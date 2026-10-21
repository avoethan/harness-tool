/** `harness learn` as a command: flags, output, exit codes (no terminal, temp HARNESS_HOME). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { main } from '../../../src/commands/learn';
import { capture } from '../commands/capture';
import { lessonIdFor } from '../../../src/learn/classes';
import { loadLesson } from '../../../src/learn/store';
import { correction, gateFail, tempHome, writeEvents } from './helpers';

test('learn command: scan, list, review listing, decisions with exit codes, stats, gc, usage', async () => {
  const h = tempHome('harness-learn-cmd-');
  try {
    writeEvents(h.harnessHome, [correction(0, 'scope', 'a'), correction(1, 'scope', 'b'), gateFail(2, { step: 'typecheck', task: 'x' }), gateFail(3, { step: 'typecheck', task: 'y', session: 's2' })]);
    const s = await capture(() => main(['--scan', '--json']));
    assert.equal(s.code, 0, s.stderr);
    const out = JSON.parse(s.stdout);
    assert.equal(out.created.length, 2);
    assert.ok(out.bundle.id.startsWith('lj'));
    const human = await capture(() => main(['scan']));
    assert.match(human.stdout, /Lessons: 0 new, 0 updated, 2 in all/);

    const tc = lessonIdFor('step:typecheck');
    const p = await capture(() => main(['prove', tc]));
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /proven \(gate-event\)/);
    assert.match(p.stdout, /Tier 0: approved; the enforcer was already in place/);
    assert.equal(loadLesson(tc)!.status, 'approved');

    const list = await capture(() => main(['review']));
    assert.equal(list.code, 0);
    assert.match(list.stdout, /1 lesson\(s\) wait for a decision/);
    assert.match(list.stdout, /harness learn review --approve <id>/);

    const scope = lessonIdFor('correction:scope');
    const noEnforcer = await capture(() => main(['review', '--approve', scope]));
    assert.equal(noEnforcer.code, 1);
    assert.match(noEnforcer.stdout, /no enforcer yet/);
    const rej = await capture(() => main(['review', '--reject', scope, '--json']));
    assert.equal(rej.code, 0);
    assert.equal(JSON.parse(rej.stdout).decisions[0].ok, true);
    assert.equal(loadLesson(scope)!.status, 'rejected');

    const st = await capture(() => main(['stats', '--json']));
    assert.equal(JSON.parse(st.stdout).rows.length, 2);
    const gc = await capture(() => main(['gc']));
    assert.match(gc.stdout, /Lesson records: 2/);
    assert.equal((await capture(() => main(['prove']))).code, 2);
    assert.equal((await capture(() => main(['--scan', '--since', 'not-a-date']))).code, 2);
    assert.equal((await capture(() => main(['--scan', '--token-cap', '5']))).code, 2);
    assert.equal((await capture(() => main(['frobnicate']))).code, 2);
    const nf = await capture(() => main(['prove', 'l-nope-000000']));
    assert.equal(nf.code, 1);
    assert.match(nf.stderr, /no lesson/);
  } finally {
    h.cleanup();
  }
});
