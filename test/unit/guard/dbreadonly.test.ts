/**
 * The database rail for targets marked `read-only`: only inline SQL that the
 * read-only classifier proves reads is allowed; everything else on such a
 * target is denied with a reason that names the mark and the offending word.
 * Also the shared-server rule for test targets beside read-only databases.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { baseInput, run, signedDb } from './helpers';
import { classifyTarget, matchAllowlist } from '../../../src/guard/db';
import { classifyReadOnlySql, READ_ONLY_FORBIDDEN } from '../../../src/guard/sqlreadonly';
import type { DbTarget } from '../../../src/types';

const RO_LIST: DbTarget[] = [
  { server: 'sql-test', marked: 'test' },
  { server: 'ro-srv', database: 'reports', marked: 'read-only' },
  { server: 'ro-wide', marked: 'read-only' },
  { server: 'shared', marked: 'test' },
  { server: 'shared', database: 'prod', marked: 'read-only' },
  { server: 'sql-prod', marked: 'not-test' },
  { server: 'dbtest', database: 'app_test', marked: 'test' },
];

const extra = { config: { db: signedDb(RO_LIST), mcp: { allowedServers: {} } } };
const ro = (cmd: string) => run(cmd, 'personal', extra);
const RO = 'sqlcmd -S ro-srv -d reports';

function allowAll(cmds: string[]): void {
  const bad = cmds.map((c) => [c, ro(c)] as const).filter(([, r]) => r.decision !== 'allow');
  assert.deepEqual(bad.map(([c, r]) => `${c} -> ${r.rail}: ${r.reason}`), []);
}

function denyAll(cmds: string[], match?: RegExp): void {
  const bad: string[] = [];
  for (const c of cmds) {
    const r = ro(c);
    if (r.decision !== 'deny' || r.rail !== 'db') bad.push(`${c} -> ${r.decision} ${r.rail}: ${r.reason}`);
    else if (match && !match.test(r.reason)) bad.push(`${c} -> reason ${r.reason}`);
  }
  assert.deepEqual(bad, []);
}

// ---------------------------------------------------------------------------
// The brief's cases
// ---------------------------------------------------------------------------

test('read-only: plain reads are allowed', () => {
  allowAll([
    `${RO} -Q "SELECT TOP 5 * FROM dbo.t"`,
    `${RO} -Q "WITH x AS (SELECT 1 a) SELECT a FROM x"`,
    `${RO} -Q "SELECT id FROM dbo.t WHERE note = 'please delete me'"`,
    `${RO} -Q "SELECT * FROM reports.dbo.t"`,
    `${RO} -Q "SELECT * FROM [Reports].[dbo].[t]"`,
    `${RO} -Q "select top 5 * from dbo.t"`,
    `${RO} -Q "SELECT 1; SELECT 2;"`,
    `${RO} -Q ";WITH x AS (SELECT 1 a) SELECT a FROM x"`,
    `${RO} -Q "SELECT [delete], \\"update\\" FROM dbo.t WITH (NOLOCK)"`,
    `${RO} -Q "SELECT id FROM dbo.t ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY"`,
    `${RO} -Q "SELECT ';DELETE FROM t' AS a"`,
    `${RO} -Q "SELECT 1 -- delete everything later"`,
    `${RO} -Q "SELECT geography::Point(1, 2, 4326) AS p"`,
    `${RO} -E -b -W -C -Q "SELECT 1"`,
    `${RO} -U app -P "$PW" -Q "SELECT 1" -o /tmp/out.txt`,
    `${RO} <<< "SELECT 1"`,
    `sqlcmd -S ro-wide -Q "SELECT 1"`,
    `sqlcmd -S ro-wide -d any -Q "SELECT * FROM any.dbo.t"`,
    `osql -S ro-srv -d reports -E -Q "SELECT 1"`,
    `mssql-cli -S ro-srv -d reports -Q "SELECT 1"`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query 'SELECT TOP 5 * FROM dbo.t'`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query 'SELECT 1' -TrustServerCertificate`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query @'\nSELECT TOP 5 *\nFROM dbo.t\n'@`,
    `Invoke-DbaQuery -SqlInstance ro-srv -Database reports -Query "SELECT 1"`,
    `pwsh -c "Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query 'SELECT 1'"`,
    `bash -c "sqlcmd -S ro-srv -d reports -Q 'SELECT 1'"`,
  ]);
});

test('read-only: every forbidden word is denied, as the first word and inside a SELECT, naming the word', () => {
  const misses: string[] = [];
  for (const w of READ_ONLY_FORBIDDEN) {
    for (const sql of [`SELECT 1; ${w} x`, `SELECT 1 ${w} x`]) {
      const r = ro(`${RO} -Q "${sql}"`);
      if (r.decision !== 'deny' || r.rail !== 'db') misses.push(`${sql} -> ${r.decision}`);
    }
    const r2 = ro(`${RO} -Q "SELECT 1 ${w.toLowerCase()} x"`);
    if (r2.decision !== 'deny') misses.push(`lower ${w} -> allow`);
  }
  // sp_/xp_ calls, mixed case
  for (const sql of ['EXEC sp_who', 'SELECT 1; sp_who', 'SELECT 1; Xp_CmdShell', 'SELECT * FROM [sp_x]', 'eXeC sp_who']) {
    const r = ro(`${RO} -Q "${sql}"`);
    if (r.decision !== 'deny') misses.push(`${sql} -> allow`);
  }
  assert.deepEqual(misses, []);
  // The reason names the mark and the offending word, never the statement.
  const r = ro(`${RO} -Q "SELECT secret_col FROM dbo.t; DELETE FROM dbo.t WHERE x = 'tok123'"`);
  assert.equal(r.decision, 'deny');
  assert.equal(r.rail, 'db');
  assert.match(r.reason, /^ro-srv\/reports is marked read-only: this statement could write \(DELETE\); stop and ask the user to run it or approve it\.$/);
  assert.doesNotMatch(r.reason, /secret_col|tok123|dbo\.t/);
});

test('read-only: the brief\'s denied shapes', () => {
  denyAll(
    [
      `${RO} -Q "SELECT a INTO dbo.copy FROM dbo.t"`,
      `${RO} -Q "SELECT 1; DELETE FROM t"`,
      `${RO} -Q "SELECT 1\nGO\nUPDATE t SET a = 1"`,
      `${RO} -Q "SELECT * FROM otherdb.dbo.t"`,
      `${RO} -Q "SELECT * FROM otherdb..t"`,
      `${RO} -Q "SELECT * FROM [otherdb].dbo.t"`,
      `${RO} -Q "SELECT * FROM srv.reports.dbo.t"`,
      `${RO} -Q ":connect sql-prod"`,
      `${RO} -Q "SELECT 1\n:connect sql-prod\nSELECT 2"`,
      `${RO} -Q "EXEC sp_who"`,
      `${RO} -Q "DECLARE @s nvarchar(max)='DELETE FROM t'; EXEC(@s)"`,
      `${RO} -Q "SELECT NEXT VALUE FOR dbo.seq"`,
      `${RO} -Q "SELECT 1 WAITFOR DELAY '00:00:05'"`,
      `${RO} -Q "SELECT 1 CHECKPOINT"`,
      `${RO} -Q "SELECT 1; EXEC sp_executesql N'DELETE FROM t'"`,
      `${RO} -Q "WITH x AS (SELECT 1 a) DELETE FROM x"`,
      `${RO} -Q "SELECT 1 END CONVERSATION @h"`,
    ],
    /is marked read-only: this statement could write \(/,
  );
  // Script files, piped input, heredocs, interactive sessions and unresolved targets stay denied (some by the rule they hit today).
  denyAll([
    `${RO} -i file.sql`,
    `${RO} < file.sql`,
    `cat q.sql | ${RO}`,
    `echo "SELECT 1" | ${RO}`,
    `${RO} <<'EOF'\nSELECT 1\nEOF`,
    `${RO}`,
    `${RO} -q "SELECT 1"`,
    `sqlcmd -S "$X" -d reports -Q "SELECT 1"`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -InputFile q.sql`,
    `Invoke-DbaQuery -SqlInstance ro-srv -Database reports -File q.sql`,
  ]);
});

test('read-only: an unsigned allowlist denies reads; not-test still denies reads; test keeps writes', () => {
  const unsigned = run(`${RO} -Q "SELECT 1"`, 'personal', { config: { db: { allowlist: RO_LIST }, mcp: { allowedServers: {} } } });
  assert.equal(unsigned.decision, 'deny');
  assert.match(unsigned.reason, /not signed/);
  const tampered = run(`${RO} -Q "SELECT 1"`, 'personal', { config: { db: { allowlist: RO_LIST.map((e) => ({ ...e, marked: 'read-only' as const })), markedHash: signedDb(RO_LIST).markedHash }, mcp: { allowedServers: {} } } });
  assert.equal(tampered.decision, 'deny');
  assert.equal(ro('sqlcmd -S sql-prod -Q "SELECT 1"').decision, 'deny');
  assert.match(ro('sqlcmd -S sql-prod -Q "SELECT 1"').reason, /not-test/);
  assert.equal(ro('sqlcmd -S unknown-srv -Q "SELECT 1"').decision, 'deny');
  assert.equal(ro('sqlcmd -S sql-test -Q "DELETE FROM t"').decision, 'allow');
  assert.equal(ro('sqlcmd -S sql-test -i seed.sql').decision, 'deny');
  assert.equal(ro(`sqlcmd -S sql-test <<'EOF'\nINSERT INTO t VALUES (1);\nEOF`).decision, 'allow');
});

test('read-only: a command that mixes a test and a read-only target applies the read-only rule to the whole command', () => {
  // SQLCMDSERVER names the test server, -S the read-only one: two targets in one command.
  const write = ro('SQLCMDSERVER=sql-test sqlcmd -S ro-srv -d reports -Q "DELETE FROM t"');
  assert.equal(write.decision, 'deny');
  assert.match(write.reason, /ro-srv\/reports is marked read-only/);
  assert.equal(ro('SQLCMDSERVER=sql-test sqlcmd -S ro-srv -d reports -Q "SELECT 1"').decision, 'allow');
  // A not-test target beside a read-only one still denies the whole command.
  assert.equal(ro('SQLCMDSERVER=sql-prod sqlcmd -S ro-srv -d reports -Q "SELECT 1"').decision, 'deny');
});

// ---------------------------------------------------------------------------
// Bypasses considered
// ---------------------------------------------------------------------------

test('read-only bypasses: comments, literals, brackets, batch separators, case', () => {
  denyAll([
    `${RO} -Q "SEL/**/ECT 1"`,
    `${RO} -Q "SELECT 1 /* x */ ; DELETE FROM t"`,
    `${RO} -Q "SELECT 1 --\nDELETE FROM t"`,
    `${RO} -Q "SELECT 1 /* /* */ DELETE FROM t */"`,
    `${RO} -Q "SELECT 1 /* unclosed"`,
    `${RO} -Q "SELECT 'unclosed"`,
    `${RO} -Q "SELECT [unclosed"`,
    `${RO} -Q "SELECT 'a\nGO\nDELETE FROM t\n'"`,
    `${RO} -Q "SELECT 1 /*\nGO\n*/"`,
    `${RO} -Q "SELECT 1\nGO 5"`,
    `${RO} -Q "SELECT 1\ngo\ndelete from t"`,
    `${RO} -Q "SELECT 1\n  GO  \n  UPDATE t SET a = 1"`,
    `${RO} -Q "select 1; DeLeTe from t"`,
    `${RO} -Q "SELECT 1 FROM t; -- only a comment\nTRUNCATE TABLE t"`,
    `${RO} -Q "lbl: SELECT 1"`,
    `${RO} -Q "SELECT 1 !! rm -rf /"`,
    `${RO} -Q "/* only a comment */"`,
    `${RO} -Q ""`,
  ]);
});

