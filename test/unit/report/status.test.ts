import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, type TempHome } from '../lifecycle/helpers';
import { capture } from '../commands/capture';
import { collectState } from '../../../src/report/collect';
import { buildStatus, renderStatus } from '../../../src/report/status';
import { main } from '../../../src/commands/status';
import { configPath } from '../../../src/lib/paths';
import { buildFixture, T1, T2 } from './fixture';

let h: TempHome;
before(() => {
  h = tempHome('harness-status-');
  delete process.env.XDG_CONFIG_HOME;
});
after(() => h.cleanup());

const NOW = new Date('2026-10-19T12:00:00.000Z');

test('status on an empty HARNESS_HOME: not installed, the next step is install', async () => {
  const s = buildStatus(collectState(), NOW);
  assert.equal(s.installed, false);
  assert.equal(s.tasks.length, 0);
  assert.match(s.next, /^Install the harness: `harness install --setting team/);
  const text = renderStatus(s);
  assert.match(text, /^harness status: not installed on this machine/);
  assert.match(text, /Ledger {7}none yet/);
  assert.match(text, /\nNext: Install the harness/);
  const cli = await capture(() => main([]));
  assert.equal(cli.code, 0);
  assert.match(cli.stdout, /not installed/);
  const json = await capture(() => main(['--json']));
  assert.equal(JSON.parse(json.stdout).installed, false);
});

test('status on a populated HARNESS_HOME: one screen with the counts, open tasks and the next step', async () => {
  buildFixture(h.harnessHome, h.workspace);
  const s = buildStatus(collectState(), NOW);
  assert.equal(s.installed, true);
  assert.equal(s.setting, 'team');
  assert.deepEqual(s.agents, ['devin', 'claude']);
  assert.equal(s.repos, 2);
  assert.deepEqual(s.ledger, { present: true, generatedAt: '2026-10-01T08:00:00.000Z', ageDays: 18, records: 5, blocking: 3 });
  assert.deepEqual(s.db, { test: 1, readOnly: 0, notTest: 0, hashOk: true });
  assert.deepEqual(s.integrity, { signed: false, ok: true, reason: undefined });
  assert.equal(s.open, 1);
  assert.equal(s.done, 1);
  const t2 = s.tasks.find((t) => t.id === T2)!;
  assert.deepEqual({ ...t2, at: undefined }, { id: T2, repo: 'alpha-service', title: 'Second task', phase: 'tests', attempt: 8, verdict: 'FAIL', capReached: true, current: true, at: undefined });
  assert.equal(s.tasks[0].id, T2, 'the current task comes first');
  assert.equal(s.tasks.find((t) => t.id === T1)!.verdict, 'PASS');
  assert.equal(s.lessonsPending, 2);
  assert.deepEqual(s.selfcheck, [{ agent: 'devin', recorded: 2, steps: 16, different: 1 }]);
  assert.match(s.next, new RegExp(`^Task ${T2} stopped at the gate attempt cap without a PASS\\. Run \`harness gate --task ${T2}\``));
  assert.ok(s.notes.some((n) => /1 line\(s\) of the instrumentation log did not parse/.test(n)));
  const text = renderStatus(s);
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 24, `fits one screen: ${lines.length} lines`);
  assert.match(text, /^harness status: team setting; agents devin, claude\n/);
  assert.match(text, /Workspace {4}.+ \(2 repos\)/);
  assert.match(text, /Ledger {7}5 standard\(s\), 3 blocking; discovered 18 days ago/);
  assert.match(text, /Databases {4}1 marked test, 0 marked not test; allowlist intact/);
  assert.match(text, /Integrity {4}not signed yet/);
  assert.match(text, /Tasks {8}1 open, 1 passed the gate/);
  assert.match(text, new RegExp(`\\* ${T2}  alpha-service  tests  attempt 8  capped  Second task`));
  assert.doesNotMatch(text, new RegExp(`\\s${T1}\\s`), 'a passed task is not listed as open');
  assert.match(text, /Lessons {6}2 waiting for review/);
  assert.match(text, /Self-checks {2}devin 2\/16 step\(s\) recorded, 1 different from expected/);
});

test('status next steps follow urgency: integrity, then a failing task, then lessons, then the self-check', () => {
  // A failing (not capped) task: drop the cap marker.
  const ev = path.join(h.harnessHome, 'runs', 'alpha-service-1a2b3c', T2, 'evidence.json');
  const e = JSON.parse(fs.readFileSync(ev, 'utf8'));
  delete e.cap_reached;
  fs.writeFileSync(ev, JSON.stringify(e));
  let s = buildStatus(collectState(), NOW);
  assert.match(s.next, new RegExp(`^Task ${T2}: the last gate run failed`));
  // The task passes: lessons come next.
  e.verdict = 'PASS';
  fs.writeFileSync(ev, JSON.stringify(e));
  s = buildStatus(collectState(), NOW);
  assert.match(s.next, /^2 lesson\(s\) wait for review: `harness learn review`/);
  // No lessons waiting: the Devin self-check is not finished.
  fs.rmSync(path.join(h.harnessHome, 'lessons'), { recursive: true, force: true });
  s = buildStatus(collectState(), NOW);
  assert.match(s.next, /^Run the devin self-check \(selfcheck\/devin-desktop\.md in the harness folder\)/);
  // Integrity fails: that comes first.
  fs.writeFileSync(path.join(h.harnessHome, 'integrity.json'), JSON.stringify({ version: 1, writtenAt: NOW.toISOString(), files: { [configPath()]: '0'.repeat(64) } }));
  s = buildStatus(collectState(), NOW);
  assert.equal(s.integrity.ok, false);
  assert.match(s.next, /^Run `harness doctor`: the integrity check fails \(changed config\.json\)/);
  assert.match(renderStatus(s), /Integrity {4}FAILS: changed config\.json/);
  fs.rmSync(path.join(h.harnessHome, 'integrity.json'));
});
