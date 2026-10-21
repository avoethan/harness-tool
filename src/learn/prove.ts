/**
 * Proof (DESIGN 2.9, R-35): an enforcer counts only when it fails on the
 * original mistake.
 *
 *   ast-grep rule    `ast-grep test` with the mistake as the `invalid` case (and
 *                    the valid samples as `valid`): "Missing" fails the proof
 *   regex rule       the violating pattern matches every invalid sample and no valid one
 *   ESLint rule      the repository's own ESLint, on the sample through --stdin,
 *                    reports the rule on the invalid samples and not on the valid ones
 *   regression test  red on the commit before the fix (the test files from the
 *                    fix overlaid in a temporary worktree), green on the fix
 *   gate step / the same check the gate ran
 *                    the gate.fail events of the class: the step (or rule) failed
 *                    on the original mistake when it happened
 *   prose            not provable by the harness (with/without agent runs are
 *                    not run); the lesson stays proposed with that reason
 *
 * Samples come from `--fixture <file>` (the user's copy of the mistake), the
 * judgment pass, or the probe library's own invalid cases, in that order;
 * the proof records which.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ledger } from '../types';
import type { CheckSpec } from '../discover/checks';
import { findAstGrep, runSgTest, type AstGrepBinary } from '../discover/astgrep';
import { resolveRepoBin } from '../discover/declared';
import { run } from '../lib/exec';
import { rawGit } from '../lib/git';
import { scriptCommand } from '../gate/scripts';
import { runTests } from '../gate/tests';
import { withBaseCheckout } from '../gate/checkout';
import { parseKey } from './classes';
import { loadSpecFor } from './ladder';
import type { Occurrence } from './capture';
import type { EnforcerPlan, FixtureSource, LessonRecord, ProofRecord } from './store';

export interface ProveOptions {
  /** A file holding the original mistake (an invalid sample). */
  fixture?: string;
  /** Repository root for an ESLint proof (else the lesson's repos from the config). */
  repo?: string;
  /** ast-grep binary; undefined finds it, null means absent. */
  ast?: AstGrepBinary | null;
  ledger?: Ledger | null;
  checksDir?: string;
  /** Occurrences of the class (gate-event proof). */
  occurrences?: Occurrence[];
  timeoutMs?: number;
  now?: Date;
}

type Samples = { valid: string[]; invalid: string[]; source: FixtureSource; ext?: string };

function samplesFor(p: EnforcerPlan, opts: ProveOptions): Samples | null {
  if (opts.fixture) {
    const text = fs.readFileSync(opts.fixture, 'utf8');
    return { valid: p.fixtures?.valid ?? [], invalid: [text], source: 'user', ext: path.extname(opts.fixture).slice(1) || undefined };
  }
  if (p.fixtures && p.fixtures.invalid.length) return { valid: p.fixtures.valid, invalid: p.fixtures.invalid, source: p.fixtures.source, ext: p.fixtures.ext };
  return null;
}

/** The check spec the proof runs: the learned check's, or the discovered record's for an existing one. */
function specFor(lesson: LessonRecord, opts: ProveOptions): CheckSpec | null {
  const p = lesson.proposal!;
  if (p.check) return { version: 1, id: p.check.id, engine: p.check.engine, mode: 'block', statement: p.check.statement, fixText: p.check.fixText, scope: p.check.scope, ...(p.check.spec as Partial<CheckSpec>) } as CheckSpec;
  if (p.ref.startsWith('ledger:') && opts.ledger && opts.checksDir) {
    const rec = opts.ledger.records.find((r) => r.id === p.ref.slice('ledger:'.length));
    return rec ? loadSpecFor(opts.checksDir, rec) : null;
  }
  return null;
}

function result(at: string, r: ProofRecord['result'], method: ProofRecord['method'], detail: string, extra: Partial<ProofRecord> = {}): ProofRecord {
  return { at, result: r, method, detail: detail.slice(0, 600), ...extra };
}

/** Proof by the gate's own report: the class's gate.fail occurrences. */
export function gateEventProof(lesson: LessonRecord, occ: Occurrence[], at: string, what: string): ProofRecord {
  const fails = occ.filter((o) => o.event === 'gate.fail');
  if (!fails.length) return result(at, 'not-proven', 'gate-event', `no gate failure of this class is in the log, so there is no record of ${what} failing on the mistake; give a sample with --fixture <file>`);
  return result(at, 'proven', 'gate-event', `${what} failed on the original mistake ${fails.length} time(s) (first: event ${fails[0].eventId} at ${fails[0].ts})`, { fixtureSource: 'gate-event', counts: { gateFails: fails.length } });
}

