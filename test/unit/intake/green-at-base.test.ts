import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBrief, type BriefFile } from '../../../src/intake/brief';
import { lintBrief } from '../../../src/intake/ambiguity';
import { verificationRows } from '../../../src/intake/writeup';
import { classifyKind, cliSignals, dbDownCriterion, extractFacts, findHeaders, greenAtBaseByWording } from '../../../src/intake/classify';
import { repoIdFor } from '../../../src/lib/config';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
let ctx: { config: { repos: Array<{ id: string; path: string; name: string; isGit: boolean }> }; defaultRepoPath: string };

const README = ['# pantry', '', 'Run `pantry list --json` to get a JSON list.', '', '| Flag | Meaning |', '| --- | --- |', '| --json | machine readable output |', ''].join('\n');

before(() => {
  h = tempHome('harness-gab-');
  repo = gitRepo(path.join(h.workspace, 'pantry'), {
    'package.json': JSON.stringify({ name: 'pantry', bin: { pantry: 'dist/cli.js' }, scripts: { test: 'node --test' } }),
    'README.md': README,
  });
  ctx = { config: { repos: [{ id: 'pantry', path: repo, name: 'pantry', isGit: true }] }, defaultRepoPath: repo };
});
after(() => h.cleanup());

function brief(title: string, criteria: string[], description = ''): BriefFile {
  const lines = [`Title: ${title}`, ...(description ? ['Description:', description] : []), 'Acceptance Criteria:', ...criteria.map((c, i) => `${i + 1}. ${c}`)];
  return buildBrief(lines.join('\n') + '\n', ctx);
}

test('green-at-base: characterisation, no behaviour change and documentation-only criteria are unit checks marked greenAtBase; "existing tests still pass" is proved by the gate', () => {
  const b = brief('Tidy the orders code', [
    'Characterisation tests pin the current output of GET /orders',
    'No behaviour change for existing callers',
    'All existing tests still pass',
    'This is a documentation-only change',
    'The order total is rounded to cents',
  ]);
  for (const id of ['AC1', 'AC2', 'AC4']) {
    const c = b.criteria.find((x) => x.id === id)!;
    assert.equal(c.kind, 'unit', `${id} ${c.text}`);
    assert.equal(c.check?.kind, 'unit');
    assert.equal(c.check?.greenAtBase, true, id);
    assert.ok(c.check?.greenAtBaseReason, id);
    assert.equal(c.check?.redFirst, false);
    assert.match(c.check!.description, /green-at-base:/);
  }
  // round 3: the sentence alone is proved by the gate's own tests:base step, not by a test named AC3
  const suite = b.criteria.find((x) => x.id === 'AC3')!;
  assert.equal(suite.kind, 'unit');
  assert.equal(suite.check?.kind, 'gate');
  assert.deepEqual(suite.check?.gateSteps, ['tests:base']);
  assert.equal(suite.check?.greenAtBase, undefined);
  const normal = b.criteria.find((x) => x.id === 'AC5')!;
  assert.equal(normal.check?.greenAtBase, undefined);
  assert.equal(normal.check?.redFirst, true);
  assert.deepEqual(b.lint, [], 'lint counts a green-at-base check as covered');
  assert.equal(greenAtBaseByWording('Orders are sorted by date'), undefined);
});

test('green-at-base: lint accepts a check that is not red-first only when it is green-at-base', () => {
  const crit = (greenAtBase: boolean) => ({ id: 'AC1', text: 'x', kind: 'unit' as const, check: { kind: 'unit' as const, description: 'd', redFirst: false, ...(greenAtBase ? { greenAtBase: true } : {}) } });
  assert.deepEqual(lintBrief({ criteria: [crit(true)], open: [] }), []);
  assert.deepEqual(lintBrief({ criteria: [crit(false)], open: [] }), ['AC1: the check is not marked red-first']);
});

