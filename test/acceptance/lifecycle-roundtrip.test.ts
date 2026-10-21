/**
 * Acceptance: the full lifecycle through the CLI in a temp HOME with a temp
 * git repository (personal setting): apply with the commit, doctor, undo with
 * the revert, uninstall. Skips with a reason when git is not available.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { sha256 } from '../../src/lib/hash';
import type { Plan } from '../../src/types';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');

function gitAvailable(): boolean {
  return !!which('git') && run('git', ['--version'], { timeoutMs: 5000 }).code === 0;
}

test('lifecycle round trip through the CLI (personal setting, apply commit and its revert)', async (t) => {
  if (!gitAvailable()) {
    t.skip('git is not available on PATH');
    return;
  }
  if (!fs.existsSync(CLI)) {
    t.skip(`not built: ${CLI} missing (run npm run build)`);
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acc-')));
  const home = path.join(root, 'home');
  const harnessHome = path.join(home, '.harness');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(harnessHome, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, HARNESS_HOME: harnessHome, HARNESS_USER_HOME: home, HARNESS_NO_INSTRUMENT: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const git = (args: string[]) => run('git', ['-c', 'user.name=harness-acc', '-c', 'user.email=acc@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, timeoutMs: 30000 });
  const harness = (args: string[]) => run(process.execPath, [CLI, ...args], { cwd: repo, env, timeoutMs: 60000 });
  try {
    assert.equal(git(['init', '-q', '-b', 'main']).code, 0);
    // the harness subprocess commits as the repository's configured user, as on a real machine
    git(['config', 'user.name', 'harness-acc']);
    git(['config', 'user.email', 'acc@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const original = '{\n  // team rules\n  "permissions": { "deny": ["Read(./.env)"] },\n}\n';
    fs.writeFileSync(settingsPath, original);
    git(['add', '-A']);
    assert.equal(git(['commit', '-q', '-m', 'init']).code, 0);
    const base = git(['rev-parse', 'HEAD']).stdout.trim();

    const agentsPath = path.join(repo, 'AGENTS.md');
    const plan: Plan = {
      id: 'acc-1',
      createdAt: new Date().toISOString(),
      setting: 'personal',
      agents: ['claude'],
      repoRoot: repo,
      targets: [
        { path: agentsPath, owner: 'generated', action: 'create', beforeSha: null, after: '# AGENTS\n\nRun `harness gate` before you say done.\n', hunks: [{ checkId: 'A1', reason: 'done-gate', provenance: 'design' }] },
        { path: settingsPath, owner: 'user', action: 'merge-json', beforeSha: sha256(original), after: JSON.stringify({ permissions: { deny: ['Bash(git push --force *)'] } }), hunks: [{ checkId: 'S1', reason: 'no force push', provenance: 'design' }] },
      ],
      notes: [],
      rejections: [],
    };
    const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    // dry run writes nothing
    const dry = harness(['apply', '--plan', planFile, '--dry-run', '--json']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);
    assert.equal(fs.existsSync(agentsPath), false);

    // without --yes and without a terminal: refused as usage
    const noYes = harness(['apply', '--plan', planFile]);
    assert.equal(noYes.code, 2);

    // apply with the commit
    const ap = harness(['apply', '--plan', planFile, '--commit', '--yes', '--json']);
    assert.equal(ap.code, 0, ap.stderr + ap.stdout);
    const applied = JSON.parse(ap.stdout);
    assert.equal(applied.ok, true);
    assert.equal(applied.written.length, 2);
    assert.ok(applied.commit);
    assert.equal(git(['log', '--format=%s', '-n1']).stdout.trim(), 'harness: apply acc-1');
    const committed = git(['show', '--name-only', '--format=', 'HEAD']).stdout.trim().split('\n').sort();
    assert.deepEqual(committed, ['.claude/settings.json', '.harness/manifest.json', 'AGENTS.md']);
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(merged.permissions.deny, ['Read(./.env)', 'Bash(git push --force *)']);
    assert.ok(fs.existsSync(path.join(harnessHome, 'integrity.json')));
    assert.ok(fs.existsSync(path.join(harnessHome, 'backups', 'acc-1')));

    // doctor runs and does not crash
    const doc = harness(['doctor', '--json']);
    assert.ok(doc.code === 0 || doc.code === 1, doc.stderr);
    const report = JSON.parse(doc.stdout);
    assert.ok(Array.isArray(report.checks) && report.checks.length > 5);

    // a second apply of the same plan is refused: the files changed since the plan
    const again = harness(['apply', '--plan', planFile, '--yes']);
    assert.equal(again.code, 4);
    assert.match(again.stdout, /refused/);

    // undo: the apply commit is reverted, files are back, history kept
    const un = harness(['undo', '--plan', 'acc-1', '--yes', '--json']);
    assert.equal(un.code, 0, un.stderr + un.stdout);
    const undone = JSON.parse(un.stdout);
    assert.ok(undone.reverted);
    assert.match(git(['log', '--format=%s', '-n1']).stdout.trim(), /^Revert "harness: apply acc-1"/);
    assert.equal(git(['merge-base', '--is-ancestor', applied.commit, 'HEAD']).code, 0, 'the apply commit is still in history');
    assert.equal(git(['merge-base', '--is-ancestor', base, 'HEAD']).code, 0);
    assert.equal(fs.existsSync(agentsPath), false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'settings back byte for byte, comments included');
    assert.equal(fs.existsSync(path.join(repo, '.harness')), false);
    assert.equal(git(['status', '--porcelain']).stdout.trim(), '');
    assert.ok(fs.existsSync(path.join(harnessHome, 'backups', 'acc-1')), 'backups kept');

    // uninstall when nothing is installed says so
    const uni = harness(['uninstall', '--repo', repo, '--yes']);
    assert.equal(uni.code, 0, uni.stderr);
    assert.match(uni.stdout, /Nothing installed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
