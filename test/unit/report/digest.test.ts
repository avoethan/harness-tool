import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, type TempHome } from '../lifecycle/helpers';
import { capture } from '../commands/capture';
import { collectState } from '../../../src/report/collect';
import { buildReport, indexTasks } from '../../../src/report/build';
import { buildDigest, renderDigest, DIGEST_SECTIONS, ticketRow } from '../../../src/report/digest';
import { makeReport } from '../../../src/report/index';
import { scrubReport } from '../../../src/report/scrub';
import { main as digestMain } from '../../../src/commands/digest';
import { main as reportMain } from '../../../src/commands/report';
import { buildFixture, ALPHA, H1, T1, T2 } from './fixture';
import type { Report } from '../../../src/types';

let h: TempHome;

function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function putJson(file: string, v: unknown): void {
  put(file, JSON.stringify(v, null, 2) + '\n');
}
function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const SECRET = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const HIDDEN_WORD = 'zorblattwords';

before(() => {
  h = tempHome('harness-digest-');
  delete process.env.XDG_CONFIG_HOME;
  buildFixture(h.harnessHome, h.workspace);
  const hh = h.harnessHome;

  // T1: criteria with checks and prove-red results; text that must never reach the digest.
  const bp = path.join(hh, 'briefs', `${T1}.json`);
  const brief = readJson(bp);
  const chk = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, description: `${HIDDEN_WORD} check`, ...extra });
  brief.criteria = [
    { id: 'AC1', text: `${HIDDEN_WORD} one`, kind: 'unit', check: chk('unit', { redFirst: true, redProof: { baseSha: 'b', at: 'x', result: 'red', files: [], exitCode: 1 } }) },
    { id: 'AC2', text: `${HIDDEN_WORD} two`, kind: 'api', check: chk('e2e-http', { redFirst: true, redProof: { baseSha: 'b', at: 'x', result: 'green', files: [], exitCode: 0 } }) },
    { id: 'AC3', text: `${HIDDEN_WORD} three`, kind: 'db', check: chk('e2e-db', { redFirst: true }) },
    { id: 'AC4', text: `${HIDDEN_WORD} four`, kind: 'unit', check: chk('unit', { greenAtBase: true, redProof: { baseSha: 'b', at: 'x', result: 'green', files: [], exitCode: 0 } }) },
    { id: 'AC5', text: `${HIDDEN_WORD} five`, kind: 'untestable', check: chk('manual') },
  ];
  putJson(bp, brief);

  // T1 run folder: live artefacts (one fresh, one stale, one failed), phase with expectation changes, runner, landing, PR.
  const r1 = path.join(hh, 'runs', ALPHA, T1);
  putJson(path.join(r1, 'e2e', 'AC2-http.json'), { version: 1, treeHash: 'a'.repeat(40), pass: true });
  putJson(path.join(r1, 'e2e', 'AC3-db.json'), { version: 1, treeHash: 'c'.repeat(40), pass: true });
  putJson(path.join(r1, 'e2e', 'AC4-http.json'), { version: 1, treeHash: 'a'.repeat(40), pass: false });
  putJson(path.join(r1, 'phase.json'), {
    version: 1,
    phase: 'tests',
    testsEntries: 2,
    expectChanges: [
      { file: 'src/orders/total.test.ts', reason: `${HIDDEN_WORD} reason`, at: '2026-10-01T10:04:00.000Z' },
      { file: 'src/orders/tax.test.ts', reason: 'r', at: '2026-10-01T10:05:00.000Z' },
    ],
  });
  putJson(path.join(r1, 'run.json'), { version: 1, task: T1, worktree: '/w', branch: `task/${T1}`, agent: 'claude', status: 'landed', updatedAt: '2026-10-01T10:09:00.000Z' });
  putJson(path.join(r1, 'landing.json'), {
    version: 1,
    repo: ALPHA,
    task: T1,
    outcome: 'landed',
    landed: true,
    post_landing_red: true,
    auto_fixed: true,
    reverted: false,
    revert_correct: null,
    transitions: [{ state: 'start' }, { state: 'landed' }, { state: 'done' }],
  });
  putJson(path.join(r1, 'ci-1-initial.json'), {});
  putJson(path.join(r1, 'ci-2-rerun.json'), {});
  putJson(path.join(r1, 'pr.json'), { url: 'https://github.com/example-org/example-repo/pull/17', number: 17, at: '2026-10-01T10:10:00.000Z', head: `task/${T1}`, base: 'main' });

  // T2: BLOCKED evidence whose reason carries a planted token, and a title with one.
  const b2 = path.join(hh, 'briefs', `${T2}.json`);
  const brief2 = readJson(b2);
  brief2.title = `Second task ${SECRET}`;
  putJson(b2, brief2);
  const e2 = path.join(hh, 'runs', ALPHA, T2, 'evidence.json');
  const ev2 = readJson(e2);
  ev2.verdict = 'BLOCKED';
  ev2.reasons = [`needs the database; saw token=${SECRET} in the environment`];
  ev2.localChanges = { leftOut: 4, changedSince: 1 };
  putJson(e2, ev2);

  // Events: denials by rail (T1's session s1, T2's session s2), runner sessions and cost.
  const ev = (ts: string, event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts, event, ...extra });
  const more = [
    ev('2026-10-01T10:04:30.000Z', 'guard.deny', { sessionId: 's1', ids: { rail: 'protect', tool: 'Edit' } }),
    ev('2026-10-01T10:04:40.000Z', 'guard.deny', { sessionId: 's1', ids: { rail: 'protect', tool: 'Write' } }),
    ev('2026-10-01T10:04:50.000Z', 'guard.deny', { sessionId: 's1', ids: { rail: 'db', tool: 'Bash' } }),
    ev('2026-10-01T10:04:55.000Z', 'guard.allow', { sessionId: 's1', ids: { rail: 'none', tool: 'Read' } }),
    ev('2026-10-05T09:02:30.000Z', 'guard.deny', { sessionId: 's2', ids: { rail: 'secrets', tool: 'Read' } }),
    ev('2026-10-05T09:02:40.000Z', 'guard.deny', { sessionId: 's2', ids: { rail: 'a-rail-of-the-workspace', tool: 'Read' } }),
    ev('2026-10-01T10:08:00.000Z', 'run.session', { task: T1, repo: ALPHA, ids: { cap: 'none', ok: '1' }, counts: { turns: 12, ms: 1000 } }),
    ev('2026-10-01T10:08:30.000Z', 'run.session', { task: T1, repo: ALPHA, ids: { cap: 'none', ok: '1' }, counts: { turns: 8, ms: 1000 } }),
    ev('2026-10-01T10:09:00.000Z', 'run.task', { task: T1, repo: ALPHA, ids: { outcome: 'landed' }, counts: { sessions: 2, ms: 1000, costMilliUsd: 1500 } }),
  ];
  fs.appendFileSync(path.join(hh, 'logs', 'events.jsonl'), more.join('\n') + '\n');
});
after(() => h.cleanup());