test('green-at-base: the write-up check column says "green-at-base: <reason>"', () => {
  const b = brief('Tidy', ['All existing tests still pass', 'The order total is rounded to cents']);
  const rows = verificationRows(b, ['AC1', 'AC2'], { evidence: null, evidenceStale: false, repoId: repoIdFor(repo), capReached: false } as never);
  assert.match(rows[0].check, /^gate: tests:base passes in this run/);
  assert.doesNotMatch(rows[1].check, /green-at-base|gate:/);
  const gab = brief('Tidy', ['No behaviour change for existing callers']);
  assert.match(verificationRows(gab, ['AC1'], { evidence: null, evidenceStale: false, repoId: repoIdFor(repo), capReached: false } as never)[0].check, /^unit: green-at-base: no behaviour change/);
});

test('README criteria become a unit check that the named file contains the named text; green-at-base when the text is already there', () => {
  const b = brief('Document the flag', [
    'The README documents the `--json` flag',
    'The README table lists the `--csv` flag',
    'README.md mentions "pantry list --json"',
    'The README explains how to install it',
  ]);
  const [c1, c2, c3, c4] = b.criteria;
  assert.equal(c1.kind, 'unit');
  assert.equal(c1.check?.greenAtBase, true);
  assert.match(c1.check!.greenAtBaseReason!, /^README\.md already holds "--json"/);
  assert.match(c1.check!.description, /reads README\.md and checks it contains "--json"/);
  assert.equal(c2.kind, 'unit', 'a README table was ui-artifact or untestable before');
  assert.equal(c2.check?.greenAtBase, undefined, '--csv is not in the README yet: red first');
  assert.equal(c2.check?.redFirst, true);
  assert.match(c2.check!.description, /reads README\.md and checks it contains "--csv"/);
  assert.equal(c3.check?.greenAtBase, true);
  assert.equal(c4.kind, 'unit');
  assert.equal(c4.check?.greenAtBase, undefined, 'no named text: nothing to compare, so red first');
});

test('F4: flags and quoted strings in a document match as whole tokens; a single-letter flag is never a needle', () => {
  const verbose = gitRepo(path.join(h.workspace, 'verbose'), {
    'package.json': JSON.stringify({ name: 'verbose', scripts: { test: 'node --test' } }),
    'README.md': '# verbose\n\nRun with --verbose for more output. Use --json-lines for streaming.\n',
  });
  const vctx = { config: { repos: [{ id: 'verbose', path: verbose, name: 'verbose', isGit: true }] }, defaultRepoPath: verbose };
  const b = buildBrief(['Title: Docs', 'Acceptance Criteria:', '1. The README documents the -v flag', '2. The README documents the `--verbose` flag', '3. The README documents the `--json` flag', ''].join('\n'), vctx);
  const [c1, c2, c3] = b.criteria;
  assert.equal(c1.check?.greenAtBase, undefined, '-v inside --verbose is not a match');
  assert.equal(c1.check?.redFirst, true);
  assert.equal(c2.check?.greenAtBase, true, 'the whole flag is there');
  assert.equal(c3.check?.greenAtBase, undefined, '--json is only a prefix of --json-lines');
});

test('command line: a flag, an exit code or printed output of a command-line tool is a unit check naming the command', () => {
  const b = brief('List pantry items', [
    '`--json` prints a JSON array of items',
    'The list command exits 1 when an item has expired',
    'It prints a table of the expiring items to stdout',
    '`-v` prints the version',
    'A non-zero exit code is returned for an unknown location',
    '`pantry list --json` prints an array',
  ]);
  for (const c of b.criteria) {
    assert.equal(c.kind, 'unit', `${c.id} ${c.text}`);
    assert.equal(c.check?.kind, 'unit');
    assert.equal(c.check?.redFirst, true);
  }
  assert.match(b.criteria[0].check!.description, /command-line tool `pantry` with `--json`/);
  assert.match(b.criteria[1].check!.description, /command-line tool `pantry`.*checks its exit code/);
  assert.match(b.criteria[2].check!.description, /checks its output/);
  assert.match(b.criteria[3].check!.description, /with `-v`/);
  assert.match(b.criteria[5].check!.description, /runs `pantry list --json`/);
  assert.deepEqual(cliSignals('`--json` prints a table').flags, ['--json']);
  assert.equal(cliSignals('exits 1 when the file is missing').exit, true);
  assert.equal(cliSignals('the e-mail is sent').flags.length, 0);
});

