import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion } from '../../../src/types';
import { buildContext } from '../../../src/gate/context';
import { nameFilterArgs, parseCounts, proveRed, acceptanceOutcome, unitCriteria, runBaseTests } from '../../../src/gate/tests';
import { runnerOf, scriptCommand, tokenizeScript } from '../../../src/gate/scripts';
import { runGate } from '../../../src/gate';
import { loadBrief } from '../../../src/intake/brief';
import { main as gateMain } from '../../../src/commands/gate';
import { capture } from '../commands/capture';
import { commitAll, demoRepo, gitRepo, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-tests-');
});
after(() => h.cleanup());

test('script bodies: simple ones become argv, shell ones do not', () => {
  assert.deepEqual(tokenizeScript('vitest run'), { env: {}, tokens: ['vitest', 'run'] });
  assert.deepEqual(tokenizeScript('NODE_ENV=test node --test "test/a b.test.js"'), { env: { NODE_ENV: 'test' }, tokens: ['node', '--test', 'test/a b.test.js'] });
  assert.deepEqual(tokenizeScript("cross-env CI=1 jest --runInBand"), { env: { CI: '1' }, tokens: ['jest', '--runInBand'] });
  assert.equal(tokenizeScript('npm run build && npm test'), null);
  assert.equal(tokenizeScript('tsc | tee out'), null);
  assert.equal(tokenizeScript('echo $HOME'), null);
  assert.equal(tokenizeScript('mocha > out.txt'), null);
  assert.equal(runnerOf(['c8', '--reporter', 'json', 'vitest', 'run']), 'vitest');
  assert.equal(runnerOf(['node', '--test']), 'node');
  assert.equal(runnerOf(['node', 'scripts/test.js']), 'unknown');
  assert.deepEqual(nameFilterArgs('vitest', 'AC1:'), ['-t', 'AC1:']);
  assert.deepEqual(nameFilterArgs('node', 'AC1:'), ['--test-name-pattern', 'AC1:']);
  assert.equal(nameFilterArgs('unknown', 'AC1:'), null);
});

test('scripts come from the base commit; a changed shell script is refused', () => {
  const r = gitRepo(path.join(h.workspace, `s${++n}`), { 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test', lint: 'node a.js && node b.js', check: 'npm run test' } }) });
  put(r, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'echo skipped', lint: 'true', check: 'npm run test' } }));
  const ctx = buildContext({ repo: r });
  const t = scriptCommand(ctx, 'test');
  assert.ok(t.ok && t.cmd.how === 'direct' && t.cmd.argv[0] === process.execPath && t.cmd.argv.includes('--test'), 'the base body runs, not the edited one');
  const c = scriptCommand(ctx, 'check');
  assert.ok(c.ok && c.cmd.argv.includes('--test'), 'npm run <x> inside a script is followed within the package');
  const l = scriptCommand(ctx, 'lint');
  assert.ok(!l.ok && /changed since the base commit/.test(l.reason));
  const m = scriptCommand(ctx, 'build');
  assert.ok(!m.ok && m.missing);
});

test('runner output parsing: jest/vitest JSON, mocha JSON, node TAP', () => {
  const vit = JSON.stringify({ numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numFailedTestSuites: 1, testResults: [{ name: '/r/test/a.test.ts', status: 'failed', assertionResults: [{ fullName: 'AC1: works', status: 'failed' }] }] });
  const v = parseCounts('vitest', `some log line {not json}\n${vit}\n`);
  assert.deepEqual({ ...v }, { passed: 1, failed: 1, skipped: 1, suitesFailed: 1, known: true, failures: ['a.test.ts > AC1: works'] });
  const m = parseCounts('mocha', JSON.stringify({ stats: { passes: 4, failures: 0, pending: 1 }, failures: [] }));
  assert.equal(m.passed, 4);
  assert.equal(m.known, true);
  const tap = 'TAP version 13\nnot ok 1 - AC1: multiplies\n1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n';
  const nt = parseCounts('node', tap);
  assert.deepEqual([nt.passed, nt.failed, nt.known, nt.failures[0]], [0, 1, true, 'AC1: multiplies']);
  assert.equal(parseCounts('unknown', 'whatever').known, false);
});

const AC1: Criterion = { id: 'AC1', text: 'mul multiplies', kind: 'unit', check: { kind: 'unit', description: 'Unit test named "AC1: ..."', redFirst: true } };
const AC2: Criterion = { id: 'AC2', text: 'add still adds', kind: 'unit', check: { kind: 'unit', description: 'Unit test named "AC2: ..."', redFirst: true } };

