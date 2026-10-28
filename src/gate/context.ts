/**
 * Gate context: which repository, task and base commit the gate checks, the
 * tree it checks, and read-only views of the two trees (base and now).
 *
 * Everything the steps read about the change comes from git objects:
 *   - the tree hash is `git write-tree` of the working tree through a
 *     temporary index (the user's index is never touched; the staged tree in
 *     pre-commit mode),
 *   - the diff is `git diff-tree <base> <tree>` (renames detected),
 *   - file content at the base and now is read from blobs.
 * The gate's own configuration comes from the machine config and the
 * repository's `.harness/config.json` *at the base commit*, never from the
 * working tree, so a change cannot loosen the gate that checks it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Criterion, GateStep, HarnessConfig } from '../types';
import { run } from '../lib/exec';
import { rawGit, nearestRepoRoot, toplevel, headSha } from '../lib/git';
import { defaultConfig, loadConfig, repoIdFor } from '../lib/config';
import { hashJson } from '../lib/hash';
import { tryParseJsonc } from '../lib/jsonc';
import { readJsonOr } from '../lib/fsx';
import { runsDir } from '../lib/paths';
import { getCurrentTask, loadBrief, validId, type BriefFile } from '../intake/brief';
import { readPhaseRecord, type PhaseRecord } from '../intake/phase';
import { committedSince, indexOf, leftOutLine, partitionChanges, readStartSnapshot, recordStartSnapshot, treeStates, type StartSnapshot } from '../intake/localchanges';

/** git's empty tree: the base of a repository with no commits yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GateMode = 'task' | 'pre-commit' | 'pre-push' | 'ci';
export type HookName = 'pre-commit' | 'pre-push' | 'ci';

export interface DiffEntry {
  /** A added, M modified, D deleted, R renamed, C copied, T type change. */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  /** For R and C: the path at the base. */
  oldPath?: string;
}

export interface TreeEntry {
  mode: string;
  blob: string;
}

export interface AddedLine {
  line: number;
  text: string;
}

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [k: string]: unknown;
}

export interface GateOptions {
  repo?: string;
  task?: string;
  base?: string;
  hook?: HookName;
  /** Override the working-tree hash (tests). */
  tree?: string;
  sessionId?: string;
}

const DEFAULT_TIMEOUTS: Record<string, number> = {
  build: 600_000,
  typecheck: 600_000,
  lint: 300_000,
  tests: 1_200_000,
  acceptance: 300_000,
  coverage: 1_200_000,
  affected: 1_200_000,
};

function git(root: string, args: string[], timeoutMs = 60_000) {
  return rawGit(root, args, timeoutMs);
}

export function isCommit(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10_000).code === 0;
}

export function resolveCommit(root: string, ref: string): string | null {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10_000);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The repository root holding `p` the same way the hooks find it (walk up to `.git`), else git's top level. */
export function resolveRepoRoot(p: string): string | null {
  const abs = path.resolve(p);
  return nearestRepoRoot(abs) ?? toplevel(abs);
}

/**
 * `git write-tree` of the working tree (tracked, modified and untracked files
 * that are not ignored) through a temporary index seeded from the real one, so
 * unchanged files are not re-hashed. The user's index is never written.
 * Produces the same hash as `writeTree` in src/lib/git (which the Stop hook uses).
 */
