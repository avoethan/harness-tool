/**
 * The start snapshot at intake, at `task claim` and from `harness task snapshot`,
 * and the one decision `isTicketPath` / `partitionChanges`.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as intakeMain } from '../../../src/commands/intake';
import { main as taskMain } from '../../../src/commands/task';
import { defaultConfig, repoIdFor, saveConfig } from '../../../src/lib/config';
import { addTask } from '../../../src/intake/ledger';
import { diffAgainst } from '../../../src/intake/writeup';
import { DELETED, indexOf, isTicketPath, localChangePaths, partitionChanges, readStartSnapshot, type StartSnapshot } from '../../../src/intake/localchanges';
import { capture } from '../commands/capture';
import { git, gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-localchanges-');
});
after(() => h.cleanup());

const HOUR = 3600_000;
function writeOld(root: string, rel: string, text: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  const t = new Date(Date.now() - HOUR);
  fs.utimesSync(p, t, t);
}

test('isTicketPath: unrecorded is the ticket\'s; recorded and unchanged is local; recorded and changed is marked; committed is never left out', () => {
  const snap: StartSnapshot = { version: 1, repoId: 'r', taskId: 't', base: null, recordedAt: '', by: 'intake', entries: [{ path: 'a.md', state: 'b1' }, { path: 'gone.md', state: DELETED }], withheld: 0 };
  const idx = indexOf(snap)!;
  assert.equal(isTicketPath(idx, 'src/x.js', 'zz'), 'ticket');
  assert.equal(isTicketPath(idx, 'a.md', 'b1'), 'local');
  assert.equal(isTicketPath(idx, 'a.md', 'b2'), 'local-changed');
  assert.equal(isTicketPath(idx, 'gone.md', null), 'local');
  assert.equal(isTicketPath(idx, 'gone.md', 'b3'), 'local-changed');
  assert.equal(isTicketPath(indexOf(snap, ['a.md'])!, 'a.md', 'b1'), 'local-changed');
  assert.equal(isTicketPath(null, 'a.md', 'b1'), 'ticket');
  // A rename is left out only when both sides are.
  const split = partitionChanges([{ path: 'new.md', oldPath: 'gone.md' }, { path: 'a.md' }], indexOf({ ...snap, entries: [...snap.entries, { path: 'new.md', state: 'n1' }] })!, (p) => ({ 'a.md': 'b1', 'new.md': 'n2' })[p] ?? null);
  assert.deepEqual(split.kept.map((k) => k.path), ['new.md']);
  assert.deepEqual(split.leftOut, ['a.md']);
  assert.deepEqual(split.changedSince, ['new.md']);
});

test('localChangePaths: forward-slash paths with spaces and non-ASCII, untracked files one by one, ignored files never', () => {
  const repo = gitRepo(path.join(h.workspace, 'paths'), { 'README.md': '# r\n', '.gitignore': 'build/\n' });
  writeOld(repo, 'my notes/réunion 1.md', 'x\n');
  writeOld(repo, 'my notes/deep/b.txt', 'y\n');
  writeOld(repo, 'build/out.js', 'z\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# r!\n');
  assert.deepEqual(localChangePaths(repo), ['README.md', 'my notes/deep/b.txt', 'my notes/réunion 1.md']);
  // The write-up's diff reads the same names unquoted.
  assert.deepEqual(diffAgainst(repo, 'HEAD').map((c) => c.file), ['my notes/deep/b.txt', 'my notes/réunion 1.md', 'README.md'].sort((a, b) => a.localeCompare(b)));
});

test('harness intake records the start snapshot of the mapped repo, does not overwrite it on a second intake, and intake show prints the count', async () => {
  const repo = gitRepo(path.join(h.workspace, 'orders-api'), { 'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run' } }), 'docs/a.md': '# a\n' });
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }] }));
  writeOld(repo, 'notes/todo.md', 'remember\n');
  writeOld(repo, 'docs/a.md', '# a, my edit\n');
  const ticket = path.join(h.root, 'ticket.txt');
  fs.writeFileSync(ticket, 'Title: Add order total\nAcceptance Criteria:\n1. GET /orders/:id returns total\n');
  const r = await capture(() => intakeMain(['--from', ticket, '--repo', repo]));
  assert.equal(r.code, 0, r.stderr);
  const id = /Brief (t-[0-9a-f]{10})/.exec(r.stdout)![1];
  assert.match(r.stdout, /Local changes present at the start in orders-api: 2 \(left out of the gate and the write-up while they stay unchanged\)/);
  const snap = readStartSnapshot(repoIdFor(repo), id)!;
  assert.equal(snap.by, 'intake');
  assert.deepEqual(snap.entries.map((e) => e.path), ['docs/a.md', 'notes/todo.md']);
  // The agent edits a file and runs intake again: the snapshot is kept, so the edit stays in the change.
  fs.writeFileSync(path.join(repo, 'src.js'), 'x\n');
  const again = await capture(() => intakeMain(['--from', ticket, '--repo', repo]));
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(readStartSnapshot(repoIdFor(repo), id)!.entries.map((e) => e.path), ['docs/a.md', 'notes/todo.md']);
  const show = await capture(() => intakeMain(['show', id]));
  assert.match(show.stdout, /Local changes present at the start in orders-api: 2/);
  assert.ok(!show.stdout.includes('notes/todo.md'), 'show prints a count, not names');
  saveConfig(defaultConfig({ setting: 'personal', workspaceRoot: h.workspace, repos: [] }));
});

test('task claim records the snapshot; task snapshot (user-run) re-records it as the tree is now', async () => {
  const repo = gitRepo(path.join(h.workspace, 'personal'), { 'README.md': '# p\n' });
  saveConfig(defaultConfig({ setting: 'personal', workspaceRoot: h.workspace, repos: [] }));
  const t = addTask(repo, { title: 'Add mul', acceptance: ['mul(2, 3) returns 6'] });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'ledger']);
  writeOld(repo, 'scratch.md', 'mine\n');
  const c = await capture(() => taskMain(['claim', t.id, '--repo', repo]));
  assert.equal(c.code, 0, c.stderr);
  const snap = readStartSnapshot(repoIdFor(repo), t.id)!;
  assert.equal(snap.by, 'claim');
  assert.deepEqual(snap.entries.map((e) => e.path), ['scratch.md']);
  assert.match(c.stdout, /1 local change\(s\) already in this repo are left out/);
  // The user edits a note on purpose mid-ticket and re-records.
  fs.writeFileSync(path.join(repo, 'scratch.md'), 'mine, more\n');
  fs.writeFileSync(path.join(repo, 'later.md'), 'new note\n');
  const s = await capture(() => taskMain(['snapshot', '--task', t.id, '--repo', repo]));
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /Recorded \d+ local change\(s\)/);
  const after = readStartSnapshot(repoIdFor(repo), t.id)!;
  assert.equal(after.by, 'user');
  assert.ok(after.entries.some((e) => e.path === 'later.md') && after.entries.some((e) => e.path === 'scratch.md'));
  assert.equal(after.withheld, 0, 'the user records the tree as it is');
  const none = await capture(() => taskMain(['snapshot', '--task', 'no-such-task', '--repo', repo]));
  assert.equal(none.code, 1);
});
