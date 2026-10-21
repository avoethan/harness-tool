import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoIdFor } from '../../../src/lib/config';
import { loadBrief, type BriefFile } from '../../../src/intake/brief';
import { readLedger } from '../../../src/intake/ledger';
import { bindBriefToWorktree, readRunState, runQueue } from '../../../src/runctl/run';
import { newRecord } from '../../../src/land/record';
import { harnessWorktreePath } from '../../../src/land/gitops';
import { harnessHome, subPath, worktreesHome } from '../../../src/lib/paths';
import { protectedRootsFor } from '../../../src/hooks/PreToolUse';
import { evaluate } from '../../../src/guard';
import type { SessionRequest } from '../../../src/runctl/session';
import { cleanupEnv, commitAll, evidenceGate, git, ledgerTaskText, put, scriptedCi, scriptedSession, sha } from '../land/helpers';
import { runnerRepo, type RunnerRepo } from './helpers';

function done(r: RunnerRepo): void {
  r.home.cleanup();
  cleanupEnv();
}

/** The scripted agent: makes the task's change and commits it. */
function doTheWork(req: SessionRequest): void {
  const file = /task T-002/.test(req.prompt) ? 'src/b.js' : 'src/a.js';
  put(req.cwd, file, file.endsWith('a.js') ? 'exports.a = 42;\n' : 'exports.b = 43;\n');
  commitAll(req.cwd, `feat: ${file}`);
}

test('run --once: next -> claim -> worktree task/<id> from main -> session with caps -> gate -> land -> done', async () => {
  const r = runnerRepo();
  try {
    const session = scriptedSession(doTheWork);
    const gate = evidenceGate();
    const ci = scriptedCi(['green']);
    const lines: string[] = [];
    const rep = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'local', model: 'haiku', caps: { turns: 5, unitMinutes: 3, budgetUsd: 0.2 } }, { session, gate, ci, config: null, say: (l) => lines.push(l) });
    assert.equal(rep.exitCode, 0, lines.join('\n'));
    assert.equal(rep.tasks.length, 1);
    assert.equal(rep.tasks[0].task, 'T-001', 'the most urgent task first');
    assert.equal(rep.tasks[0].outcome, 'landed');
    assert.equal(rep.stopped, 'one task done (--once)');
    // The session: fresh, headless, in the task worktree, with the caps and a prompt naming the task file and the task skill.
    assert.equal(session.calls.length, 1);
    const req = session.calls[0];
    const wt = harnessWorktreePath(r.repoId, 'T-001');
    assert.equal(path.resolve(req.cwd), path.resolve(wt));
    assert.equal(req.agent, 'claude');
    assert.equal(req.model, 'haiku');
    assert.deepEqual(req.caps, { turns: 5, wallMinutes: 3, budgetUsd: 0.2 });
    assert.match(req.prompt, /tasks\/T-001-a\.md/);
    // the task's own text travels in the prompt, fenced as data (a task file never committed is not in the worktree)
    assert.match(req.prompt, /```text\nT-001: Make a 42\n\nAcceptance:\n- a is 42\n\n# Make a 42\n```/);
    assert.match(req.prompt, /`task` skill/);
    assert.match(req.prompt, /branch task\/T-001/);
    assert.match(req.prompt, /never ask a question/);
    // The gate ran in the worktree for the task; land then moved main.
    assert.equal(gate.calls[0].repo, req.cwd);
    assert.equal(gate.calls[0].task, 'T-001');
    const head = sha(r.root, 'main');
    assert.notEqual(head, r.main0);
    assert.equal(fs.readFileSync(path.join(r.root, 'src/a.js'), 'utf8'), 'exports.a = 42;\n');
    // The ledger: T-001 done at the task's commit under the landing commit, and the landing commit
    // carries it (the main checkout has nothing uncommitted); T-002 untouched.
    const tasks = readLedger(r.root).tasks;
    const t1 = tasks.find((t) => t.id === 'T-001')!;
    assert.equal(t1.status, 'done');
    assert.equal(t1.commit, sha(r.root, 'main^'));
    assert.deepEqual(git(r.root, ['diff', '--name-only', 'main^', 'main']).stdout.trim().split('\n'), ['tasks/T-001-a.md']);
    assert.equal(git(r.root, ['status', '--porcelain']).stdout.trim(), '', 'no ledger change left uncommitted in the main checkout');
    assert.equal(tasks.find((t) => t.id === 'T-002')!.status, 'todo');
    // The brief was bound to the worktree (its repo id and its base commit).
    const b = loadBrief('T-001')!;
    assert.equal(b.baseShas[repoIdFor(wt)], r.main0);
    // The worktree is removed after landing; the branch stays.
    assert.equal(fs.existsSync(wt), false);
    assert.equal(git(r.root, ['rev-parse', '--verify', '--quiet', 'task/T-001']).code, 0);
    assert.equal(readRunState(r.repoId, 'T-001')?.status, 'landed');
  } finally {
    done(r);
  }
});

