/**
 * Step 5: tests the agent did not write, plus the brief's acceptance checks.
 *
 *   tests:base        the test files that exist at the base commit, run with
 *                     the base commit's `test` script; restricted to those
 *                     files when the runner takes file filters (vitest,
 *                     jest), else the whole suite (said in the report).
 *   acceptance:<id>   one step per unit-kind criterion: the test named
 *                     "<id>: ..." must have been proven red at the base
 *                     commit (`harness gate prove-red` writes `redProof` into
 *                     the brief) and must pass now, with at least one test
 *                     selected by the name filter. A green-at-base criterion
 *                     (`check.greenAtBase`: characterisation, no behaviour
 *                     change, documentation) has no red-first requirement:
 *                     its test must exist and pass now.
 *
 * `prove-red` checks out the base commit into a temporary git worktree
 * (outside the repository; the user's tree is never touched), copies the
 * changed test files in, links the repository's node_modules, runs each
 * acceptance check there and records the result in the brief.
 */
import * as path from 'node:path';
import type { Criterion, RedProof } from '../types';
import type { GateContext } from './context';
import { EMPTY_TREE, isTestFile } from './context';
import { withBaseCheckout } from './checkout';
import { redactText } from '../lib/redact';
import { loadBrief, saveBrief } from '../intake/brief';
import { failureLines, runScript, scriptCommand, type Runner, type ScriptCommand } from './scripts';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';
import { gateCriteria } from './gatecheck';
import { gateWhat } from '../intake/gatecheck';
import type { ExecResult } from '../lib/exec';

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  suitesFailed: number;
  /** Whether the counts came from a machine-readable report. */
  known: boolean;
  failures: string[];
}

/** Arguments that select tests by name, or null when the runner cannot. */
export function nameFilterArgs(runner: Runner, pattern: string): string[] | null {
  switch (runner) {
    case 'vitest':
    case 'jest':
      return ['-t', pattern];
    case 'mocha':
      return ['--grep', pattern];
    case 'node':
      return ['--test-name-pattern', pattern];
    case 'ava':
      return ['--match', `*${pattern}*`];
    case 'playwright':
      return ['-g', pattern];
    default:
      return null;
  }
}

/** Arguments for a machine-readable report on stdout. */
export function reporterArgs(runner: Runner): string[] {
  switch (runner) {
    case 'vitest':
      return ['--reporter=json'];
    case 'jest':
      return ['--json'];
    case 'mocha':
      return ['--reporter', 'json'];
    case 'node':
      return ['--test-reporter=tap'];
    default:
      return [];
  }
}

function firstJson(text: string): Record<string, unknown> | null {
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    try {
      const v = JSON.parse(text.slice(i)) as Record<string, unknown>;
      if (v && typeof v === 'object') return v;
    } catch {
      // try a trimmed tail: reporters sometimes print a line after the JSON
      const end = text.lastIndexOf('}');
      if (end > i) {
        try {
          const v = JSON.parse(text.slice(i, end + 1)) as Record<string, unknown>;
          if (v && typeof v === 'object') return v;
        } catch {
          /* keep looking */
        }
      }
    }
    if (i > 200_000) break;
  }
  return null;
}

/** Counts from a runner's machine-readable output (jest-style JSON, mocha JSON, TAP). */
export function parseCounts(runner: Runner, stdout: string): TestCounts {
  const none: TestCounts = { passed: 0, failed: 0, skipped: 0, suitesFailed: 0, known: false, failures: [] };
  if (runner === 'vitest' || runner === 'jest') {
    const j = firstJson(stdout);
    if (!j || typeof j.numTotalTests !== 'number') return none;
    const failures: string[] = [];
    for (const tr of (j.testResults as Array<Record<string, unknown>>) ?? []) {
      const file = String(tr.name ?? '');
      for (const a of (tr.assertionResults as Array<Record<string, unknown>>) ?? []) {
        if (a.status === 'failed') failures.push(`${path.basename(file)} > ${String(a.fullName ?? a.title ?? '')}`);
      }
      if (tr.status === 'failed' && !((tr.assertionResults as unknown[]) ?? []).length) failures.push(`${path.basename(file)}: failed to load (${String(tr.message ?? '').split('\n')[0].slice(0, 160)})`);
    }
    return {
      passed: Number(j.numPassedTests ?? 0),
      failed: Number(j.numFailedTests ?? 0),
      skipped: Number(j.numPendingTests ?? 0) + Number(j.numTodoTests ?? 0),
      suitesFailed: Number(j.numFailedTestSuites ?? 0),
      known: true,
      failures,
    };
  }
  if (runner === 'mocha') {
    const j = firstJson(stdout);
    const st = j?.stats as Record<string, number> | undefined;
    if (!st) return none;
    const failures = ((j!.failures as Array<Record<string, unknown>>) ?? []).map((f) => String(f.fullTitle ?? f.title ?? ''));
    return { passed: st.passes ?? 0, failed: st.failures ?? 0, skipped: st.pending ?? 0, suitesFailed: 0, known: true, failures };
  }
  if (runner === 'node') return parseNodeTap(stdout) ?? none;
  return none;
}

