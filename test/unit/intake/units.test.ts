import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { planUnits, UNMAPPED, type UnitInput } from '../../../src/intake/units';

const f = (o: Partial<UnitInput['facts']> = {}): UnitInput['facts'] => ({ paths: [], routes: [], tables: [], ...o });

test('one repo, one resource: database before API, merged into one unit when small', () => {
  const plan = planUnits(
    [
      { id: 'AC1', kind: 'api', repos: ['orders'], facts: f({ routes: [{ method: 'GET', path: '/orders/:id' }] }) },
      { id: 'AC2', kind: 'db', repos: ['orders'], facts: f({ tables: ['orders'] }) },
    ],
    { orders: 'orders-api' },
  );
  assert.equal(plan.units.length, 1);
  assert.deepEqual(plan.units[0], { id: 'U1', title: 'orders-api: orders (AC2, AC1)', repo: 'orders', paths: [], dependsOn: [], criteria: ['AC2', 'AC1'] });
  assert.equal(plan.estimates.U1, 5);
  assert.deepEqual(plan.landingOrder, ['orders']);
});

test('a large area is split so no unit exceeds the file budget; the database part comes first and the API part depends on it', () => {
  const plan = planUnits(
    [
      { id: 'AC1', kind: 'api', repos: ['orders'], facts: f({ routes: [{ path: '/orders' }] }) },
      { id: 'AC2', kind: 'api', repos: ['orders'], facts: f({ routes: [{ method: 'POST', path: '/orders' }] }) },
      { id: 'AC3', kind: 'db', repos: ['orders'], facts: f({ tables: ['orders'] }) },
    ],
    { orders: 'orders-api' },
  );
  assert.deepEqual(
    plan.units.map((u) => [u.id, u.criteria, u.dependsOn]),
    [
      ['U1', ['AC3', 'AC1'], []],
      ['U2', ['AC2'], ['U1']],
    ],
  );
  for (const u of plan.units) assert.ok(plan.estimates[u.id] <= 5);
});

test('paths cluster by folder; a criterion naming many files gets its own unit', () => {
  const plan = planUnits(
    [
      { id: 'AC1', kind: 'unit', repos: ['r'], facts: f({ paths: ['src/pricing/round.ts'] }) },
      { id: 'AC2', kind: 'unit', repos: ['r'], facts: f({ paths: ['src/pricing/tax.ts'] }) },
      { id: 'AC3', kind: 'unit', repos: ['r'], facts: f({ paths: ['src/export/a.ts', 'src/export/b.ts', 'src/export/c.ts', 'src/export/d.ts', 'src/export/e.ts'] }) },
    ],
    { r: 'shop' },
  );
  assert.deepEqual(
    plan.units.map((u) => [u.title, u.paths.length]),
    [
      ['shop: src/pricing (AC1, AC2)', 2],
      ['shop: src/export (AC3)', 5],
    ],
  );
  assert.equal(plan.estimates.U2, 6);
});

test('cross-repo: one unit per repo, the provider repo lands first, and the consumer depends on it', () => {
  const plan = planUnits(
    [
      { id: 'AC1', kind: 'ui-artifact', repos: ['web'], facts: f({ routes: [{ path: '/orders' }] }) },
      { id: 'AC2', kind: 'api', repos: ['api'], facts: f({ routes: [{ method: 'GET', path: '/orders/:id' }] }) },
      { id: 'AC3', kind: 'db', repos: ['api', 'reporting'], facts: f({ tables: ['orders'] }) },
    ],
    { web: 'web', api: 'orders-api', reporting: 'reporting' },
  );
  assert.deepEqual(
    plan.units.map((u) => [u.id, u.repo, u.criteria, u.dependsOn]),
    [
      ['U1', 'api', ['AC3', 'AC2'], []],
      ['U2', 'reporting', ['AC3'], ['U1']],
      ['U3', 'web', ['AC1'], ['U1']],
    ],
  );
  assert.deepEqual(plan.landingOrder, ['api', 'reporting', 'web']);
});

test('unmapped criteria still get a unit so nothing is lost', () => {
  const plan = planUnits([{ id: 'AC1', kind: 'unit', repos: [], facts: f() }]);
  assert.equal(plan.units[0].repo, UNMAPPED);
  assert.deepEqual(plan.landingOrder, [UNMAPPED]);
});

test('independent areas in one repo have no dependencies', () => {
  const plan = planUnits(
    [
      { id: 'AC1', kind: 'api', repos: ['r'], facts: f({ routes: [{ path: '/carts' }] }) },
      { id: 'AC2', kind: 'db', repos: ['r'], facts: f({ tables: ['invoices'] }) },
    ],
    { r: 'shop' },
  );
  assert.deepEqual(
    plan.units.map((u) => [u.title, u.dependsOn]),
    [
      ['shop: invoices (AC2)', []],
      ['shop: carts (AC1)', []],
    ],
  );
});
