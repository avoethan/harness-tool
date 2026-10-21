import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { captureOccurrences, groupByClass, isActive, parseEvents } from '../../../src/learn/capture';
import { describeKey, isLessonId, keyTouchesRail, lessonIdFor } from '../../../src/learn/classes';
import { at, correction, gateFail, type ScriptedEvent } from './helpers';

function cap(events: ScriptedEvent[], aliases?: Map<string, string>) {
  const { events: evs, malformed } = parseEvents(events.map((e) => JSON.stringify(e)).join('\n'));
  return { ...captureOccurrences(evs, { aliases }), malformed };
}

test('parseEvents keeps whitelisted fields only and counts unreadable lines', () => {
  const text = [JSON.stringify({ ...correction(0, 'style'), prompt: 'please never do X', text: 'SECRET' }), 'not json', JSON.stringify({ event: 'x' }), ''].join('\n');
  const { events, malformed } = parseEvents(text);
  assert.equal(events.length, 1);
  assert.equal(malformed, 2);
  const s = JSON.stringify(events[0]);
  assert.ok(!s.includes('never do X') && !s.includes('SECRET'), 'no free text survives parsing');
  assert.match(events[0].id, /^e-[0-9a-f]{12}$/);
  assert.equal(events[0].cls, 'style');
});

test('parseEvents --since drops older events; duplicate lines get distinct ids', () => {
  const e = correction(0, 'style');
  const { events } = parseEvents([JSON.stringify(e), JSON.stringify(e), JSON.stringify(correction(100, 'test'))].join('\n'));
  assert.equal(events.length, 3);
  assert.notEqual(events[0].id, events[1].id);
  const late = parseEvents([JSON.stringify(e), JSON.stringify(correction(100, 'test'))].join('\n'), { since: new Date(at(50)) });
  assert.equal(late.events.length, 1);
});

test('gate.fail groups by rule id, else by step kind; one occurrence per class per task', () => {
  const c = cap([
    gateFail(0, { rules: 'logging.no-console,errors.http' }),
    gateFail(5, { rules: 'logging.no-console' }), // same task: an attempt, not a new occurrence
    gateFail(10, { rules: 'logging.no-console', task: 't2', session: 's2' }),
    gateFail(20, { step: 'typecheck', task: 't3', session: 's3' }),
    gateFail(30, { step: 'acceptance:AC1', task: 't3', session: 's3' }),
  ]);
  const g = new Map(groupByClass(c).map((x) => [x.key, x]));
  assert.equal(g.get('rule:logging.no-console')!.occurrences.length, 2);
  assert.equal(g.get('rule:logging.no-console')!.followUps, 1);
  assert.equal(g.get('rule:errors.http')!.occurrences.length, 1);
  assert.equal(g.get('step:typecheck')!.occurrences.length, 1);
  assert.equal(g.get('step:acceptance')!.occurrences.length, 1);
});

test('a correction after a gate failure in the same session counts for that failure; otherwise for its class', () => {
  const c = cap([
    gateFail(0, { rules: 'logging.no-console', session: 's1' }),
    correction(5, 'style', 's1'),
    correction(6, 'style', 's1'),
    correction(7, 'style', 's2'), // other session: unexplained
    correction(60 * 5, 'style', 's1'), // 5 hours later: outside the link window
  ]);
  const g = new Map(groupByClass(c).map((x) => [x.key, x]));
  assert.equal(g.get('rule:logging.no-console')!.occurrences.length, 3);
  assert.equal(g.get('rule:logging.no-console')!.counts.correction, 2);
  assert.equal(g.get('correction:style')!.occurrences.length, 2);
  assert.ok(g.get('rule:logging.no-console')!.occurrences.some((o) => o.linkedTo));
});

test('thresholds: two occurrences make a lesson; one is enough when it touched a rail', () => {
  const c = cap([correction(0, 'scope', 'a'), correction(1, 'test', 'b'), correction(2, 'test', 'c'), correction(3, 'safety', 'd'), gateFail(4, { step: 'secrets', task: 'tx', session: 'e' }), { ts: at(5), event: 'guard.deny', sessionId: 'f', ids: { rail: 'db' } }, correction(6, 'other', 'f')]);
  const g = new Map(groupByClass(c).map((x) => [x.key, x]));
  assert.equal(isActive(g.get('correction:scope')!), false);
  assert.equal(isActive(g.get('correction:test')!), true);
  assert.equal(isActive(g.get('correction:safety')!), true);
  assert.equal(isActive(g.get('step:secrets')!), true);
  assert.equal(g.get('correction:other')!.rail, true, 'a correction in a session where the guard denied something touched a rail');
  assert.equal(isActive(g.get('correction:other')!), true);
});

test('land events: a revert after a red landing of the same task is a follow-up', () => {
  const c = cap([
    { ts: at(0), event: 'land.post_landing_red', repo: 'r', task: 'a', ids: { ci: 'local' } },
    { ts: at(1), event: 'land.reverted', repo: 'r', task: 'a', ids: { ci: 'local' } },
    { ts: at(2), event: 'land.reverted', repo: 'r', task: 'b', ids: { ci: 'local' } },
  ]);
  const g = new Map(groupByClass(c).map((x) => [x.key, x]));
  assert.equal(g.get('land:post-landing-red')!.occurrences.length, 1);
  assert.equal(g.get('land:post-landing-red')!.followUps, 1);
  assert.equal(g.get('land:reverted')!.occurrences.length, 1);
});

test('aliases fold a learned rule id back into its lesson class', () => {
  const c = cap([gateFail(0, { rules: 'logging.learned-no-print', task: 'z' })], new Map([['rule:logging.learned-no-print', 'correction:style']]));
  assert.equal(c.occurrences[0].key, 'correction:style');
});

test('class keys: stable lesson ids, rail detection, plain descriptions', () => {
  assert.equal(lessonIdFor('rule:logging.no-console'), lessonIdFor('rule:logging.no-console'));
  assert.ok(isLessonId(lessonIdFor('rule:logging.no-console')));
  assert.ok(!isLessonId('../../etc/passwd'));
  assert.equal(keyTouchesRail('step:tamper'), true);
  assert.equal(keyTouchesRail('rule:safety.no-prod-db'), true);
  assert.equal(keyTouchesRail('rule:logging.no-console'), false);
  assert.match(describeKey('land:reverted'), /reverted/);
});
