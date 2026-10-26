/**
 * Local changes present when a ticket starts (the user's notes) are not the
 * ticket's: the gate's diff, the secret scan and the write-up leave them out
 * while they stay unchanged; the agent's own work is always in.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as gateMain } from '../../../src/commands/gate';
import { runGate } from '../../../src/gate';
import { buildContext } from '../../../src/gate/context';
import { runSecrets } from '../../../src/gate/secrets';
import { repoIdFor } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import { recordBriefSnapshots, readStartSnapshot, snapshotPath, DELETED } from '../../../src/intake/localchanges';
import { capture } from '../commands/capture';
import { demoRepo, git, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-local-');
});
after(() => h.cleanup());

const TOKEN = 'ghp_' + 'B'.repeat(36);
const NOTE = 'notes/my investigation ü.md';
const HOUR = 3600_000;

/** Make a file look like it was last written an hour ago (the user's note, before the ticket). */
function age(root: string, rel: string, ms = HOUR): void {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(path.join(root, rel), t, t);
}

/**
 * A repository with the user's local changes in it, then the ticket's intake:
 * an untracked note (with a secret-shaped line), a modified tracked doc and a
 * tracked file deleted, all an hour old.
 */
function setup(): { repo: string; task: string } {
  const repo = demoRepo(path.join(h.workspace, `l${++n}`), { 'docs/guide.md': '# Guide\n', 'docs/old.md': '# Old\n' });
  put(repo, NOTE, `my notes\ntoken I was testing with: ${TOKEN}\n`);
  age(repo, NOTE);
  put(repo, 'docs/guide.md', '# Guide\n\nmy own edit\n');
  age(repo, 'docs/guide.md');
  fs.rmSync(path.join(repo, 'docs/old.md'));
  const task = `t-local-${n}`;
  const id = repoIdFor(repo);
  const b = writeBrief(repo, task, [], { repoMap: { ticket: [id], byCriterion: {}, repos: { [id]: { name: path.basename(repo), path: repo } } } });
  const rec = recordBriefSnapshots(b, 'intake');
  assert.equal(rec.length, 1);
  return { repo, task };
}

function diffPaths(repo: string, task: string): string[] {
  return buildContext({ repo, task }).diff.map((d) => d.path).sort();
}

test('the snapshot holds every local change with its git hash or the deleted marker, never content', () => {
  const { repo, task } = setup();
  const snap = readStartSnapshot(repoIdFor(repo), task)!;
  assert.ok(snap);
  assert.deepEqual(snap.entries.map((e) => e.path).sort(), ['docs/guide.md', 'docs/old.md', NOTE].sort());
  const byPath = new Map(snap.entries.map((e) => [e.path, e.state]));
  assert.equal(byPath.get('docs/old.md'), DELETED);
  assert.equal(byPath.get(NOTE), git(repo, ['hash-object', '--', NOTE]).stdout.trim());
  assert.equal(byPath.get('docs/guide.md'), git(repo, ['hash-object', '--', 'docs/guide.md']).stdout.trim());
  const raw = fs.readFileSync(snapshotPath(repoIdFor(repo), task), 'utf8');
  assert.ok(!raw.includes(TOKEN) && !raw.includes('my notes') && !raw.includes('my own edit'), 'no file content in the snapshot');
  for (const e of snap.entries) assert.match(e.state, /^(?:[0-9a-f]{40}|[0-9a-f]{64}|deleted)$/);
});

test("local changes present at intake are out of the gate's diff and secret scan; the agent's new file and a change to a clean file are in", async () => {
  const { repo, task } = setup();
  put(repo, 'src/mul.js', 'exports.mul = (a, b) => a * b;\n');
  put(repo, 'src/add.js', 'exports.add = (a, b) => b + a;\n');
  assert.deepEqual(diffPaths(repo, task), ['src/add.js', 'src/mul.js']);
  const ctx = buildContext({ repo, task });
  assert.deepEqual([...ctx.addedLines().keys()].sort(), ['src/add.js', 'src/mul.js']);
  assert.deepEqual(ctx.local.leftOut, ['docs/guide.md', 'docs/old.md', NOTE].sort());
  assert.equal(runSecrets(ctx).status, 'pass', 'the secret-shaped line in the note is not part of the change');
  // The agent's own secret is still caught.
  put(repo, 'src/client.js', `const auth = '${TOKEN}';\n`);
  const sec = runSecrets(buildContext({ repo, task }));
  assert.equal(sec.status, 'fail');
  assert.match(sec.reasons.join('\n'), /src\/client\.js:1: secret-shaped text/);
  assert.doesNotMatch(sec.reasons.join('\n'), /notes\//);
});

test('harness gate prints only the count of left-out local changes; --json lists them; the write-up leaves them out', async () => {
  const { repo, task } = setup();
  put(repo, 'src/mul.js', 'exports.mul = (a, b) => a * b;\n');
  const out = await capture(() => gateMain(['--repo', repo, '--task', task, '--steps', 'tamper,secrets']));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /3 local changes present when the ticket started were left out of this check/);
  assert.ok(!out.stdout.includes('notes/') && !out.stdout.includes('docs/guide.md') && !out.stdout.includes('docs/old.md'), 'no names in the agent-facing output');
  const js = await capture(() => gateMain(['--repo', repo, '--task', task, '--json']));
  const j = JSON.parse(js.stdout);
  assert.deepEqual(j.localChanges.leftOut, ['docs/guide.md', 'docs/old.md', NOTE].sort());
  assert.deepEqual(j.evidence.localChanges, { leftOut: 3, changedSince: 0 });
  const wu = fs.readFileSync(path.join(runsDir(), repoIdFor(repo), task, 'writeup.md'), 'utf8');
  const changed = wu.slice(wu.indexOf('## What changed'), wu.indexOf('## Scope'));
  assert.match(changed, /`src\/mul\.js`/);
  assert.ok(!changed.includes('notes/') && !changed.includes('docs/guide.md') && !changed.includes('docs/old.md'), changed);
});

