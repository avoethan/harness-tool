import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import type { DbConfig, DbTarget } from '../../../src/types';
import { hashJson } from '../../../src/lib/hash';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import { buildRunDb, migrationsAfterSnapshot, type DbPlan, type SnapshotObjects } from '../../../src/verify/dbrun';
import { objectsOfSql, type MigrationEntry } from '../../../src/verify/featuremap';
import { assertHeader, drive, parseHeaderExpectation } from '../../../src/verify/drive';
import { launch } from '../../../src/verify/launch';
import { doctor } from '../../../src/verify/doctor';
import { cleanup } from '../../../src/verify/cleanup';
import { loadRun, resolveContext } from '../../../src/verify/state';
import { gitRepo, tempHome, write } from '../lifecycle/helpers';
import { headSha } from '../../../src/lib/git';

function signed(allowlist: DbTarget[]): DbConfig {
  return { allowlist, markedHash: hashJson(allowlist) };
}

// ---------------------------------------------------------------------------
// Contract item 4: migrations after a snapshot restore
// ---------------------------------------------------------------------------

/** A fake sqlcmd (a node script): logs every call and answers the few queries buildRunDb makes. */
interface FakeDb {
  /** `table.column` pairs the INFORMATION_SCHEMA.COLUMNS query returns. */
  columns?: string[];
  indexes?: string[];
  /** Rows of a migration-history table (the table name must also be in existingTables). */
  history?: Array<Record<string, unknown>>;
}
function fakeSqlcmd(dir: string, existingTables: string[], extra: FakeDb = {}): { bin: string; calls: () => Array<{ args: string[]; stdin: string }> } {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'sqlcmd-calls.jsonl');
  const bin = path.join(dir, 'fake-sqlcmd.js');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const q = args[args.indexOf('-Q') + 1] || '';
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch (e) {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + '\\n');
if (q.includes('sys.databases')) console.log('[]');
else if (q.includes('InstanceDefaultDataPath')) console.log('[{"dataPath":"/data/","logPath":"/log/"}]');
else if (q.includes('RESTORE FILELISTONLY')) console.log('shop /x/shop.mdf D 1\\nshop_log /x/shop.ldf L 1');
else if (q.includes('INFORMATION_SCHEMA.TABLES')) console.log(JSON.stringify(${JSON.stringify(existingTables)}.map((t) => ({ t }))));
else if (q.includes('INFORMATION_SCHEMA.COLUMNS')) console.log(JSON.stringify(${JSON.stringify(extra.columns ?? [])}.map((x) => ({ t: x.split('.')[0], c: x.split('.')[1] }))));
else if (q.includes('sys.indexes')) console.log(JSON.stringify(${JSON.stringify(extra.indexes ?? [])}.map((i) => ({ i, t: 'orders' }))));
else if (q.includes('TOP 5000')) console.log(JSON.stringify(${JSON.stringify(extra.history ?? [])}));
`,
  );
  fs.chmodSync(bin, 0o755);
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
      : [];
  return { bin, calls };
}

function snapshotPlan(bin: string): DbPlan {
  return {
    server: 'dbhost,1433',
    host: 'dbhost',
    port: '1433',
    database: 'test_abc123',
    mode: 'per-run',
    transport: { mode: 'local', sqlcmd: bin, innerServer: 'dbhost,1433' },
    login: {},
    snapshot: '/backups/shop.bak',
  };
}

function entry(id: string, tables: string[], extra: Partial<MigrationEntry> = {}): MigrationEntry {
  return { id, service: 'shop-api', repoId: 'shop', file: `db/migrations/${id}.sql`, kind: 'sql', tables, references: [], sha256: '', ...extra };
}

const NOTE_OLD = "IF COL_LENGTH(N'dbo.orders', N'note') IS NULL BEGIN ALTER TABLE orders ADD note nvarchar(50) NULL END\n";
const NOTE_NEW = "IF COL_LENGTH(N'dbo.orders', N'note') IS NULL BEGIN ALTER TABLE orders ADD note nvarchar(80) NULL END\n";

const none: SnapshotObjects = { tables: [], columns: [], indexes: [], history: [] };
const noText = () => null;
const textsOf = (m: Record<string, string>) => (e: MigrationEntry) => m[e.id] ?? null;

test('migrationsAfterSnapshot: an unchanged ALTER TABLE ADD the snapshot predates is applied', () => {
  const ms = [entry('0001_init', ['orders']), entry('0002_status', ['orders'])];
  const texts = textsOf({ '0001_init': 'CREATE TABLE orders (id int);', '0002_status': 'ALTER TABLE orders ADD status nvarchar(20) NULL;' });
  const got = migrationsAfterSnapshot(ms, new Map(), { ...none, tables: ['orders'], columns: ['orders.id'] }, texts);
  assert.deepEqual(got.todo.map((g) => g.m.id), ['0002_status']);
  assert.equal(got.todo[0].changed, false);
  assert.deepEqual(got.todo[0].missing, ['column orders.status']);
  assert.deepEqual(got.held.map((h) => h.m.id), ['0001_init']);
});

test('migrationsAfterSnapshot: a changed CREATE TABLE whose table the snapshot holds is reported already in the snapshot, not run', () => {
  const ms = [entry('0001_init', ['orders'])];
  const changedBy = new Map([['shop-api', new Set(['db/migrations/0001_init.sql'])]]);
  const got = migrationsAfterSnapshot(ms, changedBy, { ...none, tables: ['orders'] }, textsOf({ '0001_init': 'CREATE TABLE [dbo].[Orders] (id int, total money);' }));
  assert.deepEqual(got.todo, []);
  assert.equal(got.held[0].why, 'present');
  assert.match(got.held[0].detail, /already in the snapshot \(table orders\)/);
  assert.match(got.held[0].detail, /changed since the base commit/);
});

test('migrationsAfterSnapshot: a data-only migration is applied only when it changed', () => {
  const ms = [entry('0005_backfill', [])];
  const texts = textsOf({ '0005_backfill': "UPDATE orders SET status = 'new' WHERE status IS NULL;" });
  const unchanged = migrationsAfterSnapshot(ms, new Map(), { ...none, tables: ['orders'] }, texts);
  assert.deepEqual(unchanged.todo, []);
  assert.equal(unchanged.held[0].why, 'unchanged-no-objects');
  const changed = migrationsAfterSnapshot(ms, new Map([['shop-api', new Set(['db/migrations/0005_backfill.sql'])]]), { ...none, tables: ['orders'] }, texts);
  assert.deepEqual(changed.todo.map((g) => [g.m.id, g.why]), [['0005_backfill', 'changed-no-objects']]);
});

test('migrationsAfterSnapshot: a migration recorded in a history table is never applied, even when its objects are missing', () => {
  const ms = [entry('0002_status', ['orders']), entry('0003_other', [])];
  const texts = textsOf({ '0002_status': 'ALTER TABLE orders ADD status int;', '0003_other': 'ALTER TABLE orders ADD other int;' });
  const have: SnapshotObjects = { ...none, tables: ['orders', '__migrations'], historyTable: '__migrations', history: ['0002_status.sql', 'x'] };
  const changedBy = new Map([['shop-api', new Set(['db/migrations/0002_status.sql'])]]);
  const got = migrationsAfterSnapshot(ms, changedBy, have, texts);
  assert.deepEqual(got.todo.map((g) => g.m.id), ['0003_other']);
  assert.deepEqual(got.held.map((h) => [h.m.id, h.why, h.detail]), [['0002_status', 'recorded', 'recorded in __migrations']]);
});

test('migrationsAfterSnapshot: indexes are checked by name; code migrations are never selected; unreadable files fall through to the apply step', () => {
  const ms = [entry('0001', []), entry('0002', [], { kind: 'code', file: 'db/migrations/0002.js' }), entry('0003', [])];
  const texts = textsOf({ '0001': 'CREATE UNIQUE NONCLUSTERED INDEX ix_orders_ref ON dbo.orders (ref);' });
  const got = migrationsAfterSnapshot(ms, new Map(), { ...none, tables: ['orders'] }, texts);
  assert.deepEqual(got.todo.map((g) => [g.m.id, g.missing]), [['0001', ['index ix_orders_ref']], ['0003', []]]);
  const have = migrationsAfterSnapshot([ms[0]], new Map(), { ...none, tables: ['orders'], indexes: ['IX_orders_ref'] }, texts);
  assert.deepEqual(have.todo, []);
  assert.equal(migrationsAfterSnapshot([ms[0]], new Map(), none, noText).todo.length, 1);
});

test('objectsOfSql reads CREATE TABLE, ADD columns (T-SQL and ADD COLUMN lists), and indexes, and ignores constraints, comments and strings', () => {
  const o = objectsOfSql(`-- ALTER TABLE ghost ADD nope int