test('run: a cap hit fails the task with cap:<kind> and is never retried', async () => {
  const r = runnerRepo();
  try {
    const session = scriptedSession(undefined, { ok: false, capHit: 'turns', subtype: 'error_max_turns' });
    const gate = evidenceGate();
    const rep = await runQueue({ repo: r.root, agent: 'claude', maxTasks: 5, ci: 'none' }, { session, gate, config: null });
    assert.equal(rep.exitCode, 1);
    assert.deepEqual(rep.tasks.map((t) => `${t.task}:${t.outcome}:${t.reason}`), ['T-001:cap:cap:turns', 'T-002:cap:cap:turns']);
    assert.equal(session.calls.length, 2, 'one session per task, no retry');
    assert.equal(gate.calls.length, 0);
    for (const t of readLedger(r.root).tasks) {
      assert.equal(t.status, 'failed');
      assert.equal(t.reason, 'cap:turns');
    }
    assert.equal(sha(r.root, 'main'), r.main0);
  } finally {
    done(r);
  }
});

test('run: a landing whose push failed is reported as failed (not landed), exit 1, and the queue stops', async () => {
  const r = runnerRepo();
  try {
    const session = scriptedSession(doTheWork);
    const gate = evidenceGate();
    const calls: string[] = [];
    const land = async (o: { task?: string }) => {
      calls.push(o.task ?? '');
      const rec = { ...newRecord({ repo: r.repoId, task: o.task ?? '', branch: `task/${o.task}`, mainBranch: 'main', ci: 'local' as const, squash: false }), landed: true, outcome: 'failed' as const };
      return { exitCode: 1, record: rec, message: `${o.task} landed on the local main (abc) but the push failed: merge the remote main in (git pull --no-rebase) and push yourself; never force` };
    };
    const rep = await runQueue({ repo: r.root, agent: 'claude', maxTasks: 5, ci: 'local' }, { session, gate, land, config: null });
    assert.equal(rep.exitCode, 1);
    assert.deepEqual(rep.tasks.map((t) => `${t.task}:${t.outcome}`), ['T-001:failed']);
    assert.match(rep.tasks[0].reason, /^land: .*push failed/);
    assert.match(rep.stopped, /^stopped after T-001/);
    assert.deepEqual(calls, ['T-001'], 'T-002 is not started: its landing would push the same range');
    assert.equal(readRunState(r.repoId, 'T-001')?.status, 'failed');
  } finally {
    done(r);
  }
});

test('run: Codex re-prompts the same session with the gate output up to N attempts, then lands', async () => {
  const r = runnerRepo();
  try {
    const session = scriptedSession((req, n) => {
      if (n === 1) {
        put(req.cwd, 'src/a.js', 'exports.a = 42;\n');
        commitAll(req.cwd, 'feat: a');
      }
    });
    const gate = evidenceGate((call, n) => (n <= 2 ? { exitCode: 1, verdict: 'FAIL', steps: [{ name: 'lint', status: 'fail', reasons: ['src/a.js:1 eqeqeq'] }], reasons: ['lint: src/a.js:1 eqeqeq'], report: 'FAIL lint src/a.js:1 eqeqeq' } : undefined));
    const rep = await runQueue({ repo: r.root, agent: 'codex', once: true, ci: 'none', caps: { codexAttempts: 3 } }, { session, gate, config: null });
    assert.equal(rep.tasks[0].outcome, 'landed', rep.tasks[0].reason);
    assert.equal(session.calls.length, 3);
    assert.equal(session.calls[0].resume, undefined);
    assert.equal(session.calls[1].resume, true);
    assert.equal(session.calls[2].resume, true);
    assert.match(session.calls[1].prompt, /did not pass \(attempt 2 of 3\)/);
    assert.match(session.calls[1].prompt, /FAIL lint src\/a\.js:1 eqeqeq/);
  } finally {
    done(r);
  }
});

