import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { land, planAfterMerge, MERGE_RERUN_STEPS, DOC_ONLY_STEPS } from '../../../src/land/land';
import { landingPath, type LandingRecord } from '../../../src/land/record';
import { acquireLandLock } from '../../../src/land/lock';
import { cliGate, inProcessGate } from '../../../src/land/gaterun';
import { claimTask, parseTask, readLedger } from '../../../src/intake/ledger';
import { runGate } from '../../../src/gate';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import { runQueue } from '../../../src/runctl/run';
import { writeBrief } from '../gate/helpers';
import { ciCommandArgv, fillCiCommand } from '../../../src/land/ci';
import { harnessWorktreePath } from '../../../src/land/gitops';
import { cleanupEnv, commitAll, git, landingFixture, ledgerTaskText, put, readJson, scriptedCi, scriptedGate, scriptedSession, sha, tree, writeEvidence, type Fixture } from './helpers';

function done(fx: Fixture): void {
  fx.home.cleanup();
  cleanupEnv();
}

function record(fx: Fixture): LandingRecord {
  return readJson<LandingRecord>(landingPath(fx.repoId, fx.taskId));
}

function parents(root: string, ref: string): string[] {
  return git(root, ['rev-list', '--parents', '-n', '1', ref]).stdout.trim().split(/\s+/).slice(1);
}

test('land: refuses without evidence, on FAIL, at the cap, and when the PASS is for another tree; main never moves', async () => {
  const fx = landingFixture();
  try {
    const gate = scriptedGate();
    const ci = scriptedCi(['green']);
    const opts = { repo: fx.root, task: fx.taskId, ci: 'local' as const };
    let r = await land(opts, { gate, ci });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /no gate evidence/);
    assert.equal(record(fx).landed, false);
    assert.equal(record(fx).outcome, 'refused');

    writeEvidence(fx, { verdict: 'FAIL', reasons: ['lint: 2 errors'] });
    r = await land(opts, { gate, ci });
    assert.match(r.message, /verdict for T-001 is FAIL/);

    writeEvidence(fx, { cap_reached: true });
    r = await land(opts, { gate, ci });
    assert.match(r.message, /cap/);

    writeEvidence(fx, { treeHash: tree(fx.root, fx.main0) });
    r = await land(opts, { gate, ci });
    assert.match(r.message, /the PASS is for tree .* but task\/T-001 is at tree/);

    // Uncommitted work after the PASS: refused (the PASS must be on the commit).
    writeEvidence(fx);
    put(fx.wt, 'src/b.js', 'exports.b = 3;\n');
    r = await land(opts, { gate, ci });
    assert.match(r.message, /uncommitted change/);
    fs.writeFileSync(path.join(fx.wt, 'src/b.js'), 'exports.b = 2;\n');

    assert.equal(sha(fx.root, 'main'), fx.main0, 'main never moved');
    assert.equal(ci.calls.length, 0, 'CI never ran');
    assert.equal(gate.calls.length, 0, 'nothing was re-gated');
  } finally {
    done(fx);
  }
});

