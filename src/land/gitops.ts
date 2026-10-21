/**
 * Git operations the landing actor and the runner share. Every call is an
 * argv array through src/lib/exec with a timeout. Nothing here rewrites
 * history: commits are only ever added (merge, commit-tree, a revert
 * commit), refs only move forward (`merge --ff-only`), pushes are plain.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ledger } from '../types';
import { rawGit } from '../lib/git';
import { ensureDir, readJsonOr } from '../lib/fsx';
import { harnessHome, ledgerPath, worktreesHome } from '../lib/paths';
import { checkCommitSubjects } from '../discover/checks';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function git(dir: string, args: string[], timeoutMs = 60_000, input?: string): GitResult {
  if (input === undefined) return rawGit(dir, args, timeoutMs);
  const { run } = require('../lib/exec') as typeof import('../lib/exec');
  return run('git', ['-c', 'core.quotepath=off', ...args], { cwd: dir, timeoutMs, input });
}

export function gitOk(dir: string, args: string[], timeoutMs = 60_000): string | null {
  const r = git(dir, args, timeoutMs);
  return r.code === 0 ? r.stdout.trim() : null;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** Short branch name (`main`, `task/T-001`), null when detached. */
  branch: string | null;
  bare: boolean;
}

/** `git worktree list --porcelain`; the first entry is the main working tree. */
export function listWorktrees(dir: string): WorktreeEntry[] {
  const r = git(dir, ['worktree', 'list', '--porcelain'], 15_000);
  if (r.code !== 0) return [];
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: path.resolve(line.slice(9)), head: null, branch: null, bare: false };
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (cur && line === 'bare') cur.bare = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** The main working tree of the repository holding `dir` (where `.git` is a folder). */
export function mainWorktreeRoot(dir: string): string | null {
  const w = listWorktrees(dir).find((e) => !e.bare);
  return w ? w.path : null;
}

export function worktreeOn(dir: string, branch: string): WorktreeEntry | null {
  return listWorktrees(dir).find((e) => e.branch === branch) ?? null;
}

export function resolveSha(dir: string, ref: string): string | null {
  return gitOk(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10_000);
}

export function branchExists(dir: string, branch: string): boolean {
  return git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 10_000).code === 0;
}

export function isAncestor(dir: string, a: string, b: string): boolean {
  return git(dir, ['merge-base', '--is-ancestor', a, b], 15_000).code === 0;
}

export function treeOf(dir: string, ref: string): string | null {
  return gitOk(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], 10_000);
}

