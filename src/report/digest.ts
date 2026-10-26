/**
 * The per-ticket digest: one page per task from its run folder(s), its brief
 * and the instrumentation log. Names and counts only: the ticket's title is
 * the one piece of ticket text it carries; criteria, descriptions, questions
 * and the agent's reasons are never copied. The rendered page goes through
 * the secret redaction once more before it is printed or saved.
 *
 * Sources, all under HARNESS_HOME:
 *   briefs/<task>.json                      title, criteria kinds, check kinds, prove-red results
 *   runs/<repo>/<task>/evidence.json        gate steps, verdict, BLOCKED reasons, local changes left out (count)
 *   runs/<repo>/<task>/e2e/*.json           live artefacts (fresh when the tree hash matches the latest evidence)
 *   runs/<repo>/<task>/phase.json           tests-phase entries and `expectChanges` (optional field)
 *   runs/<repo>/<task>/run.json             runner state (optional `sessions`, `turns`, `costUsd`)
 *   runs/<repo>/<task>/landing.json, pr.json, ci-*.json
 *   logs/events.jsonl                       gate attempts, guard denials by rail, sessions, wall time
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstrumentationEvent, TicketRow, Verdict } from '../types';
import { readJsonOr } from '../lib/fsx';
import { redactText } from '../lib/redact';
import { runsDir } from '../lib/paths';
import { stripHiddenUnicode } from '../lib/unicode';
import type { RunRecord } from './collect';
import type { TaskAcc } from './build';

/** Guard rails the digest and the report name; anything else counts as `other`. */
export const RAILS = ['db', 'git-history', 'git-hooks-bypass', 'mcp', 'outbound', 'team-push', 'team-remote', 'team-gh', 'team-shaped', 'protect', 'secrets', 'staging', 'opaque', 'nested-agent', 'phase-tests', 'internal', 'admin'] as const;
export const LANDING_WORDS = ['landed', 'deflaked', 'auto_fixed', 'reverted', 'refused', 'failed', 'dry-run', 'unfinished', 'none'] as const;

export interface DigestRepo {
  repo: string;
  verdict: Verdict | 'none';
  attempt: number;
  /** `preExisting`: steps failing the same way at the base commit (present only when there are any). */
  steps: { pass: number; fail: number; skip: number; cached: number; preExisting?: number };
  failedSteps: string[];
  blockedReasons: string[];
  capReached: boolean;
  writeup: boolean;
  /** Live artefacts of this run folder: matching the latest evidence tree, not matching it, or recording a failure. */
  artefacts: { fresh: number; stale: number; failed: number; byKind: Record<string, number> };
  /** Local changes present when the ticket started that the latest gate run left out, and recorded ones changed during the ticket (counts; evidence.json). */
  localChanges?: { leftOut: number; changedSince: number };
}

export interface Digest {
  version: 1;
  task: string;
  ticket: string;
  title: string;
  criteria: { total: number; byKind: Record<string, number>; checksByKind: Record<string, number>; redFirst: number; greenAtBase: number };
  proveRed: { red: number; green: number; missing: number; error: number; notRun: number };
  gate: { runs: number; partialRuns: number; attempts: number; verdicts: string[]; final: Verdict | 'none'; blocked: boolean };
  repos: DigestRepo[];
  interventions: { denials: number; byRail: Record<string, number> };
  tests: { phase: string; entries: number; expectChanges: Array<{ file: string; at: string }>; expectChangesTotal: number };
  runner: { present: boolean; agent?: string; status?: string; reason?: string; sessions: number; turns: number | null; costUsd: number | null };
  hookSessions: number;
  landing: { present: boolean; outcome: string; landed: boolean; postLandingRed: boolean; autoFixed: boolean; reverted: boolean; revertCorrect: boolean | null; transitions: number; ciRuns: number };
  pr: { present: boolean; number?: number; url?: string; head?: string; base?: string; at?: string; existing?: boolean };
  wall: { first: string | null; last: string | null; minutes: number | null; events: number };
  writeup: boolean;
}

const MAX_LIST = 20;

