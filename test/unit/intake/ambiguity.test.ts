import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ambiguityGate, formatQuestionsBlock, lintBrief, MAX_OPEN_MARKERS, MAX_QUESTIONS, resolveAnswer } from '../../../src/intake/ambiguity';
import type { Unclear } from '../../../src/intake/classify';
import type { Criterion } from '../../../src/types';

const fork = (id: string, impact = 3, uncertainty = 2): Unclear => ({
  criterionId: id,
  topic: 'scope',
  detail: `${id} scope`,
  question: `${id}: what is in scope?`,
  options: ['Only what is named', 'Everything'],
  recommended: 0,
  impact,
  uncertainty,
});
const blocking = (id: string): Unclear => ({
  criterionId: id,
  topic: 'meaning',
  detail: `${id} meaning`,
  question: `${id}: what does it mean?`,
  options: ['p95 under 500 ms', 'p95 under 1 s'],
  recommended: 0,
  blocking: true,
  impact: 4,
  uncertainty: 3,
});

test('observable points become observations, defaults become assumptions, forks become questions', () => {
  const g = ambiguityGate([
    { criterionId: 'AC1', topic: 'route', detail: 'AC1 names no route', command: 'git grep -n orders' },
    { criterionId: 'AC1', topic: 'status', detail: 'no status', assume: 'AC1: expected status 200 for GET' },
    fork('AC2'),
  ]);
  assert.deepEqual(g.observations, [{ criterionId: 'AC1', text: 'AC1 names no route', command: 'git grep -n orders' }]);
  assert.equal(g.questions.length, 1);
  assert.equal(g.questions[0].n, 1);
  assert.equal(g.questions[0].key, 'AC2:scope');
  assert.deepEqual(g.assumptions, ['AC1: expected status 200 for GET', 'AC2: until answered, assumed "Only what is named" (scope)']);
  assert.deepEqual(g.markers, []);
});

test('caps: at most 5 questions and 3 open markers in one batch; blocking overflow is queued, fork overflow is assumed', () => {
  const unclear = [blocking('AC1'), blocking('AC2'), blocking('AC3'), blocking('AC4'), fork('AC5', 5, 3), fork('AC6', 1, 1), fork('AC7', 4, 2), fork('AC8', 2, 2)];
  const g = ambiguityGate(unclear);
  assert.equal(MAX_QUESTIONS, 5);
  assert.equal(MAX_OPEN_MARKERS, 3);
  assert.equal(g.questions.length, 5);
  assert.deepEqual(g.markers, ['AC1', 'AC2', 'AC3']);
  // blocking first, then forks by impact x uncertainty
  assert.deepEqual(
    g.questions.map((q) => q.criterionId),
    ['AC1', 'AC2', 'AC3', 'AC5', 'AC7'],
  );
  assert.deepEqual(
    g.queued.map((q) => [q.criterionId, q.n]),
    [['AC4', 6]],
  );
  assert.ok(g.assumptions.some((a) => a.startsWith('AC6: assumed "Only what is named"') && a.includes('question cap of 5')));
  assert.ok(g.assumptions.some((a) => a.startsWith('AC8: assumed')));
});

test('answered questions are not asked again and numbering continues', () => {
  const g = ambiguityGate([fork('AC1'), fork('AC2')], { answered: new Set(['AC1:scope']), firstNumber: 4 });
  assert.deepEqual(
    g.questions.map((q) => [q.key, q.n]),
    [['AC2:scope', 4]],
  );
});

test('the questions block can be answered in one message and marks recommended options', () => {
  const g = ambiguityGate([blocking('AC1'), fork('AC2')]);
  const text = formatQuestionsBlock(g.questions, 't-abc');
  assert.match(text, /answer them all in one message/);
  assert.match(text, /Q1 \[meaning, AC1, blocks AC1\] AC1: what does it mean\?/);
  assert.match(text, /A\) p95 under 500 ms {2}\(recommended\)/);
  assert.match(text, /Q2 \[scope, AC2\]/);
  assert.match(text, /harness intake answer t-abc --q <n> --answer/);
});

test('answers: option letters map to the option text; free text is kept', () => {
  const g = ambiguityGate([blocking('AC1')]);
  const q = g.questions[0];
  assert.equal(resolveAnswer(q, 'B'), 'p95 under 1 s');
  assert.equal(resolveAnswer(q, 'b)'), 'p95 under 1 s');
  assert.equal(resolveAnswer(q, 'option A'), 'p95 under 500 ms');
  assert.equal(resolveAnswer(q, 'p99 under 2 s'), 'p99 under 2 s');
  assert.equal(resolveAnswer(q, 'Z'), 'Z');
});

const crit = (id: string, withCheck: boolean, redFirst = true): Criterion => ({
  id,
  text: `${id} text`,
  kind: 'unit',
  ...(withCheck ? { check: { kind: 'unit', description: 'd', redFirst } } : {}),
});

test('plan lint rejects a criterion with no check and no question, a check that is not red-first, and a criterion outside units', () => {
  const problems = lintBrief({
    criteria: [crit('AC1', true), crit('AC2', false), crit('AC3', false), crit('AC4', true, false)],
    open: [{ criterionId: 'AC3', blocking: true }],
    units: [{ id: 'U1', title: 'u', repo: 'r', paths: [], dependsOn: [], criteria: ['AC1', 'AC2', 'AC3'] }],
  });
  assert.deepEqual(problems, ['AC2: no check and no open question ("AC2 text")', 'AC4: the check is not marked red-first', 'AC4: not in any unit']);
  assert.deepEqual(lintBrief({ criteria: [crit('AC1', true)], open: [] }), []);
});

test('plan lint rejects an empty brief unless a question asks for the criteria, and over-cap batches', () => {
  assert.deepEqual(lintBrief({ criteria: [], open: [] }), ['The brief has no acceptance criteria and no question asking for them.']);
  assert.deepEqual(lintBrief({ criteria: [], open: [{ blocking: true }] }), []);
  assert.deepEqual(lintBrief({ criteria: [], open: [{ blocking: true }], markers: ['a', 'b', 'c', 'd'], batchSize: 6 }), ['4 open markers (cap 3)', '6 questions in one batch (cap 5)']);
});
