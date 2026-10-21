/** I: SQL probes run only where the repository has SQL, and the report says when they were skipped. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDiscover } from '../../../src/discover/index';
import { inventoryWorkspace } from '../../../src/discover/inventory';
import { sqlGate } from '../../../src/discover/domains';
import { findAstGrep } from '../../../src/discover/astgrep';
import { which } from '../../../src/lib/exec';
import { makeRepo, tempEnv, writeTree } from './helpers';

test('I: the SQL gate looks for a SQL file, a SQL client or a SQL statement in non-test code', (t) => {
  if (!which('git')) {
    t.skip('git is not available on PATH');
    return;
  }
  const env = tempEnv();
  try {
    const gate = (name: string, files: Record<string, string>) => {
      const dir = path.join(env.workspace, name);
      writeTree(dir, { 'package.json': '{"name":"x"}\n', ...files });
      return sqlGate(inventoryWorkspace(dir, {}));
    };
    const none = gate('none', { 'src/a.ts': "describe('select the cards from the deck', () => { it('works', () => {}) })\n", 'src/a.test.ts': "db.query('SELECT id FROM t')\n" });
    assert.equal(none.present, false, 'a test-only statement and prose are not SQL');
    assert.equal(gate('dep', { 'package.json': '{"name":"x","dependencies":{"knex":"^3"}}\n' }).present, true);
    assert.equal(gate('file', { 'db/001.sql': 'CREATE TABLE t (id INT);\n' }).present, true);
    assert.equal(gate('import', { 'src/db.ts': "import { Pool } from 'pg'\nexport const pool = new Pool()\n" }).present, true);
    assert.equal(gate('literal', { 'src/q.ts': "export const q = (db: any) => db.run('SELECT id, name FROM items WHERE id = ?', [1])\n" }).present, true);
  } finally {
    env.cleanup();
  }
});

test('I: sql probes are skipped in a repository without SQL, and the report says so', async (t) => {
  if (!which('git') || !findAstGrep()) {
    t.skip('git or ast-grep is not available');
    return;
  }
  const env = tempEnv();
  try {
    const call = (name: string) => `describe('${name}', () => {\n  it('select the rows from the table', () => {\n    expect(1).toBe(1)\n  })\n})\n`;
    const files: Record<string, string> = { 'package.json': '{"name":"nosql"}\n' };
    for (let i = 0; i < 12; i++) files[`src/m${i}.ts`] = `export const m${i} = ${i}\n`;
    for (let i = 0; i < 12; i++) files[`src/m${i}.test.ts`] = call(`m${i} select all from here`);
    const dir = path.join(env.workspace, 'nosql');
    makeRepo(dir, files, ['chore: init']);
    const res = await runDiscover({ root: dir, exec: false });
    assert.ok(!res.ledger.records.some((r) => r.id.startsWith('sql.')), 'no sql record');
    const f = res.findings.find((x) => x.kind === 'probes-skipped');
    assert.ok(f, 'skip recorded in the findings');
    assert.match(f!.message, /^sql probes skipped: no SQL in the repository/);
    assert.ok(f!.message.includes('sql.sql-text-literal'));
    const md = fs.readFileSync(path.join(env.harnessHome, 'ledger', 'discover.md'), 'utf8');
    assert.match(md, /sql probes skipped: no SQL in the repository/);
    const json = JSON.parse(fs.readFileSync(path.join(env.harnessHome, 'ledger', 'findings.json'), 'utf8')) as { findings: Array<{ kind: string }> };
    assert.ok(json.findings.some((x) => x.kind === 'probes-skipped'));
  } finally {
    env.cleanup();
  }
});

test('I: with a SQL client in the repository the sql probes run and nothing is reported skipped', async (t) => {
  if (!which('git') || !findAstGrep()) {
    t.skip('git or ast-grep is not available');
    return;
  }
  const env = tempEnv();
  try {
    const files: Record<string, string> = { 'package.json': '{"name":"withsql","dependencies":{"mssql":"^11"}}\n' };
    for (let i = 0; i < 12; i++) files[`src/q${i}.ts`] = `export const q${i} = (db: any) => db.query('SELECT id, name FROM dbo.items WHERE id = @id', { id: ${i} })\n`;
    const dir = path.join(env.workspace, 'withsql');
    makeRepo(dir, files, ['chore: init']);
    const res = await runDiscover({ root: dir, exec: false, write: false });
    assert.ok(res.ledger.records.some((r) => r.id === 'sql.sql-text-literal'), res.ledger.records.map((r) => r.id).join(', '));
    assert.ok(!res.findings.some((x) => x.kind === 'probes-skipped'));
  } finally {
    env.cleanup();
  }
});