test('read-only bypasses: Unicode look-alikes, zero-width and control characters', () => {
  denyAll([
    `${RO} -Q "SELECT 1; ＤＥＬＥＴＥ FROM t"`,
    `${RO} -Q "SELECT 1；DELETE FROM t"`,
    `${RO} -Q "SELECT N'café'"`,
    `${RO} -Q "SELECT 1 \u000b DELETE FROM t"`,
  ]);
  // Zero-width characters are refused by the guard before any rail (hidden Unicode).
  const zw = ro(`${RO} -Q "SELECT 1; DEL​ETE FROM t"`);
  assert.equal(zw.decision, 'deny');
  assert.equal(classifyReadOnlySql('SELECT 1; DEL​ETE FROM t').ok, false);
});

test('read-only bypasses: sqlcmd variables, -v, environment-provided queries, startup scripts', () => {
  denyAll([
    `${RO} -Q 'SELECT $(x)' -v x="1; DELETE FROM t"`,
    `${RO} -Q "SELECT 1" -v x=1 -Q '$(x)'`,
    `${RO} -Q "$Q"`,
    `${RO} -Q "SELECT $(cat q.sql)"`,
    `${RO} -Q \`cat q.sql\``,
    `SQLCMDINI=start.sql ${RO} -Q "SELECT 1"`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query $env:Q`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query "SELECT $x"`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query 'SELECT 1' -Variable "x=1"  -Query '$(x)'`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query @"\nSELECT $x\n"@`,
  ]);
  const r = run(`${RO} -Q "SELECT 1"`, 'personal', { ...extra, env: { ...baseInput().env, SQLCMDINI: '/tmp/start.sql' } });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /SQLCMDINI/);
});