test('run: Codex out of attempts fails the task with the failing steps; Claude gets no driver retry', async () => {
  const r = runnerRepo();
  try {
    const fail = () => ({ exitCode: 1, verdict: 'FAIL' as const, steps: [{ name: 'tests:base', status: 'fail' as const }], reasons: ['tests:base: 1 failed'] });
    const s1 = scriptedSession();
    const rep = await runQueue({ repo: r.root, agent: 'codex', once: true, ci: 'none', caps: { codexAttempts: 2 } }, { session: s1, gate: evidenceGate(fail), config: null });
    assert.equal(rep.tasks[0].outcome, 'failed');
    assert.equal(rep.tasks[0].reason, 'gate FAIL: tests:base');
    assert.equal(s1.calls.length, 2);
    const s2 = scriptedSession();
    const rep2 = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'none' }, { session: s2, gate: evidenceGate(fail), config: null });
    assert.equal(rep2.tasks[0].task, 'T-002');
    assert.equal(s2.calls.length, 1);
    assert.equal(readLedger(r.root).tasks.find((t) => t.id === 'T-002')!.status, 'failed');
  } finally {
    done(r);
  }
});

test('run: a session that changes nothing fails the task instead of landing an empty change', async () => {
  const r = runnerRepo('harness-run-nochange-');
  try {
    const rep = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'none' }, { session: scriptedSession(), gate: evidenceGate(), config: null });
    assert.equal(rep.tasks[0].outcome, 'failed');
    assert.match(rep.tasks[0].reason, /^no change/);
    assert.equal(sha(r.root, 'main'), r.main0);
    assert.equal(readLedger(r.root).tasks.find((t) => t.id === 'T-001')!.status, 'failed');
  } finally {
    done(r);
  }
});

test('run: BLOCKED marks the task blocked with the reason', async () => {
  const r = runnerRepo();
  try {
    const gate = evidenceGate(() => ({ exitCode: 4, verdict: 'BLOCKED', reasons: ['BLOCKED: the ticket needs a schema decision'] }));
    const rep = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'none' }, { session: scriptedSession(), gate, config: null });
    assert.equal(rep.tasks[0].outcome, 'blocked');
    const t = readLedger(r.root).tasks.find((x) => x.id === 'T-001')!;
    assert.equal(t.status, 'blocked');
    assert.equal(t.reason, 'blocked: the ticket needs a schema decision');
  } finally {
    done(r);
  }
});

test('run: a stale claim is taken over and its branch reused', async () => {
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const r = runnerRepo('harness-run-stale-');
  try {
    put(r.root, 'tasks/T-001-a.md', ledgerTaskText('T-001', 'Make a 42', { priority: 1, paths: ['src/a.js'], status: 'claimed', claimed_at: old, claimed_by: 'gone' }));
    commitAll(r.root, 'chore: claimed long ago');
    git(r.root, ['branch', 'task/T-001', 'main']);
    const session = scriptedSession((req) => {
      put(req.cwd, 'src/a.js', 'exports.a = 42;\n');
      commitAll(req.cwd, 'feat: a');
    });
    const rep = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'none' }, { session, gate: evidenceGate(), config: null });
    assert.equal(rep.tasks[0].task, 'T-001');
    assert.equal(rep.tasks[0].outcome, 'landed', rep.tasks[0].reason);
    assert.equal(readLedger(r.root).tasks.find((t) => t.id === 'T-001')!.status, 'done');
  } finally {
    done(r);
  }
});

