/**
 * The learning loop (DESIGN 2.9): scan -> propose -> (judgment) -> prove ->
 * approve by tier -> stats and gc. The command (`src/commands/learn.ts`)
 * is a thin layer over these functions.
 *
 *   scan()          events.jsonl -> classes -> lesson records (captured -> proposed),
 *                   enforcer by the ladder, a judgment bundle for what needs one
 *   proveAndRecord  run the proof; a proven tier-0 lesson is approved at once
 *                   (its learned check written into the private ledger)
 *   decide()        the user's review decisions: approve (tier 1 -> a plan through
 *                   propose), reject, expire, renew; tier 2 never automatic;
 *                   team-repository changes refused
 */
import type { AgentId, Ledger, Setting } from '../types';
import { readJsonOr } from '../lib/fsx';
import { ledgerPath } from '../lib/paths';
import { instrument } from '../lib/log';
import { checksDir as discoverChecksDir } from '../discover/checks';
import { loadProbeLibrary } from '../discover/probes';
import { findAstGrep, type AstGrepBinary } from '../discover/astgrep';
import type { ProbeTestCase } from '../discover/model';
import { captureOccurrences, eventsPath, groupByClass, isActive, readEvents, type Captured, type ClassGroup } from './capture';
import { describeKey, lessonIdFor, parseKey } from './classes';
import { chooseEnforcer } from './ladder';
import { writeJudgmentBundle } from './judgment';
import { proveLesson, type ProveOptions } from './prove';
import { installLearnedCheck, uninstallLearnedCheck } from './install';
import { isPending, isProse, listLessons, loadLesson, saveLesson, setStatus, type LessonRecord, type ProofRecord } from './store';
import { checkLineBudget, reviewByFor, tierFor, type BudgetCheck } from './tiers';

export function loadDiscoveredLedger(): Ledger | null {
  const l = readJsonOr<Ledger | null>(ledgerPath(), null);
  return l && l.version === 1 && Array.isArray(l.records) ? l : null;
}

/** Map of alias class keys (a learned rule id firing at the gate) to the lesson key they count for. */
export function aliasMap(lessons: LessonRecord[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lessons) for (const a of l.aliases ?? []) if (a !== l.key) m.set(a, l.key);
  return m;
}

/** Read and group the log, with the lessons' aliases applied. */
export function captureAll(opts: { since?: Date; eventsFile?: string; lessons?: LessonRecord[] } = {}): Captured {
  const lessons = opts.lessons ?? listLessons();
  const { events, malformed } = readEvents(opts.eventsFile ?? eventsPath(), { since: opts.since });
  const c = captureOccurrences(events, { aliases: aliasMap(lessons) });
  return { ...c, malformed };
}

function probeTests(): Map<string, ProbeTestCase> | undefined {
  try {
    return loadProbeLibrary().tests;
  } catch {
    return undefined;
  }
}

export interface ScanOptions {
  since?: Date;
  tokenCap?: number;
  now?: Date;
  setting?: Setting;
  eventsFile?: string;
  ledger?: Ledger | null;
  checksDir?: string;
  probeTests?: Map<string, ProbeTestCase>;
}

export interface ScanResult {
  events: number;
  malformed: number;
  occurrences: number;
  classes: number;
  active: number;
  created: string[];
  updated: string[];
  lessons: LessonRecord[];
  bundle?: { id: string; dir: string; items: number };
}

function newLesson(g: ClassGroup, at: string): LessonRecord {
  const { kind } = parseKey(g.key);
  return {
    version: 1,
    id: lessonIdFor(g.key),
    key: g.key,
    class: g.key,
    kind,
    description: describeKey(g.key),
    occurrences: 0,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    sources: [],
    status: 'captured',
    tier: 1,
    touchedRail: false,
    repos: [],
    counts: {},
    followUps: 0,
    capturedAt: at,
    updatedAt: at,
    history: [],
  };
}

