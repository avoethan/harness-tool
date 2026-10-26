/**
 * Failures already present at the starting commit.
 *
 * When a step that runs repository commands or whole-tree checks (lint,
 * typecheck, build, tests:base, coverage, affected) fails on the current
 * tree, the same step runs once in a temporary checkout of the base commit
 * (the way `prove-red` does) and the two failure identities are compared:
 *
 *   diagnostics  typecheck and lint: the multiset of normalised diagnostics
 *                (file relative to the repository, rule or TS code, message
 *                without line numbers);
 *   tests        tests:base: the exit code plus the normalised failing test
 *                names, when the runner's output was parsed in full;
 *   output       any other script: the exit code plus the normalised failure
 *                lines of its output (digits and the checkout folder removed).
 *
 * The step is `pre-existing` only when every current failure is also present
 * at the base (counted: two copies of one error now and one at the base is a
 * new error). Any new failure FAILs as before, naming only the new ones. A
 * base that cannot be evaluated (the checkout failed, the step was skipped
 * or timed out there, it reported its failures in another form, or ran
 * another command) never turns a failure into `pre-existing`: the step keeps
 * failing and says so. Paths are compared with forward slashes and lines
 * without carriage returns, so Windows output matches.
 *
 * The base result is cached per base commit and step command under
 * ~/.harness/cache/<repoId>/baseline-<sha>.json, and one checkout serves every
 * step of a gate run, so the base runs once per ticket.
 */
import * as path from 'node:path';
import type { GateContext } from './context';
import { EMPTY_TREE } from './context';
import type { ExecResult } from '../lib/exec';
import { readJsonOr, writeJson } from '../lib/fsx';
import { harnessHome } from '../lib/paths';
import { redactText } from '../lib/redact';
import { openBaseCheckout, type BaseCheckout } from './checkout';
import { stepKey } from './cache';
import { capReasons, type FailureIdentity, type StepDef, type StepOutcome } from './steps';

export type { FailureIdentity } from './steps';

type Item = FailureIdentity['items'][number];

export type BaseResult = { status: 'pass' } | { status: 'fail'; identity: FailureIdentity } | { status: 'error'; why: string };

export type Comparison =
  | { status: 'pre-existing'; items: Item[] }
  | { status: 'fail'; newItems: Item[]; old: number; why?: string }
  | { status: 'error'; why: string };

/** The interesting lines of a failed command (the same pick as `failureLines`). */
const FAIL_RE = /\b(?:error|fail(?:ed|ing|ure)?|FAIL|not ok|✗|×|AssertionError|Expected|Received|TS\d{4})\b/i;
const MAX_ITEMS = 500;

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rootsRe(roots: string[]): RegExp | null {
  const parts = [...new Set(roots.filter(Boolean).map((r) => r.replace(/\\/g, '/').replace(/\/+$/, '')))].filter((r) => r.length > 1).sort((a, b) => b.length - a.length);
  return parts.length ? new RegExp(`(?:${parts.map(escapeRe).join('|')})/?`, 'gi') : null;
}

