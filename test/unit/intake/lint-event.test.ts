import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as intakeMain } from '../../../src/commands/intake';
import { lintCounts, loadBrief } from '../../../src/intake/brief';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import { capture } from '../commands/capture';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
let saved: string | undefined;

before(() => {
  h = tempHome('harness-lint-event-');
  saved = process.env.HARNESS_NO_INSTRUMENT;
  delete process.env.HARNESS_NO_INSTRUMENT;
  repo = gitRepo(path.join(h.workspace, 'orders-api'), { 'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run' } }) });
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }] }));
});
after(() => {
  if (saved !== undefined) process.env.HARNESS_NO_INSTRUMENT = saved;
  h.cleanup();
});

function events(): Array<{ event: string; task?: string; ids?: Record<string, string>; counts?: Record<string, number> }> {
  const p = path.join(process.env.HARNESS_HOME as string, 'logs', 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('intake and intake lint log an intake.lint event with counts of criteria, covered, open and rejected (no text)', async () => {
  const p = path.join(h.root, 't.txt');
  fs.writeFileSync(p, 'Title: Faster search\nAcceptance Criteria:\n1. GET /search returns results\n2. Search must be fast\n3. All existing tests still pass\n');
  const r = await capture(() => intakeMain(['--from', p, '--repo', repo]));
  assert.equal(r.code, 0, r.stderr);
  const id = /Brief (t-[0-9a-f]{10})/.exec(r.stdout)![1];
  let lint = events().filter((e) => e.event === 'intake.lint');
  assert.equal(lint.length, 1);
  assert.deepEqual(lint[0].counts, { criteria: 3, covered: 2, open: 1, rejected: 0 });
  assert.equal(lint[0].task, id);
  assert.deepEqual(lint[0].ids, { brief: id });

  const l = await capture(() => intakeMain(['lint', id]));
  assert.equal(l.code, 0);
  lint = events().filter((e) => e.event === 'intake.lint');
  assert.equal(lint.length, 2);
  assert.deepEqual(lint[1].counts, { criteria: 3, covered: 2, open: 1, rejected: 0 });

  const a = await capture(() => intakeMain(['answer', id, '--q', '1', '--answer', 'p95 under 500 ms']));
  assert.equal(a.code, 0, a.stderr);
  lint = events().filter((e) => e.event === 'intake.lint');
  assert.deepEqual(lint[2].counts, { criteria: 3, covered: 3, open: 0, rejected: 0 });

  const raw = fs.readFileSync(path.join(process.env.HARNESS_HOME as string, 'logs', 'events.jsonl'), 'utf8');
  assert.equal(raw.includes('Search must be fast'), false, 'the event carries no criterion text');
});

test('lintCounts: rejected counts the plan-lint problems', () => {
  const b = loadBrief('nope');
  assert.equal(b, null);
  const crit = (id: string, check: boolean) => ({ id, text: 'x', kind: 'unit' as const, ...(check ? { check: { kind: 'unit' as const, description: 'd', redFirst: true } } : {}) });
  assert.deepEqual(lintCounts({ criteria: [crit('AC1', true), crit('AC2', false)], lint: ['AC2: no check and no open question ("x")'], questionDetails: [], queued: [] }), { criteria: 2, covered: 1, open: 0, rejected: 1 });
});
