/**
 * Lesson records: one JSON file per mistake class at
 * ~/.harness/lessons/<id>.json, a superset of `Lesson` (src/types.ts).
 *
 * Records are raw and append-only in spirit (R-32): a re-scan adds source
 * event ids and counts, every status change appends to `history`, and
 * nothing ever rewrites a record into a summary or deletes it (gc only lists).
 * A record holds ids, counts, rule ids, file paths and the enforcer the
 * harness or the judgment pass proposed; never the text of a conversation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnforcerRung, Lesson } from '../types';
import { harnessHome } from '../lib/paths';
import { readJsonOr, writeJson } from '../lib/fsx';
import { isLessonId, type ClassKind } from './classes';

export type LessonStatus = Lesson['status'];

export type ProofMethod = 'ast-grep-test' | 'regex-fixture' | 'eslint-fixture' | 'regression' | 'gate-event' | 'prose' | 'none';

export interface ProofRecord {
  at: string;
  /** proven: the enforcer fails on the mistake; unprovable: prose the harness cannot test. */
  result: 'proven' | 'not-proven' | 'error' | 'unprovable';
  method: ProofMethod;
  detail: string;
  /** Where the mistake sample came from. */
  fixtureSource?: FixtureSource;
  counts?: Record<string, number>;
}

export type FixtureSource = 'probe-library' | 'judgment' | 'user' | 'gate-event' | 'commits';

/** A learned check for the private ledger (tier 0). */
export interface LearnedCheck {
  /** Ledger record id the check runs as (same id as the record it promotes, or `<family>.learned-<slug>`). */
  id: string;
  family: string;
  statement: string;
  fixText: string;
  /** The ledger record this check promotes from warn to block (same id), if any. */
  overrides?: string;
  /** Runner engine (src/discover/checks.ts). */
  engine: 'ast-grep' | 'regex' | 'eslint' | 'builtin' | 'subjects';
  /** The check spec body (rules, patterns, builtin data, eslint rule), copied into the spec file. */
  spec: Record<string, unknown>;
  scope: { repos: string[]; paths?: string[] };
}

/** What the harness (or the judgment pass) proposes to enforce a lesson with. */
export interface EnforcerPlan {
  rung: EnforcerRung;
  /** ledger:<id> | learned/<lesson>.json | gate:<step> | test:<repo>:<file> | instruction | skill | rail */
  ref: string;
  /** Why this rung and not a higher one, in plain words. */
  why: string;
  /** An enforcer already in place: the lesson records and proves it, nothing is written. */
  existing: boolean;
  source: 'ledger' | 'gate-step' | 'judgment' | 'rail';
  check?: LearnedCheck;
  fixtures?: { valid: string[]; invalid: string[]; source: FixtureSource; ext?: string };
  test?: { repo: string; files: string[]; preFix: string; fix: string };
  /** Instruction line (a negative constraint) or skill text. */
  text?: string;
}

export interface LessonRecord extends Lesson {
  version: 1;
  /** Class key (src/learn/classes.ts). */
  key: string;
  kind: ClassKind;
  /** Plain words built from the key only. */
  description: string;
  touchedRail: boolean;
  /** Repo ids seen in the occurrences. */
  repos: string[];
  /** Occurrences by event name. */
  counts: Record<string, number>;
  /** Follow-up failures inside a task already counted (gate attempts), and reverts after a red landing. */
  followUps: number;
  capturedAt: string;
  updatedAt: string;
  proposal?: EnforcerPlan;
  tierReason?: string;
  needsJudgment?: { reason: string; rungs?: EnforcerRung[]; suggested?: EnforcerRung; bundle?: string; at?: string };
  proof?: ProofRecord;
  /** Why the lesson stays where it is (not proven, refused, waiting for judgment). */
  reason?: string;
  /** When the enforcer landed (tier 0 install, or the review approval that produced a plan). */
  landedAt?: string;
  decided?: { at: string; by: 'auto' | 'user'; decision: 'approve' | 'reject' | 'expire' | 'renew' };
  /** The plan an approval produced (`harness apply --plan <id>`). */
  plan?: string;
  /** Set by gc: a prose lesson whose class came back twice after it landed needs a code check. */
  promote?: { at: string; repeats: number };
  /** Other class keys that count as this lesson (a learned rule id firing at the gate). */
  aliases?: string[];
  history: Array<{ at: string; status: LessonStatus; note: string }>;
}

export function lessonsDir(): string {
  return path.join(harnessHome(), 'lessons');
}

export function lessonPath(id: string): string {
  if (!isLessonId(id)) throw new Error(`bad lesson id '${id}'`);
  return path.join(lessonsDir(), `${id}.json`);
}

export function loadLesson(id: string): LessonRecord | null {
  if (!isLessonId(id)) return null;
  const r = readJsonOr<LessonRecord | null>(lessonPath(id), null);
  return r && r.version === 1 && r.id === id ? r : null;
}

export function saveLesson(rec: LessonRecord): string {
  const p = lessonPath(rec.id);
  writeJson(p, rec);
  return p;
}

export function listLessons(dir = lessonsDir()): LessonRecord[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LessonRecord[] = [];
  for (const n of names.sort()) {
    const id = n.slice(0, -'.json'.length);
    if (!isLessonId(id)) continue;
    const r = readJsonOr<LessonRecord | null>(path.join(dir, n), null);
    if (r && r.version === 1 && r.id === id) out.push(r);
  }
  return out;
}

/** A prose lesson the renderer writes: an instruction line in the always-on file, or skill text. */
export interface ProseLine {
  id: string;
  rung: 'instruction' | 'skill';
  text: string;
  reviewBy?: string;
}

/**
 * Approved prose lessons for the renderer (src/render/propose.ts reads them
 * from `<harnessHome>/lessons`). A lesson past its review date stays until the
 * user expires or renews it in `harness learn review`.
 */
export function approvedProse(harnessHomeDir: string): ProseLine[] {
  const out: ProseLine[] = [];
  for (const r of listLessons(path.join(harnessHomeDir, 'lessons'))) {
    const p = r.proposal;
    if (r.status !== 'approved' || !p || (p.rung !== 'instruction' && p.rung !== 'skill') || typeof p.text !== 'string' || !p.text.trim()) continue;
    out.push({ id: r.id, rung: p.rung, text: p.text.trim(), reviewBy: r.reviewBy });
  }
  return out;
}

/** Change the status and append the change to the history (the record is never rewritten as a summary). */
export function setStatus(rec: LessonRecord, status: LessonStatus, note: string, at = new Date().toISOString()): void {
  rec.status = status;
  rec.updatedAt = at;
  rec.history.push({ at, status, note: note.slice(0, 300) });
}

/** Lessons waiting for a decision in `harness learn review`. */
export function isPending(rec: LessonRecord): boolean {
  return rec.status === 'proposed' || rec.status === 'proven';
}

/** Prose lessons: skill text and instruction lines (they expire). */
export function isProse(rec: Pick<LessonRecord, 'proposal'>): boolean {
  return rec.proposal?.rung === 'skill' || rec.proposal?.rung === 'instruction';
}
