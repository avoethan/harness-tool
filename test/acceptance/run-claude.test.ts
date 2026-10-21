/**
 * Acceptance: a real, cheap `harness run --once --agent claude` on a trivial
 * task (fix a typo in README.md), with haiku and tight caps (8 turns, 4
 * minutes per unit, 6 per ticket, 0.25 USD). Skipped with the reason when
 * Claude Code is not on PATH or HARNESS_SKIP_CLAUDE=1.
 *
 * Isolation: a temp HOME seeded with the Claude login only (the behaviour
 * tests' runner), a temp HARNESS_HOME, a temp repository; the harness's own
 * bin folder first on PATH. The repository has no harness install (no hooks,
 * no skills): this checks the runner's mechanics with a real headless
 * session, not the agent's use of the skills.
 *
 * The outcome of a real model run is not fixed; the test asserts the
 * runner's bookkeeping for whatever happened (landed -> done and the fix on
 * main; a cap -> failed with cap:<kind>; anything else -> failed or blocked
 * with a reason) and prints the cost the agent reported.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/lib/exec';
import { repoIdFor } from '../../src/lib/config';
import { claudeAvailable, makeIsolatedHome } from '../behaviour/claude-runner';
import type { RunReport } from '../../src/runctl/run';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');
const BIN = path.resolve(__dirname, '..', '..', '..', 'bin');

function git(dir: string, args: string[]): string {
  const r = run('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, timeoutMs: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const TASK = `---
id: T-001
title: Fix the greeting typo in README.md
priority: 1
status: todo
depends_on: []
paths: ["README.md"]
acceptance: ["README.md says Hello from the greeter."]
---

# Fix the greeting typo in README.md

README.md says "Helo from the greeter." It must say "Hello from the greeter."
Change only that line, then commit the change.
`;

test('harness run --once --agent claude with haiku and tight caps on a trivial task', async (t) => {
  const a = claudeAvailable();
  if (!a.ok) return t.skip(`Claude Code is not available: ${a.reason}`);
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI} (run npm run build)`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acc-run-')));
  const claudeHome = makeIsolatedHome();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Greeter\n\nHelo from the greeter.\n');
    fs.writeFileSync(path.join(repo, '.harness', 'config.json'), JSON.stringify({ setting: 'personal', agents: ['claude'] }, null, 2) + '\n');
    fs.writeFileSync(path.join(repo, 'tasks', 'T-001-greeting.md'), TASK);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'harness-test']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'docs: greeter readme and one task']);
    const main0 = git(repo, ['rev-parse', 'main']);
    const hh = path.join(tmp, 'harness-home');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: claudeHome,
      USERPROFILE: claudeHome,
      XDG_CONFIG_HOME: path.join(claudeHome, '.config'),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_TELEMETRY: '1',
      HARNESS_HOME: hh,
      HARNESS_USER_HOME: path.join(tmp, 'user-home'),
      PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_TERMINAL_PROMPT: '0',
    };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CI;
    const t0 = Date.now();
    const r = run(process.execPath, [CLI, 'run', '--once', '--agent', 'claude', '--model', 'haiku', '--turns', '8', '--unit-minutes', '4', '--ticket-minutes', '6', '--budget-usd', '0.25', '--ci', 'local', '--repo', repo, '--json'], { cwd: repo, env, timeoutMs: 10 * 60_000 });
    const wallMs = Date.now() - t0;
    let report: RunReport;
    try {
      report = JSON.parse(r.stdout) as RunReport;
    } catch {
      assert.fail(`harness run printed no JSON (exit ${r.code}): ${r.stderr.slice(-800)}`);
    }
    assert.equal(report.tasks.length, 1, report.stopped);
    const tr = report.tasks[0];
    const line = { kind: 'run-claude', model: 'haiku', outcome: tr.outcome, reason: tr.reason, sessions: tr.sessions, costUsd: tr.costUsd ?? null, taskMs: tr.durationMs, wallMs, exitCode: r.code };
    t.diagnostic(`run-claude-acceptance ${JSON.stringify(line)}`);
    if (process.env.HARNESS_ACCEPTANCE_OUT) fs.appendFileSync(process.env.HARNESS_ACCEPTANCE_OUT, JSON.stringify(line) + '\n');
    assert.equal(tr.task, 'T-001');
    assert.equal(tr.sessions, 1, 'one fresh headless session (Claude gets no driver retry)');
    assert.ok(tr.costUsd !== undefined, 'the agent reported a cost');
    const ledger = fs.readFileSync(path.join(repo, 'tasks', 'T-001-greeting.md'), 'utf8');
    if (tr.outcome === 'landed') {
      assert.equal(r.code, 0);
      assert.match(ledger, /^status: done$/m);
      assert.notEqual(git(repo, ['rev-parse', 'main']), main0);
      assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /Hello from the greeter\./);
      const landing = JSON.parse(fs.readFileSync(path.join(hh, 'runs', repoIdFor(repo), 'T-001', 'landing.json'), 'utf8')) as { landed: boolean; ciRuns: Array<{ status: string }> };
      assert.equal(landing.landed, true);
      assert.equal(landing.ciRuns[0]?.status, 'green');
    } else if (tr.outcome === 'cap') {
      assert.match(tr.reason, /^cap:(turns|wall|budget|ticket-wall|gate-attempts)$/);
      assert.match(ledger, /^status: failed$/m);
      assert.equal(git(repo, ['rev-parse', 'main']), main0);
    } else {
      assert.ok(['failed', 'blocked', 'paused'].includes(tr.outcome), tr.outcome);
      assert.ok(tr.reason.length > 0);
      assert.equal(git(repo, ['rev-parse', 'main']), main0, 'nothing landed');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});
