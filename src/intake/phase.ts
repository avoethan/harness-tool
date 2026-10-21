/**
 * Task phase record: `implement` (product code; test and golden files are
 * read-only for the agent) or `tests` (adding or changing tests is allowed,
 * logged and counted). Stored per task in the run folder:
 *
 *   ~/.harness/runs/<repoId>/<taskId>/phase.json
 *     { version, repo, task, phase, since, testsEntries, history[], updatedAt }
 *
 * The guard reads the phase from the session state first; `phaseForRepo` is
 * the fallback for a session that has none (the PreToolUse hook can call it
 * with the repo root it already resolves).
 */
import * as path from 'node:path';
import { readJsonOr, writeJson } from '../lib/fsx';
import { repoIdFor } from '../lib/config';
import { getCurrentTask, runDir } from './brief';

export type TaskPhase = 'implement' | 'tests';

export interface PhaseRecord {
  version: 1;
  repo: string;
  task: string;
  phase: TaskPhase;
  /** When the current phase started. */
  since: string;
  /** How many times the task entered the tests phase. */
  testsEntries: number;
  history: Array<{ phase: TaskPhase; at: string; sessionId?: string }>;
  updatedAt: string;
}

const MAX_HISTORY = 200;

export function isTaskPhase(p: unknown): p is TaskPhase {
  return p === 'implement' || p === 'tests';
}

export function phasePath(repoId: string, taskId: string): string {
  return path.join(runDir(repoId, taskId), 'phase.json');
}

export function readPhaseRecord(repoId: string, taskId: string): PhaseRecord | null {
  let p: string;
  try {
    p = phasePath(repoId, taskId);
  } catch {
    return null;
  }
  const r = readJsonOr<PhaseRecord | null>(p, null);
  return r && r.version === 1 && isTaskPhase(r.phase) ? r : null;
}

/** Record the phase for a task. Entering `tests` from anything else counts one entry. */
export function setTaskPhase(repoId: string, taskId: string, phase: TaskPhase, opts: { sessionId?: string; now?: Date } = {}): PhaseRecord {
  if (!isTaskPhase(phase)) throw new Error(`unknown phase: ${String(phase)}`);
  const now = (opts.now ?? new Date()).toISOString();
  const prev = readPhaseRecord(repoId, taskId);
  const changed = !prev || prev.phase !== phase;
  const rec: PhaseRecord = {
    version: 1,
    repo: repoId,
    task: taskId,
    phase,
    since: changed ? now : prev!.since,
    testsEntries: (prev?.testsEntries ?? 0) + (phase === 'tests' && changed ? 1 : 0),
    history: changed ? [...(prev?.history ?? []), { phase, at: now, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }].slice(-MAX_HISTORY) : prev!.history,
    updatedAt: now,
  };
  writeJson(phasePath(repoId, taskId), rec);
  return rec;
}

export function getTaskPhase(repoId: string, taskId: string): TaskPhase | undefined {
  return readPhaseRecord(repoId, taskId)?.phase;
}

/** The phase of the current task of a repo (by its root path); undefined when no task or no phase is recorded. */
export function phaseForRepo(repoRoot: string): { phase?: TaskPhase; task?: string } {
  const repoId = repoIdFor(repoRoot);
  const task = getCurrentTask(repoId);
  if (!task) return {};
  const phase = getTaskPhase(repoId, task);
  return phase ? { phase, task } : { task };
}