/**
 * Counts from node's TAP reporter. With process isolation a test file is
 * itself a result line (named by its path) and a file whose tests were all
 * filtered out still reports `ok`, so file lines and suites are told apart
 * from tests by name and by the `type:` in each result's YAML block.
 */
export function parseNodeTap(stdout: string): TestCounts | null {
  const lines = stdout.split(/\r?\n/);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let fileFails = 0;
  let suiteFails = 0;
  let seen = 0;
  const failures: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(lines[i]);
    if (!m) continue;
    seen++;
    let type = 'test';
    if (lines[i + 1]?.trim() === '---') {
      for (let j = i + 2; j < lines.length && lines[j].trim() !== '...'; j++) {
        const t = /^\s*type:\s*'?(\w+)'?/.exec(lines[j]);
        if (t) type = t[1];
      }
    }
    const name = m[3].trim();
    const ok = m[2] === 'ok';
    const isFile = /\.(?:[cm]?[jt]sx?)$/.test(name) && (/[\\/]/.test(name) || /\.(?:test|spec)\./.test(name));
    if (type === 'suite') {
      if (!ok) suiteFails++;
      continue;
    }
    if (isFile) {
      if (!ok) {
        fileFails++;
        failures.push(`${name}: failed to load or exited with an error`);
      }
      continue;
    }
    if (m[4]) {
      skipped++;
      continue;
    }
    if (ok) passed++;
    else {
      failed++;
      failures.push(name);
    }
  }
  if (!seen) {
    const num = (k: string) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(stdout)?.[1] ?? NaN);
    if (!Number.isFinite(num('pass'))) return null;
    return { passed: num('pass'), failed: num('fail') || 0, skipped: num('skipped') || 0, suitesFailed: 0, known: true, failures: [] };
  }
  const realFailures = failed ? failures.filter((f) => !/: failed to load/.test(f)) : failures;
  return { passed, failed, skipped, suitesFailed: failed ? 0 : fileFails + suiteFails, known: true, failures: realFailures.slice(0, 20) };
}

function testArgv(cmd: ScriptCommand, extra: string[]): ScriptCommand {
  if (cmd.how === 'direct' && cmd.runner === 'node') {
    const i = cmd.argv.indexOf('--test', cmd.toolArgsAt - 1);
    if (i >= 0) return { ...cmd, argv: [...cmd.argv.slice(0, i + 1), ...extra, ...cmd.argv.slice(i + 1)] };
  }
  return { ...cmd, argv: cmd.how === 'direct' ? [...cmd.argv, ...extra] : cmd.argv, env: cmd.env };
}

/** Run the test script with extra runner arguments (inserted where the runner expects them). */
export function runTests(cmd: ScriptCommand, extra: string[], timeoutMs: number, opts: { cwd?: string } = {}): ExecResult {
  const c = testArgv(cmd, extra);
  return runScript(c, cmd.how === 'direct' ? [] : extra, timeoutMs, opts);
}

