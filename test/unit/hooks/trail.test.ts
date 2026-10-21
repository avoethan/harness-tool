import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeTrail, openTrailLines, readTrails, renderTrail, trailPath, writeTrail, type TrailInput } from '../../../src/runctl/trail';
import { sandbox, type Sandbox } from './helpers';

let sb: Sandbox;
before(() => {
  sb = sandbox('harness-trail-');
});
after(() => sb.restore());

const base = (over: Partial<TrailInput> = {}): TrailInput => ({
  taskId: 't-0000000001',
  repoId: 'svc-abcdef',
  repoRoot: '/work/ws/svc',
  agent: 'claude',
  reason: 'PreCompact',
  intent: 'Add paging',
  files: [{ rel: 'src/a.ts', ts: '2026-10-19T10:00:00.000Z' }],
  editCount: 1,
  evidence: { verdict: 'PASS', treeHash: 'abc123def4567890', finishedAt: '2026-10-19T10:05:00.000Z', reasons: [] },
  treeNow: 'abc123def4567890',
  next: 'Re-run `harness gate`.',
  gotchas: ['no-console in src/a.ts'],
  now: new Date('2026-10-19T11:00:00.000Z'),
  ...over,
});

test('renderTrail has the header keys and every section', () => {
  const t = renderTrail(base());
  for (const s of ['status: open', 'repo: /work/ws/svc', 'task: t-0000000001', 'updated: 2026-10-19T11:00:00.000Z (PreCompact, claude)', '## Intent', '## Progress', '## Verified state', '## Next', '## Gotchas']) assert.ok(t.includes(s), s);
  assert.match(t, /The working tree has not changed since that run/);
  assert.match(t, /Inherited verified claims are never trusted/);
  const stale = renderTrail(base({ treeNow: 'ffff' }));
  assert.match(stale, /changed after that run/);
  const capped = renderTrail(base({ evidence: { verdict: 'FAIL', treeHash: 'a', finishedAt: '', reasons: ['x'], capReached: true } }));
  assert.match(capped, /cap_reached/);
});

test('trail text is single-line sanitised: hidden Unicode and line breaks never reach the file', () => {
  const p = writeTrail(base({ taskId: 't-hidden', intent: 'Title​ with\nbreak‮' }));
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /## Intent\nTitle with break\n/);
  assert.doesNotMatch(text, /[​‮]/);
});

test('open trails are filtered by workspace and status, newest first, and cut at the line limit', () => {
  writeTrail(base({ taskId: 't-a', repoRoot: '/work/ws/svc' }));
  writeTrail(base({ taskId: 't-b', repoRoot: '/elsewhere/repo' }));
  writeTrail(base({ taskId: 't-c', repoRoot: '/work/ws/other' }));
  closeTrail('t-c');
  const lines = openTrailLines(['/work/ws'], 200);
  const text = lines.join('\n');
  assert.match(text, /task: t-a/);
  assert.doesNotMatch(text, /task: t-b/);
  assert.doesNotMatch(text, /task: t-c/, 'closed trails are not printed');
  assert.ok(!lines.includes(''), 'printed form has no blank lines');
  const short = openTrailLines(['/work/ws'], 5);
  assert.equal(short.length, 5);
  assert.match(short[4], /trails cut at 5 lines/);
  const all = readTrails();
  assert.ok(all.find((x) => x.taskId === 't-c')?.status === 'closed');
  assert.equal(closeTrail('t-missing'), false);
});

test('task ids cannot escape the trail folder', () => {
  const p = trailPath('../../etc/passwd');
  assert.equal(path.dirname(p), path.join(sb.hh, 'trail'));
});
