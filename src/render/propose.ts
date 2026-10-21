/**
 * The plan builder (DESIGN 2.3): turns the assessment, the ledger, the safety
 * inventory and the rendered harness into a Plan (types.ts) that
 * `harness apply` writes with backups and a manifest.
 *
 * Per target: the action, the owner, the content after, a unified diff, and
 * hunks tagged with check id, reason, provenance and a content hash.
 *
 *   - user files (the user's instruction files and skills) get diff
 *     proposals, owner `user`: lines move out by class (see userfiles.ts),
 *     the user's wording is moved, never rewritten;
 *   - rendered files are owner `generated` when the harness creates them or
 *     the manifest says it wrote them and they are untouched since; otherwise
 *     they are diff proposals on the user's file (owner `user`);
 *   - settings files are `merge-json` unions: nothing existing is removed;
 *   - every safety rule found (deny/ask rules, git hooks, CI jobs, "never"
 *     sentences) is listed with the rail or rule that now enforces it;
 *   - rejections are remembered by (check, path, content hash) in
 *     ~/.harness/plans/rejections.json and never proposed again;
 *   - archive and quarantine files are harness state: propose writes them
 *     itself under ~/.harness/archive/ and ~/.harness/quarantine/ (apply
 *     refuses targets inside the harness folder by design).
 *
 * A second run on an installed machine proposes only differences: a plan
 * with no targets means nothing to change.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, AssessReport, HarnessConfig, Ledger, Plan, PlanTarget, Rejection, SafetyRule, Setting } from '../types';
import { runAssess } from '../assess/index';
import { safetyTopic } from '../assess/safety';
import { unifiedDiff } from '../discover/diff';
import { loadConfig } from '../lib/config';
import { readJsonOr, readTextOr, writeJson } from '../lib/fsx';
import { isTracked, nearestRepoRoot } from '../lib/git';
import { sha256, sha256File } from '../lib/hash';
import { parseJsonc, unionJson } from '../lib/jsonc';
import { harnessHome as defaultHarnessHome, packageRoot as defaultPackageRoot, subPath, userHome as defaultUserHome } from '../lib/paths';
import { instrument } from '../lib/log';
import { harnessVersion } from '../cli';
import { findEntry, loadManifest, manifestPathFor, samePath } from '../lifecycle/manifest';
import { plansDir, savePlan } from '../lifecycle/plans';
import { ownedArrayElements, pruneStaleOwned } from '../lifecycle/owned';
import { allRepoFacts, homeRelative, posix, showHidden, upsertBlock, type InventoryRepo, type LedgerInventory, type RenderContext, type RenderedFile, type RuleRow } from './model';
import { renderHarness } from './index';
import { appendEntries, applyMoves, archiveEntry, harnessBlockLines, mergeMovedState, planFileMoves, quarantineEntry, sideFileName, type FileMoves, type UnitMove } from './userfiles';
import { approvedProse } from '../learn/store';

export interface ProposeMeta {
  workspaceRoot: string;
  userHome: string;
  harnessVersion: string;
  approvedAt?: string;
  /** Files written under the harness folder by this propose (archive, quarantine). */
  sideFiles?: string[];
}

export interface ProposedPlan extends Plan {
  meta: ProposeMeta;
}

export interface ProposeOptions {
  setting: Setting;
  agents: AgentId[];
  /** Team: the folder holding the repos. Personal: the repository (or a folder in it). */
  workspaceRoot: string;
  userHome?: string;
  harnessHome?: string;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  assess?: AssessReport;
  ledger?: Ledger | null;
  inventory?: LedgerInventory | null;
  config?: HarnessConfig | null;
  includes?: string[];
  now?: Date;
  planId?: string;
  /** Write the archive and quarantine files (default true). */
  writeSideFiles?: boolean;
}

export interface ProposeResult {
  plan: ProposedPlan;
  /** Changes left out because the user rejected them before. */
  suppressed: Array<{ checkId: string; path: string }>;
  file?: string;
}

// ---------------------------------------------------------------------------
// rejections
// ---------------------------------------------------------------------------

export function rejectionsPath(home = defaultHarnessHome()): string {
  return path.join(home, 'plans', 'rejections.json');
}

export function loadRejections(home = defaultHarnessHome()): Rejection[] {
  const j = readJsonOr<{ rejections?: Rejection[] } | null>(rejectionsPath(home), null);
  return Array.isArray(j?.rejections) ? j!.rejections : [];
}