export function astGrepProof(spec: CheckSpec, s: Samples, bin: AstGrepBinary | null, at: string): ProofRecord {
  if (!bin) return result(at, 'not-proven', 'ast-grep-test', 'ast-grep is not installed (npm install in the harness folder adds it); the rule cannot be proven here');
  const rules = (spec.rules ?? []).filter((r) => String(r.language ?? 'TypeScript') === 'TypeScript');
  if (!rules.length) return result(at, 'not-proven', 'ast-grep-test', 'the check has no TypeScript rule to test');
  // Every invalid sample must be matched by at least one rule: test each rule, then each sample against the union.
  let matched = 0;
  const per: string[] = [];
  for (const sample of s.invalid) {
    let hit = false;
    for (const r of rules) {
      const t = runSgTest(bin, [r], [{ id: String(r.id), valid: [''], invalid: [sample] }]);
      if (t.ran && t.failed === 0) {
        hit = true;
        break;
      }
    }
    if (hit) matched++;
    else per.push('an invalid sample was not reported (ast-grep: Missing)');
  }
  let noisy = 0;
  for (const sample of s.valid) {
    for (const r of rules) {
      const t = runSgTest(bin, [r], [{ id: String(r.id), valid: [sample], invalid: [] }]);
      if (!t.ran || t.failed) {
        noisy++;
        break;
      }
    }
  }
  const counts = { invalid: s.invalid.length, reported: matched, valid: s.valid.length, noisy };
  if (matched === s.invalid.length && noisy === 0) {
    return result(at, 'proven', 'ast-grep-test', `ast-grep test: the rule reports all ${matched} sample(s) of the mistake and none of ${s.valid.length} valid sample(s)`, { fixtureSource: s.source, counts });
  }
  return result(at, 'not-proven', 'ast-grep-test', `ast-grep test: ${matched} of ${s.invalid.length} mistake sample(s) reported, ${noisy} valid sample(s) wrongly reported${per.length ? `; ${per[0]}` : ''}`, { fixtureSource: s.source, counts });
}

export function regexProof(spec: CheckSpec, s: Samples, at: string): ProofRecord {
  const pats = spec.violate ?? [];
  if (!pats.length) return result(at, 'not-proven', 'regex-fixture', 'the check has no violating pattern');
  let res: RegExp[];
  try {
    res = pats.map((p) => new RegExp(p, (spec.flags ?? '').replace(/g/g, '')));
  } catch (e) {
    return result(at, 'error', 'regex-fixture', `pattern does not compile: ${(e as Error).message}`);
  }
  const hits = s.invalid.filter((x) => res.some((r) => r.test(x))).length;
  const noisy = s.valid.filter((x) => res.some((r) => r.test(x))).length;
  const counts = { invalid: s.invalid.length, reported: hits, valid: s.valid.length, noisy };
  if (hits === s.invalid.length && noisy === 0) return result(at, 'proven', 'regex-fixture', `the pattern matches all ${hits} sample(s) of the mistake and none of ${s.valid.length} valid sample(s)`, { fixtureSource: s.source, counts });
  return result(at, 'not-proven', 'regex-fixture', `${hits} of ${s.invalid.length} mistake sample(s) matched, ${noisy} valid sample(s) matched`, { fixtureSource: s.source, counts });
}

/** Run the repository's own ESLint on samples through --stdin and count the rule's messages. */
export function eslintProof(repoRoot: string, rule: string, s: Samples, at: string, timeoutMs = 60_000): ProofRecord {
  const bin = resolveRepoBin(repoRoot, 'eslint', 'eslint');
  if (!bin) return result(at, 'not-proven', 'eslint-fixture', `ESLint is not installed in ${repoRoot} (the harness never installs it); the rule cannot be proven here`);
  const ext = s.ext && /^[cm]?[jt]sx?$/.test(s.ext) ? s.ext : 'ts';
  const stdinName = path.join(repoRoot, `harness-learn-sample.${ext}`);
  const count = (text: string): number | null => {
    const r = run(process.execPath, [bin, '--format', 'json', '--stdin', '--stdin-filename', stdinName], { cwd: repoRoot, input: text, timeoutMs });
    try {
      const out = JSON.parse(r.stdout) as Array<{ messages?: Array<{ ruleId?: string | null }> }>;
      return out.reduce((n, f) => n + (f.messages ?? []).filter((m) => m.ruleId === rule).length, 0);
    } catch {
      return null;
    }
  };
  let reported = 0;
  let noisy = 0;
  for (const x of s.invalid) {
    const n = count(x);
    if (n === null) return result(at, 'error', 'eslint-fixture', 'ESLint did not return JSON for the sample');
    if (n > 0) reported++;
  }
  for (const x of s.valid) {
    const n = count(x);
    if (n === null) return result(at, 'error', 'eslint-fixture', 'ESLint did not return JSON for the sample');
    if (n > 0) noisy++;
  }
  const counts = { invalid: s.invalid.length, reported, valid: s.valid.length, noisy };
  if (reported === s.invalid.length && noisy === 0) return result(at, 'proven', 'eslint-fixture', `the repository's ESLint reports ${rule} on all ${reported} sample(s) of the mistake and on none of ${s.valid.length} valid sample(s)`, { fixtureSource: s.source, counts });
  return result(at, 'not-proven', 'eslint-fixture', `ESLint reported ${rule} on ${reported} of ${s.invalid.length} mistake sample(s) and on ${noisy} valid sample(s)`, { fixtureSource: s.source, counts });
}

