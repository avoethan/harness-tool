/**
 * `harness install --yes` end to end in a temp HOME and a temp personal repo
 * (discovery without running repo binaries; no network): what it writes,
 * that a second run is a no-op, that `harness undo` restores everything,
 * that installing again proposes the same files, and that `self-update`
 * replaces pristine files and keeps edited ones.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, gitRepo, git } from '../lifecycle/helpers';
import { parseDbTest } from '../../../src/commands/install';
import { run } from '../../../src/lib/exec';
import { loadConfig } from '../../../src/lib/config';
import { sha256 } from '../../../src/lib/hash';
import { loadManifest, manifestPathFor } from '../../../src/lifecycle/manifest';
import { writeJson } from '../../../src/lib/fsx';
import { ALWAYS_ON_MAX_BYTES } from '../../../src/render/model';

function personalRepo(root: string): string {
  return gitRepo(path.join(root, 'repo'), {
    'package.json': JSON.stringify({ name: 'tiny', scripts: { build: 'tsc', typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' } }, null, 2) + '\n',
    '.env.example': 'DB_SERVER=localhost\nDB_PORT=1433\nDB_NAME=app_test\n',
    'src/add.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'README.md': '# tiny\n',
  });
}

const CLI = path.resolve(__dirname, '..', '..', '..', 'src', 'cli.js');

/** Run the CLI as a child process (the test runner's own output stays untouched). */
function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  delete env.XDG_CONFIG_HOME;
  const r = run(process.execPath, [CLI, ...args], { cwd, env, timeoutMs: 120000 });
  return Promise.resolve({ code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr });
}

function planCount(stdout: string): number {
  const m = /Plan \S+ \(personal setting; agents [^)]*\): (\d+) file\(s\)/.exec(stdout);
  return m ? Number(m[1]) : -1;
}

test('parseDbTest keeps host,port together and validates', () => {
  assert.deepEqual(parseDbTest('localhost,1433'), { target: { server: 'localhost,1433', database: undefined, marked: 'test' } });
  assert.deepEqual(parseDbTest('db.local/app_test'), { target: { server: 'db.local', database: 'app_test', marked: 'test' } });
  assert.ok('error' in parseDbTest('Server=x;Password=y'));
});

