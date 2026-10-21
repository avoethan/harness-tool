import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { InstrumentationEvent } from '../../../src/types';
import { allowedPathsFor, capsFromConfig, checkStop, gateRuns, irreversibleWhat, repeatedFailures, sessionCaps } from '../../../src/runctl/caps';
import { capFromResult, committedClaudeAllowRules, parseClaudeResult, sessionCommand } from '../../../src/runctl/session';
import type { BriefFile } from '../../../src/intake/brief';
import { cleanupEnv, commitAll, landingFixture, put } from '../land/helpers';

test('caps: from the config, narrowed (never widened) by flags; a session gets what is left of the ticket', () => {
  const c = capsFromConfig({ caps: { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8, budgetUsd: 4 } });
  assert.deepEqual(c, { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8, budgetUsd: 4, codexAttempts: 3 });
  const lowered = capsFromConfig({ caps: { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8, budgetUsd: 4 } }, { turns: 10, budgetUsd: 0.5, unitMinutes: 99, codexAttempts: 2 });
  assert.equal(lowered.turns, 10);
  assert.equal(lowered.budgetUsd, 0.5);
  assert.equal(lowered.unitMinutes, 25, 'a flag cannot raise a cap');
  assert.equal(lowered.codexAttempts, 2);
  const noBudget = capsFromConfig(null);
  assert.equal(noBudget.budgetUsd, undefined);
  assert.equal(noBudget.turns, 80);
  assert.deepEqual(sessionCaps(lowered), { turns: 10, wallMinutes: 25, budgetUsd: 0.5 });
  assert.equal(sessionCaps(lowered, 7.5).wallMinutes, 7.5);
  assert.equal(sessionCaps(lowered, -3).wallMinutes, 0);
});

test('session: the exact claude and codex command shapes', () => {
  const caps = { turns: 12, wallMinutes: 5, budgetUsd: 0.25 };
  const c = sessionCommand({ agent: 'claude', cwd: '/w', prompt: 'do it', caps, model: 'haiku', purpose: 'task' });
  assert.equal(c.cmd, 'claude');
  assert.deepEqual(c.args, ['-p', 'do it', '--output-format', 'json', '--max-turns', '12', '--max-budget-usd', '0.25', '--model', 'haiku', '--permission-mode', 'acceptEdits']);
  const noBudget = sessionCommand({ agent: 'claude', cwd: '/w', prompt: 'x', caps: { turns: 3, wallMinutes: 1 }, permissionMode: 'default', purpose: 'fix' });
  assert.deepEqual(noBudget.args, ['-p', 'x', '--output-format', 'json', '--max-turns', '3', '--permission-mode', 'default']);
  assert.deepEqual(sessionCommand({ agent: 'codex', cwd: '/w', prompt: 'p', caps, purpose: 'task' }), { cmd: 'codex', args: ['exec', '--full-auto', 'p'] });
  assert.deepEqual(sessionCommand({ agent: 'codex', cwd: '/w', prompt: 'gate says', caps, resume: true, purpose: 'task' }), { cmd: 'codex', args: ['exec', 'resume', '--last', 'gate says'] });
  // allow rules go last (the flag takes every following argument)
  const allowed = sessionCommand({ agent: 'claude', cwd: '/w', prompt: 'x', caps: { turns: 3, wallMinutes: 1 }, purpose: 'task', allowedTools: ['Bash(harness gate *)', 'Bash(npm test)'] });
  assert.deepEqual(allowed.args.slice(-3), ['--allowedTools', 'Bash(harness gate *)', 'Bash(npm test)']);
});

