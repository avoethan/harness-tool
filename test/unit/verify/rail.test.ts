import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { DbConfig, DbTarget } from '../../../src/types';
import { hashJson } from '../../../src/lib/hash';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import {
  allowlistReady,
  checkRecipeSql,
  checkSelectOnly,
  chooseTransport,
  displayCommand,
  guardCheck,
  parameterised,
  parseDockerPs,
  quoteIdent,
  serviceServerCheck,
  sqlcmdArgv,
  type Transport,
} from '../../../src/verify/sqlcmd';
import { planDb, dropRunDb } from '../../../src/verify/dbrun';
import { doctor } from '../../../src/verify/doctor';
import { resolveContext, type VerifyRun } from '../../../src/verify/state';
import { cleanup } from '../../../src/verify/cleanup';
import { main } from '../../../src/commands/verify';
import { gitRepo, tempHome } from '../lifecycle/helpers';

function signed(allowlist: DbTarget[]): DbConfig {
  return { allowlist, markedHash: hashJson(allowlist) };
}

const DOCKER: Transport = { mode: 'docker', docker: '/usr/bin/docker', container: 'sql-test', sqlcmd: '/opt/mssql-tools18/bin/sqlcmd', innerServer: 'localhost' };
const LOCAL: Transport = { mode: 'local', sqlcmd: '/usr/bin/sqlcmd', innerServer: 'dbhost,1433' };
const LOGIN = { user: 'sa', passwordEnv: 'PW' };

test('an empty or unsigned allowlist refuses every database step with the marking instruction', () => {
  for (const db of [{ allowlist: [] } as DbConfig, { allowlist: [{ server: 'dbhost', marked: 'test' }], markedHash: 'stale' } as DbConfig]) {
    const r = allowlistReady(db);
    assert.equal(r.ok, false);
    assert.match(r.reason, /harness db mark/);
    assert.equal(guardCheck(LOCAL, 'test_abc123', LOGIN, db).ok, false);
    assert.equal(serviceServerCheck('dbhost,1433', 'test_abc123', db).ok, false);
  }
  const p = planDb({ vcfg: {}, db: { allowlist: [] }, runId: 'abc123' });
  assert.equal(p.ok, false);
  assert.equal(p.rail, true);
  assert.match(p.reason ?? '', /No test database is marked yet/);
});

test('the guard judges the exact sqlcmd line: the container must be marked test; not-test and unmarked are refused', () => {
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'sql-test', marked: 'test' }])).ok, true);
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'other', marked: 'test' }])).ok, false);
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'sql-test', marked: 'not-test' }])).ok, false);
  assert.equal(guardCheck(LOCAL, 'test_abc123', LOGIN, signed([{ server: 'dbhost,1433', marked: 'test' }])).ok, true);
  assert.equal(guardCheck(LOCAL, 'test_abc123', LOGIN, signed([{ server: 'dbhost', database: 'shop_test', marked: 'test' }])).ok, false, 'a database-scoped entry does not cover test_<runid>');
  // the password is never on the command line
  const argv = sqlcmdArgv(DOCKER, 'test_abc123', LOGIN, { query: 'SELECT 1' });
  assert.ok(argv.includes('SQLCMDPASSWORD') && !argv.some((a) => a.startsWith('SQLCMDPASSWORD=')));
  assert.ok(!argv.includes('-P'));
  assert.match(displayCommand(DOCKER, 'test_abc123', LOGIN, 'SELECT 1'), /^docker exec -i -e SQLCMDPASSWORD sql-test \/opt\/mssql-tools18\/bin\/sqlcmd -S localhost -d test_abc123 -U sa/);
});

test('the docker transport is covered by a marked localhost,<port> the container publishes (and by nothing wider)', () => {
  const c = { name: 'sql-test', image: 'mcr.microsoft.com/mssql/server:2022-latest', hostPorts: ['14333'] };
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'localhost,14333', marked: 'test' }]), c).ok, true);
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: '127.0.0.1,14333', marked: 'test' }]), c).ok, true);
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'localhost,14333', marked: 'test' }])).ok, false, 'without the container facts the guard alone decides');
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'localhost,1433', marked: 'test' }]), c).ok, false, 'another port is another server');
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'localhost,14333', marked: 'not-test' }]), c).ok, false);
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'localhost,14333', database: 'shop_test', marked: 'test' }]), c).ok, false, 'a database-scoped entry does not cover test_<runid>');
  assert.equal(guardCheck(DOCKER, 'test_abc123', LOGIN, signed([{ server: 'localhost,14333', marked: 'test' }]), { ...c, name: 'other' }).ok, false, 'the facts must be about the container the command names');
  assert.equal(guardCheck(LOCAL, 'test_abc123', LOGIN, signed([{ server: 'localhost,14333', marked: 'test' }]), c).ok, false, 'the local transport is judged as typed');
});

