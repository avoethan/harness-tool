import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, git, type TempHome } from '../lifecycle/helpers';
import { capture } from '../commands/capture';
import { collectState } from '../../../src/report/collect';
import { buildReport } from '../../../src/report/build';
import { renderMarkdown } from '../../../src/report/markdown';
import { summariseAll } from '../../../src/report/selfcheck';
import { parseCsv, readWorklog } from '../../../src/report/worklog';
import { main } from '../../../src/commands/report';
import { buildFixture, H1, H2, T1 } from './fixture';
import type { Report } from '../../../src/types';

let h: TempHome;
let report: Report;
before(() => {
  h = tempHome('harness-report-');
  delete process.env.XDG_CONFIG_HOME;
  buildFixture(h.harnessHome, h.workspace);
  report = buildReport(collectState(), { harnessVersion: '0.1.0', now: new Date('2026-10-19T00:00:00.000Z'), selfcheck: summariseAll() });
});
after(() => h.cleanup());

test('standards, checks, assessment and proposals are counted from the fixture, unknown keys as other', () => {
  assert.deepEqual(report.standards.byTier, { declared: 1, 'counted-strong': 1, 'counted-majority': 1, 'single-source': 1, other: 1 });
  assert.deepEqual(report.standards.byFamily, { lint: 1, naming: 2, errors: 1, other: 1 });
  assert.equal(report.checks.generated, 4);
  assert.deepEqual(report.checks.byMode, { block: 2, warn: 1, judgment: 1 });
  assert.deepEqual(report.checks.byType, { eslint: 1, 'ast-grep': 2, judgment: 1 });
  assert.deepEqual(report.assessment.findingsByCheck, { R10: 2, R30: 1, other: 2 });
  assert.deepEqual(report.assessment.classifications, { KEEP: 3, CONVERT: 2, QUARANTINE: 1, other: 1 });
  assert.equal(report.teamProposals, 2);
});

test('per task rows keyed by ticket hash with the known counts; hook and adhoc runs are not tasks', () => {
  assert.equal(report.tasks.length, 2);
  const [a, b] = report.tasks;
  assert.equal(a.ticketHash, H1);
  assert.deepEqual(
    { ...a },
    {
      ticketHash: H1,
      criteria: 3,
      checksRun: 6, // tamper, secrets, standards, lint, tests:base, acceptance:AC1 (coverage skipped)
      checksFailedThenFixed: 1, // lint failed in the first gate run, passes now
      gateVerdict: 'PASS',
      verificationEvidence: 2,
      standardsFlagged: 0,
      clarificationsAsked: 2, // one answered, one open
      repeatCorrections: 1, // style twice, test once
      steeringMessages: 3, // four prompts in the one session tied to the task
      reworkRounds: 2, // from the work log
      outcome: 'merged', // from the work log
      gateRuns: 2,
      capReached: false,
    },
  );
  assert.equal(b.ticketHash, H2);
  assert.equal(b.criteria, 2);
  assert.equal(b.checksRun, 3); // standards (event), tamper, lint
  assert.equal(b.checksFailedThenFixed, 0);
  assert.equal(b.gateVerdict, 'FAIL');
  assert.equal(b.standardsFlagged, 2); // lint.no-explicit-any (event and evidence), naming.camel-case (warn)
  assert.equal(b.repeatCorrections, 0); // one correction, tied through the session
  assert.equal(b.steeringMessages, 1);
  assert.equal(b.reworkRounds, undefined);
  assert.equal(b.outcome, 'capped');
  assert.equal(b.capReached, true);
});

test('learning loop, caps, self-checks, work log rows and the period', () => {
  assert.deepEqual(report.learning, { captured: 4, proven: 2, approved: 1, expired: 1 });
  assert.deepEqual(report.caps, { tasksAtGateCap: 1, stopReleasesAtCap: 1 });
  assert.deepEqual(report.selfcheck, { devin: { steps: 16, recorded: 2, confirmed: ['markers'], different: ['stop-timeout'] } });
  assert.equal(report.worklogRows, 1);
  assert.deepEqual(report.period, { from: '2026-09-01', to: '2026-10-05' });
  assert.equal(report.harnessVersion, '0.1.0');
});

