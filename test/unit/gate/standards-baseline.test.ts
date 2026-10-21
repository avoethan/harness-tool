/**
 * The gate's standards baseline is anchored to the base commit, not to the
 * mutable baseline stored in the check specs. Red-team (Lens C, "baseline
 * games"): an agent that introduces a violation and then re-runs
 * `harness discover` rewrites the stored spec baseline so it absorbs the new
 * violation, which used to make the standards step pass. The gate now derives
 * the baseline from the base-commit content of the changed files, so the new
 * violation still blocks; a genuinely pre-existing violation in a modified
 * file is still excused.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDiscover } from '../../../src/discover/index';
import { runGate } from '../../../src/gate/index';
import { syntheticWorkspace, tempEnv, writeTree, git } from '../discover/helpers';

function namingReasons(ev: { steps: Array<{ name: string; status: string; reasons?: string[] }> }): string[] {
  const s = ev.steps.find((x) => x.name === 'standards');
  return (s?.reasons ?? []).filter((r) => r.includes('naming.ts-file-case-kebab'));
}

test('gate standards: a new violation still blocks after a laundering `discover` re-baseline', async () => {
  const env = tempEnv('harness-gate-baseline-');
  try {
    const { alpha } = syntheticWorkspace(env.workspace);
    git(alpha, ['init', '-q', '-b', 'main']);
    git(alpha, ['add', '-A']);
    git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base']);
    await runDiscover({ root: env.workspace, exec: false });
    const base = git(alpha, ['rev-parse', 'HEAD']).stdout.trim();

    // The agent adds a camelCase file (breaks the kebab-case file-name standard) and commits it.
    writeTree(alpha, { 'src/lib/BadName.ts': 'export const x = 1;\n' });
    git(alpha, ['add', '-A']);
    git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'feat: add helper']);

    const g1 = await runGate({ repo: alpha, base, steps: ['standards'], noCache: true });
    const s1 = g1.evidence.steps.find((x) => x.name === 'standards')!;
    assert.equal(s1.status, 'fail', 'the new camelCase file fails the standards step');
    assert.ok(namingReasons(g1.evidence).length >= 1, 'the kebab-case naming standard is named');

    // Launder: re-run discover with the violation present, so the stored spec
    // baseline now lists BadName.ts as a pre-existing exception.
    await runDiscover({ root: env.workspace, exec: false });
    const spec = JSON.parse(fs.readFileSync(path.join(env.harnessHome, 'ledger', 'checks', 'naming.ts-file-case-kebab.json'), 'utf8'));
    assert.ok(JSON.stringify(spec.baseline ?? []).includes('BadName'), 'the re-discover did absorb BadName into the stored baseline');

    // The gate still fails: its baseline comes from the base commit, where
    // BadName.ts did not exist.
    const g2 = await runGate({ repo: alpha, base, steps: ['standards'], noCache: true });
    const s2 = g2.evidence.steps.find((x) => x.name === 'standards')!;
    assert.equal(s2.status, 'fail', 'the standards step still fails after the laundering re-discover');
    assert.ok(namingReasons(g2.evidence).length >= 1, 'the kebab-case naming standard is still named');
  } finally {
    env.cleanup?.();
  }
});

test('gate standards: a violation already present in a modified file at the base commit is still excused', async () => {
  const env = tempEnv('harness-gate-baseline-pre-');
  try {
    const { alpha } = syntheticWorkspace(env.workspace);
    // A camelCase file exists at the base commit (pre-existing debt).
    writeTree(alpha, { 'src/lib/legacyName.ts': 'export const y = 1;\n' });
    git(alpha, ['init', '-q', '-b', 'main']);
    git(alpha, ['add', '-A']);
    git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base']);
    await runDiscover({ root: env.workspace, exec: false });
    const base = git(alpha, ['rev-parse', 'HEAD']).stdout.trim();

    // The agent edits that same file (its content changes, but the bad name is pre-existing).
    writeTree(alpha, { 'src/lib/legacyName.ts': 'export const y = 2;\n' });
    git(alpha, ['add', '-A']);
    git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'fix(lib): bump value']);

    const g = await runGate({ repo: alpha, base, steps: ['standards'], noCache: true });
    const s = g.evidence.steps.find((x) => x.name === 'standards')!;
    assert.notEqual(s.status, 'fail', `a pre-existing bad name in a modified file is not newly flagged: ${JSON.stringify(s.reasons)}`);
    assert.equal(namingReasons(g.evidence).length, 0, 'the pre-existing naming violation is not reported as new');
  } finally {
    env.cleanup?.();
  }
});
