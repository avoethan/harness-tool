/**
 * Timing of the Stop check on a repo with 200 files, in process (the
 * process-level run, 20 fresh `node dist/src/hook.js Stop` calls with a
 * median under 300 ms, is in test/acceptance/hooks-cli.test.ts so the quick
 * suite stays short). The measured numbers are printed.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { evaluateStop } from '../../../src/hooks/evidence';
import { recordEdit } from '../../../src/lib/session';
import { repoIdFor } from '../../../src/lib/config';
import { ctxFor, makeRepo, sandbox, treeOf, writeEvidence, writeFile, type Sandbox } from './helpers';

let sb: Sandbox;
let repo: string;

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: s[Math.floor((s.length - 1) / 2)], p90: q(0.9), max: s[s.length - 1] };
}

before(() => {
  sb = sandbox('harness-timing-');
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`src/mod${String(i).padStart(3, '0')}.ts`] = `export const v${i} = ${i};\n`;
  repo = makeRepo(path.join(sb.tmp, 'big'), files);
  writeFile(repo, 'src/mod000.ts', 'export const v0 = 1000;\n');
  recordEdit('timing', { path: path.join(repo, 'src', 'mod000.ts'), repo: repoIdFor(repo) });
  writeEvidence(repo, 't-timing', { verdict: 'PASS', treeHash: treeOf(repo) });
});
after(() => sb.restore());

test('timing: the in-process check (no node start-up), 20 runs', (t) => {
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    const o = evaluateStop({ session_id: 'timing' }, ctxFor('claude', 'Stop', 'timing'));
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(o.outcome, 'pass');
  }
  const st = stats(ms);
  const line = `Stop check in-process, 200-file repo, ${st.n} runs: min ${st.min.toFixed(2)} ms, median ${st.median.toFixed(2)} ms, p90 ${st.p90.toFixed(2)} ms, max ${st.max.toFixed(2)} ms`;
  t.diagnostic(line);
  process.stdout.write(`# ${line}\n`);
  assert.ok(st.median < 300, line);
});

test('timing: an uncached tree hash on the 200-file repo stays well inside the 1.5 s budget', (t) => {
  // Invalidate the cache by touching the edited file each run.
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) {
    writeFile(repo, 'src/mod000.ts', `export const v0 = ${2000 + i};\n`);
    const t0 = process.hrtime.bigint();
    const o = evaluateStop({ session_id: 'timing' }, ctxFor('claude', 'Stop', 'timing'));
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.ok(o.repos[0].treeCached === false);
  }
  const st = stats(ms);
  const line = `Stop check with a fresh write-tree, 200-file repo, ${st.n} runs: median ${st.median.toFixed(1)} ms, max ${st.max.toFixed(1)} ms`;
  t.diagnostic(line);
  process.stdout.write(`# ${line}\n`);
  assert.ok(st.max < 1500, line);
});