function oneLine(s: unknown, max = 160): string {
  return redactText(stripHiddenUnicode(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function inc(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

function sorted(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function railOf(raw: unknown): string {
  return typeof raw === 'string' && (RAILS as readonly string[]).includes(raw) ? raw : 'other';
}

/** guard.deny events by rail. */
export function denialsByRail(events: InstrumentationEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of events) if (ev.event === 'guard.deny') inc(out, railOf(ev.ids?.rail));
  return sorted(out);
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function artefactKind(file: string): string {
  const m = /-(http|db|browser)\.json$/.exec(file);
  return m ? m[1] : 'other';
}

function repoDigest(run: RunRecord, dir: string): DigestRepo {
  const ev = run.evidence;
  const steps: DigestRepo['steps'] = { pass: 0, fail: 0, skip: 0, cached: 0 };
  const failedSteps: string[] = [];
  for (const s of ev?.steps ?? []) {
    if (s.status === 'pre-existing') steps.preExisting = (steps.preExisting ?? 0) + 1;
    else if (s.status in steps) steps[s.status]++;
    if (s.status === 'fail' && failedSteps.length < MAX_LIST) failedSteps.push(oneLine(s.name, 60));
  }
  const blockedReasons: string[] = [];
  if (ev?.verdict === 'BLOCKED') for (const r of (ev.reasons ?? []).slice(0, 3)) blockedReasons.push(oneLine(r));
  const art = { fresh: 0, stale: 0, failed: 0, byKind: {} as Record<string, number> };
  for (const f of listDir(path.join(dir, 'e2e'))) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const rec = readJsonOr<{ treeHash?: string; pass?: boolean } | null>(path.join(dir, 'e2e', f.name), null);
    inc(art.byKind, artefactKind(f.name));
    if (rec?.pass === false) art.failed++;
    else if (ev && rec?.treeHash && rec.treeHash === ev.treeHash) art.fresh++;
    else art.stale++;
  }
  art.byKind = sorted(art.byKind);
  return {
    repo: oneLine(run.repo, 80),
    verdict: ev?.verdict ?? 'none',
    attempt: ev?.attempt ?? 0,
    steps,
    failedSteps,
    blockedReasons,
    capReached: !!run.capFile || ev?.cap_reached === true,
    writeup: run.writeup,
    artefacts: art,
    ...(ev?.localChanges ? { localChanges: { leftOut: Number(ev.localChanges.leftOut) || 0, changedSince: Number(ev.localChanges.changedSince) || 0 } } : {}),
  };
}

function combine(repos: DigestRepo[]): Verdict | 'none' {
  const vs = repos.map((r) => r.verdict).filter((v): v is Verdict => v !== 'none');
  if (!vs.length) return 'none';
  if (vs.includes('FAIL')) return 'FAIL';
  if (vs.includes('BLOCKED')) return 'BLOCKED';
  return 'PASS';
}

/** Events that belong to a task: those naming it, and every event of a session tied to it. */
export function eventsOfTask(acc: TaskAcc, all: InstrumentationEvent[]): InstrumentationEvent[] {
  return all.filter((e) => e.task === acc.id || (!!e.sessionId && acc.sessions.has(e.sessionId)));
}

export function buildDigest(acc: TaskAcc, allEvents: InstrumentationEvent[]): Digest {
  const brief = acc.brief;
  const events = eventsOfTask(acc, allEvents);
  const byKind: Record<string, number> = {};
  const checksByKind: Record<string, number> = {};
  const proveRed = { red: 0, green: 0, missing: 0, error: 0, notRun: 0 };
  let redFirst = 0;
  let greenAtBase = 0;
  for (const c of brief?.criteria ?? []) {
    inc(byKind, String(c.kind ?? 'other'));
    if (c.check) {
      inc(checksByKind, c.check.kind);
      if (c.check.redFirst) redFirst++;
      if (c.check.greenAtBase) greenAtBase++;
      if (c.check.kind === 'unit' || c.check.kind === 'e2e-http' || c.check.kind === 'e2e-db') {
        const r = c.check.redProof?.result;
        if (r === 'red' || r === 'green' || r === 'missing' || r === 'error') proveRed[r]++;
        else if (c.check.redFirst || c.check.greenAtBase) proveRed.notRun++;
      }
    }
  }

  const repos: DigestRepo[] = [];
  let runJson: Record<string, unknown> | null = null;
  let landingJson: Record<string, unknown> | null = null;
  let prJson: Record<string, unknown> | null = null;
  let ciRuns = 0;
  let expectTotal = 0;
  const expect: Array<{ file: string; at: string }> = [];
  let testsEntries = 0;
  let phase = 'implement';
  for (const run of [...acc.runs].sort((a, b) => (a.repo < b.repo ? -1 : 1))) {
    const dir = path.join(runsDir(), run.repo, run.task);
    repos.push(repoDigest(run, dir));
    const phaseRec = readJsonOr<{ phase?: string; testsEntries?: number; expectChanges?: unknown } | null>(path.join(dir, 'phase.json'), null);
    if (phaseRec) {
      testsEntries += num(phaseRec.testsEntries) ?? 0;
      if (phaseRec.phase === 'tests') phase = 'tests';
      if (Array.isArray(phaseRec.expectChanges)) {
        for (const x of phaseRec.expectChanges as Array<{ file?: unknown; at?: unknown }>) {
          expectTotal++;
          if (expect.length < MAX_LIST) expect.push({ file: oneLine(x?.file, 120), at: typeof x?.at === 'string' ? x.at.slice(0, 19) : '' });
        }
      }
    }
    runJson = runJson ?? readJsonOr<Record<string, unknown> | null>(path.join(dir, 'run.json'), null);
    landingJson = landingJson ?? readJsonOr<Record<string, unknown> | null>(path.join(dir, 'landing.json'), null);
    prJson = prJson ?? readJsonOr<Record<string, unknown> | null>(path.join(dir, 'pr.json'), null);
    ciRuns += listDir(dir).filter((f) => f.isFile() && /^ci-\d+-.*\.json$/.test(f.name)).length;
  }

  // Gate attempts from the log; the evidence's own attempt counter when the log is empty.
  const verdicts: string[] = [];
  let gateRuns = 0;
  let partial = 0;
  for (const e of events) {
    if (e.event === 'gate.verdict') {
      gateRuns++;
      const v = e.ids?.verdict;
      if (verdicts.length < MAX_LIST) verdicts.push(v === 'PASS' || v === 'FAIL' || v === 'BLOCKED' ? v : 'other');
    } else if (e.event === 'gate.partial') partial++;
  }
  const attempts = Math.max(gateRuns, ...repos.map((r) => r.attempt), 0);
  const final = combine(repos);

  const byRail = denialsByRail(events);
  const denials = Object.values(byRail).reduce((n, c) => n + c, 0);

  // Runner: run.json (optional sessions, turns, costUsd) and the runner's own events.
  const runSessions = events.filter((e) => e.event === 'run.session');
  let turns: number | null = null;
  for (const e of runSessions) {
    const t = e.counts?.turns;
    if (typeof t === 'number' && t >= 0) turns = (turns ?? 0) + t;
  }
  const jsonTurns = num(runJson?.turns);
  if (jsonTurns !== undefined) turns = jsonTurns;
  let cost: number | null = num(runJson?.costUsd) ?? null;
  if (cost === null) {
    const milli = events.filter((e) => e.event === 'run.task' && typeof e.counts?.costMilliUsd === 'number').reduce((n, e) => n + (e.counts!.costMilliUsd as number), 0);
    if (milli > 0) cost = milli / 1000;
  }
  const sessions = Math.max(num(runJson?.sessions) ?? 0, runSessions.length);
  const status = typeof runJson?.status === 'string' ? runJson.status : undefined;

  const lj = landingJson as Record<string, any> | null;
  const landing = lj
    ? {
        present: true,
        outcome: typeof lj.outcome === 'string' && (LANDING_WORDS as readonly string[]).includes(lj.outcome) ? lj.outcome : lj.finishedAt ? 'failed' : 'unfinished',
        landed: lj.landed === true,
        postLandingRed: lj.post_landing_red === true,
        autoFixed: lj.auto_fixed === true,
        reverted: lj.reverted === true,
        revertCorrect: typeof lj.revert_correct === 'boolean' ? lj.revert_correct : null,
        transitions: Array.isArray(lj.transitions) ? lj.transitions.length : 0,
        ciRuns,
      }
    : { present: false, outcome: 'none', landed: false, postLandingRed: false, autoFixed: false, reverted: false, revertCorrect: null as boolean | null, transitions: 0, ciRuns };

  const pj = prJson as Record<string, any> | null;
  const pr: Digest['pr'] = pj
    ? {
        present: true,
        ...(num(pj.number) !== undefined ? { number: num(pj.number) } : {}),
        ...(typeof pj.url === 'string' ? { url: oneLine(pj.url, 200) } : {}),
        ...(typeof pj.head === 'string' ? { head: oneLine(pj.head, 100) } : {}),
        ...(typeof pj.base === 'string' ? { base: oneLine(pj.base, 100) } : {}),
        ...(typeof pj.at === 'string' ? { at: pj.at.slice(0, 19) } : {}),
        ...(pj.existing === true ? { existing: true } : {}),
      }
    : { present: false };

  const stamps = events.map((e) => e.ts).filter((t) => Number.isFinite(Date.parse(t))).sort();
  const first = stamps[0] ?? null;
  const last = stamps[stamps.length - 1] ?? null;
  const minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : null;

  return {
    version: 1,
    task: oneLine(acc.id, 80),
    ticket: (brief?.ticketHash ?? '').slice(0, 12),
    title: oneLine(brief?.title ?? '', 160),
    criteria: { total: brief?.criteria?.length ?? 0, byKind: sorted(byKind), checksByKind: sorted(checksByKind), redFirst, greenAtBase },
    proveRed,
    gate: { runs: gateRuns, partialRuns: partial, attempts, verdicts, final, blocked: final === 'BLOCKED' },
    repos,
    interventions: { denials, byRail },
    tests: { phase, entries: testsEntries, expectChanges: expect, expectChangesTotal: expectTotal },
    runner: {
      present: !!runJson,
      ...(typeof runJson?.agent === 'string' ? { agent: oneLine(runJson.agent, 20) } : {}),
      ...(status ? { status: oneLine(status, 20) } : {}),
      ...(typeof runJson?.reason === 'string' ? { reason: oneLine(runJson.reason, 120) } : {}),
      sessions,
      turns,
      costUsd: cost === null ? null : Number(cost.toFixed(4)),
    },
    hookSessions: acc.sessions.size,
    landing,
    pr,
    wall: { first, last, minutes, events: events.length },
    writeup: acc.runs.some((r) => r.writeup),
  };
}

/** The headline numbers of a digest. */
export function ticketRow(d: Digest, ticketHash: string): TicketRow {
  const row: TicketRow = {
    ticketHash,
    criteria: d.criteria.total,
    gateAttempts: d.gate.attempts,
    gateVerdict: d.gate.final,
    denials: d.interventions.denials,
    testsEntries: d.tests.entries,
    expectChanges: d.tests.expectChangesTotal,
    sessions: Math.max(d.runner.sessions, d.hookSessions),
    landing: d.landing.outcome,
    pullRequest: d.pr.present,
  };
  if (d.runner.costUsd !== null) row.costUsd = d.runner.costUsd;
  if (d.wall.minutes !== null) row.minutes = d.wall.minutes;
  return row;
}

function table(head: string[], rows: Array<Array<string | number>>): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map((_, i) => (i === 0 ? ' --- ' : ' ---: ')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

function counts(m: Record<string, number>): string {
  const e = Object.entries(m);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
}

function duration(min: number | null): string {
  if (min === null) return 'not known';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export const DIGEST_SECTIONS = ['Criteria and checks', 'Prove-red', 'Gate', 'Interventions', 'Tests phase', 'Live artefacts', 'Sessions and cost', 'Landing and pull request', 'Time'] as const;

/** The digest as Markdown, with secrets redacted over the whole text. */
export function renderDigest(d: Digest): string {
  const L: string[] = [];
  L.push(`# Ticket digest${d.title ? `: ${d.title}` : ''}`, '');
  L.push(`Task ${d.task}${d.ticket ? `, ticket ${d.ticket}` : ''}. Names and counts only: no ticket text beyond the title.`, '');

  L.push('## Criteria and checks', '');
  L.push(`${d.criteria.total} criteria. By kind: ${counts(d.criteria.byKind)}.`);
  L.push(`Checks by kind: ${counts(d.criteria.checksByKind)}. Red-first: ${d.criteria.redFirst}. Green at base: ${d.criteria.greenAtBase}.`, '');

  L.push('## Prove-red', '');
  const p = d.proveRed;
  L.push(`Red ${p.red}, green ${p.green}, no test found ${p.missing}, could not run ${p.error}, not run yet ${p.notRun}.`, '');

  L.push('## Gate', '');
  L.push(`${d.gate.runs} full gate run(s), ${d.gate.partialRuns} partial; highest attempt ${d.gate.attempts}. Verdicts in order: ${d.gate.verdicts.join(', ') || 'none'}. Final verdict: ${d.gate.final === 'none' ? 'no run' : d.gate.final}.`);
  if (!d.repos.length) L.push('', 'No run folder yet.');
  for (const r of d.repos) {
    L.push('', `Repository ${r.repo}: ${r.verdict === 'none' ? 'no evidence' : r.verdict} at attempt ${r.attempt}. Steps: ${r.steps.pass} pass, ${r.steps.fail} fail, ${r.steps.skip} skipped, ${r.steps.cached} cached${r.steps.preExisting ? `, ${r.steps.preExisting} already failing at the base commit (pre-existing)` : ''}.${r.capReached ? ' The attempt cap was reached.' : ''}`);
    if (r.failedSteps.length) L.push(`Failing steps: ${r.failedSteps.join(', ')}.`);
    if (r.localChanges?.leftOut || r.localChanges?.changedSince) L.push(`Local changes present when the ticket started: ${r.localChanges.leftOut} left out of the gate${r.localChanges.changedSince ? `, ${r.localChanges.changedSince} changed during the ticket and checked` : ''}.`);
    if (r.blockedReasons.length) {
      L.push('BLOCKED reason:');
      for (const x of r.blockedReasons) L.push(`- ${x}`);
    }
  }
  L.push('');

  L.push('## Interventions', '');
  const rails = Object.entries(d.interventions.byRail);
  if (!rails.length) L.push('The hooks denied nothing.');
  else L.push(`The hooks denied ${d.interventions.denials} tool call(s).`, '', ...table(['Rail', 'Denials'], rails.map(([k, v]) => [k, v])));
  L.push('');

  L.push('## Tests phase', '');
  L.push(`Phase now: ${d.tests.phase}. Entered the tests phase ${d.tests.entries} time(s). Declared expectation changes: ${d.tests.expectChangesTotal}.`);
  for (const x of d.tests.expectChanges) L.push(`- ${x.file}${x.at ? ` (${x.at})` : ''}`);
  if (d.tests.expectChangesTotal > d.tests.expectChanges.length) L.push(`- and ${d.tests.expectChangesTotal - d.tests.expectChanges.length} more`);
  L.push('');

  L.push('## Live artefacts', '');
  if (!d.repos.length) L.push('None.');
  for (const r of d.repos) L.push(`${r.repo}: ${r.artefacts.fresh} fresh, ${r.artefacts.stale} stale, ${r.artefacts.failed} recording a failure (${counts(r.artefacts.byKind)}).`);
  L.push('');

  L.push('## Sessions and cost', '');
  const rn = d.runner;
  L.push(`Sessions seen by the hooks: ${d.hookSessions}.`);
  if (rn.present || rn.sessions) L.push(`Runner${rn.agent ? ` (${rn.agent})` : ''}${rn.status ? `, status ${rn.status}` : ''}${rn.reason ? `, reason ${rn.reason}` : ''}: ${rn.sessions} session(s), ${rn.turns === null ? 'turns not recorded' : `${rn.turns} turn(s)`}.`);
  else L.push('No runner record: the task was not driven by `harness run`.');
  L.push(rn.costUsd === null ? 'Cost: not recorded.' : `Cost as reported by the agent: ${rn.costUsd} USD.`, '');

  L.push('## Landing and pull request', '');
  const ld = d.landing;
  if (!ld.present) L.push('No landing record.');
  else
    L.push(
      `Landing: ${ld.outcome}. Landed ${ld.landed ? 'yes' : 'no'}, red after landing ${ld.postLandingRed ? 'yes' : 'no'}, auto-fixed ${ld.autoFixed ? 'yes' : 'no'}, reverted ${ld.reverted ? 'yes' : 'no'}${ld.revertCorrect === null ? '' : ` (revert ${ld.revertCorrect ? 'correct' : 'not exact'})`}; ${ld.transitions} transition(s), ${ld.ciRuns} CI run(s) recorded.`,
    );
  if (!d.pr.present) L.push('No pull request record.');
  else L.push(`Pull request${d.pr.number !== undefined ? ` #${d.pr.number}` : ''}${d.pr.existing ? ' (already open)' : ''}${d.pr.head ? `, ${d.pr.head} into ${d.pr.base ?? '?'}` : ''}${d.pr.at ? `, ${d.pr.at}` : ''}${d.pr.url ? `: ${d.pr.url}` : ''}.`);
  L.push(`Write-up: ${d.writeup ? 'saved' : 'not written yet'}.`, '');

  L.push('## Time', '');
  L.push(d.wall.first && d.wall.last ? `First event ${d.wall.first.slice(0, 19)}, last ${d.wall.last.slice(0, 19)}: ${duration(d.wall.minutes)} across ${d.wall.events} event(s).` : 'No instrumentation events for this task.');
  L.push('');
  return redactText(L.join('\n'));
}
