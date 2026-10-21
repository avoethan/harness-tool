/**
 * `harness propose`
 *
 *   harness propose [--setting team|personal] [--agents devin,claude,codex]
 *                   [--workspace <dir>] [--include <dir>]... [--out <file>]
 *                   [--no-diff] [--json]
 *       Build the plan (DESIGN 2.3; src/render/propose.ts): per file the
 *       action, why (check ids) and the diff; saved to ~/.harness/plans/<id>.json
 *       for `harness apply --plan <id>`. Nothing in the agents' files is
 *       written. `--out` also writes the plain-language plan to a file.
 *
 *   harness propose --approve <id> [--reject <check>:<path>]...
 *   harness propose --plan <id> --reject <check>:<path>...
 *       Record decisions: each rejection is remembered by (check, path,
 *       content hash) and never proposed again; the plan is rebuilt without
 *       it under the same id. `--approve` marks the plan approved. These are
 *       the user's decisions: the guard blocks them from agent tool calls.
 *
 *   harness propose --for-team <repo path|name|id> [--json]
 *       Team proposals from the discovery ledger (never applied).
 *
 * Exit 0 ok; 1 a rejection matched nothing or the plan is missing; 2 usage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { ALL_AGENTS, type AgentId, type Setting } from '../types';
import { flagBool, flagList, flagStr, flagValues, parseArgv } from '../lib/argv';
import { loadConfig } from '../lib/config';
import { writeTextAtomic } from '../lib/fsx';
import { instrument } from '../lib/log';
import { userHome } from '../lib/paths';
import { proposeForTeam } from '../discover/proposals';
import { loadPlanRef, savePlan } from '../lifecycle/plans';
import { buildPlan, formatPlan, hunkCounts, proposeAndSave, recordRejections, rejectablePairs, type ProposedPlan } from '../render/propose';

export const meta: CommandMeta = {
  name: 'propose',
  summary: 'Write a plan of changes with diffs and provenance; --for-team writes team proposals (never applied)',
  usage:
    'harness propose [--setting team|personal] [--agents devin,claude,codex] [--workspace <dir>] [--include <dir>]... [--out <file>] [--no-diff] [--json] | --approve <id> [--reject <check>:<path>]... | --plan <id> --reject <check>:<path>... | --for-team <repo> [--json]',
  examples: [
    'harness propose --setting team --agents devin,claude --workspace ~/work',
    'harness propose --approve p-20261019-120000-ab12 --reject R30:~/.claude/CLAUDE.md',
    'harness propose --for-team billing-api',
  ],
};

const BOOLEANS = new Set(['json', 'help', 'h', 'diff', 'no-diff']);

function usage(msg: string): number {
  process.stderr.write(`propose: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(userHome(), p.slice(2));
  return p;
}

/** `<check>:<path>`; the check id never holds a path separator, so Windows drive letters stay in the path. */
export function parseReject(s: string): { checkId: string; path: string } | null {
  const m = /^([A-Za-z0-9._-]+):(.+)$/.exec(s.trim());
  if (!m) return null;
  return { checkId: m[1], path: path.resolve(expandHome(m[2])) };
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, BOOLEANS);
  const json = flagBool(a, 'json');

  const forTeam = flagStr(a, 'for-team');
  if (forTeam !== undefined) return forTeamMode(forTeam, json);

  const approve = flagStr(a, 'approve');
  const planRef = approve ?? flagStr(a, 'plan');
  const rejects = flagValues(a, 'reject');
  if (approve !== undefined || rejects.length) {
    if (!planRef) return usage('--reject needs the plan: --approve <id> or --plan <id>');
    return decide(planRef, rejects, approve !== undefined, json);
  }

  const cfg = loadConfig();
  const settingRaw = flagStr(a, 'setting') ?? cfg?.setting ?? 'team';
  if (settingRaw !== 'team' && settingRaw !== 'personal') return usage('--setting must be team or personal');
  const setting = settingRaw as Setting;
  const agentsRaw = flagList(a, 'agents');
  const agents = (agentsRaw.length ? agentsRaw : (cfg?.agents ?? ALL_AGENTS)) as AgentId[];
  const bad = agents.filter((x) => !ALL_AGENTS.includes(x));
  if (bad.length) return usage(`unknown agent ${bad.join(', ')} (use devin, claude, codex)`);
  const workspace = path.resolve(expandHome(flagStr(a, 'workspace') ?? (setting === 'team' ? cfg?.workspaceRoot : undefined) ?? process.cwd()));
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) return usage(`workspace ${workspace} is not a folder`);
  const includes = flagList(a, 'include').map((x) => path.resolve(expandHome(x)));

  const r = proposeAndSave({ setting, agents, workspaceRoot: workspace, includes: includes.length ? includes : undefined });
  const text = formatPlan(r.plan, { file: r.file, diffs: !(flagBool(a, 'no-diff') || a.flags.diff === false) });
  const out = flagStr(a, 'out');
  if (out) writeTextAtomic(path.resolve(expandHome(out)), text);
  if (json) process.stdout.write(JSON.stringify({ id: r.plan.id, file: r.file, targets: r.plan.targets.length, hunks: hunkCounts(r.plan), suppressed: r.suppressed.length, plan: r.plan }, null, 2) + '\n');
  else {
    process.stdout.write(text);
    if (r.plan.targets.length) {
      process.stdout.write(`\nNothing is written yet. To apply this plan, run in your terminal:\n  harness apply --plan ${r.plan.id}\n`);
      process.stdout.write(`To leave a change out: harness propose --approve ${r.plan.id} --reject <check>:<path>\n`);
    }
    if (out) process.stdout.write(`Wrote ${path.resolve(expandHome(out))}\n`);
  }
  return 0;
}

