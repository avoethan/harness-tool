import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPlan } from '../../../src/lifecycle/apply';
import { undoPlan } from '../../../src/lifecycle/undo';
import { savePlan } from '../../../src/lifecycle/plans';
import { changeDiff, collectChanges, formatChanges } from '../../../src/lifecycle/changes';
import { main as changesMain } from '../../../src/commands/changes';
import { capture } from '../commands/capture';
import { plan, target, tempHome, write, type TempHome } from './helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-changes-');
});
after(() => h.cleanup());

test('changes lists added, changed and removed files with how each stands now, across installs', async () => {
  const ws = path.join(h.workspace, 'a');
  const agents = path.join(ws, 'AGENTS.md');
  const skill = path.join(ws, '.devin', 'skills', 'task', 'SKILL.md');
  const flow = path.join(ws, '.devin', 'workflows', 'old.md');
  write(agents, '# Mine\nkeep this\n');
  write(flow, 'generated before\n');

  const p1 = plan('p-one', 'team', [
    target(agents, 'modify', '# Mine\nkeep this\n\n<!-- harness -->\nRun the gate.\n', { owner: 'user', hunks: [{ checkId: 'R26', reason: 'TRIM -> archive: a file map the agent can derive', provenance: 'AGENTS.md:3-12' }] }),
    target(skill, 'create', 'skill v1\n'),
  ]);
  savePlan(p1);
  const r1 = await applyPlan(p1, { workspaceRoot: h.workspace });
  assert.ok(r1.ok, JSON.stringify(r1.refused));
  let c = collectChanges();
  assert.deepEqual(c.files.map((f) => [path.basename(f.path), f.kind, f.now]), [['SKILL.md', 'added', 'as-left'], ['AGENTS.md', 'changed', 'as-left']]);
  assert.match(changeDiff(c.files.find((f) => f.path === agents)!), /\+Run the gate\./);

  // a self-update replaces the skill; the user then edits it, and edits AGENTS.md back to their original
  const r2 = await applyPlan(plan('p-two', 'team', [target(skill, 'modify', 'skill v2\n')]), { workspaceRoot: h.workspace });
  assert.ok(r2.ok, JSON.stringify(r2.refused));
  fs.writeFileSync(skill, 'skill v2\nmy own line\n');
  fs.writeFileSync(agents, '# Mine\nkeep this\n');
  c = collectChanges();
  const skillC = c.files.find((f) => f.path === skill)!;
  assert.equal(skillC.kind, 'added', 'still a harness-added file: it did not exist before the first install');
  assert.equal(skillC.now, 'edited-since');
  assert.deepEqual(skillC.plans, ['p-one', 'p-two']);
  assert.equal(c.files.find((f) => f.path === agents)!.now, 'back-to-original');
  const text = formatChanges(c, { diff: true });
  assert.match(text, /2 installs or self-updates in effect/);
  assert.match(text, /Changed \(a copy of the original is kept\): 1/);
  assert.match(text, /edited since \(by you or an agent\)/);
  assert.match(text, /\+my own line/);
  assert.match(text, /1 file was changed after the harness wrote it/);
  // why: the plan's own reason with where it came from, and why that kind of change helps
  assert.match(text, /why:\n\s+- TRIM -> archive: a file map the agent can derive  \[from AGENTS\.md:3-12\]/);
  assert.match(text, /better because: derived content \(file maps, structure\) goes stale/);
  // p-two's plan file was never saved: its change to the skill has no reason, p-one's still does
  assert.deepEqual(skillC.reasons.map((r) => r.plan), ['p-one']);

  // the command filters by path text, either slash
  const out = await capture(() => changesMain(['--path', '.devin\\skills', '--json']));
  const j = JSON.parse(out.stdout) as { harness: { files: Array<{ path: string }> }; agentFiles: unknown };
  assert.deepEqual(j.harness.files.map((f) => f.path), [skill]);
  assert.equal(j.agentFiles, null, 'no agent-files record yet');

  // an undone install no longer counts
  await undoPlan('p-two', {});
  await undoPlan('p-one', {});
  assert.equal(collectChanges().files.filter((f) => f.path === agents).length, 0);
});

test('a file the harness added and later removed again is not listed: nothing of it is left', async () => {
  const ws = path.join(h.workspace, 'b');
  const gen = path.join(ws, '.devin', 'workflows', 'gen.md');
  const r1 = await applyPlan(plan('p-gen', 'team', [target(gen, 'create', 'generated\n')]), { workspaceRoot: h.workspace });
  assert.ok(r1.ok);
  const r2 = await applyPlan(plan('p-del', 'team', [target(gen, 'delete')]), { workspaceRoot: h.workspace });
  assert.ok(r2.ok, JSON.stringify(r2));
  const c = collectChanges().files.filter((f) => f.path === gen);
  assert.equal(c.length, 0, 'added and removed again by the harness: nothing of it is left to report');
});

test('with nothing installed it says so', async () => {
  const out = formatChanges({ plans: [], files: [] });
  assert.match(out, /the harness has changed none of your files/);
});

test('reasons: consecutive lines with the same reason read as one range; the why-better sentence comes by check id or classification', async () => {
  const { groupReasons, whyBetter } = await import('../../../src/lifecycle/changes');
  const r = (from: string, reason = 'TRIM -> archive: derivable') => ({ plan: 'p', checkId: 'R26', reason, from });
  const g = groupReasons([r('AGENTS.md:6'), r('AGENTS.md:7'), r('AGENTS.md:8-9'), r('AGENTS.md:12'), r('AGENTS.md:13', 'FIX -> corrected: stale'), r('templates (harness)')]);
  assert.deepEqual(g.map((x) => x.from), ['AGENTS.md:6-9', 'AGENTS.md:12', 'AGENTS.md:13', 'templates (harness)']);
  assert.match(whyBetter({ checkId: 'render.skill.task', reason: 'task skill' })!, /step-by-step order of work/);
  assert.match(whyBetter({ checkId: 'X99', reason: 'QUARANTINE -> quarantine: odd' })!, /set aside for you to review/);
  assert.equal(whyBetter({ checkId: 'X99', reason: 'something else' }), undefined);
});
