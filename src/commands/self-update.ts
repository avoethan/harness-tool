/**
 * `harness self-update [--setting team|personal] [--repo <path>] [--dry-run] [--yes] [--json]`
 *
 * After the harness package itself was updated (git pull + npm run build, or
 * a new tarball): compare every file the manifest owns with what the new
 * version renders, and
 *   - replace the ones still pristine (exactly what the harness wrote),
 *   - show a diff for the ones edited since (never written),
 *   - union any new settings entries (nothing existing is removed),
 *   - re-sign the integrity manifest, so the hooks trust the new hook files.
 *
 * The user's command (the guard blocks it from agent tool calls). The write
 * goes through the lifecycle (backups, manifest chain), so `harness undo`
 * reverts an update like any plan.
 * Exit 0 ok; 1 failure; 2 usage; 4 refused by apply.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import type { AgentId, Plan, PlanTarget, Setting } from '../types';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { loadConfig, resolveConfig } from '../lib/config';
import { isFile, readJsonOr, readTextOr } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { sha256 } from '../lib/hash';
import { instrument } from '../lib/log';
import { askYesNo, isInteractive } from '../lib/prompt';
import { unifiedDiff } from '../discover/diff';
import { applyPlan } from '../lifecycle/apply';
import { formatApply } from '../lifecycle/format';
import { classifyEntry, loadManifest, manifestPathFor, resignIntegrity, samePath } from '../lifecycle/manifest';
import { savePlan } from '../lifecycle/plans';
import { renderHarness } from '../render/index';
import { posix, showHidden, upsertBlock } from '../render/model';
import { formatPlan, newPlanId, prepareContext } from '../render/propose';
import { parseJsonc, unionJson } from '../lib/jsonc';

export const meta: CommandMeta = {
  name: 'self-update',
  summary: 'Replace pristine generated files from a newer harness',
  usage: 'harness self-update [--setting team|personal] [--repo <path>] [--dry-run] [--yes] [--json]',
  examples: ['harness self-update --dry-run', 'harness self-update --yes', 'harness self-update --repo . --yes'],
};

export interface UpdateReport {
  replaced: string[];
  unioned: string[];
  editedSince: Array<{ path: string; diff: string }>;
  missing: string[];
  notRendered: string[];
  unchanged: number;
}

function objectOf(text: string | null): Record<string, unknown> | null {
  if (text === null || !text.trim()) return {};
  try {
    const v = parseJsonc<unknown>(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Build the update plan: what changes and what is only reported. */