test('land: fast-forwards main to a landing commit whose body is the write-up; CI green; push to the remote', async () => {
  const fx = landingFixture();
  try {
    // A bare remote, so the push is real (local, no network).
    const bare = path.join(fx.home.root, 'origin.git');
    git(fx.home.root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(fx.root, ['remote', 'add', 'origin', bare]);
    git(fx.root, ['push', '-q', 'origin', 'main']);
    writeBrief(fx.wt, fx.taskId, [{ id: 'AC1', text: 'a is 42', kind: 'unit' }]);
    writeEvidence(fx);
    const taskTip = sha(fx.wt, 'HEAD');
    // The claim, the way the runner leaves it: a local change to the task file in the main checkout.
    assert.equal(claimTask(fx.root, fx.taskId, 'tester').ok, true);
    assert.notEqual(git(fx.root, ['status', '--porcelain']).stdout.trim(), '');
    const ci = scriptedCi(['green']);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local' }, { gate: scriptedGate(), ci });
    assert.equal(r.exitCode, 0, r.message);
    const head = sha(fx.root, 'main');
    assert.notEqual(head, fx.main0);
    // Fast-forward: the old main and the agent's commit are ancestors; the landing commit's parent is the task tip.
    assert.equal(git(fx.root, ['merge-base', '--is-ancestor', fx.main0, head]).code, 0);
    assert.deepEqual(parents(fx.root, head), [taskTip]);
    // The landing commit changes one file: the task, now done, naming the commit that landed and the evidence.
    assert.deepEqual(git(fx.root, ['diff', '--name-only', taskTip, head]).stdout.trim().split('\n'), [fx.taskFile]);
    const committed = parseTask(git(fx.root, ['show', `${head}:${fx.taskFile}`]).stdout, fx.taskFile).task!;
    assert.equal(committed.status, 'done');
    assert.equal(committed.commit, taskTip);
    assert.match(committed.evidence ?? '', /^~\/\.harness\/runs\/.*\/T-001\/evidence\.json$/, 'home-relative, never the home folder');
    assert.equal(committed.claimed_at, undefined, 'claims stay local');
    assert.equal(committed.claimed_by, undefined);
    assert.equal(record(fx).ledger?.file, fx.taskFile);
    // The main checkout's claim gave way to the committed file: nothing is left uncommitted.
    assert.equal(git(fx.root, ['status', '--porcelain']).stdout.trim(), '');
    assert.equal(readLedger(fx.root).tasks.find((x) => x.id === fx.taskId)?.status, 'done');
    const msg = git(fx.root, ['log', '-1', '--format=%B', head]).stdout;
    assert.match(msg.split('\n')[0], /^T-001: Make a 42$/);
    assert.match(msg, /^# Test task$/m, 'the write-up (from the brief) is the body');
    assert.match(msg, /^## Why$/m);
    assert.match(msg, /Harness-Task: T-001/);
    // The main checkout was fast-forwarded (its file content is the task's).
    assert.equal(fs.readFileSync(path.join(fx.root, 'src/a.js'), 'utf8'), 'exports.a = 42;\n');
    // The task branch now points at the landed commit too.
    assert.equal(sha(fx.root, 'task/T-001'), head);
    // Pushed with a plain push.
    assert.equal(git(bare, ['rev-parse', 'main']).stdout.trim(), head);
    const rec = record(fx);
    assert.equal(rec.landed, true);
    assert.equal(rec.post_landing_red, false);
    assert.equal(rec.auto_fixed, false);
    assert.equal(rec.reverted, false);
    assert.equal(rec.revert_correct, null);
    assert.equal(rec.outcome, 'landed');
    assert.equal(rec.push?.ok, true);
    assert.deepEqual(rec.landedCommits?.sort(), [head, taskTip].sort());
    assert.equal(ci.calls.length, 1);
    assert.equal(ci.calls[0].base, fx.main0, 'CI diffs against main before the landing');
    assert.ok(rec.transitions.map((t) => t.state).join(',').includes('locked,committed,landed,pushed,ci,done'));
    assert.equal(fs.existsSync(path.join(fx.home.harnessHome, 'runs', fx.repoId, 'land.lock')), false, 'the lock is released');
  } finally {
    done(fx);
  }
});

test('land: --squash puts one commit with the whole change on top of main; the task branch is left as it was', async () => {
  const fx = landingFixture();
  try {
    put(fx.wt, 'src/b.js', 'exports.b = 43;\n');
    const tip = commitAll(fx.wt, 'feat: b too');
    writeEvidence(fx);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none', squash: true }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 0, r.message);
    const head = sha(fx.root, 'main');
    assert.deepEqual(parents(fx.root, head), [fx.main0]);
    assert.deepEqual(git(fx.root, ['diff', '--name-only', tip, head]).stdout.trim().split('\n'), [fx.taskFile], 'the task change plus the task file marked done');
    assert.equal(sha(fx.root, 'task/T-001'), tip);
    assert.equal(record(fx).landedCommits?.length, 1);
    assert.match(record(fx).transitions.find((t) => t.state === 'ci')?.note ?? '', /none/);
  } finally {
    done(fx);
  }
});

test('land: behind main merges main into the branch as a new commit (no rebase) and re-runs only the steps the merge invalidated', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const taskCommit = sha(fx.wt, 'HEAD');
    // main advances with a change to a file the task did not touch.
    put(fx.root, 'src/b.js', 'exports.b = 7;\n');
    const main1 = commitAll(fx.root, 'feat: b is 7');
    const gate = scriptedGate();
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none' }, { gate });
    assert.equal(r.exitCode, 0, r.message);
    const rec = record(fx);
    assert.ok(rec.merge);
    assert.equal(rec.merge!.mainSha, main1);
    assert.equal(rec.merge!.mode, 'partial');
    assert.equal(rec.merge!.behindBy, 1);
    assert.deepEqual(parents(fx.root, rec.merge!.mergeCommit), [taskCommit, main1], 'a merge commit: the task tip first, main second');
    // The gate was asked for exactly the invalidated steps, against the new main.
    assert.equal(gate.calls.length, 1);
    assert.deepEqual(gate.calls[0].steps, MERGE_RERUN_STEPS);
    assert.equal(gate.calls[0].base, main1);
    assert.equal(gate.calls[0].repo, fx.wt);
    // No history rewrite: the agent's commit is still in main's history, main1 too.
    const head = sha(fx.root, 'main');
    assert.equal(git(fx.root, ['merge-base', '--is-ancestor', taskCommit, head]).code, 0);
    assert.equal(git(fx.root, ['merge-base', '--is-ancestor', main1, head]).code, 0);
    assert.equal(fs.readFileSync(path.join(fx.root, 'src/b.js'), 'utf8'), 'exports.b = 7;\n');
    assert.equal(fs.readFileSync(path.join(fx.root, 'src/a.js'), 'utf8'), 'exports.a = 42;\n');
  } finally {
    done(fx);
  }
});

test('land: a merge that touches the task\'s own files re-runs the full gate; a failing re-run refuses and keeps the merge on the branch', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    // main changes a different line region of a file the task changed? Use another file the task also changes.
    put(fx.wt, 'docs/notes.md', 'notes\nmore from the task\n');
    commitAll(fx.wt, 'docs: task notes');
    writeEvidence(fx);
    put(fx.root, 'docs/notes.md', 'main notes\nnotes\n');
    commitAll(fx.root, 'docs: main notes');
    const gate = scriptedGate((call) => (call.steps ? undefined : { exitCode: 1, verdict: 'FAIL', steps: [{ name: 'tests:base', status: 'fail', reasons: ['1 failed'] }] }));
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none' }, { gate });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /after merging main into task\/T-001 .* the gate failed: tests:base failed/);
    assert.equal(gate.calls.length, 1);
    assert.equal(gate.calls[0].steps, undefined, 'full gate');
    const rec = record(fx);
    assert.equal(rec.merge?.mode, 'full');
    assert.deepEqual(rec.merge?.overlap, ['docs/notes.md']);
    assert.equal(rec.landed, false);
    // The merge commit stays on the branch (nothing is undone by rewriting).
    assert.equal(sha(fx.root, 'task/T-001'), rec.merge?.mergeCommit);
  } finally {
    done(fx);
  }
});