test('a note edited after intake is in, and the write-up marks it as changed during the ticket', async () => {
  const { repo, task } = setup();
  put(repo, NOTE, `my notes\ntoken I was testing with: ${TOKEN}\nmore\n`);
  assert.deepEqual(diffPaths(repo, task), [NOTE]);
  const ctx = buildContext({ repo, task });
  assert.deepEqual(ctx.local.changedSince, [NOTE]);
  assert.equal(runSecrets(ctx).status, 'fail', 'a recorded path that changed is scanned again');
  await capture(() => gateMain(['--repo', repo, '--task', task, '--steps', 'tamper']));
  const r = await runGate({ repo, task, stepDefs: () => [] });
  assert.deepEqual(r.evidence.localChanges, { leftOut: 2, changedSince: 1 });
  const { gatherRepoWork, renderWriteup } = await import('../../../src/intake/writeup');
  const { loadBrief } = await import('../../../src/intake/brief');
  const b = loadBrief(task)!;
  const w = gatherRepoWork(b, repoIdFor(repo), 'repo', repo);
  assert.deepEqual(w.changes.map((c) => c.file), [NOTE]);
  const text = renderWriteup({ brief: b, setting: 'team', repos: [w] }, w);
  assert.ok(text.includes(`\`${NOTE}\` new, untracked - changed during the ticket (you had local changes in it before)`), text);
});

test('a file deleted at the start and left deleted is out; restored with other content it is in', () => {
  const { repo, task } = setup();
  assert.ok(!diffPaths(repo, task).includes('docs/old.md'));
  put(repo, 'docs/old.md', '# Old, rewritten\n');
  const ctx = buildContext({ repo, task });
  assert.deepEqual(ctx.diff.map((d) => `${d.status} ${d.path}`), ['M docs/old.md']);
  assert.deepEqual(ctx.local.changedSince, ['docs/old.md']);
  // Restored exactly as at the base: no change at all, so nothing to leave out or check.
  put(repo, 'docs/old.md', '# Old\n');
  const again = buildContext({ repo, task });
  assert.deepEqual(again.diff, []);
  assert.ok(!again.local.leftOut.includes('docs/old.md'));
});

test('a recorded local change that is committed during the ticket is part of the change (it ships)', () => {
  const { repo, task } = setup();
  git(repo, ['add', '--', NOTE]);
  git(repo, ['commit', '-q', '-m', 'agent commits the note']);
  const ctx = buildContext({ repo, task });
  assert.ok(ctx.diff.some((d) => d.path === NOTE), 'a committed note is in');
  assert.equal(runSecrets(ctx).status, 'fail');
});

test('the agent cannot hide its work: a snapshot taken at intake leaves out files an agent session edited', () => {
  const repo = demoRepo(path.join(h.workspace, `l${++n}`));
  put(repo, 'src/agent.js', 'module.exports = 1;\n');
  age(repo, 'src/agent.js');
  put(repo, 'notes.md', 'mine\n');
  age(repo, 'notes.md');
  const state = path.join(process.env.HARNESS_HOME!, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'sess-agent.json'), JSON.stringify({ version: 1, sessionId: 'sess-agent', edits: [{ path: path.join(repo, 'src', 'agent.js'), repo: repoIdFor(repo), ts: new Date().toISOString() }] }));
  try {
    const task = `t-local-${n}`;
    const id = repoIdFor(repo);
    const b = writeBrief(repo, task, [], { repoMap: { ticket: [id], byCriterion: {}, repos: { [id]: { name: 'r', path: repo } } } });
    const [rec] = recordBriefSnapshots(b, 'intake');
    assert.deepEqual(rec.snapshot!.entries.map((e) => e.path), ['notes.md']);
    assert.equal(rec.snapshot!.withheld, 1);
    assert.deepEqual(diffPaths(repo, task), ['src/agent.js']);
  } finally {
    fs.rmSync(path.join(state, 'sess-agent.json'), { force: true });
  }
});

test('a task without a snapshot gets one at the first gate run, recording only what predates the task', () => {
  const repo = demoRepo(path.join(h.workspace, `l${++n}`));
  put(repo, 'notes.md', 'mine\n');
  age(repo, 'notes.md', 2 * HOUR);
  const task = `t-local-${n}`;
  writeBrief(repo, task, [], { createdAt: new Date(Date.now() - HOUR).toISOString() });
  // Written after the task started: the agent's.
  put(repo, 'src/new.js', 'module.exports = 2;\n');
  assert.equal(readStartSnapshot(repoIdFor(repo), task), null);
  assert.deepEqual(diffPaths(repo, task), ['src/new.js']);
  const snap = readStartSnapshot(repoIdFor(repo), task)!;
  assert.equal(snap.by, 'gate');
  assert.deepEqual(snap.entries.map((e) => e.path), ['notes.md']);
  assert.equal(snap.withheld, 1);
});

test('hook runs (pre-commit) ignore the snapshot: a staged note is checked', () => {
  const { repo } = setup();
  git(repo, ['add', '--', NOTE]);
  const ctx = buildContext({ repo, hook: 'pre-commit' });
  assert.ok(ctx.diff.some((d) => d.path === NOTE));
  assert.deepEqual(ctx.local.leftOut, []);
});