/** Test files that exist at the base commit. */
export function baseTestFiles(ctx: Pick<GateContext, 'baseEntries'>): string[] {
  return [...ctx.baseEntries.keys()].filter(isTestFile).sort();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The test files in the working tree whose text names a test `<id>: ...`. */
function testFilesNaming(ctx: Pick<GateContext, 'entries' | 'nowText'>, id: string): string[] {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(testNamePattern(id))}`);
  return [...ctx.entries.keys()].filter((f) => isTestFile(f) && re.test(ctx.nowText(f) ?? ''));
}

export function runBaseTests(ctx: GateContext): StepOutcome {
  if (!ctx.basePkg) return skip('no package.json at the base commit (no test script to run)');
  const s = scriptCommand(ctx, 'test');
  if (!s.ok) return s.missing ? skip(`${s.reason}; there are no base tests to run`) : fail([s.reason]);
  const baseFiles = baseTestFiles(ctx);
  const added = ctx.diff.filter((d) => (d.status === 'A' || d.status === 'R' || d.status === 'C') && isTestFile(d.path)).map((d) => d.path);
  const present = baseFiles.filter((f) => ctx.entries.has(f));
  let filters: string[] = [];
  let scope = 'the whole suite';
  if (added.length && present.length) {
    const pkgRel = path.relative(ctx.root, s.cmd.cwd).split(path.sep).join('/');
    const rel = present.map((f) => (pkgRel && f.startsWith(pkgRel + '/') ? f.slice(pkgRel.length + 1) : f));
    const joined = rel.join(' ').length;
    if ((s.cmd.runner === 'vitest' || s.cmd.runner === 'jest') && joined < 24_000) {
      filters = s.cmd.runner === 'jest' ? rel.map((f) => escapeRe(f)) : rel;
      scope = `${present.length} test file(s) that exist at the base commit`;
    } else scope = `the whole suite (the runner cannot be limited to the base commit's ${present.length} test file(s); the ${added.length} new test file(s) ran too)`;
  }
  const r = runTests(s.cmd, [...reporterArgs(s.cmd.runner), ...filters], ctx.timeout('tests'));
  const counts = parseCounts(s.cmd.runner, r.stdout);
  if (r.code === 0 && (!counts.known || counts.failed === 0)) {
    return pass(`\`${s.cmd.display}\` on ${scope}${counts.known ? `: ${counts.passed} passed, ${counts.skipped} skipped` : ''}`);
  }
  const why = counts.known && counts.failures.length ? counts.failures.map((f) => `failing: ${redactText(f).slice(0, 200)}`) : failureLines(r);
  return fail(capReasons([`\`${s.cmd.display}\` on ${scope} exited ${r.timedOut ? 'on timeout' : r.code}${counts.known ? ` (${counts.failed} failed, ${counts.passed} passed)` : ''}`, ...why], 20));
}

// ---------------------------------------------------------------------------
// Acceptance checks
// ---------------------------------------------------------------------------

/** The unit-kind criteria the gate runs as acceptance checks. */
export function unitCriteria(ctx: Pick<GateContext, 'criteria'>): Criterion[] {
  return ctx.criteria.filter((c) => c.check?.kind === 'unit' || (!c.check && c.kind === 'unit'));
}

/** The name prefix a criterion's test carries (`AC1:`; see src/intake/classify.ts testCommand). */
export function testNamePattern(id: string): string {
  return `${id}:`;
}

export function acceptanceOutcome(ctx: GateContext, c: Criterion): StepOutcome {
  const proof = c.check?.redProof;
  const short = ctx.base === EMPTY_TREE ? 'the empty tree' : ctx.base.slice(0, 10);
  const problems: string[] = [];
  const greenAtBase = c.check?.greenAtBase === true;
  if (greenAtBase) {
    // must keep passing: no red proof is asked for, whatever redProof holds; but a test has to be there to keep passing
    if (!testFilesNaming(ctx, c.id).length) problems.push(`${c.id}: no test names ${c.id} (a green-at-base check still needs a test file with a test named "${testNamePattern(c.id)} ...")`);
  } else if (!proof) problems.push(`${c.id} was never proven red at the base commit ${short}; write the test first, then run \`harness gate prove-red\``);
  else if (proof.baseSha !== ctx.base) problems.push(`${c.id} was proven against ${proof.baseSha.slice(0, 10)}, not the base commit ${short}; run \`harness gate prove-red\` again`);
  else if (proof.result === 'green') problems.push(`${c.id} passed at the base commit, so it does not show the change works; make the test fail without the change, then run \`harness gate prove-red\``);
  else if (proof.result === 'missing') problems.push(`${c.id}: no test named "${testNamePattern(c.id)} ..." was found when proving red; name the test with the criterion id`);
  else if (proof.result !== 'red') problems.push(`${c.id}: proving red did not complete (${proof.result}); run \`harness gate prove-red\` again`);
  const s = scriptCommand(ctx, 'test');
  if (!s.ok) return fail([...problems, `${c.id}: ${s.reason}`]);
  const filter = nameFilterArgs(s.cmd.runner, testNamePattern(c.id));
  if (!filter) return fail([...problems, `${c.id}: the test runner of \`${s.cmd.display}\` cannot select a test by name, so the acceptance check cannot run on its own`]);
  const r = runTests(s.cmd, [...reporterArgs(s.cmd.runner), ...filter], ctx.timeout('acceptance'));
  const counts = parseCounts(s.cmd.runner, r.stdout);
  if (counts.known && counts.passed + counts.failed === 0) problems.push(`${c.id}: no test named "${testNamePattern(c.id)} ..." ran`);
  else if (r.code !== 0 || counts.failed > 0) {
    problems.push(`${c.id}: the acceptance test fails${counts.known ? ` (${counts.failed} failed)` : ` (exit ${r.timedOut ? 'timeout' : r.code})`}`);
    problems.push(...(counts.failures.length ? counts.failures.map((f) => `failing: ${redactText(f).slice(0, 200)}`) : failureLines(r, 8)));
  }
  if (problems.length) return fail(capReasons(problems, 12));
  if (greenAtBase) return pass(`${counts.known ? `${counts.passed} test(s)` : 'the test'} named "${testNamePattern(c.id)} ..." passed (green-at-base: ${c.check?.greenAtBaseReason ?? 'it must keep passing'})`);
  return pass(`${counts.known ? `${counts.passed} test(s)` : 'the test'} named "${testNamePattern(c.id)} ..." passed; proven red at ${proof!.baseSha.slice(0, 10)}`);
}

