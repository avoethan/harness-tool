import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../../../src/lib/hash';
import {
  backupFile,
  backupRoot,
  listPlanIds,
  listPlanStamps,
  loadPlanRecord,
  mirrorPath,
  newBackupStamp,
  restoreFromBackup,
  savePlanRecord,
} from '../../../src/lifecycle/backup';

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-backup-'));
  process.env.HARNESS_HOME = path.join(tmp, 'home', '.harness');
  process.env.HARNESS_USER_HOME = path.join(tmp, 'home');
  process.env.HARNESS_NO_INSTRUMENT = '1';
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mirrorPath: POSIX, Windows drive letters, UNC and odd segments', () => {
  assert.equal(mirrorPath('/home/me/.claude/settings.json'), 'home/me/.claude/settings.json');
  assert.equal(mirrorPath('C:\\Users\\me\\.codex\\hooks.json'), 'c/Users/me/.codex/hooks.json');
  assert.equal(mirrorPath('d:/work/repo/AGENTS.md'), 'd/work/repo/AGENTS.md');
  assert.equal(mirrorPath('\\\\server\\share\\x\\AGENTS.md'), 'unc/server/share/x/AGENTS.md');
  assert.equal(mirrorPath('/a/../b/./c:d.txt'), 'a/__/b/c_d.txt');
  assert.ok(!mirrorPath('/a/b').startsWith('/'));
});

test('stamp is folder-safe on every platform', () => {
  const s = newBackupStamp(new Date('2026-10-19T05:17:00.000Z'));
  assert.equal(s, '2026-10-19T05-17-00.000Z');
  assert.ok(!/[:*?"<>|]/.test(s));
});

test('backupFile mirrors the absolute path and restoreFromBackup puts the bytes back', () => {
  const src = path.join(tmp, 'work', 'settings.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  const content = '{ "a": 1 } // comment\n';
  fs.writeFileSync(src, content);
  const stamp = newBackupStamp();
  const rec = backupFile('plan-1', stamp, src)!;
  assert.ok(rec);
  assert.equal(rec.sha, sha256(content));
  assert.ok(rec.backup.startsWith(backupRoot('plan-1', stamp)));
  assert.ok(rec.backup.endsWith(path.join(...mirrorPath(src).split('/'))));
  assert.equal(fs.readFileSync(rec.backup, 'utf8'), content);
  assert.equal(backupFile('plan-1', stamp, path.join(tmp, 'missing.txt')), null);

  fs.writeFileSync(src, 'changed');
  const sha = restoreFromBackup(rec.backup, src);
  assert.equal(sha, sha256(content));
  assert.equal(fs.readFileSync(src, 'utf8'), content);
  // restore into a folder that no longer exists
  const gone = path.join(tmp, 'gone', 'deeper', 'f.json');
  restoreFromBackup(rec.backup, gone);
  assert.equal(fs.readFileSync(gone, 'utf8'), content);
});

test('plan records: save, list newest first, load latest', () => {
  const base = { version: 1 as const, harnessVersion: '0', files: [], settingsEdits: [], setting: 'team' as const, manifestPath: '/m' };
  savePlanRecord({ ...base, planId: 'p1', stamp: '2026-01-01T00-00-00.000Z' });
  savePlanRecord({ ...base, planId: 'p1', stamp: '2026-01-02T00-00-00.000Z' });
  savePlanRecord({ ...base, planId: 'p2', stamp: '2026-01-03T00-00-00.000Z' });
  assert.deepEqual(listPlanStamps('p1'), ['2026-01-02T00-00-00.000Z', '2026-01-01T00-00-00.000Z']);
  assert.equal(loadPlanRecord('p1')!.stamp, '2026-01-02T00-00-00.000Z');
  assert.equal(loadPlanRecord('p1', '2026-01-01T00-00-00.000Z')!.stamp, '2026-01-01T00-00-00.000Z');
  assert.equal(loadPlanRecord('nope'), null);
  const ids = listPlanIds().map((x) => x.planId);
  assert.ok(ids.indexOf('p2') < ids.indexOf('p1'), 'newest apply first');
  assert.ok(ids.includes('plan-1'), 'the earlier test backup is listed too');
});
