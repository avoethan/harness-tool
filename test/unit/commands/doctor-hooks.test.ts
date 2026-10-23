/** doctor names the last hook event seen from each configured agent, and whether the guard has checked one of its tool calls. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkHooksSeen } from '../../../src/commands/doctor';
import type { HarnessConfig } from '../../../src/types';

const cfg = { agents: ['devin', 'claude'] } as unknown as HarnessConfig;
function log(lines: object[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-seen-'));
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('an agent with a guard decision is ok; one with only session events warns; one with nothing warns', () => {
  const f = log([
    { ts: '2026-10-23T22:00:00.000Z', event: 'session.start', agent: 'devin' },
    { ts: '2026-10-23T22:05:31.622Z', event: 'guard.allow', agent: 'devin', ids: { rail: 'none', tool: 'read' } },
    { ts: '2026-10-23T22:06:00.000Z', event: 'post.tool', agent: 'devin' },
  ]);
  const [devin, claude] = checkHooksSeen(cfg, f);
  assert.equal(devin.status, 'ok');
  assert.match(devin.message, /last hook event 2026-10-23T22:06:00\.000Z; the guard last checked one of its tool calls at 2026-10-23T22:05:31\.622Z/);
  assert.equal(claude.status, 'warn');
  assert.match(claude.message, /no hook event from claude yet/);
});

test('session events without a guard decision warn with the next step', () => {
  const f = log([{ ts: '2026-10-23T22:00:00.000Z', event: 'session.start', agent: 'devin' }]);
  const [devin] = checkHooksSeen(cfg, f);
  assert.equal(devin.status, 'warn');
  assert.match(devin.fix ?? '', /git status/);
});

test('a missing or malformed log is a warning per agent, never a failure', () => {
  const missing = path.join(os.tmpdir(), 'no-such-dir-hooks', 'events.jsonl');
  assert.deepEqual(checkHooksSeen(cfg, missing).map((c) => c.status), ['warn', 'warn']);
  const f = log([]);
  fs.appendFileSync(f, '{not json\n');
  assert.deepEqual(checkHooksSeen(cfg, f).map((c) => c.status), ['warn', 'warn']);
});
