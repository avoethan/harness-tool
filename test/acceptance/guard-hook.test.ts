/**
 * Acceptance: the built hook binary, driven exactly as an agent drives it
 * (JSON on stdin, event name as argv), denies with exit 2 + JSON on stdout
 * + reason on stderr, allows with exit 0, and finishes well under 2 s.
 * Needs only node and the build; skips with a reason when dist/ is absent.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const hookJs = path.resolve(__dirname, '..', '..', 'src', 'hook.js');

/**
 * The hook runs from the system temp folder, as an agent's would from its task
 * folder: not from the harness package, which is itself protected unless it
 * is a git checkout (a copied folder or an unpacked tarball is not).
 */
function runHook(payload: unknown, env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [hookJs, 'PreToolUse'], {
    cwd: os.tmpdir(),
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HARNESS_NO_INSTRUMENT: '', ...env },
    timeout: 20000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

test('acceptance: PreToolUse hook end to end', (t) => {
  if (!fs.existsSync(hookJs)) return t.skip(`skipped: ${hookJs} not built (run npm run build)`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-accept-'));
  const env = { HARNESS_HOME: path.join(tmp, 'hh'), HARNESS_USER_HOME: path.join(tmp, 'home') };
  try {
    const force = runHook({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, env);
    assert.equal(force.code, 2, force.stderr);
    const out = JSON.parse(force.stdout.trim());
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /force/i);
    assert.match(force.stderr, /force/i);
    assert.ok(force.ms < 2000, `force-push check took ${force.ms} ms`);

    const db = runHook({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'sqlcmd -S myserver -Q "select 1"' } }, env);
    assert.equal(db.code, 2, db.stderr);
    const dbOut = JSON.parse(db.stdout.trim());
    assert.equal(dbOut.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(db.stderr, /harness db mark/);

    const status = runHook({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'git status' } }, env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.stdout.trim(), '');
    assert.ok(status.ms < 2000, `git status check took ${status.ms} ms`);

    const edit = runHook({ session_id: 's', tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'home', '.claude', 'settings.json'), old_string: 'a', new_string: 'b' } }, env);
    assert.equal(edit.code, 2, edit.stderr);
    assert.match(edit.stderr, /harness-protected/);

    const devin = runHook({ session_id: 's', tool_name: 'exec', tool_input: { command: 'git push --force' } }, env);
    assert.equal(devin.code, 2);

    const nested = runHook({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'claude --dangerously-skip-permissions -p hi' } }, env);
    assert.equal(nested.code, 2);

    const ok = runHook({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } }, env);
    assert.equal(ok.code, 0, ok.stderr);

    // timing over a handful of ordinary commands
    const samples = ['ls -la', 'npm run build', 'git diff', 'cat src/x.ts', 'node x.js'].map((c) => runHook({ session_id: 's' + c, tool_name: 'Bash', tool_input: { command: c } }, env).ms);
    const max = Math.max(...samples);
    process.stdout.write(`  hook process round-trips: ${samples.join(', ')} ms (max ${max})\n`);
    assert.ok(max < 2000, `slowest hook call ${max} ms`);

    const log = fs.readFileSync(path.join(env.HARNESS_HOME, 'logs', 'events.jsonl'), 'utf8');
    assert.match(log, /guard\.deny/);
    assert.doesNotMatch(log, /myserver|push --force/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