export function acceptanceSteps(ctx: GateContext): StepDef[] {
  const crits = unitCriteria(ctx);
  if (!crits.length && gateCriteria(ctx).length) return [];
  if (!crits.length) {
    const why = ctx.brief ? 'the brief has no unit-kind acceptance checks for this repository' : 'no brief for this task (run `harness intake` or `harness task claim` to get acceptance checks)';
    return [{ name: 'acceptance', design: 5, group: 'tests', cacheFail: false, inputs: () => null, run: () => skip(why) }];
  }
  return crits.map((c) => ({
    name: `acceptance:${c.id}`,
    design: 5,
    group: 'tests',
    cacheFail: false,
    after: ['build'],
    inputs: (x: GateContext) => [x.tree, JSON.stringify(c.check?.redProof ?? null)],
    run: (x: GateContext) => acceptanceOutcome(x, c),
  }));
}

export const baseTestsStep: StepDef = { name: 'tests:base', design: 5, group: 'tests', cacheFail: false, after: ['build'], inputs: (ctx) => [ctx.tree], run: runBaseTests };

// ---------------------------------------------------------------------------
// prove-red
// ---------------------------------------------------------------------------

export interface RedResult {
  criterion: string;
  proof: RedProof;
  detail: string;
  /** The check is green-at-base: it must pass at the base commit, so a green run is the expected result. */
  greenAtBase?: boolean;
}

/** Whether a prove-red result is what the criterion's check expects: red for a red-first check; green (or red, which is only noted) for a green-at-base check. */
export function proofAsExpected(r: Pick<RedResult, 'proof' | 'greenAtBase'>): boolean {
  if (r.greenAtBase) return r.proof.result === 'green' || r.proof.result === 'red';
  return r.proof.result === 'red';
}

/** Run every unit acceptance check against a temporary checkout of the base commit and record the result in the brief. */
/** A gate-proved check has nothing to run at the base commit: the gate's own steps prove it. */
export interface GateProved {
  criterion: string;
  detail: string;
}

