import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion, GateStep } from '../../../src/types';
import { runGate } from '../../../src/gate';
import { buildContext } from '../../../src/gate/context';
import { gateOutcome, inScope } from '../../../src/gate/gatecheck';
import { sortSteps } from '../../../src/gate/steps';
import { main as gateMain } from '../../../src/commands/gate';
import { capture } from '../commands/capture';
import { commitAll, demoRepo, git, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-gatecheck-');
});
after(() => h.cleanup());

const AC2: Criterion = {
  id: 'AC2',
  text: 'The pin commit is still in the history and a new commit undoes it; nothing else changes in the tree.',
  kind: 'unit',
  check: { kind: 'gate', description: 'proved by the gate: the change touches only .nvmrc; the base commit stays in the history (no rewrite)', redFirst: false, scopePaths: ['.nvmrc'], keepsHistory: true },
};
const AC3: Criterion = {
  id: 'AC3',
  text: 'CI-equivalent checks (lint, typecheck, test, build, format:check) still pass.',
  kind: 'unit',
  check: { kind: 'gate', description: 'proved by the gate: lint, typecheck, tests:base, build pass in this run', redFirst: false, gateSteps: ['lint', 'typecheck', 'tests:base', 'build'] },
};

/** A repo whose last commit "pinned" .nvmrc, with a brief based at that commit; the fix is committed on top. */
function pinned(): { r: string; task: string } {
  const r = demoRepo(path.join(h.workspace, `g${++n}`), { '.nvmrc': '18\n' });
  const task = `t-gate-${n}`;
  writeBrief(r, task, [AC2, AC3]);
  return { r, task };
}

test('a gate check passes when the named steps passed, only the scope path changed and the base is still in the history', async () => {
  const { r } = pinned();
  fs.rmSync(path.join(r, '.nvmrc'));
  commitAll(r, 'revert: pin Node 18');
  const run = await runGate({ repo: r });
  const by = (name: string): GateStep => run.evidence.steps.find((s) => s.name === name)!;
  assert.equal(by('acceptance:AC2').status, 'pass', JSON.stringify(by('acceptance:AC2')));
  assert.match(by('acceptance:AC2').reasons!.join(' '), /proved by the gate: only \.nvmrc changed.*is still in the history/);
  assert.equal(by('acceptance:AC3').status, 'pass', JSON.stringify(by('acceptance:AC3')));
  assert.match(by('acceptance:AC3').reasons!.join(' '), /lint, typecheck, tests:base, build passed in this run/);
  // a step skipped because the repository has no such script counts as passed and is named
  assert.equal(by('lint').status, 'skip');
  assert.match(by('acceptance:AC3').reasons!.join(' '), /lint was skipped \(.*\), counted as passed/);
  // the gate-proved steps run last, after every step they read
  const names = run.evidence.steps.map((s) => s.name);
  assert.ok(names.indexOf('acceptance:AC3') > names.indexOf('affected'));
  assert.ok(!names.includes('acceptance'), 'no placeholder acceptance step when the checks are all gate-proved');
});

test('a change outside the scope paths fails the check and lists the offenders (working tree and untracked files included)', async () => {
  const { r } = pinned();
  fs.rmSync(path.join(r, '.nvmrc'));
  commitAll(r, 'revert: pin Node 18');
  put(r, 'src/add.js', 'exports.add = (a, b) => b + a;\n');
  put(r, 'notes/todo.txt', 'x\n');
  const run = await runGate({ repo: r });
  const s = run.evidence.steps.find((x) => x.name === 'acceptance:AC2')!;
  assert.equal(s.status, 'fail');
  assert.match(s.reasons!.join('\n'), /AC2: changed outside \.nvmrc: notes\/todo\.txt, src\/add\.js/);
  assert.equal(run.evidence.verdict, 'FAIL');
});

test('rewritten history fails the check: the base commit is no longer an ancestor of HEAD', () => {
  const { r } = pinned();
  fs.rmSync(path.join(r, '.nvmrc'));
  commitAll(r, 'revert: pin Node 18');
  const ok = buildContext({ repo: r });
  ok.stepResults = [];
  assert.equal(gateOutcome(ok, AC2).status, 'pass');
  // amend the base commit itself and commit the fix again on top: the brief's base sha is orphaned
  git(r, ['reset', '-q', '--hard', 'HEAD~1']);
  git(r, ['commit', '-q', '--amend', '-m', 'pin Node 18 (rewritten)']);
  fs.rmSync(path.join(r, '.nvmrc'));
  commitAll(r, 'revert: pin Node 18');
  const ctx = buildContext({ repo: r });
  assert.equal(ctx.base, ok.base, 'the brief still names the old base commit');
  ctx.stepResults = [];
  const o = gateOutcome(ctx, AC2);
  assert.equal(o.status, 'fail');
  assert.match(o.reasons.join('\n'), /no longer an ancestor of HEAD/);
});

