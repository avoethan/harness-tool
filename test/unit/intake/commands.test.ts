import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as intakeMain } from '../../../src/commands/intake';
import { buildBrief, getCurrentTask, loadBrief, saveBrief, answerQuestion } from '../../../src/intake/brief';
import { defaultConfig, repoIdFor, saveConfig } from '../../../src/lib/config';
import { extractFacts } from '../../../src/intake/classify';
import { capture } from '../commands/capture';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
let cfgRepos: Array<{ id: string; path: string; name: string; isGit: boolean }>;
const file = (name: string, text: string) => {
  const p = path.join(h.root, name);
  fs.writeFileSync(p, text);
  return p;
};

before(() => {
  h = tempHome('harness-intake-');
  repo = gitRepo(path.join(h.workspace, 'orders-api'), { 'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run' } }) });
  cfgRepos = [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }];
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: cfgRepos }));
});
after(() => h.cleanup());

test('intake --from <file>: two criteria classified api and db with checks; brief saved; current task set for the mapped repo', async () => {
  const p = file('t1.txt', 'Title: Add order total\nAcceptance Criteria:\n1. GET /orders/:id returns total\n2. total stored in orders.total column\n');
  const r = await capture(() => intakeMain(['--from', p, '--repo', repo]));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AC1 {2}\[api 0\.95\] GET \/orders\/:id returns total/);
  assert.match(r.stdout, /run: {3}harness verify drive --method GET --path \/orders\/:id --expect-status 200 --expect-body total/);
  assert.match(r.stdout, /AC2 {2}\[db 0\.90\] total stored in orders\.total column/);
  assert.match(r.stdout, /run: {3}harness verify db --table orders --expect-columns total/);
  assert.match(r.stdout, /U1 {2}orders-api: orders \(AC2, AC1\)/);
  const id = /Brief (t-[0-9a-f]{10})/.exec(r.stdout)![1];
  assert.equal(getCurrentTask(repoIdFor(repo)), id);
  const b = loadBrief(id)!;
  assert.deepEqual(b.repos, [repoIdFor(repo)]);
  assert.ok(b.criteria.every((c) => c.check?.redFirst === true));
  const show = await capture(() => intakeMain(['show', '--repo', repo]));
  assert.equal(show.code, 0);
  assert.match(show.stdout, new RegExp(`Brief ${id}`));
  const lint = await capture(() => intakeMain(['lint', id]));
  assert.equal(lint.code, 0);
  const list = await capture(() => intakeMain(['list', '--json']));
  assert.ok(JSON.parse(list.stdout).some((x: { id: string }) => x.id === id));
});

test('an untestable criterion stops with a blocking question; answering re-classifies it into a checked criterion', async () => {
  const p = file('t2.txt', 'Title: Faster search\nAC:\n1. GET /search returns results\n2. Search must be fast\n');
  const r = await capture(() => intakeMain(['--from', p, '--repo', repo]));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AC2 {2}\[untestable 0\.70\] Search must be fast/);
  assert.match(r.stdout, /EARS: The orders-api shall ensure that search be fast \[measurable: a time limit/);
  assert.match(r.stdout, /Q1 \[meaning, AC2, blocks AC2\]/);
  const id = /Brief (t-[0-9a-f]{10})/.exec(r.stdout)![1];
  let b = loadBrief(id)!;
  assert.deepEqual(b.markers, ['AC2']);
  assert.equal(b.criteria[1].check, undefined);
  assert.ok(b.criteria[1].question);
  const bad = await capture(() => intakeMain(['answer', id, '--q', '9', '--answer', 'A']));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Q9 is not an open question; open: Q1/);
  const a = await capture(() => intakeMain(['answer', id, '--q', '1', '--answer', 'A']));
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /Recorded Q1: p95 under 500 ms/);
  b = loadBrief(id)!;
  assert.equal(b.criteria[1].kind, 'nonfunctional');
  assert.match(b.criteria[1].check!.description, /p95 < 500 ms/);
  assert.equal(b.questionDetails.length, 0);
  assert.deepEqual(b.markers, []);
  assert.equal(b.clarifications[0].a, 'p95 under 500 ms');
  assert.deepEqual(b.lint, []);
  // re-intake of the same text keeps the answer
  const again = await capture(() => intakeMain(['--from', p, '--repo', repo]));
  assert.equal(again.code, 0);
  assert.equal(loadBrief(id)!.clarifications.length, 1);
});

