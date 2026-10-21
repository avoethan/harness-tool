/**
 * Build the code-free report (counts only) from the harness state.
 *
 * Redaction by construction: every key the report carries comes from a fixed
 * vocabulary (tiers, families, modes, check types, classes, verdicts,
 * outcomes, assess check ids of the form `R10`); anything else is counted
 * under `other`. Tasks are keyed by the ticket hash, never by title or id.
 * The scrubber (scrub.ts) checks the result again against the workspace.
 *
 * Per task (DESIGN 2.11, EVAL-PLAN 9):
 *   criteria                brief criteria
 *   checksRun               gate steps that ran (not skipped), per repo, over every gate run in the period
 *   checksFailedThenFixed   of those, steps that failed in some run and pass in the latest evidence
 *   gateVerdict             the latest evidence per repo, combined (FAIL > BLOCKED > PASS)
 *   verificationEvidence    E2E artefact files in the task's run folders
 *   standardsFlagged        ledger rule ids the standards step named (block or warn)
 *   clarificationsAsked     questions answered plus questions open in the brief
 *   repeatCorrections       corrections of a class already corrected in the same task
 *   steeringMessages        per session mapped to the task: prompts minus one
 *   reworkRounds, outcome   from the user's work log when it has the ticket; else the outcome is derived
 */
import type {
  CheckMode,
  CheckType,
  Classification,
  InstrumentationEvent,
  Report,
  StandardFamily,
  TaskReportRow,
  Tier,
  Verdict,
} from '../types';
import { sha256 } from '../lib/hash';
import type { HarnessState, RunRecord } from './collect';
import { rowFor } from './worklog';
import type { BriefFile } from '../intake/brief';
import { buildDigest, denialsByRail, ticketRow } from './digest';

export const TIERS: Tier[] = ['declared', 'counted-strong', 'counted-majority', 'review-derived', 'single-source'];
export const FAMILIES: StandardFamily[] = ['lint', 'format', 'types', 'naming', 'layout', 'sql', 'tests', 'errors', 'logging', 'api', 'async', 'imports', 'validation', 'commits', 'ci', 'safety', 'other'];
export const MODES: CheckMode[] = ['block', 'warn', 'judgment'];
export const CHECK_TYPES: CheckType[] = ['config', 'eslint', 'ast-grep', 'semgrep', 'dependency-cruiser', 'knip', 'sql-lint', 'regex', 'commitlint', 'judgment'];
export const CLASSES: Classification[] = ['KEEP', 'CONVERT', 'TRIM', 'FIX', 'SPLIT', 'QUARANTINE'];
export const OUTCOMES = ['merged', 'abandoned', 'reverted', 'gate-pass', 'blocked', 'capped', 'open', 'other'] as const;
export type ReportOutcome = (typeof OUTCOMES)[number];
/**
 * Assess check ids: `R01`..`R31` (an optional letter suffix such as `R30a` is allowed). Only this shape
 * reaches the report as a key; anything else counts as `other`. The shape is kept narrow because the
 * scrubber cannot tell a check id from a workspace name of the same shape (a repository named `qx42`
 * would otherwise reach the report as the key `QX42`; found by the safety suite).
 */
export const CHECK_ID_RE = /^R\d{2}[a-z]?$/;
/** Run folders that are not tasks. */
export function isTaskId(task: string): boolean {
  return task !== 'adhoc' && !task.startsWith('hook-');
}

export interface BuildOptions {
  harnessVersion: string;
  /** ISO date or timestamp: count only what happened on or after it. */
  since?: string;
  now?: Date;
  selfcheck?: Report['selfcheck'];
}

function pick<T extends string>(allowed: readonly T[], k: unknown, other: T): T {
  return typeof k === 'string' && (allowed as readonly string[]).includes(k) ? (k as T) : other;
}