function digests() {
  const st = collectState();
  const idx = indexTasks(st);
  const get = (id: string) => buildDigest(idx.tasks.find((t) => t.id === id)!, idx.events);
  return { d1: get(T1), d2: get(T2) };
}

test('the digest of the fixture task carries the known counts', () => {
  const { d1 } = digests();
  assert.equal(d1.title, 'Export the quokkaledger totals');
  assert.equal(d1.ticket, H1.slice(0, 12));
  assert.deepEqual(d1.criteria.byKind, { api: 1, db: 1, unit: 2, untestable: 1 });
  assert.deepEqual(d1.criteria.checksByKind, { 'e2e-db': 1, 'e2e-http': 1, manual: 1, unit: 2 });
  assert.equal(d1.criteria.redFirst, 3);
  assert.equal(d1.criteria.greenAtBase, 1);
  assert.deepEqual(d1.proveRed, { red: 1, green: 2, missing: 0, error: 0, notRun: 1 });
  assert.equal(d1.gate.runs, 2);
  assert.equal(d1.gate.attempts, 2);
  assert.deepEqual(d1.gate.verdicts, ['FAIL', 'PASS']);
  assert.equal(d1.gate.final, 'PASS');
  assert.equal(d1.repos.length, 1);
  assert.deepEqual(d1.repos[0].steps, { pass: 6, fail: 0, skip: 1, cached: 0 });
  assert.deepEqual(d1.repos[0].artefacts, { fresh: 1, stale: 1, failed: 1, byKind: { db: 1, http: 2 } });
  assert.deepEqual(d1.interventions, { denials: 3, byRail: { db: 1, protect: 2 } });
  assert.equal(d1.tests.phase, 'tests');
  assert.equal(d1.tests.entries, 2);
  assert.equal(d1.tests.expectChangesTotal, 2);
  assert.deepEqual(d1.tests.expectChanges.map((x) => x.file), ['src/orders/total.test.ts', 'src/orders/tax.test.ts']);
  assert.equal(d1.runner.present, true);
  assert.equal(d1.runner.agent, 'claude');
  assert.equal(d1.runner.sessions, 2);
  assert.equal(d1.runner.turns, 20);
  assert.equal(d1.runner.costUsd, 1.5);
  assert.equal(d1.hookSessions, 1);
  assert.equal(d1.landing.outcome, 'landed');
  assert.equal(d1.landing.postLandingRed, true);
  assert.equal(d1.landing.transitions, 3);
  assert.equal(d1.landing.ciRuns, 2);
  assert.equal(d1.pr.number, 17);
  assert.equal(d1.wall.first, '2026-10-01T10:01:00.000Z');
  assert.equal(d1.wall.last, '2026-10-01T10:09:00.000Z');
  assert.equal(d1.wall.minutes, 8);
});

