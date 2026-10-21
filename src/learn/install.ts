/**
 * Tier 0: write a proven learned check into the private ledger
 * (~/.harness/ledger/checks/learned/<id>.json, + <id>.yml for ast-grep) and
 * its record into ~/.harness/ledger/learned.json. Nothing in any agent's
 * configuration changes and nothing is re-signed: the gate and the
 * PostToolUse hook pick the check up through `withLearned` (learned.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckType, Ledger, LedgerRecord } from '../types';
import { writeCheckSpec, type CheckSpec } from '../discover/checks';
import { writeJson, writeTextAtomic } from '../lib/fsx';
import { learnedChecksDir, learnedLedgerPath, loadLearnedRecords, type LearnedRecord } from './learned';
import type { LearnedCheck, LessonRecord } from './store';

const TYPE_OF: Record<LearnedCheck['engine'], CheckType> = { 'ast-grep': 'ast-grep', regex: 'regex', eslint: 'eslint', builtin: 'config', subjects: 'commitlint' };

export function learnedSpec(check: LearnedCheck): CheckSpec {
  return { version: 1, id: check.id, engine: check.engine, mode: 'block', statement: check.statement, fixText: check.fixText, scope: check.scope, ...(check.spec as Partial<CheckSpec>) } as CheckSpec;
}

/** The ledger record a learned check runs as. */
export function learnedRecord(lesson: Pick<LessonRecord, 'id'>, check: LearnedCheck, discovered: Ledger | null, now = new Date().toISOString()): LearnedRecord {
  const ref = `learned/${check.id}.json`;
  const orig = check.overrides ? discovered?.records.find((r) => r.id === check.overrides) : undefined;
  if (orig) {
    return {
      ...orig,
      check: { ...orig.check, mode: 'block', ref, fixText: orig.check.fixText ?? check.fixText },
      provenance: [...orig.provenance, { kind: 'history', ref: `lesson:${lesson.id}` }],
      lesson: lesson.id,
      overrides: orig.id,
    };
  }
  const rec: LedgerRecord = {
    id: check.id,
    statement: check.statement,
    family: check.family as LedgerRecord['family'],
    scope: check.scope,
    tier: 'single-source',
    confidence: 0.5,
    evidence: { sites: 0, conforming: 0, packages: 0, examples: [], sources: [`lesson:${lesson.id}`] },
    check: { type: TYPE_OF[check.engine], mode: 'block', ref, fixText: check.fixText },
    conflicts: [],
    provenance: [{ kind: 'history', ref: `lesson:${lesson.id}` }],
    history: { firstSeen: now, lastCounted: now, disputes: 0 },
  };
  return { ...rec, lesson: lesson.id };
}

/** Write the spec and upsert the record. Returns the files written. */
export function installLearnedCheck(lesson: Pick<LessonRecord, 'id'>, check: LearnedCheck, discovered: Ledger | null, now = new Date().toISOString()): string[] {
  const dir = learnedChecksDir();
  fs.mkdirSync(dir, { recursive: true });
  const files = writeCheckSpec(dir, learnedSpec(check), (p, t) => writeTextAtomic(p, t));
  const rec = learnedRecord(lesson, check, discovered, now);
  const records = loadLearnedRecords().filter((r) => r.id !== rec.id);
  records.push(rec);
  writeJson(learnedLedgerPath(), { version: 1, updatedAt: now, records });
  files.push(learnedLedgerPath());
  return files;
}

/** Remove a lesson's learned check (spec files and record). Returns the files removed or changed. */
export function uninstallLearnedCheck(lessonId: string, now = new Date().toISOString()): string[] {
  const all = loadLearnedRecords();
  const mine = all.filter((r) => r.lesson === lessonId);
  if (!mine.length) return [];
  const out: string[] = [];
  for (const r of mine) {
    for (const ext of ['.json', '.yml']) {
      const p = path.join(learnedChecksDir(), `${r.id}${ext}`);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        out.push(p);
      }
    }
  }
  writeJson(learnedLedgerPath(), { version: 1, updatedAt: now, records: all.filter((r) => r.lesson !== lessonId) });
  out.push(learnedLedgerPath());
  return out;
}
