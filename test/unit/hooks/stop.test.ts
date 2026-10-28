import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handle as stopHandle } from '../../../src/hooks/Stop';
import { handle as subagentStopHandle } from '../../../src/hooks/SubagentStop';
import { handle as taskCompletedHandle } from '../../../src/hooks/TaskCompleted';
import { evaluateStop, attemptKey, treeNow } from '../../../src/hooks/evidence';
import { renderOutput } from '../../../src/hook';
import { recordEdit, loadSession, saveSession } from '../../../src/lib/session';
import { repoIdFor, saveConfig, defaultConfig } from '../../../src/lib/config';
import type { AgentId } from '../../../src/types';
import { ctxFor, events, makeRepo, sandbox, treeOf, writeEvidence, writeFile, type Sandbox } from './helpers';

let sb: Sandbox;
let repo: string;
let n = 0;
const sid = () => `stop-${++n}`;

before(() => {
  sb = sandbox('harness-stop-');
});
after(() => sb.restore());
beforeEach(() => {
  repo = makeRepo(path.join(sb.tmp, `repo${n}`), { 'src/a.ts': 'export const a = 1;\n', 'README.md': '# r\n' });
});

function edit(s: string, file = path.join(repo, 'src', 'a.ts')): void {
  recordEdit(s, { path: file, repo: repoIdFor(repo) });
}

test('Stop: an empty edit log lets the agent stop (all three agents)', async () => {
  for (const agent of ['claude', 'codex', 'devin'] as AgentId[]) {
    const s = sid();
    const r = await stopHandle({ session_id: s, hook_event_name: 'Stop', stop_hook_active: false }, ctxFor(agent, 'Stop', s));
    assert.equal(r.exitCode, 0);
    assert.equal(renderOutput(agent, 'Stop', r), null);
  }
});

test('Stop: edits without evidence block with "run `harness gate`" and the exact command', async () => {
  const s = sid();
  edit(s);
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('codex', 'Stop', s));
  assert.equal(r.exitCode, 2);
  assert.match(String(r.stderr), /Run `harness gate`/);
  assert.match(String(r.stderr), /no evidence yet/);
  assert.ok(String(r.stderr).includes(`harness gate --repo "${repo}"`), 'Codex re-prompts with the reason, so it carries the exact command');
  const out = renderOutput('codex', 'Stop', r) as Record<string, unknown>;
  assert.equal(out.decision, 'block');
  assert.match(String(out.reason), /harness gate/);
  assert.equal(loadSession(s).attempts[attemptKey(repoIdFor(repo), null)], 1);
});

test('Stop: never blocks twice for the same unchanged tree and evidence', async () => {
  const s = sid();
  edit(s);
  const first = await stopHandle({ session_id: s, hook_event_name: 'Stop', stop_hook_active: false }, ctxFor('claude', 'Stop', s));
  assert.equal(first.exitCode, 2);
  const second = await stopHandle({ session_id: s, hook_event_name: 'Stop', stop_hook_active: true }, ctxFor('claude', 'Stop', s));
  assert.equal(second.exitCode, 0, 'unchanged tree: released');
  assert.equal(loadSession(s).attempts[attemptKey(repoIdFor(repo), null)], 1, 'the release does not count as an attempt');
  // A change to the tree makes a new block legitimate.
  writeFile(repo, 'src/a.ts', 'export const a = 2;\n');
  edit(s);
  const third = await stopHandle({ session_id: s, hook_event_name: 'Stop', stop_hook_active: true }, ctxFor('claude', 'Stop', s));
  assert.equal(third.exitCode, 2);
  assert.ok(events().some((e) => e.event === 'stop.unchanged'));
});

test('Stop: fresh PASS evidence (tree hash equals write-tree now) lets the agent stop', async () => {
  const s = sid();
  writeFile(repo, 'src/a.ts', 'export const a = 3;\n');
  edit(s);
  writeEvidence(repo, 't-pass', { verdict: 'PASS', treeHash: treeOf(repo) });
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
  assert.equal(r.exitCode, 0, String(r.stderr));
});

test('Stop: BLOCKED evidence for the current tree also lets the agent stop', async () => {
  const s = sid();
  edit(s);
  writeEvidence(repo, 't-blocked', { verdict: 'BLOCKED', reasons: ['needs a product decision'], treeHash: treeOf(repo) });
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('devin', 'Stop', s));
  assert.equal(r.exitCode, 0);
});

test('Stop: stale evidence (the tree changed after the gate ran) blocks', async () => {
  const s = sid();
  edit(s);
  writeEvidence(repo, 't-stale', { verdict: 'PASS', treeHash: treeOf(repo) });
  writeFile(repo, 'src/a.ts', 'export const a = 4;\n');
  edit(s);
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
  assert.equal(r.exitCode, 2);
  assert.match(String(r.stderr), /stale/);
});

test('Stop: FAIL evidence blocks with the last failure list', async () => {
  const s = sid();
  edit(s);
  writeEvidence(repo, 't-fail', { verdict: 'FAIL', reasons: ['tests: 2 failing in src/a.test.ts', 'lint: no-console in src/a.ts'], treeHash: treeOf(repo) });
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
  assert.equal(r.exitCode, 2);
  assert.match(String(r.stderr), /tests: 2 failing/);
  assert.match(String(r.stderr), /lint: no-console/);
  assert.match(String(r.stderr), /harness gate/);
});