test('land: a conflicting main refuses, aborts the merge and leaves the branch as it was', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const tip = sha(fx.wt, 'HEAD');
    put(fx.root, 'src/a.js', 'exports.a = 5;\n');
    commitAll(fx.root, 'feat: a is 5');
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none' }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /conflicts with task\/T-001 in src\/a\.js/);
    assert.equal(sha(fx.root, 'task/T-001'), tip);
    assert.equal(fs.existsSync(path.join(fx.root, '.git', 'worktrees', 'T-001', 'MERGE_HEAD')), false);
    assert.equal(git(fx.wt, ['status', '--porcelain']).stdout.trim(), '');
  } finally {
    done(fx);
  }
});

test('planAfterMerge: docs only, untouched code, overlap and dependency changes', () => {
  assert.deepEqual(planAfterMerge(['README.md', 'docs/x.md'], ['src/a.js']).steps, DOC_ONLY_STEPS);
  assert.deepEqual(planAfterMerge(['src/b.js'], ['src/a.js']).steps, MERGE_RERUN_STEPS);
  assert.equal(planAfterMerge(['src/a.js'], ['src/a.js']).mode, 'full');
  assert.equal(planAfterMerge(['package-lock.json'], ['src/a.js']).mode, 'full');
  assert.equal(planAfterMerge(['tsconfig.build.json'], ['src/a.js']).mode, 'full');
});

