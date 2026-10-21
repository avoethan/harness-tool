import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { Criterion } from '../../../src/types';
import { buildContext } from '../../../src/gate/context';
import { acceptanceOutcome, proofAsExpected } from '../../../src/gate/tests';
import { runGate } from '../../../src/gate';
import { loadBrief } from '../../../src/intake/brief';
import { main as gateMain } from '../../../src/commands/gate';
import { capture } from '../commands/capture';
import { demoRepo, gitRepo, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-gab-');
});
after(() => h.cleanup());

const REASON = 'characterisation: it passes before the change and must keep passing';
const AC1: Criterion = { id: 'AC1', text: 'add still adds', kind: 'unit', check: { kind: 'unit', description: 'Unit test named "AC1: ..."', redFirst: false, greenAtBase: true, greenAtBaseReason: REASON } };
const AC2: Criterion = { id: 'AC2', text: 'mul multiplies', kind: 'unit', check: { kind: 'unit', description: 'Unit test named "AC2: ..."', redFirst: true } };

const ADD_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add');\ntest('AC1: add still adds', () => {\n  assert.equal(add(2, 3), 5);\n});\n";
const MUL_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('AC2: mul multiplies', () => {\n  const { mul } = require('../src/mul');\n  assert.equal(mul(2, 3), 6);\n});\n";

test('prove-red: a green result on a green-at-base check is expected (exit 0), a red-first check still has to be red', async () => {
  const r = demoRepo(path.join(h.workspace, `g${++n}`));
  const task = `t-gab-${n}`;
  writeBrief(r, task, [AC1, AC2]);
  put(r, 'test/add2.test.js', ADD_TEST);
  put(r, 'test/mul.test.js', MUL_TEST);

  const out = await capture(() => gateMain(['prove-red', '--repo', r]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /BASE\s+AC1\s+passes at the base commit .*as expected: green-at-base/);
  assert.match(out.stdout, /RED\s+AC2\s+fails at the base commit/);
  assert.match(out.stdout, /1 proven red, 1 green-at-base/);

  const brief = loadBrief(task)!;
  const c1 = brief.criteria.find((c) => c.id === 'AC1')!;
  assert.equal(c1.check?.redProof?.result, 'green');
  assert.equal(c1.check?.greenAtBase, true, 'the flag survives prove-red');
  assert.equal(c1.check?.redFirst, false);
  assert.equal(brief.criteria.find((c) => c.id === 'AC2')!.check?.redProof?.result, 'red');

  const json = await capture(() => gateMain(['prove-red', '--repo', r, '--json']));
  const res = JSON.parse(json.stdout).results as Array<{ criterion: string; greenAtBase?: boolean; proof: { result: string } }>;
  assert.deepEqual(res.map((x) => [x.criterion, x.proof.result, x.greenAtBase === true]), [['AC1', 'green', true], ['AC2', 'red', false]]);
});

test('prove-red: a red-first check that passes at the base still fails the command', async () => {
  const r = demoRepo(path.join(h.workspace, `g${++n}`));
  writeBrief(r, `t-gab-${n}`, [{ ...AC1, check: { kind: 'unit', description: 'Unit test named "AC1: ..."', redFirst: true } }]);
  put(r, 'test/add2.test.js', ADD_TEST);
  const out = await capture(() => gateMain(['prove-red', '--repo', r]));
  assert.equal(out.code, 1);
  assert.match(out.stdout, /NOT\s+AC1\s+passes at the base commit/);
  assert.equal(proofAsExpected({ proof: { baseSha: '', at: '', result: 'green', files: [], exitCode: 0 } }), false);
  assert.equal(proofAsExpected({ proof: { baseSha: '', at: '', result: 'green', files: [], exitCode: 0 }, greenAtBase: true }), true);
  assert.equal(proofAsExpected({ proof: { baseSha: '', at: '', result: 'missing', files: [], exitCode: null }, greenAtBase: true }), false);
});

test('acceptance step: a green-at-base check needs only a test that exists and passes now, with or without a red proof', async () => {
  const r = demoRepo(path.join(h.workspace, `g${++n}`));
  writeBrief(r, `t-gab-${n}`, [AC1]);
  put(r, 'test/add2.test.js', ADD_TEST);
  // never proven: the red-first rule does not apply
  let ctx = buildContext({ repo: r });
  const o = acceptanceOutcome(ctx, ctx.criteria[0]);
  assert.equal(o.status, 'pass', JSON.stringify(o));
  assert.match(o.reasons[0], /green-at-base: characterisation/);
  // proven "green" at the base: still a pass (a red-first check is refused here)
  const run = await runGate({ repo: r, steps: ['acceptance'] });
  assert.equal(run.evidence.steps.find((s) => s.name === 'acceptance:AC1')?.status, 'pass');
  const red = { ...ctx.criteria[0], check: { ...AC1.check!, greenAtBase: false, redFirst: true, redProof: { baseSha: ctx.base, at: '', result: 'green' as const, files: [], exitCode: 0 } } };
  assert.equal(acceptanceOutcome(ctx, red).status, 'fail');
  // the test must exist
  ctx = buildContext({ repo: r });
  const missing = acceptanceOutcome(ctx, { ...ctx.criteria[0], id: 'AC7' });
  assert.equal(missing.status, 'fail');
  assert.match(missing.reasons.join('\n'), /AC7/);
});

test('F5: a green-at-base check needs a test file that names ACn, even when the runner reports no counts', () => {
  // the runner here (a stand-in for ava) selects by name but prints nothing countable and exits 0
  const files = { 'package.json': JSON.stringify({ name: 'quiet', scripts: { test: 'sh quiet.sh ava' } }), 'quiet.sh': 'exit 0\n', 'test/other.test.js': "test('adds', () => {});\n" };
  const r = gitRepo(path.join(h.workspace, `g${++n}`), files);
  writeBrief(r, `t-gab-${n}`, [AC1]);
  let ctx = buildContext({ repo: r });
  const none = acceptanceOutcome(ctx, ctx.criteria[0]);
  assert.equal(none.status, 'fail', JSON.stringify(none));
  assert.match(none.reasons.join('\n'), /no test names AC1/);
  put(r, 'test/add2.test.js', ADD_TEST);
  ctx = buildContext({ repo: r });
  assert.equal(acceptanceOutcome(ctx, ctx.criteria[0]).status, 'pass');
});
