/**
 * The pause/resume round trip of a task worktree (DESIGN §2.13).
 *
 *   harness run pause  [--task <id>]   write the trail (~/.harness/trail/<id>.md)
 *                                      and a `wip: pause` commit on task/<id>
 *                                      (the hooks' own pause commit: never on
 *                                      main, never pushed, secrets refused)
 *   harness run resume [--task <id>]   read the trail, re-run the gate in the
 *                                      worktree (an inherited "verified" claim
 *                                      is never trusted), then continue: land
 *                                      on PASS, else a fresh session with the
 *                                      trail and the gate report.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from '../types';
import { repoIdFor } from '../lib/config';
import { readJsonOr } from '../lib/fsx';
import { nearestRepoRoot, writeTree } from '../lib/git';
import { instrument } from '../lib/log';
import { runsDir } from '../lib/paths';
import { getCurrentTask, loadBrief, validId } from '../intake/brief';
import { claimTask, readLedger, DEFAULT_STALE_MINUTES } from '../intake/ledger';
import { dirtyPaths, ensureWorktree, gitOk, harnessWorktreePath, mainBranchName, mainWorktreeRoot, worktreeOn } from '../land/gitops';
import { wipCommit } from '../hooks/pause';
import { trailPath, writeTrail } from './trail';
import { capsFromConfig } from './caps';
import type { SessionAgent } from './session';

export interface PauseInput {
  mainRoot: string;
  repoId: string;
  taskId: string;
  worktree: string;
  branch: string;
  agent: SessionAgent;
  note?: string;
}

export interface PauseResult {
  trail: string;
  /** One line about the pause commit (made, or why not). */
  wip: string;
  made: boolean;
  sha?: string;
}

/** Write the trail and make the `wip: pause` commit on the task branch. */
export function pauseTask(p: PauseInput): PauseResult {
  const wtRepoId = repoIdFor(p.worktree);
  const now = new Date().toISOString();
  const files = dirtyPaths(p.worktree).map((rel) => ({ rel, ts: now }));
  let made = false;
  let sha: string | undefined;
  let line: string;
  try {
    const w = wipCommit(p.worktree, { cwd: p.worktree, hook_event_name: 'SessionEnd' }, { agent: p.agent as AgentId, event: 'SessionEnd', sessionId: `run-pause-${p.taskId}` }, 'manual');
    made = w.made;
    sha = w.sha;
    line = w.made ? `wip: pause commit ${w.sha} on branch ${w.branch} (not pushed).` : `No pause commit: ${w.reason}.`;
  } catch (e) {
    line = `No pause commit: ${String((e as Error)?.message ?? e).slice(0, 100)}.`;
  }
  const ev =
    readJsonOr<{ verdict: 'PASS' | 'FAIL' | 'BLOCKED'; treeHash: string; finishedAt: string; reasons: string[]; cap_reached?: boolean } | null>(path.join(runsDir(), wtRepoId, p.taskId, 'evidence.json'), null) ??
    readJsonOr(path.join(runsDir(), p.repoId, p.taskId, 'evidence.json'), null);
  const trail = writeTrail({
    taskId: p.taskId,
    repoId: wtRepoId,
    repoRoot: p.worktree,
    agent: p.agent as AgentId,
    reason: 'manual',
    intent: loadBrief(p.taskId)?.title ?? null,
    files,
    editCount: files.length,
    evidence: ev ? { verdict: ev.verdict, treeHash: ev.treeHash, finishedAt: ev.finishedAt, reasons: ev.reasons ?? [], capReached: ev.cap_reached === true } : null,
    treeNow: writeTree(p.worktree),
    next: `harness run resume --task ${p.taskId} (it re-runs the gate first, then continues in ${p.worktree})`,
    gotchas: p.note ? [p.note] : [],
    wip: line,
  });
  const { writeRunState } = require('./run') as typeof import('./run');
  writeRunState(p.repoId, { task: p.taskId, repoRoot: p.mainRoot, worktree: p.worktree, branch: p.branch, agent: p.agent, status: 'paused', wip: line });
  instrument({ event: 'run.pause', repo: p.repoId, task: p.taskId, agent: p.agent as AgentId, counts: { files: files.length, wip: made ? 1 : 0 } });
  return { trail, wip: line, made, ...(sha ? { sha } : {}) };
}

export interface TaskLocation {
  mainRoot: string;
  repoId: string;
  mainBranch: string;
  taskId: string;
  branch: string;
  worktree: string | null;
}

