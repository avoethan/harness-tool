/**
 * harness verify and databases marked read-only: launch never creates,
 * restores, copies from or seeds one (exit 4 naming the mark); verify db may
 * only read one, through the guard's read-only classifier.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { DbConfig, DbTarget } from '../../../src/types';
import { hashJson } from '../../../src/lib/hash';
import { checkReadOnlyTarget, checkSelectOnly, guardCheck, serviceServerCheck, type Transport } from '../../../src/verify/sqlcmd';
import { planDb, recheckPlan, type DbPlan } from '../../../src/verify/dbrun';

function signed(allowlist: DbTarget[]): DbConfig {
  return { allowlist, markedHash: hashJson(allowlist) };
}

const LIST = signed([
  { server: 'dbhost,1433', marked: 'test' },
  { server: 'dbhost,1433', database: 'reports', marked: 'read-only' },
  { server: 'ro-wide,1433', marked: 'read-only' },
]);
const LOCAL: Transport = { mode: 'local', sqlcmd: '/usr/bin/sqlcmd', innerServer: 'dbhost,1433' };
const LOGIN = { user: 'sa', passwordEnv: 'PW' };
const deps = { which: (c: string) => (c === 'sqlcmd' ? '/usr/bin/sqlcmd' : null), containers: () => [] };

test('serviceServerCheck and guardCheck refuse a read-only target unless asked to allow reads', () => {
  const s = serviceServerCheck('dbhost,1433', 'reports', LIST);
  assert.equal(s.ok, false);
  assert.match(s.reason, /marked read-only.*never creates, restores, copies from or seeds/);
  assert.equal(serviceServerCheck('dbhost,1433', 'test_abc123', LIST).ok, true, 'the test databases beside it stay usable');
  const g = guardCheck(LOCAL, 'reports', LOGIN, LIST);
  assert.equal(g.ok, false);
  assert.match(g.reason, /marked read-only/);
  const s2 = serviceServerCheck('dbhost,1433', 'reports', LIST, undefined, { allowReadOnly: true });
  assert.equal(s2.ok, true);
  assert.equal(s2.readOnly, true);
  assert.equal(guardCheck(LOCAL, 'reports', LOGIN, LIST, undefined, { allowReadOnly: true }).ok, true);
});

test('verify launch: an existing-mode database or a snapshot source marked read-only is refused as a rail (exit 4)', () => {
  const existing = planDb({ vcfg: { db: { server: 'dbhost,1433', mode: 'existing', database: 'reports' } }, db: LIST, runId: 'abc123', deps });
  assert.equal(existing.ok, false);
  assert.equal(existing.rail, true);
  assert.match(existing.reason ?? '', /reports is marked read-only/);
  for (const snap of ['db:reports', 'clone:reports']) {
    const p = planDb({ vcfg: { db: { server: 'dbhost,1433', snapshot: snap } }, db: LIST, runId: 'abc123', deps });
    assert.equal(p.ok, false, snap);
    assert.equal(p.rail, true);
    assert.match(p.reason ?? '', /snapshot source reports.*read-only/);
  }
  // A per-run database on a server-wide read-only server: creating it needs master, which is read-only too.
  const wide = planDb({ vcfg: { db: { server: 'ro-wide,1433' } }, db: LIST, runId: 'abc123', deps });
  assert.equal(wide.ok, false);
  assert.equal(wide.rail, true);
  assert.match(wide.reason ?? '', /read-only/);
  // The test server beside the read-only database still works.
  assert.equal(planDb({ vcfg: { db: { server: 'dbhost,1433' } }, db: LIST, runId: 'abc123', deps }).ok, true);
});

test('verify db: a run database re-marked read-only passes the recheck as read-only; recipes that write are refused, reads go through the classifier', () => {
  const plan: DbPlan = { server: 'dbhost,1433', host: 'dbhost', port: '1433', database: 'reports', mode: 'existing', transport: LOCAL, login: LOGIN };
  assert.equal(recheckPlan(plan, LIST).ok, false, 'without allowReadOnly the recheck refuses');
  const rc = recheckPlan(plan, LIST, undefined, { allowReadOnly: true });
  assert.equal(rc.ok, true, rc.reason);
  assert.equal(rc.readOnly, true);
  assert.equal(checkReadOnlyTarget('SELECT COUNT(*) AS n FROM dbo.orders', 'reports'), null);
  assert.match(checkReadOnlyTarget("INSERT INTO dbo.orders (id) VALUES (1)", 'reports') ?? '', /reports is marked read-only: this statement could write \(INSERT\)/);
  assert.match(checkReadOnlyTarget('UPDATE dbo.orders SET status = @s', 'reports') ?? '', /UPDATE/);
  // --query uses the same classifier: what it adds over the old checks
  for (const q of ["SELECT 1 WAITFOR DELAY '00:00:05'", 'SELECT $(x)', 'SELECT NEXT VALUE FOR dbo.seq', 'SELECT 1 {call dbo.p}', 'SELECT N\'café\'']) {
    assert.match(checkSelectOnly(q, 'reports') ?? '', /could write or reach outside reports/, q);
  }
  assert.equal(checkSelectOnly('SELECT * FROM reports.dbo.orders', 'reports'), null);
});