test('read-only bypasses: extra arguments, slash flags, swallowed flags, unknown flags, other clients', () => {
  denyAll([
    `${RO} -Q "SELECT 1" /Q "DELETE FROM t"`,
    `${RO} -Q "SELECT 1" extra`,
    `${RO} -Q "SELECT 1" -h -i evil.sql`,
    `${RO} -A -Q "SELECT 1"`,
    `Invoke-Sqlcmd "DELETE FROM t" -ServerInstance ro-srv -Database reports`,
    `Invoke-DbaQuery -SqlInstance ro-srv -Database reports -Query "SELECT 1" -CommandType StoredProcedure`,
    `Invoke-Sqlcmd2 -ServerInstance ro-srv -Database reports -Query "SELECT 1"`,
    `bcp "SELECT * FROM dbo.t" queryout out.dat -S ro-srv -d reports -T -c`,
    `bcp dbo.t in data.dat -S ro-srv -d reports -T -c`,
    `sqlpackage /Action:Publish /TargetServerName:ro-srv /TargetDatabaseName:reports /SourceFile:x.dacpac`,
    `psql -h ro-wide -c "SELECT 1"`,
    `mysql -h ro-wide -e "SELECT 1"`,
    `node -e "require('mssql').connect('Server=ro-srv;Database=reports').then(p => p.query('SELECT 1'))"`,
    `DATABASE_URL=mssql://app@ro-srv:1433/reports npm test`,
    `Copy-DbaDatabase -Source ro-srv -Destination sql-test -Database reports`,
    `docker run --rm mcr.microsoft.com/mssql-tools sqlcmd -S ro-srv -d reports -i /x.sql`,
  ]);
  // A swallowed flag is refused for test targets too (the client may read it as a flag).
  assert.equal(ro('sqlcmd -S sql-test -Q "SELECT 1" -h -i evil.sql').decision, 'deny');
  // -C (trust the server certificate) takes no value: -i after it is seen as a script.
  assert.equal(ro('sqlcmd -S sql-test -Q "SELECT 1" -C -i evil.sql').decision, 'deny');
});

