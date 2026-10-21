import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { COMMANDS, main } from '../../src/cli';
import { capture } from './commands/capture';

test('harness help help describes help instead of calling it not built', async () => {
  const r = await capture(() => main(['help', 'help']));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^help — /);
  assert.match(r.stdout, /Usage: harness help \[<command>\]/);
  assert.doesNotMatch(r.stdout, /not built yet/);
});

test('every registered command has help with a usage line, and none says not built', async () => {
  for (const [name] of COMMANDS) {
    const r = await capture(() => main(['help', name]));
    assert.equal(r.code, 0, `harness help ${name} exits 0`);
    assert.match(r.stdout, new RegExp(`^${name} — `), `harness help ${name} names the command`);
    assert.match(r.stdout, /\nUsage: harness /, `harness help ${name} prints a usage line`);
    assert.doesNotMatch(r.stdout, /not built yet/, `harness help ${name} is built`);
  }
});

test('harness help <unknown> is a usage error', async () => {
  const r = await capture(() => main(['help', 'no-such-command']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command: no-such-command/);
});