function gitShow(root: string, rev: string, rel: string): string | null {
  const r = rawGit(root, ['show', `${rev}:${rel}`], 30_000);
  return r.code === 0 ? r.stdout : null;
}

function pmOf(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** Regression proof: the test is red on the commit before the fix and green on the fix. */
export function regressionProof(test: NonNullable<EnforcerPlan['test']>, at: string, timeoutMs = 300_000): ProofRecord {
  const root = test.repo;
  const show = (rel: string) => gitShow(root, test.fix, rel);
  const s = scriptCommand({ root, baseText: show, nowText: show, pm: pmOf(root) }, 'test');
  if (!s.ok) return result(at, 'not-proven', 'regression', `no test command at the fix commit: ${s.reason}`);
  const pkgRel = path.relative(root, s.cmd.cwd);
  const overlay = new Map<string, string>();
  for (const f of test.files) {
    const text = show(f);
    if (text === null) return result(at, 'not-proven', 'regression', `${f} is not in the fix commit`);
    overlay.set(f, text);
  }
  const runAt = (rev: string, ov: Map<string, string>) => withBaseCheckout(root, rev, ov, (wt) => runTests(s.cmd, test.files, timeoutMs, { cwd: path.join(wt, pkgRel) }));
  const red = runAt(test.preFix, overlay);
  if (!red.ok) return result(at, 'error', 'regression', red.error);
  const green = runAt(test.fix, new Map());
  if (!green.ok) return result(at, 'error', 'regression', green.error);
  const r = red.value;
  const g = green.value;
  const counts = { preFixExit: r.code ?? -1, fixExit: g.code ?? -1 };
  if (r.timedOut || g.timedOut) return result(at, 'error', 'regression', 'the test timed out', { counts, fixtureSource: 'commits' });
  if (r.code !== 0 && g.code === 0) return result(at, 'proven', 'regression', `${test.files.join(', ')}: red on ${test.preFix.slice(0, 12)} (exit ${r.code}), green on ${test.fix.slice(0, 12)}`, { counts, fixtureSource: 'commits' });
  return result(at, 'not-proven', 'regression', `${test.files.join(', ')}: ${r.code === 0 ? 'passes' : 'fails'} on the commit before the fix and ${g.code === 0 ? 'passes' : 'fails'} on the fix; a regression test must fail before and pass after`, { counts, fixtureSource: 'commits' });
}

/** Prove a lesson's proposed enforcer. Does not change the record (the caller saves it). */
export function proveLesson(lesson: LessonRecord, opts: ProveOptions = {}): ProofRecord {
  const at = (opts.now ?? new Date()).toISOString();
  const p = lesson.proposal;
  if (!p) {
    const nj = lesson.needsJudgment;
    return result(at, 'not-proven', 'none', nj ? `no enforcer yet: waiting for the judgment pass${nj.bundle ? ` (bundle ${nj.bundle}; then harness learn --import-judgment ${nj.bundle})` : ''}` : 'no enforcer proposed');
  }
  if (p.source === 'rail') return result(at, 'not-proven', 'none', 'a safety rail: tier 2 lessons are listed for the user and never proven or applied by the harness');
  if (p.rung === 'skill' || p.rung === 'instruction') return result(at, 'unprovable', 'prose', 'prose cannot be proven by a check; the proof would need agent runs with and without the text (not run by the harness)');
  if (p.rung === 'test' && p.test) return regressionProof(p.test, at, opts.timeoutMs);
  const occ = opts.occurrences ?? [];
  if (p.source === 'gate-step') return gateEventProof(lesson, occ, at, `the gate's ${parseKey(lesson.key).subject} step`);
  if (p.ref.startsWith('eslint:')) {
    const s = samplesFor(p, opts);
    const repo = opts.repo;
    if (!s) return result(at, 'not-proven', 'eslint-fixture', 'no sample of the mistake: give one with --fixture <file>');
    if (!repo) return result(at, 'not-proven', 'eslint-fixture', 'an ESLint proof needs the repository: --repo <path>');
    return eslintProof(repo, p.ref.slice('eslint:'.length), s, at, opts.timeoutMs);
  }
  const spec = specFor(lesson, opts);
  if (!spec) return result(at, 'not-proven', 'none', 'the check spec is missing (run harness discover, then harness learn --scan)');
  const s = samplesFor(p, opts);
  if (spec.engine === 'ast-grep' && s) return astGrepProof(spec, s, opts.ast === undefined ? findAstGrep() : opts.ast, at);
  if (spec.engine === 'regex' && (spec.target === 'match' || spec.target === 'content') && s) return regexProof(spec, s, at);
  // No runnable sample: the same check reported the original mistake at the gate.
  return gateEventProof(lesson, occ, at, `the check ${spec.id}`);
}
