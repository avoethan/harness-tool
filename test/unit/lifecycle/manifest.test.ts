import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../../../src/lib/hash';
import {
  addCreatedDirs,
  addSettingsEdit,
  classifyEntry,
  classifyPath,
  emptyManifest,
  loadManifest,
  manifestPathFor,
  mergeEntry,
  ownedPaths,
  removeEntry,
  resignIntegrity,
  saveManifest,
} from '../../../src/lifecycle/manifest';
import type { ManifestFile } from '../../../src/types';

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-manifest-'));
  process.env.HARNESS_HOME = path.join(tmp, 'home', '.harness');
  process.env.HARNESS_USER_HOME = path.join(tmp, 'home');
  process.env.HARNESS_NO_INSTRUMENT = '1';
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function entry(p: string, content: string, before: string | null = null): ManifestFile {
  return { path: p, owner: 'generated', beforeSha: before, afterSha: sha256(content), backup: null };
}

test('manifest path depends on the setting', () => {
  assert.equal(manifestPathFor('team'), path.join(process.env.HARNESS_HOME!, 'manifest.json'));
  assert.equal(manifestPathFor('personal', '/r'), path.join('/r', '.harness', 'manifest.json'));
  assert.throws(() => manifestPathFor('personal'));
});

test('classification: pristine, modified, missing, foreign', () => {
  const f = path.join(tmp, 'a.md');
  fs.writeFileSync(f, 'hello\n');
  const m = emptyManifest();
  m.files.push(entry(f, 'hello\n'));
  assert.equal(classifyEntry(m.files[0]), 'pristine');
  assert.equal(classifyPath(m, f), 'pristine');
  fs.writeFileSync(f, 'hello edited\n');
  assert.equal(classifyPath(m, f), 'modified');
  fs.unlinkSync(f);
  assert.equal(classifyPath(m, f), 'missing');
  assert.equal(classifyPath(m, path.join(tmp, 'other.md')), 'foreign');
});

test('save/load round trip and ownedPaths includes settings files once', () => {
  const p = path.join(tmp, 'm', 'manifest.json');
  const m = emptyManifest();
  m.files.push(entry('/x/AGENTS.md', 'a'));
  m.files.push(entry('/x/.claude/settings.json', 'b', 'c'));
  addSettingsEdit(m, { path: '/x/.claude/settings.json', key: 'permissions.deny', before: [], after: ['Bash(git push *)'] });
  addSettingsEdit(m, { path: '/x/.codex/hooks.json', key: 'hooks', before: undefined, after: {} });
  saveManifest(p, m);
  const back = loadManifest(p)!;
  assert.ok(back);
  assert.equal(back.files.length, 2);
  assert.deepEqual(ownedPaths(back).sort(), ['/x/.claude/settings.json', '/x/.codex/hooks.json', '/x/AGENTS.md'].sort());
  assert.equal(loadManifest(path.join(tmp, 'nope.json')), null);
});

test('mergeEntry keeps the original before-state when the chain is intact', () => {
  const m = emptyManifest();
  const first = mergeEntry(m, { path: '/x/f', owner: 'generated', beforeSha: null, afterSha: 'v1', backup: null });
  assert.equal(first.beforeSha, null);
  // second apply read the file while it was still v1 -> chained
  const second = mergeEntry(m, { path: '/x/f', owner: 'generated', beforeSha: 'v1', afterSha: 'v2', backup: '/b/f' });
  assert.equal(second.beforeSha, null, 'original before is kept');
  assert.equal(second.backup, null);
  assert.equal(second.afterSha, 'v2');
  assert.equal(m.files.length, 1);
  // user edited to v2x, third apply read v2x -> chain broken, new before wins
  const third = mergeEntry(m, { path: '/x/f', owner: 'generated', beforeSha: 'v2x', afterSha: 'v3', backup: '/b2/f' });
  assert.equal(third.beforeSha, 'v2x');
  assert.equal(third.backup, '/b2/f');
  assert.ok(removeEntry(m, '/x/f'));
  assert.equal(m.files.length, 0);
});

test('addSettingsEdit keeps the first before on a repeated key; createdDirs deepest first', () => {
  const m = emptyManifest();
  addSettingsEdit(m, { path: '/s.json', key: 'hooks', before: undefined, after: { a: 1 } });
  addSettingsEdit(m, { path: '/s.json', key: 'hooks', before: { a: 1 }, after: { a: 1, b: 2 } });
  assert.equal(m.settingsEdits.length, 1);
  assert.equal(m.settingsEdits[0].before, undefined);
  assert.deepEqual(m.settingsEdits[0].after, { a: 1, b: 2 });
  addCreatedDirs(m, ['/a', '/a/b/c', '/a/b']);
  addCreatedDirs(m, ['/a/b']);
  assert.deepEqual(m.createdDirs, ['/a/b/c', '/a/b', '/a']);
});

test('resignIntegrity writes integrity.json covering config and the machine manifest when present', () => {
  const home = process.env.HARNESS_HOME!;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(home, 'manifest.json'), '{"version":1,"files":[],"settingsEdits":[]}\n');
  const im = resignIntegrity('test');
  assert.ok(im.files[path.join(home, 'config.json')]);
  assert.ok(im.files[path.join(home, 'manifest.json')]);
  assert.ok(fs.existsSync(path.join(home, 'integrity.json')));
});
