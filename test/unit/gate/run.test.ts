import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile, GateStep } from '../../../src/types';
import { allSteps, decideVerdict, runGate } from '../../../src/gate';
import { buildContext, workingTree } from '../../../src/gate/context';
import { entriesDigest } from '../../../src/gate/cache';
import { STEP_ORDER, selects, sortSteps, type StepDef } from '../../../src/gate/steps';
import { runSecrets } from '../../../src/gate/secrets';
import { main as gateMain } from '../../../src/commands/gate';
import { writeTree } from '../../../src/lib/git';
import { repoIdFor } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import { capture } from '../commands/capture';
import { commitAll, demoRepo, git, put, tempHome, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-run-');
});
after(() => h.cleanup());

function repo(extra: Record<string, string> = {}): string {
  return demoRepo(path.join(h.workspace, `r${++n}`), extra);
}

function readEvidence(root: string, task: string): EvidenceFile {
  return JSON.parse(fs.readFileSync(path.join(runsDir(), repoIdFor(root), task, 'evidence.json'), 'utf8')) as EvidenceFile;
}

test('a temp repo with no changes: harness gate prints PASS with every step listed; evidence has the Stop hook fields', async () => {
  const r = repo();
  const out = await capture(() => gateMain(['--repo', r]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  for (const name of ['tamper', 'secrets', 'map-drift', 'e2e', 'standards', 'lint', 'typecheck', 'build', 'tests:base', 'acceptance', 'coverage', 'affected']) assert.match(out.stdout, new RegExp(`\\b(PASS|skip)\\s+${name.replace(':', '\\:')}\\b`), `step ${name} listed`);
  assert.match(out.stdout, /Verdict: PASS\./);
  assert.match(out.stdout, /PASS\s+tests:base .*1 passed/);
  const ev = readEvidence(r, 'adhoc');
  assert.equal(ev.version, 1);
  assert.equal(ev.verdict, 'PASS');
  assert.deepEqual(ev.reasons, []);
  assert.equal(ev.treeHash, writeTree(r), 'tree hash equals what the Stop hook computes');
  assert.equal(ev.baseSha, git(r, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(ev.attempt, 1);
  assert.equal(ev.task, 'adhoc');
  assert.equal(ev.repo, repoIdFor(r));
  assert.ok(Date.parse(ev.startedAt) <= Date.parse(ev.finishedAt));
  assert.ok(Array.isArray(ev.e2e));
  for (const s of ev.steps) {
    assert.ok(['pass', 'fail', 'skip', 'cached'].includes(s.status));
    assert.equal(typeof s.durationMs, 'number');
  }
  assert.ok(ev.steps.find((s) => s.name === 'tests:base')?.cache === 'miss');

  // Second run: attempt 2, cached steps reported as cached.
  const again = await capture(() => gateMain(['--repo', r, '--json']));
  assert.equal(again.code, 0);
  const j = JSON.parse(again.stdout) as { verdict: string; evidence: EvidenceFile };
  assert.equal(j.verdict, 'PASS');
  assert.equal(j.evidence.attempt, 2);
  const t = j.evidence.steps.find((s) => s.name === 'tests:base')!;
  assert.equal(t.status, 'cached');
  assert.equal(t.cache, 'hit');
});

test('step ordering: cheapest first, DESIGN numbers, selectors', () => {
  const r = repo();
  const names = allSteps(buildContext({ repo: r })).map((s) => s.name);
  assert.deepEqual(names, ['tamper', 'secrets', 'map-drift', 'e2e', 'standards', 'lint', 'typecheck', 'build', 'tests:base', 'acceptance', 'coverage', 'affected']);
  assert.deepEqual(
    sortSteps([{ name: 'coverage' }, { name: 'acceptance:AC2' }, { name: 'tamper' }, { name: 'acceptance:AC1' }, { name: 'e2e:AC3' }]).map((s) => s.name),
    ['tamper', 'e2e:AC3', 'acceptance:AC2', 'acceptance:AC1', 'coverage'],
  );
  assert.equal(STEP_ORDER[0], 'tamper');
  const acc = { name: 'acceptance:AC1', group: 'tests', design: 5 };
  assert.ok(selects('acceptance', acc) && selects('tests', acc) && selects('5', acc) && selects('acceptance:AC1', acc));
  assert.ok(!selects('lint', acc));
});

test('verdict rules', () => {
  const s = (name: string, status: GateStep['status'], reasons?: string[]): GateStep => ({ name, status, durationMs: 1, reasons });
  assert.deepEqual(decideVerdict([s('a', 'pass'), s('b', 'skip', ['why']), s('c', 'cached')], {}), { verdict: 'PASS', reasons: [] });
  const f = decideVerdict([s('tamper', 'fail', ['x.test.js: test file deleted']), s('b', 'pass')], {});
  assert.equal(f.verdict, 'FAIL');
  assert.deepEqual(f.reasons, ['tamper: x.test.js: test file deleted']);
  const b = decideVerdict([s('tamper', 'pass')], { blocked: 'needs a schema decision' });
  assert.deepEqual(b, { verdict: 'BLOCKED', reasons: ['BLOCKED: needs a schema decision'] });
  const c = decideVerdict([s('a', 'pass')], { capped: true, cap: 8, capAt: '2026-10-19T10:00:00.000Z' });
  assert.equal(c.verdict, 'FAIL');
  assert.match(c.reasons[0], /attempt cap reached \(8\)/);
  assert.equal(decideVerdict([s('a', 'pass')], { capped: true, mode: 'ci' }).verdict, 'PASS', 'the cap belongs to agent task runs, not CI');
  assert.equal(decideVerdict([s('a', 'pass')], { treeChanged: ['dist/x.js'] }).verdict, 'FAIL');
});

test('cache: hit on the same inputs, miss when an input changes, hit for a step whose inputs did not change', async () => {
  const r = repo({ 'docs/readme.md': '# a\n' });
  const calls: Record<string, number> = { whole: 0, docs: 0 };
  const defs = (): StepDef[] => [
    { name: 'tamper', design: 1, group: 'tamper', cacheFail: false, inputs: (ctx) => [ctx.tree], run: () => (calls.whole++, { status: 'pass', reasons: [] }) },
    { name: 'secrets', design: 2, group: 'secrets', cacheFail: false, inputs: (ctx) => [entriesDigest(ctx.entries, (p) => p.startsWith('docs/'))], run: () => (calls.docs++, { status: 'pass', reasons: [] }) },
  ];
  await runGate({ repo: r, task: 'cache-t', stepDefs: defs });
  let ev = readEvidence(r, 'cache-t');
  assert.deepEqual(ev.steps.map((s) => s.cache), ['miss', 'miss']);
  await runGate({ repo: r, task: 'cache-t', stepDefs: defs });
  ev = readEvidence(r, 'cache-t');
  assert.deepEqual(ev.steps.map((s) => `${s.status}/${s.cache}`), ['cached/hit', 'cached/hit']);
  assert.deepEqual(calls, { whole: 1, docs: 1 });
  put(r, 'src/add.js', 'exports.add = (a, b) => b + a;\n');
  await runGate({ repo: r, task: 'cache-t', stepDefs: defs });
  ev = readEvidence(r, 'cache-t');
  assert.deepEqual(ev.steps.map((s) => s.cache), ['miss', 'hit'], 'a source change invalidates only the whole-tree step');
  assert.deepEqual(calls, { whole: 2, docs: 1 });
  // A failing result of a non-deterministic step is not reused.
  const failing = (): StepDef[] => [{ name: 'tests:base', design: 5, group: 'tests', cacheFail: false, inputs: (ctx) => [ctx.tree], run: () => (calls.whole++, { status: 'fail', reasons: ['boom'] }) }];
  await runGate({ repo: r, task: 'cache-f', stepDefs: failing });
  await runGate({ repo: r, task: 'cache-f', stepDefs: failing });
  assert.equal(calls.whole, 4);
  assert.equal(readEvidence(r, 'cache-f').steps[0].cache, 'miss');
});

test('secret scan on a diff names the pattern and file, never the value; secret files and evidence are scanned too', () => {
  const r = repo();
  const token = 'ghp_' + 'A'.repeat(36);
  put(r, 'src/client.js', `const api = 'https://example.invalid';\nconst auth = '${token}';\n`);
  put(r, '.env', 'DB_PASSWORD=hunter22\n');
  put(r, '.env.example', 'DB_PASSWORD=\n');
  const ctx = buildContext({ repo: r, task: 'sec' });
  fs.mkdirSync(path.join(ctx.runDir, 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(ctx.runDir, 'e2e', 'AC1-http.json'), JSON.stringify({ id: 'AC1-http', headers: { Authorization: `Bearer ${'x'.repeat(30)}` } }));
  const out = runSecrets(ctx);
  assert.equal(out.status, 'fail');
  const text = out.reasons.join('\n');
  assert.match(text, /src\/client\.js:2: secret-shaped text \(github-token\) added/);
  assert.match(text, /^\.env: a secret or key file is part of the change/m);
  assert.doesNotMatch(text, /\.env\.example/);
  assert.match(text, /evidence e2e\/AC1-http\.json:1: secret-shaped text \(bearer\)/);
  assert.ok(!text.includes(token) && !text.includes('hunter22') && !text.includes('x'.repeat(30)), 'no secret value in the reasons');
});

test('hidden Unicode added by the change FAILs the secret step, and a hidden character in a reason cannot break the evidence write', async () => {
  const r = repo();
  put(r, 'src/add.js', `exports.add = (a, b) => a + b; // ok‮\n`);
  put(r, `src/zw​name.js`, 'module.exports = 1;\n');
  const out = runSecrets(buildContext({ repo: r }));
  assert.equal(out.status, 'fail');
  const text = out.reasons.join('\n');
  assert.match(text, /src\/add\.js:1: hidden Unicode added \(bidi\)/);
  assert.match(text, /src\/zwname\.js: the file name carries hidden Unicode characters/);
  const run1 = await runGate({ repo: r, task: 'hidden', stepDefs: () => [{ name: 'tamper', design: 1, group: 'tamper', cacheFail: false, inputs: () => null, run: () => ({ status: 'fail', reasons: [`quoted ​ text ‮ here`] }) }] });
  assert.equal(run1.evidence.verdict, 'FAIL');
  assert.equal(run1.evidence.reasons[0], 'tamper: quoted text here');
});

test('--blocked records BLOCKED with the reason (exit 4); --steps is partial and writes no evidence', async () => {
  const r = repo();
  const b = await capture(() => gateMain(['--repo', r, '--task', 'blk', '--blocked', 'the test database is down']));
  assert.equal(b.code, 4, b.stdout + b.stderr);
  const ev = readEvidence(r, 'blk');
  assert.equal(ev.verdict, 'BLOCKED');
  assert.equal(ev.reasons[0], 'BLOCKED: the test database is down');
  assert.deepEqual(ev.steps.map((s) => s.name), ['tamper', 'secrets']);
  assert.match(b.stdout, /Verdict: BLOCKED/);
  const usage = await capture(() => gateMain(['--repo', r, '--blocked']));
  assert.equal(usage.code, 2);

  const p = await capture(() => gateMain(['--repo', r, '--task', 'part', '--steps', 'tamper,secrets']));
  assert.equal(p.code, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /Partial run \(--steps tamper,secrets\)/);
  assert.ok(!fs.existsSync(path.join(runsDir(), repoIdFor(r), 'part', 'evidence.json')), 'a partial run writes no verdict');
  const bad = await capture(() => gateMain(['--repo', r, '--steps', 'nope']));
  assert.equal(bad.code, 2);
});

test('cap_reached set by the Stop hook: the gate still runs but refuses PASS and keeps the marker', async () => {
  const r = repo();
  const first = await runGate({ repo: r, task: 'capped', stepDefs: () => [{ name: 'tamper', design: 1, group: 'tamper', cacheFail: false, inputs: () => null, run: () => ({ status: 'pass', reasons: [] }) }] });
  assert.equal(first.evidence.verdict, 'PASS');
  const p = first.evidencePath!;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as EvidenceFile;
  raw.cap_reached = true;
  raw.cap_reached_at = '2026-10-19T10:00:00.000Z';
  fs.writeFileSync(p, JSON.stringify(raw));
  const second = await runGate({ repo: r, task: 'capped', stepDefs: () => [{ name: 'tamper', design: 1, group: 'tamper', cacheFail: false, inputs: () => null, run: () => ({ status: 'pass', reasons: [] }) }] });
  assert.equal(second.exitCode, 1);
  assert.equal(second.evidence.verdict, 'FAIL');
  assert.equal(second.evidence.cap_reached, true);
  assert.equal(second.evidence.steps[0].status, 'pass', 'the steps still ran');
  assert.match(second.evidence.reasons[0], /attempt cap reached/);
  assert.match(second.report, /attempt cap was reached/);
  // cap.json (the gate never ran before the cap) works the same way.
  const r2 = repo();
  const dir = path.join(runsDir(), repoIdFor(r2), 'capjson');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cap.json'), JSON.stringify({ version: 1, cap_reached: true, cap_reached_at: '2026-10-19T10:00:00.000Z' }));
  const third = await runGate({ repo: r2, task: 'capjson', stepDefs: () => [] });
  assert.equal(third.evidence.verdict, 'FAIL');
  assert.equal(third.evidence.cap_reached, true);
});

test('the Stop hook reads the gate evidence: FAIL blocks with the gate reasons, PASS on the same tree lets the agent stop', async () => {
  const { evaluateStop } = await import('../../../src/hooks/evidence');
  const { recordEdit } = await import('../../../src/lib/session');
  const { setCurrentTask } = await import('../../../src/intake/brief');
  const r = repo();
  const repoId = repoIdFor(r);
  setCurrentTask(repoId, 'stop-t');
  const sid = `gate-stop-${n}`;
  put(r, 'src/add.js', 'exports.add = (a, b) => a - b;\n');
  recordEdit(sid, { path: path.join(r, 'src/add.js'), repo: repoId });
  const failed = await runGate({ repo: r });
  assert.equal(failed.evidence.verdict, 'FAIL');
  assert.equal(failed.evidence.task, 'stop-t');
  const blocked = evaluateStop({ session_id: sid }, { agent: 'claude', event: 'Stop', sessionId: sid }, { budgetMs: 10_000 });
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.message ?? '', /tests:base/);
  put(r, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
  const passed = await runGate({ repo: r });
  assert.equal(passed.evidence.verdict, 'PASS', passed.evidence.reasons.join('; '));
  const ok = evaluateStop({ session_id: sid }, { agent: 'claude', event: 'Stop', sessionId: sid }, { budgetMs: 10_000 });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.outcome, 'pass');
});

test('hook modes: pre-commit runs steps 1-4 on the staged tree and stops the commit on FAIL; pre-push runs everything', async () => {
  const r = repo();
  // Stage a test deletion, keep an unstaged edit in the working tree.
  git(r, ['rm', '-q', 'test/add.test.js']);
  put(r, 'src/add.js', 'exports.add = (a, b) => a + b + 0;\n');
  const pc = await capture(() => gateMain(['--repo', r, '--hook', 'pre-commit']));
  assert.equal(pc.code, 1, pc.stdout);
  const ev = readEvidence(r, 'hook-pre-commit');
  assert.equal(ev.verdict, 'FAIL');
  assert.deepEqual(ev.steps.map((s) => s.name), ['tamper', 'secrets', 'standards', 'lint', 'typecheck', 'build']);
  assert.equal(ev.treeHash, git(r, ['write-tree']).stdout.trim(), 'pre-commit checks the staged tree');
  assert.notEqual(ev.treeHash, workingTree(r));
  assert.match(ev.reasons[0], /tamper: test\/add\.test\.js: test file deleted/);
  assert.match(pc.stdout, /pre-commit hook mode/);

  // Restore, commit a clean change; pre-push runs every step against the parent commit.
  git(r, ['checkout', '-q', 'HEAD', '--', 'test/add.test.js']);
  commitAll(r, 'feat: tweak add');
  const pp = await capture(() => gateMain(['--repo', r, '--hook', 'pre-push']));
  assert.equal(pp.code, 0, pp.stdout);
  const ev2 = readEvidence(r, 'hook-pre-push');
  assert.equal(ev2.steps.length, 12);
  assert.equal(ev2.baseSha, git(r, ['rev-parse', 'HEAD^']).stdout.trim());
  const bad = await capture(() => gateMain(['--repo', r, '--hook', 'post-merge']));
  assert.equal(bad.code, 2);
});