test('run: an empty queue stops at once; a missing agent stops before claiming', async () => {
  const r = runnerRepo('harness-run-empty-', {});
  try {
    const none = { available: () => ({ ok: false as const, reason: 'claude is not on PATH' }), run: async () => { throw new Error('never'); } };
    const rep0 = await runQueue({ repo: r.root, agent: 'claude', once: true, ci: 'none' }, { session: none, gate: evidenceGate(), config: null });
    assert.equal(rep0.exitCode, 1);
    assert.match(rep0.stopped, /not on PATH/);
    assert.equal(readLedger(r.root).tasks.every((t) => t.status === 'todo'), true, 'nothing claimed');
    put(r.root, 'tasks/T-001-a.md', ledgerTaskText('T-001', 'Make a 42', { status: 'done', commit: 'abcdef1' }));
    put(r.root, 'tasks/T-002-b.md', ledgerTaskText('T-002', 'Make b 43', { status: 'done', commit: 'abcdef1' }));
    const rep = await runQueue({ repo: r.root, agent: 'claude', ci: 'none' }, { session: scriptedSession(), gate: evidenceGate(), config: null });
    assert.equal(rep.exitCode, 0);
    assert.equal(rep.tasks.length, 0);
    assert.match(rep.stopped, /no task is ready/);
  } finally {
    done(r);
  }
});

test('bindBriefToWorktree: repo ids, units, meta and the base commit move to the worktree', () => {
  const b = {
    repos: ['main-1'],
    units: [{ id: 'U1', title: 'u', repo: 'main-1', paths: ['src'], dependsOn: [], criteria: ['AC1'] }],
    landingOrder: ['main-1'],
    criteriaMeta: { AC1: { repos: ['main-1'] } },
    repoMap: { ticket: ['main-1'], byCriterion: { AC1: ['main-1'] }, repos: { 'main-1': { name: 'repo', path: '/r' } } },
    baseShas: { 'main-1': 'old' },
  } as unknown as BriefFile;
  const out = bindBriefToWorktree(b, 'main-1', 'wt-2', 'base');
  assert.deepEqual(out.repos, ['wt-2']);
  assert.equal(out.units[0].repo, 'wt-2');
  assert.deepEqual(out.landingOrder, ['wt-2']);
  assert.deepEqual(out.criteriaMeta.AC1.repos, ['wt-2']);
  assert.deepEqual(out.repoMap.byCriterion.AC1, ['wt-2']);
  assert.ok(out.repoMap.repos['wt-2']);
  assert.deepEqual(out.baseShas, { 'wt-2': 'base' });
});

test('task worktrees live outside the protected harness home, so the installed guard lets the agent edit its task there and still denies the harness state', () => {
  const r = runnerRepo('harness-run-wt-');
  try {
    const wt = harnessWorktreePath(r.repoId, 'T-001');
    assert.ok(!subPath(harnessHome(), wt), `${wt} is inside ${harnessHome()}`);
    assert.equal(path.dirname(path.dirname(wt)), worktreesHome());
    const roots = protectedRootsFor(r.root);
    const decide = (toolName: string, toolInput: Record<string, unknown>) =>
      evaluate({ agent: 'claude', setting: 'personal', env: { HOME: r.home.userHome, HARNESS_HOME: harnessHome() }, config: { db: { allowlist: [] }, mcp: { allowedServers: {} } }, protectedRoots: roots, userHome: r.home.userHome, cwd: wt, repoRoot: wt, toolName, toolInput }).decision;
    assert.equal(decide('Write', { file_path: path.join(wt, 'src', 'format.ts'), content: 'export {};\n' }), 'allow');
    assert.equal(decide('Edit', { file_path: path.join(wt, 'src', 'a.js'), old_string: '1', new_string: '42' }), 'allow');
    assert.equal(decide('Bash', { command: 'git branch --show-current' }), 'allow');
    assert.equal(decide('Write', { file_path: path.join(harnessHome(), 'runs', 'x', 'evidence.json'), content: '{}' }), 'deny');
  } finally {
    done(r);
  }
});
