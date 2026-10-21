/**
 * Standards at the point of use (DESIGN §2.4, R-27): the ledger's records
 * for a repo, the ledger's file-scoped checks on one edited file, and the
 * short text injected as additionalContext.
 *
 * File-scoped ledger checks: the hook calls `runLedgerChecks` from
 * src/discover/checks.ts when that module exports it (interface below).
 * When it is absent the hook still maps the lint findings it already has to
 * ledger records (ESLint rule ids to `check.type: 'eslint'` records, SQL
 * linter codes to `sql-lint` records, Prettier to `format` records), so the
 * violated standard's statement and fix text are injected either way.
 *
 * Ledger statements are data written by discovery from repo material; they
 * are injected as one-line quotes under a header that says so, with hidden
 * Unicode stripped and length capped.
 */
import * as path from 'node:path';
import type { Ledger, LedgerRecord, Tier } from '../types';
import { readJsonOr } from '../lib/fsx';
import { ledgerPath } from '../lib/paths';
import { oneLine } from './common';
import type { LintFinding } from './lint';
import { withLearned } from '../learn/learned';

// ---------------------------------------------------------------------------
// The interface the hook calls (implemented by src/discover/checks.ts)
// ---------------------------------------------------------------------------

export interface LedgerCheckFinding {
  /** LedgerRecord.id of the violated standard. */
  ruleId: string;
  /** Absolute path of the file. */
  file: string;
  line?: number;
  /** Short tool message (never file content). */
  message?: string;
}

export interface RunLedgerChecksOptions {
  repoRoot: string;
  repoId: string;
  /** Absolute paths; the hook passes exactly one. */
  files: string[];
  /** The records in scope for these files (already filtered by repo and path). */
  records: LedgerRecord[];
  timeoutMs: number;
  /** 'file': only checks that can run on single files (ast-grep, regex, file-scoped ESLint rules). */
  scope: 'file';
}

export type RunLedgerChecks = (opts: RunLedgerChecksOptions) => Promise<LedgerCheckFinding[]> | LedgerCheckFinding[];

let override: RunLedgerChecks | null | undefined;

/** Replace the runner (tests and embedders); `undefined` restores the lookup. */
export function useLedgerChecks(fn: RunLedgerChecks | null | undefined): void {
  override = fn;
}

/** Shape of discover's runner: (ledger, files, opts) -> violations. */
type DiscoverRunner = (
  ledger: Ledger,
  files: string[],
  opts: { mode?: 'block' | 'warn' | 'all'; repoRoot?: string; ignoreScope?: boolean; eslint?: boolean; timeoutMs?: number },
) => Array<{ recordId: string; file: string; line: number; message: string }>;

/**
 * `runLedgerChecks` from src/discover/checks.ts adapted to the hook's call
 * shape, or null when that module does not provide it. The hook passes the
 * records already scoped to the repo and path, so scope filtering is off;
 * ESLint-only records stay off here (the gate runs them), and only the
 * file-scoped checks (ast-grep, regex) run within the hook's budget.
 */
export function externalLedgerChecks(): RunLedgerChecks | null {
  if (override !== undefined) return override;
  let runner: DiscoverRunner | null = null;
  try {
    const mod = require(path.join(__dirname, '..', 'discover', 'checks')) as { runLedgerChecks?: unknown };
    runner = typeof mod.runLedgerChecks === 'function' ? (mod.runLedgerChecks as DiscoverRunner) : null;
  } catch {
    runner = null;
  }
  if (!runner) return null;
  const run = runner;
  return (opts: RunLedgerChecksOptions): LedgerCheckFinding[] => {
    const ledger: Ledger = {
      version: 1,
      generatedAt: new Date().toISOString(),
      workspaceRoot: opts.repoRoot,
      records: opts.records,
      skipped: [],
      scanners: [],
    };
    const violations = run(ledger, opts.files, { mode: 'all', repoRoot: opts.repoRoot, ignoreScope: true, eslint: false, timeoutMs: opts.timeoutMs });
    return violations.map((v) => ({ ruleId: v.recordId, file: v.file, line: v.line, message: v.message }));
  };
}

// ---------------------------------------------------------------------------
// Ledger access
// ---------------------------------------------------------------------------

/** The discovered ledger with the learning loop's approved checks merged in (src/learn/learned.ts). */
export function loadLedger(): Ledger | null {
  const l = readJsonOr<Ledger | null>(ledgerPath(), null);
  return withLearned(!l || l.version !== 1 || !Array.isArray(l.records) ? null : l);
}

function globToRe(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/** True when the record's path globs (if any) match the repo-relative path. */
export function pathInScope(rec: LedgerRecord, relPath?: string): boolean {
  const globs = rec.scope?.paths;
  if (!globs || !globs.length || !relPath) return true;
  const rel = relPath.replace(/\\/g, '/');
  return globs.some((g) => {
    const re = globToRe(g);
    return re.test(rel) || (!g.includes('/') && re.test(path.posix.basename(rel)));
  });
}

/** Records that hold for a repo (by id, or the whole workspace) and, when given, a file in it. */
export function recordsFor(ledger: Ledger | null, repoId: string, relPath?: string): LedgerRecord[] {
  if (!ledger) return [];
  return ledger.records.filter((r) => {
    const repos = r?.scope?.repos ?? [];
    if (!repos.includes('*') && !repos.includes(repoId)) return false;
    return pathInScope(r, relPath);
  });
}

const TIER_RANK: Record<Tier, number> = { declared: 0, 'counted-strong': 1, 'counted-majority': 2, 'review-derived': 3, 'single-source': 4 };

/** The repo's top declared and counted-strong standards, strongest first. */
export function topStandards(records: LedgerRecord[], max: number): LedgerRecord[] {
  return records
    .filter((r) => r.tier === 'declared' || r.tier === 'counted-strong')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.id.localeCompare(b.id))
    .slice(0, max);
}

/** One line: the statement and, when the ledger has it, the fix. */
export function standardLine(rec: LedgerRecord, max = 220): string {
  const fix = rec.check?.fixText ? ` Fix: ${oneLine(rec.check.fixText, 120)}` : '';
  return oneLine(`${rec.statement}${fix}`, max);
}

function refList(ref: string | undefined): string[] {
  return String(ref ?? '')
    .split(/[\s,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The ledger record a lint finding violates, when the ledger has one. */
export function recordForFinding(f: LintFinding, records: LedgerRecord[]): LedgerRecord | null {
  for (const r of records) {
    const t = r.check?.type;
    const refs = refList(r.check?.ref);
    if (f.tool === 'eslint' && t === 'eslint' && refs.some((x) => x === f.rule || x.endsWith('/' + f.rule) || x.replace(/^eslint:/, '') === f.rule)) return r;
    if ((f.tool === 'tsqllint' || f.tool === 'sqlfluff') && t === 'sql-lint' && refs.some((x) => x.toLowerCase() === f.rule.toLowerCase())) return r;
    if (f.tool === 'prettier' && r.family === 'format' && (t === 'config' || t === 'eslint') && (refs.some((x) => /prettier/i.test(x)) || /prettier/i.test(r.id))) return r;
  }
  return null;
}
