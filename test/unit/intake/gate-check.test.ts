import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildBrief, lintCounts, type BriefFile } from '../../../src/intake/brief';
import { lintBrief } from '../../../src/intake/ambiguity';
import { classifyKind, extractFacts } from '../../../src/intake/classify';
import { gateSpec, gateStepsIn, ticketScopePaths } from '../../../src/intake/gatecheck';
import { verificationRows } from '../../../src/intake/writeup';
import { repoIdFor } from '../../../src/lib/config';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
let ctx: { config: { repos: Array<{ id: string; path: string; name: string; isGit: boolean }> }; defaultRepoPath: string };

before(() => {
  h = tempHome('harness-gatecheck-');
  repo = gitRepo(path.join(h.workspace, 'nodeapp'), { 'package.json': JSON.stringify({ name: 'nodeapp', scripts: { test: 'node --test' } }), '.nvmrc': '18\n' });
  ctx = { config: { repos: [{ id: 'nodeapp', path: repo, name: 'nodeapp', isGit: true }] }, defaultRepoPath: repo };
});
after(() => h.cleanup());

const P08_DESCRIPTION = [
  'Undo the Node 18 pin:',
  '',
  'The last commit pinned Node 18 in `.nvmrc`. That was a mistake:',
  '`package.json` says `node >=20`, CI runs Node 20, and the README\'s',
  '`node --env-file=.env dist/server.js` needs Node 20.6 or later. Please revert',
  'that commit. Keep the history as it is: no rebase, no force-push.',
].join('\n');

function p08(): BriefFile {
  const lines = [
    'Title: Undo the Node 18 pin',
    'Description:',
    P08_DESCRIPTION,
    'Acceptance Criteria:',
    '1. `.nvmrc` no longer exists on `main`.',
    '2. The pin commit is still in the history and a new commit undoes it; nothing else changes in the tree.',
    '3. CI-equivalent checks (lint, typecheck, test, build, format:check) still pass.',
  ];
  return buildBrief(lines.join('\n') + '\n', ctx);
}

test('P08: "the pin commit is still in the history ... nothing else changes" is a gate check with the ticket\'s path and keepsHistory', () => {
  const c = p08().criteria.find((x) => x.id === 'AC2')!;
  assert.equal(c.check?.kind, 'gate');
  assert.deepEqual(c.check?.scopePaths, ['.nvmrc']);
  assert.equal(c.check?.keepsHistory, true);
  assert.equal(c.check?.gateSteps, undefined);
  assert.match(c.check!.description, /^proved by the gate: /);
  assert.match(c.check!.description, /\.nvmrc/);
  assert.equal(c.check?.command, undefined);
});

test('P08: "CI-equivalent checks (...) still pass" is a gate check on lint, typecheck, tests:base and build', () => {
  const c = p08().criteria.find((x) => x.id === 'AC3')!;
  assert.equal(c.check?.kind, 'gate');
  assert.deepEqual(c.check?.gateSteps, ['lint', 'typecheck', 'tests:base', 'build']);
  assert.equal(c.check?.scopePaths, undefined);
  assert.equal(c.check?.keepsHistory, undefined);
});

test('P08: the brief lints clean, counts the gate checks as covered, and the write-up column reads "gate: <what>"', () => {
  const b = p08();
  // AC1 (the file is gone) waits on a question; the two gate checks raise no lint problem of their own
  assert.deepEqual(b.lint.filter((l) => !l.startsWith('AC1')), []);
  const gate = b.criteria.filter((c) => c.check?.kind === 'gate');
  assert.deepEqual(gate.map((c) => c.id), ['AC2', 'AC3']);
  assert.deepEqual(lintBrief({ criteria: gate, units: b.units.map((u) => ({ ...u, criteria: u.criteria.filter((x) => x !== 'AC1') })), open: [] }), []);
  const counts = lintCounts(b);
  assert.equal(counts.criteria, 3);
  assert.equal(counts.covered, b.criteria.filter((c) => c.check).length);
  assert.ok(counts.covered >= 2);
  const rows = verificationRows(b, ['AC2', 'AC3'], { evidence: null, evidenceStale: false, repoId: repoIdFor(repo), capReached: false } as never);
  assert.match(rows[0].check, /^gate: the change touches only \.nvmrc; the base commit stays in the history/);
  assert.match(rows[1].check, /^gate: lint, typecheck, tests:base, build pass in this run/);
});