export function saveRejections(list: Rejection[], home = defaultHarnessHome()): void {
  writeJson(rejectionsPath(home), { version: 1, rejections: list });
}

export function isRejected(list: Rejection[], checkId: string, p: string, contentHash: string | undefined): boolean {
  if (!contentHash) return false;
  return list.some((r) => r.checkId === checkId && samePath(r.path, p) && r.contentHash === contentHash);
}

/**
 * Record `<check>:<path>` rejections against a plan's hunks (each by its
 * content hash). Returns what was added and the requests that matched nothing.
 */
export function recordRejections(plan: Plan, requests: Array<{ checkId: string; path: string; raw: string }>, home = defaultHarnessHome(), now = new Date()): { added: Rejection[]; unmatched: string[] } {
  const list = loadRejections(home);
  const added: Rejection[] = [];
  const unmatched: string[] = [];
  for (const r of requests) {
    let hit = 0;
    for (const t of plan.targets) {
      if (!samePath(t.path, r.path)) continue;
      for (const h of t.hunks) {
        if (h.checkId !== r.checkId || !h.contentHash) continue;
        hit++;
        if (isRejected(list, h.checkId, t.path, h.contentHash)) continue;
        const rej: Rejection = { checkId: h.checkId, path: t.path, contentHash: h.contentHash, rejectedAt: now.toISOString() };
        list.push(rej);
        added.push(rej);
      }
    }
    if (!hit) unmatched.push(r.raw);
  }
  if (added.length) saveRejections(list, home);
  return { added, unmatched };
}