test('Stop: at the attempt cap the agent is let go and cap_reached is written into the evidence', async () => {
  const s = sid();
  edit(s);
  const evPath = writeEvidence(repo, 't-cap', { verdict: 'FAIL', reasons: ['still failing'], treeHash: 'deadbeef' });
  const st = loadSession(s);
  st.attempts[attemptKey(repoIdFor(repo), 't-cap')] = 8;
  saveSession(st);
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
  assert.equal(r.exitCode, 0);
  const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
  assert.equal(ev.cap_reached, true);
  assert.equal(ev.verdict, 'FAIL', 'the verdict is untouched');
  assert.ok(events().some((e) => e.event === 'stop.cap'));
});

test('Stop: the cap comes from the config (gateAttempts) and without evidence a cap.json is written', async () => {
  saveConfig(defaultConfig({ caps: { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 2 } }));
  try {
    const s = sid();
    edit(s);
    const a = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
    assert.equal(a.exitCode, 2);
    assert.match(String(a.stderr), /Stop attempt 1 of 2/);
    writeFile(repo, 'src/a.ts', 'export const a = 5;\n');
    edit(s);
    const b = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
    assert.equal(b.exitCode, 2);
    writeFile(repo, 'src/a.ts', 'export const a = 6;\n');
    edit(s);
    const c = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
    assert.equal(c.exitCode, 0, 'third stop: cap of 2 reached');
    const cap = JSON.parse(fs.readFileSync(path.join(sb.hh, 'runs', repoIdFor(repo), 'none', 'cap.json'), 'utf8'));
    assert.equal(cap.cap_reached, true);
  } finally {
    fs.rmSync(path.join(sb.hh, 'config.json'), { force: true });
  }
});

test('SubagentStop and TaskCompleted run the same check', async () => {
  const s = sid();
  edit(s);
  const a = await subagentStopHandle({ session_id: s, hook_event_name: 'SubagentStop' }, ctxFor('claude', 'SubagentStop', s));
  assert.equal(a.exitCode, 2);
  assert.equal((renderOutput('claude', 'SubagentStop', a) as Record<string, unknown>).decision, 'block');
  writeFile(repo, 'src/a.ts', 'export const a = 7;\n');
  edit(s);
  const b = await taskCompletedHandle({ session_id: s, hook_event_name: 'TaskCompleted' }, ctxFor('claude', 'TaskCompleted', s));
  assert.equal(b.exitCode, 2);
  writeEvidence(repo, 't-sub', { verdict: 'PASS', treeHash: treeOf(repo) });
  const c = await taskCompletedHandle({ session_id: s, hook_event_name: 'TaskCompleted' }, ctxFor('claude', 'TaskCompleted', s));
  assert.equal(c.exitCode, 0);
});

test('Stop: edits in two repos need evidence for both', async () => {
  const s = sid();
  const other = makeRepo(path.join(sb.tmp, `other${n}`), { 'x.ts': 'export {};\n' });
  edit(s);
  recordEdit(s, { path: path.join(other, 'x.ts'), repo: repoIdFor(other) });
  writeEvidence(repo, 't-two', { verdict: 'PASS', treeHash: treeOf(repo) });
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('claude', 'Stop', s));
  assert.equal(r.exitCode, 2);
  assert.ok(String(r.stderr).includes(path.basename(other)), 'names the repo without evidence');
  assert.ok(!String(r.stderr).includes(`- ${path.basename(repo)}:`), 'the passing repo is not listed');
});

test('Stop: the tree hash is cached until an edited file, the index or the evidence changes', () => {
  const s = sid();
  edit(s);
  const id = repoIdFor(repo);
  const files = [path.join(repo, 'src', 'a.ts')];
  const a = treeNow(id, repo, files, null, 0, 5000);
  const b = treeNow(id, repo, files, null, 0, 5000);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(a.tree, b.tree);
  writeFile(repo, 'src/a.ts', 'export const a = 99;\n');
  const c = treeNow(id, repo, files, null, 0, 5000);
  assert.equal(c.cached, false);
  assert.notEqual(c.tree, a.tree);
  const d = treeNow(id, repo, files, null, 1, 5000);
  assert.equal(d.cached, false, 'a shell call since the last Stop invalidates the cache');
});

test('Stop: edits outside any repo are ignored', () => {
  const s = sid();
  recordEdit(s, { path: path.join(sb.tmp, 'loose.txt'), repo: '' });
  const o = evaluateStop({ session_id: s }, ctxFor('claude', 'Stop', s));
  assert.equal(o.outcome, 'no-edits');
});

test('Stop: edits in a second repository the ticket does not cover point at intake add-repo with the ticket id', async () => {
  const s = sid();
  writeFile(repo, 'src/a.ts', 'export const a = 9;\n');
  edit(s);
  writeEvidence(repo, 't-cross', { verdict: 'PASS', treeHash: treeOf(repo) });
  const other = makeRepo(path.join(sb.tmp, `other${n}`), { 'src/b.ts': 'export const b = 1;\n' });
  writeFile(other, 'src/b.ts', 'export const b = 2;\n');
  recordEdit(s, { path: path.join(other, 'src', 'b.ts'), repo: repoIdFor(other) });
  const r = await stopHandle({ session_id: s, hook_event_name: 'Stop' }, ctxFor('devin', 'Stop', s));
  assert.equal(r.exitCode, 2);
  assert.match(String(r.stderr), /edited, but not part of ticket t-cross/);
  assert.ok(String(r.stderr).includes(`harness intake add-repo "${other}" --task t-cross`), String(r.stderr));
});
