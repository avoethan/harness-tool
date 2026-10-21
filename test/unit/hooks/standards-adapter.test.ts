/**
 * The PostToolUse hook calls discover's ledger-check runner through
 * externalLedgerChecks(). The runner takes (ledger, files, opts); the hook
 * passes one options object. This test drives a real discovered ledger and
 * a violating file through the hook's call shape and expects findings.
 * (Regression: the adapter was missing, the throw was swallowed, and no
 * ledger check ever ran at edit time.)
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { runDiscover } from '../../../src/discover/index';
import { externalLedgerChecks, useLedgerChecks } from '../../../src/hooks/standards';
import type { Ledger } from '../../../src/types';
import { syntheticWorkspace, tempEnv, writeTree } from '../discover/helpers';

test('externalLedgerChecks adapts the hook call shape to discover\'s runner and returns findings', async () => {
  const env = tempEnv('harness-hook-adapter-');
  try {
    const { alpha } = syntheticWorkspace(env.workspace);
    const res = await runDiscover({ root: env.workspace, exec: false });
    const ledger: Ledger = res.ledger;
    const file = path.join(alpha, 'src/lib/orderCsv.ts');
    writeTree(alpha, {
      'src/lib/orderCsv.ts': "export function f(a: number, b: number): boolean {\n  return a == b;\n}\n",
    });
    useLedgerChecks(undefined);
    const run = externalLedgerChecks();
    assert.ok(run, 'discover provides the runner');
    const findings = await run!({ repoRoot: alpha, repoId: 'alpha', files: [file], records: ledger.records, timeoutMs: 5000, scope: 'file' });
    const ids = findings.map((f) => f.ruleId);
    assert.ok(ids.includes('lint.eqeqeq'), `expected lint.eqeqeq among ${ids.join(', ')}`);
    const eq = findings.find((f) => f.ruleId === 'lint.eqeqeq')!;
    assert.equal(eq.file, file);
    assert.equal(eq.line, 2);
    assert.ok(ids.includes('naming.ts-file-case-kebab'), 'the file name check runs on one file too');
  } finally {
    env.cleanup?.();
  }
});