/** Merge a class group into a lesson record: add new source ids and counts, never drop old ones. */
function mergeGroup(l: LessonRecord, g: ClassGroup): boolean {
  const known = new Set(l.sources);
  let changed = false;
  for (const o of g.occurrences) {
    if (known.has(o.eventId)) continue;
    known.add(o.eventId);
    l.sources.push(o.eventId);
    l.counts[o.event] = (l.counts[o.event] ?? 0) + 1;
    changed = true;
  }
  l.occurrences = l.sources.length;
  if (g.firstSeen < l.firstSeen) l.firstSeen = g.firstSeen;
  if (g.lastSeen > l.lastSeen) l.lastSeen = g.lastSeen;
  for (const r of g.repos) if (!l.repos.includes(r)) l.repos.push(r);
  if (g.followUps > l.followUps) l.followUps = g.followUps;
  if (g.rail && !l.touchedRail) {
    l.touchedRail = true;
    changed = true;
  }
  return changed;
}

/** `harness learn --scan`. */
export function scan(opts: ScanOptions = {}): ScanResult {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const setting: Setting = opts.setting ?? 'team';
  const existing = listLessons();
  const byId = new Map(existing.map((l) => [l.id, l]));
  const captured = captureAll({ since: opts.since, eventsFile: opts.eventsFile, lessons: existing });
  const groups = groupByClass(captured);
  const ledger = opts.ledger !== undefined ? opts.ledger : loadDiscoveredLedger();
  const ladderCtx = { ledger, checksDir: opts.checksDir ?? discoverChecksDir(), probeTests: opts.probeTests ?? probeTests() };
  const created: string[] = [];
  const updated: string[] = [];
  const touched = new Map<string, LessonRecord>();
  for (const g of groups) {
    const id = lessonIdFor(g.key);
    let l = byId.get(id);
    if (!l) {
      if (!isActive(g)) continue;
      l = newLesson(g, at);
      mergeGroup(l, g);
      setStatus(l, 'captured', `${g.occurrences.length} occurrence(s)${g.rail ? ', touched a safety rail' : ''}`, at);
      created.push(id);
      touched.set(id, l);
    } else if (mergeGroup(l, g)) {
      l.updatedAt = at;
      updated.push(id);
      touched.set(id, l);
    }
  }
  // Propose (or re-propose) for every lesson not decided yet; a judgment's proposal stays until a decision.
  for (const l of [...existing, ...created.map((id) => touched.get(id)!)]) {
    const rec = touched.get(l.id) ?? l;
    const undecided = rec.status === 'captured' || rec.status === 'proposed' || rec.status === 'proven';
    const promoting = rec.status === 'approved' && !!rec.promote;
    if (!undecided && !promoting) continue;
    if (!promoting && rec.proposal?.source === 'judgment') continue;
    if (!promoting && rec.status === 'proven') continue;
    const d = chooseEnforcer({ key: rec.key, touchedRail: rec.touchedRail, gateFails: rec.counts['gate.fail'] ?? 0, promote: promoting, lessonId: rec.id }, ladderCtx);
    const before = JSON.stringify([rec.proposal, rec.needsJudgment?.reason, rec.tier]);
    if (d.proposal) {
      const t = tierFor(d.proposal, { setting });
      rec.proposal = d.proposal;
      rec.enforcer = { rung: d.proposal.rung, ref: d.proposal.ref, fires: rec.enforcer?.fires ?? 0, ...(rec.enforcer?.provenOn ? { provenOn: rec.enforcer.provenOn } : {}) };
      rec.tier = t.tier;
      rec.tierReason = t.refused ?? t.reason;
      rec.needsJudgment = undefined;
      if (t.refused) rec.reason = t.refused;
    } else if (d.needsJudgment) {
      const keepBundle = rec.needsJudgment?.reason === d.needsJudgment.reason ? rec.needsJudgment.bundle : undefined;
      if (!promoting) {
        rec.proposal = undefined;
        rec.enforcer = undefined;
        rec.tier = 1;
        rec.tierReason = 'decided once the judgment pass names the enforcer';
      }
      rec.needsJudgment = { reason: d.needsJudgment.reason, rungs: d.needsJudgment.rungs, suggested: d.needsJudgment.suggested, ...(keepBundle ? { bundle: keepBundle, at: rec.needsJudgment?.at } : {}) };
    }
    const changed = before !== JSON.stringify([rec.proposal, rec.needsJudgment?.reason, rec.tier]);
    if (rec.status === 'captured') {
      setStatus(rec, 'proposed', rec.proposal ? `${rec.proposal.rung} enforcer proposed (tier ${rec.tier})` : 'needs the judgment pass', at);
    } else if (changed) {
      rec.updatedAt = at;
      rec.history.push({ at, status: rec.status, note: rec.proposal ? `proposal now ${rec.proposal.rung} (${rec.proposal.ref})` : 'proposal needs the judgment pass' });
    }
    if (changed || rec.status === 'proposed') touched.set(rec.id, rec);
    if (changed && !created.includes(rec.id) && !updated.includes(rec.id)) updated.push(rec.id);
  }
  // Fires since landing for approved lessons (gate failures of the class).
  for (const l of existing) {
    if (l.status !== 'approved' || !l.enforcer || !l.landedAt) continue;
    const land = Date.parse(l.landedAt);
    const fires = captured.occurrences.filter((o) => o.key === l.key && o.event === 'gate.fail' && o.t >= land).length;
    if (fires !== l.enforcer.fires) {
      const rec = touched.get(l.id) ?? l;
      rec.enforcer = { ...rec.enforcer!, fires };
      touched.set(l.id, rec);
    }
  }
  // Judgment bundle for the lessons that need one and have none pending.
  const needing = [...touched.values(), ...existing.filter((l) => !touched.has(l.id))].filter((l) => l.needsJudgment && !l.needsJudgment.bundle && l.status !== 'rejected' && l.status !== 'expired');
  let bundle: ScanResult['bundle'];
  if (needing.length) {
    const b = writeJudgmentBundle(
      needing.map((l) => ({ lesson: l, occurrences: captured.occurrences.filter((o) => o.key === l.key), ledger })),
      { tokenCap: opts.tokenCap, now },
    );
    if (b) {
      bundle = b;
      for (const l of needing.slice(0, b.items)) {
        l.needsJudgment = { ...l.needsJudgment!, bundle: b.id, at };
        touched.set(l.id, l);
      }
    }
  }
  for (const l of touched.values()) saveLesson(l);
  const lessons = listLessons();
  const active = groups.filter(isActive).length;
  instrument({ event: 'learn.scan', ids: { ...(bundle ? { bundle: bundle.id } : {}) }, counts: { events: captured.events, occurrences: captured.occurrences.length, classes: groups.length, active, created: created.length, updated: updated.length, lessons: lessons.length, judgment: bundle?.items ?? 0 } });
  return { events: captured.events, malformed: captured.malformed, occurrences: captured.occurrences.length, classes: groups.length, active, created, updated, lessons, bundle };
}