test('command line: the new rule leaves HTTP and database criteria alone', () => {
  assert.equal(classifyKind('GET /orders/:id returns total').kind, 'api');
  assert.equal(classifyKind('total stored in orders.total column').kind, 'db');
  assert.equal(classifyKind('GET /orders?sort=total prints nothing special to stdout of the server').kind, 'api');
});

test('code structure: a helper, an extraction or "no duplicated logic" is unit, never db or api, even when it names a table, column or route', () => {
  const b = brief('Orders total', [
    'A pure helper `computeTotal` with unit tests, used when writing the orders.total column',
    'The totals logic is extracted into a module, not repeated in GET /orders/:id',
    'There is no duplicated logic between the orders table and the invoices table',
    'A helper function formats the amount for the orders table',
    'The tax rule is shared in one place for POST /orders and PATCH /orders/:id',
  ]);
  for (const c of b.criteria) {
    assert.equal(c.kind, 'unit', `${c.id} ${c.text}`);
    assert.equal(c.check?.kind, 'unit');
    assert.equal(c.check?.command?.includes('harness verify'), false);
  }
  assert.equal(classifyKind('The helper text is shown on the form').kind, 'ui-artifact');
});

test('db down: a service that must answer while its database is down is api with the launch line and the drive line', () => {
  const b = brief(
    'Health check',
    ['GET /health answers 503 while the database is down', 'The service keeps answering when the database is unreachable', 'The endpoint answers while the database is down'],
    'Add GET /products/low-stock.',
  );
  const [c1, c2, c3] = b.criteria;
  for (const c of b.criteria) {
    assert.equal(c.kind, 'api', c.text);
    assert.equal(c.check?.kind, 'e2e-http');
  }
  assert.deepEqual(c1.check!.command!.split('\n'), ['harness verify launch --db-unreachable', 'harness verify drive --method GET --path /health --expect-status 503 --criterion AC1']);
  assert.deepEqual(c2.check!.command!.split('\n')[0], 'harness verify launch --db-unreachable');
  assert.match(c2.check!.command!, /harness verify drive --method GET --path \S+ --expect-status 503 --criterion AC2$/);
  assert.match(c3.check!.command!, /--path \/products\/low-stock --expect-status 503/);
  assert.equal(dbDownCriterion('The orders table has a total column'), false);
  assert.equal(dbDownCriterion('The service returns 404 when no database row exists for the id'), false);
  assert.equal(dbDownCriterion('The service still answers without a database connection'), true);
  assert.equal(dbDownCriterion('Migration fails when the database is down'), false);
});

test('db down: the status comes from the ticket when it names one', () => {
  const b = brief('Health', ['GET /health returns 200 with degraded while the database is unreachable', 'GET /health answers 500 when the database is down']);
  assert.match(b.criteria[0].check!.command!, /--expect-status 200/);
  assert.match(b.criteria[1].check!.command!, /--expect-status 500/);
  assert.ok(b.criteria[0].check!.command!.startsWith('harness verify launch --db-unreachable\n'));
});

test('response header: a criterion naming a header gets --expect-header "<Name>~<value>" on its drive line', () => {
  const b = brief('Export', [
    'GET /orders/export returns Content-Type: text/csv',
    'GET /orders/export sets the Content-Disposition header',
    'GET /orders/export responds 200 with Content-Disposition: attachment and Content-Type: text/csv',
  ]);
  assert.equal(b.criteria[0].kind, 'api');
  assert.equal(b.criteria[0].check!.command, 'harness verify drive --method GET --path /orders/export --expect-status 200 --expect-header "Content-Type~text/csv" --criterion AC1');
  assert.match(b.criteria[1].check!.command!, /--expect-header "Content-Disposition=\*" --criterion AC2$/);
  assert.match(b.criteria[2].check!.command!, /--expect-header "Content-Disposition~attachment" --expect-header "Content-Type~text\/csv" --criterion AC3$/);
  assert.equal(b.criteria[0].check!.command!.includes('--expect-body'), false);
  assert.deepEqual(findHeaders('Content-Type: text/csv; charset=utf-8'), [{ name: 'Content-Type', value: 'text/csv' }]);
  assert.deepEqual(findHeaders('the file is a csv'), []);
  assert.deepEqual(extractFacts('GET /orders/export returns Content-Type: text/csv').paths, [], 'a media type is not a path');
  assert.equal(fs.existsSync(repo), true);
});
