import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkFor, classifyKind, dbDownCriterion, earsRewrite, expectHeaderArg, extractFacts, findHeaders, findCommands, forksFor, mapCriterionRepos, mentionsRepo, repoInfos, testCommand, type RepoInfo } from '../../../src/intake/classify';
import { tempHome, type TempHome } from '../lifecycle/helpers';

const kind = (t: string) => classifyKind(t).kind;

let h: TempHome;
let repos: RepoInfo[];
before(() => {
  h = tempHome('harness-classify-');
  const mk = (name: string, pkg: Record<string, unknown> | null, files: Record<string, string> = {}) => {
    const dir = path.join(h.workspace, name);
    fs.mkdirSync(dir, { recursive: true });
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    for (const [rel, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), c);
    }
    return dir;
  };
  const orders = mk('orders-api', { name: '@shop/orders-api', scripts: { test: 'jest' } }, { 'src/routes/orders.ts': '' });
  const catalog = mk('catalog-api', { name: 'catalog-api', scripts: { test: 'vitest run' } }, { 'pnpm-lock.yaml': '' });
  const web = mk('web', { name: 'web', scripts: { test: 'mocha' } });
  const lib = mk('pricing-lib', { name: 'pricing-lib', scripts: { test: 'node --test dist' } });
  repos = repoInfos({ repos: [orders, catalog, web, lib].map((p) => ({ id: path.basename(p), path: p, name: path.basename(p), isGit: false })) });
});
after(() => h.cleanup());

test('kind: api from method + route, route + response words, and API words with a status', () => {
  assert.equal(kind('GET /orders/:id returns total'), 'api');
  assert.equal(kind('/orders/:id/items responds with the list of items'), 'api');
  assert.equal(kind('the endpoint returns 404 for an unknown id'), 'api');
  const r = classifyKind('GET /orders/:id returns total');
  assert.equal(r.confidence, 0.95);
  assert.deepEqual(r.reasons, ['method+route']);
});

test('kind: db from table.column, "table X", stored in the database, and SQL', () => {
  assert.equal(kind('total stored in orders.total column'), 'db');
  assert.equal(kind('The audit table records the user'), 'db');
  assert.equal(kind('Refunds are persisted in the database'), 'db');
  assert.equal(kind('SELECT count(*) FROM refunds returns one row per refund'), 'db');
  assert.deepEqual(extractFacts('The audit table records the user').tables, ['audit']);
});

test('kind: ui-artifact, nonfunctional with and without a number, unit, untestable', () => {
  assert.equal(kind('The order page shows the total'), 'ui-artifact');
  assert.equal(kind('The user sees a warning banner'), 'ui-artifact');
  assert.equal(kind('p95 latency of GET /orders under 300 ms'), 'nonfunctional');
  assert.equal(kind('Search performance must not degrade'), 'nonfunctional');
  assert.ok(classifyKind('Search performance must not degrade').needsRewrite);
  assert.equal(kind('The function rounds half up to 2 decimals'), 'unit');
  assert.equal(kind('valid code: Given a cart with total 100, when the user applies the code, then the total is 90'), 'unit');
  assert.equal(kind('The export must be user-friendly'), 'untestable');
  assert.equal(kind('Order totals'), 'untestable');
});

test('facts: routes skip file paths, statuses from numbers and words, measures, body facts, paths', () => {
  const f = extractFacts('POST /api/v1/orders returns 201 Created with `id` and total; see src/routes/orders.ts');
  assert.deepEqual(f.routes, [{ method: 'POST', path: '/api/v1/orders' }]);
  assert.deepEqual(f.statuses, [201]);
  assert.ok(f.bodyFacts.includes('id'));
  assert.ok(f.paths.includes('src/routes/orders.ts'));
  assert.deepEqual(extractFacts('an unknown order returns not found').statusWords, [404]);
  const m = extractFacts('p99 under 2 s for 50 concurrent users').measures;
  assert.equal(m[0].value, 2);
  assert.equal(m[0].unit, 's');
  assert.equal(m[0].op, '<');
  assert.equal(m[0].metric, 'p99');
});