test('--since keeps only what happened on or after the date', () => {
  const r = buildReport(collectState(), { harnessVersion: '0.1.0', since: '2026-10-02T00:00:00.000Z' });
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].ticketHash, H2);
  assert.equal(r.period?.since, '2026-10-02');
  assert.equal(r.period?.from, '2026-10-02'); // the lessons' first-seen date
  assert.equal(r.learning.captured, 4);
  const late = buildReport(collectState(), { harnessVersion: '0.1.0', since: '2026-10-10' });
  assert.equal(late.tasks.length, 0);
  assert.equal(late.learning.captured, 0);
});

test('Markdown: plain language, one table per section, no ticket text', () => {
  const md = renderMarkdown(report);
  const sections = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(sections, [
    '## Standards by tier',
    '## Standards by family',
    '## Checks generated',
    '## Checks by tool',
    '## Assessment findings',
    '## Assessment line classes',
    '## Team proposals',
    '## Tasks',
    '## Learning loop',
    '## Caps',
    '## Self-checks',
  ]);
  for (const block of md.split('\n## ').slice(1)) {
    const tables = block.split('\n').filter((l) => /^\| --- \|/.test(l)).length;
    assert.equal(tables, 1, `one table in section ${block.split('\n')[0]}`);
  }
  assert.match(md, /\| Ticket \| Criteria \| Checks run \| Failed then fixed \| Gate verdict \| Gate runs \| Verification evidence \| Standards flagged \| Clarifications asked \| Repeat corrections \| Steering messages \| Rework rounds \| Outcome \|/);
  assert.match(md, new RegExp(`\\| ${H1.slice(0, 12)} \\| 3 \\| 6 \\| 1 \\| PASS \\| 2 \\| 2 \\| 0 \\| 2 \\| 1 \\| 3 \\| 2 \\| merged \\|`));
  assert.match(md, new RegExp(`\\| ${H2.slice(0, 12)} \\| 2 \\| 3 \\| 0 \\| FAIL \\| 1 \\| 0 \\| 2 \\| 0 \\| 0 \\| 1 \\| not logged \\| stopped at the attempt cap \\|`));
  assert.match(md, /\| declared \| 1 \|\n\| counted-strong \| 1 \|/);
  assert.match(md, /\| Ticket \| Criteria .*\n\| --- \| ---: \| ---: \| ---: \| --- \| ---: \| ---: \| ---: \| ---: \| ---: \| ---: \| --- \| --- \|/, 'numbers right, text left');
  assert.match(md, /\| total \| 5 \|/);
  assert.match(md, /Covers 2026-09-01 to 2026-10-05/);
  assert.doesNotMatch(md, /quokkaledger|Zanzibar|alpha-service/i);
});

test('JSON follows the Report type', () => {
  const j = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  for (const k of ['version', 'generatedAt', 'harnessVersion', 'standards', 'checks', 'assessment', 'teamProposals', 'tasks', 'learning']) assert.ok(k in j, `key ${k}`);
  assert.equal(j.version, 1);
  const row = (j.tasks as Array<Record<string, unknown>>)[0];
  for (const k of ['ticketHash', 'criteria', 'checksRun', 'checksFailedThenFixed', 'gateVerdict', 'verificationEvidence', 'standardsFlagged', 'clarificationsAsked', 'repeatCorrections', 'steeringMessages', 'outcome']) assert.ok(k in row, `row key ${k}`);
  assert.ok(!('title' in row) && !('id' in row), 'no title or task id in a row');
});

test('work log CSV: quoted fields, header lookup by name, unusable rows skipped', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n\r\n1,2,3'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
  const log = readWorklog(path.join(h.harnessHome, 'worklog.csv'))!;
  assert.equal(log.rows.length, 1);
  assert.equal(log.skipped, 1);
  assert.deepEqual(log.rows[0], { ticketHash: H1.slice(0, 12), date: '2026-10-01', reworkRounds: 2, outcome: 'merged' });
  assert.equal(readWorklog(path.join(h.root, 'missing.csv')), null);
});

