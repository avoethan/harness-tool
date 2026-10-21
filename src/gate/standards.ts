/**
 * Step 4: the ledger's standards checks on the changed files
 * (runLedgerChecks from src/discover/checks.ts), plus the commit-subject
 * records over the commits between the base and HEAD.
 *
 * Block mode for records in the `declared` and `counted-strong` tiers (and
 * any record whose own check mode is `block`); warn mode for the rest: a
 * warning is listed but does not fail the step. A FAIL names the rule id,
 * the statement, file:line and the fix text. Records the runner could not
 * check (no spec on disk, ast-grep absent) are listed, never dropped.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Ledger, LedgerRecord } from '../types';
import type { GateContext } from './context';
import { EMPTY_TREE } from './context';
import { entriesDigest } from './cache';
import { checkCommitSubjects, checksDir, runLedgerChecksDetailed, type Violation } from '../discover/checks';
import { readJsonOr } from '../lib/fsx';
import { ledgerPath } from '../lib/paths';
import { rawGit } from '../lib/git';
import { sha256 } from '../lib/hash';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';
import { learnedStamp, withLearned } from '../learn/learned';

const BLOCK_TIERS = new Set(['declared', 'counted-strong']);

export function isBlocking(r: Pick<LedgerRecord, 'tier' | 'check'>): boolean {
  return BLOCK_TIERS.has(r.tier) || r.check?.mode === 'block';
}

/** The discovered ledger with the learning loop's approved checks merged in (src/learn/learned.ts). */
export function loadLedger(): Ledger | null {
  const l = readJsonOr<Ledger | null>(ledgerPath(), null);
  return withLearned(l && l.version === 1 && Array.isArray(l.records) ? l : null);
}

