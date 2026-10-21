/**
 * Acceptance: the personal setting end to end on the personal stand-in.
 *
 *   1. the stand-in repository with its test database and a local bare origin (setup.js);
 *   2. `harness install --setting personal --yes --db-test localhost,1433 --commit` in an isolated
 *      HOME: the apply commit holds the in-repo files, the tree is clean, the stand-in's own format
 *      check passes, the planted AGENTS.md / CLAUDE.md defects got their changes, the git hooks are
 *      executable and fail closed, Codex's sandbox may write the harness folder; a commit that breaks
 *      a planted standard is refused by the pre-commit gate naming the rule, a clean one passes, and
 *      the first push after the install goes through the pre-push gate;
 *   5. `harness undo` reverts the apply commit with a new commit (history kept, tree clean, files as
 *      before the install), and a second install proposes the same plan;
 *   3. (HARNESS_RUN_CLAUDE=1) `harness task add` + `harness run --once` with Claude Code headless under
 *      tight caps (haiku, 60 turns, 2 USD) and the stand-in's CI as the landing's CI command: whatever
 *      the model does, the runner and the landing must leave a consistent state.
 *
 * Needs HARNESS_STANDIN_PERSONAL (the stand-in folder) and Docker with the test SQL Server container
 * (MSSQL_CONTAINER, default harness-standin-mssql); skips with the reason otherwise. Everything runs in
 * a temporary folder with its own HOME and HARNESS_HOME (removed at the end unless HARNESS_ACCEPTANCE_KEEP=1);
 * the run's test database is dropped at the end.
 * Recorded runs: test/acceptance/INTEGRATION-PERSONAL.md.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, type ExecResult } from '../../src/lib/exec';
import { packageRoot } from '../../src/lib/paths';
import { claudeAvailable, makeIsolatedHome } from '../behaviour/claude-runner';

const STANDIN = process.env.HARNESS_STANDIN_PERSONAL ? path.resolve(process.env.HARNESS_STANDIN_PERSONAL) : '';
const CLI = path.join(packageRoot(), 'dist', 'src', 'cli.js');
const BIN = path.join(packageRoot(), 'bin');
const CONTAINER = process.env.MSSQL_CONTAINER || 'harness-standin-mssql';
const MODEL = process.env.HARNESS_CLAUDE_MODEL || 'haiku';

/** Files the apply commit must hold (the in-repo set of the personal setting for Claude and Codex). */
const APPLY_PATHS = [
  '.agents/skills/learn/SKILL.md',
  '.agents/skills/setup/SKILL.md',
  '.agents/skills/task/SKILL.md',
  '.claude/rules/standards.md',
  '.claude/settings.json',
  '.claude/skills/learn/SKILL.md',
  '.claude/skills/setup/SKILL.md',
  '.claude/skills/task/SKILL.md',
  '.codex/hooks.json',
  '.codex/rules/harness.rules',
  '.github/workflows/harness-gate.yml',
  '.gitignore',
  '.harness/config.json',
  '.harness/manifest.json',
  '.prettierignore',
  'AGENTS.md',
  'CLAUDE.md',
  'tasks/README.md',
];

function skipReason(): string | null {
  if (!STANDIN) return 'HARNESS_STANDIN_PERSONAL is not set (the personal stand-in folder with setup.js)';
  if (!fs.existsSync(path.join(STANDIN, 'setup.js'))) return `${STANDIN} has no setup.js`;
  if (!fs.existsSync(CLI)) return 'the harness is not built (npm run build)';
  const d = run('docker', ['ps', '--format', '{{.Names}}'], { timeoutMs: 20_000 });
  if (d.code !== 0) return `Docker is unreachable (${(d.stderr || 'docker ps failed').trim().split('\n')[0]})`;
  if (!d.stdout.split('\n').map((s) => s.trim()).includes(CONTAINER)) return `the test SQL Server container ${CONTAINER} is not running`;
  return null;
}

interface Ctx {
  root: string;
  home: string;
  repo: string;
  origin: string;
  db: string;
  env: NodeJS.ProcessEnv;
}