function inc(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

function sortedCounts(m: Record<string, number>, order?: readonly string[]): Record<string, number> {
  const keys = Object.keys(m);
  keys.sort((a, b) => {
    if (order) {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = m[k];
  return out;
}

/** A hex ticket hash; anything else is hashed so no text can pass through. */
export function safeHash(h: unknown, fallbackSeed: string): string {
  if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) return h;
  return sha256(typeof h === 'string' && h ? h : fallbackSeed);
}

export function parseSince(raw: string | undefined): string | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

const RULE_RE = /^(?:warn: )?([a-z][\w.-]*\.[\w.-]+) at /;

function stepKey(repo: string, step: string): string {
  return `${repo}\u0000${step}`;
}

export interface TaskAcc {
  id: string;
  brief?: BriefFile;
  runs: RunRecord[];
  events: InstrumentationEvent[];
  sessions: Set<string>;
}

/** session id -> the task most of its task-bearing events name (ties: the later one). */
export function mapSessionsToTasks(events: InstrumentationEvent[], taskIds: Set<string>): Map<string, string> {
  const byHash = new Map<string, string>();
  for (const id of taskIds) byHash.set(sha256(id), id);
  const votes = new Map<string, Map<string, { n: number; last: string }>>();
  for (const ev of events) {
    if (!ev.sessionId) continue;
    let task: string | undefined;
    if (ev.task && taskIds.has(ev.task)) task = ev.task;
    else if (ev.event === 'correction' && ev.ids?.ticket) task = byHash.get(ev.ids.ticket);
    if (!task) continue;
    const m = votes.get(ev.sessionId) ?? new Map<string, { n: number; last: string }>();
    const v = m.get(task) ?? { n: 0, last: '' };
    v.n++;
    if (ev.ts > v.last) v.last = ev.ts;
    m.set(task, v);
    votes.set(ev.sessionId, m);
  }
  const out = new Map<string, string>();
  for (const [sid, m] of votes) {
    let best: string | undefined;
    let bv = { n: -1, last: '' };
    for (const [task, v] of m) if (v.n > bv.n || (v.n === bv.n && v.last > bv.last)) [best, bv] = [task, v];
    if (best) out.set(sid, best);
  }
  return out;
}

function combineVerdict(runs: RunRecord[]): Verdict | 'none' {
  const vs = runs.map((r) => r.evidence?.verdict).filter((v): v is Verdict => !!v);
  if (!vs.length) return 'none';
  if (vs.includes('FAIL')) return 'FAIL';
  if (vs.includes('BLOCKED')) return 'BLOCKED';
  return vs.every((v) => v === 'PASS') ? 'PASS' : 'FAIL';
}

function deriveOutcome(verdict: Verdict | 'none', capped: boolean): ReportOutcome {
  if (capped) return 'capped';
  if (verdict === 'PASS') return 'gate-pass';
  if (verdict === 'BLOCKED') return 'blocked';
  return 'open';
}

export function taskRow(acc: TaskAcc, st: HarnessState, sessionTask: Map<string, string>, prompts: Map<string, number>, inPeriodEvents: InstrumentationEvent[]): TaskReportRow {
  const ticketHash = safeHash(acc.brief?.ticketHash, acc.id);
  const ran = new Set<string>();
  const failed = new Set<string>();
  const rules = new Set<string>();
  let gateRuns = 0;
  for (const ev of acc.events) {
    const repo = ev.repo ?? '';
    const step = ev.ids?.step;
    if (ev.event === 'gate.step' && step) {
      const status = ev.ids?.status;
      if (status && status !== 'skip') ran.add(stepKey(repo, step));
      if (status === 'fail') failed.add(stepKey(repo, step));
    } else if (ev.event === 'gate.fail' && step) {
      failed.add(stepKey(repo, step));
      ran.add(stepKey(repo, step));
      if (ev.ids?.rules) for (const r of ev.ids.rules.split(',')) if (r.trim()) rules.add(r.trim());
    } else if (ev.event === 'gate.verdict') gateRuns++;
  }
  let fixed = 0;
  const latest = new Map<string, string>();
  for (const run of acc.runs) {
    for (const s of run.evidence?.steps ?? []) {
      latest.set(stepKey(run.repo, s.name), s.status);
      if (s.status !== 'skip') ran.add(stepKey(run.repo, s.name));
      if (s.name === 'standards') for (const r of s.reasons ?? []) {
        const m = RULE_RE.exec(r);
        if (m) rules.add(m[1]);
      }
    }
  }
  for (const k of failed) {
    const now = latest.get(k);
    if (now === 'pass' || now === 'cached') fixed++;
  }
  // Corrections: those the hook tied to this task, plus untied ones from sessions mapped to it.
  const taskHash = sha256(acc.id);
  const byClass: Record<string, number> = {};
  for (const ev of inPeriodEvents) {
    if (ev.event !== 'correction') continue;
    const t = ev.ids?.ticket;
    const mine = t === taskHash || ((!t || t === 'none') && ev.sessionId && sessionTask.get(ev.sessionId) === acc.id);
    if (mine) inc(byClass, ev.class ?? 'other');
  }
  const repeat = Object.values(byClass).reduce((n, c) => n + Math.max(0, c - 1), 0);
  let steering = 0;
  for (const sid of acc.sessions) steering += Math.max(0, (prompts.get(sid) ?? 0) - 1);
  const verdict = combineVerdict(acc.runs);
  const capped = acc.runs.some((r) => r.capFile || r.evidence?.cap_reached === true);
  const log = rowFor(st.worklog, ticketHash);
  const outcome: ReportOutcome = log?.outcome ?? deriveOutcome(verdict, capped);
  const row: TaskReportRow = {
    ticketHash,
    criteria: acc.brief?.criteria?.length ?? 0,
    checksRun: ran.size,
    checksFailedThenFixed: fixed,
    gateVerdict: verdict,
    verificationEvidence: acc.runs.reduce((n, r) => n + r.e2eFiles, 0),
    standardsFlagged: rules.size,
    clarificationsAsked: acc.brief ? (acc.brief.clarifications?.length ?? 0) + (acc.brief.questionDetails?.length ?? 0) : 0,
    repeatCorrections: repeat,
    steeringMessages: steering,
    outcome: pick(OUTCOMES, outcome, 'other'),
    gateRuns,
    capReached: capped,
  };
  if (log?.reworkRounds !== undefined) row.reworkRounds = log.reworkRounds;
  return row;
}

/** Prompts per session: prompt.submit events, or the dispatcher's hook.UserPromptSubmit when the handler logged none. */
export function promptsPerSession(events: InstrumentationEvent[]): Map<string, number> {
  const submit = new Map<string, number>();
  const hook = new Map<string, number>();
  for (const ev of events) {
    if (!ev.sessionId) continue;
    if (ev.event === 'prompt.submit') submit.set(ev.sessionId, (submit.get(ev.sessionId) ?? 0) + 1);
    else if (ev.event === 'hook.UserPromptSubmit') hook.set(ev.sessionId, (hook.get(ev.sessionId) ?? 0) + 1);
  }
  for (const [sid, n] of hook) if (!submit.has(sid)) submit.set(sid, n);
  return submit;
}

/** Stop events that let the agent stop and were followed by a user prompt in the same session. */
export function waitingEpisodes(events: InstrumentationEvent[], sessions: Set<string>): number {
  const bySession = new Map<string, InstrumentationEvent[]>();
  for (const ev of events) {
    if (!ev.sessionId || !sessions.has(ev.sessionId)) continue;
    if (!(ev.event.startsWith('stop.') || ev.event === 'prompt.submit')) continue;
    (bySession.get(ev.sessionId) ?? bySession.set(ev.sessionId, []).get(ev.sessionId)!).push(ev);
  }
  let n = 0;
  for (const list of bySession.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let stopped = false;
    for (const ev of list) {
      if (ev.event.startsWith('stop.')) stopped = ev.event !== 'stop.block' && ev.event !== 'stop.error';
      else if (ev.event === 'prompt.submit' && stopped) {
        n++;
        stopped = false;
      }
    }
  }
  return n;
}

export interface TaskIndex {
  tasks: TaskAcc[];
  sessionTask: Map<string, string>;
  prompts: Map<string, number>;
  events: InstrumentationEvent[];
}

/** Tasks in the period with their briefs, runs, events and sessions. */
export function indexTasks(st: HarnessState, since?: string): TaskIndex {
  const events = since ? st.events.filter((e) => e.ts >= since) : st.events;
  const ids = new Set<string>();
  for (const b of st.briefs) ids.add(b.id);
  for (const r of st.runs) if (isTaskId(r.task)) ids.add(r.task);
  const sessionTask = mapSessionsToTasks(events, ids);
  const prompts = promptsPerSession(events);
  const accs = new Map<string, TaskAcc>();
  const get = (id: string): TaskAcc => {
    let a = accs.get(id);
    if (!a) accs.set(id, (a = { id, runs: [], events: [], sessions: new Set() }));
    return a;
  };
  for (const b of st.briefs) get(b.id).brief = b;
  for (const r of st.runs) if (isTaskId(r.task)) get(r.task).runs.push(r);
  for (const ev of events) if (ev.task && accs.has(ev.task)) get(ev.task).events.push(ev);
  for (const [sid, task] of sessionTask) accs.get(task)?.sessions.add(sid);
  let tasks = [...accs.values()];
  if (since) {
    tasks = tasks.filter((a) => {
      const dates = [a.brief?.updatedAt, a.brief?.createdAt, ...a.runs.map((r) => r.evidence?.finishedAt)].filter((d): d is string => typeof d === 'string');
      return dates.some((d) => d >= since) || a.events.length > 0 || a.sessions.size > 0;
    });
  }
  tasks.sort((x, y) => {
    const dx = x.brief?.createdAt ?? x.runs.map((r) => r.evidence?.startedAt ?? '').sort()[0] ?? '';
    const dy = y.brief?.createdAt ?? y.runs.map((r) => r.evidence?.startedAt ?? '').sort()[0] ?? '';
    return dx < dy ? -1 : dx > dy ? 1 : x.id < y.id ? -1 : 1;
  });
  return { tasks, sessionTask, prompts, events };
}

export function buildReport(st: HarnessState, opts: BuildOptions): Report {
  const now = opts.now ?? new Date();
  const since = opts.since;

  // Standards and checks (snapshots: the current ledger).
  const byTier: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  const byModeRecords: Record<string, number> = {};
  const byTypeRecords: Record<string, number> = {};
  for (const r of st.ledger?.records ?? []) {
    inc(byTier, pick(TIERS, r.tier, 'other' as Tier));
    inc(byFamily, pick(FAMILIES, r.family, 'other'));
    inc(byModeRecords, pick(MODES, r.check?.mode, 'other' as CheckMode));
    inc(byTypeRecords, pick(CHECK_TYPES, r.check?.type, 'other' as CheckType));
  }
  let byMode = byModeRecords;
  let byType = byTypeRecords;
  if (st.checkIndex) {
    byMode = {};
    byType = {};
    for (const c of st.checkIndex) {
      inc(byMode, pick(MODES, c.mode, 'other' as CheckMode));
      inc(byType, pick(CHECK_TYPES, c.type, 'other' as CheckType));
    }
  }
  const generated = st.checkIndex ? st.checkIndex.length : st.checkSpecs;

  // Assessment.
  const findingsByCheck: Record<string, number> = {};
  const classifications: Record<string, number> = {};
  for (const f of st.assess?.findings ?? []) inc(findingsByCheck, typeof f.check === 'string' && CHECK_ID_RE.test(f.check) ? f.check : 'other');
  for (const c of st.assess?.classifications ?? []) inc(classifications, pick(CLASSES, c.cls, 'other' as Classification));

  // Tasks.
  const idx = indexTasks(st, since);
  const tasks = idx.tasks.map((a) => taskRow(a, st, idx.sessionTask, idx.prompts, idx.events));

  // Per-ticket headline numbers (the digest's) and the denials by rail.
  const perTicket = idx.tasks.map((a) => ticketRow(buildDigest(a, idx.events), safeHash(a.brief?.ticketHash, a.id)));
  const rails = denialsByRail(idx.events);

  // Learning loop.
  const lessons = st.lessons.filter((l) => !since || (l.lastSeen ?? l.firstSeen ?? '') >= since);
  const learning = {
    captured: lessons.length,
    proven: lessons.filter((l) => l.status === 'proven' || l.status === 'approved' || !!l.enforcer?.provenOn).length,
    approved: lessons.filter((l) => l.status === 'approved').length,
    expired: lessons.filter((l) => l.status === 'expired').length,
  };

  // Caps.
  const caps = {
    tasksAtGateCap: tasks.filter((t) => t.capReached).length,
    stopReleasesAtCap: idx.events.filter((e) => e.event === 'stop.cap').length,
  };

  // Period: the first and last dated record counted.
  const dates: string[] = [];
  for (const e of idx.events) dates.push(e.ts);
  for (const a of idx.tasks) {
    if (a.brief?.createdAt) dates.push(a.brief.createdAt);
    for (const r of a.runs) if (r.evidence?.finishedAt) dates.push(r.evidence.finishedAt);
  }
  for (const l of lessons) if (l.firstSeen) dates.push(l.firstSeen);
  const valid = dates.filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const period: NonNullable<Report['period']> = {};
  if (since) period.since = since.slice(0, 10);
  if (valid.length) {
    period.from = valid[0].slice(0, 10);
    period.to = valid[valid.length - 1].slice(0, 10);
  }

  const report: Report = {
    version: 1,
    generatedAt: now.toISOString(),
    harnessVersion: /^[0-9A-Za-z.+-]{1,40}$/.test(opts.harnessVersion) ? opts.harnessVersion : 'unknown',
    period,
    standards: { byTier: sortedCounts(byTier, TIERS), byFamily: sortedCounts(byFamily, FAMILIES) },
    checks: { generated, byMode: sortedCounts(byMode, MODES), byType: sortedCounts(byType, CHECK_TYPES) },
    assessment: { findingsByCheck: sortedCounts(findingsByCheck), classifications: sortedCounts(classifications, CLASSES) },
    teamProposals: st.proposals,
    tasks,
    learning,
    caps,
    perTicket,
    rails,
  };
  if (opts.selfcheck && Object.keys(opts.selfcheck).length) report.selfcheck = opts.selfcheck;
  if (st.worklog) report.worklogRows = st.worklog.rows.length;
  return report;
}

/** Sessions mapped to a task (for the work-log row). */
export function sessionsOf(idx: TaskIndex, taskId: string): Set<string> {
  return idx.tasks.find((t) => t.id === taskId)?.sessions ?? new Set();
}