export function workingTree(root: string, timeoutMs = 120_000): string | null {
  const tmpIndex = path.join(os.tmpdir(), `harness-gate-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const ip = git(root, ['rev-parse', '--git-path', 'index'], 10_000);
    if (ip.code === 0) {
      const real = path.resolve(root, ip.stdout.trim());
      try {
        fs.copyFileSync(real, tmpIndex);
        // Keep the index's own time: git rehashes an entry whose file is not older than the index
        // ("racy git"); a copy stamped now would hide a same-size edit made in the same second.
        const st = fs.statSync(real);
        fs.utimesSync(tmpIndex, st.atime, st.mtime);
      } catch {
        /* no index yet (fresh repository): start empty */
      }
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const a = run('git', ['add', '-A', '--', '.'], { cwd: root, env, timeoutMs });
    if (a.code !== 0) return null;
    const w = run('git', ['write-tree'], { cwd: root, env, timeoutMs });
    return w.code === 0 ? w.stdout.trim() : null;
  } finally {
    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      /* ignore */
    }
  }
}

/** The staged tree (pre-commit): `git write-tree` of the real index (writes tree objects only). */
export function stagedTree(root: string): string | null {
  const w = git(root, ['write-tree'], 60_000);
  return w.code === 0 ? w.stdout.trim() : null;
}

/** Every file in a tree with its mode and blob id (`git ls-tree -r -z`). */
export function listTree(root: string, tree: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const r = git(root, ['ls-tree', '-r', '-z', '--full-tree', tree], 60_000);
  if (r.code !== 0) return out;
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blob] = rec.slice(0, tab).split(' ');
    if (type !== 'blob') continue;
    out.set(rec.slice(tab + 1), { mode, blob });
  }
  return out;
}

/** Name-status diff between two trees or commits, renames detected. */
export function diffTrees(root: string, base: string, tree: string): DiffEntry[] {
  const r = git(root, ['diff-tree', '-r', '-M', '-z', '--no-ext-diff', '--name-status', base, tree], 60_000);
  if (r.code !== 0) return [];
  const parts = r.stdout.split('\0');
  const out: DiffEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!st) continue;
    const s = st[0] as DiffEntry['status'];
    if (s === 'R' || s === 'C') {
      out.push({ status: s, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      out.push({ status: s, path: parts[i + 1] });
      i += 1;
    }
  }
  return out.filter((e) => e.path);
}

function unquoteGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p.slice(1, -1);
  }
}

/** Added lines per file (new line numbers) between two trees, from a zero-context diff. */
export function addedLinesBetween(root: string, base: string, tree: string, paths?: string[]): Map<string, AddedLine[]> {
  // core.quotepath=false: a non-ASCII path keeps its own name in the `+++ b/<path>` line.
  const args = ['-c', 'core.quotepath=false', 'diff-tree', '-r', '-M', '-p', '-U0', '--no-color', '--no-ext-diff', base, tree];
  if (paths?.length) args.push('--', ...paths);
  const r = git(root, args, 120_000);
  const out = new Map<string, AddedLine[]>();
  if (r.code !== 0) return out;
  let file: string | null = null;
  let next = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = unquoteGitPath(line.slice(4).trim());
      file = p === '/dev/null' ? null : p.replace(/^"?b\//, '');
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      next = Number(h[1]);
      continue;
    }
    if (file && line.startsWith('+')) {
      const l = out.get(file) ?? [];
      l.push({ line: next, text: line.slice(1) });
      out.set(file, l);
      next++;
    }
  }
  return out;
}

export function isBinary(text: string): boolean {
  return text.includes('\0');
}

// ---------------------------------------------------------------------------
// File classes
// ---------------------------------------------------------------------------

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|rs|swift)$/i;

/** A test file: under a test folder, or named *.test.* / *.spec.* / test_*.py / *_test.(py|go). */
export function isTestFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  if (!CODE_EXT.test(p)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(p)) return true;
  if (/(^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/i.test(p)) return true;
  return /(^|\/)(?:__tests__|tests?|specs?|e2e)\//i.test(p) && !/(^|\/)node_modules\//.test(p);
}

/** Golden and snapshot files. */
export function isGoldenFile(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return /(^|\/)__snapshots__\//.test(p) || /\.snap$/i.test(p) || /(^|\/)(?:golden|goldens|__golden__|__goldens__)\//i.test(p) || /\.golden(?:\.[^/]+)?$/i.test(p);
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

export interface GateContext {
  root: string;
  repoId: string;
  repoName: string;
  taskId: string;
  taskSource: 'flag' | 'current-task' | 'hook' | 'adhoc';
  runDir: string;
  mode: GateMode;
  base: string;
  baseSource: string;
  head: string | null;
  tree: string;
  entries: Map<string, TreeEntry>;
  baseEntries: Map<string, TreeEntry>;
  diff: DiffEntry[];
  config: HarnessConfig;
  configHash: string;
  brief: BriefFile | null;
  /** The brief's criteria that belong to this repository. */
  criteria: Criterion[];
  phase: PhaseRecord | null;
  basePkg: PackageJson | null;
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun';
  warnings: string[];
  sessionId?: string;
  /** The results of the steps that already ran in this gate run (set by `runGate`; a `gate` check reads them). */
  stepResults?: GateStep[];
  timeout(step: string): number;
  /** Text of a file at the base (null when absent or binary). */
  baseText(rel: string): string | null;
  /** Text of a file in the checked tree (null when absent or binary). */
  nowText(rel: string): string | null;
  /** Added lines per changed file (cached). */
  addedLines(): Map<string, AddedLine[]>;
  /** Paths changed and still present (A, M, R, C, T). */
  changedPresent(): string[];
  /**
   * Local changes present when the ticket started (src/intake/localchanges.ts): `diff` and
   * `addedLines` already leave out `leftOut`; `changedSince` are recorded paths changed during the ticket.
   */
  local: LocalChanges;
}

export interface LocalChanges {
  snapshot: StartSnapshot | null;
  leftOut: string[];
  changedSince: string[];
}

export class GateError extends Error {
  constructor(
    message: string,
    public exitCode = 1,
  ) {
    super(message);
  }
}

function blobText(root: string, blob: string, cache: Map<string, string | null>): string | null {
  if (cache.has(blob)) return cache.get(blob)!;
  const r = git(root, ['cat-file', 'blob', blob], 30_000);
  const t = r.code === 0 && !isBinary(r.stdout) ? r.stdout : null;
  cache.set(blob, t);
  return t;
}

function packageManagerFor(pkg: PackageJson | null, baseEntries: Map<string, TreeEntry>): GateContext['pm'] {
  const pmField = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (pmField === 'pnpm' || pmField === 'yarn' || pmField === 'bun' || pmField === 'npm') return pmField;
  if (baseEntries.has('pnpm-lock.yaml')) return 'pnpm';
  if (baseEntries.has('yarn.lock')) return 'yarn';
  if (baseEntries.has('bun.lockb') || baseEntries.has('bun.lock')) return 'bun';
  return 'npm';
}

/** Machine config overlaid with the repository's `.harness/config.json` as it was at the base commit. */
export function configAtBase(root: string, base: string): HarnessConfig {
  const machine = loadConfig() ?? defaultConfig({ workspaceRoot: root });
  const r = git(root, ['cat-file', 'blob', `${base}:.harness/config.json`], 10_000);
  if (r.code !== 0) return machine;
  const parsed = tryParseJsonc<Partial<HarnessConfig>>(r.stdout);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return machine;
  const overlay = parsed.value;
  return { ...machine, ...overlay, version: 1, db: machine.db, mcp: machine.mcp, caps: machine.caps, workspaceRoot: machine.workspaceRoot } as HarnessConfig;
}

/** The criteria of a brief that belong to a repository (by unit, else every criterion when the brief names this repo or none). */
export function criteriaForRepo(brief: BriefFile | null, repoId: string): Criterion[] {
  if (!brief) return [];
  const ids = new Set<string>();
  for (const u of brief.units ?? []) if (u.repo === repoId) for (const c of u.criteria) ids.add(c);
  if (!ids.size) {
    // a repository added during the ticket for a supporting change carries no criterion of its own
    if ((brief.addedRepos ?? []).some((a) => repoIdFor(a.path) === repoId)) return [];
    const repos = brief.repos ?? [];
    const metaRepos = Object.values(brief.criteriaMeta ?? {}).flatMap((m) => m.repos ?? []);
    if (!repos.length || repos.includes(repoId) || (!metaRepos.length && repos.length <= 1)) return brief.criteria;
    return brief.criteria.filter((c) => (brief.criteriaMeta?.[c.id]?.repos ?? []).includes(repoId));
  }
  return brief.criteria.filter((c) => ids.has(c.id));
}

function upstreamBase(root: string): string | null {
  const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 5000);
  if (up.code === 0 && up.stdout.trim()) {
    const mb = git(root, ['merge-base', 'HEAD', up.stdout.trim()], 10_000);
    if (mb.code === 0 && mb.stdout.trim()) return mb.stdout.trim();
  }
  return null;
}

function defaultBranchBase(root: string): string | null {
  const head = headSha(root);
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (!isCommit(root, ref)) continue;
    const mb = git(root, ['merge-base', 'HEAD', ref], 10_000);
    const sha = mb.code === 0 ? mb.stdout.trim() : '';
    if (sha && sha !== head) return sha;
  }
  return null;
}

function parentOfHead(root: string): string | null {
  return resolveCommit(root, 'HEAD^');
}

export interface BaseChoice {
  base: string;
  source: string;
}

/** Pick the base commit for a run (see README: flag, brief, previous evidence, HEAD; hook modes: HEAD / upstream / CI base). */
export function chooseBase(root: string, mode: GateMode, opts: { flag?: string; brief?: BriefFile | null; repoId: string; previousBase?: string }): BaseChoice {
  if (opts.flag) {
    const sha = resolveCommit(root, opts.flag);
    if (!sha) throw new GateError(`--base ${opts.flag} is not a commit in this repository`, 2);
    return { base: sha, source: 'flag' };
  }
  const head = headSha(root);
  if (mode === 'pre-commit') return head ? { base: head, source: 'HEAD' } : { base: EMPTY_TREE, source: 'empty tree (no commits yet)' };
  if (mode === 'pre-push' || mode === 'ci') {
    const ref = process.env.GITHUB_BASE_REF;
    if (mode === 'ci' && ref && /^[\w./-]+$/.test(ref)) {
      for (const cand of [`origin/${ref}`, ref]) {
        if (!isCommit(root, cand)) continue;
        const mb = git(root, ['merge-base', 'HEAD', cand], 10_000);
        if (mb.code === 0 && mb.stdout.trim()) return { base: mb.stdout.trim(), source: `merge-base with ${cand}` };
      }
    }
    const up = upstreamBase(root);
    if (up && up !== head) return { base: up, source: 'merge-base with the upstream branch' };
    const def = defaultBranchBase(root);
    if (def) return { base: def, source: 'merge-base with the default branch' };
    const parent = parentOfHead(root);
    if (parent) return { base: parent, source: 'parent of HEAD' };
    return head ? { base: head, source: 'HEAD' } : { base: EMPTY_TREE, source: 'empty tree (no commits yet)' };
  }
  const fromBrief = opts.brief?.baseShas?.[opts.repoId];
  if (fromBrief) {
    const sha = resolveCommit(root, fromBrief);
    if (sha) return { base: sha, source: 'brief (HEAD at intake)' };
  }
  if (opts.previousBase && opts.previousBase !== EMPTY_TREE) {
    const sha = resolveCommit(root, opts.previousBase);
    if (sha) return { base: sha, source: 'previous gate run of this task' };
  }
  if (opts.previousBase === EMPTY_TREE) return { base: EMPTY_TREE, source: 'previous gate run of this task' };
  return head ? { base: head, source: 'HEAD (first gate run of this task)' } : { base: EMPTY_TREE, source: 'empty tree (no commits yet)' };
}

/** The task id a run writes evidence for. */
export function chooseTask(repoId: string, opts: { task?: string; hook?: HookName }): { taskId: string; source: GateContext['taskSource'] } {
  if (opts.task) {
    if (!validId(opts.task)) throw new GateError(`invalid task id: ${JSON.stringify(opts.task.slice(0, 40))}`, 2);
    return { taskId: opts.task, source: 'flag' };
  }
  if (opts.hook) return { taskId: `hook-${opts.hook}`, source: 'hook' };
  const cur = getCurrentTask(repoId);
  if (cur) return { taskId: cur, source: 'current-task' };
  return { taskId: 'adhoc', source: 'adhoc' };
}

/** Drop the left-out paths (a path the diff header spells differently stays in: scanned, never hidden). */
function dropPaths<V>(m: Map<string, V>, drop: Set<string> | null): Map<string, V> {
  if (!drop) return m;
  for (const k of drop) m.delete(k);
  return m;
}

/**
 * The task's start snapshot (task mode with a brief only; hook runs check what is committed or staged).
 * A task without one gets it now, guarded so that nothing changed after the task started is recorded.
 */
function startSnapshotFor(root: string, repoId: string, taskId: string, mode: GateMode, brief: BriefFile | null, tree: string): { snapshot: StartSnapshot | null } {
  if (mode !== 'task' || !brief || !validId(repoId) || !validId(taskId)) return { snapshot: null };
  const have = readStartSnapshot(repoId, taskId);
  if (have) return { snapshot: have };
  try {
    return { snapshot: recordStartSnapshot(root, { repoId, taskId, by: 'gate', tree, taskStart: brief.createdAt }).snapshot };
  } catch {
    return { snapshot: null };
  }
}

/** The gate's diff without the local changes present at the start (one decision: isTicketPath). */
function partitionLocal(root: string, snap: StartSnapshot, diff: DiffEntry[], tree: string) {
  const idx = indexOf(snap, committedSince(root, snap.base, headSha(root)));
  if (!idx) return null;
  const states = treeStates(root, tree);
  return partitionChanges(diff, idx, (p) => states.get(p) ?? null);
}

export function buildContext(opts: GateOptions): GateContext {
  const start = path.resolve(opts.repo ?? process.cwd());
  if (!fs.existsSync(start)) throw new GateError(`no such folder: ${start}`, 2);
  const root = resolveRepoRoot(start);
  if (!root) throw new GateError(`${start} is not inside a git repository; the gate needs git to hash the tree and diff against the base commit`, 2);
  const repoId = repoIdFor(root);
  const mode: GateMode = opts.hook ?? 'task';
  const { taskId, source: taskSource } = chooseTask(repoId, opts);
  const runDir = path.join(runsDir(), repoId, taskId);
  // Hook runs read the current task's brief (allowed paths, acceptance checks) when there is one.
  const briefId = opts.hook ? getCurrentTask(repoId) : taskId;
  const brief = briefId ? loadBrief(briefId) : null;
  const prev = readJsonOr<{ baseSha?: string } | null>(path.join(runDir, 'evidence.json'), null);
  const { base, source: baseSource } = chooseBase(root, mode, { flag: opts.base, brief, repoId, previousBase: mode === 'task' ? prev?.baseSha : undefined });
  const tree = opts.tree ?? (mode === 'pre-commit' ? stagedTree(root) : workingTree(root));
  if (!tree) throw new GateError('could not hash the working tree (git add/write-tree failed); check that git works in this repository', 1);
  const entries = listTree(root, tree);
  const baseEntries = base === EMPTY_TREE ? new Map<string, TreeEntry>() : listTree(root, base);
  const rawDiff = base === tree ? [] : diffTrees(root, base, tree);
  const local = startSnapshotFor(root, repoId, taskId, mode, brief, tree);
  const split = local.snapshot ? partitionLocal(root, local.snapshot, rawDiff, tree) : null;
  const diff = split ? split.kept : rawDiff;
  const config = configAtBase(root, base);
  const blobCache = new Map<string, string | null>();
  const baseText = (rel: string) => {
    const e = baseEntries.get(rel);
    return e ? blobText(root, e.blob, blobCache) : null;
  };
  const nowText = (rel: string) => {
    const e = entries.get(rel);
    return e ? blobText(root, e.blob, blobCache) : null;
  };
  let pkg: PackageJson | null = null;
  const pkgText = baseText('package.json');
  if (pkgText) {
    const p = tryParseJsonc<PackageJson>(pkgText);
    if (p.ok && p.value && typeof p.value === 'object') pkg = p.value;
  }
  let added: Map<string, AddedLine[]> | null = null;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(config.gate?.timeoutsMs ?? {}) };
  const phase = mode === 'task' && validId(repoId) && validId(taskId) ? readPhaseRecord(repoId, taskId) : null;
  const warnings: string[] = [];
  if (split?.leftOut.length) warnings.push(leftOutLine(split.leftOut.length));
  const kept = new Set(diff.flatMap((d) => [d.path, d.oldPath ?? d.path]));
  const dropped = split?.leftOut.length ? new Set(split.leftOut.filter((p) => !kept.has(p))) : null;
  return {
    root,
    repoId,
    repoName: path.basename(root),
    taskId,
    taskSource,
    runDir,
    mode,
    base,
    baseSource,
    head: headSha(root),
    tree,
    entries,
    baseEntries,
    diff,
    config,
    configHash: hashJson({ gate: config.gate ?? null, setting: config.setting }),
    brief,
    criteria: criteriaForRepo(brief, repoId),
    phase,
    basePkg: pkg,
    pm: packageManagerFor(pkg, baseEntries),
    warnings,
    sessionId: opts.sessionId,
    timeout: (step: string) => {
      const n = timeouts[step];
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 600_000;
    },
    baseText,
    nowText,
    addedLines: () => (added ??= base === tree || !diff.length ? new Map() : dropPaths(addedLinesBetween(root, base, tree), dropped)),
    changedPresent: () => diff.filter((d) => d.status !== 'D').map((d) => d.path),
    local: { snapshot: local.snapshot, leftOut: split?.leftOut ?? [], changedSince: split?.changedSince ?? [] },
  };
}