test('CLI: report --md prints the tables, --json parses, --check-scrub passes, --out writes outside a repo', async () => {
  const md = await capture(() => main(['--md']));
  assert.equal(md.code, 0, md.stderr);
  assert.match(md.stdout, /^# Harness report/);
  assert.match(md.stdout, /## Tasks\n/);
  assert.match(md.stdout, /\| Tier \| Standards \|/);
  const js = await capture(() => main(['--json']));
  assert.equal(js.code, 0, js.stderr);
  assert.equal(JSON.parse(js.stdout).tasks.length, 2);
  const sc = await capture(() => main(['--check-scrub']));
  assert.equal(sc.code, 0, sc.stdout + sc.stderr);
  assert.match(sc.stdout, /^scrub: ok\. \d+ token\(s\) checked/);
  const n = Number(/(\d+) token\(s\) checked/.exec(sc.stdout)![1]);
  assert.ok(n > 10, `tokens checked: ${n}`);
  const out = path.join(h.root, 'out', 'report.md');
  const w = await capture(() => main(['--md', '--out', out]));
  assert.equal(w.code, 0, w.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^# Harness report/);
  const bad = await capture(() => main(['--since', 'not a date']));
  assert.equal(bad.code, 2);
  const both = await capture(() => main(['--json', '--md']));
  assert.equal(both.code, 2);
});

test('CLI: --out inside a git repository is refused in the team setting (exit 4), nothing written', async () => {
  const repo = path.join(h.workspace, 'alpha-service');
  assert.equal(git(repo, ['init', '-q']).code, 0);
  const out = path.join(repo, 'harness-report.md');
  const r = await capture(() => main(['--out', out]));
  assert.equal(r.code, 4);
  assert.match(r.stderr, /inside a git repository/);
  assert.equal(fs.existsSync(out), false);
  fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
});

test('CLI: a report that would carry a workspace token is refused and names the field only', async () => {
  // A workspace file named like the ticket-hash prefix the Markdown shows: the scrub must catch it.
  const planted = path.join(h.workspace, 'beta-service', `${H1.slice(0, 12)}.txt`);
  fs.writeFileSync(planted, 'x');
  try {
    const r = await capture(() => main(['--md']));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /report: refused\. The report would carry workspace text in: markdown line \d+/);
    assert.ok(!r.stderr.includes(H1.slice(0, 12)), 'the leaked token is not printed');
    assert.equal(r.stdout, '');
    const sc = await capture(() => main(['--check-scrub']));
    assert.equal(sc.code, 1);
    assert.match(sc.stdout, /scrub: FAILED/);
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

test('CLI: report row prints a work-log row with what the harness measured; --append adds it once', async () => {
  const r = await capture(() => main(['row', '--task', T1, '--header']));
  assert.equal(r.code, 0, r.stderr);
  const [header, row] = r.stdout.trim().split('\n');
  assert.equal(header, 'ticket_hash,date,task_kind,size_estimate,user_messages,waiting_for_user_episodes,acus,time_to_pr_min,pr_rework_rounds,review_findings_by_family,e2e_proof_in_writeup,clarifications_asked,repeat_corrections,outcome,harness_version');
  const cells = row.split(',');
  assert.equal(cells[0], H1);
  assert.equal(cells[1], '2026-10-01');
  assert.equal(cells[2], 'unit'); // ties broken by the first kind counted
  assert.equal(cells[4], '3'); // user messages: four prompts minus one
  assert.equal(cells[5], '1'); // one stop followed by a prompt
  assert.equal(cells[10], 'yes'); // a write-up and two E2E artefacts
  assert.equal(cells[11], '2');
  assert.equal(cells[12], '1');
  const byHash = await capture(() => main(['row', '--task', H2.slice(0, 10)]));
  assert.equal(byHash.code, 0, byHash.stderr);
  assert.ok(byHash.stdout.startsWith(H2));
  const missing = await capture(() => main(['row', '--task', 't-0000000000']));
  assert.equal(missing.code, 1);
  const log = path.join(h.root, 'my-worklog.csv');
  const a1 = await capture(() => main(['row', '--task', T1, '--append', '--worklog', log]));
  assert.equal(a1.code, 0, a1.stderr);
  const a2 = await capture(() => main(['row', '--task', T1, '--append', '--worklog', log]));
  assert.equal(a2.code, 1);
  const text = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(text.length, 2);
  assert.ok(text[0].startsWith('ticket_hash,'));
});
