import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as intakeMain } from '../../../src/commands/intake';
import { buildBrief, loadBrief } from '../../../src/intake/brief';
import { unattendedOption } from '../../../src/intake/ambiguity';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import { capture } from '../commands/capture';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
let ctx: { config: { repos: Array<{ id: string; path: string; name: string; isGit: boolean }> }; defaultRepoPath: string };
let n = 0;

before(() => {
  h = tempHome('harness-unattended-');
  repo = gitRepo(path.join(h.workspace, 'orders-api'), { 'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run' } }) });
  const repos = [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }];
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos }));
  ctx = { config: { repos }, defaultRepoPath: repo };
});
after(() => h.cleanup());

const ticket = (extra = '') => `Title: Faster search ${extra}${++n}\nAcceptance Criteria:\n1. GET /search returns results\n2. Search must be fast\n`;
const file = (name: string, text: string) => {
  const p = path.join(h.root, name);
  fs.writeFileSync(p, text);
  return p;
};

test('unattended: a blocking question takes the recommended option, recorded as an assumption; the criterion gets its check; the question stays listed', () => {
  const t = ticket();
  const waiting = buildBrief(t, ctx);
  assert.deepEqual(waiting.markers, ['AC2'], 'without --unattended the criterion waits');
  assert.equal(waiting.criteria[1].check, undefined);

  const b = buildBrief(t, { ...ctx, unattended: true });
  assert.deepEqual(b.markers, []);
  assert.ok(b.criteria[1].check, 'AC2 is classified with the recommended answer');
  assert.equal(b.criteria[1].question, undefined);
  assert.ok(b.assumptions.includes('AC2: answered Q1 (meaning): p95 under 500 ms (unattended: no one to answer)'), b.assumptions.join('\n'));
  assert.deepEqual(b.lint, []);
  assert.equal(b.questionDetails.length, 1, 'still listed so a person can overturn it');
  assert.equal(b.questionDetails[0].n, 1);
  assert.equal(b.questionDetails[0].unattended, true);
  assert.equal(b.questionDetails[0].blocking, false);
  assert.equal(b.clarifications[0].unattended, true);
  assert.equal(b.questions.length, 1);
});

test('unattended: building again keeps the same question numbers and does not ask twice', () => {
  const t = ticket('again ');
  const a = buildBrief(t, { ...ctx, unattended: true });
  const b = buildBrief(t, { ...ctx, unattended: true });
  assert.deepEqual(b.questionDetails.map((q) => [q.n, q.key]), a.questionDetails.map((q) => [q.n, q.key]));
  assert.equal(b.clarifications.length, 1);
});

test('unattended: an option that only hands the choice back to a person is skipped', () => {
  assert.equal(unattendedOption({ options: ['p95 under 500 ms', 'p95 under 200 ms'], recommended: 0 }), 'p95 under 500 ms');
  assert.equal(
    unattendedOption({ options: ['Tell me the exact result to check', 'Treat it as a manual check you review in the write-up', 'Drop it from this ticket'], recommended: 0 }),
    'Treat it as a manual check you review in the write-up',
  );
  assert.equal(unattendedOption({ options: ['I will list them (one per line)', 'Use the title as the only criterion'], recommended: 0 }), 'Use the title as the only criterion');
  assert.equal(unattendedOption({ options: ['Another limit: say which'], recommended: 0 }), 'Another limit: say which');
});

test('harness intake --unattended and HARNESS_UNATTENDED=1: nothing waits, the Questions section still lists the question', async () => {
  const p = file('u1.txt', ticket('flag '));
  const r = await capture(() => intakeMain(['--from', p, '--repo', repo, '--unattended']));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AC2 {2}\[nonfunctional [\d.]+\] Search must be fast/);
  assert.match(r.stdout, /Q1 \[meaning, AC2, assumed: unattended\]/);
  assert.doesNotMatch(r.stdout, /blocks AC2/);
  assert.match(r.stdout, /AC2: answered Q1 \(meaning\): p95 under 500 ms \(unattended: no one to answer\)/);
  assert.match(r.stdout, /harness intake answer t-[0-9a-f]{10} --q <n>/);

  const p2 = file('u2.txt', ticket('env '));
  process.env.HARNESS_UNATTENDED = '1';
  try {
    const e = await capture(() => intakeMain(['--from', p2, '--repo', repo]));
    assert.equal(e.code, 0, e.stderr);
    assert.match(e.stdout, /\(unattended: no one to answer\)/);
  } finally {
    delete process.env.HARNESS_UNATTENDED;
  }
  const plain = await capture(() => intakeMain(['--from', file('u3.txt', ticket('plain ')), '--repo', repo]));
  assert.match(plain.stdout, /Q1 \[meaning, AC2, blocks AC2\]/);
});

test('harness intake answer <id> --all-recommended takes the recommended option for the blocking questions; a later answer overturns it', async () => {
  const p = file('a1.txt', ticket('all '));
  const first = await capture(() => intakeMain(['--from', p, '--repo', repo]));
  const id = /Brief (t-[0-9a-f]{10})/.exec(first.stdout)![1];
  assert.match(first.stdout, /blocks AC2/);

  const all = await capture(() => intakeMain(['answer', id, '--all-recommended']));
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /Took the recommended option for Q1/);
  let b = loadBrief(id)!;
  assert.deepEqual(b.markers, []);
  assert.ok(b.criteria[1].check);
  assert.ok(b.assumptions.some((a) => a.endsWith('p95 under 500 ms (unattended: no one to answer)')));

  const again = await capture(() => intakeMain(['answer', id, '--all-recommended']));
  assert.match(again.stdout, /No blocking question is open/);

  const over = await capture(() => intakeMain(['answer', id, '--q', '1', '--answer', 'p95 under 200 ms']));
  assert.equal(over.code, 0, over.stderr);
  b = loadBrief(id)!;
  assert.equal(b.clarifications.length, 1, 'the person\'s answer replaced the recommended one');
  assert.equal(b.clarifications[0].unattended, undefined);
  assert.equal(b.clarifications[0].a, 'p95 under 200 ms');
  assert.ok(b.assumptions.some((a) => a.includes('p95 under 200 ms') && !a.includes('unattended')));
  assert.equal(b.questionDetails.length, 0);
});

test('harness intake answer without --q and without --all-recommended is a usage error', async () => {
  const r = await capture(() => intakeMain(['answer', 't-0000000000']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--all-recommended/);
});

test('a ticket with no criteria: unattended takes the title as the only criterion option instead of waiting for a list', () => {
  const b = buildBrief(`Title: Something vague ${++n}\n`, { ...ctx, unattended: true });
  assert.deepEqual(b.markers, []);
  assert.ok(b.assumptions.some((a) => a.includes('Use the title as the only criterion') && a.includes('(unattended: no one to answer)')), b.assumptions.join('\n'));
});