IF COL_LENGTH(N'dbo.orders', N'status') IS NULL BEGIN ALTER TABLE [dbo].[orders] ADD status nvarchar(20) NULL, [note] nvarchar(max) DEFAULT 'a,b' END
ALTER TABLE items ADD COLUMN qty int, ADD COLUMN price money;
ALTER TABLE items ADD CONSTRAINT pk_items PRIMARY KEY (id);
CREATE TABLE IF NOT EXISTS audit (id int);
UPDATE orders SET a = 1, b = 2;`);
  assert.deepEqual(o.tables, ['audit']);
  assert.deepEqual(o.columns.map((c) => `${c.table}.${c.column}`).sort(), ['items.price', 'items.qty', 'orders.note', 'orders.status']);
  assert.deepEqual(o.indexes, []);
});

test('a snapshot restore is followed by the migrations the snapshot lacks; --no-migrate skips them', async () => {
  const h = tempHome('harness-verify-snap-');
  try {
    const repo = gitRepo(path.join(h.workspace, 'shop-api'), {
      'package.json': '{"scripts":{"dev":"node x.js"}}',
      'db/migrations/0001_init.sql': 'CREATE TABLE orders (id int);\n',
      'db/migrations/0002_add_note.sql': NOTE_OLD,
    });
    const base = headSha(repo);
    // The ticket's work: edits one migration and adds another (uncommitted).
    write(path.join(repo, 'db/migrations/0002_add_note.sql'), NOTE_NEW);
    write(path.join(repo, 'db/migrations/0003_audit.sql'), 'CREATE TABLE audit (id int);\n');
    const migrations = [entry('0001_init', ['orders']), entry('0002_add_note', ['orders']), entry('0003_audit', ['audit'])];

    const f1 = fakeSqlcmd(path.join(h.root, 'one'), ['orders']);
    const r = await buildRunDb({ plan: snapshotPlan(f1.bin), migrations, repoRoots: { 'shop-api': repo }, bases: { 'shop-api': base }, seeds: [] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.db.source, 'snapshot');
    assert.deepEqual(r.db.migrations.map((m) => m.id), ['0002_add_note', '0003_audit']);
    assert.ok(r.db.migrations.every((m) => m.afterSnapshot && m.changed), 'both are changes of this work');
    assert.deepEqual(r.db.schemaServices, ['shop-api']);
    const scripts = f1.calls().filter((c) => c.stdin.includes('\nGO'));
    assert.equal(scripts.length, 2);
    assert.match(scripts[0].stdin, /nvarchar\(80\)/);
    assert.match(scripts[1].stdin, /CREATE TABLE audit/);
    assert.ok(scripts.every((c) => c.args.includes('test_abc123')), 'only the run database is touched');

    // An unchanged migration whose table is missing from the snapshot is applied too.
    const f2 = fakeSqlcmd(path.join(h.root, 'two'), []);
    const r2 = await buildRunDb({ plan: snapshotPlan(f2.bin), migrations: [migrations[0]], repoRoots: { 'shop-api': repo }, bases: { 'shop-api': base }, seeds: [] });
    assert.equal(r2.ok, true, r2.error);
    assert.deepEqual(r2.db.migrations.map((m) => [m.id, m.changed ?? false]), [['0001_init', false]]);

    // --no-migrate / verify.db.migrateAfterSnapshot false
    const f3 = fakeSqlcmd(path.join(h.root, 'three'), ['orders']);
    const r3 = await buildRunDb({ plan: snapshotPlan(f3.bin), migrations, repoRoots: { 'shop-api': repo }, bases: { 'shop-api': base }, seeds: [], migrateAfterSnapshot: false });
    assert.equal(r3.ok, true, r3.error);
    assert.equal(r3.db.migrationsSkipped, true);
    assert.deepEqual(r3.db.migrations, []);
    assert.equal(f3.calls().filter((c) => c.stdin.includes('\nGO')).length, 0);
    assert.match(r3.notes.join('\n'), /not applied after the snapshot/);
  } finally {
    h.cleanup();
  }
});

test('buildRunDb after a snapshot: applies the unchanged ALTER, skips the held ones, honours the history table; nothing runs outside the run database', async () => {
  const h = tempHome('harness-verify-snapobj-');
  try {
    const repo = gitRepo(path.join(h.workspace, 'shop-api'), {
      'package.json': '{}',
      'db/migrations/0001_init.sql': 'CREATE TABLE orders (id int);\n',
      'db/migrations/0002_status.sql': 'ALTER TABLE orders ADD status nvarchar(20) NULL;\n',
      'db/migrations/0003_audit.sql': 'CREATE TABLE audit (id int);\n',
      'db/migrations/0004_backfill.sql': "UPDATE orders SET status = 'new';\n",
    });
    const base = headSha(repo);
    // 0003 changed since the base, but the snapshot already holds audit; 0002 is unchanged and the snapshot lacks status.
    write(path.join(repo, 'db/migrations/0003_audit.sql'), 'CREATE TABLE audit (id int, at datetime);\n');
    const migrations = [entry('0001_init', ['orders']), entry('0002_status', ['orders']), entry('0003_audit', ['audit']), entry('0004_backfill', [])];
    const f = fakeSqlcmd(path.join(h.root, 'objs'), ['orders', 'audit'], { columns: ['orders.id', 'audit.id'] });
    const r = await buildRunDb({ plan: snapshotPlan(f.bin), migrations, repoRoots: { 'shop-api': repo }, bases: { 'shop-api': base }, seeds: [] });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.db.migrations.map((m) => m.id), ['0002_status']);
    assert.match(r.notes.join('\n'), /shop-api\/0003_audit: not applied, already in the snapshot/);
    assert.match(r.notes.join('\n'), /shop-api\/0004_backfill: not applied/);
    const scripts = f.calls().filter((c) => c.stdin.includes('\nGO'));
    assert.equal(scripts.length, 1);
    assert.match(scripts[0].stdin, /ADD status/);
    assert.ok(scripts.every((c) => c.args.includes('test_abc123')));

    // A history table that records 0002 keeps it out.
    const f2 = fakeSqlcmd(path.join(h.root, 'hist'), ['orders', 'audit', '__migrations'], { columns: ['orders.id'], history: [{ id: 1, name: '0001_init.sql' }, { id: 2, name: '0002_status' }] });
    const r2 = await buildRunDb({ plan: snapshotPlan(f2.bin), migrations: migrations.slice(0, 2), repoRoots: { 'shop-api': repo }, bases: { 'shop-api': base }, seeds: [] });
    assert.equal(r2.ok, true, r2.error);
    assert.deepEqual(r2.db.migrations, []);
    assert.match(r2.notes.join('\n'), /0002_status: not applied, recorded in __migrations/);
    assert.equal(f2.calls().filter((c) => c.stdin.includes('\nGO')).length, 0);
  } finally {
    h.cleanup();
  }
});

test('a migration that fails after the snapshot stops the build and names the file', async () => {
  const h = tempHome('harness-verify-snapfail-');
  try {
    const repo = gitRepo(path.join(h.workspace, 'shop-api'), { 'package.json': '{}', 'db/migrations/0001_init.sql': 'CREATE TABLE orders (id int);\n' });
    const base = headSha(repo);
    write(path.join(repo, 'db/migrations/0002_bad.sql'), 'USE other_db;\nCREATE TABLE t (id int);\n');
    const f = fakeSqlcmd(path.join(h.root, 'bad'), ['orders']);
    const r = await buildRunDb({ plan: snapshotPlan(f.bin), migrations: [entry('0001_init', ['orders']), entry('0002_bad', ['t'])], repoRoots: { 'shop-api': repo }, bases: { 'shop-api': base }, seeds: [] });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /0002_bad\.sql was not applied/);
    assert.equal(r.db.created, true, 'the restored database is recorded so cleanup drops it');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Contract item 3: --expect-header
// ---------------------------------------------------------------------------

test('--expect-header parses the three forms', () => {
  assert.deepEqual(parseHeaderExpectation('Content-Type~text/csv'), { name: 'content-type', op: '~', value: 'text/csv' });
  assert.deepEqual(parseHeaderExpectation('X-Total=3'), { name: 'x-total', op: '=', value: '3' });
  assert.deepEqual(parseHeaderExpectation('ETag=*'), { name: 'etag', op: 'present', value: '' });
  assert.equal(parseHeaderExpectation('no operator'), null);
  assert.equal(parseHeaderExpectation('X-Total='), null);
});

test('header assertions: exact, contains, present; case-insensitive names; secret headers never record values', () => {
  const res = { headers: [['content-type', 'text/csv; charset=utf-8'], ['x-total', '3'], ['authorization', 'Bearer abc.def.ghi'], ['x-api-key', 'k-12345678901234567890']] as Array<[string, string]>, setCookie: ['sid=zzz; HttpOnly'] };
  const a = (s: string) => assertHeader(parseHeaderExpectation(s)!, res);
  assert.equal(a('Content-Type~text/csv').pass, true);
  assert.equal(a('CONTENT-TYPE~application/json').pass, false);
  assert.equal(a('X-Total=3').pass, true);
  assert.equal(a('x-total=4').pass, false);
  assert.equal(a('X-Missing=*').pass, false);
  assert.equal(a('X-Missing=*').actual, 'absent');
  assert.equal(a('Set-Cookie=*').pass, true, 'Set-Cookie is present through the cookie list');
  assert.equal(a('Authorization=*').pass, true);
  const exact = a('Authorization=Bearer abc.def.ghi');
  assert.equal(exact.pass, true);
  assert.ok(!JSON.stringify(exact).includes('abc.def.ghi'), 'the value is not recorded');
  assert.ok(!JSON.stringify(a('X-Api-Key~k-1234')).includes('k-1234'));
  assert.ok(!JSON.stringify(a('Set-Cookie~sid=zzz')).includes('zzz'));
  assert.equal(a('X-Total=3').kind, 'header');
});

test('header assertions record the actual value only for safe header names; other names record matched / not matched', () => {
  const res = { headers: [['content-type', 'text/csv'], ['x-ratelimit-remaining', '41'], ['x-internal-user', 'alice@example.com'], ['x-total', '3']] as Array<[string, string]>, setCookie: [] as string[] };
  const a = (s: string) => assertHeader(parseHeaderExpectation(s)!, res);
  assert.equal(a('Content-Type~text/').actual, 'text/csv');
  assert.equal(a('X-RateLimit-Remaining=41').actual, '41');
  assert.equal(a('X-Internal-User~alice').actual, 'matched');
  assert.equal(a('X-Internal-User=bob').actual, 'not matched');
  assert.equal(a('X-Internal-User=bob').pass, false);
  assert.equal(a('X-Total=3').actual, 'matched');
  assert.equal(a('X-Missing~z').actual, 'absent');
  assert.equal(a('X-Internal-User=*').actual, 'present');
  assert.ok(!JSON.stringify([a('X-Internal-User~alice'), a('X-Internal-User=bob')]).includes('alice@example.com'), 'the actual value of an unlisted header is not recorded');
});

// ---------------------------------------------------------------------------
// Contract item 2: launch --db-unreachable, with a real (tiny) service
// ---------------------------------------------------------------------------

const SERVER_JS = `
const http = require('http');
http.createServer((req, res) => {
  const body = JSON.stringify({ status: 'degraded', db: process.env.DB_SERVER + ',' + process.env.DB_PORT });
  res.writeHead(503, { 'content-type': 'text/csv', 'x-total': '3', 'set-cookie': 'sid=abc; HttpOnly' });
  res.end(body);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

test('launch --db-unreachable reserves a dead port, points the services at it, marks the run and the artefacts; doctor reports it', async () => {
  const h = tempHome('harness-verify-dead-');
  const cwd = process.cwd();
  try {
    const repo = gitRepo(path.join(h.workspace, 'svc'), {
      'package.json': '{"name":"svc","scripts":{"dev":"node server.js"}}',
      'server.js': SERVER_JS,
      '.env.example': 'PORT=3000\nDB_SERVER=localhost\nDB_PORT=1433\nDB_NAME=app_test\n',
    });
    const cfg = defaultConfig({ workspaceRoot: h.workspace });
    cfg.db = signed([{ server: 'dbhost,1433', marked: 'test' }]);
    cfg.verify = { portBase: 38000 };
    saveConfig(cfg);
    process.chdir(repo);
    const ctx = resolveContext({ cwd: repo });
    const r = await launch(ctx, { noDb: true, dbUnreachable: true, readyTimeoutMs: 20_000 });
    try {
      assert.equal(r.code, 0, r.lines.join('\n'));
      const run = r.run!;
      assert.equal(run.dbUnreachable, true);
      assert.equal(run.ports.length, 2, 'one port for the service and one reserved dead port');
      assert.equal(run.unreachablePort, run.ports[1]);
      assert.equal(await listening(run.unreachablePort!), false, 'nothing listens on the reserved port');
      const svc = run.services[0];
      assert.equal(svc.launchEnv.DB_SERVER, '127.0.0.1');
      assert.equal(svc.launchEnv.DB_PORT, String(run.unreachablePort));
      assert.equal(svc.ready, true, 'a 503 answer counts as the service answering');
      assert.match(r.lines.join('\n'), /Database deliberately unreachable \(--db-unreachable\)/);
      const envText = fs.readFileSync(path.join(h.harnessHome, 'runs', ctx.repoId!, ctx.taskId, 'run.env'), 'utf8');
      assert.match(envText, new RegExp(`DB_PORT=${run.unreachablePort}`));

      const d = await doctor(ctx, loadRun(ctx.repoId!, ctx.taskId));
      assert.equal(d.code, 0, JSON.stringify(d.checks));
      assert.ok(d.checks.some((c) => c.status === 'warn' && /database deliberately unreachable \(--db-unreachable\)/.test(c.detail)));
      assert.ok(!d.checks.some((c) => c.status === 'fail'));

      // drive: status 503 and the three header forms; the artefact carries dbUnreachable and the header assertions.
      const base = { method: 'GET', path: '/anything', params: {}, query: {}, headers: {}, expectJson: [], expectBody: [], expectPms: {} };
      const d1 = await drive(ctx, loadRun(ctx.repoId!, ctx.taskId)!, { ...base, expectStatus: 503, expectHeader: ['Content-Type~text/csv', 'X-TOTAL=3', 'Set-Cookie=*'] });
      assert.equal(d1.code, 0, d1.lines.join('\n'));
      assert.equal(d1.artefact?.dbUnreachable, true);
      assert.deepEqual(d1.artefact?.assertions.map((a) => a.kind), ['status', 'header', 'header', 'header']);
      assert.match(d1.lines.join('\n'), /ok\s+header: expected content-type contains text\/csv/);
      const text = fs.readFileSync(d1.files![0], 'utf8');
      assert.equal(JSON.parse(text).dbUnreachable, true);
      assert.ok(!text.includes('sid=abc'), 'the cookie value is not recorded');

      const d2 = await drive(ctx, loadRun(ctx.repoId!, ctx.taskId)!, { ...base, expectHeader: ['Content-Type~application/json'] });
      assert.equal(d2.code, 1);
      assert.match(d2.lines.join('\n'), /FAIL header/);
      const d3 = await drive(ctx, loadRun(ctx.repoId!, ctx.taskId)!, { ...base, expectHeader: ['not a header expectation'] });
      assert.equal(d3.code, 2);
      const d4 = await drive(ctx, loadRun(ctx.repoId!, ctx.taskId)!, { ...base, expectHeader: ['Authorization Bearer abcdefghijklmnopqrstuvwxyz0123456789'] });
      assert.equal(d4.code, 2);
      assert.ok(!d4.lines.join('\n').includes('Bearer abc'), 'a malformed expectation is echoed for its first 20 characters only');
      assert.match(d4.lines.join('\n'), /--expect-header Authorization Bearer: /);
    } finally {
      await cleanup(ctx, loadRun(ctx.repoId!, ctx.taskId) ?? r.run!);
    }
  } finally {
    process.chdir(cwd);
    h.cleanup();
  }
});

test('launch --db-unreachable gives the dead port to the entry service only; a dependency service keeps its own database settings', async () => {
  const h = tempHome('harness-verify-deadsplit-');
  const cwd = process.cwd();
  try {
    gitRepo(path.join(h.workspace, 'catalog'), {
      'package.json': '{"name":"catalog","scripts":{"dev":"node server.js"}}',
      'server.js': SERVER_JS,
      '.env.example': 'PORT=3001\nDB_SERVER=localhost\nDB_PORT=1433\nDB_NAME=app_test\n',
    });
    const front = gitRepo(path.join(h.workspace, 'front'), {
      'package.json': '{"name":"front","scripts":{"dev":"node server.js"}}',
      'server.js': SERVER_JS,
      '.env.example': 'PORT=3000\nDB_SERVER=localhost\nDB_PORT=1433\nDB_NAME=app_test\nCATALOG_API_URL=http://localhost:3001\n',
    });
    const cfg = defaultConfig({ workspaceRoot: h.workspace });
    cfg.db = signed([{ server: 'dbhost,1433', marked: 'test' }]);
    cfg.verify = { portBase: 38200 };
    saveConfig(cfg);
    process.chdir(front);
    const ctx = resolveContext({ cwd: front });
    const r = await launch(ctx, { noDb: true, dbUnreachable: true, services: ['front'], readyTimeoutMs: 20_000 });
    try {
      assert.equal(r.code, 0, r.lines.join('\n'));
      const run = r.run!;
      const by = (n: string) => run.services.find((s) => s.name === n)!;
      assert.equal(by('front').role, 'entry');
      assert.equal(by('catalog').role, 'dependency');
      assert.equal(by('front').launchEnv.DB_PORT, String(run.unreachablePort));
      assert.equal(by('front').launchEnv.DB_SERVER, '127.0.0.1');
      assert.notEqual(by('catalog').launchEnv.DB_PORT, String(run.unreachablePort), 'the dependency does not get the dead port');
      assert.deepEqual(run.unreachableServices, ['front']);
      const text = r.lines.join('\n');
      assert.match(text, /where nothing listens, for front; dependency services keep the real run database/);
      assert.ok(run.notes.some((n) => /dead port went to front; dependency service\(s\) catalog keep the real run database/.test(n)));
    } finally {
      await cleanup(ctx, loadRun(ctx.repoId!, ctx.taskId) ?? r.run!);
    }
  } finally {
    process.chdir(cwd);
    h.cleanup();
  }
});