test('caps hold over a vague ticket: 3 blocking questions under the marker cap, the rest queued; an answer can drop a criterion', () => {
  const vague = ['must be fast', 'must be user-friendly', 'must be robust', 'must be intuitive', 'must be secure', 'must be scalable'].map((t, i) => `${i + 1}. The screen ${t}`);
  const b = buildBrief(`Title: Polish\nAcceptance Criteria:\n${vague.join('\n')}\n`, { config: { repos: cfgRepos }, defaultRepoPath: repo });
  assert.equal(b.questionDetails.length, 3, 'only three blocking questions fit under the marker cap');
  assert.equal(b.markers.length, 3);
  assert.equal(b.queued.length, 3);
  assert.deepEqual(b.lint, [], 'queued questions count as open questions');
  saveBrief(b);
  const q = b.questionDetails[0];
  assert.equal(q.options[q.options.length - 1], 'Drop it from this ticket');
  const res = answerQuestion(b, q.n, String.fromCharCode(64 + q.options.length), { config: { repos: cfgRepos }, defaultRepoPath: repo });
  assert.equal(res.dropped, true);
  assert.equal(res.brief.criteria.length, 5);
  assert.equal(res.brief.dropped[0].id, q.criterionId);
  assert.equal(res.brief.markers.length, 3, 'a queued question moved into the batch');
  assert.equal(res.brief.queued.length, 2);
});