test('named steps: a failed step, a skip that is not "no script" and a missing step do not count; "no script" skips do', () => {
  const { r } = pinned();
  const ctx = buildContext({ repo: r });
  const step = (name: string, status: GateStep['status'], reason?: string): GateStep => ({ name, status, durationMs: 0, ...(reason ? { reasons: [reason] } : {}) });
  const names = ['lint', 'typecheck', 'tests:base', 'build'];
  ctx.stepResults = [step('lint', 'skip', 'no linter configured (no ESLint or Prettier config and no lint script at the base commit)'), step('typecheck', 'cached'), step('tests:base', 'pass'), step('build', 'skip', 'no `build` script in package.json; nothing to build')];
  let o = gateOutcome(ctx, AC3);
  assert.equal(o.status, 'pass', JSON.stringify(o));
  assert.match(o.reasons.join(' '), /lint was skipped.*counted as passed/);
  assert.match(o.reasons.join(' '), /build was skipped.*counted as passed/);

  ctx.stepResults = [step('lint', 'pass'), step('typecheck', 'pass'), step('tests:base', 'fail', 'failing: add.test.js > adds'), step('build', 'pass')];
  o = gateOutcome(ctx, AC3);
  assert.equal(o.status, 'fail');
  assert.match(o.reasons.join(' '), /AC3: step tests:base failed \(failing: add\.test\.js > adds\)/);

  ctx.stepResults = [step('lint', 'pass'), step('typecheck', 'skip', 'TypeScript is neither declared nor installed in the repository; no typecheck ran'), step('tests:base', 'pass'), step('build', 'pass')];
  o = gateOutcome(ctx, AC3);
  assert.equal(o.status, 'fail');
  assert.match(o.reasons.join(' '), /step typecheck was skipped .* proves nothing/);

  ctx.stepResults = names.slice(0, 2).map((x) => step(x, 'pass'));
  o = gateOutcome(ctx, AC3);
  assert.equal(o.status, 'skip', 'a partial run cannot read the steps it did not run');
  assert.match(o.reasons[0], /tests:base, build not part of this run/);
});

test('the gate step runs no repository code of its own: its outcome needs no script, only git and the step results', () => {
  const r = demoRepo(path.join(h.workspace, `g${++n}`), { '.nvmrc': '18\n' });
  put(r, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(9)"', build: 'node -e "process.exit(9)"' } }));
  commitAll(r, 'scripts');
  writeBrief(r, `t-gate-${n}`, [AC2]);
  fs.rmSync(path.join(r, '.nvmrc'));
  commitAll(r, 'revert: pin');
  const ctx = buildContext({ repo: r });
  assert.equal(gateOutcome(ctx, AC2).status, 'pass');
});

test('scope paths: a folder covers what is inside it, a file only itself', () => {
  assert.equal(inScope('.nvmrc', ['.nvmrc']), true);
  assert.equal(inScope('./src/a/b.ts', ['src/a/']), true);
  assert.equal(inScope('src/ab/b.ts', ['src/a']), false);
  assert.equal(inScope('.nvmrc.bak', ['.nvmrc']), false);
});

test('sortSteps puts late steps after every other step', () => {
  const s = sortSteps([{ name: 'acceptance:AC2', late: true }, { name: 'affected' }, { name: 'lint' }]);
  assert.deepEqual(s.map((x) => x.name), ['lint', 'affected', 'acceptance:AC2']);
});

test('prove-red: a gate check is "proved by the gate\'s own steps", not run and not a failure', async () => {
  const { r } = pinned();
  const out = await capture(() => gateMain(['prove-red', '--repo', r]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /GATE\s+AC2\s+proved by the gate's own steps/);
  assert.match(out.stdout, /GATE\s+AC3\s+proved by the gate's own steps \(lint, typecheck, tests:base, build pass in this run\)/);
  const json = await capture(() => gateMain(['prove-red', '--repo', r, '--json']));
  const j = JSON.parse(json.stdout) as { gate: Array<{ criterion: string }>; results: unknown[] };
  assert.deepEqual(j.gate.map((x) => x.criterion), ['AC2', 'AC3']);
  assert.deepEqual(j.results, []);
});

test('a file-contains gate check: the gate reads the file itself, so no test runner is needed', () => {
  const r = demoRepo(path.join(h.workspace, `g${++n}`), { 'README.md': 'scratch\n' });
  const AC: Criterion = {
    id: 'AC1',
    text: 'README.md contains the line "second line".',
    kind: 'unit',
    check: { kind: 'gate', description: 'proved by the gate: README.md contains "second line"', redFirst: false, fileContains: { path: 'README.md', text: 'second line' } },
  };
  writeBrief(r, `t-gate-${n}`, [AC]);
  let ctx = buildContext({ repo: r });
  ctx.stepResults = [];
  const before = gateOutcome(ctx, AC);
  assert.equal(before.status, 'fail');
  assert.match(before.reasons.join(' '), /does not contain "second line"/);
  put(r, 'README.md', 'scratch\nsecond line\n');
  ctx = buildContext({ repo: r });
  ctx.stepResults = [];
  assert.equal(gateOutcome(ctx, AC).status, 'pass');
  const outside: Criterion = { ...AC, check: { ...AC.check!, fileContains: { path: '../x.md', text: 'a' } } };
  assert.equal(gateOutcome(ctx, outside).status, 'fail');
});