export function proveRed(ctx: GateContext): { results: RedResult[]; error?: string; note?: string; gate: GateProved[] } {
  const crits = unitCriteria(ctx);
  const gate: GateProved[] = gateCriteria(ctx).map((c) => ({ criterion: c.id, detail: `proved by the gate's own steps (${gateWhat(c.check!)}); nothing to run at the base commit` }));
  if (!ctx.brief) return { results: [], gate, error: 'no brief for this task (run `harness intake` or `harness task claim` first)' };
  if (!crits.length) {
    // Not an error: a brief of api/db checks has nothing to run at the base commit; its checks are red until verify records artefacts.
    const e2e = ctx.criteria.filter((c) => c.check && (c.check.kind === 'e2e-http' || c.check.kind === 'e2e-db')).map((c) => c.id);
    return {
      results: [],
      gate,
      note: `the brief has no unit checks for this repository, so there is nothing to run at the base commit${e2e.length ? `; its end-to-end checks (${e2e.join(', ')}) count only from \`harness verify\` artefacts recorded on the changed code, so they are red until then` : ''}. Unit tests you add still run in the gate's test step.`,
    };
  }
  if (ctx.base === EMPTY_TREE) return { results: [], gate, error: 'the base is the empty tree (no commits yet); there is nothing to prove red against' };
  const s = scriptCommand(ctx, 'test');
  if (!s.ok) return { results: [], gate, error: s.reason };
  const testFiles = ctx.diff.filter((d) => d.status !== 'D' && isTestFile(d.path)).map((d) => d.path);
  const overlay = new Map<string, string>();
  for (const f of testFiles) {
    const text = ctx.nowText(f);
    if (text !== null) overlay.set(f, text);
  }
  const at = new Date().toISOString();
  const pkgRel = path.relative(ctx.root, s.cmd.cwd);
  const co = withBaseCheckout(ctx.root, ctx.base, overlay, (wt) => {
    const out: RedResult[] = [];
    for (const c of crits) {
      const pattern = testNamePattern(c.id);
      const mentions = testFiles.filter((f) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(pattern)}`).test(ctx.nowText(f) ?? ''));
      const filter = nameFilterArgs(s.cmd.runner, pattern);
      let proof: RedProof;
      let detail: string;
      if (!mentions.length) {
        proof = { baseSha: ctx.base, at, result: 'missing', files: [], exitCode: null };
        detail = `no changed test file names a test "${pattern} ..."`;
      } else if (!filter) {
        proof = { baseSha: ctx.base, at, result: 'error', files: mentions, exitCode: null };
        detail = 'the test runner cannot select a test by name';
      } else {
        const r = runTests(s.cmd, [...reporterArgs(s.cmd.runner), ...filter], ctx.timeout('acceptance'), { cwd: path.join(wt, pkgRel) });
        const counts = parseCounts(s.cmd.runner, r.stdout);
        let result: RedProof['result'];
        if (r.timedOut || r.code === null || r.code < 0) result = 'error';
        else if (r.code !== 0 && (!counts.known || counts.failed > 0 || counts.suitesFailed > 0)) result = 'red';
        else if (r.code === 0 && counts.known && counts.passed === 0) result = 'missing';
        else if (r.code === 0) result = 'green';
        else result = 'error';
        proof = { baseSha: ctx.base, at, result, files: mentions, exitCode: r.code };
        detail =
          result === 'red' && c.check?.greenAtBase
            ? 'fails at the base commit although the check is green-at-base; it only has to pass after the change, but check that it really describes existing behaviour'
            : result === 'green' && c.check?.greenAtBase
              ? `passes at the base commit (${counts.passed} passed), as expected: green-at-base${c.check.greenAtBaseReason ? ` (${c.check.greenAtBaseReason})` : ''}`
              : result === 'red'
            ? `fails at the base commit${counts.known ? ` (${counts.failed} failed${counts.suitesFailed ? `, ${counts.suitesFailed} file(s) did not load` : ''})` : ''}: proven red`
            : result === 'green'
              ? `passes at the base commit (${counts.passed} passed): not red, so it does not prove the change`
              : result === 'missing'
                ? 'no test with that name ran at the base commit'
                : `could not run (${r.timedOut ? 'timeout' : `exit ${r.code}`})`;
      }
      out.push({ criterion: c.id, proof, detail, ...(c.check?.greenAtBase ? { greenAtBase: true } : {}) });
    }
    return out;
  });
  if (!co.ok) return { results: [], gate, error: co.error };
  const results = co.value;
  // Record in the brief (re-read so a concurrent intake answer is not lost).
  const brief = loadBrief(ctx.brief.id);
  if (brief) {
    for (const r of results) {
      const c = brief.criteria.find((x) => x.id === r.criterion);
      if (!c) continue;
      const base = c.check ?? { kind: 'unit' as const, description: `Unit test named "${c.id}: ..."` };
      // a green-at-base check keeps its flags; it was never red-first
      c.check = base.greenAtBase ? { ...base, redProof: r.proof } : { ...base, redFirst: r.proof.result === 'red', redProof: r.proof };
    }
    brief.updatedAt = new Date().toISOString();
    saveBrief(brief);
  }
  return { results, gate };
}