export interface ProveOutcome {
  lesson: LessonRecord;
  proof: ProofRecord;
  approved: boolean;
  installed: string[];
}

/** `harness learn prove <id>`: run the proof, record it; a proven tier-0 lesson is approved at once. */
export function proveAndRecord(id: string, opts: Omit<ProveOptions, 'occurrences' | 'ledger' | 'checksDir'> & { now?: Date } = {}): ProveOutcome | { error: string } {
  const lesson = loadLesson(id);
  if (!lesson) return { error: `no lesson ${id} (list them with \`harness learn list\`)` };
  if (lesson.status === 'rejected' || lesson.status === 'expired') return { error: `lesson ${id} is ${lesson.status}` };
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const captured = captureAll();
  const ledger = loadDiscoveredLedger();
  const proof = proveLesson(lesson, { ...opts, occurrences: captured.occurrences.filter((o) => o.key === lesson.key), ledger, checksDir: discoverChecksDir(), now });
  lesson.proof = proof;
  lesson.updatedAt = at;
  let approved = false;
  let installed: string[] = [];
  if (proof.result === 'proven') {
    lesson.enforcer = { ...(lesson.enforcer ?? { rung: lesson.proposal!.rung, ref: lesson.proposal!.ref, fires: 0 }), provenOn: at };
    lesson.reason = undefined;
    if (lesson.status !== 'approved') setStatus(lesson, 'proven', `${proof.method}: ${proof.detail}`, at);
    else lesson.history.push({ at, status: lesson.status, note: `re-proven: ${proof.method}` });
    if (lesson.status === 'proven' && lesson.tier === 0) {
      if (lesson.proposal?.check) installed = installLearnedCheck(lesson, lesson.proposal.check, ledger, at);
      lesson.landedAt = at;
      lesson.decided = { at, by: 'auto', decision: 'approve' };
      setStatus(lesson, 'approved', lesson.proposal?.check ? `tier 0: learned check ${lesson.proposal.check.id} written to the private ledger` : 'tier 0: the enforcer already exists; recorded', at);
      approved = true;
      instrument({ event: 'learn.approve', ids: { lesson: lesson.id, tier: '0', by: 'auto' }, counts: { files: installed.length } });
    }
  } else {
    lesson.reason = proof.result === 'unprovable' ? `not provable by the harness: ${proof.detail}` : `not proven: ${proof.detail}`;
    lesson.history.push({ at, status: lesson.status, note: `proof ${proof.result} (${proof.method})` });
  }
  saveLesson(lesson);
  instrument({ event: 'learn.prove', ids: { lesson: lesson.id, result: proof.result, method: proof.method } });
  return { lesson, proof, approved, installed };
}