async function decide(ref: string, rejects: string[], approve: boolean, json: boolean): Promise<number> {
  const loaded = loadPlanRef(ref);
  if (!loaded.ok) {
    process.stderr.write(`propose: ${loaded.error}\n`);
    return 1;
  }
  const plan = loaded.plan as ProposedPlan;
  const now = new Date().toISOString();
  const requests: Array<{ checkId: string; path: string; raw: string }> = [];
  for (const raw of rejects) {
    const r = parseReject(raw);
    if (!r) return usage(`--reject ${raw}: expected <check>:<path>`);
    requests.push({ ...r, raw });
  }
  const { added, unmatched } = recordRejections(plan, requests);
  if (unmatched.length) {
    process.stderr.write(`propose: ${unmatched.map((u) => `--reject ${u}`).join(', ')} matches no change in plan ${plan.id}. Changes in this plan:\n${rejectablePairs(plan).map((x) => '  ' + x).join('\n')}\n`);
    return 1;
  }
  let next: ProposedPlan = plan;
  if (added.length) {
    const meta = plan.meta ?? { workspaceRoot: plan.repoRoot ?? process.cwd(), userHome: userHome(), harnessVersion: '' };
    next = buildPlan({ setting: plan.setting, agents: plan.agents, workspaceRoot: meta.workspaceRoot, planId: plan.id }).plan;
  }
  if (approve) next.meta = { ...next.meta, approvedAt: now };
  const file = savePlan(next);
  instrument({ event: 'propose.decide', ids: { plan: plan.id }, counts: { rejected: added.length, approved: approve ? 1 : 0, targets: next.targets.length } });
  if (json) {
    process.stdout.write(JSON.stringify({ id: next.id, file, approved: approve, rejected: added, targets: next.targets.length }, null, 2) + '\n');
    return 0;
  }
  for (const r of added) process.stdout.write(`Rejected ${r.checkId} on ${r.path}; it will not be proposed again while its content is the same.\n`);
  process.stdout.write(`Plan ${next.id}${approve ? ' approved' : ''}: ${next.targets.length} file(s) to change. Saved ${file}\n`);
  if (next.targets.length) process.stdout.write(`Apply it in your terminal: harness apply --plan ${next.id}\n`);
  else process.stdout.write('Nothing left to apply.\n');
  return 0;
}

function forTeamMode(forTeam: string, json: boolean): number {
  if (!forTeam) {
    process.stderr.write('propose: --for-team needs a repository (path, name or id)\n');
    return 2;
  }
  const r = proposeForTeam(forTeam);
  if ('error' in r) {
    process.stderr.write(`propose: ${r.error}\n`);
    return 1;
  }
  instrument({ event: 'propose.for-team', repo: r.repo.id, counts: { proposals: r.proposals.length } });
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return 0;
  }
  if (!r.proposals.length) {
    process.stdout.write(`propose: no team proposals for ${r.repo.name} (nothing declared-but-not-followed, no unenforced counted convention with a core-rule equivalent, CI runs every check script, CONTRIBUTING already states the counted conventions)\n`);
    return 0;
  }
  process.stdout.write(`propose: ${r.proposals.length} team proposal(s) for ${r.repo.name} in ${r.dir} (never applied; carry them through the team's pull-request process):\n`);
  for (const p of r.proposals) process.stdout.write(`  ${p.n}. [${p.kind}] ${p.title}\n     ${p.md}\n     ${p.diff}\n`);
  return 0;
}
