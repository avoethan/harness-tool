import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { chooseEnforcer, type LadderContext } from '../../../src/learn/ladder';
import { tierFor, TEAM_REFUSAL, checkLineBudget, reviewByFor } from '../../../src/learn/tiers';
import type { Ledger } from '../../../src/types';
import type { EnforcerPlan } from '../../../src/learn/store';
import { consoleSpec, record, tempHome, writeLedger, CONSOLE_RULE } from './helpers';

function ctxWith(records: Parameters<typeof writeLedger>[1]): { ctx: LadderContext; cleanup: () => void } {
  const h = tempHome('harness-learn-ladder-');
  writeLedger(h.harnessHome, records);
  const ledger = JSON.parse(require('node:fs').readFileSync(path.join(h.harnessHome, 'ledger', 'ledger.json'), 'utf8')) as Ledger;
  const tests = new Map([[CONSOLE_RULE.id, { id: CONSOLE_RULE.id, valid: ["logger.info('x');"], invalid: ["console.log('x');"] }]]);
  return { ctx: { ledger, checksDir: path.join(h.harnessHome, 'ledger', 'checks'), probeTests: tests }, cleanup: h.cleanup };
}

const input = (key: string, extra: Partial<Parameters<typeof chooseEnforcer>[0]> = {}) => ({ key, touchedRail: false, gateFails: 1, lessonId: 'l-x-000000', ...extra });

test('ladder: a warn-mode rule the gate keeps reporting is promoted to a block-mode learned check (tier 0)', () => {
  const { ctx, cleanup } = ctxWith([{ rec: record('logging.logger-not-console'), spec: consoleSpec() }]);
  try {
    const d = chooseEnforcer(input('rule:logging.logger-not-console'), ctx);
    assert.equal(d.proposal?.rung, 'lint');
    assert.equal(d.proposal?.existing, false);
    assert.equal(d.proposal?.ref, 'learned/logging.logger-not-console.json');
    assert.equal(d.proposal?.check?.overrides, 'logging.logger-not-console');
    assert.deepEqual(d.proposal?.fixtures?.invalid, ["console.log('x');"]);
    assert.equal(d.proposal?.fixtures?.source, 'probe-library');
    assert.equal(tierFor(d.proposal!, { setting: 'team' }).tier, 0);
  } finally {
    cleanup();
  }
});

test('ladder: a rule the gate already blocks is recorded with its existing enforcer', () => {
  const { ctx, cleanup } = ctxWith([{ rec: record('logging.logger-not-console', { tier: 'counted-strong', mode: 'block' }), spec: consoleSpec() }]);
  try {
    const d = chooseEnforcer(input('rule:logging.logger-not-console'), ctx);
    assert.equal(d.proposal?.existing, true);
    assert.equal(d.proposal?.ref, 'ledger:logging.logger-not-console');
    assert.equal(tierFor(d.proposal!, { setting: 'personal' }).tier, 0);
  } finally {
    cleanup();
  }
});

test('ladder: an ESLint warning, a config-only rule and an unknown rule need the judgment pass', () => {
  const { ctx, cleanup } = ctxWith([
    { rec: record('logging.no-console-eslint', { type: 'eslint' }), spec: { engine: 'eslint', eslint: { rule: 'no-console', fragment: {} } } },
    { rec: record('format.prettier', { type: 'config' }), spec: { engine: 'config', note: 'formatter' } },
  ]);
  try {
    for (const key of ['rule:logging.no-console-eslint', 'rule:format.prettier', 'rule:errors.gone']) {
      const d = chooseEnforcer(input(key), ctx);
      assert.equal(d.proposal, undefined, key);
      assert.ok(d.needsJudgment, key);
      assert.equal(d.needsJudgment!.suggested, 'lint');
    }
  } finally {
    cleanup();
  }
});