test('a task without run.json, landing or pr records says so; the optional expectChanges field is not required', () => {
  const { d2 } = digests();
  assert.equal(d2.runner.present, false);
  assert.equal(d2.runner.costUsd, null);
  assert.equal(d2.landing.present, false);
  assert.equal(d2.landing.outcome, 'none');
  assert.equal(d2.pr.present, false);
  assert.equal(d2.tests.expectChangesTotal, 0);
  assert.equal(d2.gate.final, 'BLOCKED');
  assert.deepEqual(d2.interventions.byRail, { other: 1, secrets: 1 });
  const text = renderDigest(d2);
  assert.match(text, /No landing record\./);
  assert.match(text, /No pull request record\./);
  assert.match(text, /Cost: not recorded\./);
});

test('the digest counts the local changes the gate left out (counts only, from evidence.json)', () => {
  const { d1, d2 } = digests();
  assert.deepEqual(d2.repos[0].localChanges, { leftOut: 4, changedSince: 1 });
  assert.equal(d1.repos[0].localChanges, undefined);
  assert.match(renderDigest(d2), /Local changes present when the ticket started: 4 left out of the gate, 1 changed during the ticket and checked\./);
  assert.doesNotMatch(renderDigest(d1), /Local changes present/);
});

test('the rendered digest has its sections and carries names and counts only', () => {
  const { d1 } = digests();
  const text = renderDigest(d1);
  const heads = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  assert.deepEqual(heads, [...DIGEST_SECTIONS]);
  assert.match(text, /^# Ticket digest: Export the quokkaledger totals/);
  assert.match(text, /Red 1, green 2, no test found 0, could not run 0, not run yet 1\./);
  assert.match(text, /The hooks denied 3 tool call\(s\)\./);
  assert.match(text, /\| protect \| 2 \|/);
  assert.match(text, /Entered the tests phase 2 time\(s\)\. Declared expectation changes: 2\./);
  assert.match(text, /- src\/orders\/total\.test\.ts \(2026-10-01T10:04:00\)/);
  assert.match(text, /1 fresh, 1 stale, 1 recording a failure/);
  assert.match(text, /Cost as reported by the agent: 1\.5 USD\./);
  assert.match(text, /Pull request #17/);
  assert.match(text, /8 min across/);
  // Ticket text beyond the title, criteria text and the agent's reasons never appear.
  assert.ok(!text.includes(HIDDEN_WORD), 'criteria, check descriptions and reasons are not copied');
});

test('a planted token in the title or a BLOCKED reason is redacted in the digest', () => {
  const { d2 } = digests();
  const text = renderDigest(d2);
  assert.ok(!text.includes(SECRET), 'the token does not appear');
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /BLOCKED reason:/);
});

test('harness digest prints the page, saves digest.md beside the write-up, and --json prints the record', async () => {
  const r = await capture(() => digestMain(['--task', T1]));
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(h.harnessHome, 'runs', ALPHA, T1, 'digest.md');
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(h.harnessHome, 'runs', ALPHA, T1, 'writeup.md')));
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(r.stdout.startsWith(saved), 'the printed page is the saved page');
  assert.match(r.stdout, /Saved .*digest\.md/);

  const j = await capture(() => digestMain(['--task', T1, '--json']));
  assert.equal(j.code, 0);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.gate.attempts, 2);

  const blocked = await capture(() => digestMain(['--task', T2]));
  assert.equal(blocked.code, 0);
  assert.ok(!blocked.stdout.includes(SECRET));
  assert.ok(!fs.readFileSync(path.join(h.harnessHome, 'runs', ALPHA, T2, 'digest.md'), 'utf8').includes(SECRET));
});