test('land: --ci local green path with the real gate (task evidence, then the CI stand-in as a child process)', async () => {
  const fx = landingFixture();
  try {
    // Real evidence from the real gate on the committed tip.
    const g = await runGate({ repo: fx.wt, task: fx.taskId });
    assert.equal(g.evidence.verdict, 'PASS', g.report);
    // Things a CI machine never has must not reach the CI stand-in: an uncommitted .env in the
    // main checkout (the secrets step would fail it) and the main repo's current task with an
    // unproven acceptance check (the acceptance step would fail it).
    put(fx.root, '.env', 'X=1\n');
    writeBrief(fx.root, 'CUR-1', [{ id: 'AC1', text: 'never proven', kind: 'unit' }]);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local' }, { gate: inProcessGate(), ciGate: cliGate() });
    assert.equal(r.exitCode, 0, r.message);
    const rec = record(fx);
    assert.equal(rec.landed, true);
    assert.equal(rec.ciRuns.length, 1);
    assert.equal(rec.ciRuns[0].status, 'green', rec.ciRuns[0].detail);
    assert.ok(rec.ciRuns[0].evidencePath && fs.existsSync(rec.ciRuns[0].evidencePath), 'the CI evidence is kept with the landing');
    const ci = readJson<{ verdict: string; baseSha: string; treeHash: string }>(rec.ciRuns[0].evidencePath!);
    assert.equal(ci.verdict, 'PASS');
    assert.equal(ci.baseSha, fx.main0);
    assert.equal(ci.treeHash, tree(fx.root, rec.landedTip!), 'CI checked exactly the landed commit');
    assert.equal(fs.existsSync(harnessWorktreePath(fx.repoId, '_land')), false, 'the landing checkout is removed');
  } finally {
    done(fx);
  }
});

test('land: red CI, a green rerun: landed and recorded as a flake', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const session = scriptedSession();
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local' }, { gate: scriptedGate(), ci: scriptedCi(['red', 'green']), session });
    assert.equal(r.exitCode, 0);
    const rec = record(fx);
    assert.equal(rec.outcome, 'deflaked');
    assert.equal(rec.landed, true);
    assert.equal(rec.post_landing_red, true);
    assert.equal(rec.reverted, false);
    assert.deepEqual(rec.ciRuns.map((c) => `${c.kind}:${c.status}`), ['initial:red', 'rerun:green']);
    assert.equal(session.calls.length, 0, 'no fix attempt after a green rerun');
  } finally {
    done(fx);
  }
});

test('land: red CI, red rerun, a fix that passes the gate and CI: auto_fixed', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const session = scriptedSession((req) => {
      put(req.cwd, 'src/b.js', 'exports.b = 2; // fixed\n');
    });
    const gate = scriptedGate();
    const ci = scriptedCi(['red', 'red', 'green']);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'claude' }, { gate, ci, session });
    assert.equal(r.exitCode, 0, r.message);
    const rec = record(fx);
    assert.equal(rec.outcome, 'auto_fixed');
    assert.equal(rec.auto_fixed, true);
    assert.equal(rec.post_landing_red, true);
    assert.equal(rec.reverted, false);
    assert.equal(rec.fix?.ok, true);
    assert.equal(rec.fix?.commits.length, 1);
    assert.equal(sha(fx.root, 'main'), rec.fix?.commits[0]);
    assert.deepEqual(ci.calls.map((c) => c.kind), ['initial', 'rerun', 'after-fix']);
    // The fix session: a fresh headless session in its own worktree, with the caps and the failure as the prompt.
    assert.equal(session.calls.length, 1);
    const req = session.calls[0];
    assert.equal(req.purpose, 'fix');
    assert.equal(req.agent, 'claude');
    assert.match(req.prompt, /CI failed on main right after task T-001/);
    assert.match(req.prompt, /tests:base: test\/a\.test\.js failed/);
    assert.ok(req.caps.turns > 0 && req.caps.wallMinutes > 0);
    assert.notEqual(path.resolve(req.cwd), path.resolve(fx.wt));
    // The fix landed only through the same gate: a full gate on the fix worktree against the landed commit.
    const fixGate = gate.calls.find((c) => c.task === 'T-001-fix');
    assert.ok(fixGate);
    assert.equal(fixGate!.base, rec.landedTip);
    assert.equal(fixGate!.steps, undefined);
  } finally {
    done(fx);
  }
});