// ---------------------------------------------------------------------------
// Review decisions (the user's; the guard blocks `learn review` from agents)
// ---------------------------------------------------------------------------

export interface ReviewContext {
  setting: Setting;
  agents: AgentId[];
  workspaceRoot: string;
  now?: Date;
  /** Measures the always-on blocks with these instruction lessons (tests inject it). */
  measure?: (lessons: LessonRecord[]) => number[];
  /** Builds a plan for the approved prose (tests inject it). Returns the plan id. */
  plan?: () => { id: string; targets: number } | { error: string };
}

export interface Decision {
  lesson: string;
  action: 'approve' | 'reject' | 'expire' | 'renew';
  ok: boolean;
  message: string;
  /** Exit code contribution: 4 for a rail refusal, 1 for other refusals. */
  code?: 0 | 1 | 4;
  budget?: BudgetCheck;
}

export interface ReviewResult {
  decisions: Decision[];
  plan?: { id: string; targets: number } | { error: string };
}

function approvedInstruction(except?: string): LessonRecord[] {
  return listLessons().filter((l) => l.id !== except && l.status === 'approved' && l.proposal?.rung === 'instruction');
}

export function decide(requests: Array<{ action: Decision['action']; id: string }>, ctx: ReviewContext): ReviewResult {
  const now = ctx.now ?? new Date();
  const at = now.toISOString();
  const decisions: Decision[] = [];
  let needPlan = false;
  for (const r of requests) {
    const l = loadLesson(r.id);
    const d = (ok: boolean, message: string, code: Decision['code'] = ok ? 0 : 1, extra: Partial<Decision> = {}) => decisions.push({ lesson: r.id, action: r.action, ok, message, code, ...extra });
    if (!l) {
      d(false, 'no such lesson');
      continue;
    }
    if (r.action === 'approve') {
      if (!isPending(l)) {
        d(false, `it is ${l.status}, not pending`);
        continue;
      }
      if (!l.proposal) {
        d(false, `no enforcer yet: ${l.needsJudgment?.reason ?? 'run harness learn --scan'}`);
        continue;
      }
      const t = tierFor(l.proposal, { setting: ctx.setting });
      if (t.refused) {
        l.reason = t.refused;
        l.history.push({ at, status: l.status, note: 'approval refused: team repository' });
        saveLesson(l);
        d(false, `refused: ${t.refused}`, 4);
        continue;
      }
      if (t.tier === 0) {
        d(false, l.status === 'proven' ? 'tier 0 lessons are approved by `harness learn prove`' : `prove it first: harness learn prove ${l.id}${l.reason ? ` (${l.reason})` : ''}`);
        continue;
      }
      if (t.tier === 2) {
        l.decided = { at, by: 'user', decision: 'approve' };
        setStatus(l, 'approved', `tier 2 approved by the user (${t.reason}); the harness writes nothing for it: make the change by hand`, at);
        saveLesson(l);
        d(true, `approved (tier 2: ${t.reason}); the harness writes nothing for it, make the change by hand`);
        continue;
      }
      // tier 1
      if (l.proposal.rung === 'instruction') {
        const all = [...approvedInstruction(l.id), l];
        const blocks = ctx.measure ? ctx.measure(all) : [];
        const budget = checkLineBudget(blocks, all, { candidate: l.id });
        if (!budget.ok) {
          l.reason = `line budget: ${budget.reason}`;
          l.history.push({ at, status: l.status, note: `approval refused: ${budget.reason}` });
          saveLesson(l);
          d(false, `refused: ${budget.reason}. Trim first: ${budget.trim.length ? budget.trim.map((x) => `harness learn review --expire ${x}`).join('; ') : 'trim your own text in the always-on file or expire learned lines'}`, 1, { budget });
          continue;
        }
      }
      l.landedAt = at;
      if (isProse(l)) l.reviewBy = reviewByFor(l.proposal.rung as 'instruction' | 'skill', now);
      l.decided = { at, by: 'user', decision: 'approve' };
      l.reason = undefined;
      setStatus(l, 'approved', `tier 1 approved by the user${l.reviewBy ? `; review by ${l.reviewBy}` : ''}`, at);
      saveLesson(l);
      needPlan = needPlan || isProse(l);
      d(true, `approved (tier 1: ${t.reason})${l.reviewBy ? `; review by ${l.reviewBy}` : ''}`);
      instrument({ event: 'learn.approve', ids: { lesson: l.id, tier: '1', by: 'user' } });
      continue;
    }
    if (r.action === 'reject') {
      if (!isPending(l) && l.status !== 'captured') {
        d(false, `it is ${l.status}; use --expire for an approved lesson`);
        continue;
      }
      l.decided = { at, by: 'user', decision: 'reject' };
      setStatus(l, 'rejected', 'rejected by the user', at);
      saveLesson(l);
      d(true, 'rejected (the record is kept; the class is not proposed again)');
      instrument({ event: 'learn.reject', ids: { lesson: l.id } });
      continue;
    }
    if (r.action === 'expire') {
      if (l.status !== 'approved') {
        d(false, `it is ${l.status}, not approved`);
        continue;
      }
      const removed = uninstallLearnedCheck(l.id, at);
      l.decided = { at, by: 'user', decision: 'expire' };
      setStatus(l, 'expired', removed.length ? `expired by the user; learned check removed` : 'expired by the user', at);
      saveLesson(l);
      needPlan = needPlan || isProse(l);
      d(true, removed.length ? 'expired; its learned check is removed from the private ledger' : 'expired');
      instrument({ event: 'learn.expire', ids: { lesson: l.id }, counts: { files: removed.length } });
      continue;
    }
    // renew
    if (l.status !== 'approved' || !isProse(l)) {
      d(false, 'only approved prose lessons carry a review date');
      continue;
    }
    l.reviewBy = reviewByFor(l.proposal!.rung as 'instruction' | 'skill', now);
    l.decided = { at, by: 'user', decision: 'renew' };
    l.updatedAt = at;
    l.history.push({ at, status: l.status, note: `renewed by the user; review by ${l.reviewBy}` });
    saveLesson(l);
    needPlan = true;
    d(true, `renewed; review by ${l.reviewBy}`);
  }
  let plan: ReviewResult['plan'];
  if (needPlan && ctx.plan) {
    plan = ctx.plan();
    if ('id' in plan) {
      for (const dcs of decisions.filter((x) => x.ok)) {
        const l = loadLesson(dcs.lesson);
        if (l && isProse(l)) {
          l.plan = plan.id;
          saveLesson(l);
        }
      }
    }
  }
  return { decisions, plan };
}

/** The ast-grep binary for proofs and imports (null when absent). */
export function astGrep(): AstGrepBinary | null {
  return findAstGrep();
}
