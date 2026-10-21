import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTaskPhase, phaseForRepo, phasePath, readPhaseRecord, setTaskPhase } from '../../../src/intake/phase';
import { setCurrentTask } from '../../../src/intake/brief';
import { repoIdFor } from '../../../src/lib/config';
import { getPhase } from '../../../src/lib/session';
import { main as phaseMain } from '../../../src/commands/phase';
import { capture } from '../commands/capture';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
before(() => {
  h = tempHome('harness-phase-');
  delete process.env.HARNESS_SESSION_ID;
  repo = gitRepo(path.join(h.workspace, 'svc'));
});
after(() => h.cleanup());

test('setTaskPhase writes phase.json with timestamps and counts entries into the tests phase (transitions only)', () => {
  const t0 = new Date('2026-10-19T10:00:00Z');
  const r1 = setTaskPhase('svc-abc', 't-1', 'tests', { now: t0 });
  assert.equal(r1.testsEntries, 1);
  assert.equal(r1.since, t0.toISOString());
  const r2 = setTaskPhase('svc-abc', 't-1', 'tests', { now: new Date('2026-10-19T10:05:00Z') });
  assert.equal(r2.testsEntries, 1, 'staying in tests is not a new entry');
  assert.equal(r2.since, t0.toISOString());
  setTaskPhase('svc-abc', 't-1', 'implement', { now: new Date('2026-10-19T10:10:00Z'), sessionId: 's1' });
  const r4 = setTaskPhase('svc-abc', 't-1', 'tests', { now: new Date('2026-10-19T10:20:00Z') });
  assert.equal(r4.testsEntries, 2);
  assert.deepEqual(
    r4.history.map((x) => x.phase),
    ['tests', 'implement', 'tests'],
  );
  assert.equal(r4.history[1].sessionId, 's1');
  assert.equal(getTaskPhase('svc-abc', 't-1'), 'tests');
  assert.ok(fs.existsSync(phasePath('svc-abc', 't-1')));
  assert.equal(readPhaseRecord('svc-abc', 'nope'), null);
  assert.throws(() => setTaskPhase('svc-abc', 't-1', 'review' as never), /unknown phase/);
});

test('phaseForRepo reads the current task of a repo (the guard fallback)', () => {
  assert.deepEqual(phaseForRepo(repo), {});
  setCurrentTask(repoIdFor(repo), 't-2');
  assert.deepEqual(phaseForRepo(repo), { task: 't-2' });
  setTaskPhase(repoIdFor(repo), 't-2', 'implement');
  assert.deepEqual(phaseForRepo(repo), { phase: 'implement', task: 't-2' });
});

test('phase command: current task, --task, --session writes the session state too, status, usage errors', async () => {
  const other = gitRepo(path.join(h.workspace, 'empty'));
  let r = await capture(() => phaseMain(['tests', '--repo', other]));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No current task/);
  r = await capture(() => phaseMain(['tests', '--repo', repo, '--session', 'sess-9']));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Task t-2: phase tests \(entry 1\)/);
  assert.equal(getPhase('sess-9'), 'tests');
  r = await capture(() => phaseMain(['implement', '--repo', repo]));
  assert.match(r.stdout, /recorded for the task only/);
  assert.equal(getPhase('sess-9'), 'tests', 'no session given: the session state is untouched');
  r = await capture(() => phaseMain(['status', '--repo', repo, '--json']));
  const j = JSON.parse(r.stdout);
  assert.equal(j.phase, 'implement');
  assert.equal(j.testsEntries, 1);
  r = await capture(() => phaseMain(['tests', '--repo', repo, '--task', 'T-007']));
  assert.equal(r.code, 0);
  assert.equal(getTaskPhase(repoIdFor(repo), 'T-007'), 'tests');
  r = await capture(() => phaseMain(['tests', '--repo', repo, '--task', '../x']));
  assert.equal(r.code, 2);
  r = await capture(() => phaseMain(['review', '--repo', repo]));
  assert.equal(r.code, 2);
});