test('ladder: gate steps are existing enforcers (typecheck is the types rung); rails go to tier 2', () => {
  const ctx: LadderContext = { ledger: null, checksDir: '/nonexistent' };
  const tc = chooseEnforcer(input('step:typecheck'), ctx).proposal!;
  assert.equal(tc.rung, 'types');
  assert.equal(tc.existing, true);
  assert.equal(tierFor(tc, { setting: 'team' }).tier, 0);
  const cov = chooseEnforcer(input('step:coverage'), ctx).proposal!;
  assert.equal(cov.rung, 'ci');
  const rail = chooseEnforcer(input('step:tamper', { touchedRail: true }), ctx).proposal!;
  assert.equal(rail.source, 'rail');
  assert.equal(tierFor(rail, { setting: 'personal' }).tier, 2);
  const safety = chooseEnforcer(input('correction:safety', { touchedRail: true }), ctx).proposal!;
  assert.equal(tierFor(safety, { setting: 'team' }).tier, 2);
});

test('ladder: corrections and broken landings need judgment, with the suggested rung per class', () => {
  const ctx: LadderContext = { ledger: null, checksDir: '/nonexistent' };
  assert.equal(chooseEnforcer(input('correction:style'), ctx).needsJudgment?.suggested, 'lint');
  assert.equal(chooseEnforcer(input('correction:test'), ctx).needsJudgment?.suggested, 'test');
  assert.equal(chooseEnforcer(input('correction:scope'), ctx).needsJudgment?.suggested, 'skill');
  assert.equal(chooseEnforcer(input('correction:other'), ctx).needsJudgment?.suggested, 'instruction');
  assert.deepEqual(chooseEnforcer(input('land:post-landing-red'), ctx).needsJudgment?.rungs, ['test']);
  assert.deepEqual(chooseEnforcer(input('correction:style', { promote: true }), ctx).needsJudgment?.rungs, ['lint', 'test']);
});

const plan = (p: Partial<EnforcerPlan>): EnforcerPlan => ({ rung: 'lint', ref: 'x', why: '', existing: false, source: 'judgment', ...p });

test('tiers: private checks 0, prose 1, hooks and architecture 2, team-repository changes refused', () => {
  assert.equal(tierFor(plan({ check: { id: 'a.learned-b', family: 'a', statement: 's', fixText: 'f', engine: 'regex', spec: {}, scope: { repos: ['*'] } } }), { setting: 'team' }).tier, 0);
  assert.equal(tierFor(plan({ rung: 'instruction', text: 'Never x.' }), { setting: 'team' }).tier, 1);
  assert.equal(tierFor(plan({ rung: 'skill', text: 'x' }), { setting: 'personal' }).tier, 1);
  assert.equal(tierFor(plan({ rung: 'hook' }), { setting: 'personal' }).tier, 2);
  assert.equal(tierFor(plan({ rung: 'types' }), { setting: 'personal' }).tier, 2);
  assert.equal(tierFor(plan({ rung: 'ci' }), { setting: 'personal' }).tier, 1);
  const team = tierFor(plan({ rung: 'ci' }), { setting: 'team' });
  assert.equal(team.tier, 2);
  assert.equal(team.refused, TEAM_REFUSAL);
  assert.equal(tierFor(plan({ rung: 'test', existing: true }), { setting: 'team' }).tier, 0, 'a committed regression test is only recorded');
});

test('line budget: refuses over 60 harness-owned lines or over the learned-line cap, naming the oldest lines to trim', () => {
  const learned = [
    { id: 'l-a-000001', capturedAt: '2026-01-01T00:00:00Z', landedAt: '2026-02-01T00:00:00Z' },
    { id: 'l-b-000002', capturedAt: '2026-01-01T00:00:00Z', landedAt: '2026-01-15T00:00:00Z' },
    { id: 'l-new-000003', capturedAt: '2026-03-01T00:00:00Z' },
  ];
  assert.equal(checkLineBudget([58], learned, { candidate: 'l-new-000003' }).ok, true);
  const over = checkLineBudget([61, 40], learned, { candidate: 'l-new-000003' });
  assert.equal(over.ok, false);
  assert.match(over.reason!, /61 harness-owned lines/);
  assert.deepEqual(over.trim, ['l-b-000002']);
  const cap = checkLineBudget([30], learned, { candidate: 'l-new-000003', cap: 2 });
  assert.equal(cap.ok, false);
  assert.match(cap.reason!, /cap of 2/);
  assert.equal(reviewByFor('instruction', new Date('2026-01-01T00:00:00Z')), '2026-03-02');
  assert.equal(reviewByFor('skill', new Date('2026-01-01T00:00:00Z')), '2026-04-01');
});