/** Every `<check>:<path>` pair a plan offers, for an error message. */
export function rejectablePairs(plan: Plan): string[] {
  return plan.targets.flatMap((t) => [...new Set(t.hunks.map((h) => h.checkId))].map((c) => `${c}:${t.path}`));
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

/** A minimal inventory from package.json files when discovery has not run. */
export function fallbackInventory(repos: Array<{ id: string; name: string; path: string }>, workspaceRoot: string): LedgerInventory {
  return {
    workspaceRoot,
    repos: repos.map((r): InventoryRepo => {
      const pj = readJsonOr<{ scripts?: Record<string, string> } | null>(path.join(r.path, 'package.json'), null);
      const pm = fs.existsSync(path.join(r.path, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(r.path, 'yarn.lock')) ? 'yarn' : fs.existsSync(path.join(r.path, 'bun.lockb')) || fs.existsSync(path.join(r.path, 'bun.lock')) ? 'bun' : 'npm';
      return { id: r.id, name: r.name, path: r.path, relPath: posix(path.relative(workspaceRoot, r.path)) || '.', packageManager: pm, packages: [{ dir: '', scripts: pj?.scripts ?? {} }] };
    }),
  };
}

function loadInputs(o: ProposeOptions, harnessHome: string): { ledger: Ledger | null; inventory: LedgerInventory | null; config: HarnessConfig | null } {
  const ledger = o.ledger !== undefined ? o.ledger : readJsonOr<Ledger | null>(path.join(harnessHome, 'ledger', 'ledger.json'), null);
  let inventory = o.inventory !== undefined ? o.inventory : readJsonOr<LedgerInventory | null>(path.join(harnessHome, 'ledger', 'inventory.json'), null);
  const config = o.config !== undefined ? o.config : loadConfig();
  if (inventory && inventory.workspaceRoot && path.resolve(inventory.workspaceRoot) !== path.resolve(o.workspaceRoot) && o.setting === 'team') inventory = null;
  if (o.setting === 'personal') {
    const root = path.resolve(o.workspaceRoot);
    const own = inventory?.repos.filter((r) => path.resolve(r.path) === root) ?? [];
    inventory = own.length ? { ...inventory!, workspaceRoot: root, repos: own } : fallbackInventory([{ id: path.basename(root), name: path.basename(root), path: root }], root);
  } else if (!inventory && config?.repos?.length) {
    inventory = fallbackInventory(config.repos, o.workspaceRoot);
  }
  return { ledger, inventory, config };
}

// ---------------------------------------------------------------------------
// owner and target construction
// ---------------------------------------------------------------------------

function ownerOf(p: string, current: string | null, manifests: Array<ReturnType<typeof loadManifest>>): 'user' | 'generated' {
  if (current === null) return 'generated';
  for (const m of manifests) {
    const e = m ? findEntry(m, p) : undefined;
    if (e && e.owner === 'generated' && e.afterSha === sha256(current)) return 'generated';
  }
  return 'user';
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null || !text.trim()) return {};
  try {
    const v = parseJsonc<unknown>(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function previewMerge(current: string | null, fragment: string, owned?: Map<string, Set<string>>): { text: string; changed: boolean } | { error: string } {
  const base = parseObject(current);
  if (!base) return { error: 'the existing file is not a JSON object that can be read; fix it by hand first' };
  // the same replacement apply makes: stale harness entries of an earlier install (another copy of the harness) go
  const frag = JSON.parse(fragment) as Record<string, unknown>;
  const pruned = owned && owned.size ? pruneStaleOwned(base, frag, owned).base : base;
  const merged = unionJson(pruned, frag);
  const text = JSON.stringify(merged, null, 2) + '\n';
  return { text, changed: JSON.stringify(merged) !== JSON.stringify(base) };
}

interface Building {
  ctx: RenderContext;
  manifests: Array<ReturnType<typeof loadManifest>>;
  rejections: Rejection[];
  suppressed: ProposeResult['suppressed'];
  notes: string[];
}

function display(b: Building, p: string): string {
  const h = homeRelative(p, b.ctx.userHome);
  if (h.startsWith('~/')) return h;
  const rel = path.relative(b.ctx.workspaceRoot, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return posix(path.join(path.basename(b.ctx.workspaceRoot), rel));
  return h;
}

/**
 * One rendered file as a plan target. `movedText` is the user's text of the same file after the
 * line moves (FIX, CONVERT, TRIM, QUARANTINE): a marker block goes into that text, not into the file
 * as it is on disk, so a user file that also carries a block (the personal CLAUDE.md import) gets
 * both its moves and the block.
 */
function renderedToTarget(b: Building, rf: RenderedFile, movedText?: string): PlanTarget | null {
  const hunks = rf.hunks.filter((h) => {
    if (isRejected(b.rejections, h.checkId, rf.path, h.contentHash)) {
      b.suppressed.push({ checkId: h.checkId, path: rf.path });
      return false;
    }
    return true;
  });
  if (!hunks.length) return null;
  const cur = readTextOr(rf.path, null);
  if (rf.kind === 'json') {
    const owned = new Map<string, Set<string>>();
    for (const m of b.manifests) if (m) for (const [k, v] of ownedArrayElements(m.settingsEdits, rf.path)) owned.set(k, new Set([...(owned.get(k) ?? []), ...v]));
    const prev = previewMerge(cur, rf.content, owned);
    if ('error' in prev) {
      b.notes.push(`${display(b, rf.path)}: ${prev.error}`);
      return null;
    }
    if (!prev.changed) return null;
    return { path: rf.path, owner: cur === null ? 'generated' : 'user', action: 'merge-json', beforeSha: cur === null ? null : sha256(cur), after: rf.content, diff: showHidden(unifiedDiff(posix(rf.path), cur, prev.text)), hunks };
  }
  const after = rf.kind === 'block' ? upsertBlock(movedText ?? cur, rf.content, rf.block?.style ?? 'md', rf.block?.position ?? 'end') : rf.content;
  if (cur !== null && cur === after) return null;
  const t: PlanTarget = {
    path: rf.path,
    owner: ownerOf(rf.path, cur, b.manifests),
    action: cur === null ? 'create' : 'modify',
    beforeSha: cur === null ? null : sha256(cur),
    after,
    diff: showHidden(unifiedDiff(posix(rf.path), cur, after)),
    hunks,
  };
  if (rf.mode !== undefined) t.mode = rf.mode;
  return t;
}

// ---------------------------------------------------------------------------
// safety inventory: every rule found is kept and listed with its enforcer
// ---------------------------------------------------------------------------

export function promotionFor(r: SafetyRule, setting: Setting, config: HarnessConfig | null): string {
  switch (r.kind) {
    case 'deny-rule':
    case 'ask-rule':
      return `kept in its own file and translated into every targeted agent's ${r.kind === 'deny-rule' ? 'deny' : 'ask'} rules`;
    case 'git-hook':
      return 'kept; skipping it is denied by the guard (--no-verify, core.hooksPath, git aliases)';
    case 'ci-required':
      return 'kept; the gate runs the same verification scripts before "done"';
    case 'never-sentence': {
      const topic = safetyTopic(r.text);
      const tests = (config?.db?.allowlist ?? []).filter((t) => t.marked === 'test').map((t) => (t.database ? `${t.server}/${t.database}` : t.server));
      switch (topic) {
        case 'database':
          if (/\bmigrations?\b/i.test(r.text) && !/\b(prod|production|write|drop|delete|truncate)\b/i.test(r.text)) {
            return 'kept as written: no hard block exists for editing a file; the always-on file lists it under Never when discovery recorded it, and the gate\'s tamper step shows edited migrations';
          }
          return `promoted to the database rail: the guard denies every database command whose target is not marked test (marked test: ${tests.length ? tests.join(', ') : 'none yet, so all are denied'})`;
        case 'production':
          return `promoted to the database rail: the guard denies every database command whose target is not marked test (marked test: ${tests.length ? tests.join(', ') : 'none yet, so all are denied'})`;
        case 'secrets':
          return 'promoted to the secrets rail: the guard denies reading, staging or copying secret files; evidence and logs are redacted';
        case 'history':
          return 'promoted to the history rail: force-push and history rewrites are denied by the guard and permission rules';
        case 'protected-branch':
          return setting === 'team' ? 'promoted to the team rail: the agent never pushes or opens pull requests' : 'promoted: only `harness land` pushes, by fast-forward after the gate passed';
        case 'bypass':
          return 'promoted to the hooks rail: --no-verify and hook-path changes are denied';
        case 'destructive':
          return 'promoted in part: deleting harness state and agent config is denied; other deletions stop the line (the task skill escalates irreversible actions)';
        default:
          return `kept as written (topic ${topic ?? 'other'}): no hard block exists for it; the task skill stops the line on irreversible actions`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------

export function newPlanId(now: Date): string {
  const s = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `p-${s}-${sha256(String(now.getTime()) + process.pid + Math.random()).slice(0, 4)}`;
}

export interface PreparedContext {
  ctx: RenderContext;
  harnessHome: string;
  userHome: string;
  workspaceRoot: string;
  repoRoot?: string;
  manifests: Array<ReturnType<typeof loadManifest>>;
  /** Files the harness wrote (generated, or created by an apply). */
  ownedFiles: Set<string>;
  hadLedger: boolean;
}

/**
 * The render context for a setting: inputs (ledger, inventory, config), the
 * manifests, and the ledger without records the harness would have learned
 * from its own files. Shared by propose and self-update.
 */
export function prepareContext(o: Omit<ProposeOptions, 'assess' | 'planId' | 'writeSideFiles' | 'now'>): PreparedContext {
  const hh = o.harnessHome ?? defaultHarnessHome();
  const uh = o.userHome ?? defaultUserHome();
  const pkg = o.packageRoot ?? defaultPackageRoot();
  let workspaceRoot = path.resolve(o.workspaceRoot);
  let repoRoot: string | undefined;
  if (o.setting === 'personal') {
    repoRoot = nearestRepoRoot(workspaceRoot) ?? workspaceRoot;
    workspaceRoot = repoRoot;
  }
  const inputs = loadInputs({ ...o, workspaceRoot }, hh);
  const ctx: RenderContext = {
    setting: o.setting,
    agents: o.agents,
    workspaceRoot,
    repoRoot,
    userHome: uh,
    harnessHome: hh,
    packageRoot: pkg,
    platform: o.platform ?? process.platform,
    ledger: inputs.ledger,
    inventory: inputs.inventory,
    config: inputs.config,
    harnessVersion: harnessVersion(),
  };
  // Prose lessons the user approved in `harness learn review` (instruction lines and skill text).
  const prose = approvedProse(hh);
  if (prose.length) ctx.lessons = prose;
  const manifests = [loadManifest(manifestPathFor('team')), repoRoot ? loadManifest(manifestPathFor('personal', repoRoot)) : null];
  // The harness never learns from its own output: standards whose only file evidence is a file the
  // harness wrote are left out (safety rules are filtered the same way in buildPlan).
  const ownedFiles = new Set<string>();
  for (const m of manifests) for (const f of m?.files ?? []) if (f.owner === 'generated' || f.beforeSha === null) ownedFiles.add(path.resolve(f.path));
  if (ctx.ledger) {
    const kept = ctx.ledger.records.filter((r) => !harnessDerived(r, ownedFiles, ctx));
    if (kept.length !== ctx.ledger.records.length) ctx.ledger = { ...ctx.ledger, records: kept };
  }
  return { ctx, harnessHome: hh, userHome: uh, workspaceRoot, repoRoot, manifests, ownedFiles, hadLedger: !!inputs.ledger };
}

export function buildPlan(o: ProposeOptions): ProposeResult {
  const now = o.now ?? new Date();
  const planId = o.planId ?? newPlanId(now);
  const prep = prepareContext(o);
  const { ctx, manifests, ownedFiles, workspaceRoot, repoRoot } = prep;
  const hh = prep.harnessHome;
  const uh = prep.userHome;
  const inputs = { config: ctx.config };
  const report = o.assess ?? runAssess({ workspace: workspaceRoot, setting: o.setting, agents: o.agents, userHome: uh, includes: o.includes ?? inputs.config?.include ?? [] }).report;
  const b: Building = { ctx, manifests, rejections: loadRejections(hh), suppressed: [], notes: [] };
  if (!prep.hadLedger) b.notes.push('no standards ledger yet: run `harness discover` first so the always-on file and the scoped rules carry the standards');

  // ---- 1. user files: line moves -------------------------------------------
  const facts = allRepoFacts(ctx);
  const records = ctx.ledger?.records ?? [];
  const renderedPreview = renderHarness(ctx, { safety: [] });
  const renderedText = new Set(renderedPreview.files.filter((f) => f.kind === 'text' && f.role !== 'always-on').map((f) => path.resolve(f.path)));
  const ownRules = ownRuleTexts(renderedPreview.permissions);
  const alwaysOnPaths = new Set(renderedPreview.files.filter((f) => f.role === 'always-on' || f.kind === 'block').map((f) => path.resolve(f.path)));
  const safetyRules = report.safetyRules.filter((r) => {
    const src = path.resolve(r.source.replace(/#.*$/, ''));
    if (renderedText.has(src) || ownedFiles.has(src)) return alwaysOnPaths.has(src) ? !inHarnessBlock(src, r.line) : false;
    if (alwaysOnPaths.has(src) && inHarnessBlock(src, r.line)) return false;
    return !ownRules.has(normRule(r.text));
  });
  const moved: FileMoves[] = [];
  for (const f of report.files) {
    if (!['instructions', 'rule', 'skill', 'command', 'subagent', 'legacy'].includes(f.kind)) continue;
    if (renderedText.has(path.resolve(f.path))) continue; // the harness's own rendered file
    if (manifests.some((m) => m && findEntry(m, f.path)?.owner === 'generated')) continue;
    if (!inScope(o.setting, f, workspaceRoot, uh, o.includes ?? inputs.config?.include ?? [])) {
      if (report.classifications.some((c) => c.file === f.path && c.cls !== 'KEEP')) b.notes.push(`${display(b, f.path)} is outside this setting's reach (${f.level ?? 'unknown level'}); it is assessed but never changed`);
      continue;
    }
    const text = readTextOr(f.path, null);
    if (text === null) continue;
    if (sha256(text) !== f.sha256) {
      b.notes.push(`${display(b, f.path)} changed since the assessment; run propose again to include it`);
      continue;
    }
    const fm = planFileMoves({ report, records, facts, workspaceRoot }, f, text);
    if (!fm) continue;
    // rejected unit moves stay where they are
    fm.units = fm.units.map((u) => {
      if (isRejected(b.rejections, u.check, f.path, u.contentHash)) {
        b.suppressed.push({ checkId: u.check, path: f.path });
        return { ...u, dest: 'keep' as const };
      }
      return u;
    });
    fm.after = applyMoves(fm.before, fm.units);
    if (o.setting === 'team') {
      const repo = nearestRepoRoot(path.dirname(f.path));
      if (repo && subPath(workspaceRoot, repo) && !subPath(hh, repo) && isTracked(repo, f.path)) {
        b.notes.push(`${display(b, f.path)} is tracked by a team repository: the harness never changes team files (${fm.units.filter((u) => u.dest !== 'keep').length} proposed move(s) left out; carry them through the team's process, e.g. \`harness propose --for-team\`)`);
        continue;
      }
    }
    moved.push(fm);
  }

  // ---- 2. extra inputs for the render: CONVERT rules, SPLIT references ------
  const newRules: RuleRow[] = [];
  const newRefs: Array<{ origin: string; text: string }> = [];
  for (const fm of moved) {
    for (const u of fm.units) {
      if (u.dest === 'archive' && u.rule && !newRules.some((r) => r.id === u.rule!.id)) newRules.push(u.rule);
      if (u.dest === 'split') newRefs.push({ origin: `${display(b, u.file)}:${u.lines[0]}`, text: u.raw.join('\n') });
    }
  }
  // what earlier proposals moved stays rendered, so a second run on an installed machine changes nothing
  const state = mergeMovedState(hh, { converted: newRules.map((r) => ({ id: r.id, rule: r.rule, enforcer: r.enforcer, origin: r.enforcer })), references: newRefs }, o.writeSideFiles !== false);
  const ledgerIds = new Set(records.map((r) => r.id));
  const extraRules: RuleRow[] = state.converted.filter((c) => ledgerIds.has(c.id)).map((c) => ({ id: c.id, rule: c.rule, enforcer: c.enforcer }));
  for (const r of newRules) if (!extraRules.some((x) => x.id === r.id)) extraRules.push(r);
  const references = [...state.references];
  for (const r of newRefs) if (!references.some((x) => x.origin === r.origin && x.text === r.text)) references.push(r);
  ctx.extraRules = extraRules;
  ctx.references = references;

  // ---- 3. archive and quarantine (harness state) ----------------------------
  const sideFiles: string[] = [];
  const writeSide = o.writeSideFiles !== false;
  for (const fm of moved) {
    const disp = display(b, fm.file.path);
    const arch = fm.units.filter((u) => u.dest === 'archive' || (u.dest === 'fix' && (u.replace?.size ?? 0) > 0));
    const quar = fm.units.filter((u) => u.dest === 'quarantine');
    if (arch.length) {
      const file = path.join(hh, 'archive', sideFileName(disp));
      const header = `# Archive of ${disp}\n\nLines moved out of this file by \`harness propose\`. The wording is the user's, verbatim; each entry names its origin and why it moved.\n`;
      if (writeSide) appendEntries(file, header, arch.map((u) => archiveEntry(disp, u, planId)));
      sideFiles.push(file);
    }
    if (quar.length) {
      const file = path.join(hh, 'quarantine', sideFileName(disp));
      const header = `# Quarantine: ${disp}\n\nLines removed from what agents load because they carry hidden characters, read like instructions to an agent, or grant autonomy the rails do not allow. Look at them before using any of it.\n`;
      if (writeSide) appendEntries(file, header, quar.map((u) => quarantineEntry(disp, u, planId)));
      sideFiles.push(file);
    }
  }

  // ---- 4. render with the moved user text ------------------------------------
  const afterOf = new Map(moved.map((fm) => [path.resolve(fm.file.path), fm.after]));
  const rendered = renderHarness(ctx, { safety: safetyRules, userText: (p) => afterOf.get(path.resolve(p)) ?? readTextOr(p, null) });
  b.notes.push(...rendered.notes);
  for (const ov of rendered.over) b.notes.push(`${display(b, ov.path)}: ${ov.why}`);

  // ---- 5. targets -----------------------------------------------------------
  const targets: PlanTarget[] = [];
  const byPath = new Map<string, PlanTarget>();
  const pushTarget = (t: PlanTarget) => {
    const k = path.resolve(t.path);
    const prev = byPath.get(k);
    if (prev) {
      prev.hunks.push(...t.hunks);
      return;
    }
    byPath.set(k, t);
    targets.push(t);
  };
  // rendered files first, so a user file that is also the always-on file becomes one target
  const renderedTargets = new Map<string, PlanTarget>();
  for (const rf of rendered.files) {
    const t = renderedToTarget(b, rf, rf.kind === 'block' ? afterOf.get(path.resolve(rf.path)) : undefined);
    if (t) renderedTargets.set(path.resolve(rf.path), t);
  }
  for (const fm of moved) {
    const k = path.resolve(fm.file.path);
    const hunks = fm.units
      .filter((u) => u.dest !== 'keep')
      .map((u) => ({ checkId: u.check, reason: `${u.cls} ${destWord(u)}: ${u.reason}${u.note ? ` (${u.note})` : ''}`, provenance: `${display(b, u.file)}:${u.lines.length > 1 ? `${u.lines[0]}-${u.lines[u.lines.length - 1]}` : u.lines[0]}`, contentHash: u.contentHash }));
    const rt = renderedTargets.get(k);
    if (rt) {
      rt.hunks.unshift(...hunks);
      rt.owner = 'user';
      continue;
    }
    if (fm.after === fm.before) {
      // advisory only: no change to the file; the hunks travel in the notes
      for (const h of hunks) b.notes.push(`${h.provenance} [${h.checkId}] ${h.reason}`);
      continue;
    }
    pushTarget({ path: fm.file.path, owner: 'user', action: 'modify', beforeSha: sha256(fm.before), after: fm.after, diff: showHidden(unifiedDiff(posix(fm.file.path), fm.before, fm.after)), hunks, ...(o.setting === 'team' && needsExclude(fm.file.path, workspaceRoot, hh) ? { exclude: true } : {}) });
  }
  for (const t of renderedTargets.values()) pushTarget(t);

  // ---- 6. safety inventory: listed, each with its enforcer -------------------
  const railTarget = targets.find((t) => t.action === 'merge-json') ?? targets.find((t) => /\.rules$/.test(t.path));
  const safetyNotes: string[] = [];
  for (const r of safetyRules) {
    const how = promotionFor(r, o.setting, inputs.config);
    const where = `${display(b, r.source)}${r.line ? `:${r.line}` : ''}`;
    safetyNotes.push(`- ${r.kind} ${where}: "${r.text.slice(0, 120)}" -> ${how}`);
    r.promoted = how;
    const hunk = { checkId: 'safety', reason: `${r.kind} "${r.text.slice(0, 100)}": ${how}`, provenance: where, contentHash: sha256(`${r.source}\n${r.text}`) };
    if (railTarget && !isRejected(b.rejections, 'safety', railTarget.path, hunk.contentHash)) railTarget.hunks.push(hunk);
  }
  if (safetyNotes.length) b.notes.push(`Safety rules found (${safetyNotes.length}), all kept:\n${safetyNotes.join('\n')}`);

  // ---- 7. the plan ----------------------------------------------------------
  const notes = [...b.notes];
  if (sideFiles.length) notes.push(`Moved text is kept under ${display(b, hh)}: ${[...new Set(sideFiles)].map((f) => display(b, f)).join(', ')}`);
  if (b.suppressed.length) notes.push(`${b.suppressed.length} change(s) you rejected before were left out (${rejectionsPath(hh)}).`);
  const plan: ProposedPlan = {
    id: planId,
    createdAt: now.toISOString(),
    setting: o.setting,
    agents: o.agents,
    ...(repoRoot ? { repoRoot } : {}),
    targets,
    notes,
    rejections: b.rejections,
    meta: { workspaceRoot, userHome: uh, harnessVersion: ctx.harnessVersion, sideFiles: [...new Set(sideFiles)] },
  };
  instrument({ event: 'propose', ids: { plan: planId, setting: o.setting }, counts: { targets: targets.length, hunks: targets.reduce((n, t) => n + t.hunks.length, 0), suppressed: b.suppressed.length, safety: safetyRules.length } });
  return { plan, suppressed: b.suppressed };
}

/** A ledger record whose every file source is a file the harness wrote (it would learn from itself). */
export function harnessDerived(r: { scope: { repos: string[] }; evidence: { sources: string[] } }, owned: Set<string>, ctx: RenderContext): boolean {
  if (!owned.size) return false;
  const repos = allRepoFacts(ctx).filter((f) => r.scope.repos.includes('*') || r.scope.repos.includes(f.id));
  let files = 0;
  let mine = 0;
  for (const src of r.evidence.sources) {
    const m = /^([a-z-]+):([^#\s]+)/i.exec(src);
    if (!m || m[1] === 'probe' || m[1] === 'review' || m[1] === 'judgment') continue;
    files++;
    if (repos.some((f) => owned.has(path.resolve(f.path, m[2]))) || owned.has(path.resolve(m[2]))) mine++;
  }
  return files > 0 && mine === files;
}

/** The harness's own permission rules, in the spelling assess uses for safety rules. */
function ownRuleTexts(p: ReturnType<typeof renderHarness>['permissions']): Set<string> {
  const out = new Set<string>();
  for (const x of [...p.rules.claude.deny, ...p.rules.claude.allow, ...p.claudeAsk, ...p.rules.devin.deny, ...p.rules.devin.ask, ...p.rules.devin.allow]) out.add(normRule(x));
  for (const line of p.codexRules.split('\n')) {
    const m = /prefix_rule\(pattern=\[(.*?)\], decision="(\w+)"/.exec(line);
    if (!m) continue;
    try {
      const words = JSON.parse(`[${m[1]}]`) as string[];
      out.add(normRule(`${words.join(' ')} (${m[2]})`));
    } catch {
      /* not ours */
    }
  }
  return out;
}

function normRule(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function inHarnessBlock(file: string, line: number | undefined): boolean {
  if (!line) return false;
  const text = readTextOr(file, null);
  return text !== null && harnessBlockLines(text.replace(/\r\n/g, '\n')).has(line);
}

function destWord(u: UnitMove): string {
  switch (u.dest) {
    case 'archive':
      return u.rule ? '-> check + archive' : '-> archive';
    case 'quarantine':
      return '-> quarantine';
    case 'fix':
      return '-> corrected';
    case 'split':
      return '-> task skill reference';
    case 'advisory':
      return '(stays; advisory)';
    default:
      return '';
  }
}

/**
 * Which of the user's files a plan may change. Personal: only files inside
 * the repository. Team: the user-level agent files, the workspace folder
 * itself and the folders named with --include (repo files are filtered later:
 * tracked ones are never changed). Never an ancestor folder's file: it
 * belongs to something else.
 */
export function inScope(setting: Setting, f: { path: string; level?: string }, workspaceRoot: string, userHome: string, includes: string[]): boolean {
  if (setting === 'personal') return subPath(workspaceRoot, f.path);
  if (subPath(workspaceRoot, f.path)) return true;
  if (includes.some((i) => subPath(path.resolve(i), f.path))) return true;
  if (f.level === 'user' && subPath(userHome, f.path)) return true;
  return false;
}

/** Team: an untracked user file inside a repository must be excluded before apply writes it. */
function needsExclude(p: string, workspaceRoot: string, hh: string): boolean {
  const repo = nearestRepoRoot(path.dirname(p));
  return !!repo && subPath(workspaceRoot, repo) && !subPath(hh, repo);
}

/** Build and save; returns the plan file path too. */
export function proposeAndSave(o: ProposeOptions): ProposeResult {
  const r = buildPlan(o);
  return { ...r, file: savePlan(r.plan) };
}

// ---------------------------------------------------------------------------
// plain-language output
// ---------------------------------------------------------------------------

const ACTION_WORD: Record<PlanTarget['action'], string> = { create: 'create', modify: 'change', delete: 'delete', 'merge-json': 'add to' };

export function formatPlan(plan: Plan, opts: { userHome?: string; diffs?: boolean; file?: string } = {}): string {
  const uh = opts.userHome ?? defaultUserHome();
  const L: string[] = [];
  L.push(`Plan ${plan.id} (${plan.setting} setting; agents ${plan.agents.join(', ')}): ${plan.targets.length} file(s).`);
  if (opts.file) L.push(`Saved: ${opts.file}`);
  if (!plan.targets.length) L.push('Nothing to change: the harness is already in place for this setting.');
  plan.targets.forEach((t, i) => {
    const who = t.owner === 'user' ? 'your file: a proposal you approve' : 'generated by the harness';
    L.push('');
    L.push(`${i + 1}. ${ACTION_WORD[t.action]} ${homeRelative(t.path, uh)}  (${who})`);
    for (const h of t.hunks) L.push(`   - [${h.checkId}] ${h.reason}  (from ${h.provenance})`);
    if (opts.diffs !== false && t.diff) {
      const d = t.diff.split('\n');
      const max = 200;
      L.push(...d.slice(0, max).map((x) => '   ' + x));
      if (d.length > max) L.push(`   ... ${d.length - max} more diff lines in the plan file`);
    }
  });
  if (plan.notes.length) {
    L.push('');
    L.push('Notes:');
    for (const n of plan.notes) L.push(...n.split('\n').map((x, j) => (j === 0 ? `- ${x}` : `  ${x}`)));
  }
  return L.join('\n') + '\n';
}

/** A short count of hunks per check id (for summaries and tests). */
export function hunkCounts(plan: Plan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of plan.targets) for (const h of t.hunks) out[h.checkId] = (out[h.checkId] ?? 0) + 1;
  return out;
}

export { plansDir };