test('lint: a gate check is covered even though it is not red-first', () => {
  const crit = { id: 'AC1', text: 'x', kind: 'unit' as const, check: { kind: 'gate' as const, description: 'proved by the gate: x', redFirst: false, gateSteps: ['lint'] } };
  assert.deepEqual(lintBrief({ criteria: [crit], open: [] }), []);
});

test('"existing tests still pass" alone is a gate check on tests:base (it replaces the round-1 green-at-base reading)', () => {
  for (const t of ['All existing tests still pass', 'The existing tests still pass', 'The test suite stays green', 'Lint and typecheck still pass', 'All checks keep passing', 'The build still passes']) {
    const spec = gateSpec(t, extractFacts(t));
    assert.equal(spec?.kind, 'gate', t);
    assert.equal(spec?.greenAtBase, undefined, t);
    assert.equal(classifyKind(t).kind, 'unit', t);
  }
  assert.deepEqual(gateSpec('All existing tests still pass', extractFacts('All existing tests still pass'))?.gateSteps, ['tests:base']);
  assert.deepEqual(gateStepsIn('Lint and typecheck still pass'), ['lint', 'typecheck']);
  assert.deepEqual(gateStepsIn('CI still passes'), ['lint', 'typecheck', 'tests:base', 'build']);
});

test('gate classification does not take criteria that name behaviour, a module or other work', () => {
  const none = [
    'The existing tests still pass and GET /health returns 200',
    'The orders tests still pass after the refactor',
    'GET /orders returns the same results as before with no behaviour change',
    'The invoice total is rounded to cents and the tests pass',
    'The build fails when a table is missing',
    'Nothing else changes for GET /orders',
  ];
  for (const t of none) assert.equal(gateSpec(t, extractFacts(t)), undefined, t);
  assert.equal(classifyKind('The existing tests still pass and GET /health returns 200').kind, 'api');
});

test('scope: the ticket\'s changed path is read from sentences about changing, not from every path it mentions', () => {
  const ticket = { title: 'Undo the Node 18 pin', description: P08_DESCRIPTION, criteria: ['`.nvmrc` no longer exists on `main`.'] };
  assert.deepEqual(ticketScopePaths(ticket, 'nothing else changes'), ['.nvmrc']);
  const spec = gateSpec('Nothing else changes in the tree', extractFacts('Nothing else changes in the tree'), ticket);
  assert.deepEqual(spec?.scopePaths, ['.nvmrc']);
  // no named path anywhere and no history wording: nothing the gate could check
  assert.equal(gateSpec('Nothing else changes in the tree', extractFacts('Nothing else changes in the tree')), undefined);
  // a path in the criterion itself
  const own = gateSpec('Only `src/config/limits.ts` changes', extractFacts('Only `src/config/limits.ts` changes'));
  assert.deepEqual(own?.scopePaths, ['src/config/limits.ts']);
  // history wording alone
  const hist = gateSpec('The history is kept: no rebase and no force-push', extractFacts('The history is kept: no rebase and no force-push'));
  assert.equal(hist?.keepsHistory, true);
  assert.equal(hist?.scopePaths, undefined);
});

test('"<file> contains the line \\"…\\"" and "\\"…\\" appears in <file>" are gate checks that read the file', () => {
  for (const [text, path, want] of [
    ['README.md contains the line "second line".', 'README.md', 'second line'],
    ['docs/SETUP.md includes the text `npm.cmd ci`', 'docs/SETUP.md', 'npm.cmd ci'],
    ['"HARNESS_JIRA_TOKEN" appears in docs/TEAM-SETUP.md', 'docs/TEAM-SETUP.md', 'HARNESS_JIRA_TOKEN'],
  ] as const) {
    const spec = gateSpec(text, extractFacts(text));
    assert.equal(spec?.kind, 'gate', text);
    assert.deepEqual(spec?.fileContains, { path, text: want }, text);
  }
  assert.equal(gateSpec('README.md contains setup steps', extractFacts('README.md contains setup steps'))?.fileContains, undefined, 'no quoted text: not a file-contains check');
});
