/**
 * Acceptance: the hook runtime driven exactly as an agent drives it (JSON on
 * stdin, the event name as argv, `node dist/src/hook.js <Event>`):
 *  - Stop exits 0 on an empty edit log;
 *  - after an edit-log entry it exits 2 with a JSON block whose reason names
 *    `harness gate`; with fresh PASS evidence it exits 0;
 *  - PostToolUse records the edit and renders the lint note as
 *    hookSpecificOutput.additionalContext; SessionStart writes the heartbeat;
 *  - timing: 20 Stop processes on a 200-file repo, median under 300 ms.
 * Needs only node, git and the build; skips with a reason when dist/ is absent.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoIdFor } from '../../src/lib/config';
import { lintRepo, makeRepo, sandbox, treeOf, writeEvidence, writeFile, type Sandbox } from '../unit/hooks/helpers';

const hookJs = path.resolve(__dirname, '..', '..', 'src', 'hook.js');
let sb: Sandbox;

before(() => {
  sb = sandbox('harness-hooks-cli-');
});
after(() => sb.restore());

function hook(event: string, payload: unknown, extraEnv: Record<string, string> = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [hookJs, event], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_HOME: sb.hh, HARNESS_USER_HOME: sb.home, ...extraEnv },
    timeout: 30000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('acceptance: Stop through the hook binary (empty log -> 0; edit -> 2 naming harness gate; fresh PASS -> 0)', (t) => {
  if (!fs.existsSync(hookJs)) return t.skip(`skipped: ${hookJs} not built (run npm run build)`);
  const empty = hook('Stop', '{"session_id":"s1","hook_event_name":"Stop"}');
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), '');

  const repo = makeRepo(path.join(sb.tmp, 'repo'), { 'a.ts': 'export const a = 1;\n' });
  fs.mkdirSync(path.join(sb.hh, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(sb.hh, 'state', 's1.json'),
    JSON.stringify({ version: 1, sessionId: 's1', agent: 'claude', startedAt: '', updatedAt: '', edits: [{ path: path.join(repo, 'a.ts'), repo: repoIdFor(repo), ts: new Date().toISOString() }], injected: {}, attempts: {}, status: 'working' }),
  );
  const blocked = hook('Stop', { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  assert.equal(blocked.code, 2);
  const out = JSON.parse(blocked.stdout.trim());
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /`harness gate`/);
  assert.ok(blocked.ms < 1500, `Stop took ${blocked.ms} ms`);

  // Codex: same JSON (plain text is invalid for its Stop), reason carries the exact command.
  const codex = hook('Stop', { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'done again', cwd: repo }, { HARNESS_AGENT: 'codex' });
  assert.equal(codex.code, 0, 'unchanged tree after a block: released, never blocked twice');

  writeEvidence(repo, 't-cli', { verdict: 'PASS', treeHash: treeOf(repo) });
  const pass = hook('Stop', { session_id: 's1', hook_event_name: 'Stop', last_assistant_message: 'verified' });
  assert.equal(pass.code, 0, pass.stderr);
});

test('acceptance: PostToolUse and SessionStart through the hook binary', (t) => {
  if (!fs.existsSync(hookJs)) return t.skip(`skipped: ${hookJs} not built (run npm run build)`);
  const repo = lintRepo(path.join(sb.tmp, 'lint'));
  const f = writeFile(repo, 'src/bad.ts', 'console.log("x");\n');
  const r = hook('PostToolUse', { session_id: 's2', hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Write', tool_input: { file_path: f, content: 'x' } });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /eslint no-console/);
  const state = JSON.parse(fs.readFileSync(path.join(sb.hh, 'state', 's2.json'), 'utf8'));
  assert.equal(state.edits.length, 1);

  const s = hook('SessionStart', { session_id: 's3', hook_event_name: 'SessionStart', source: 'startup', cwd: repo }, { HARNESS_AGENT: 'codex' });
  assert.equal(s.code, 0, s.stderr);
  assert.match(JSON.parse(s.stdout.trim()).hookSpecificOutput.additionalContext, /Repos \(name: path \| verify\)/);
  const hb = JSON.parse(fs.readFileSync(path.join(sb.hh, 'state', 'heartbeat-codex.json'), 'utf8'));
  assert.equal(hb.sessionId, 's3');
});

test('acceptance timing: 20 Stop processes on a 200-file repo, median under 300 ms', (t) => {
  if (!fs.existsSync(hookJs)) return t.skip(`skipped: ${hookJs} not built (run npm run build)`);
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`src/mod${String(i).padStart(3, '0')}.ts`] = `export const v${i} = ${i};\n`;
  const repo = makeRepo(path.join(sb.tmp, 'big'), files);
  writeFile(repo, 'src/mod000.ts', 'export const v0 = 1000;\n');
  fs.mkdirSync(path.join(sb.hh, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(sb.hh, 'state', 'timing.json'),
    JSON.stringify({ version: 1, sessionId: 'timing', agent: 'claude', startedAt: '', updatedAt: '', edits: [{ path: path.join(repo, 'src', 'mod000.ts'), repo: repoIdFor(repo), ts: new Date().toISOString() }], injected: {}, attempts: {}, status: 'working' }),
  );
  writeEvidence(repo, 't-timing', { verdict: 'PASS', treeHash: treeOf(repo) });
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    // A distinct last_assistant_message per run so the dispatcher's double-registration dedupe never short-cuts it.
    const r = hook('Stop', { session_id: 'timing', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: `run ${i}` });
    assert.equal(r.code, 0, r.stderr);
    ms.push(r.ms);
  }
  const s = [...ms].sort((a, b) => a - b);
  const median = s[9];
  const line = `Stop hook process, 200-file repo, 20 runs: min ${s[0].toFixed(1)} ms, median ${median.toFixed(1)} ms, p90 ${s[18].toFixed(1)} ms, max ${s[19].toFixed(1)} ms (first run ${ms[0].toFixed(1)} ms)`;
  t.diagnostic(line);
  process.stdout.write(`# ${line}\n`);
  assert.ok(median < 300, line);
});
