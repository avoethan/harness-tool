import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeAvailable, runClaude, harnessHookEntry } from './claude-runner';
import { hookEntryPath } from '../../src/lib/paths';

test('behaviour: claude -p runs in an isolated HOME and a harness hook is invoked', (t) => {
  const avail = claudeAvailable();
  if (!avail.ok) return t.skip(`skipped: ${avail.reason}`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-smoke-'));
  const log = path.join(cwd, 'hook.log');
  const r = runClaude({
    prompt: 'Reply with exactly the word PANGOLIN and nothing else.',
    cwd,
    maxTurns: 2,
    model: 'claude-haiku-5-5',
    userSettings: {
      hooks: {
        UserPromptSubmit: [harnessHookEntry(hookEntryPath(), 'UserPromptSubmit')],
      },
    },
    env: { HARNESS_HOME: path.join(cwd, 'hh'), HARNESS_LOG_PROBE: log },
    timeoutMs: 120000,
  });
  assert.ok(r.ok, `claude failed: ${r.stderr.slice(0, 500)}`);
  assert.match(String(r.result), /PANGOLIN/);
  // The dispatcher instruments every hook call; the events log proves the hook ran.
  const events = fs.readFileSync(path.join(cwd, 'hh', 'logs', 'events.jsonl'), 'utf8');
  assert.match(events, /hook\.UserPromptSubmit/);
  process.stdout.write(`  claude ${avail.version}: cost_usd=${r.costUsd} turns=${r.numTurns}\n`);
});
