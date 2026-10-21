/**
 * Discovery end to end over a small synthetic workspace (two git repos made
 * in a temp dir): ledger, checks, findings, db candidates, stable ids, the
 * check runner, commit-subject checks and team proposals.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDiscover } from '../../../src/discover/index';
import { runLedgerChecksDetailed, checkCommitSubjects, runLedgerChecks } from '../../../src/discover/checks';
import { proposeForTeam } from '../../../src/discover/proposals';
import { which } from '../../../src/lib/exec';
import type { Ledger } from '../../../src/types';
import { syntheticWorkspace, tempEnv, writeTree } from './helpers';

test('discover on a synthetic two-repo workspace', async (t) => {
  if (!which('git')) {
    t.skip('git is not available on PATH');
    return;
  }
  const env = tempEnv();
  try {
    const { alpha, beta } = syntheticWorkspace(env.workspace);
    const res = await runDiscover({ root: env.workspace, exec: false });
    const ids = res.ledger.records.map((r) => r.id);
    const byId = new Map(res.ledger.records.map((r) => [r.id, r]));

    // Declared and followed.
    assert.equal(byId.get('lint.eqeqeq')?.tier, 'declared');
    assert.deepEqual(byId.get('lint.eqeqeq')?.scope, { repos: ['*'] });
    // Counted conventions.
    assert.equal(byId.get('naming.ts-file-case-kebab')?.tier, 'counted-strong');
    assert.equal(byId.get('layout.driver-gateway-mssql')?.tier, 'counted-strong');
    assert.equal(byId.get('sql.sql-text-literal')?.tier, 'counted-strong');
    assert.equal(byId.get('tests.placement-mirror')?.tier, 'declared', 'vitest include declares it');
    assert.equal(byId.get('naming.commit-subjects-conventional')?.tier, 'counted-strong');
    // The scoped conflict.
    const single = byId.get('format.quotes-single');
    const double = byId.get('format.quotes-double');
    assert.ok(single && double, `quote records: ${ids.filter((i) => i.startsWith('format.')).join(', ')}`);
    assert.equal(single!.scope.repos.length, 1);
    assert.equal(double!.scope.repos.length, 1);
    assert.notEqual(single!.scope.repos[0], double!.scope.repos[0]);
    assert.equal(single!.conflicts.length, 1);
    // Declared but not followed: a finding, not a standard.
    assert.ok(!ids.some((i) => i.startsWith('lint.explicit-return-types')));
    const f = res.findings.find((x) => x.kind === 'declared-but-not-followed');
    assert.ok(f, 'declared-but-not-followed finding');
    assert.deepEqual([f!.counts?.sites, f!.counts?.conforming], [26, 14], '12 loaders per repo, half typed, plus the typed db.ts query');
    // Thresholds printed; scanners reported.
    assert.equal(res.thresholds.scale, 'small');
    assert.ok(res.ledger.scanners.some((s) => s.name === 'dependency-cruiser' && !s.available));
    // Files on disk.
    const dir = path.join(env.harnessHome, 'ledger');
    for (const f2 of ['ledger.json', 'findings.json', 'db-candidates.json', 'inventory.json', 'discover.md', 'checks/index.json', 'checks/lint.eqeqeq.json']) assert.ok(fs.existsSync(path.join(dir, f2)), `${f2} written`);
    const md = fs.readFileSync(path.join(dir, 'discover.md'), 'utf8');
    assert.match(md, /## Conflicts \(scoped, never averaged\)/);
    assert.match(md, /Declared but not followed/);
    assert.match(md, /Thresholds in use/);
    // DB candidates: host and database, never the password.
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'db-candidates.json'), 'utf8'));
    assert.deepEqual(db.candidates.map((c: { server: string; database?: string }) => [c.server, c.database]), [['localhost,1433', 'items_test']]);
    assert.ok(!fs.readFileSync(path.join(dir, 'db-candidates.json'), 'utf8').includes('Very$ecret'));
    for (const f3 of ['ledger.json', 'findings.json', 'inventory.json', 'discover.md']) assert.ok(!fs.readFileSync(path.join(dir, f3), 'utf8').includes('Very$ecret'), `${f3} has no password`);

    // Stable ids across runs.
    const res2 = await runDiscover({ root: env.workspace, exec: false });
    assert.deepEqual(res2.ledger.records.map((r) => r.id), ids);
    assert.equal(res2.ledger.records[0].history.firstSeen, res.ledger.records[0].history.firstSeen);

    // The check runner: a new file that breaks several standards.
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')) as Ledger;
    writeTree(alpha, {
      'src/lib/orderCsv.ts': "import sql from 'mssql';\nexport function f(a: number, b: number): boolean {\n  return a == b;\n}\nexport async function g(name: string): Promise<void> {\n  await query(`SELECT id FROM dbo.items WHERE name = '${name}'`);\n}\ndeclare function query(s: string): Promise<void>;\nvoid sql;\n",
      'migrations/add_notes.sql': 'ALTER TABLE dbo.items ADD notes NVARCHAR(10) NULL;\n',
    });
    const run1 = runLedgerChecksDetailed(ledger, [path.join(alpha, 'src/lib/orderCsv.ts'), path.join(alpha, 'migrations/add_notes.sql')], { mode: 'block' });
    const hit = new Set(run1.violations.map((v) => v.recordId));
    for (const want of ['lint.eqeqeq', 'naming.ts-file-case-kebab', 'layout.driver-gateway-mssql', 'sql.sql-text-literal', 'sql.migration-ddl-guards', 'sql.migration-file-names-seq-kebab', 'tests.per-module']) assert.ok(hit.has(want), `violation of ${want}: got ${[...hit].join(', ')}`);
    assert.ok(run1.durationMs < 5000);
    const v = run1.violations.find((x) => x.recordId === 'lint.eqeqeq')!;
    assert.equal(v.line, 3);
    assert.ok(v.fixText);
    // A conforming file has no violations from the counted records.
    const clean = runLedgerChecks(ledger, [path.join(beta, 'src/lib/item-store-1.ts')], { mode: 'all' });
    assert.deepEqual(clean.map((x) => x.recordId), []);
    // Scope: the single-quote record does not apply to beta.
    assert.ok(!runLedgerChecks(ledger, [path.join(beta, 'src/db.ts')]).some((x) => x.recordId === 'format.quotes-single'));
    // Commit subjects.
    const subj = checkCommitSubjects(ledger, ['feat(items): add export', 'Fixed the thing']);
    assert.equal(subj.length, 1);
    assert.equal(subj[0].snippet, 'Fixed the thing');

    // Team proposals for one repo.
    const prop = proposeForTeam('alpha');
    assert.ok(!('error' in prop), 'error' in prop ? prop.error : '');
    if (!('error' in prop)) {
      const kinds = prop.proposals.map((p) => p.kind);
      assert.ok(kinds.includes('eslint-baseline'));
      assert.ok(kinds.includes('contributing'));
      for (const p of prop.proposals) {
        assert.ok(fs.existsSync(p.md) && fs.existsSync(p.diff));
        assert.match(fs.readFileSync(p.diff, 'utf8'), /^--- (a\/|\/dev\/null)/);
      }
      const warnToError = fs.readFileSync(prop.proposals[0].diff, 'utf8');
      assert.match(warnToError, /-\s+'warn',\n\+\s+'error',/);
    }
    assert.ok('error' in proposeForTeam('no-such-repo'));
  } finally {
    env.cleanup();
  }
});

test('without ast-grep, and with --max-files: regex probes still count, scanners and skipped files are reported, declared ids stay the same', async (t) => {
  if (!which('git')) {
    t.skip('git is not available on PATH');
    return;
  }
  const env = tempEnv();
  const prev = process.env.HARNESS_AST_GREP;
  process.env.HARNESS_AST_GREP = 'none';
  try {
    syntheticWorkspace(env.workspace);
    const res = await runDiscover({ root: env.workspace, exec: false, write: false });
    const ast = res.ledger.scanners.find((s) => s.name === 'ast-grep');
    assert.equal(ast?.available, false);
    assert.ok(res.notCounted.length > 30);
    const ids = res.ledger.records.map((r) => r.id);
    assert.ok(ids.includes('lint.eqeqeq'), 'declared rule keeps the probe id');
    assert.equal(res.ledger.records.find((r) => r.id === 'lint.eqeqeq')?.evidence.sites, 0);
    assert.ok(ids.includes('naming.ts-file-case-kebab'), 'file-name probe still counted');
    assert.ok(ids.includes('layout.driver-gateway-mssql'), 'import gateway still counted');

    const capped = await runDiscover({ root: env.workspace, exec: false, maxFiles: 10, write: false });
    assert.equal(capped.ws.totalFiles, 10);
    assert.ok(capped.ledger.skipped.length > 0);
    assert.ok(capped.ledger.skipped.every((s) => s.reason === 'over the --max-files limit'));
  } finally {
    if (prev === undefined) delete process.env.HARNESS_AST_GREP;
    else process.env.HARNESS_AST_GREP = prev;
    env.cleanup();
  }
});