function envFor(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HARNESS_USER_HOME: home,
    HARNESS_HOME: path.join(home, '.harness'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_TELEMETRY: '1',
    PATH: BIN + path.delimiter + (process.env.PATH ?? ''),
  };
  // A user's terminal: no parent agent session, no test-runner context, no other harness home.
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'NODE_TEST_CONTEXT', 'HARNESS_NO_INSTRUMENT', 'GIT_CONFIG_GLOBAL']) delete env[k];
  return env;
}

function sh(c: Ctx, cmd: string, args: string[], cwd = c.repo, timeoutMs = 600_000): ExecResult {
  return run(cmd, args, { cwd, env: c.env, timeoutMs });
}
const harness = (c: Ctx, args: string[], timeoutMs = 600_000) => sh(c, process.execPath, [CLI, ...args], c.repo, timeoutMs);
const git = (c: Ctx, args: string[]) => sh(c, 'git', args);
const out = (r: ExecResult) => `${r.stdout}\n${r.stderr}`.trim();
const head = (c: Ctx, ref = 'HEAD') => git(c, ['rev-parse', ref]).stdout.trim();
const porcelain = (c: Ctx) => git(c, ['status', '--porcelain', '--untracked-files=all']).stdout.trim();

function planOf(c: Ctx, installOut: string): { id: string; targets: Record<string, string[]> } {
  const m = /harness undo --plan (\S+)/.exec(installOut);
  assert.ok(m, `the install names its plan: ${installOut.slice(-400)}`);
  const p = JSON.parse(fs.readFileSync(path.join(c.home, '.harness', 'plans', `${m![1]}.json`), 'utf8')) as { targets: Array<{ path: string; hunks: Array<{ checkId: string }> }> };
  const targets: Record<string, string[]> = {};
  for (const t of p.targets) targets[path.relative(c.root, t.path).split(path.sep).join('/')] = t.hunks.map((h) => h.checkId).sort();
  return { id: m![1], targets };
}

function dropDatabase(name: string): void {
  if (!/^test_[a-z0-9_]+$/.test(name)) return;
  const script = "const s = require(process.argv[1]); const t = s.detect(); if (t.mode !== 'none') s.runQuery(t, 'master', `IF DB_ID(N'${process.argv[2]}') IS NOT NULL BEGIN ALTER DATABASE [${process.argv[2]}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${process.argv[2]}]; END`);";
  run(process.execPath, ['-e', script, path.join(STANDIN, 'db', 'sqlcmd.js'), name], { timeoutMs: 120_000 });
}