test('land: red CI, red rerun, a fix that fails the gate: one revert commit, revert_correct, the task re-queued', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    // Claim state in the main checkout's ledger, the way the runner leaves it.
    const session = scriptedSession((req) => put(req.cwd, 'src/b.js', 'broken\n'));
    const gate = scriptedGate((call) => (call.task === 'T-001-fix' ? { exitCode: 1, verdict: 'FAIL', steps: [{ name: 'tests:base', status: 'fail' }] } : undefined));
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'claude' }, { gate, ci: scriptedCi(['red', 'red']), session });
    assert.equal(r.exitCode, 1);
    const rec = record(fx);
    assert.equal(rec.outcome, 'reverted');
    assert.equal(rec.landed, true);
    assert.equal(rec.post_landing_red, true);
    assert.equal(rec.auto_fixed, false);
    assert.equal(rec.reverted, true);
    assert.equal(rec.revert_correct, true);
    assert.match(rec.fix?.reason ?? '', /did not pass the gate/);
    // Exactly one revert commit on top of the landed tip; main's tree is back at the old main.
    const head = sha(fx.root, 'main');
    assert.equal(rec.revert?.commit, head);
    assert.deepEqual(parents(fx.root, head), [rec.landedTip]);
    assert.equal(tree(fx.root, head), tree(fx.root, fx.main0));
    assert.deepEqual([...(rec.revert?.reverted ?? [])].sort(), [...(rec.landedCommits ?? [])].sort(), 'the revert names exactly the task commits');
    assert.match(git(fx.root, ['log', '-1', '--format=%s', head]).stdout, /^Revert "T-001: Make a 42"/);
    assert.match(git(fx.root, ['log', '-1', '--format=%B', head]).stdout, /Failure evidence: ~\/\.harness\/runs\/.*ci-2-rerun\.json/, 'home-relative in a commit that gets pushed');
    assert.equal(fs.readFileSync(path.join(fx.root, 'src/a.js'), 'utf8'), 'exports.a = 1;\n');
    // History kept: the landed commits are still ancestors of main.
    for (const c of rec.landedCommits ?? []) assert.equal(git(fx.root, ['merge-base', '--is-ancestor', c, head]).code, 0);
    // Re-queued: todo, priority kept, a note with the evidence.
    const t = readLedger(fx.root).tasks.find((x) => x.id === fx.taskId)!;
    assert.equal(t.status, 'todo');
    assert.equal(t.priority, 1);
    assert.match(t.reason ?? '', /^reverted .*CI failed on main/);
    assert.match(t.evidence ?? '', /ci-2-rerun\.json$/);
    assert.match(t.body, /re-queued/);
    assert.equal(rec.requeued, true);
    const states = rec.transitions.map((x) => x.state);
    for (const s of ['landed', 'post_landing_red', 'rerun', 'fix_started', 'fix_failed', 'reverted', 'requeued']) assert.ok(states.includes(s as never), `transition ${s}`);
  } finally {
    done(fx);
  }
});

test('land: a fix that lands but CI stays red: one revert of the task and fix commits together', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const session = scriptedSession((req) => put(req.cwd, 'src/b.js', 'exports.b = 20;\n'));
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'codex' }, { gate: scriptedGate(), ci: scriptedCi(['red', 'red', 'red']), session });
    assert.equal(r.exitCode, 1);
    const rec = record(fx);
    assert.equal(rec.reverted, true);
    assert.equal(rec.revert_correct, true);
    assert.equal(rec.fix?.commits.length, 1);
    const expected = [...(rec.landedCommits ?? []), ...(rec.fix?.commits ?? [])].sort();
    assert.deepEqual([...(rec.revert?.reverted ?? [])].sort(), expected);
    const head = sha(fx.root, 'main');
    assert.deepEqual(parents(fx.root, head), [rec.fix!.commits[0]], 'one revert commit on top of the fix');
    assert.equal(tree(fx.root, head), tree(fx.root, fx.main0));
    assert.equal(fs.readFileSync(path.join(fx.root, 'src/b.js'), 'utf8'), 'exports.b = 2;\n');
    assert.equal(session.calls[0].agent, 'codex');
  } finally {
    done(fx);
  }
});

test('land: wrong-revert guard: a foreign commit on main stops the automatic revert', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    // During the fix attempt someone else commits on main (outside the landing lock's control).
    const session = scriptedSession(() => {
      put(fx.root, 'README.md', '# demo, edited by someone else\n');
      commitAll(fx.root, 'docs: someone else');
    });
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'claude' }, { gate: scriptedGate(), ci: scriptedCi(['red', 'red']), session });
    assert.equal(r.exitCode, 1);
    const rec = record(fx);
    assert.equal(rec.reverted, false);
    assert.equal(rec.revert_correct, false);
    assert.equal(rec.revert?.commit, null);
    assert.match(rec.revert?.detail ?? '', /not this landing's/);
    assert.match(git(fx.root, ['log', '-1', '--format=%s', 'main']).stdout, /^docs: someone else/, 'nothing was reverted');
    assert.ok(rec.transitions.some((t) => t.state === 'revert_refused'));
    const t = readLedger(fx.root).tasks.find((x) => x.id === fx.taskId)!;
    assert.equal(t.status, 'done', 'the landing commit on main says done; nothing was reverted, so nothing was re-queued');
    assert.equal(t.reason, undefined);
  } finally {
    done(fx);
  }
});

