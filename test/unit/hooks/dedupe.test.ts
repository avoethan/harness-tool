/**
 * The dispatcher's dedupe (src/hook.ts) answers a repeated identical hook
 * call from the first result for a few seconds (double registration). It
 * must never answer from a state that has since changed (found by the safety
 * suite): a Stop after a new edit is evaluated again, and a cached
 * PreToolUse allow is not reused. Runs dist/src/hook.js as a process, where
 * the dedupe lives.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordEdit } from '../../../src/lib/session';
import { repoIdFor } from '../../../src/lib/config';
import { makeRepo, sandbox, writeFile } from './helpers';

const HOOK = path.resolve(__dirname, '..', '..', '..', 'src', 'hook.js');

function hook(event: string, input: Record<string, unknown>, cwd: string): number | null {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [HOOK, event, '--agent', 'claude'], { cwd, env, input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 }).status;
}

test('dedupe: an identical Stop after a new edit is evaluated again (no stale exit 0), and a block is not repeated for an unchanged state', () => {
  const sb = sandbox('harness-dedupe-');
  try {
    const repo = makeRepo(path.join(sb.tmp, 'r'), { 'src/a.js': 'a\n' });
    const stop = { session_id: 'dd1', hook_event_name: 'Stop', cwd: repo, stop_hook_active: false, last_assistant_message: 'Done.' };
    assert.equal(hook('Stop', stop, repo), 0, 'no edits: pass');
    writeFile(repo, 'src/a.js', 'b\n');
    recordEdit('dd1', { path: path.join(repo, 'src', 'a.js'), repo: repoIdFor(repo) });
    assert.equal(hook('Stop', stop, repo), 2, 'same payload within seconds, but an edit since: blocked');
    assert.equal(hook('Stop', { ...stop, stop_hook_active: true }, repo), 0, 'unchanged state after the block: released');
  } finally {
    sb.restore();
  }
});

test('dedupe: a cached PreToolUse allow is not reused, a cached denial is', () => {
  const sb = sandbox('harness-dedupe-');
  try {
    const repo = makeRepo(path.join(sb.tmp, 'r'), { 'README.md': '# r\n' });
    const call = (command: string) => ({ session_id: 'dd2', hook_event_name: 'PreToolUse', cwd: repo, tool_name: 'Bash', tool_input: { command } });
    assert.equal(hook('PreToolUse', call('git status'), repo), 0);
    assert.equal(hook('PreToolUse', call('git status'), repo), 0);
    assert.equal(hook('PreToolUse', call('git push --force'), repo), 2);
    assert.equal(hook('PreToolUse', call('git push --force'), repo), 2);
    const lines = require('node:fs').readFileSync(path.join(sb.hh, 'logs', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    assert.equal(lines.filter((e: { event: string }) => e.event === 'guard.allow').length, 2, 'both allows were evaluated');
    assert.equal(lines.filter((e: { event: string }) => e.event === 'hook.dedupe').length, 1, 'the repeated denial came from the cache');
  } finally {
    sb.restore();
  }
});