test('integration (personal setting): stand-in, install with the apply commit, fail-closed hooks, pre-commit refusal, first push, undo and reinstall; the runner with Claude behind HARNESS_RUN_CLAUDE=1', async (t) => {
  const why = skipReason();
  if (why) {
    t.diagnostic(`skipped: ${why}`);
    t.skip(why);
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-int-personal-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const c: Ctx = { root, home, repo: path.join(root, 'pantry'), origin: path.join(root, 'origin.git'), db: `test_ipa_${process.pid}_${Date.now().toString(36)}`, env: envFor(home) };
  try {
    // ---- step 1: the stand-in with its database and a local bare origin --------------------------
    const t1 = Date.now();
    const setup = sh(c, process.execPath, [path.join(STANDIN, 'setup.js'), c.repo, '--origin', c.origin, '--db-name', c.db], STANDIN, 900_000);
    assert.equal(setup.code, 0, out(setup));
    assert.equal(git(c, ['rev-list', '--count', 'HEAD']).stdout.trim(), '25');
    assert.equal(sh(c, 'git', ['rev-parse', 'main'], c.origin).stdout.trim(), head(c), 'origin has main');
    const preInstall = head(c);
    const agentsBefore = git(c, ['show', `${preInstall}:AGENTS.md`]).stdout;
    t.diagnostic(`step 1: stand-in with database ${c.db} and origin in ${((Date.now() - t1) / 1000).toFixed(1)} s`);

    // ---- step 2: install with the apply commit ----------------------------------------------------
    const t2 = Date.now();
    const install = harness(c, ['install', '--setting', 'personal', '--workspace', c.repo, '--yes', '--db-test', 'localhost,1433', '--commit']);
    assert.equal(install.code, 0, out(install));
    const plan1 = planOf(c, install.stdout);
    const applySha = head(c);
    assert.notEqual(applySha, preInstall);
    assert.equal(git(c, ['rev-parse', 'HEAD^']).stdout.trim(), preInstall, 'one apply commit on top');
    assert.match(git(c, ['log', '-1', '--format=%s']).stdout.trim(), /^chore\(harness\): apply p-/, "the apply commit follows the stand-in's Conventional Commits standard");
    const committed = git(c, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(committed, APPLY_PATHS);
    assert.equal(porcelain(c), '', 'nothing left uncommitted');
    t.diagnostic(`step 2: install exit 0 in ${((Date.now() - t2) / 1000).toFixed(1)} s, plan ${plan1.id}, ${committed.length} paths in the apply commit`);
    // the planted defects got their changes (CLAUDE.md included)
    const agents = fs.readFileSync(path.join(c.repo, 'AGENTS.md'), 'utf8');
    const claudeMd = fs.readFileSync(path.join(c.repo, 'CLAUDE.md'), 'utf8');
    for (const [file, text] of [['AGENTS.md', agents], ['CLAUDE.md', claudeMd]] as const) {
      assert.ok(!text.includes('npm run check'), `${file}: stale command fixed`);
      assert.ok(!/double quotes/i.test(text), `${file}: the rule that contradicts Prettier moved out`);
      assert.ok(!/asyncHandler/.test(text.replace(/<!-- harness:begin[\s\S]*?<!-- harness:end -->/, '')), `${file}: the rule now enforced by a check moved out`);
    }
    assert.ok(!/without asking/i.test(agents), 'AGENTS.md: the autonomy grant is quarantined');
    assert.ok(agents.includes('src/routes/items.ts') && !agents.includes('src/handlers/items.ts'), 'AGENTS.md: stale path fixed');
    assert.match(claudeMd, /^<!-- harness:begin[^\n]*\n@AGENTS\.md\n/, 'CLAUDE.md imports AGENTS.md');
    // the stand-in's own CI format check passes on what the harness wrote
    const prettier = sh(c, path.join(c.repo, 'node_modules', '.bin', 'prettier'), ['--check', '.']);
    assert.equal(prettier.code, 0, out(prettier));
    // Codex's workspace-write sandbox may write the harness folder (the gate's evidence)
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.ok(toml.includes(`writable_roots = [${JSON.stringify(path.join(home, '.harness'))}]`), toml);
    // git hooks: executable, fail closed
    for (const hook of ['pre-commit', 'pre-push']) {
      const p = path.join(c.repo, '.git', 'hooks', hook);
      assert.ok(fs.existsSync(p), `${hook} exists`);
      assert.ok((fs.statSync(p).mode & 0o111) !== 0, `${hook} is executable`);
      const text = fs.readFileSync(p, 'utf8');
      assert.match(text, /gate --hook (pre-commit|pre-push) \|\| exit 1/);
      const broken = path.join(root, `${hook}-missing-cli`);
      fs.writeFileSync(broken, text.replace(/dist\/src\/cli\.js"/, 'dist/src/cli-missing.js"'), { mode: 0o755 });
      const r = sh(c, broken, []);
      assert.equal(r.code, 1, `${hook} with its CLI missing refuses: ${out(r)}`);
      assert.match(r.stderr, /is missing, so the gate cannot run/);
    }

    // ---- the pre-commit gate: a planted standard broken, then a clean change ------------------------
    const cfg = path.join(c.repo, 'src', 'config.ts');
    const original = fs.readFileSync(cfg, 'utf8');
    assert.ok(original.includes('raw === undefined'));
    fs.writeFileSync(cfg, original.replace('raw === undefined', 'raw == undefined'));
    assert.equal(git(c, ['add', 'src/config.ts']).code, 0);
    const bad = git(c, ['commit', '-m', 'fix: loose comparison']);
    assert.notEqual(bad.code, 0, 'the pre-commit gate refuses');
    assert.match(out(bad), /lint\.eqeqeq at src\/config\.ts:\d+/, 'the refusal names the rule');
    assert.equal(head(c), applySha, 'no commit was made');
    assert.equal(git(c, ['checkout', 'HEAD', '--', 'src/config.ts']).code, 0);
    fs.writeFileSync(path.join(c.repo, 'README.md'), fs.readFileSync(path.join(c.repo, 'README.md'), 'utf8').replace(/\n*$/, '\n\nA note from the integration test.\n'));
    assert.equal(git(c, ['add', 'README.md']).code, 0);
    const good = git(c, ['commit', '-m', 'docs: integration test note']);
    assert.equal(good.code, 0, out(good));
    assert.match(out(good), /Verdict: PASS/);
    // the first push after the install goes through the pre-push gate (the apply commit is the harness's own)
    const push = git(c, ['push', 'origin', 'main']);
    assert.equal(push.code, 0, out(push));
    assert.equal(sh(c, 'git', ['rev-parse', 'main'], c.origin).stdout.trim(), head(c));
    t.diagnostic('step 2: pre-commit refused lint.eqeqeq, a clean commit passed, the first push passed the pre-push gate');

    // ---- step 5: undo reverts the apply commit; a second install proposes the same plan --------------
    const beforeUndo = head(c);
    const undo = harness(c, ['undo', '--plan', plan1.id, '--yes']);
    assert.equal(undo.code, 0, out(undo));
    assert.equal(git(c, ['rev-parse', 'HEAD^']).stdout.trim(), beforeUndo, 'one new commit on top');
    assert.equal(git(c, ['log', '-1', '--format=%s']).stdout.trim(), `revert: chore(harness): apply ${plan1.id}`, "the revert follows the stand-in's Conventional Commits standard too");
    assert.equal(git(c, ['merge-base', '--is-ancestor', applySha, 'HEAD']).code, 0, 'history kept: the apply commit is still an ancestor');
    assert.equal(porcelain(c), '', 'the working tree is clean after undo');
    assert.equal(fs.readFileSync(path.join(c.repo, 'AGENTS.md'), 'utf8'), agentsBefore, 'AGENTS.md as before the install');
    assert.ok(!fs.existsSync(path.join(c.repo, '.claude', 'settings.json')) && !fs.existsSync(path.join(c.repo, '.harness', 'manifest.json')), 'the harness files are gone');
    assert.ok(!fs.existsSync(path.join(c.repo, '.git', 'hooks', 'pre-commit')), 'the git hooks are gone');
    const reinstall = harness(c, ['install', '--setting', 'personal', '--workspace', c.repo, '--yes', '--db-test', 'localhost,1433', '--commit']);
    assert.equal(reinstall.code, 0, out(reinstall));
    const plan2 = planOf(c, reinstall.stdout);
    assert.deepEqual(plan2.targets, plan1.targets, 'the second install proposes the same files with the same changes');
    assert.equal(porcelain(c), '');
    t.diagnostic(`step 5: undo made a revert commit, tree clean; reinstall plan ${plan2.id} has the same ${Object.keys(plan2.targets).length} targets`);

    // ---- step 3 (HARNESS_RUN_CLAUDE=1): the runner with Claude Code headless ------------------------
    await t.test('step 3: harness run --once with Claude Code (HARNESS_RUN_CLAUDE=1)', { timeout: 45 * 60_000 }, (st) => {
      if (process.env.HARNESS_RUN_CLAUDE !== '1') {
        st.skip('HARNESS_RUN_CLAUDE is not 1 (this step spends money on a real model)');
        return;
      }
      const avail = claudeAvailable();
      if (!avail.ok) {
        st.skip(avail.reason);
        return;
      }
      // the only credential copied: the Claude login
      const loginHome = makeIsolatedHome();
      try {
        fs.copyFileSync(path.join(loginHome, '.claude.json'), path.join(home, '.claude.json'));
        const cred = path.join(loginHome, '.claude', '.credentials.json');
        if (fs.existsSync(cred)) fs.copyFileSync(cred, path.join(home, '.claude', '.credentials.json'));
      } finally {
        fs.rmSync(loginHome, { recursive: true, force: true });
      }
      const add = harness(c, ['task', 'add', '--title', 'Say how long ago something expired', '--priority', '1', '--acceptance', 'The attached describeExpiry cases pass (tomorrow; expired 1d ago and 12d ago; today and 5d unchanged)', '--acceptance', 'pantry list and pantry expiring use the new wording', '--acceptance', 'Items without an expiry date still show -', '--paths', 'src,test/unit']);
      assert.equal(add.code, 0, out(add));
      const file = path.join(c.repo, 'tasks', /tasks\/(T-001-[^\s]+\.md)/.exec(add.stdout)![1]);
      const ticket = fs.readFileSync(path.join(STANDIN, 'tasks', '07-expiry-wording', 'task.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n---\n[\s\S]*$/, '\n---\n') + ticket);
      const mainBefore = head(c);
      const ciCommand = `node ${path.join(STANDIN, 'tasks', 'post-landing.js')} ci {checkout} --state ${path.join(root, 'pantry.post-landing.json')} --harness ${CLI} --base {base}`;
      const t3 = Date.now();
      const r = harness(c, ['run', '--once', '--agent', 'claude', '--ci', 'local', '--model', MODEL, '--turns', '60', '--budget-usd', '2', '--ci-command', ciCommand], 40 * 60_000);
      st.diagnostic(`step 3: harness run exit ${r.code} in ${((Date.now() - t3) / 1000).toFixed(0)} s: ${r.stdout.trim().split('\n').slice(-2).join(' | ')}`);
      const runs = path.join(home, '.harness', 'runs');
      const repoRun = fs.readdirSync(runs).find((d) => fs.existsSync(path.join(runs, d, 'T-001', 'run.json')));
      assert.ok(repoRun, `run state for T-001: ${out(r)}`);
      const state = JSON.parse(fs.readFileSync(path.join(runs, repoRun!, 'T-001', 'run.json'), 'utf8')) as { status: string; branch: string };
      assert.equal(state.branch, 'task/T-001');
      assert.equal(git(c, ['rev-parse', '--verify', '--quiet', 'task/T-001']).code, 0, 'the task branch exists');
      const committedTask = (ref: string) => git(c, ['show', `${ref}:tasks/${path.basename(file)}`]);
      if (state.status === 'landed') {
        const landing = JSON.parse(fs.readFileSync(path.join(runs, repoRun!, 'T-001', 'landing.json'), 'utf8')) as { landed: boolean; post_landing_red: boolean; reverted: boolean; landedTip: string };
        assert.equal(landing.landed, true);
        assert.equal(landing.reverted, false);
        assert.match(committedTask('main').stdout, /^status: done$/m, 'the landing commit carries the task as done');
        assert.match(git(c, ['log', '-1', '--format=%B', 'main']).stdout, /Harness-Task: T-001/);
        assert.equal(git(c, ['status', '--porcelain', '--', 'tasks']).stdout.trim(), '', 'no ledger change left uncommitted');
        assert.equal(sh(c, 'git', ['rev-parse', 'main'], c.origin).stdout.trim(), head(c, 'main'), 'pushed');
      } else {
        assert.ok(['failed', 'blocked', 'reverted', 'paused'].includes(state.status), `status ${state.status}`);
        if (state.status !== 'reverted') assert.equal(head(c, 'main'), mainBefore, 'main did not move');
        const local = fs.readFileSync(file, 'utf8');
        assert.match(local, new RegExp(`^status: ${state.status === 'paused' ? 'claimed' : state.status === 'reverted' ? 'todo' : state.status}$`, 'm'));
      }
      st.diagnostic(`step 3: T-001 ${state.status}`);
    });
  } finally {
    dropDatabase(c.db);
    if (process.env.HARNESS_ACCEPTANCE_KEEP === '1') t.diagnostic(`kept ${root} (HARNESS_ACCEPTANCE_KEEP=1)`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
});
