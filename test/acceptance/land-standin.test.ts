/**
 * Acceptance: `harness land` on a repository created from the personal
 * stand-in, with a planted post-landing failure.
 *
 *   HARNESS_STANDIN_PERSONAL   the stand-in folder (its setup.js creates the repository;
 *                              the test skips with a reason when it is unset)
 *   HARNESS_ACCEPTANCE_OUT     append one JSON line with the measured results
 *
 * setup.js runs with `--no-db --no-env --origin <temp bare repo>` and installs
 * the repository's dependencies (`npm ci`; skipped with a reason when that
 * fails). Nothing touches the network except that install; the push goes to
 * the local bare origin.
 *
 * The planted failure: a unit test committed on main that passes everywhere
 * except under CI (`CI=true`, which the local CI stand-in sets) once a given
 * file has landed; it then fails once (a flake) or always. Two tasks are
 * worked in worktrees the way the runner makes them (task/<id> from main,
 * node_modules linked), each gated with the real `harness gate`:
 *   T-101 lands, CI is red once and green on the rerun: landed, post-landing
 *         red, not reverted (a flake);
 *   T-102 was branched before T-101 landed, so land merges main into it and
 *         re-runs the invalidated gate steps; CI stays red, no fixer: one
 *         revert commit, revert_correct, the task re-queued.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { repoIdFor } from '../../src/lib/config';
import { ensureWorktree, harnessWorktreePath } from '../../src/land/gitops';
import type { LandingRecord } from '../../src/land/record';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');

const PROBE = `import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Planted post-landing failure (harness landing acceptance test): green everywhere
// except under CI once HARNESS_PROBE_FILE exists; then red once (HARNESS_PROBE_MARKER)
// or always (HARNESS_PROBE_ALWAYS=1).
describe('landing probe', () => {
  it('stays green outside CI', () => {
    const file = process.env.HARNESS_PROBE_FILE;
    const landed = file !== undefined && existsSync(file);
    let red = false;
    if (process.env.CI === 'true' && landed) {
      if (process.env.HARNESS_PROBE_ALWAYS === '1') {
        red = true;
      } else {
        const marker = process.env.HARNESS_PROBE_MARKER;
        if (marker !== undefined && !existsSync(marker)) {
          writeFileSync(marker, 'failed once\\n');
          red = true;
        }
      }
    }
    expect(red).toBe(false);
  });
});
`;

const SLUG = `/** Lower-case, dash-separated form of a name, for URLs and file names. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const CLAMP = `/** \`value\` limited to the range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
`;

function task(id: string, title: string, paths: string[]): string {
  return `---\nid: ${id}\ntitle: ${title}\npriority: 1\nstatus: todo\ndepends_on: []\npaths: ${JSON.stringify(paths)}\nacceptance: []\n---\n\n# ${title}\n`;
}

function git(dir: string, args: string[]): string {
  const r = run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, timeoutMs: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

test('land on the personal stand-in: a flaky post-landing failure is deflaked; a persistent one is reverted and re-queued', async (t) => {
  const standin = process.env.HARNESS_STANDIN_PERSONAL;
  if (!standin) return t.skip('HARNESS_STANDIN_PERSONAL is not set (path to the personal stand-in folder; see test/acceptance/README.md)');
  if (!fs.existsSync(path.join(standin, 'setup.js'))) return t.skip(`HARNESS_STANDIN_PERSONAL=${standin} has no setup.js`);
  if (!which('git')) return t.skip('git is not available on PATH');
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI} (run npm run build)`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acc-land-')));
  const saved = { HARNESS_HOME: process.env.HARNESS_HOME, HARNESS_USER_HOME: process.env.HARNESS_USER_HOME, HARNESS_NO_INSTRUMENT: process.env.HARNESS_NO_INSTRUMENT };
  try {
    const userHome = path.join(tmp, 'home');
    const home = path.join(userHome, '.harness');
    fs.mkdirSync(home, { recursive: true });
    const repo = path.join(tmp, 'repo');
    const bare = path.join(tmp, 'origin.git');
    const t0 = Date.now();
    const s = run(process.execPath, [path.join(standin, 'setup.js'), repo, '--no-db', '--no-env', '--origin', bare], { timeoutMs: 900_000, env: { ...process.env, HOME: tmp } });
    if (s.code !== 0 || !fs.existsSync(path.join(repo, 'node_modules'))) return t.skip(`setup.js could not create an installed repository (npm ci needs the registry or a cache): ${(s.stderr || s.stdout).trim().split('\n').slice(-2).join(' ')}`);
    const setupMs = Date.now() - t0;
    // This process uses the harness modules for the worktrees: point them at the temp home.
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_USER_HOME = userHome;
    process.env.HARNESS_NO_INSTRUMENT = '1';
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, HARNESS_HOME: home, HARNESS_USER_HOME: userHome, HARNESS_NO_INSTRUMENT: '1', GIT_TERMINAL_PROMPT: '0' };
    delete env.CI;
    const cli = (args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) => run(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, timeoutMs: 900_000 });

    // Plant the probe and two ledger tasks on main, and publish them.
    fs.writeFileSync(path.join(repo, 'test/unit/lib/landing-probe.test.ts'), PROBE);
    fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tasks/T-101-slug.md'), task('T-101', 'Add a slug helper', ['src/lib']));
    fs.writeFileSync(path.join(repo, 'tasks/T-102-clamp.md'), task('T-102', 'Add a clamp helper', ['src/lib']));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'test: add the landing probe and two tasks']);
    git(repo, ['push', '-q', 'origin', 'main']);
    const repoId = repoIdFor(repo);

    // Both tasks branch from this main, in worktrees the way the runner makes them.
    const work = (id: string, file: string, text: string, subject: string) => {
      const wt = harnessWorktreePath(repoId, id);
      const made = ensureWorktree(repo, wt, `task/${id}`, 'main');
      assert.ok(made.ok, JSON.stringify(made));
      fs.writeFileSync(path.join(wt, file), text);
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-q', '-m', subject]);
      return wt;
    };
    const wt1 = work('T-101', 'src/lib/slug.ts', SLUG, 'feat(lib): add a slug helper');
    const wt2 = work('T-102', 'src/lib/clamp.ts', CLAMP, 'feat(lib): add a clamp helper');
    const main0 = git(repo, ['rev-parse', 'main']);

    // The real gate on each committed tip, against main.
    const g1t = Date.now();
    const g1 = cli(['gate', '--task', 'T-101', '--base', main0], wt1);
    const gate1Ms = Date.now() - g1t;
    assert.equal(g1.code, 0, `gate T-101:\n${g1.stdout}\n${g1.stderr}`);
    const g2 = cli(['gate', '--task', 'T-102', '--base', main0], wt2);
    assert.equal(g2.code, 0, `gate T-102:\n${g2.stdout}\n${g2.stderr}`);

    // T-101: CI red once (the probe's marker), green on the rerun.
    const l1t = Date.now();
    const l1 = cli(['land', '--task', 'T-101', '--ci', 'local', '--json'], repo, { HARNESS_PROBE_FILE: 'src/lib/slug.ts', HARNESS_PROBE_MARKER: path.join(tmp, 'probe-once') });
    const land1Ms = Date.now() - l1t;
    const r1 = JSON.parse(l1.stdout) as { exitCode: number; message: string; landing: LandingRecord };
    assert.equal(l1.code, 0, `${r1.message}\n${l1.stderr}`);
    const rec1 = JSON.parse(fs.readFileSync(path.join(home, 'runs', repoId, 'T-101', 'landing.json'), 'utf8')) as LandingRecord;
    assert.equal(rec1.outcome, 'deflaked');
    assert.equal(rec1.landed, true);
    assert.equal(rec1.post_landing_red, true);
    assert.equal(rec1.auto_fixed, false);
    assert.equal(rec1.reverted, false);
    assert.equal(rec1.revert_correct, null);
    assert.deepEqual(rec1.ciRuns.map((c) => `${c.kind}:${c.status}`), ['initial:red', 'rerun:green']);
    // The red came from the planted probe alone: only the base tests failed in the CI gate.
    const failedIn = (p: string | undefined) => (JSON.parse(fs.readFileSync(p!, 'utf8')) as { steps: Array<{ name: string; status: string }> }).steps.filter((x) => x.status === 'fail').map((x) => x.name);
    assert.deepEqual(failedIn(rec1.ciRuns[0].evidencePath), ['tests:base']);
    assert.deepEqual(failedIn(rec1.ciRuns[1].evidencePath), []);
    assert.equal(git(bare, ['rev-parse', 'main']), rec1.landedTip, 'pushed to the origin');
    assert.match(git(repo, ['log', '-1', '--format=%s', 'main']), /T-101/);

    // T-102: behind main now, so land merges main in and re-runs the invalidated steps; CI stays red; no fixer: revert.
    const l2t = Date.now();
    const l2 = cli(['land', '--task', 'T-102', '--ci', 'local', '--fixer', 'none', '--json'], repo, { HARNESS_PROBE_FILE: 'src/lib/clamp.ts', HARNESS_PROBE_ALWAYS: '1' });
    const land2Ms = Date.now() - l2t;
    const r2 = JSON.parse(l2.stdout) as { exitCode: number; message: string; landing: LandingRecord };
    assert.equal(l2.code, 1, r2.message);
    const rec2 = JSON.parse(fs.readFileSync(path.join(home, 'runs', repoId, 'T-102', 'landing.json'), 'utf8')) as LandingRecord;
    assert.ok(rec2.merge, 'main was merged into the branch');
    assert.equal(rec2.merge!.mode, 'partial');
    assert.equal(rec2.merge!.ok, true);
    assert.ok(rec2.merge!.steps.some((x) => x.name === 'tests:base' && x.status !== 'fail'));
    assert.deepEqual(rec2.ciRuns.map((c) => `${c.kind}:${c.status}`), ['initial:red', 'rerun:red']);
    assert.deepEqual(failedIn(rec2.ciRuns[1].evidencePath), ['tests:base']);
    assert.equal(rec2.outcome, 'reverted');
    assert.equal(rec2.landed, true);
    assert.equal(rec2.post_landing_red, true);
    assert.equal(rec2.auto_fixed, false);
    assert.equal(rec2.reverted, true);
    assert.equal(rec2.revert_correct, true);
    const head = git(repo, ['rev-parse', 'main']);
    assert.equal(rec2.revert?.commit, head);
    assert.equal(git(repo, ['rev-parse', 'main^{tree}']), git(repo, [`rev-parse`, `${rec1.landedTip}^{tree}`]), 'main is back at the tree T-101 left');
    assert.equal(git(bare, ['rev-parse', 'main']), head, 'the revert is pushed');
    assert.equal(fs.existsSync(path.join(repo, 'src/lib/clamp.ts')), false);
    assert.equal(fs.existsSync(path.join(repo, 'src/lib/slug.ts')), true);
    const ledger = fs.readFileSync(path.join(repo, 'tasks/T-102-clamp.md'), 'utf8');
    assert.match(ledger, /^status: todo$/m);
    assert.match(ledger, /^reason: ["']?reverted /m);
    assert.match(ledger, /^priority: 1$/m);

    const line = {
      kind: 'land-standin',
      setupMs,
      gateMs: gate1Ms,
      land1: { ms: land1Ms, outcome: rec1.outcome, landed: rec1.landed, post_landing_red: rec1.post_landing_red, auto_fixed: rec1.auto_fixed, reverted: rec1.reverted, revert_correct: rec1.revert_correct, ci: rec1.ciRuns.map((c) => `${c.kind}:${c.status}:${c.durationMs}ms`) },
      land2: { ms: land2Ms, outcome: rec2.outcome, landed: rec2.landed, post_landing_red: rec2.post_landing_red, auto_fixed: rec2.auto_fixed, reverted: rec2.reverted, revert_correct: rec2.revert_correct, merge: { mode: rec2.merge!.mode, steps: rec2.merge!.steps.length }, ci: rec2.ciRuns.map((c) => `${c.kind}:${c.status}:${c.durationMs}ms`) },
    };
    t.diagnostic(`land-acceptance ${JSON.stringify(line)}`);
    if (process.env.HARNESS_ACCEPTANCE_OUT) fs.appendFileSync(process.env.HARNESS_ACCEPTANCE_OUT, JSON.stringify(line) + '\n');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
