import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSession, saveSession, recordEdit, setPhase, getPhase, bumpAttempt, getAttempt, markInjected, setStatus, setLastPromptHash, sessionStatePath, safeSessionId, defaultSession, updateSession } from '../../../src/lib/session';

let tmp: string;
let prevHome: string | undefined;
let prevUser: string | undefined;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-session-'));
  prevHome = process.env.HARNESS_HOME;
  prevUser = process.env.HARNESS_USER_HOME;
  process.env.HARNESS_HOME = path.join(tmp, 'hh');
  process.env.HARNESS_USER_HOME = path.join(tmp, 'home');
});
after(() => {
  if (prevHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = prevHome;
  if (prevUser === undefined) delete process.env.HARNESS_USER_HOME;
  else process.env.HARNESS_USER_HOME = prevUser;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('default state when nothing is stored', () => {
  const s = loadSession('s1', 'codex');
  assert.equal(s.version, 1);
  assert.equal(s.sessionId, 's1');
  assert.equal(s.agent, 'codex');
  assert.deepEqual(s.edits, []);
  assert.deepEqual(s.injected, {});
  assert.deepEqual(s.attempts, {});
  assert.equal(s.status, 'working');
  assert.equal(s.phase, undefined);
  assert.equal(getPhase('s1'), undefined);
  assert.equal(getAttempt('s1', 'gate'), 0);
  assert.ok(!fs.existsSync(sessionStatePath('s1')));
});

test('save and load round-trip, atomic write leaves no temp files', () => {
  const s = defaultSession('s2', 'claude');
  s.phase = 'tests';
  saveSession(s);
  const p = sessionStatePath('s2');
  assert.ok(fs.existsSync(p));
  assert.ok(p.startsWith(path.join(tmp, 'hh', 'state')));
  const files = fs.readdirSync(path.dirname(p));
  assert.ok(files.every((f) => !f.endsWith('.tmp')), files.join(','));
  const back = loadSession('s2');
  assert.equal(back.phase, 'tests');
  assert.equal(back.agent, 'claude');
  assert.ok(back.updatedAt >= back.startedAt);
});

test('helpers used by other hooks', () => {
  recordEdit('s3', { path: '/x/a.ts', repo: 'r1' }, 'devin');
  recordEdit('s3', { path: '/x/b.ts' });
  const s = loadSession('s3');
  assert.equal(s.edits.length, 2);
  assert.equal(s.edits[0].repo, 'r1');
  assert.equal(s.edits[1].repo, '');
  assert.ok(s.edits[0].ts);
  assert.equal(s.agent, 'devin');
  setPhase('s3', 'implement');
  assert.equal(getPhase('s3'), 'implement');
  setPhase('s3', 'tests');
  assert.equal(getPhase('s3'), 'tests');
  assert.equal(bumpAttempt('s3', 'gate'), 1);
  assert.equal(bumpAttempt('s3', 'gate'), 2);
  assert.equal(bumpAttempt('s3', 'stop'), 1);
  assert.equal(getAttempt('s3', 'gate'), 2);
  assert.deepEqual(markInjected('s3', 'r1', ['a', 'b']), ['a', 'b']);
  assert.deepEqual(markInjected('s3', 'r1', ['b', 'c']), ['c']);
  assert.deepEqual(markInjected('s3', 'r2', ['a']), ['a']);
  assert.deepEqual(loadSession('s3').injected, { r1: ['a', 'b', 'c'], r2: ['a'] });
  setStatus('s3', 'asking');
  assert.equal(loadSession('s3').status, 'asking');
  const h = setLastPromptHash('s3', 'hello');
  assert.equal(h.length, 64);
  assert.equal(loadSession('s3').lastPromptHash, h);
  updateSession('s3', (x) => void (x.status = 'blocked'));
  assert.equal(loadSession('s3').status, 'blocked');
});

test('session ids are made file-safe and corrupt files fall back to defaults', () => {
  assert.equal(safeSessionId('abc-123_x.y'), 'abc-123_x.y');
  assert.equal(safeSessionId('../../etc/passwd'), safeSessionId('../../etc/passwd'));
  assert.doesNotMatch(safeSessionId('../../etc/passwd'), /\.\.\//);
  assert.doesNotMatch(safeSessionId('a/b\\c:d'), /[/\\:]/);
  assert.ok(safeSessionId('x'.repeat(200)).length < 100);
  assert.notEqual(safeSessionId('x'.repeat(200)), safeSessionId('x'.repeat(201)));
  assert.equal(safeSessionId(''), 'nosession');
  const p = sessionStatePath('corrupt');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not json');
  assert.equal(loadSession('corrupt').status, 'working');
  fs.writeFileSync(p, JSON.stringify({ version: 2 }));
  assert.equal(loadSession('corrupt').version, 1);
  fs.writeFileSync(p, JSON.stringify({ version: 1, edits: 'nope', phase: 'bogus' }));
  const s = loadSession('corrupt');
  assert.deepEqual(s.edits, []);
  assert.equal(getPhase('corrupt'), undefined);
});

test('edit log is capped', () => {
  const s = defaultSession('cap');
  for (let i = 0; i < 2500; i++) s.edits.push({ path: `/f${i}`, repo: '', ts: 't' });
  saveSession(s);
  const back = loadSession('cap');
  assert.equal(back.edits.length, 2000);
  assert.equal(back.edits[0].path, '/f500');
});