test('land: no fixer available goes straight from the red rerun to the revert', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'none' }, { gate: scriptedGate(), ci: scriptedCi(['red', 'red']) });
    assert.equal(r.exitCode, 1);
    const rec = record(fx);
    assert.equal(rec.fix?.attempted, false);
    assert.match(rec.fix?.reason ?? '', /--fixer none/);
    assert.equal(rec.reverted, true);
    assert.equal(rec.revert_correct, true);
  } finally {
    done(fx);
  }
});

test('land: a second landing fails fast with --no-wait while the lock is held, and leaves the holder\'s record alone', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    const held = await acquireLandLock(fx.repoId, { task: 'OTHER' });
    assert.ok(held.ok);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none', wait: false }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /another landing holds the lock/);
    assert.equal(fs.existsSync(landingPath(fx.repoId, fx.taskId)), false);
    assert.equal(sha(fx.root, 'main'), fx.main0);
    if (held.ok) held.release();
  } finally {
    done(fx);
  }
});

test('land and run refuse in the team setting (exit 4): the harness never pushes there', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    saveConfig(defaultConfig({ setting: 'team', workspaceRoot: fx.home.workspace }));
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none' }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 4);
    assert.match(r.message, /team setting: the harness never lands, merges or pushes there/);
    assert.equal(sha(fx.root, 'main'), fx.main0);
    const q = await runQueue({ repo: fx.root, agent: 'claude', once: true, ci: 'none' }, { session: scriptedSession(), gate: scriptedGate(), config: null });
    assert.equal(q.exitCode, 4);
    assert.equal(readLedger(fx.root).tasks[0].status, 'todo', 'nothing claimed');
    // The repository's own personal overlay wins over a team machine config.
    put(fx.root, '.harness/config.json', JSON.stringify({ setting: 'personal' }));
    commitAll(fx.root, 'chore: personal overlay');
    const ok = await land({ repo: fx.root, task: fx.taskId, ci: 'none' }, { gate: scriptedGate() });
    assert.notEqual(ok.exitCode, 4);
  } finally {
    done(fx);
  }
});

test('land: --dry-run checks everything and changes nothing', async () => {
  const fx = landingFixture();
  try {
    writeEvidence(fx);
    put(fx.root, 'src/b.js', 'exports.b = 9;\n');
    const m1 = commitAll(fx.root, 'feat: b');
    const lines: string[] = [];
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none', dryRun: true }, { gate: scriptedGate(), say: (l) => lines.push(l) });
    assert.equal(r.exitCode, 0);
    assert.equal(r.record.outcome, 'dry-run');
    assert.equal(sha(fx.root, 'main'), m1);
    assert.equal(fs.existsSync(landingPath(fx.repoId, fx.taskId)), false);
    assert.ok(lines.some((l) => /is behind it/.test(l)));
  } finally {
    done(fx);
  }
});

test('land: the repository\'s pre-push hook checks exactly each pushed commit; the revert push skips it', async () => {
  const fx = landingFixture();
  try {
    const bare = path.join(fx.home.root, 'origin.git');
    git(fx.home.root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(fx.root, ['remote', 'add', 'origin', bare]);
    git(fx.root, ['push', '-q', 'origin', 'main']);
    // A pre-push hook that records the commit checked out where it runs.
    const log = path.join(fx.home.root, 'pre-push.log');
    const hook = path.join(fx.root, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, `#!/bin/sh\ngit rev-parse HEAD >> "${log}"\nexit 0\n`, { mode: 0o755 });
    writeEvidence(fx);
    const session = scriptedSession((req) => put(req.cwd, 'src/b.js', 'exports.b = 22;\n'));
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'claude' }, { gate: scriptedGate(), ci: scriptedCi(['red', 'red', 'red']), session });
    assert.equal(r.exitCode, 1);
    const rec = record(fx);
    assert.equal(rec.reverted, true);
    assert.equal(rec.revert?.pushed, true);
    const ran = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(ran, [rec.landedTip, rec.fix!.commits[0]], 'the hook ran for the landing and the fix, each on its own commit, not for the revert');
    assert.equal(git(bare, ['rev-parse', 'main']).stdout.trim(), rec.revert?.commit);
  } finally {
    done(fx);
  }
});

