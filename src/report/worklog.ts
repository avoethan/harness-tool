/**
 * The work log the user keeps (one row per ticket; the columns of the
 * real-use log). The report reads it for what the harness cannot measure
 * itself (pull-request rework rounds and the final outcome) and
 * `harness report row` prints a row pre-filled with what the harness did
 * measure, for the user to complete.
 *
 *   ~/.harness/worklog.csv   (or `--worklog <file>`)
 *
 * The file is the user's: the report reads only the columns it needs, joins
 * rows to tasks by ticket hash (a prefix of 8 or more hex characters is
 * enough), and never copies free text from it into the report.
 */
import * as path from 'node:path';
import { harnessHome } from '../lib/paths';
import { readTextOr } from '../lib/fsx';

/** The work-log columns, in order. */
export const WORKLOG_COLUMNS = [
  'ticket_hash',
  'date',
  'task_kind',
  'size_estimate',
  'user_messages',
  'waiting_for_user_episodes',
  'acus',
  'time_to_pr_min',
  'pr_rework_rounds',
  'review_findings_by_family',
  'e2e_proof_in_writeup',
  'clarifications_asked',
  'repeat_corrections',
  'outcome',
  'harness_version',
] as const;

export type WorklogColumn = (typeof WORKLOG_COLUMNS)[number];

export type WorklogOutcome = 'merged' | 'abandoned' | 'reverted' | 'other';

export interface WorklogRow {
  /** Lower-case hex (a prefix of the ticket hash). */
  ticketHash: string;
  date?: string;
  reworkRounds?: number;
  outcome?: WorklogOutcome;
}

export interface Worklog {
  file: string;
  rows: WorklogRow[];
  /** Rows without a usable ticket hash. */
  skipped: number;
}

export function worklogPath(): string {
  return path.join(harnessHome(), 'worklog.csv');
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = text.replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** One CSV line; fields with a comma, quote or line break are quoted. */
export function csvLine(values: Array<string | number | undefined | null>): string {
  return values
    .map((v) => {
      const t = v === undefined || v === null ? '' : String(v);
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    })
    .join(',');
}

export function normaliseOutcome(raw: string | undefined): WorklogOutcome | undefined {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return undefined;
  if (/^merged?\b/.test(t)) return 'merged';
  if (/^abandon/.test(t)) return 'abandoned';
  if (/^revert/.test(t)) return 'reverted';
  return 'other';
}

function intOrUndefined(raw: string | undefined): number | undefined {
  const t = (raw ?? '').trim();
  if (!/^\d{1,6}$/.test(t)) return undefined;
  return Number(t);
}

/** Read the work log; null when the file does not exist. */
export function readWorklog(file: string = worklogPath()): Worklog | null {
  const text = readTextOr(file, null);
  if (text === null) return null;
  const rows = parseCsv(text);
  if (!rows.length) return { file, rows: [], skipped: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: WorklogColumn): number => header.indexOf(name);
  const iHash = col('ticket_hash');
  if (iHash < 0) return { file, rows: [], skipped: rows.length - 1 };
  const iDate = col('date');
  const iRework = col('pr_rework_rounds');
  const iOutcome = col('outcome');
  const out: WorklogRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const hash = (r[iHash] ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(hash)) {
      skipped++;
      continue;
    }
    const date = iDate >= 0 ? (r[iDate] ?? '').trim() : '';
    out.push({
      ticketHash: hash,
      date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : undefined,
      reworkRounds: iRework >= 0 ? intOrUndefined(r[iRework]) : undefined,
      outcome: iOutcome >= 0 ? normaliseOutcome(r[iOutcome]) : undefined,
    });
  }
  return { file, rows: out, skipped };
}

/** The work-log row for a ticket hash: the last row whose hash is a prefix of it. */
export function rowFor(log: Worklog | null, ticketHash: string): WorklogRow | undefined {
  if (!log) return undefined;
  const h = ticketHash.toLowerCase();
  let hit: WorklogRow | undefined;
  for (const r of log.rows) if (h.startsWith(r.ticketHash)) hit = r;
  return hit;
}