test('acceptance checks: FAIL until proven red, prove-red records redProof in the brief, PASS after the change; a check green at the base is refused', async () => {
  const r = demoRepo(path.join(h.workspace, `a${++n}`));
  const task = `t-acc-${n}`;
  writeBrief(r, task, [AC1, AC2]);
  // Tests phase: the agent writes the checks first.
  put(r, 'test/mul.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('AC1: mul multiplies', () => {\n  const { mul } = require('../src/mul');\n  assert.equal(mul(2, 3), 6);\n});\n");
  put(r, 'test/add2.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add');\ntest('AC2: add still adds', () => {\n  assert.equal(add(2, 3), 5);\n});\n");
  let ctx = buildContext({ repo: r });
  assert.deepEqual(unitCriteria(ctx).map((c) => c.id), ['AC1', 'AC2']);
  const before1 = acceptanceOutcome(ctx, ctx.criteria[0]);
  assert.equal(before1.status, 'fail');
  assert.match(before1.reasons[0], /AC1 was never proven red at the base commit/);

  const out = await capture(() => gateMain(['prove-red', '--repo', r]));
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /RED\s+AC1\s+fails at the base commit/);
  assert.match(out.stdout, /NOT\s+AC2\s+passes at the base commit/);
  const brief = loadBrief(task)!;
  const c1 = brief.criteria.find((c) => c.id === 'AC1')!;
  assert.equal(c1.check?.redFirst, true);
  assert.equal(c1.check?.redProof?.result, 'red');
  assert.deepEqual(c1.check?.redProof?.files, ['test/mul.test.js']);
  assert.equal(brief.criteria.find((c) => c.id === 'AC2')!.check?.redProof?.result, 'green');
  assert.equal(fs.readdirSync(path.join(r)).includes('base'), false, 'the base checkout lived outside the repo');

  // Implement; the gate passes AC1 and refuses AC2 (green at the base).
  put(r, 'src/mul.js', 'exports.mul = (a, b) => a * b;\n');
  const run = await runGate({ repo: r });
  const steps = Object.fromEntries(run.evidence.steps.map((s) => [s.name, s]));
  assert.equal(steps['acceptance:AC1'].status, 'pass', JSON.stringify(steps['acceptance:AC1']));
  assert.equal(steps['acceptance:AC2'].status, 'fail');
  assert.match(steps['acceptance:AC2'].reasons![0], /AC2 passed at the base commit, so it does not show the change works/);
  assert.equal(steps['tests:base'].status, 'pass');
  assert.match(steps['tests:base'].reasons![0], /whole suite/);
  assert.equal(run.evidence.verdict, 'FAIL');

  // A criterion whose test is missing: "no test named" after proving.
  ctx = buildContext({ repo: r });
  const fake = { ...AC1, id: 'AC9', check: { ...AC1.check!, redProof: { baseSha: ctx.base, at: '', result: 'red' as const, files: [], exitCode: 1 } } };
  const miss = acceptanceOutcome(ctx, fake);
  assert.equal(miss.status, 'fail');
  assert.match(miss.reasons.join('\n'), /no test named "AC9: \.\.\." ran/);
});

test('prove-red on a brief of end-to-end checks only: nothing to run at the base, exit 0 with the reason (integration run: it exited 2 as a usage error)', async () => {
  const r = demoRepo(path.join(h.workspace, `e${++n}`));
  const task = `t-e2e-${n}`;
  const api: Criterion = { id: 'AC1', text: 'GET /products/low-stock answers 200', kind: 'api', check: { kind: 'e2e-http', description: 'GET /products/low-stock -> 200', command: 'harness verify drive --method GET --path /products/low-stock --expect-status 200 --criterion AC1', redFirst: true } };
  writeBrief(r, task, [api]);
  const out = await capture(() => gateMain(['prove-red', '--repo', r, '--task', task]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /no unit checks for this repository, so there is nothing to run at the base commit; its end-to-end checks \(AC1\) count only from `harness verify` artefacts/);
  assert.match(out.stdout, /Now implement/);
});

test('base tests: a failing base test FAILs and names the test; prove-red without a brief says what to do', async () => {
  const r = demoRepo(path.join(h.workspace, `b${++n}`));
  commitAll(r, 'x');
  put(r, 'src/add.js', 'exports.add = (a, b) => a - b;\n');
  const out = runBaseTests(buildContext({ repo: r, task: 'nobrief' }));
  assert.equal(out.status, 'fail');
  assert.match(out.reasons.join('\n'), /failing: adds/);
  const pr = await capture(() => gateMain(['prove-red', '--repo', r, '--task', 'nobrief']));
  assert.equal(pr.code, 2);
  assert.match(pr.stderr, /no brief for this task/);
});