test('harness digest: unknown task exits 1, bad id and stray arguments exit 2', async () => {
  const none = await capture(() => digestMain(['--task', 't-9999999999']));
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No task t-9999999999/);
  const bad = await capture(() => digestMain(['--task', '../x']));
  assert.equal(bad.code, 2);
  const extra = await capture(() => digestMain(['whatever']));
  assert.equal(extra.code, 2);
});

test('the report gains a per-ticket table with the digest headline numbers, and a line per rail', () => {
  const report = buildReport(collectState(), { harnessVersion: '0.4.0', now: new Date('2026-10-19T00:00:00.000Z') });
  assert.equal(report.perTicket!.length, 2);
  assert.deepEqual(report.perTicket![0], {
    ticketHash: H1,
    criteria: 5,
    gateAttempts: 2,
    gateVerdict: 'PASS',
    denials: 3,
    testsEntries: 2,
    expectChanges: 2,
    sessions: 2,
    costUsd: 1.5,
    landing: 'landed',
    pullRequest: true,
    minutes: 8,
  });
  const second = report.perTicket![1];
  assert.equal(second.gateVerdict, 'BLOCKED');
  assert.equal(second.denials, 2);
  assert.equal(second.landing, 'none');
  assert.equal(second.pullRequest, false);
  assert.equal(second.costUsd, undefined);
  assert.deepEqual(report.rails, { db: 1, other: 1, protect: 2, secrets: 1 });
  // Existing fields are unchanged: the task rows have no per-ticket keys.
  assert.ok(!('denials' in report.tasks[0]));

  const md = makeReport({ harnessVersion: '0.4.0', now: new Date('2026-10-19T00:00:00.000Z') }).markdown;
  assert.match(md, /## Per ticket/);
  assert.match(md, new RegExp(`\\| ${H1.slice(0, 12)} \\| 5 \\| 2 \\| PASS \\| 3 \\| 2 \\| 2 \\| 2 \\| 1\\.5 \\| landed \\| yes \\| 8 \\|`));
  assert.match(md, /## Rails/);
  assert.match(md, /\| protect \| 2 \|/);
  assert.match(md, /\| total \| 5 \|/);
});

test('the report with the per-ticket table passes the scrub, and the scrubber catches a planted workspace word in it', async () => {
  const run = makeReport({ harnessVersion: '0.4.0', now: new Date('2026-10-19T00:00:00.000Z') });
  assert.equal(run.scrub.ok, true, `leaks: ${run.scrub.leaks.join(', ')}`);
  const bad: Report = JSON.parse(JSON.stringify(run.report));
  bad.perTicket![0].landing = 'quokkaledger';
  const r = scrubReport(bad, null, run.tokens);
  assert.equal(r.ok, false);
  assert.ok(r.leaks.includes('perTicket[0].landing'), r.leaks.join(', '));
  const bad2: Report = JSON.parse(JSON.stringify(run.report));
  bad2.rails!['alpha-service'] = 1;
  const r2 = scrubReport(bad2, null, run.tokens);
  assert.equal(r2.ok, false);
  assert.ok(r2.leaks.some((l) => l.startsWith('rails')), r2.leaks.join(', '));

  const cmd = await capture(() => reportMain(['--check-scrub']));
  assert.equal(cmd.code, 0, cmd.stdout);
});

test('ticketRow turns a digest into the headline numbers', () => {
  const { d1 } = digests();
  const row = ticketRow(d1, H1);
  assert.equal(row.gateAttempts, d1.gate.attempts);
  assert.equal(row.pullRequest, true);
});