test('forks take the recommended option until answered and stay non-blocking; prose-only tickets ask to confirm the criteria', () => {
  const b = buildBrief('Title: Admin export\nAC:\n- Only admins can export orders via GET /orders/export\n', { config: { repos: cfgRepos }, defaultRepoPath: repo });
  assert.equal(b.questionDetails[0].topic, 'security');
  assert.equal(b.questionDetails[0].blocking, false);
  assert.ok(b.criteria[0].check);
  assert.ok(b.assumptions.some((a) => a.includes('until answered, assumed "403 Forbidden"')));
  const res = answerQuestion(b, 1, 'B', { config: { repos: cfgRepos }, defaultRepoPath: repo });
  assert.match(res.brief.criteria[0].check!.description, /clarified: 404 Not Found/);
  const prose = buildBrief('Refunds\n\nThe refund email must include the amount. It should be sent within a minute.', { config: { repos: cfgRepos }, defaultRepoPath: repo });
  assert.equal(prose.inferred, true);
  assert.ok(prose.questionDetails.some((q) => q.topic === 'criteria' && /no acceptance-criteria list/.test(q.text)));
  assert.ok(prose.assumptions.some((a) => /read from the ticket's prose/.test(a)));
  const empty = buildBrief('Just a title', { config: { repos: cfgRepos }, defaultRepoPath: repo });
  assert.equal(empty.criteria.length, 0);
  assert.equal(empty.questionDetails[0].blocking, true);
  assert.deepEqual(empty.lint, []);
});

test('plan lint: a brief edited so a criterion has neither check nor question fails `intake lint` and `intake show` with exit 1', async () => {
  const b = buildBrief('Title: Lint me\nAC:\n1. GET /a returns 200\n2. GET /b returns 200\n', { config: { repos: cfgRepos }, defaultRepoPath: repo });
  saveBrief({ ...b, criteria: b.criteria.map((c, i) => (i === 1 ? { ...c, check: undefined } : c)), lint: ['AC2: no check and no open question ("GET /b returns 200")'] });
  const r = await capture(() => intakeMain(['lint', b.id]));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Plan lint FAILED for t-[0-9a-f]+:\n {2}- AC2: no check and no open question/);
  const s = await capture(() => intakeMain(['show', b.id]));
  assert.equal(s.code, 1);
});

test('usage errors and logging: no ticket text or key in events.jsonl, only the brief id, the sha256 and counts', async () => {
  assert.equal((await capture(() => intakeMain([]))).code, 2);
  assert.equal((await capture(() => intakeMain(['--from', path.join(h.root, 'missing.txt')]))).code, 2);
  assert.equal((await capture(() => intakeMain(['--from', file('empty.txt', '  \n')]))).code, 2);
  assert.equal((await capture(() => intakeMain(['answer', 'nope', '--q', '1', '--answer', 'A']))).code, 1);
  delete process.env.HARNESS_NO_INSTRUMENT;
  try {
    const p = file('t3.txt', 'Title: SHOP-4711 Secret project falcon\nAC:\n1. GET /falcon returns 200\n');
    const r = await capture(() => intakeMain(['--from', p, '--repo', repo]));
    assert.equal(r.code, 0, r.stderr);
  } finally {
    process.env.HARNESS_NO_INSTRUMENT = '1';
  }
  const log = fs.readFileSync(path.join(h.harnessHome, 'logs', 'events.jsonl'), 'utf8');
  assert.match(log, /"event":"intake.brief"/);
  assert.match(log, /"ticketSha256":"[0-9a-f]{64}"/);
  assert.doesNotMatch(log, /SHOP-4711|falcon/i);
});

// Tickets whose endpoint is named only in the description (integration findings on the team stand-in).
const LOW_STOCK = `SHOP-102: Low-stock endpoint

Type: Story | Priority: Medium | Component: catalog-api | Size: S

Description
The warehouse wants a list of products that are about to run out. Add \`GET /products/low-stock?threshold=<n>\` returning active products with \`stock < n\`, ordered by stock ascending then id. Default threshold 5.

Acceptance criteria
1. Default call returns products 3 (stock 4) only (product 5 is inactive).
2. \`?threshold=20\` returns products 3 and 2, in that order.
3. \`threshold=0\` or a non-integer answers 400.
4. The route must be registered before \`/:id\` so that \`low-stock\` is not read as an id.
`;

const READINESS = `SHOP-104: Readiness probe that checks the pool

Type: Task | Priority: High | Component: orders-api | Size: S

Description
The platform team wants \`GET /health/ready\` that answers 200 \`{ "ready": true, "pool": { "size": n, "available": m } }\` when the pool can run \`SELECT 1\`, and 503 \`{ "ready": false }\` otherwise. \`GET /health\` stays as it is.

Acceptance criteria
1. With the database up: 200 and integer \`size\`/\`available\`.
2. When the query throws: 503 \`{ "ready": false }\` (no stack trace, no 500).
3. The probe must not open a new connection; it uses the existing pool.
`;

const DOCUMENT_ENV = `SHOP-110: Document environment variables

Type: Task | Priority: Low | Component: catalog-api | Size: S

Description
New starters keep asking what each variable does. Add an "Environment" section to \`README.md\` with a table of every variable in \`.env.example\` (name, default, meaning), and make \`src/config.ts\` reject an unknown \`LOG_LEVEL\` with a message that lists the allowed values (it already does; make sure the README matches).

Acceptance criteria
1. The README table lists DB_SERVER, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, PORT, LOG_LEVEL with defaults matching \`src/config.ts\`.
2. No code behaviour changes; all tests pass.
`;

test('endpoint named only in the description: criteria about its responses are api checks against it (query values and statuses from the criterion)', () => {
  const b = buildBrief(LOW_STOCK, { config: { repos: cfgRepos }, defaultRepoPath: repo });
  const by = Object.fromEntries(b.criteria.map((c) => [c.id, c]));
  for (const id of ['AC1', 'AC2', 'AC3', 'AC4']) assert.equal(by[id].kind, 'api', `${id}: ${by[id].kind}`);
  assert.equal(by.AC1.check?.command, 'harness verify drive --method GET --path /products/low-stock --expect-status 200 --criterion AC1');
  assert.equal(by.AC2.check?.command, 'harness verify drive --method GET --path "/products/low-stock?threshold=20" --expect-status 200 --criterion AC2', 'a quoted query is the request, not an expected body');
  assert.equal(by.AC3.check?.command, 'harness verify drive --method GET --path "/products/low-stock?threshold=0" --expect-status 400 --criterion AC3');
  assert.equal(by.AC4.check?.command, 'harness verify drive --method GET --path /products/low-stock --expect-status 200 --criterion AC4', 'a route pattern (/:id) is not the endpoint; the endpoint is reached by its own path');
  assert.ok(b.criteria.every((c) => c.check), 'every criterion has a check; none waits for an answer');

  const r = buildBrief(READINESS, { config: { repos: cfgRepos }, defaultRepoPath: repo });
  const rb = Object.fromEntries(r.criteria.map((c) => [c.id, c]));
  assert.equal(rb.AC1.kind, 'api', 'was untestable: the endpoint is only in the description');
  assert.equal(rb.AC1.check?.command, 'harness verify drive --method GET --path /health/ready --expect-status 200 --expect-body size --expect-body available --criterion AC1');
  assert.equal(rb.AC2.kind, 'api');
  assert.match(rb.AC2.check?.command ?? '', /--path \/health\/ready --expect-status 503/, 'the first status, never the negated "no 500"');
  assert.equal(rb.AC3.kind, 'unit', 'a criterion about the implementation stays a unit check');
});

test('a README criterion is a document check (unit), not a database table, and UPPER_SNAKE names are not columns', () => {
  const b = buildBrief(DOCUMENT_ENV, { config: { repos: cfgRepos }, defaultRepoPath: repo });
  const by = Object.fromEntries(b.criteria.map((c) => [c.id, c]));
  assert.equal(by.AC1.kind, 'unit', `AC1: ${by.AC1.kind} (was db: "README table" read as a table)`);
  assert.equal(by.AC1.check?.kind, 'unit');
  assert.equal(by.AC2.kind, 'unit', '"all tests pass" is the suite');
  assert.ok(!b.criteria.some((c) => c.check?.kind === 'e2e-db'));
});

test('ticket endpoints: several in order, a criterion naming a method uses that one; method routes may end like a file; negated bodies carry no body check', () => {
  const t = `Shipment notes\n\nDescription\nExpose it in \`GET /shipments/:id\`, and add \`PATCH /shipments/:id/notes\` with body \`{ "notes": "..." }\`. Support wants \`GET /orders/:id/export.csv\` too.\n\nAcceptance criteria\n1. \`PATCH\` stores the text; \`GET\` returns it; \`notes\` longer than 500 characters answers 400.\n2. Inactive products never appear (product 5, "Retired blender", is excluded).\n`;
  const b = buildBrief(t, { config: { repos: cfgRepos }, defaultRepoPath: repo });
  const by = Object.fromEntries(b.criteria.map((c) => [c.id, c]));
  assert.equal(by.AC1.check?.command, 'harness verify drive --method PATCH --path /shipments/:id/notes --expect-status 400 --criterion AC1');
  assert.doesNotMatch(by.AC2.check?.command ?? '', /Retired blender/, 'a body that must be absent is not expected');
  assert.deepEqual(extractFacts('Add `GET /orders/:id/export.csv` returning CSV').routes, [{ method: 'GET', path: '/orders/:id/export.csv' }]);
  assert.deepEqual(extractFacts('Upload the file /tmp/x/report.csv').routes, [], 'a bare path ending like a file is still a file');
});

test('a ticket with no criteria: the answer to "What must be true when this is done?" becomes the criteria', () => {
  const ctx = { config: { repos: cfgRepos }, defaultRepoPath: repo };
  const empty = buildBrief('Add a second line to the README', ctx);
  assert.equal(empty.criteria.length, 0);
  const q = empty.questionDetails.find((x) => x.topic === 'criteria')!;
  const one = answerQuestion(empty, q.n, 'A) README.md contains the line "second line".', ctx);
  assert.deepEqual(one.brief.criteria.map((c) => c.text), ['README.md contains the line "second line".']);
  assert.ok(!one.brief.questionDetails.some((x) => x.topic === 'criteria' && x.blocking), 'the criteria question is no longer open');
  const two = answerQuestion(empty, q.n, 'The README has two lines; the first line is unchanged', ctx);
  assert.deepEqual(two.brief.criteria.map((c) => c.text), ['The README has two lines', 'the first line is unchanged']);
  const lines = answerQuestion(empty, q.n, '1. first criterion\n2. second criterion', ctx);
  assert.deepEqual(lines.brief.criteria.map((c) => c.id), ['AC1', 'AC2']);
  const title = answerQuestion(empty, q.n, 'B', ctx);
  assert.deepEqual(title.brief.criteria.map((c) => c.text), ['Add a second line to the README']);
  assert.throws(() => answerQuestion(empty, q.n, 'A', ctx), /give the criteria themselves/);
});