/** Commit subjects between the base and HEAD (oldest first); empty when the base is not a commit. */
export function subjectsSince(root: string, base: string): string[] {
  if (base === EMPTY_TREE) return [];
  const r = rawGit(root, ['log', '--reverse', '--format=%s', `${base}..HEAD`], 30_000);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function describe(v: Violation, ctx: GateContext, rec: LedgerRecord | undefined): string {
  const file = v.file.startsWith('(') ? v.file : path.relative(ctx.root, v.file).split(path.sep).join('/');
  const where = v.line ? `${file}:${v.line}` : file;
  const fix = v.fixText ?? rec?.check.fixText;
  const snippet = v.file === '(commit subject)' && v.snippet ? ` "${v.snippet}"` : '';
  return `${v.recordId} at ${where}${snippet}: ${rec?.statement ?? v.message}${fix ? ` Fix: ${fix}` : ''}`;
}

/** A per-file key for a violation, matching baselineKey's shape (snippet, not line). */
function vKey(v: Violation): string {
  return `${v.recordId}::${(v.snippet ?? '').replace(/\s+/g, ' ').trim()}`;
}

/**
 * The baseline the gate trusts is the set of violations already present in the
 * changed files *at the base commit*, recomputed here from the base blobs,
 * never the `baseline` stored in the check specs. The stored baseline lives in
 * `~/.harness/ledger/checks` and a mid-task `harness discover` would rewrite it
 * to absorb the agent's new violations (a gate-gaming path the red-team found);
 * the base commit is immutable within a task, so a violation that is not in the
 * base content of its file is new and blocks. Added files have no base content,
 * so every violation in them is new.
 */
function baseBaseline(ctx: GateContext, ledger: Ledger, files: string[], checksDirOpt?: string): Set<string> {
  const rels = files.map((abs) => path.relative(ctx.root, abs).split(path.sep).join('/'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gate-base-'));
  const baseFiles: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const text = ctx.baseText(rels[i]); // null for an added file or a binary blob
      if (text == null) continue;
      const dest = path.join(tmp, rels[i]);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
      baseFiles.push(dest);
    }
    if (!baseFiles.length) return new Set();
    const res = runLedgerChecksDetailed(ledger, baseFiles, { mode: 'all', eslint: false, checksDir: checksDirOpt, repoRoot: tmp, ignoreScope: true, ignoreBaseline: true });
    const keys = new Set<string>();
    for (const v of res.violations) keys.add(`${path.relative(tmp, v.file).split(path.sep).join('/')}|${vKey(v)}`);
    return keys;
  } catch {
    return new Set();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function runStandards(ctx: GateContext, ledgerArg?: Ledger | null, opts: { checksDir?: string } = {}): StepOutcome {
  const ledger = ledgerArg === undefined ? loadLedger() : ledgerArg;
  if (!ledger) return skip('no standards ledger yet (run `harness discover`)');
  const files = ctx
    .changedPresent()
    .map((p) => path.join(ctx.root, p))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const byId = new Map(ledger.records.map((r) => [r.id, r]));
  // Raw working-tree violations (stored spec baselines ignored), minus the
  // baseline recomputed from the base commit — so re-baselining via a mid-task
  // `harness discover` cannot hide a new violation.
  const rawRes = runLedgerChecksDetailed(ledger, files, { mode: 'all', eslint: false, checksDir: opts.checksDir, ignoreBaseline: true });
  const baseKeys = baseBaseline(ctx, ledger, files, opts.checksDir);
  const res = {
    ...rawRes,
    violations: rawRes.violations.filter((v) => !baseKeys.has(`${path.relative(ctx.root, v.file).split(path.sep).join('/')}|${vKey(v)}`)),
  };
  const subjects = subjectsSince(ctx.root, ctx.base);
  const subj = subjects.length ? checkCommitSubjects(ledger, subjects, { checksDir: opts.checksDir, repoId: ctx.repoId }) : [];
  const all = [...res.violations, ...subj];
  const blocking = all.filter((v) => {
    const r = byId.get(v.recordId);
    return r ? isBlocking(r) : v.mode === 'block';
  });
  const warnings = all.filter((v) => !blocking.includes(v));
  const notes: string[] = [];
  const unchecked = res.skipped.filter((s) => !/ESLint-only rule|commit-subject check/.test(s.reason));
  if (unchecked.length) {
    const why = [...new Set(unchecked.map((s) => s.reason))].slice(0, 3).join('; ');
    notes.push(`${unchecked.length} record(s) not checked here (${why})`);
  }
  if (blocking.length) {
    return fail(capReasons([...blocking.map((v) => describe(v, ctx, byId.get(v.recordId))), ...warnings.map((v) => `warn: ${describe(v, ctx, byId.get(v.recordId))}`), ...notes]));
  }
  return pass(`${files.length} changed file(s) and ${subjects.length} commit subject(s) checked against ${ledger.records.length} ledger record(s)`, ...capReasons(warnings.map((v) => `warn: ${describe(v, ctx, byId.get(v.recordId))}`), 10), ...notes);
}

function dirDigest(dir: string): string {
  const parts: string[] = [];
  try {
    for (const n of fs.readdirSync(dir).sort()) {
      const st = fs.statSync(path.join(dir, n));
      parts.push(`${n}:${st.size}:${st.mtimeMs}`);
    }
  } catch {
    /* none */
  }
  return sha256(parts.join('\n'));
}

export const standardsStep: StepDef = {
  name: 'standards',
  design: 4,
  group: 'standards',
  cacheFail: true,
  inputs: (ctx) => {
    const changed = new Set(ctx.changedPresent());
    let ledgerStamp = 'none';
    try {
      const st = fs.statSync(ledgerPath());
      ledgerStamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      /* none */
    }
    // Some checks look at sibling files (a test beside a module), so test files are part of the input too.
    // ctx.base is part of the key: the baseline is recomputed from the base commit.
    return [entriesDigest(ctx.entries, (p) => changed.has(p) || /(^|\/)(?:test|tests|__tests__)\//.test(p)), ledgerStamp, dirDigest(checksDir()), learnedStamp(), ctx.head ?? '-', ctx.base];
  },
  run: (ctx) => runStandards(ctx),
};