test('land: a rejected push (the remote moved) reports, keeps the local landing and never forces', async () => {
  const fx = landingFixture();
  try {
    const bare = path.join(fx.home.root, 'origin.git');
    git(fx.home.root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(fx.root, ['remote', 'add', 'origin', bare]);
    git(fx.root, ['push', '-q', 'origin', 'main']);
    // Someone pushes to the remote main from another clone.
    const other = path.join(fx.home.root, 'other');
    git(fx.home.root, ['clone', '-q', bare, other]);
    git(other, ['config', 'user.name', 'x']);
    git(other, ['config', 'user.email', 'x@example.invalid']);
    put(other, 'docs/other.md', 'other\n');
    commitAll(other, 'docs: other');
    git(other, ['push', '-q', 'origin', 'main']);
    const remoteHead = git(bare, ['rev-parse', 'main']).stdout.trim();
    writeEvidence(fx);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'none' }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /push failed.*never force/);
    const rec = record(fx);
    assert.equal(rec.landed, true);
    assert.equal(rec.push?.ok, false);
    assert.equal(git(bare, ['rev-parse', 'main']).stdout.trim(), remoteHead, 'the remote was not overwritten');
  } finally {
    done(fx);
  }
});

test('land: a task file the main checkout holds untracked (claimed, never committed) lands with the landing commit; the revert takes it off main and the task is re-queued locally', async () => {
  const fx = landingFixture('T-007', { prefix: 'harness-land-ledger-' });
  try {
    // A second task added after main0 and never committed (the way `harness task add` leaves it), then claimed.
    const rel = 'tasks/T-008-untracked.md';
    put(fx.root, rel, ledgerTaskText('T-008', 'Untracked task', { priority: 3 }));
    assert.equal(claimTask(fx.root, 'T-008', 'runner').ok, true);
    const wt = path.join(fx.home.root, 'wt', 'T-008');
    assert.equal(git(fx.root, ['worktree', 'add', '-q', '-b', 'task/T-008', wt, 'main']).code, 0);
    put(wt, 'src/b.js', 'exports.b = 8;\n');
    const taskTip = commitAll(wt, 'feat: b is 8');
    writeEvidence({ ...fx, taskId: 'T-008', wt });
    const r = await land({ repo: fx.root, task: 'T-008', ci: 'local', fixer: 'none' }, { gate: scriptedGate(), ci: scriptedCi(['red', 'red']) });
    assert.equal(r.exitCode, 1, r.message);
    const rec = readJson<LandingRecord>(landingPath(fx.repoId, 'T-008'));
    assert.equal(rec.landed, true);
    assert.equal(rec.reverted, true);
    assert.equal(rec.revert_correct, true, 'main is back at the old tree, task file included');
    assert.deepEqual(rec.ledger, { file: rel, commit: taskTip });
    // The landing commit added the task file as done; the revert took it off main again.
    const landed = parseTask(git(fx.root, ['show', `${rec.landedTip}:${rel}`]).stdout, rel).task!;
    assert.equal(landed.status, 'done');
    assert.equal(landed.commit, taskTip);
    assert.notEqual(git(fx.root, ['cat-file', '-e', `main:${rel}`]).code, 0, 'not on main after the revert');
    assert.equal(tree(fx.root, 'main'), tree(fx.root, fx.main0));
    // The task is not lost: re-queued in the main checkout, uncommitted, priority kept, with the note.
    const t = readLedger(fx.root).tasks.find((x) => x.id === 'T-008')!;
    assert.equal(t.status, 'todo');
    assert.equal(t.priority, 3);
    assert.equal(t.claimed_at, undefined);
    assert.match(t.reason ?? '', /^reverted .*CI failed on main/);
    assert.match(git(fx.root, ['status', '--porcelain', '--untracked-files=all']).stdout, /\?\? tasks\/T-008-untracked\.md/);
  } finally {
    done(fx);
  }
});

