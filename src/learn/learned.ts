/**
 * Learned checks in the private ledger (tier 0): the part the gate and the
 * PostToolUse hook read. Kept light (fs and path only) because the hook
 * loads it on every edit.
 *
 *   ~/.harness/ledger/learned.json             {version: 1, records: LearnedRecord[]}
 *   ~/.harness/ledger/checks/learned/<id>.json  the check spec (+ <id>.yml for ast-grep)
 *
 * Discovery rewrites ledger.json and the top level of ledger/checks/ on every
 * run; learned checks live beside it so they survive. `withLearned(ledger)`
 * merges them into the ledger the gate and the hook use: a learned record
 * that promotes a discovered record (same id, `overrides`) replaces it in
 * block mode; any other learned record is added. A learned record never
 * replaces a safety record and never lowers a mode.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ledger, LedgerRecord } from '../types';
import { harnessHome } from '../lib/paths';
import { readJsonOr } from '../lib/fsx';

export const LEARNED_SUBDIR = 'learned';
export const LEARNED_REF_RE = /^learned\/[A-Za-z0-9][\w.-]*\.json$/;

export interface LearnedRecord extends LedgerRecord {
  /** The lesson this check enforces. */
  lesson: string;
  /** The discovered record id this check promotes to block mode. */
  overrides?: string;
}

export function learnedChecksDir(): string {
  return path.join(harnessHome(), 'ledger', 'checks', LEARNED_SUBDIR);
}

export function learnedLedgerPath(): string {
  return path.join(harnessHome(), 'ledger', 'learned.json');
}

export function loadLearnedRecords(file = learnedLedgerPath()): LearnedRecord[] {
  const j = readJsonOr<{ version?: number; records?: unknown } | null>(file, null);
  if (!j || j.version !== 1 || !Array.isArray(j.records)) return [];
  return (j.records as LearnedRecord[]).filter(
    (r) => r && typeof r.id === 'string' && typeof r.lesson === 'string' && r.check && r.check.mode === 'block' && typeof r.check.ref === 'string' && LEARNED_REF_RE.test(r.check.ref) && r.scope && Array.isArray(r.scope.repos),
  );
}

/** The ledger with the learned checks merged in (see the header). Null only when there is neither. */
export function withLearned(ledger: Ledger | null, learned: LearnedRecord[] = loadLearnedRecords()): Ledger | null {
  if (!learned.length) return ledger;
  const base: Ledger = ledger ?? { version: 1, generatedAt: new Date(0).toISOString(), workspaceRoot: '', records: [], skipped: [], scanners: [] };
  const records = [...base.records];
  for (const l of learned) {
    const i = records.findIndex((r) => r.id === l.id);
    if (i >= 0) {
      const cur = records[i];
      if (l.overrides === cur.id && cur.family !== 'safety') records[i] = l;
      continue; // never shadow a discovered record otherwise
    }
    records.push(l);
  }
  return { ...base, records };
}

/** A stamp of the learned checks (the gate's standards cache key includes it). */
export function learnedStamp(): string {
  const parts: string[] = [];
  for (const p of [learnedLedgerPath(), learnedChecksDir()]) {
    try {
      const st = fs.statSync(p);
      parts.push(`${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push('-');
    }
  }
  try {
    for (const n of fs.readdirSync(learnedChecksDir()).sort()) {
      const st = fs.statSync(path.join(learnedChecksDir(), n));
      parts.push(`${n}:${st.size}:${st.mtimeMs}`);
    }
  } catch {
    /* none */
  }
  return parts.join('|');
}