test('read-only bypasses: shell expansion, xargs, batch terminators, ODBC escapes, Windows argument splitting', () => {
  denyAll([
    // the shell may expand an unquoted glob or brace into other SQL (a file named "SELECT 1 ; DELETE FROM t")
    `${RO} -Q 'SELECT 1 '*`,
    `${RO} -Q SELECT\\ 1\\ {x,y}`,
    `${RO} -Q{"SELECT 1",'dbo.DeleteAll'}`,
    // xargs appends arguments the guard never sees (a second -Q, a second -S)
    `echo "-Q dbo.DeleteAll" | xargs ${RO} -Q "SELECT 1"`,
    // another batch terminator lets a procedure name start a batch; a new login password
    `${RO} -c FOO -Q "SELECT 1\nFOO\ndbo.DeleteAll"`,
    `${RO} -z newpass -Q "SELECT 1"`,
    // ODBC escapes run procedures
    `${RO} -Q "SELECT 1; {call dbo.DeleteAll}"`,
    `${RO} -Q "{call dbo.DeleteAll}"`,
    `Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query (Get-Content q.sql -Raw)`,
  ]);
  // xargs is refused for test targets too: the appended words may name another server.
  assert.equal(ro('echo "-S sql-prod" | xargs sqlcmd -S sql-test -Q "DELETE FROM t"').decision, 'deny');
  // Windows: PowerShell and cmd may split an argument with embedded quotes or a trailing backslash.
  const win = { ...extra, platform: 'win32' as const };
  for (const c of [`sqlcmd -S ro-srv -d reports -Q 'SELECT "x" -i evil.sql "y"'`, `sqlcmd -S ro-srv -d reports -Q 'SELECT 1 \\' -v 'x=1'`]) {
    const r = run(c, 'personal', win);
    assert.equal(r.decision, 'deny', `${c}: ${r.reason}`);
  }
  assert.equal(run(`sqlcmd -S ro-srv -d reports -Q "SELECT 1"`, 'personal', win).decision, 'allow');
  assert.equal(run(`Invoke-Sqlcmd -ServerInstance ro-srv -Database reports -Query 'SELECT 1'`, 'personal', win).decision, 'allow');
});

