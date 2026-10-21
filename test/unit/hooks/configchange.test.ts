import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handle, isHarnessOwned } from '../../../src/hooks/ConfigChange';
import { manifestPath } from '../../../src/lib/paths';
import type { Manifest } from '../../../src/types';
import { ctxFor, events, sandbox, type Sandbox } from './helpers';

let sb: Sandbox;
let settings: string;

before(() => {
  sb = sandbox('harness-cfgchg-');
  settings = path.join(sb.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{}');
  const m: Manifest = { version: 1, harnessVersion: '0.1.0', files: [], settingsEdits: [{ path: settings, key: 'hooks.Stop', before: null, after: [] }] };
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m));
});
after(() => sb.restore());

test('a harness-owned settings file change gets the re-sign warning; other files do not', async () => {
  const r = await handle({ session_id: 'cc1', hook_event_name: 'ConfigChange', source: 'user_settings', file_path: settings }, ctxFor('claude', 'ConfigChange', 'cc1'));
  assert.equal(r.exitCode, 0);
  assert.match(String(r.additionalContext), /re-signs integrity only through `harness config`/);
  const other = path.join(sb.tmp, 'proj', '.claude', 'settings.local.json');
  const r2 = await handle({ session_id: 'cc1', hook_event_name: 'ConfigChange', source: 'local_settings', file_path: other }, ctxFor('claude', 'ConfigChange', 'cc1'));
  assert.equal(r2.additionalContext, undefined);
  const ev = events().filter((e) => e.event === 'config.change');
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0].ids, { source: 'user_settings' });
  assert.deepEqual(ev[0].counts, { owned: 1, file: 1 });
  assert.ok(!JSON.stringify(ev).includes(settings), 'paths are not logged');
});

test('anything under the harness state counts as harness-owned', () => {
  assert.equal(isHarnessOwned(path.join(sb.hh, 'config.json'), sb.tmp), true);
  assert.equal(isHarnessOwned(path.join(sb.tmp, 'random.json'), sb.tmp), false);
});