test('land --ci local with a CI command: runs it in the landing checkout at the landed commit (placeholders, CI=true), green on exit 0, red with its output as the failure text; the config key is read from main before the landing', async () => {
  const fx = landingFixture('T-009', { prefix: 'harness-land-cicmd-' });
  try {
    const script = path.join(fx.home.root, 'ci.js');
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs'); const path = require('path');",
        'const [checkout, sha, base, marker] = process.argv.slice(2);',
        "fs.appendFileSync(marker, JSON.stringify({ checkout, sha, base, cwd: process.cwd(), ci: process.env.CI, envSha: process.env.HARNESS_CI_SHA, a: fs.readFileSync(path.join(checkout, 'src/a.js'), 'utf8') }) + '\\n');",
        "const n = fs.readFileSync(marker, 'utf8').trim().split('\\n').length;",
        "if (n === 1) { console.log('step lint ok'); console.error('planted step: release policy says no'); process.exit(1); }",
        "console.log('all green');",
      ].join('\n'),
    );
    const marker = path.join(fx.home.root, 'ci-runs.jsonl');
    writeEvidence(fx);
    const r = await land({ repo: fx.root, task: fx.taskId, ci: 'local', fixer: 'none', ciCommand: [process.execPath, script, '{checkout}', '{sha}', '{base}', marker] }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 0, r.message);
    const rec = record(fx);
    assert.equal(rec.outcome, 'deflaked');
    assert.deepEqual(rec.ciRuns.map((c) => `${c.kind}:${c.status}`), ['initial:red', 'rerun:green']);
    assert.match(rec.ciRuns[0].detail, /exited 1 .*release policy says no/);
    const ev = readJson<{ kind: string; exitCode: number; log: string }>(rec.ciRuns[0].evidencePath!);
    assert.equal(ev.kind, 'command');
    assert.equal(ev.exitCode, 1);
    assert.match(ev.log, /planted step: release policy says no/);
    const runs = fs.readFileSync(marker, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, string>);
    assert.equal(runs.length, 2);
    for (const x of runs) {
      assert.equal(x.sha, rec.landedTip);
      assert.equal(x.envSha, rec.landedTip);
      assert.equal(x.base, fx.main0);
      assert.equal(x.ci, 'true');
      assert.equal(path.resolve(x.cwd), path.resolve(x.checkout));
      assert.match(x.checkout, /_land$/, 'the landing checkout, not the main checkout');
      assert.equal(x.a, 'exports.a = 42;\n', 'the landed tree');
    }
  } finally {
    done(fx);
  }
  // The config key: land.ciCommand in the repository's .harness/config.json on main.
  const fy = landingFixture('T-010', { prefix: 'harness-land-cicfg-', noTaskCommit: true });
  try {
    const marker = path.join(fy.home.root, 'cfg-ran.txt');
    const script = path.join(fy.home.root, 'ci.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(0);\n`);
    put(fy.root, '.harness/config.json', JSON.stringify({ version: 1, setting: 'personal', agents: ['claude'], land: { ciCommand: [process.execPath, script] } }));
    const main1 = commitAll(fy.root, 'chore: ci command');
    assert.equal(git(fy.wt, ['merge', '-q', '--ff-only', main1]).code, 0);
    put(fy.wt, 'src/a.js', 'exports.a = 10;\n');
    commitAll(fy.wt, 'feat: a is 10');
    writeEvidence(fy);
    const r = await land({ repo: fy.root, task: fy.taskId, ci: 'local', fixer: 'none' }, { gate: scriptedGate() });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
    assert.match(readJson<LandingRecord>(landingPath(fy.repoId, fy.taskId)).ciRuns[0].detail, /CI command passed/);
  } finally {
    done(fy);
  }
});

test('ciCommandArgv: argv arrays as they are; one command line split without a shell; shell features refused', () => {
  assert.deepEqual(ciCommandArgv(['node', 'ci.js', '{checkout}']), ['node', 'ci.js', '{checkout}']);
  assert.deepEqual(ciCommandArgv('node "my ci.js" ci {checkout} --base {base}'), ['node', 'my ci.js', 'ci', '{checkout}', '--base', '{base}']);
  for (const bad of ['npm run lint && npm test', 'node ci.js | tee log', 'node ci.js > out', 'node $(which ci)', 'FOO=1 node ci.js', '', '   ']) assert.equal(ciCommandArgv(bad), null, bad);
  assert.equal(ciCommandArgv([]), null);
  assert.deepEqual(fillCiCommand(['x', '{checkout}/a', '{sha}{base}'], { checkout: '/c', sha: 's', base: 'b' }), ['x', '/c/a', 'sb']);
});
