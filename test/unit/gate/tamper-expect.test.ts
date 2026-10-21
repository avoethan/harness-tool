import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildContext } from '../../../src/gate/context';
import { expectationChanges, tamperFindings } from '../../../src/gate/tamper';
import { addExpectChange, setTaskPhase } from '../../../src/intake/phase';
import { repoIdFor } from '../../../src/lib/config';
import { demoRepo, put, tempHome, writeBrief, type TempHome } from './helpers';
import type { Criterion } from '../../../src/types';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-expect-');
});
after(() => h.cleanup());

function repo(): string {
  return demoRepo(path.join(h.workspace, `r${++n}`));
}
const TEST = 'test/add.test.js';
function edit(r: string, from: string, to: string): void {
  put(r, TEST, fs.readFileSync(path.join(r, TEST), 'utf8').replace(from, to));
}
const crit = (id: string, text: string): Criterion => ({ id, text, kind: 'unit', check: { kind: 'unit', description: 'x', redFirst: true } });

test('expectationChanges: a changed literal on an assertion line is found; formatting, new assertions and other lines are not', () => {
  const before = "test('a', () => {\n  assert.equal(add(1, 2), 3);\n  const x = 5;\n});\n";
  assert.deepEqual(expectationChanges(before, "test('a', () => {\n  assert.equal(add(1, 2), 4);\n  const x = 5;\n});\n").map((x) => x.line), [2]);
  assert.deepEqual(expectationChanges(before, "test('a', () => {\n  assert.equal( add(1,2),   3 );\n  const x = 5;\n});\n"), [], 'whitespace only');
  assert.deepEqual(expectationChanges(before, "test('a', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n  const x = 5;\n});\n"), [], 'a new assertion');
  assert.deepEqual(expectationChanges(before, "test('a', () => {\n  assert.equal(add(1, 2), 3);\n  const x = 6;\n});\n"), [], 'a non-assertion line');
  assert.equal(expectationChanges('expect(r).toMatch(/ab+/);\n', 'expect(r).toMatch(/ab*/);\n').length, 1, 'a regex');
  assert.equal(expectationChanges('expect(r.ok).toBe(true);\n', 'expect(r.ok).toBe(false);\n').length, 1, 'a boolean');
  assert.equal(expectationChanges('expect(r).toEqual({ a: 1 });\n', 'expect(r).toEqual({ a: 2 });\n').length, 1, 'an object');
  assert.equal(expectationChanges("expect(r).toBe('x');\n", 'expect(r).toBe("y");\n').length, 1, 'a string');
});

test('a changed assertion literal in a pre-existing test FAILs, naming file and line', () => {
  const r = repo();
  edit(r, 'assert.equal(add(2, 2), 4);', 'assert.equal(add(2, 2), 5);');
  const f = tamperFindings(buildContext({ repo: r }));
  assert.deepEqual(f, ['expectation changed in a pre-existing test: test/add.test.js:6']);
});

test('removing an assertion line is still the assertion-count FAIL, not an expectation change', () => {
  const r = repo();
  edit(r, '  assert.equal(add(2, 2), 4);\n', '');
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), ['test/add.test.js: assertion count dropped from 2 to 1']);
});

test('a non-assertion change and a new test file are never flagged', () => {
  const r = repo();
  edit(r, "test('adds'", "test('adds numbers'");
  put(r, 'test/new.test.js', "const assert = require('node:assert');\nassert.equal(1, 1);\n");
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);
});

test('a change covered by a unit path of the brief passes', () => {
  const r = repo();
  const repoId = repoIdFor(r);
  writeBrief(r, `t-exp-${n}`, [crit('AC1', 'adds')], { units: [{ id: 'U1', title: 'u', repo: repoId, paths: [TEST], dependsOn: [], criteria: ['AC1'] }] });
  edit(r, 'assert.equal(add(2, 2), 4);', 'assert.equal(add(2, 2), 5);');
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);
});

test('a change whose new literal a criterion quotes passes; an unquoted one does not', () => {
  const r = repo();
  writeBrief(r, `t-exp-${n}`, [crit('AC1', 'add returns "seventeen" for 8 and 9')]);
  edit(r, 'assert.equal(add(2, 2), 4);', 'assert.equal(add(2, 2), "seventeen");');
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);
  edit(r, '"seventeen"', '"eighteen"');
  assert.equal(tamperFindings(buildContext({ repo: r })).length, 1);
});

test('a declared change passes, is recorded with its reason, and covers only that file', () => {
  const r = repo();
  const task = `t-exp-${n}`;
  writeBrief(r, task, []);
  const repoId = repoIdFor(r);
  setTaskPhase(repoId, task, 'tests');
  edit(r, 'assert.equal(add(2, 2), 4);', 'assert.equal(add(2, 2), 5);');
  assert.equal(tamperFindings(buildContext({ repo: r })).length, 1);
  const rec = addExpectChange(repoId, task, { file: TEST, reason: 'add now rounds up' });
  assert.equal(rec.expectChanges?.length, 1);
  assert.deepEqual(Object.keys(rec.expectChanges![0]).sort(), ['at', 'file', 'reason']);
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);
  // an unrelated pre-existing test file is not covered
  const r2 = repo();
  const task2 = `t-exp-${n}`;
  writeBrief(r2, task2, []);
  addExpectChange(repoIdFor(r2), task2, { file: 'test/other.test.js', reason: 'x' });
  edit(r2, 'assert.equal(add(2, 2), 4);', 'assert.equal(add(2, 2), 5);');
  assert.equal(tamperFindings(buildContext({ repo: r2 })).length, 1);
});
