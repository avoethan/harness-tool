/**
 * The staging check after `git add` / `git commit -a` (DESIGN §2.10). The
 * hard block lives in the PreToolUse guard on `git commit`; this check runs
 * after the command so the agent hears about an offending staged path at
 * the moment it staged it, not only when it tries to commit.
 *
 * It asks the guard itself: for each staged path (and, after `commit -a`,
 * each path of the commit just made) it evaluates a synthetic `git commit`
 * with only that path staged and collects the guard's `staging` denials.
 * So the warning and the later block always agree: secrets and env files in
 * every setting; harness-owned, excluded and harness-shaped paths and new CI
 * workflows in the team setting.
 */
import * as path from 'node:path';
import type { HookInput } from '../types';
import type { HookContext } from '../hook';
import { evaluate } from '../guard';
import { allSegments, parseCommand } from '../guard/parse';
import { rawGit, stagedFiles } from '../lib/git';
import { buildGuardInput } from './PreToolUse';
import { hookCwd, repoOf } from './common';

export interface StagingHit {
  path: string;
  reason: string;
  where: 'staged' | 'last-commit';
}

export interface StagingResult {
  repoRoot: string;
  checked: number;
  offending: StagingHit[];
}

const MAX_FILES = 500;
const GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);

/** `git add` and `git commit -a` invocations in a command, with the folder each runs in. */
export function stagingCommands(command: string, cwd: string): Array<{ kind: 'add' | 'commit-all'; dir: string }> {
  const out: Array<{ kind: 'add' | 'commit-all'; dir: string }> = [];
  let segs;
  try {
    segs = allSegments(parseCommand(command));
  } catch {
    return out;
  }
  let cur = cwd;
  for (const seg of segs) {
    if (seg.depth === 0 && seg.prog === 'cd' && seg.args[0] && !seg.args[0].startsWith('-')) {
      cur = path.resolve(cur, seg.args[0]);
      continue;
    }
    if (seg.prog !== 'git') continue;
    const a = seg.args;
    let dir = cur;
    let i = 0;
    while (i < a.length && a[i].startsWith('-')) {
      if (a[i] === '-C' && a[i + 1]) dir = path.resolve(dir, a[i + 1]);
      i += GLOBAL_VALUE_OPTS.has(a[i]) ? 2 : 1;
    }
    const sub = a[i];
    const rest = a.slice(i + 1);
    if (sub === 'add') out.push({ kind: 'add', dir });
    else if (sub === 'commit' && rest.some((x) => x === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(x))) out.push({ kind: 'commit-all', dir });
  }
  return out;
}

function lastCommitFiles(root: string): string[] {
  const r = rawGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], 5000);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** Run the staging check for the repos a command staged into. Never throws for git errors. */
export function stagingCheck(input: HookInput, ctx: HookContext, command: string): StagingResult[] {
  const cmds = stagingCommands(command, hookCwd(input));
  const byRoot = new Map<string, Set<'add' | 'commit-all'>>();
  for (const c of cmds) {
    const hit = repoOf(c.dir);
    if (!hit) continue;
    const kinds = byRoot.get(hit.root) ?? new Set();
    kinds.add(c.kind);
    byRoot.set(hit.root, kinds);
  }
  const results: StagingResult[] = [];
  for (const [root, kinds] of byRoot) {
    const files: Array<{ f: string; where: StagingHit['where'] }> = stagedFiles(root).map((f) => ({ f, where: 'staged' as const }));
    if (kinds.has('commit-all')) for (const f of lastCommitFiles(root)) files.push({ f, where: 'last-commit' });
    const gi = buildGuardInput({ ...input, tool_name: 'Bash', tool_input: { command: 'git commit -m harness-staging-check' }, cwd: root }, ctx);
    const offending: StagingHit[] = [];
    const seen = new Set<string>();
    for (const { f, where } of files.slice(0, MAX_FILES)) {
      if (seen.has(where + f)) continue;
      seen.add(where + f);
      const d = evaluate({ ...gi, stagedFiles: () => [f], worktreeStatus: () => ({ modified: [], untracked: [] }) });
      if (d.decision === 'deny' && d.rail === 'staging') offending.push({ path: f, reason: d.reason, where });
    }
    results.push({ repoRoot: root, checked: Math.min(files.length, MAX_FILES), offending });
  }
  return results;
}

/** The warning text for the agent (at most `max` paths). */
export function stagingWarning(results: StagingResult[], max = 8): string | null {
  const hits = results.flatMap((r) => r.offending.map((o) => ({ ...o, root: r.repoRoot })));
  if (!hits.length) return null;
  const lines = ['harness staging check: these paths must not be committed.'];
  for (const h of hits.slice(0, max)) {
    if (h.where === 'staged') lines.push(`- ${h.path} is staged; unstage it with \`git restore --staged -- ${h.path}\`. (${h.reason})`);
    else lines.push(`- ${h.path} is in the commit just made; do not push it, and tell the user so they can remove it.`);
  }
  if (hits.length > max) lines.push(`(+${hits.length - max} more)`);
  return lines.join('\n');
}