test('planDb: install marked localhost,1433 and sqlcmd is reached through the container publishing 1433 (integration finding)', () => {
  const c = { name: 'shop-mssql', image: 'mcr.microsoft.com/mssql/server:2022-latest', hostPorts: ['1433'] };
  const deps = { which: (cmd: string) => (cmd === 'docker' ? '/usr/bin/docker' : null), containers: () => [c] };
  const p = planDb({ vcfg: {}, db: signed([{ server: 'localhost,1433', marked: 'test' }]), runId: 'abc123', deps });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.plan?.server, 'localhost,1433');
  assert.equal(p.plan?.transport.mode, 'docker');
  assert.equal(p.plan?.database, 'test_abc123');
  const other = planDb({ vcfg: {}, db: signed([{ server: 'localhost,1444', marked: 'test' }]), runId: 'abc123', deps });
  assert.equal(other.ok, false);
  assert.equal(other.rail, true);
});

test('the services\' server: marked directly, or the published port of the marked container', () => {
  const c = { name: 'sql-test', image: 'mcr.microsoft.com/mssql/server:2022-latest', hostPorts: ['14333'] };
  assert.equal(serviceServerCheck('localhost,14333', 'test_abc123', signed([{ server: 'sql-test', marked: 'test' }]), c).ok, true);
  assert.equal(serviceServerCheck('localhost,1433', 'test_abc123', signed([{ server: 'sql-test', marked: 'test' }]), c).ok, false);
  assert.equal(serviceServerCheck('localhost,1433', 'test_abc123', signed([{ server: 'localhost,1433', marked: 'test' }])).ok, true);
  const r = serviceServerCheck('prod-sql', 'test_abc123', signed([{ server: 'prod-sql', marked: 'not-test' }, { server: 'localhost', marked: 'test' }]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not-test/);
});

test('agent queries are one read-only SELECT on the run database; recipes may not leave it', () => {
  const db = 'test_abc123';
  assert.equal(checkSelectOnly('SELECT id, status FROM dbo.orders WHERE id = @id', db), null);
  assert.equal(checkSelectOnly("WITH x AS (SELECT 1 AS a) SELECT a FROM x;", db), null);
  assert.equal(checkSelectOnly("SELECT ';' AS s, o.id FROM dbo.orders o", db), null);
  // The guard's read-only classifier has the last word: a three-part column name reads like another database.
  assert.match(checkSelectOnly("SELECT ';' AS s, dbo.orders.id FROM dbo.orders", db) ?? '', /three-part name/);
  assert.match(checkSelectOnly('DELETE FROM dbo.orders', db) ?? '', /only a SELECT/);
  assert.match(checkSelectOnly('SELECT 1; DROP TABLE dbo.orders', db) ?? '', /one statement/);
  assert.match(checkSelectOnly('SELECT name FROM master.sys.databases', db) ?? '', /another database/);
  assert.match(checkSelectOnly('SELECT * FROM OPENROWSET(BULK \'x\', SINGLE_CLOB) AS t', db) ?? '', /OPENROWSET/i);
  assert.match(checkSelectOnly(':connect prod\nSELECT 1', db) ?? '', /directives/);
  assert.match(checkSelectOnly('SELECT * INTO #t FROM dbo.orders', db) ?? '', /INTO/);
  assert.equal(checkRecipeSql("INSERT INTO dbo.users (email) VALUES (N'e2e@example.com')", db), null);
  assert.match(checkRecipeSql('USE shop_prod; DELETE FROM dbo.orders', db) ?? '', /another database/);
  assert.match(checkRecipeSql('EXEC xp_cmdshell \'dir\'', db) ?? '', /xp_cmdshell/);
  assert.match(checkRecipeSql('DROP DATABASE shop_test', db) ?? '', /drop database/i);
});

test('parameterised statements, quoted identifiers, docker ps parsing, transport choice', () => {
  assert.equal(parameterised('SELECT 1 WHERE a = @p0 AND b = @p1', ["O'Brien", 5]), "EXEC sp_executesql N'SELECT 1 WHERE a = @p0 AND b = @p1', N'@p0 nvarchar(max), @p1 bigint', @p0 = N'O''Brien', @p1 = 5");
  assert.equal(quoteIdent('dbo.orders'), '[dbo].[orders]');
  assert.throws(() => quoteIdent('orders]; DROP TABLE x--'));
  const ps = parseDockerPs('sql-test\tmcr.microsoft.com/mssql/server:2022-latest\t0.0.0.0:14333->1433/tcp, [::]:14333->1433/tcp\nweb\tnginx\t0.0.0.0:80->80/tcp\n');
  assert.deepEqual(ps[0], { name: 'sql-test', image: 'mcr.microsoft.com/mssql/server:2022-latest', hostPorts: ['14333'] });
  const containers = () => parseDockerPs('a\tmcr.microsoft.com/mssql/server:2022-latest\t0.0.0.0:1433->1433/tcp\nb\tmcr.microsoft.com/mssql/server:2019\t0.0.0.0:1533->1433/tcp\n');
  const noSqlcmd = (c: string) => (c === 'docker' ? '/usr/bin/docker' : null);
  assert.equal(chooseTransport({}, 'localhost,1533', { which: noSqlcmd, containers }).container?.name, 'b');
  assert.equal(chooseTransport({}, undefined, { which: noSqlcmd, containers }).ok, false, 'two containers and no hint: ask for verify.db.container');
  assert.equal(chooseTransport({ db: { container: 'a' } }, undefined, { which: noSqlcmd, containers }).transport?.container, 'a');
  assert.equal(chooseTransport({}, 'h,1', { which: (c) => (c === 'sqlcmd' ? '/bin/sqlcmd' : null), containers }).transport?.mode, 'local');
  // never drops anything but test_<runid>
  assert.equal(dropRunDb({ transport: LOCAL, database: 'shop_test', login: LOGIN, mode: 'per-run' }).ok, false);
  assert.equal(dropRunDb({ transport: LOCAL, database: 'shop_test', login: LOGIN, mode: 'existing' }).skipped !== undefined, true);
});

test('verify doctor with an empty allowlist refuses (exit 4) with the marking instruction', async () => {
  const h = tempHome('harness-verify-doctor-');
  const cwd = process.cwd();
  const writes: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  try {
    const repo = gitRepo(path.join(h.workspace, 'svc'), { 'package.json': '{"scripts":{"dev":"node x.js"}}', '.env.example': 'PORT=3000\nDB_NAME=app_test\n' });
    saveConfig(defaultConfig({ workspaceRoot: h.workspace }));
    const ctx = resolveContext({ cwd: repo });
    const r = await doctor(ctx, null);
    assert.equal(r.code, 4);
    assert.match(r.checks[0].detail, /No test database is marked yet.*harness db mark/);
    process.chdir(repo);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => (writes.push(String(s)), true);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => (writes.push(String(s)), true);
    const code = await main(['doctor']);
    const launchCode = await main(['launch']);
    // cleanup of a run whose launch failed before its database existed: nothing to drop, no sqlcmd call, exit 0
    const run: VerifyRun = {
      version: 1, runId: 'abc123', repoId: ctx.repoId!, taskId: ctx.taskId, repoRoot: repo, workspaceRoot: h.workspace, entry: 'svc',
      services: [], ports: [], createdAt: new Date().toISOString(), status: 'partial', notes: [],
      db: { server: 'localhost,1433', host: 'localhost', port: '1433', database: 'test_abc123', mode: 'per-run', transport: 'docker', container: 'nowhere', created: false, source: 'migrations', seed: null, migrations: [], schemaServices: [] } as VerifyRun['db'],
    };
    const cl = await cleanup(ctx, run);
    assert.equal(cl.code, 0, cl.lines.join('\n'));
    assert.match(cl.lines.join('\n'), /test_abc123 was never created by this run; nothing to drop/);
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    assert.equal(code, 4);
    assert.equal(launchCode, 4, 'launch refuses before starting anything');
    assert.match(writes.join(''), /harness db mark/);
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    process.chdir(cwd);
    h.cleanup();
  }
});