test('install --yes (personal): writes the harness, a second run is a no-op, undo restores everything, install again proposes the same files', async () => {
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  const h = tempHome('harness-install-');
  try {
    const repo = personalRepo(h.root);
    const base = ['--setting', 'personal', '--workspace', repo, '--yes', '--no-exec'];
    // with --yes, discovered database servers must be answered with flags
    const refused = await cli(['install', ...base], repo);
    assert.equal(refused.code, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /--db-test/);

    const first = await cli(['install', ...base, '--db-test', 'localhost,1433'], repo);
    assert.equal(first.code, 0, first.stderr);
    const n1 = planCount(first.stdout);
    assert.ok(n1 > 10, `first plan has ${n1} files`);
    // what it wrote
    const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    assert.ok(Buffer.byteLength(agents) <= ALWAYS_ON_MAX_BYTES, `AGENTS.md is ${Buffer.byteLength(agents)} bytes`);
    assert.match(agents, /`task` skill/);
    assert.match(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
    for (const s of ['task', 'learn', 'setup']) {
      assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', s, 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(repo, '.agents', 'skills', s, 'SKILL.md')));
    }
    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    assert.match(settings.hooks.Stop[0].hooks[0].command, /^node "[^"\\]+\/dist\/src\/hook\.js" Stop --agent claude$/);
    assert.ok(settings.permissions.deny.includes('Bash(git push --force)'));
    assert.ok(fs.existsSync(path.join(repo, '.codex', 'hooks.json')));
    assert.ok(fs.existsSync(path.join(repo, '.codex', 'rules', 'harness.rules')));
    assert.match(fs.readFileSync(path.join(h.userHome, '.codex', 'config.toml'), 'utf8'), /trust_level = "trusted"/);
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    assert.match(fs.readFileSync(hook, 'utf8'), /gate --hook pre-commit \|\| exit 1/);
    if (process.platform !== 'win32') assert.ok(fs.statSync(hook).mode & 0o111, 'pre-commit is executable');
    assert.ok(fs.existsSync(path.join(repo, '.github', 'workflows', 'harness-gate.yml')));
    assert.ok(fs.existsSync(path.join(repo, 'tasks', 'README.md')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.harness', 'config.json'), 'utf8')), { version: 1, setting: 'personal', agents: ['claude', 'codex'] });
    const cfg = loadConfig()!;
    assert.deepEqual(cfg.db.allowlist, [{ server: 'localhost,1433', marked: 'test' }]);
    assert.ok(fs.existsSync(path.join(h.harnessHome, '.git')), '~/.harness is a git repository');
    assert.ok(fs.existsSync(path.join(h.harnessHome, 'integrity.json')));
    assert.match(first.stdout, /Next steps:/);
    assert.match(first.stdout, /Codex: start codex, run `\/hooks`/);

    // a second run proposes nothing
    const second = await cli(['install', ...base, '--db-test', 'localhost,1433'], repo);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Nothing to change/);

    // undo restores the repository and the user's home
    const u = await cli(['undo', '--yes'], repo);
    assert.equal(u.code, 0, u.stdout + u.stderr);
    assert.equal(git(repo, ['status', '--porcelain']).stdout.trim(), '', 'repository back to its committed state');
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')));
    assert.ok(!fs.existsSync(path.join(h.userHome, '.codex', 'config.toml')));

    // installing again proposes the same set of files
    const third = await cli(['install', ...base, '--db-test', 'localhost,1433'], repo);
    assert.equal(third.code, 0, third.stderr);
    assert.equal(planCount(third.stdout), n1);
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    h.cleanup();
  }
});

test('self-update replaces pristine generated files, keeps edited ones with a diff, and re-signs integrity', async () => {
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  const h = tempHome('harness-selfupdate-');
  try {
    const repo = personalRepo(h.root);
    const r = await cli(['install', '--setting', 'personal', '--workspace', repo, '--yes', '--no-exec', '--db-none'], repo);
    assert.equal(r.code, 0, r.stderr);
    const mp = manifestPathFor('personal', repo);
    const m = loadManifest(mp)!;
    // an older harness wrote the task skill (pristine relative to the manifest) ...
    const task = path.join(repo, '.claude', 'skills', 'task', 'SKILL.md');
    const old = '---\nname: task\ndescription: an older version of the task skill, still exactly as the harness wrote it.\n---\n\nold\n';
    fs.writeFileSync(task, old);
    m.files.find((f) => f.path === task)!.afterSha = sha256(old);
    writeJson(mp, m);
    // ... and the user edited the learn skill since
    const learn = path.join(repo, '.claude', 'skills', 'learn', 'SKILL.md');
    fs.appendFileSync(learn, '\nmy own note\n');
    const dry = await cli(['self-update', '--repo', repo, '--dry-run'], repo);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(fs.readFileSync(task, 'utf8'), old, 'dry run writes nothing');
    const res = await cli(['self-update', '--repo', repo, '--yes'], repo);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(fs.readFileSync(task, 'utf8'), /# Task: from ticket to proven change/);
    assert.match(fs.readFileSync(learn, 'utf8'), /my own note/);
    assert.match(res.stdout, /1 pristine file\(s\) to replace/);
    assert.match(res.stdout, /Edited since the harness wrote it \(kept\): .*learn/);
    const integrity = JSON.parse(fs.readFileSync(path.join(h.harnessHome, 'integrity.json'), 'utf8'));
    assert.ok(Object.keys(integrity.files).length > 0);
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    h.cleanup();
  }
});