test('EARS rewrites: when / while / if / ubiquitous, with the missing fact named', () => {
  const a = earsRewrite('When the user submits the form, the API should respond quickly', 'shop');
  assert.equal(a.ears, 'When the user submits the form, the API shall respond quickly [measurable: a time limit, e.g. p95 under 500 ms].');
  assert.equal(a.missing.length, 1);
  const b = earsRewrite('While the import runs, the UI must stay responsive', 'shop');
  assert.match(b.ears, /^While the import runs, the UI shall stay responsive \[measurable/);
  const c = earsRewrite('If the payment fails, the order should be handled gracefully', 'shop');
  assert.match(c.ears, /^If the payment fails, then the shop shall ensure that the order be handled gracefully \[measurable: the failure behaviour/);
  const d = earsRewrite('The page should load fast', 'shop');
  assert.match(d.ears, /^The page shall load fast \[measurable/);
  const e = earsRewrite('Order totals', 'orders-api', extractFacts('Order totals'), 'untestable');
  assert.equal(e.ears, 'The orders-api shall ensure that order totals [observable result: what a test would check].');
  const f = earsRewrite('Search performance must not degrade', 'search', extractFacts('Search performance must not degrade'), 'nonfunctional');
  assert.match(f.ears, /\[measurable: a number with a unit/);
  assert.equal(f.missing.length, 1);
});

test('untestable criteria get a blocking question and no check; the EARS text is in the question', () => {
  const t = 'The export must be user-friendly';
  const facts = extractFacts(t);
  const r = checkFor('AC3', t, 'untestable', facts, undefined, earsRewrite(t, 'shop', facts, 'untestable'));
  assert.equal(r.check, undefined);
  assert.equal(r.unclear.length, 1);
  assert.equal(r.unclear[0].topic, 'meaning');
  assert.equal(r.unclear[0].blocking, true);
  assert.match(r.unclear[0].question!, /The export shall be user-friendly \[measurable/);
  assert.ok(r.unclear[0].options!.length >= 2);
});

test('repo mapping: names and package names, paths that exist, resource tokens, generic names only in code form', () => {
  const orders = repos.find((r) => r.name === 'orders-api')!;
  const web = repos.find((r) => r.name === 'web')!;
  assert.equal(mentionsRepo('change the orders api to return totals', orders), 'name');
  assert.equal(mentionsRepo('@shop/orders-api returns totals', orders), 'name');
  assert.equal(mentionsRepo('see src/routes/orders.ts', orders), 'path');
  assert.equal(mentionsRepo('the web page shows totals', web), null);
  assert.equal(mentionsRepo('in the web repo, the page shows totals', web), 'name');
  const f = extractFacts('GET /orders/:id returns total');
  const m = mapCriterionRepos('GET /orders/:id returns total', f, repos, []);
  assert.deepEqual(m, { repos: [orders.id], how: 'resource' });
  const none = mapCriterionRepos('the job is idempotent', extractFacts('the job is idempotent'), repos, []);
  assert.equal(none.how, 'none');
  const dflt = mapCriterionRepos('the job is idempotent', extractFacts('the job is idempotent'), repos, [], repos[1].id);
  assert.deepEqual(dflt, { repos: [repos[1].id], how: 'default' });
  const ticket = mapCriterionRepos('the job is idempotent', extractFacts('x'), repos, [repos[3].id]);
  assert.deepEqual(ticket, { repos: [repos[3].id], how: 'ticket' });
});

test('unit check commands follow the repo test runner and package manager', () => {
  const byName = (n: string) => repos.find((r) => r.name === n)!;
  assert.equal(testCommand(byName('orders-api'), 'AC1:'), 'npm test -- -t "AC1:"');
  assert.equal(testCommand(byName('catalog-api'), 'AC1:'), 'pnpm test -t "AC1:"');
  assert.equal(testCommand(byName('web'), 'AC1:'), 'npm test -- --grep "AC1:"');
  assert.equal(testCommand(byName('pricing-lib'), 'AC1:'), 'npm test -- --test-name-pattern "AC1:"');
  assert.equal(testCommand(undefined, 'AC1:'), undefined);
  const r = checkFor('AC1', 'The function rounds half up', 'unit', extractFacts('The function rounds half up'), byName('orders-api'));
  assert.equal(r.check!.kind, 'unit');
  assert.equal(r.check!.redFirst, true);
  assert.equal(r.check!.command, 'npm test -- -t "AC1:"');
  assert.match(r.check!.description, /Unit test named "AC1: The function rounds half up" in orders-api/);
});

test('api checks: verify drive with method, status and body; defaults are logged as assumptions; missing route is observable', () => {
  const t = 'GET /orders/:id returns total';
  const r = checkFor('AC1', t, 'api', extractFacts(t), undefined);
  assert.equal(r.check!.kind, 'e2e-http');
  assert.equal(r.check!.command, 'harness verify drive --method GET --path /orders/:id --expect-status 200 --expect-body total --criterion AC1', 'the artefact is linked to its criterion by name');
  assert.equal(r.check!.redFirst, true);
  assert.deepEqual(
    r.unclear.map((u) => [u.topic, u.assume]),
    [['status', 'AC1: expected status 200 for GET']],
  );
  const post = checkFor('AC2', 'POST /orders creates an order', 'api', extractFacts('POST /orders creates an order'), undefined);
  assert.match(post.check!.command!, /--expect-status 201/);
  const del = checkFor('AC3', 'DELETE /orders/:id removes it', 'api', extractFacts('DELETE /orders/:id removes it'), undefined);
  assert.match(del.check!.command!, /--expect-status 204/);
  const nf = checkFor('AC4', 'an unknown order id returns not found from the API', 'api', extractFacts('an unknown order id returns not found from the API'), undefined);
  assert.match(nf.check!.command!, /--path "<route>" --expect-status 404/);
  assert.ok(nf.unclear.some((u) => u.topic === 'route' && !!u.command));
  assert.ok(nf.unclear.some((u) => u.topic === 'method' && !!u.assume));
});

test('api checks: a status-only expectation is liveOptional; body, header, database, timing and db-down expectations stay live-only', () => {
  const only = checkFor('AC1', 'GET /health returns 200', 'api', extractFacts('GET /health returns 200'), undefined);
  assert.equal(only.check!.kind, 'e2e-http');
  assert.equal(only.check!.liveOptional, true);
  assert.equal(only.check!.liveOptionalRoute, 'GET /health');
  assert.equal(only.check!.redFirst, true);
  assert.match(only.check!.description, /live drive, or a unit test named "AC1:" that names the route "GET \/health"/);
  assert.equal(only.check!.command, 'harness verify drive --method GET --path /health --expect-status 200 --criterion AC1', 'the run line is unchanged');
  for (const t of [
    'GET /orders/:id returns total',
    'GET /report responds with header Content-Type text/csv',
    'POST /orders stores the row in the orders table',
    'GET /orders answers 200 with p95 under 300 ms',
    'GET /orders returns 503 while the database is unreachable',
  ]) {
    const r = checkFor('AC1', t, 'api', extractFacts(t), undefined);
    assert.equal(r.check!.kind, 'e2e-http', t);
    assert.equal(r.check!.liveOptional, undefined, t);
  }
  const noRoute = checkFor('AC4', 'an unknown order id returns not found from the API', 'api', extractFacts('an unknown order id returns not found from the API'), undefined);
  assert.equal(noRoute.check!.liveOptional, undefined, 'no route named: nothing for a unit test to name');
});

test('db, ui, nonfunctional checks', () => {
  const db = checkFor('AC2', 'total stored in orders.total column', 'db', extractFacts('total stored in orders.total column'), undefined);
  assert.equal(db.check!.kind, 'e2e-db');
  assert.equal(db.check!.command, 'harness verify db --table orders --expect-columns total --criterion AC2');
  const rows = checkFor('AC5', 'the refunds table has 2 rows after two refunds', 'db', extractFacts('the refunds table has 2 rows after two refunds'), undefined);
  assert.match(rows.check!.command!, /--table refunds --expect-rows 2/);
  const ui = checkFor('AC3', 'The order page shows the total', 'ui-artifact', extractFacts('The order page shows the total'), undefined);
  assert.equal(ui.check!.kind, 'manual');
  assert.match(ui.check!.description, /ac3-the-order-page-shows-the-total\.png/);
  const perf = checkFor('AC4', 'p95 latency of GET /orders under 300 ms', 'nonfunctional', extractFacts('p95 latency of GET /orders under 300 ms'), undefined);
  assert.equal(perf.check!.kind, 'e2e-http');
  assert.match(perf.check!.command!, /--repeat 20 --expect-p95-ms 300/);
  const measure = checkFor('AC6', 'memory stays under 512 mb during import', 'nonfunctional', extractFacts('memory stays under 512 mb during import'), undefined);
  assert.equal(measure.check!.kind, 'manual');
  assert.match(measure.check!.description, /Measure before and after: memory < 512 mb/);
  const noNum = checkFor('AC7', 'Search performance must not degrade', 'nonfunctional', extractFacts('Search performance must not degrade'), undefined);
  assert.equal(noNum.check, undefined);
  assert.equal(noNum.unclear[0].topic, 'measure');
  assert.equal(noNum.unclear[0].blocking, true);
});

test('forks: scope, security, privacy, UX wording, and current behaviour', () => {
  const topics = (t: string, k: Parameters<typeof forksFor>[2] = 'unit') => forksFor('AC1', t, k, extractFacts(t)).map((u) => u.topic);
  assert.deepEqual(topics('Apply the discount to carts, wishlists etc.'), ['scope']);
  assert.deepEqual(topics('Only admins can export orders'), ['security']);
  assert.deepEqual(topics('Only admins can export orders; others get 403'), []);
  assert.deepEqual(topics('The customer email address is logged on failure'), ['privacy']);
  assert.deepEqual(topics('The customer email address is logged masked on failure'), []);
  assert.deepEqual(topics('The page shows an error message', 'ui-artifact'), ['ux']);
  assert.deepEqual(topics('The page shows the message "Saved"', 'ui-artifact'), []);
  const beh = forksFor('AC1', 'Existing totals stay unchanged', 'unit', extractFacts('Existing totals stay unchanged'));
  assert.equal(beh[0].topic, 'behaviour');
  assert.ok(beh[0].command);
});

test('kind: a quoted command line is a unit check even when the text names the API or JSON (found by the Stage 3 dry run on a command-line ticket)', () => {
  assert.equal(kind('`pantry list --json` prints `{"items":[...]}` with the API\'s item fields (`expires_on` as `YYYY-MM-DD` or null).'), 'unit');
  assert.equal(kind('`pantry expiring --days 7 --json` prints `{"days":7,"items":[...]}`.'), 'unit');
  assert.equal(kind('`pantry list --location Fridge` lists items 1, 2 and 3.'), 'unit');
  assert.equal(kind('`pantry report` prints the four headings `Locations`, `Expiring soon`, `Low stock`, `Totals`.'), 'unit');
  assert.equal(kind('`pantry help` lists `report [--days <n>]`.'), 'unit');
  // a real route still wins, and plain quoted words are not commands
  assert.equal(kind('GET /orders/:id returns total'), 'api');
  assert.deepEqual(findCommands(['expires_on', 'not found', '{"items":[]}', 'GET /x', '?days=7', '--json']), []);
  assert.deepEqual(findCommands(['pantry list --json', 'npm run format', 'node dist/cli.js add Milk --location 2', 'pantry list --json']), ['pantry list --json', 'npm run format', 'node dist/cli.js add Milk --location 2']);
  const t = '`pantry locations --json` prints `{"locations":[...]}`.';
  const r = checkFor('AC3', t, 'unit', extractFacts(t), undefined);
  assert.equal(r.check?.kind, 'unit');
  assert.match(r.check?.description ?? '', /runs `pantry locations --json`/);
});

test('kind: a flag such as `--json` is not an API word; a criterion about a command-line flag is a unit check', () => {
  assert.equal(kind('Without `--json` the output is unchanged; `--json` takes no value.'), 'unit');
  assert.equal(kind('The endpoint returns JSON with the order'), 'api');
  assert.notEqual(kind('the file `report.json` lists the totals'), 'api');
});

test('F1: green-at-base, code-structure and document shortcuts do not override routes, statuses or table facts', () => {
  assert.equal(kind('The existing tests still pass and GET /health returns 200'), 'api');
  assert.equal(kind('GET /orders returns the same results as before with no behaviour change'), 'api');
  assert.equal(kind('POST /orders returns 201 and the order is not duplicated in the orders table'), 'api');
  assert.equal(kind('The orders table is not duplicated when the same request is sent twice'), 'db');
  assert.equal(kind('The helper column is added to the orders table'), 'db');
  assert.equal(kind('A new helper table stores the audit rows'), 'db');
  assert.equal(kind('The users table behaviour is unchanged: results are the same as before'), 'db');
  // earlier positive cases keep their kind
  assert.equal(kind('A pure helper function with unit tests'), 'unit');
  assert.equal(kind('The existing tests still pass'), 'unit');
  assert.equal(kind('The README documents the --json flag'), 'unit');
  assert.equal(kind('Add a shared helper function for rounding'), 'unit');
});

test('F2: the db-down shape needs unreachable wording, skips "available", and reads the 5xx from the clause after it', () => {
  const fails = 'When the database write fails, the endpoint returns 500 and rolls back the transaction';
  assert.equal(kind(fails), 'api');
  assert.equal(dbDownCriterion(fails), false);
  assert.doesNotMatch(checkFor('AC1', fails, 'api', extractFacts(fails), undefined).check?.command ?? '', /db-unreachable/);
  const retries = 'The service retries the query up to 3 times when the database is unavailable';
  assert.equal(kind(retries), 'unit');
  assert.equal(dbDownCriterion(retries), false);
  const both = 'The API returns 200 when the database is available and 503 when it is down';
  assert.equal(kind(both), 'api');
  const c = checkFor('AC1', both, 'api', extractFacts(both), undefined).check;
  assert.match(c?.command ?? '', /db-unreachable/);
  assert.match(c?.command ?? '', /--expect-status 503/, 'the down clause decides the status, not the 200 for the up case');
  assert.doesNotMatch(c?.command ?? '', /--expect-status 200/);
  // positive cases
  assert.equal(dbDownCriterion('GET /health still answers 503 when the database is down'), true);
  assert.equal(dbDownCriterion('The service responds while the database is unreachable'), true);
  const down = 'The endpoint returns 200 normally; when the database is unreachable it returns 502';
  const d = checkFor('AC1', down, 'api', extractFacts(down), undefined).check;
  assert.match(d?.command ?? '', /db-unreachable/);
  assert.match(d?.command ?? '', /--expect-status 502/);
  const dflt = 'The service responds when the database is down';
  assert.match(checkFor('AC2', dflt, 'api', extractFacts(dflt), undefined).check?.command ?? '', /--expect-status 503/);
});

test('F9: header names need "header" in the sentence, are not found inside paths, and X- is case-sensitive', () => {
  const args = (t: string) => findHeaders(t).map(expectHeaderArg);
  assert.deepEqual(findHeaders('GET /x-ray/scan returns 200'), []);
  assert.deepEqual(findHeaders('GET /reports/x-axis-labels returns 200'), []);
  assert.deepEqual(args('The response header Content-Type is text/csv'), ['--expect-header "Content-Type~text/csv"']);
  assert.deepEqual(args('The response carries an X-Request-Id header'), ['--expect-header "X-Request-Id=*"']);
  assert.deepEqual(findHeaders('The X-Request-Id is logged'), [], 'an X- name needs the word "header"');
  assert.deepEqual(findHeaders('The header x-trace is set'), [], 'an X- name is case-sensitive');
  assert.deepEqual(findHeaders('GET /orders/export returns Content-Type: text/csv'), [{ name: 'Content-Type', value: 'text/csv' }]);
});