export function buildUpdate(setting: Setting, repoRoot: string | null): { plan: Plan; report: UpdateReport } | { error: string } {
  const manifestP = manifestPathFor(setting, repoRoot);
  const m = loadManifest(manifestP);
  if (!m) return { error: `nothing installed: no manifest at ${manifestP}` };
  const cfg = setting === 'personal' && repoRoot ? resolveConfig(repoRoot).config : loadConfig();
  if (!cfg) return { error: 'no harness config; run `harness install` first' };
  const repoCfg = repoRoot ? readJsonOr<{ agents?: AgentId[] } | null>(path.join(repoRoot, '.harness', 'config.json'), null) : null;
  const agents = (repoCfg?.agents ?? cfg.agents) as AgentId[];
  const workspaceRoot = setting === 'personal' && repoRoot ? repoRoot : cfg.workspaceRoot;
  const prep = prepareContext({ setting, agents, workspaceRoot, config: cfg });
  const rendered = renderHarness(prep.ctx, { safety: [] });
  const report: UpdateReport = { replaced: [], unioned: [], editedSince: [], missing: [], notRendered: [], unchanged: 0 };
  const targets: PlanTarget[] = [];
  for (const entry of m.files) {
    if (entry.afterSha === '') continue; // a file the harness deleted
    const rf = rendered.files.find((f) => samePath(f.path, entry.path));
    if (!rf) {
      report.notRendered.push(entry.path);
      continue;
    }
    if (rf.kind === 'json') continue; // settings: handled as unions below
    const state = classifyEntry(entry);
    if (state === 'missing') {
      report.missing.push(entry.path);
      continue;
    }
    const cur = readTextOr(entry.path, null);
    const fresh = rf.kind === 'block' ? upsertBlock(cur, rf.content, rf.block?.style ?? 'md', rf.block?.position ?? 'end') : rf.content;
    if (cur === fresh) {
      report.unchanged++;
      continue;
    }
    if (state === 'modified') {
      report.editedSince.push({ path: entry.path, diff: showHidden(unifiedDiff(posix(entry.path), cur, fresh)) });
      continue;
    }
    const t: PlanTarget = { path: entry.path, owner: entry.owner, action: 'modify', beforeSha: cur === null ? null : sha256(cur), after: fresh, diff: showHidden(unifiedDiff(posix(entry.path), cur, fresh)), hunks: rf.hunks.map((h) => ({ ...h, reason: `self-update: ${h.reason}` })) };
    if (rf.mode !== undefined) t.mode = rf.mode;
    targets.push(t);
    report.replaced.push(entry.path);
  }
  // settings files: union the newly rendered fragment (new hook events or rules); never removes anything
  const settingsPaths = new Set([...m.settingsEdits.map((e) => path.resolve(e.path)), ...m.files.map((f) => path.resolve(f.path))]);
  for (const rf of rendered.files.filter((f) => f.kind === 'json' && settingsPaths.has(path.resolve(f.path)))) {
    const cur = readTextOr(rf.path, null);
    const base = objectOf(cur);
    if (!base) {
      report.editedSince.push({ path: rf.path, diff: '(the file is not a JSON object the harness can read; fix it by hand)' });
      continue;
    }
    const merged = unionJson(base, JSON.parse(rf.content));
    if (JSON.stringify(merged) === JSON.stringify(base)) {
      report.unchanged++;
      continue;
    }
    targets.push({ path: rf.path, owner: cur === null ? 'generated' : 'user', action: 'merge-json', beforeSha: cur === null ? null : sha256(cur), after: rf.content, diff: unifiedDiff(posix(rf.path), cur, JSON.stringify(merged, null, 2) + '\n'), hunks: rf.hunks.map((h) => ({ ...h, reason: `self-update: ${h.reason}` })) });
    report.unioned.push(rf.path);
  }
  const plan: Plan = {
    id: newPlanId(new Date()).replace(/^p-/, 'u-'),
    createdAt: new Date().toISOString(),
    setting,
    agents,
    ...(setting === 'personal' && repoRoot ? { repoRoot } : {}),
    targets,
    notes: [
      ...report.editedSince.map((e) => `${e.path} was edited since the harness wrote it: kept as it is (the diff to the new version is shown; apply it by hand if you want it)`),
      ...report.missing.map((p) => `${p} is missing: run \`harness install\` to put it back`),
      ...report.notRendered.map((p) => `${p} is no longer part of the rendered harness: kept (\`harness uninstall\` removes it)`),
    ],
    rejections: [],
  };
  return { plan, report };
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['dry-run', 'json', 'yes', 'y', 'help', 'h']));
  const json = flagBool(p, 'json');
  const dryRun = flagBool(p, 'dry-run');
  const yes = flagBool(p, 'yes') || flagBool(p, 'y');
  const settingFlag = flagStr(p, 'setting');
  if (settingFlag && settingFlag !== 'team' && settingFlag !== 'personal') {
    process.stderr.write('self-update: --setting must be team or personal\n');
    return 2;
  }
  let repoRoot: string | null = flagStr(p, 'repo') ? path.resolve(flagStr(p, 'repo')!) : null;
  let setting: Setting;
  if (settingFlag) setting = settingFlag as Setting;
  else if (repoRoot) setting = 'personal';
  else {
    const near = nearestRepoRoot(process.cwd());
    setting = near && isFile(manifestPathFor('personal', near)) ? 'personal' : 'team';
    if (setting === 'personal') repoRoot = near;
  }
  if (setting === 'personal' && !repoRoot) repoRoot = nearestRepoRoot(process.cwd());
  if (setting === 'personal' && !repoRoot) {
    process.stderr.write('self-update: personal setting: run inside the repository or pass --repo <path>\n');
    return 2;
  }
  const r = buildUpdate(setting, repoRoot);
  if ('error' in r) {
    process.stdout.write(`self-update: ${r.error}\n`);
    return 0;
  }
  const { plan, report } = r;
  if (!json) {
    process.stdout.write(`Self-update (${setting} setting): ${report.replaced.length} pristine file(s) to replace, ${report.unioned.length} settings file(s) to extend, ${report.editedSince.length} edited since (kept), ${report.unchanged} unchanged.\n`);
    for (const e of report.editedSince) process.stdout.write(`\nEdited since the harness wrote it (kept): ${e.path}\n${e.diff}\n`);
    if (plan.targets.length) process.stdout.write('\n' + formatPlan(plan, { diffs: true }));
  }
  if (!plan.targets.length || dryRun) {
    if (!plan.targets.length && !dryRun) {
      resignIntegrity('self-update');
      if (!json) process.stdout.write('Nothing to replace. Integrity re-signed for the installed hook files.\n');
    } else if (!plan.targets.length && !json) process.stdout.write('Nothing to replace (dry run: nothing written).\n');
    if (json) process.stdout.write(JSON.stringify({ dryRun, report, plan }, null, 2) + '\n');
    return 0;
  }
  if (!yes) {
    if (!isInteractive()) {
      process.stderr.write('self-update: this changes files; pass --yes, or --dry-run to see what would happen\n');
      return 2;
    }
    if (!(await askYesNo('Replace these files?'))) {
      process.stdout.write('Nothing changed.\n');
      return 0;
    }
  }
  const file = savePlan(plan);
  const res = await applyPlan(plan, { repoRoot: repoRoot ?? undefined });
  resignIntegrity('self-update');
  instrument({ event: 'self-update', ids: { plan: plan.id, setting }, counts: { replaced: report.replaced.length, unioned: report.unioned.length, edited: report.editedSince.length } });
  if (json) process.stdout.write(JSON.stringify({ plan: plan.id, file, report, result: res }, null, 2) + '\n');
  else process.stdout.write(formatApply(res) + '\n');
  if (res.ok) return 0;
  return res.refused.length ? 4 : 1;
}