/** Commits in a range, newest first. */
export function revList(dir: string, range: string): string[] {
  const out = gitOk(dir, ['rev-list', range], 30_000);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

export function countBehind(dir: string, tip: string, main: string): number {
  const out = gitOk(dir, ['rev-list', '--count', `${tip}..${main}`], 15_000);
  return out ? Number(out) || 0 : 0;
}

/** Changed paths between two commits (both sides of renames). */
export function changedPaths(dir: string, a: string, b: string): string[] {
  const out = gitOk(dir, ['diff', '--name-only', '--no-renames', a, b], 30_000);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

/** Uncommitted changes (tracked and untracked, not ignored), as repo-relative paths. */
export function dirtyPaths(dir: string): string[] {
  const r = git(dir, ['status', '--porcelain=v1', '--untracked-files=all'], 30_000);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
}

/** Whether a merge, rebase, cherry-pick or revert is in progress in a worktree. */
export function operationInProgress(dir: string): string | null {
  const gd = gitOk(dir, ['rev-parse', '--git-dir'], 5000);
  if (!gd) return null;
  const abs = path.resolve(dir, gd);
  for (const f of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) if (fs.existsSync(path.join(abs, f))) return f;
  return null;
}

/** The remote `main` pushes to: `branch.<main>.remote`, else `origin` when it exists; null without remotes. */
export function remoteFor(dir: string, branch: string): string | null {
  const configured = gitOk(dir, ['config', '--get', `branch.${branch}.remote`], 5000);
  const remotes = (gitOk(dir, ['remote'], 5000) ?? '').split(/\r?\n/).filter(Boolean);
  if (configured && remotes.includes(configured)) return configured;
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] : null;
}

export function remoteUrl(dir: string, remote: string): string | null {
  return gitOk(dir, ['remote', 'get-url', remote], 5000);
}

/** `main` unless the flag names another branch; `master` when `main` does not exist. */
export function mainBranchName(dir: string, flag?: string): string {
  if (flag) return flag;
  if (branchExists(dir, 'main')) return 'main';
  if (branchExists(dir, 'master')) return 'master';
  return 'main';
}

function identityArgs(dir: string): string[] {
  const email = gitOk(dir, ['config', '--get', 'user.email'], 5000);
  const name = gitOk(dir, ['config', '--get', 'user.name'], 5000);
  const out: string[] = [];
  if (!name) out.push('-c', 'user.name=harness');
  if (!email) out.push('-c', 'user.email=harness@localhost.invalid');
  return out;
}

/** An empty folder used as core.hooksPath for commits that must not run repo hooks (the revert). */
export function noHooksDir(): string {
  const d = path.join(harnessHome(), 'state', 'no-git-hooks');
  ensureDir(d);
  return d;
}

/** A new commit object (no ref moved, no working tree touched). */
export function commitTree(dir: string, tree: string, parents: string[], message: string): string | null {
  const args = [...identityArgs(dir), 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'];
  const r = git(dir, args, 30_000, message);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `git commit` with the identity fallback; `noHooks` points core.hooksPath at an empty folder (used for the revert). */
export function commit(dir: string, message: string, opts: { noHooks?: boolean; allowEmpty?: boolean } = {}): GitResult {
  const args = [...identityArgs(dir), '-c', 'commit.gpgsign=false'];
  if (opts.noHooks) args.push('-c', `core.hooksPath=${noHooksDir()}`);
  args.push('commit', '-q', '-F', '-');
  if (opts.allowEmpty) args.push('--allow-empty');
  if (opts.noHooks) args.push('--no-verify');
  return git(dir, args, 120_000, message);
}

/** `git merge --no-ff <ref>` with a message; aborts on conflict and returns the conflicting paths. */
export function mergeInto(dir: string, ref: string, message: string): { ok: true; sha: string } | { ok: false; conflicts: string[]; detail: string } {
  const r = git(dir, [...identityArgs(dir), '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', message, ref], 300_000);
  if (r.code === 0) {
    const sha = resolveSha(dir, 'HEAD');
    return sha ? { ok: true, sha } : { ok: false, conflicts: [], detail: 'merge made no commit' };
  }
  const conflicts = (gitOk(dir, ['diff', '--name-only', '--diff-filter=U'], 15_000) ?? '').split(/\r?\n/).filter(Boolean);
  if (operationInProgress(dir) === 'MERGE_HEAD') git(dir, ['merge', '--abort'], 60_000);
  return { ok: false, conflicts, detail: (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' ') };
}

/** Fast-forward the branch checked out in `dir` to `sha`; never anything but a fast-forward. */
/**
 * A tree like `baseTree` with one file (repo-relative, forward slashes) set to `content`, built with
 * a temporary index (plumbing only: no working tree, no ref, no hook is touched). Null on failure.
 */
export function treeWithFile(dir: string, baseTree: string, rel: string, content: string): string | null {
  const { run } = require('../lib/exec') as typeof import('../lib/exec');
  const blob = git(dir, ['hash-object', '-w', '--stdin'], 30_000, content);
  if (blob.code !== 0 || !/^[0-9a-f]{40,64}$/.test(blob.stdout.trim())) return null;
  const idx = path.join(os.tmpdir(), `harness-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const opts = { cwd: dir, timeoutMs: 30_000, env: { ...process.env, GIT_INDEX_FILE: idx } };
  try {
    if (run('git', ['read-tree', baseTree], opts).code !== 0) return null;
    if (run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${rel}`], opts).code !== 0) return null;
    const w = run('git', ['write-tree'], opts);
    return w.code === 0 && w.stdout.trim() ? w.stdout.trim() : null;
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

/**
 * Make room in a checkout for an incoming version of one file the checkout holds as a local change
 * (modified or untracked): the local copy is removed (tracked: restored to HEAD) and a function that
 * puts it back is returned (null when the file was clean or absent, so there is nothing to undo).
 */
export function setAsideLocalFile(dir: string, rel: string): (() => void) | null {
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) return null;
  const st = git(dir, ['status', '--porcelain', '--untracked-files=all', '--', rel], 30_000);
  if (st.code !== 0 || !st.stdout.trim()) return null;
  const saved = fs.readFileSync(abs);
  const tracked = git(dir, ['ls-files', '--error-unmatch', '--', rel], 15_000).code === 0;
  if (tracked) {
    if (git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel], 30_000).code !== 0) return null;
  } else fs.rmSync(abs, { force: true });
  return () => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, saved);
  };
}

