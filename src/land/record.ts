/**
 * The landing record: `~/.harness/runs/<repoId>/<taskId>/landing.json`,
 * rewritten after every transition so a cut-off landing still leaves its
 * state on disk. The top-level booleans are the landing metrics of
 * EVAL-PLAN §7 (`landed`, `post_landing_red`, `auto_fixed`, `reverted`,
 * `revert_correct`); `transitions` is the state machine's trail.
 *
 * Every transition is also an instrumentation event `land.<state>` with ids
 * and counts only (task id, short shas, step names), never text.
 */
import * as path from 'node:path';
import { readJsonOr, writeJson } from '../lib/fsx';
import { instrument } from '../lib/log';
import { runsDir } from '../lib/paths';

export type LandState =
  | 'start'
  | 'locked'
  | 'refused'
  | 'merged_main'
  | 'regated'
  | 'committed'
  | 'landed'
  | 'pushed'
  | 'push_failed'
  | 'ci'
  | 'post_landing_red'
  | 'rerun'
  | 'fix_started'
  | 'fix_failed'
  | 'auto_fixed'
  | 'revert_refused'
  | 'reverted'
  | 'requeued'
  | 'done';

export type LandOutcome = 'landed' | 'deflaked' | 'auto_fixed' | 'reverted' | 'refused' | 'failed' | 'dry-run';

export interface CiAttempt {
  kind: 'initial' | 'rerun' | 'after-fix';
  sha: string;
  status: 'green' | 'red' | 'none' | 'timeout' | 'error';
  detail: string;
  evidencePath?: string;
  durationMs: number;
}

export interface LandingRecord {
  version: 1;
  repo: string;
  task: string;
  branch: string;
  mainBranch: string;
  ci: 'local' | 'github' | 'none';
  squash: boolean;
  startedAt: string;
  finishedAt?: string;
  outcome?: LandOutcome;
  /** Plain-language reason when refused or failed. */
  reason?: string;
  // EVAL-PLAN §7 landing metrics.
  landed: boolean;
  post_landing_red: boolean;
  auto_fixed: boolean;
  reverted: boolean;
  /** Whether the revert restored main exactly and touched only the task and fix commits; null when there was no revert. */
  revert_correct: boolean | null;
  evidence?: { path: string; verdict: string; treeHash: string; tipTree: string; attempt?: number };
  merge?: { behindBy: number; mainSha: string; mergeCommit: string; touched: number; overlap: string[]; mode: 'partial' | 'full'; steps: Array<{ name: string; status: string }>; ok: boolean; note: string };
  /** main before the landing, the landed tip, and the commits it brought to main. */
  oldMain?: string;
  landedTip?: string;
  landedCommits?: string[];
  subject?: string;
  push?: { remote: string | null; ok: boolean; detail: string };
  ciRuns: CiAttempt[];
  fix?: { agent: string; attempted: boolean; ok: boolean; reason: string; commits: string[]; costUsd?: number; turns?: number; gate?: string };
  revert?: { commit: string | null; reverted: string[]; treeMatchesBase: boolean; pushed: boolean; detail: string };
  requeued?: boolean;
  /** The task-ledger file the landing commit carries with status done (claims stay local), and the commit it names. */
  ledger?: { file: string; commit: string } | null;
  failureEvidence?: string;
  transitions: Array<{ at: string; state: LandState; note?: string }>;
}

export function landingPath(repoId: string, taskId: string): string {
  return path.join(runsDir(), repoId, taskId, 'landing.json');
}

export function readLanding(repoId: string, taskId: string): LandingRecord | null {
  const r = readJsonOr<LandingRecord | null>(landingPath(repoId, taskId), null);
  return r && r.version === 1 ? r : null;
}

export function newRecord(input: Pick<LandingRecord, 'repo' | 'task' | 'branch' | 'mainBranch' | 'ci' | 'squash'>, now = new Date()): LandingRecord {
  return {
    version: 1,
    ...input,
    startedAt: now.toISOString(),
    landed: false,
    post_landing_red: false,
    auto_fixed: false,
    reverted: false,
    revert_correct: null,
    ciRuns: [],
    transitions: [],
  };
}

function short(s: string | undefined | null): string {
  return s ? s.slice(0, 12) : '';
}

/** The recorder used by the state machine: append a transition, log it, persist the record (unless dry-run). */
export class Recorder {
  constructor(
    public rec: LandingRecord,
    public persist: boolean,
  ) {}

  transition(state: LandState, note?: string, extra: { ids?: Record<string, string>; counts?: Record<string, number> } = {}): void {
    this.rec.transitions.push({ at: new Date().toISOString(), state, ...(note ? { note: note.slice(0, 300) } : {}) });
    instrument({
      event: `land.${state}`,
      repo: this.rec.repo,
      task: this.rec.task,
      ids: { ci: this.rec.ci, ...(this.rec.landedTip ? { tip: short(this.rec.landedTip) } : {}), ...(extra.ids ?? {}) },
      counts: extra.counts,
    });
    this.save();
  }

  save(): void {
    if (!this.persist) return;
    try {
      writeJson(landingPath(this.rec.repo, this.rec.task), this.rec);
    } catch {
      /* the record is best effort; the landing itself already happened or not */
    }
  }

  finish(outcome: LandOutcome, reason?: string): LandingRecord {
    this.rec.outcome = outcome;
    if (reason) this.rec.reason = reason.slice(0, 600);
    this.rec.finishedAt = new Date().toISOString();
    instrument({
      event: 'land.outcome',
      repo: this.rec.repo,
      task: this.rec.task,
      ids: { outcome, ci: this.rec.ci },
      counts: {
        landed: this.rec.landed ? 1 : 0,
        post_landing_red: this.rec.post_landing_red ? 1 : 0,
        auto_fixed: this.rec.auto_fixed ? 1 : 0,
        reverted: this.rec.reverted ? 1 : 0,
        revert_correct: this.rec.revert_correct === null ? -1 : this.rec.revert_correct ? 1 : 0,
        ciRuns: this.rec.ciRuns.length,
      },
    });
    this.save();
    return this.rec;
  }
}