/** One output line with ANSI colours, carriage returns, backslashes and the repository folders removed. */
export function cleanLine(line: string, roots: string[]): string {
  // eslint-disable-next-line no-control-regex
  let s = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').replace(/\\/g, '/');
  const re = rootsRe(roots);
  if (re) s = s.replace(re, '');
  return s.trim().replace(/^\.\//, '');
}

export function withoutLineNumbers(msg: string): string {
  return msg
    .replace(/\(\d+,\d+\)/g, '')
    .replace(/:\d+:\d+\b/g, '')
    .replace(/\bline \d+\b/gi, 'line')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A TypeScript diagnostic line as `{ id: "file|TSnnnn|message", text }`, or null when the line is not one. */
export function normaliseDiagnostic(line: string, roots: string[]): Item | null {
  const c = cleanLine(line, roots);
  const m = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(c) ?? /^(.*?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(c);
  let file = '';
  let code: string;
  let msg: string;
  if (m) {
    file = m[1].replace(/^\/+/, '').replace(/^\.\//, '');
    code = m[4];
    msg = m[5];
  } else {
    const g = /^error (TS\d+): (.*)$/.exec(c);
    if (!g) return null;
    code = g[1];
    msg = g[2];
  }
  return { id: `${file}|${code}|${withoutLineNumbers(msg)}`, text: redactText(c).slice(0, 240) };
}

/** Every TypeScript diagnostic in a command's output. */
export function tsDiagnostics(out: string, roots: string[]): Item[] {
  const items: Item[] = [];
  for (const l of out.split(/\n/)) {
    const d = normaliseDiagnostic(l, roots);
    if (d) items.push(d);
  }
  return items;
}

/** A failing test's name as compared: whitespace collapsed, durations and folders removed. */
export function normaliseTestName(name: string, roots: string[]): string {
  return cleanLine(name, roots)
    .replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `output` identity of a command: its exit code and normalised failure lines; null on a timeout or a cut-off output. */
export function outputIdentity(r: ExecResult, fingerprint: string, header: string, roots: string[]): FailureIdentity | null {
  if (r.timedOut || r.code === null) return null;
  const items: Item[] = [];
  for (const raw of `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\n/)) {
    const c = cleanLine(raw, roots);
    if (!c || !FAIL_RE.test(c)) continue;
    items.push({ id: c.replace(/\d+/g, '#').replace(/\s+/g, ' '), text: redactText(c).slice(0, 240) });
    if (items.length > MAX_ITEMS) return null;
  }
  return { kind: 'output', fingerprint, exit: r.code, header, items };
}

/** A script step's identity: its TypeScript diagnostics when it printed any, else its `output` identity. */
export function scriptIdentity(r: ExecResult, fingerprint: string, header: string, roots: string[]): FailureIdentity | null {
  if (r.timedOut || r.code === null) return null;
  const diags = tsDiagnostics(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, roots);
  if (diags.length && diags.length <= MAX_ITEMS) return { kind: 'diagnostics', fingerprint, exit: null, header, items: diags };
  return outputIdentity(r, fingerprint, header, roots);
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** Compare the current failure with the base's. Pre-existing only when every current failure (counted) is at the base. */
export function compareFailures(now: FailureIdentity, base: BaseResult): Comparison {
  if (base.status === 'error') return { status: 'error', why: base.why };
  if (base.status === 'pass') return { status: 'fail', newItems: now.items, old: 0, why: 'the same step passes at the base commit, so every failure is new' };
  const b = base.identity;
  if (b.fingerprint !== now.fingerprint) return { status: 'error', why: 'a different command ran at the base commit' };
  if (b.kind !== now.kind) return { status: 'error', why: 'the base run reported its failures in another form, so they cannot be compared' };
  if (now.kind === 'diagnostics' && !now.items.length) return { status: 'error', why: 'no diagnostics to compare' };
  if (now.kind !== 'diagnostics' && now.exit !== b.exit) return { status: 'fail', newItems: now.items, old: 0, why: `it exits ${now.exit} now and ${b.exit} at the base commit` };
  const left = new Map<string, number>();
  for (const i of b.items) left.set(i.id, (left.get(i.id) ?? 0) + 1);
  const newItems: Item[] = [];
  let old = 0;
  for (const i of now.items) {
    const k = left.get(i.id) ?? 0;
    if (k > 0) {
      left.set(i.id, k - 1);
      old++;
    } else newItems.push(i);
  }
  if (!newItems.length) return { status: 'pre-existing', items: now.items };
  return { status: 'fail', newItems, old };
}

// ---------------------------------------------------------------------------
// Running the base (one checkout per gate run, results cached per base commit)
// ---------------------------------------------------------------------------

interface BaselineCacheFile {
  version: 1;
  entries: Record<string, { status: 'pass' | 'fail'; identity?: FailureIdentity; at: string }>;
}

const open = new WeakMap<GateContext, { co?: BaseCheckout; error?: string }>();

export function baselineCachePath(repoId: string, base: string): string {
  return path.join(harnessHome(), 'cache', repoId, `baseline-${base.slice(0, 40)}.json`);
}

function checkoutFor(ctx: GateContext): { wt: string } | { error: string } {
  let s = open.get(ctx);
  if (!s) {
    const co = openBaseCheckout(ctx.root, ctx.base);
    s = co.ok ? { co: co.checkout } : { error: co.error };
    open.set(ctx, s);
  }
  return s.co ? { wt: s.co.wt } : { error: s.error ?? 'no checkout' };
}

/** Remove the run's base checkout, if one was made. */
export function closeBaseline(ctx: GateContext): void {
  const s = open.get(ctx);
  open.delete(ctx);
  s?.co?.close();
}

/** The step's result at the base commit, from the cache or by running it there. */
export function baseResult(ctx: GateContext, def: StepDef, now: FailureIdentity): BaseResult {
  if (ctx.base === EMPTY_TREE) return { status: 'error', why: 'the base is the empty tree' };
  if (!def.baseline) return { status: 'error', why: 'this step has no base run' };
  const file = baselineCachePath(ctx.repoId, ctx.base);
  const cache = readJsonOr<BaselineCacheFile | null>(file, null);
  const entries = cache && cache.version === 1 && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  const key = stepKey(def.name, ctx.base, 'baseline', [now.fingerprint]);
  const hit = entries[key];
  if (hit?.status === 'pass') return { status: 'pass' };
  if (hit?.status === 'fail' && hit.identity) return { status: 'fail', identity: hit.identity };
  const co = checkoutFor(ctx);
  if ('error' in co) return { status: 'error', why: co.error };
  let out: StepOutcome;
  try {
    out = def.baseline(ctx, co.wt);
  } catch (e) {
    return { status: 'error', why: `the step failed to run there (${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 160)})` };
  }
  let res: BaseResult;
  if (out.status === 'pass') res = { status: 'pass' };
  else if (out.status === 'fail' && out.identity) res = { status: 'fail', identity: out.identity };
  else if (out.status === 'skip') return { status: 'error', why: `the step was skipped there: ${(out.reasons[0] ?? '').slice(0, 160)}` };
  else return { status: 'error', why: `${(out.reasons[0] ?? 'it failed without a comparable result').slice(0, 160)}` };
  try {
    writeJson(file, { version: 1, entries: { ...entries, [key]: { ...res, at: new Date().toISOString() } } } satisfies BaselineCacheFile);
  } catch {
    /* the cache is an optimisation */
  }
  return res;
}

function short(ctx: Pick<GateContext, 'base'>): string {
  return ctx.base.slice(0, 10);
}

/**
 * Compare a failing step with the same step at the base commit and return
 * the outcome to record: `pre-existing`, a FAIL naming only the new failures,
 * or the original FAIL with the reason the base could not be compared.
 */
export function applyBaseline(ctx: GateContext, def: StepDef, out: StepOutcome): StepOutcome {
  if (out.status !== 'fail' || !out.identity || !def.baseline) return out;
  const now = out.identity;
  const cmp = compareFailures(now, baseResult(ctx, def, now));
  const at = short(ctx);
  if (cmp.status === 'pre-existing') {
    return {
      status: 'pre-existing',
      reasons: capReasons([`already failing at the base commit ${at}, nothing new: ${now.header}${cmp.items.length ? ` (${cmp.items.length} failure(s), all present before this change)` : ''}`, ...cmp.items.map((i) => i.text)], 21),
    };
  }
  if (cmp.status === 'error') return { status: 'fail', reasons: [...out.reasons, `the base commit ${at} could not be checked for comparison (${cmp.why}), so every failure above counts as new`] };
  if (cmp.old > 0 && cmp.newItems.length) {
    return { status: 'fail', reasons: capReasons([`${now.header}: ${cmp.newItems.length} new since the base commit; ${cmp.old} already failing at the base commit ${at} left out`, ...cmp.newItems.map((i) => i.text)], 21) };
  }
  return { status: 'fail', reasons: [...out.reasons, ...(cmp.why ? [`(${cmp.why})`] : [])] };
}

/** The base checkout's counterpart of a folder inside the repository. */
export function inCheckout(ctx: Pick<GateContext, 'root'>, dir: string, wt: string): string {
  return path.join(wt, path.relative(ctx.root, dir));
}

/** The folders whose paths are removed from output before comparing. */
export function rootsFor(ctx: Pick<GateContext, 'root'>, at?: string): string[] {
  return at ? [at, ctx.root] : [ctx.root];
}