// ---------------------------------------------------------------------------
// Marks: precedence and the shared-server rule
// ---------------------------------------------------------------------------

test('classifyTarget: a database entry beats a server-wide one, the strictest wins within a scope, no database means any', () => {
  const t = (host: string, database?: string) => ({ host, database, source: 'x' });
  assert.equal(classifyTarget(t('shared', 'prod'), RO_LIST).mark, 'read-only');
  assert.equal(classifyTarget(t('shared', 'PROD'), RO_LIST).mark, 'read-only');
  assert.equal(classifyTarget(t('shared', 'app'), RO_LIST).mark, 'test');
  assert.equal(classifyTarget(t('shared'), RO_LIST).mark, 'read-only', 'the default database may be prod');
  assert.equal(classifyTarget(t('ro-srv', 'reports'), RO_LIST).mark, 'read-only');
  assert.equal(classifyTarget(t('ro-srv', 'other'), RO_LIST).why, 'database');
  assert.equal(classifyTarget(t('ro-srv'), RO_LIST).why, 'database');
  const order: DbTarget[] = [
    { server: 'h', marked: 'test' },
    { server: 'h', database: 'p', marked: 'not-test' },
  ];
  assert.equal(classifyTarget(t('h', 'p'), order).mark, 'not-test');
  assert.equal(classifyTarget(t('h'), order).mark, 'not-test');
  assert.equal(classifyTarget(t('h', 'q'), order).mark, 'test');
  const wideRo: DbTarget[] = [
    { server: 'h', marked: 'read-only' },
    { server: 'h', database: 'scratch', marked: 'test' },
  ];
  assert.equal(classifyTarget(t('h', 'scratch'), wideRo).mark, 'test');
  assert.equal(classifyTarget(t('h', 'other'), wideRo).mark, 'read-only');
  assert.equal(classifyTarget(t('h'), wideRo).mark, 'read-only');
  // matchAllowlist (verify's check) passes only test
  assert.equal(matchAllowlist(t('shared', 'prod'), RO_LIST).why, 'read-only');
  assert.equal(matchAllowlist(t('shared', 'app'), RO_LIST).ok, true);
});