export function fastForward(dir: string, sha: string): GitResult {
  return git(dir, ['merge', '--ff-only', '-q', sha], 300_000);
}

/**
 * Share the main checkout's installed dependencies with a new worktree, the
 * way the gate's base-commit checkouts do (`linkNodeModules`): every
 * `node_modules` folder (to depth 3) mirrored as a real folder of links, so
 * the repository's own `node_modules/` ignore rule hides it from git and
 * workspace packages resolve inside the worktree. Without it the gate in
 * the worktree fails on every declared tool. Nothing is installed. Returns
 * the number of links made.
 */
export function linkDependencies(mainRoot: string, wt: string): number {
  if (path.resolve(mainRoot) === path.resolve(wt)) return 0;
  try {
    const { linkNodeModules } = require('../gate/checkout') as typeof import('../gate/checkout');
    return linkNodeModules(mainRoot, wt);
  } catch {
    return 0;
  }
}

/** Create (or reuse) a worktree for `branch` at `wtPath`; a new branch starts at `startPoint`. */
export function ensureWorktree(repoRoot: string, wtPath: string, branch: string, startPoint: string): { ok: true; created: boolean; branchCreated: boolean } | { ok: false; detail: string } {
  const existing = worktreeOn(repoRoot, branch);
  if (existing) {
    if (path.resolve(existing.path) === path.resolve(wtPath) || fs.existsSync(existing.path)) return { ok: true, created: false, branchCreated: false };
  }
  ensureDir(path.dirname(wtPath));
  git(repoRoot, ['worktree', 'prune'], 30_000);
  if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length) return { ok: false, detail: `${wtPath} exists and is not a worktree of ${branch}; move it away` };
  const has = branchExists(repoRoot, branch);
  const args = has ? ['worktree', 'add', '-q', wtPath, branch] : ['worktree', 'add', '-q', '-b', branch, wtPath, startPoint];
  const r = git(repoRoot, args, 300_000);
  if (r.code !== 0) return { ok: false, detail: (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(' ') };
  linkDependencies(mainWorktreeRoot(repoRoot) ?? repoRoot, wtPath);
  return { ok: true, created: true, branchCreated: !has };
}

/** Remove a worktree the harness created (the branch stays). */
export function removeWorktree(repoRoot: string, wtPath: string): boolean {
  const r = git(repoRoot, ['worktree', 'remove', '--force', wtPath], 120_000);
  return r.code === 0;
}

/**
 * Where the harness keeps its worktrees: `~/.harness-worktrees/<repoId>/<name>`, outside the harness
 * state folder, because the agent works in them and `~/.harness/**` is a protected root.
 */
export function harnessWorktreePath(repoId: string, name: string): string {
  return path.join(worktreesHome(), repoId, name.replace(/[^A-Za-z0-9._-]/g, '_'));
}

/**
 * Pick the first subject that follows the repository's commit-subject
 * standard (the ledger's `subjects` checks), so commits the harness makes
 * do not fail the gate's standards step in CI. Falls back to the first.
 */
export function pickSubject(candidates: string[], repoId?: string): string {
  const clean = candidates.map((c) => c.replace(/[\r\n]+/g, ' ').trim()).filter(Boolean);
  const ledger = readJsonOr<Ledger | null>(ledgerPath(), null);
  if (!ledger || !Array.isArray(ledger.records)) return clean[0];
  for (const c of clean) {
    try {
      if (!checkCommitSubjects(ledger, [c], repoId ? { repoId } : {}).length) return c;
    } catch {
      return clean[0];
    }
  }
  return clean[0];
}

/** Trim a title for a commit subject. */
export function subjectTitle(title: string, max = 60): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3).trimEnd() + '...' : t;
}

/**
 * A title as the summary of a `type: summary` subject: Conventional Commits summaries start in lower
 * case, so an ordinary first word is lowered (`Say how ...` -> `say how ...`); an acronym or a code
 * name (`API`, `CSV`, `iOS`) stays as written.
 */
export function summaryCase(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title;
}
