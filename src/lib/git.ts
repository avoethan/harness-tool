import * as path from 'node:path';
import { run } from './exec';

function git(cwd: string, args: string[], timeoutMs = 30000) {
  return run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs });
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], 5000).stdout.trim() === 'true';
}

export function toplevel(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--show-toplevel'], 5000);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Walk up from `p` to the nearest directory containing `.git`; null when none. */
export function nearestRepoRoot(p: string): string | null {
  let cur = path.resolve(p);
  for (;;) {
    if (require('node:fs').existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function headSha(dir: string): string | null {
  const r = git(dir, ['rev-parse', 'HEAD'], 5000);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Hash of the working tree (tracked + staged state), via a temporary index so the user's index is untouched.
 * `timeoutMs` bounds each of the two git calls (the Stop hook passes its remaining budget).
 */
export function writeTree(dir: string, timeoutMs = 60000): string | null {
  const tmpIndex = path.join(require('node:os').tmpdir(), `harness-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    const a = run('git', ['add', '-A', '--', '.'], { cwd: dir, env, timeoutMs });
    if (a.code !== 0) return null;
    const w = run('git', ['write-tree'], { cwd: dir, env, timeoutMs });
    return w.code === 0 ? w.stdout.trim() : null;
  } finally {
    try {
      require('node:fs').unlinkSync(tmpIndex);
    } catch {
      /* ignore */
    }
  }
}

export function isTracked(dir: string, file: string): boolean {
  const r = git(dir, ['ls-files', '--error-unmatch', '--', file], 5000);
  return r.code === 0;
}

/** Returns the matching ignore rule (`source:line:pattern`) or null when not ignored. */
export function checkIgnore(dir: string, file: string): string | null {
  const r = git(dir, ['check-ignore', '-v', '--', file], 5000);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

export function stagedFiles(dir: string): string[] {
  const r = git(dir, ['diff', '--cached', '--name-only'], 10000);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export function changedFiles(dir: string, base: string): string[] {
  const r = git(dir, ['diff', '--name-only', base], 30000);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export function currentBranch(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function recentSubjects(dir: string, n = 500): string[] {
  const r = git(dir, ['log', `-n${n}`, '--format=%s'], 30000);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export function remotes(dir: string): string[] {
  const r = git(dir, ['remote'], 5000);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export { git as rawGit };
