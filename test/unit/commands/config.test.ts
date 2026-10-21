import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main, parseValue, refusedKeyReason, setConfigValue } from '../../../src/commands/config';
import { defaultConfig, loadConfig, saveConfig } from '../../../src/lib/config';
import { capture, withTty } from './capture';
import { tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-config-');
});
after(() => h.cleanup());

test('config set is refused without an interactive terminal (exit 4), allowed with --from-install', async () => {
  await withTty(false, false, async () => {
    const r = await capture(() => main(['set', 'setting', 'personal']));
    assert.equal(r.code, 4);
    assert.match(r.stderr, /interactive terminal/);
    assert.equal(loadConfig(), null, 'nothing written');
  });
  await withTty(true, false, async () => {
    const r = await capture(() => main(['set', 'setting', 'personal']));
    assert.equal(r.code, 4, 'both ends must be a terminal');
  });
  await withTty(false, false, async () => {
    const r = await capture(() => main(['set', 'setting', 'personal', '--from-install']));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Set setting = "personal"/);
    assert.equal(loadConfig()!.setting, 'personal');
    const integrity = JSON.parse(fs.readFileSync(path.join(h.harnessHome, 'integrity.json'), 'utf8'));
    assert.ok(integrity.files[path.join(h.harnessHome, 'config.json')], 'config re-signed');
  });
  await withTty(true, true, async () => {
    const r = await capture(() => main(['set', 'caps.turns', '40']));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(loadConfig()!.caps.turns, 40);
  });
});

test('config set never writes the database allowlist, even for the installer', async () => {
  await withTty(true, true, async () => {
    for (const key of ['db.allowlist', 'db', 'db.markedHash']) {
      const r = await capture(() => main(['set', key, '[]', '--from-install']));
      assert.equal(r.code, 4, key);
      assert.match(r.stderr, /harness db mark/);
    }
    const unknown = await capture(() => main(['set', 'hooksEnabled', 'false']));
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown setting/);
    const bad = await capture(() => main(['set', 'setting', 'both']));
    assert.equal(bad.code, 2);
    const rel = await capture(() => main(['set', 'workspaceRoot', 'relative/path']));
    assert.equal(rel.code, 2);
  });
  assert.ok(refusedKeyReason('db.allowlist'));
  assert.ok(refusedKeyReason('version'));
  assert.equal(refusedKeyReason('caps.turns'), null);
});

test('values: JSON when valid, strings otherwise; agents accept a comma list', () => {
  assert.equal(parseValue('40'), 40);
  assert.deepEqual(parseValue('["claude","codex"]'), ['claude', 'codex']);
  assert.equal(parseValue('personal'), 'personal');
  const c = defaultConfig();
  assert.equal(setConfigValue(c, 'agents', 'claude, codex'), null);
  assert.deepEqual(c.agents, ['claude', 'codex']);
  assert.match(setConfigValue(c, 'agents', ['cursor']) ?? '', /agents must be/);
  assert.equal(setConfigValue(c, 'reviews.source', 'pasted'), null);
  assert.match(setConfigValue(c, 'reviews.source', 'email') ?? '', /reviews.source/);
  assert.match(setConfigValue(c, 'caps.turns', 'many') ?? '', /number/);
  assert.equal(setConfigValue(c, 'include', ['/x']), null);
});

test('config get prints the whole config, one key, or says there is none', async () => {
  const whole = await capture(() => main(['get']));
  assert.equal(whole.code, 0);
  assert.equal(JSON.parse(whole.stdout).setting, 'personal');
  const one = await capture(() => main(['get', 'caps.turns']));
  assert.equal(one.stdout.trim(), '40');
  const missing = await capture(() => main(['get', 'nope.key']));
  assert.equal(missing.code, 1);
  saveConfig(defaultConfig());
  fs.unlinkSync(path.join(h.harnessHome, 'config.json'));
  const none = await capture(() => main(['get']));
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No config yet/);
});

test('config set verify.*: the settings verify names in its messages are settable, validated, and never a password', () => {
  const c = defaultConfig();
  assert.equal(refusedKeyReason('verify.db.user'), null);
  assert.equal(setConfigValue(c, 'verify.db.user', 'sa'), null);
  assert.equal(setConfigValue(c, 'verify.db.server', 'localhost,1433'), null);
  assert.equal(setConfigValue(c, 'verify.db.passwordEnv', 'DB_PASSWORD'), null);
  assert.equal(setConfigValue(c, 'verify.portBase', 21000), null);
  assert.deepEqual(c.verify, { db: { user: 'sa', server: 'localhost,1433', passwordEnv: 'DB_PASSWORD' }, portBase: 21000 });
  assert.match(setConfigValue(c, 'verify.db.passwordEnv', 'Example_Pw_123!') ?? '', /NAME of an environment variable/, 'a password-shaped value is refused');
  assert.match(setConfigValue(c, 'verify.db.server', 'host; DROP') ?? '', /host\[,port\]/);
  assert.match(setConfigValue(c, 'verify.db.sqlcmd', 'shell') ?? '', /auto, local or docker/);
  assert.match(setConfigValue(c, 'verify.portBase', -1) ?? '', /positive whole number/);
  assert.match(setConfigValue(c, 'db.allowlist', []) ?? '', /harness db mark/, 'the allowlist stays out of reach');
});