test('shared server: a test database beside a read-only one cannot reach it', () => {
  assert.equal(ro('sqlcmd -S shared -d app -Q "DELETE FROM dbo.t"').decision, 'allow');
  assert.equal(ro('sqlcmd -S shared -d app -Q "INSERT INTO app.dbo.t VALUES (1)"').decision, 'allow');
  assert.equal(ro('sqlcmd -S shared -d prod -Q "SELECT 1"').decision, 'allow');
  denyAll([
    'sqlcmd -S shared -d prod -Q "DELETE FROM dbo.t"',
    'sqlcmd -S shared -Q "DELETE FROM dbo.t"',
    'sqlcmd -S shared -d app -Q "DELETE FROM prod.dbo.t"',
    'sqlcmd -S shared -d app -Q "DELETE FROM [PROD]..t"',
    'sqlcmd -S shared -d app -Q "INSERT INTO other.dbo.t VALUES (1)"',
    'sqlcmd -S shared -d app -Q "DROP DATABASE prod"',
    'sqlcmd -S shared -d app -Q "ALTER DATABASE prod SET READ_WRITE"',
    'sqlcmd -S shared -d app -Q "EXEC(\'DELETE FROM t\')"',
    'sqlcmd -S shared -d app -Q "DECLARE @s nvarchar(99) = N\'x\'; EXEC @s"',
    'sqlcmd -S shared -d app -Q "EXEC sp_executesql N\'SELECT 1\'"',
    'sqlcmd -S shared -d app -Q "EXEC sp_MSforeachdb \'DELETE FROM ?.dbo.t\'"',
    'sqlcmd -S shared -d app -Q "EXEC sp_detach_db @dbname = @d"',
    'sqlcmd -S shared -d app -Q "DBCC CHECKDB(@d, REPAIR_ALLOW_DATA_LOSS)"',
    'sqlcmd -S shared -d app -Q "CREATE ASSEMBLY a FROM 0x00"',
    'sqlcmd -S shared -d app -Q "SELECT DB_ID(\'prod\')"',
    'sqlcmd -S shared -d app -Q "SELECT 1; DELETE FROM t WHERE a = N\'ｐｒｏｄ\'"',
    'sqlcmd -S shared -d app -Q \'DELETE FROM $(db).dbo.t\'',
    'sqlcmd -S shared -d app -Q "$Q"',
    'bcp prod.dbo.t in data.dat -S shared -d app -T -c',
  ]);
  // Database names the client may read differently from the guard.
  denyAll([
    'sqlcmd -S shared -d app -d prod -Q "DELETE FROM t"',
    'sqlcmd -S shared -d "prod " -Q "DELETE FROM t"',
    'sqlcmd -S shared -d "[prod]" -Q "DELETE FROM t"',
    'sqlcmd -S shared -d prod. -Q "DELETE FROM t"',
    `Invoke-Sqlcmd -ConnectionString 'Data Source=shared;Initial Catalog=app;Database=prod' -Query "DELETE FROM t"`,
    `Invoke-Sqlcmd -ConnectionString 'Server=sql-test;Failover Partner=sql-prod;Database=a' -Query 'SELECT 1'`,
    'sqlcmd -S shared. -d app -Q "DELETE FROM t"',
    // driver code and dacpacs carry SQL the guard does not read
    `node -e "require('mssql').connect('Server=shared;Database=app').then(p => p.query('DELETE FROM prod.dbo.t'))"`,
    'sqlpackage /Action:Publish /TargetServerName:shared /TargetDatabaseName:app /SourceFile:x.dacpac',
  ]);
  // A database-scoped test entry: the other databases on that server are not test.
  assert.equal(ro('sqlcmd -S dbtest -d app_test -Q "DELETE FROM dbo.t"').decision, 'allow');
  assert.equal(ro('sqlcmd -S dbtest -d app_test -Q "DELETE FROM other.dbo.t"').decision, 'deny');
  // A server-wide test entry with nothing else on the server keeps today's behaviour.
  assert.equal(ro('sqlcmd -S sql-test -d a -Q "DELETE FROM b.dbo.t"').decision, 'allow');
});

test('classifyReadOnlySql: unit rules', () => {
  assert.equal(classifyReadOnlySql('SELECT 1').ok, true);
  assert.equal(classifyReadOnlySql('SELECT * FROM a.dbo.t', { databases: ['A'] }).ok, true);
  assert.equal(classifyReadOnlySql('SELECT * FROM a.dbo.t').ok, false);
  assert.equal(classifyReadOnlySql('SELECT 1 GO SELECT 2').ok, true);
  assert.equal(classifyReadOnlySql('SELECT 1 GO DELETE FROM t').word, 'DELETE');
  assert.equal(classifyReadOnlySql('SELECT a INTO #t FROM b').word, 'INTO');
  assert.equal(classifyReadOnlySql('UPDATE t SET a = 1').word, 'UPDATE');
  assert.equal(classifyReadOnlySql('SELECT 1 /* /* nested */ */').ok, false);
  assert.equal(classifyReadOnlySql("SELECT 'it''s' AS a").ok, true);
  assert.equal(classifyReadOnlySql('SELECT "a""b" FROM t').ok, true);
  assert.equal(classifyReadOnlySql('SELECT [a]]b] FROM t').ok, true);
  assert.equal(classifyReadOnlySql('SELECT x.c.value(1) FROM t x').ok, false, 'three parts: deny when in doubt');
  // Numbers run into words: T-SQL reads `SELECT 1DELETE FROM t` as two statements.
  for (const q of ['SELECT 1DELETE FROM t', 'SELECT 1EXEC sp_who', 'SELECT 0x00INSERT INTO t VALUES (1)', 'SELECT $1DELETE FROM t', 'SELECT 1.5e3UPDATE t SET a = 1']) {
    assert.equal(classifyReadOnlySql(q).ok, false, q);
  }
  for (const q of ['SELECT 1.5e3 AS a', 'SELECT 0x1F AS b', 'SELECT $5 AS m', 'SELECT .5 AS c', 'SELECT TOP 5 * FROM t', 'SELECT a$b FROM t']) {
    assert.equal(classifyReadOnlySql(q).ok, true, q);
  }
});
