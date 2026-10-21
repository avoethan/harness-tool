import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLedger } from '../../../src/intake/ledger';
import { readRunState, runQueue } from '../../../src/runctl/run';
import { locateTask, pauseTask, resumeTask } from '../../../src/runctl/pause';
import { trailPath } from '../../../src/runctl/trail';
import { harnessWorktreePath } from '../../../src/land/gitops';
import { evidenceGate, git, put, scriptedCi, scriptedSession, sha } from '../land/helpers';
import { runnerRepo } from './helpers';

function cleanup(r: { home: { cleanup(): void } }): void {
  r.home.cleanup();
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
}

test('pause/resume: a session cut off early pauses (trail + wip commit); resume re-runs the gate first and lands on PASS without a new session', async () => {
  const r = runnerRepo('harness-pause-');
  try {
    // The session edits but is cut off (a usage limit): no cap, not ok.
    const s1 = scriptedSession((req) => put(req.cwd, 'src/a.js', 'exports.a = 42;\n'), { ok: false, detail: 'usage limit reached' });
    const g1 = evidenceGate();
    const rep = await runQueue({ repo: r.root, agent: 'claude', maxTasks: 5, ci: 'local' }, { session: s1, gate: g1, ci: scriptedCi(['green']), config: null });
    assert.equal(rep.tasks.length, 1, 'the run stops at the pause');
    assert.equal(rep.tasks[0].outcome, 'paused');
    assert.match(rep.stopped, /paused T-001/);
    assert.equal(g1.calls.length, 0);
    const wt = harnessWorktreePath(r.repoId, 'T-001');
    // The pause commit is on the task branch, never on main, and holds the edit.
    assert.equal(git(r.root, ['log', '-1', '--format=%s', 'task/T-001']).stdout.trim(), 'wip: pause');
    assert.equal(git(wt, ['status', '--porcelain']).stdout.trim(), '');
    assert.equal(sha(r.root, 'main'), r.main0);
    // The trail: open, names the next command, and says the verified state must be re-run.
    const trail = fs.readFileSync(trailPath('T-001'), 'utf8');
    assert.match(trail, /^status: open$/m);
    assert.match(trail, /harness run resume --task T-001/);
    assert.match(trail, /wip: pause commit [0-9a-f]+ on branch task\/T-001/);
    assert.match(trail, /src\/a\.js/);
    assert.match(trail, /usage limit reached/);
    assert.equal(readRunState(r.repoId, 'T-001')?.status, 'paused');
    assert.equal(readLedger(r.root).tasks.find((t) => t.id === 'T-001')!.status, 'claimed');

    // Resume: the gate runs first (nothing inherited is trusted), passes, and the task lands without a session.
    const s2 = scriptedSession();
    const g2 = evidenceGate();
    const lines: string[] = [];
    const res = await resumeTask({ repo: r.root, task: 'T-001', agent: 'claude', ci: 'local' }, { session: s2, gate: g2, ci: scriptedCi(['green']), config: null, say: (l) => lines.push(l) });
    assert.ok(res.ok, res.ok ? '' : res.error);
    if (!res.ok) return;
    assert.equal(res.run.outcome, 'landed', res.run.reason);
    assert.equal(g2.calls[0].repo, wt);
    assert.equal(g2.calls[0].task, 'T-001');
    assert.equal(g2.calls[0].steps, undefined, 'a full gate run');
    assert.equal(s2.calls.length, 0, 'no session needed: the gate passed');
    assert.ok(lines.some((l) => /\| status: open/.test(l)), 'the trail is shown');
    assert.equal(readLedger(r.root).tasks.find((t) => t.id === 'T-001')!.status, 'done');
    assert.match(fs.readFileSync(trailPath('T-001'), 'utf8'), /^status: closed$/m, 'landing closes the trail');
    assert.equal(fs.readFileSync(path.join(r.root, 'src/a.js'), 'utf8'), 'exports.a = 42;\n');
  } finally {
    cleanup(r);
  }
});

test('pause/resume: harness run pause on a worktree, then resume with a failing gate starts a session with the trail and the gate report', async () => {
  const r = runnerRepo('harness-pause2-');
  try {
    // Start the task without landing, so it stays claimed with a worktree.
    const s0 = scriptedSession((req) => put(req.cwd, 'src/a.js', 'exports.a = 4;\n'), { ok: false, detail: 'crash' });
    await runQueue({ repo: r.root, agent: 'codex', once: true, ci: 'none' }, { session: s0, gate: evidenceGate(), config: null });
    const wt = harnessWorktreePath(r.repoId, 'T-001');
    // More work after the automatic pause, then an explicit pause from inside the worktree.
    put(wt, 'src/a.js', 'exports.a = 41;\n');
    const loc = locateTask(wt);
    assert.ok(!('error' in loc));
    if ('error' in loc) return;
    assert.equal(loc.taskId, 'T-001');
    assert.equal(path.resolve(loc.worktree!), path.resolve(wt));
    const p = pauseTask({ mainRoot: loc.mainRoot, repoId: loc.repoId, taskId: loc.taskId, worktree: wt, branch: loc.branch, agent: 'codex', note: 'stopping for the night' });
    assert.equal(p.made, true);
    assert.equal(git(r.root, ['log', '-2', '--format=%s', 'task/T-001']).stdout.trim().split('\n').join('|'), 'wip: pause|wip: pause');
    assert.match(fs.readFileSync(p.trail, 'utf8'), /stopping for the night/);

    // Resume: the gate fails first, so a session starts with the trail and the gate report in its prompt.
    const s2 = scriptedSession((req) => {
      put(req.cwd, 'src/a.js', 'exports.a = 42;\n');
      git(req.cwd, ['add', '-A']);
      git(req.cwd, ['commit', '-q', '-m', 'feat: a is 42']);
    });
    const g2 = evidenceGate((call, n) => (n === 1 ? { exitCode: 1, verdict: 'FAIL', steps: [{ name: 'acceptance:AC1', status: 'fail' }], reasons: ['acceptance:AC1: expected 42'], report: 'FAIL acceptance:AC1 expected 42' } : undefined));
    const res = await resumeTask({ repo: wt, ci: 'none' }, { session: s2, gate: g2, config: null });
    assert.ok(res.ok, res.ok ? '' : res.error);
    if (!res.ok) return;
    assert.equal(res.run.outcome, 'landed', res.run.reason);
    assert.equal(s2.calls.length, 1);
    assert.equal(s2.calls[0].agent, 'codex', 'the agent comes from the run state');
    assert.equal(s2.calls[0].purpose, 'resume');
    assert.match(s2.calls[0].prompt, /An earlier session left this trail/);
    assert.match(s2.calls[0].prompt, /# harness trail: T-001/);
    assert.match(s2.calls[0].prompt, /FAIL acceptance:AC1 expected 42/);
    assert.equal(g2.calls.length, 2, 'gate before the session and after it');
  } finally {
    cleanup(r);
  }
});

test('resume: refuses without a trail', async () => {
  const r = runnerRepo('harness-pause3-');
  try {
    const res = await resumeTask({ repo: r.root, task: 'T-002', ci: 'none' }, { session: scriptedSession(), gate: evidenceGate(), config: null });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /no trail for T-002/);
  } finally {
    cleanup(r);
  }
});