/** The task a pause or resume is about: the flag, the `task/<id>` branch checked out here, or the current task. */
export function locateTask(start: string, taskFlag?: string, mainFlag?: string): TaskLocation | { error: string } {
  const abs = path.resolve(start);
  const mainRoot = fs.existsSync(abs) ? mainWorktreeRoot(abs) : null;
  if (!mainRoot) return { error: `${abs} is not inside a git repository` };
  const repoId = repoIdFor(mainRoot);
  const mainBranch = mainBranchName(mainRoot, mainFlag);
  let taskId = taskFlag ?? null;
  const here = nearestRepoRoot(abs);
  if (!taskId && here) {
    const br = gitOk(here, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
    const m = br ? /^task\/(.+)$/.exec(br) : null;
    if (m) taskId = m[1];
    else taskId = getCurrentTask(repoIdFor(here)) ?? getCurrentTask(repoId);
  }
  if (!taskId) return { error: 'no task: pass --task <id>, or run from the task worktree' };
  if (!validId(taskId)) return { error: `invalid task id ${JSON.stringify(taskId.slice(0, 40))}` };
  const branch = `task/${taskId}`;
  const wt = worktreeOn(mainRoot, branch)?.path ?? null;
  return { mainRoot, repoId, mainBranch, taskId, branch, worktree: wt && fs.existsSync(wt) ? wt : null };
}

/** Resume a paused task: read the trail, re-run the gate, continue (see run.ts workTask). */
export async function resumeTask(
  opts: Omit<import('./run').RunOptions, 'agent'> & { task?: string; agent?: SessionAgent },
  deps: import('./run').RunDeps,
): Promise<{ ok: true; run: import('./run').TaskRun; trail: string } | { ok: false; error: string; exitCode: number }> {
  const say = deps.say ?? (() => undefined);
  const loc = locateTask(opts.repo ?? process.cwd(), opts.task, opts.main);
  if ('error' in loc) return { ok: false, error: loc.error, exitCode: 2 };
  const { teamRefusal } = require('../land/land') as typeof import('../land/land');
  const team = teamRefusal(loc.mainRoot);
  if (team) return { ok: false, error: `refused: ${team}`, exitCode: 4 };
  const trailFile = trailPath(loc.taskId);
  let trail: string;
  try {
    trail = fs.readFileSync(trailFile, 'utf8');
  } catch {
    return { ok: false, error: `no trail for ${loc.taskId} (${trailFile}): nothing was paused; start it with harness run`, exitCode: 1 };
  }
  const { readRunState, workTask } = require('./run') as typeof import('./run');
  const state = readRunState(loc.repoId, loc.taskId);
  const agent: SessionAgent = opts.agent ?? state?.agent ?? 'claude';
  const avail = deps.session.available(agent);
  if (!avail.ok) return { ok: false, error: `cannot start ${agent}: ${avail.reason}`, exitCode: 1 };
  let worktree = loc.worktree;
  if (!worktree) {
    const wt = harnessWorktreePath(loc.repoId, loc.taskId);
    const made = ensureWorktree(loc.mainRoot, wt, loc.branch, loc.mainBranch);
    if (!made.ok) return { ok: false, error: `cannot check out ${loc.branch}: ${made.detail}`, exitCode: 1 };
    worktree = wt;
  }
  const task = readLedger(loc.mainRoot).tasks.find((t) => t.id === loc.taskId);
  if (!task) return { ok: false, error: `${loc.taskId} is not in the task ledger (tasks/)`, exitCode: 1 };
  if (task.status !== 'claimed') {
    const c = claimTask(loc.mainRoot, task.id, agent, { staleMinutes: opts.staleMinutes ?? DEFAULT_STALE_MINUTES });
    if (!c.ok) return { ok: false, error: `cannot claim ${task.id} again: ${c.reason}`, exitCode: 1 };
  }
  say(`Resuming ${loc.taskId} in ${worktree} from its trail (${trailFile}):`);
  for (const l of trail.split('\n').filter((x) => x.trim())) say(`  | ${l}`);
  instrument({ event: 'run.resume', repo: loc.repoId, task: loc.taskId, agent: agent as AgentId });
  const caps = capsFromConfig(deps.config !== undefined ? deps.config : require('../lib/config').loadConfig(), opts.caps ?? {});
  const run = await workTask({ mainRoot: loc.mainRoot, repoId: loc.repoId, mainBranch: loc.mainBranch, task: readLedger(loc.mainRoot).tasks.find((t) => t.id === loc.taskId) ?? task, worktree, branch: loc.branch, caps, agent, gateFirst: true, trail }, { ...opts, agent }, deps);
  return { ok: true, run, trail };
}
