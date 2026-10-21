import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadBrief } from '../../../src/intake/brief';
import { runQueue } from '../../../src/runctl/run';
import type { SessionRequest } from '../../../src/runctl/session';
import { cleanupEnv, commitAll, evidenceGate, ledgerTaskText, put, scriptedCi, scriptedSession } from '../land/helpers';
import { runnerRepo } from './helpers';

test('run: the personal runner builds each brief unattended, so a vague criterion takes its recommended option instead of waiting for an answer', async () => {
  const r = runnerRepo('harness-run-unattended-', {
    'tasks/T-001-a.md': ledgerTaskText('T-001', 'Make a 42', { priority: 1, paths: ['src/a.js'], acceptance: ['Search must be fast'] }),
  });
  try {
    const doTheWork = (req: SessionRequest): void => {
      put(req.cwd, 'src/a.js', 'exports.a = 42;\n');
      commitAll(req.cwd, 'feat: a');
    };
    const lines: string[] = [];
    const rep = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'local' }, { session: scriptedSession(doTheWork), gate: evidenceGate(), ci: scriptedCi(['green']), config: null, say: (l) => lines.push(l) });
    assert.equal(rep.exitCode, 0, lines.join('\n'));
    const b = loadBrief('T-001')!;
    assert.deepEqual(b.markers, [], 'no criterion waits for an answer nobody can give');
    assert.ok(b.criteria[0].check);
    assert.ok(b.assumptions.some((a) => a.includes('(unattended: no one to answer)')), b.assumptions.join('\n'));
    assert.equal(b.questionDetails[0]?.unattended, true);
  } finally {
    r.home.cleanup();
    cleanupEnv();
  }
});