test('session: the committed project allow rules (HEAD, not the working tree) become --allowedTools, since headless Claude ignores a project\'s allow rules in a folder it was never told to trust', () => {
  const fx = landingFixture('T-031', { prefix: 'harness-session-allow-' });
  try {
    assert.deepEqual(committedClaudeAllowRules(fx.root), [], 'no .claude/settings.json: none');
    put(fx.root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(harness gate *)', 'Bash(npx vitest run *)', 'Read(~/.harness/runs/**)', 42, ''], deny: ['Bash(git push --force *)'] } }));
    commitAll(fx.root, 'chore: settings');
    assert.deepEqual(committedClaudeAllowRules(fx.root), ['Bash(harness gate *)', 'Bash(npx vitest run *)', 'Read(~/.harness/runs/**)']);
    // a change in the working tree (by anyone) does not widen what the session gets
    put(fx.root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
    assert.deepEqual(committedClaudeAllowRules(fx.root), ['Bash(harness gate *)', 'Bash(npx vitest run *)', 'Read(~/.harness/runs/**)']);
  } finally {
    fx.home.cleanup();
    cleanupEnv();
  }
});

test('session: result parsing and cap detection', () => {
  const j = parseClaudeResult('noise\n{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":12,"total_cost_usd":0.031,"session_id":"s1"}\n');
  assert.equal(j?.subtype, 'error_max_turns');
  assert.equal(capFromResult({ timedOut: false, subtype: j?.subtype }, { turns: 12, wallMinutes: 5 }), 'turns');
  assert.equal(capFromResult({ timedOut: true }, { turns: 12, wallMinutes: 5 }), 'wall');
  assert.equal(capFromResult({ timedOut: false, subtype: 'error_max_budget_usd' }, { turns: 12, wallMinutes: 5 }), 'budget');
  assert.equal(capFromResult({ timedOut: false, subtype: 'success', costUsd: 0.3 }, { turns: 12, wallMinutes: 5, budgetUsd: 0.25 }), 'budget');
  assert.equal(capFromResult({ timedOut: false, subtype: 'success', costUsd: 0.1 }, { turns: 12, wallMinutes: 5, budgetUsd: 0.25 }), null);
  assert.equal(parseClaudeResult('not json'), null);
});

test('stop the line: a command a rail refuses, and rail denials already in the session', () => {
  const guard = (cmd: string) => (/push --force/.test(cmd) ? { decision: 'deny' as const, rail: 'git-history', reason: 'Force-pushing rewrites shared history.' } : { decision: 'allow' as const });
  const r = checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T-1', allowedPaths: [], command: 'git push --force origin main', guard, events: [] });
  assert.ok(r.some((x) => x.kind === 'rail' && /git-history rail/.test(x.reason)));
  assert.ok(r.some((x) => x.kind === 'irreversible'));
  assert.deepEqual(checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T-1', allowedPaths: [], command: 'npm test', guard, events: [] }), []);
  const events: InstrumentationEvent[] = [
    { ts: 't', event: 'guard.deny', sessionId: 's1', ids: { rail: 'test-db' } },
    { ts: 't', event: 'guard.deny', sessionId: 'other', ids: { rail: 'secrets' } },
  ];
  const d = checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T-1', allowedPaths: [], sessionId: 's1', events, guard });
  assert.equal(d.length, 1);
  assert.match(d[0].reason, /1 command\(s\) in this session were refused by a rail \(test-db\)/);
});

test('stop the line: the real guard refuses a force-push', () => {
  const fx = landingFixture('T-9', { prefix: 'harness-stop-' });
  try {
    const r = checkStop({ repoRoot: fx.wt, repoId: 'x', taskId: 'T-9', allowedPaths: [], command: 'git push --force origin main', events: [] });
    assert.ok(r.some((x) => x.kind === 'rail'), JSON.stringify(r));
  } finally {
    fx.home.cleanup();
    cleanupEnv();
  }
});

test('stop the line: irreversible commands and declared needs', () => {
  assert.match(irreversibleWhat('sqlcmd -Q "DROP TABLE dbo.items"') ?? '', /drops/);
  assert.match(irreversibleWhat('psql -c "delete from items;"') ?? '', /no WHERE/);
  assert.equal(irreversibleWhat('psql -c "delete from items where id = 3;"'), null);
  assert.match(irreversibleWhat('git branch -D old') ?? '', /deletes a branch/);
  assert.match(irreversibleWhat('npm publish') ?? '', /publishes/);
  assert.equal(irreversibleWhat('git push origin task/T-1'), null);
  const r = checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T', allowedPaths: [], irreversible: 'the migration drops a column on the shared database', events: [], guard: () => ({ decision: 'allow' }) });
  assert.equal(r[0].kind, 'irreversible');
  assert.match(r[0].reason, /drops a column/);
});

function gateEvents(repo: string, task: string, runs: Array<Array<[string, string, string]>>): InstrumentationEvent[] {
  const out: InstrumentationEvent[] = [];
  runs.forEach((steps, i) => {
    for (const [step, status, cache] of steps) out.push({ ts: 't', event: 'gate.step', repo, task, ids: { step, status, cache } });
    out.push({ ts: 't', event: 'gate.verdict', repo, task, ids: { verdict: steps.some((s) => s[1] === 'fail') ? 'FAIL' : 'PASS' }, counts: { attempt: i + 1 } });
  });
  return out;
}

test('stop the line: the same gate step failing 3 times after fixes (cached repeats and partial runs do not count)', () => {
  const ev = gateEvents('r', 'T', [
    [['lint', 'fail', 'miss'], ['tests:base', 'pass', 'miss']],
    [['lint', 'fail', 'miss'], ['tests:base', 'pass', 'hit']],
    [['lint', 'fail', 'hit'], ['tests:base', 'fail', 'miss']],
    [['lint', 'fail', 'miss'], ['tests:base', 'fail', 'miss']],
  ]);
  assert.deepEqual(repeatedFailures(gateRuns(ev, 'r', 'T')), [{ step: 'lint', times: 3 }]);
  const r = checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T', allowedPaths: [], events: ev, guard: () => ({ decision: 'allow' }) });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'repeated-failure');
  assert.match(r[0].reason, /gate step lint failed 3 times in a row after fixes/);
  // A pass in between resets the count; another task's runs never count.
  const reset = gateEvents('r', 'T', [[['lint', 'fail', 'miss']], [['lint', 'fail', 'miss']], [['lint', 'pass', 'miss']], [['lint', 'fail', 'miss']]]);
  assert.deepEqual(repeatedFailures(gateRuns(reset, 'r', 'T')), []);
  assert.deepEqual(repeatedFailures(gateRuns(ev, 'r', 'OTHER')), []);
});

function brief(over: Partial<BriefFile>): BriefFile {
  return { id: 'T', title: 'Add export', criteria: [], units: [], repos: [], baseShas: {}, criteriaMeta: {}, ...over } as unknown as BriefFile;
}

test('stop the line: a bug task whose reproduction check is green at the base commit', () => {
  const proof = { baseSha: 'a'.repeat(40), at: 't', result: 'green' as const, files: [], exitCode: 0 };
  const crit = [{ id: 'AC1', text: 'no crash', kind: 'unit' as const, check: { kind: 'unit' as const, description: 'd', redProof: proof } }];
  const g = () => ({ decision: 'allow' as const });
  const bug = checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T', allowedPaths: [], events: [], guard: g, brief: brief({ title: 'Fix crash when the list is empty', criteria: crit }) });
  assert.equal(bug[0]?.kind, 'not-reproducible');
  assert.match(bug[0].reason, /AC1's reproduction check passes at the base commit aaaaaaaaaa/);
  // A feature task with a green check is a wrong check (rewrite it), not a stop.
  assert.deepEqual(checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T', allowedPaths: [], events: [], guard: g, brief: brief({ title: 'Add CSV export', criteria: crit }) }), []);
  const declared = checkStop({ repoRoot: '/r', repoId: 'r', taskId: 'T', allowedPaths: [], events: [], guard: g, notReproduced: 'the 500 does not happen on the test database' });
  assert.equal(declared[0].kind, 'not-reproducible');
});

test('stop the line: scope grew beyond the units\' paths (test files and the ledger are not counted)', () => {
  const fx = landingFixture('T-5', { prefix: 'harness-scope-' });
  try {
    const g = () => ({ decision: 'allow' as const });
    // Committed on the branch: src/a.js (inside src). Now add files outside.
    put(fx.wt, 'docs/notes.md', 'changed\n');
    put(fx.wt, 'test/a.test.js', 'test\n');
    put(fx.wt, 'tasks/T-5-demo.md', 'edited\n');
    commitAll(fx.wt, 'more');
    put(fx.wt, 'README.md', '# changed, uncommitted\n');
    const r = checkStop({ repoRoot: fx.wt, repoId: 'x', taskId: 'T-5', base: fx.main0, allowedPaths: ['src'], events: [], guard: g });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'scope');
    assert.deepEqual([...(r[0].detail ?? [])].sort(), ['README.md', 'docs/notes.md']);
    assert.deepEqual(checkStop({ repoRoot: fx.wt, repoId: 'x', taskId: 'T-5', base: fx.main0, allowedPaths: [], events: [], guard: g }), [], 'no declared paths: the whole repository');
    assert.deepEqual(checkStop({ repoRoot: fx.wt, repoId: 'x', taskId: 'T-5', base: fx.main0, allowedPaths: ['src', 'docs', 'README.md'], events: [], guard: g }), []);
  } finally {
    fx.home.cleanup();
    cleanupEnv();
  }
});

test('allowedPathsFor: the task paths plus every unit path', () => {
  const b = brief({ units: [{ id: 'U1', title: 'u', repo: 'r', paths: ['src/export', 'src/lib'], dependsOn: [], criteria: [] }] });
  assert.deepEqual(allowedPathsFor(b, ['src/export', 'docs']).sort(), ['docs', 'src/export', 'src/lib']);
  assert.deepEqual(allowedPathsFor(null, []), []);
  assert.ok(path.isAbsolute('/x'));
});
