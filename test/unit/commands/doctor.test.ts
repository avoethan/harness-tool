import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatDoctor, heartbeatPath, hookCommands, main, runDoctor, type Check } from '../../../src/commands/doctor';
import { allowlistHash, defaultConfig, saveConfig } from '../../../src/lib/config';
import { writeIntegrity } from '../../../src/lib/integrity';
import { hookEntryPath } from '../../../src/lib/paths';
import { capture } from './capture';
import { git, tempHome, write, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-doctor-');
});
after(() => h.cleanup());

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;

test('doctor on an empty HARNESS_HOME: readable report, no crash, exit 0, every expected check present', async () => {
  fs.rmSync(h.harnessHome, { recursive: true, force: true });
  const r = await runDoctor();
  const names = r.checks.map((c) => c.name);
  for (const n of ['node', 'built', 'integrity', 'config', 'db-allowlist', 'scanner:ast-grep', 'scanner:repo-tools', 'scanner:sqlcmd', 'scanner:semgrep', 'hooks:devin', 'hooks:claude', 'hooks:codex', 'state-repo', 'codex-hooks-trusted']) {
    assert.ok(names.includes(n), `check ${n} present`);
  }
  assert.equal(byName(r.checks, 'node').status, 'ok');
  assert.equal(byName(r.checks, 'built').status, 'ok');
  assert.match(byName(r.checks, 'built').message, /\/dist\/src\/hook\.js$/, 'absolute forward-slash hook path');
  assert.equal(byName(r.checks, 'integrity').status, 'warn');
  assert.match(byName(r.checks, 'integrity').message, /not yet signed: run install/);
  assert.equal(byName(r.checks, 'config').status, 'warn');
  assert.match(byName(r.checks, 'db-allowlist').message, /empty: every database command is denied until you mark a test server/);
  assert.equal(byName(r.checks, 'state-repo').status, 'warn');
  for (const c of r.checks) if (c.status !== 'ok') assert.ok(c.fix, `${c.name} has a fix hint`);
  assert.equal(r.summary.fail, 0);
  assert.equal(r.ok, true);
  const text = formatDoctor(r);
  assert.match(text, /\d+ ok, \d+ warnings?, 0 failures/);
  const cli = await capture(() => main([]));
  assert.equal(cli.code, 0);
  assert.match(cli.stdout, /doctor/);
  const json = await capture(() => main(['--json']));
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).ok, true);
});

test('doctor --fix creates the private state repository; a remote is reported', async () => {
  const r = await runDoctor({ fix: true });
  assert.equal(byName(r.checks, 'state-repo').status, 'ok');
  assert.ok(fs.existsSync(path.join(h.harnessHome, '.git')));
  const again = await runDoctor();
  assert.equal(byName(again.checks, 'state-repo').status, 'ok');
  assert.match(byName(again.checks, 'state-repo').message, /no remote/);
  git(h.harnessHome, ['remote', 'add', 'origin', 'https://example.invalid/private.git']);
  const withRemote = await runDoctor();
  assert.equal(byName(withRemote.checks, 'state-repo').status, 'warn');
  assert.match(byName(withRemote.checks, 'state-repo').message, /has a remote/);
  git(h.harnessHome, ['remote', 'remove', 'origin']);
});

test('doctor with a config: hooks found by the harness hook path, Codex heartbeat, allowlist hash mismatch', async () => {
  const c = defaultConfig({ setting: 'team', agents: ['claude', 'codex'], workspaceRoot: h.workspace });
  c.db.allowlist = [{ server: 'localhost,1433', database: 'shop_test', marked: 'test' }];
  c.db.markedHash = allowlistHash(c);
  c.db.markedAt = new Date().toISOString();
  saveConfig(c);
  writeIntegrity();
  const hook = hookEntryPath();
  write(
    path.join(h.userHome, '.claude', 'settings.json'),
    `// comments are fine\n{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \\"${hook}\\" PreToolUse", "timeout": 20 }] }], "Stop": [{ "hooks": [{ "type": "command", "command": "node \\"${hook}\\" Stop" }] }] }, }\n`,
  );
  write(path.join(h.userHome, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /opt/other/hook.js' }] }] } }));
  const r = await runDoctor();
  assert.equal(byName(r.checks, 'integrity').status, 'ok');
  assert.equal(byName(r.checks, 'config').status, 'ok');
  assert.match(byName(r.checks, 'config').message, /team setting; agents claude, codex/);
  assert.equal(byName(r.checks, 'db-allowlist').status, 'ok');
  assert.match(byName(r.checks, 'db-allowlist').message, /localhost,1433\/shop_test=test/);
  assert.equal(byName(r.checks, 'hooks:claude').status, 'ok');
  assert.match(byName(r.checks, 'hooks:claude').message, /PreToolUse, Stop/);
  assert.equal(byName(r.checks, 'hooks:codex').status, 'fail', 'registered hooks do not run the harness');
  assert.equal(r.checks.some((x) => x.name === 'hooks:devin'), false, 'only configured agents are checked');
  assert.equal(byName(r.checks, 'codex-hooks-trusted').status, 'warn');
  assert.match(byName(r.checks, 'codex-hooks-trusted').fix!, /\/hooks/);
  assert.equal(r.ok, false);
  const cli = await capture(() => main([]));
  assert.equal(cli.code, 1);

  write(heartbeatPath('codex'), JSON.stringify({ agent: 'codex', at: '2026-10-19T08:00:00Z', sessionId: 's1' }));
  // the allowlist edited by hand: hash mismatch is a failure
  c.db.allowlist.push({ server: 'prod-sql', marked: 'test' });
  saveConfig(c);
  writeIntegrity();
  const r2 = await runDoctor();
  assert.equal(byName(r2.checks, 'codex-hooks-trusted').status, 'ok');
  assert.equal(byName(r2.checks, 'db-allowlist').status, 'fail');
  assert.match(byName(r2.checks, 'db-allowlist').message, /edited outside/);
  // an unparsable settings file is a failure with a hint, not a crash
  write(path.join(h.userHome, '.codex', 'hooks.json'), '{ not json');
  const r3 = await runDoctor();
  assert.equal(byName(r3.checks, 'hooks:codex').status, 'fail');
  assert.match(byName(r3.checks, 'hooks:codex').message, /does not parse/);
});

test('hookCommands collects command strings under every event', () => {
  const doc = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }], Stop: [{ hooks: [{ command: 'c' }] }] }, other: { command: 'ignored' } };
  assert.deepEqual(hookCommands(doc), [
    { event: 'PreToolUse', command: 'a' },
    { event: 'PreToolUse', command: 'b' },
    { event: 'Stop', command: 'c' },
  ]);
  assert.deepEqual(hookCommands(null), []);
  assert.deepEqual(hookCommands({ hooks: 'nope' }), []);
});
