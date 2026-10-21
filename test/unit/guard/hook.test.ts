import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handle, buildGuardInput, protectedRootsFor } from '../../../src/hooks/PreToolUse';
import { packageRoot, harnessHome, agentHome, configPath, manifestPath } from '../../../src/lib/paths';
import { setPhase } from '../../../src/lib/session';
import { writeJson } from '../../../src/lib/fsx';
import { defaultConfig } from '../../../src/lib/config';
import { hashJson } from '../../../src/lib/hash';
import type { HookContext } from '../../../src/hook';

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ctx: HookContext = { agent: 'claude', event: 'PreToolUse', sessionId: 'hook-test-session' };

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hook-'));
  for (const k of ['HARNESS_HOME', 'HARNESS_USER_HOME', 'HARNESS_NO_INSTRUMENT', 'SQLCMDSERVER']) saved[k] = process.env[k];
  process.env.HARNESS_HOME = path.join(tmp, 'hh');
  process.env.HARNESS_USER_HOME = path.join(tmp, 'home');
  delete process.env.HARNESS_NO_INSTRUMENT;
  delete process.env.SQLCMDSERVER;
  fs.mkdirSync(path.join(tmp, 'repo', 'src'), { recursive: true });
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ session_id: ctx.sessionId, tool_name: 'Bash', tool_input: { command }, cwd: path.join(tmp, 'repo'), ...extra });

test('protected roots cover harness home, agent homes, skills, ~/.claude.json and the package', () => {
  const roots = protectedRootsFor(path.join(tmp, 'repo'));
  assert.ok(roots.includes(harnessHome()));
  assert.ok(roots.includes(agentHome('claude')));
  assert.ok(roots.includes(agentHome('codex')));
  assert.ok(roots.includes(agentHome('devin')));
  assert.ok(roots.includes(path.join(tmp, 'home', '.devin')));
  assert.ok(roots.includes(path.join(tmp, 'home', '.claude.json')));
  assert.ok(roots.includes(path.join(tmp, 'home', '.agents', 'skills')));
  assert.ok(roots.includes(packageRoot()));
  // working inside the harness checkout itself: the package root is not protected
  assert.ok(!protectedRootsFor(packageRoot()).includes(packageRoot()));
  assert.ok(!protectedRootsFor(path.join(packageRoot(), 'src')).includes(packageRoot()));
  assert.ok(protectedRootsFor(null).includes(packageRoot()));
});

test('buildGuardInput reads config, phase, manifest and repo state', () => {
  const input = buildGuardInput(bash('git status'), ctx);
  assert.equal(input.setting, 'team'); // default config
  assert.equal(input.agent, 'claude');
  assert.equal(input.toolName, 'Bash');
  assert.equal(input.cwd, path.join(tmp, 'repo'));
  assert.equal(input.phase, undefined);
  assert.deepEqual(input.harnessOwnedPaths, []);
  assert.equal(input.stagedFiles, undefined);
  assert.equal(input.repoRoot, null);
  // with a repo, a manifest and a phase
  const { rawGit } = require('../../../src/lib/git') as typeof import('../../../src/lib/git');
  const repo = path.join(tmp, 'repo');
  rawGit(repo, ['init', '-q']);
  rawGit(repo, ['config', 'user.email', 'builder@example.invalid']);
  rawGit(repo, ['config', 'user.name', 'builder']);
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
  rawGit(repo, ['add', 'src/a.ts']);
  rawGit(repo, ['commit', '-q', '-m', 'init']);
  writeJson(manifestPath(), { version: 1, harnessVersion: '0', files: [{ path: path.join(repo, 'AGENTS.md'), owner: 'generated', beforeSha: null, afterSha: 'x', backup: null }], settingsEdits: [] });
  setPhase(ctx.sessionId, 'implement');
  const i2 = buildGuardInput(bash('git add -A && git commit -m x'), ctx);
  assert.equal(i2.repoRoot, repo);
  assert.equal(i2.phase, 'implement');
  assert.deepEqual(i2.harnessOwnedPaths, [path.join(repo, 'AGENTS.md')]);
  assert.ok(i2.stagedFiles);
  assert.ok(i2.worktreeStatus);
  assert.ok(i2.trackedPathCheck);
  assert.equal(i2.trackedPathCheck!('src/a.ts'), true);
  assert.equal(i2.trackedPathCheck!('nope.ts'), false);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'y');
  const st = i2.worktreeStatus!();
  assert.deepEqual(st.untracked, ['AGENTS.md']);
  assert.deepEqual(st.modified, ['src/a.ts']);
  rawGit(repo, ['add', 'AGENTS.md']);
  assert.deepEqual(i2.stagedFiles!(), ['AGENTS.md']);
  const i3 = buildGuardInput(bash('ls'), ctx);
  assert.equal(i3.stagedFiles, undefined, 'git state is only read for add/commit');
  assert.ok(i2.realpath);
  assert.equal(i2.realpath!(path.join(repo, 'does', 'not', 'exist')), path.join(fs.realpathSync.native(repo), 'does', 'not', 'exist'));
});

test('handle(): deny is exit 2 with the reason; allow is exit 0; the log carries rail names only', async () => {
  const d = await handle(bash('git push --force'), ctx);
  assert.equal(d.exitCode, 2);
  assert.match(d.stderr ?? '', /force/i);
  const a = await handle(bash('git status'), ctx);
  assert.equal(a.exitCode, 0);
  assert.equal(a.stderr, undefined);
  const s = await handle(bash('sqlcmd -S anyserver -Q "select 1"'), ctx);
  assert.equal(s.exitCode, 2);
  assert.match(s.stderr ?? '', /harness db mark/);
  const e = await handle({ session_id: ctx.sessionId, tool_name: 'Edit', tool_input: { file_path: path.join(agentHome('claude'), 'settings.json'), old_string: 'a', new_string: 'b' } }, ctx);
  assert.equal(e.exitCode, 2);
  const h = await handle({ session_id: ctx.sessionId, tool_name: 'Write', tool_input: { file_path: path.join(harnessHome(), 'config.json'), content: '{}' } }, ctx);
  assert.equal(h.exitCode, 2);
  const t = await handle({ session_id: ctx.sessionId, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'repo', 'src', 'a.test.ts') }, cwd: path.join(tmp, 'repo') }, ctx);
  assert.equal(t.exitCode, 2, 'implement phase set earlier');
  setPhase(ctx.sessionId, 'tests');
  const t2 = await handle({ session_id: ctx.sessionId, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'repo', 'src', 'a.test.ts') }, cwd: path.join(tmp, 'repo') }, ctx);
  assert.equal(t2.exitCode, 0);
  // staging check through the real git callbacks (AGENTS.md was staged above; team setting by default)
  const c = await handle(bash('git commit -m x'), ctx);
  assert.equal(c.exitCode, 2);
  assert.match(c.stderr ?? '', /AGENTS.md/);
  // Devin-style lowercase tool
  const dv = await handle({ session_id: ctx.sessionId, tool_name: 'exec', tool_input: { command: 'git push --force' } }, { ...ctx, agent: 'devin' });
  assert.equal(dv.exitCode, 2);
  // MCP
  const m = await handle({ session_id: ctx.sessionId, tool_name: 'mcp__anything__query', tool_input: { server: 'x' } }, ctx);
  assert.equal(m.exitCode, 2);
  // garbage input never throws
  const g = await handle({} as never, ctx);
  assert.equal(g.exitCode, 0);
  const g2 = await handle({ tool_name: 'Bash', tool_input: 'not an object' } as never, ctx);
  assert.equal(g2.exitCode, 0);
  const log = fs.readFileSync(path.join(harnessHome(), 'logs', 'events.jsonl'), 'utf8');
  assert.match(log, /guard\.deny/);
  assert.match(log, /guard\.allow/);
  assert.match(log, /"rail":"git-history"/);
  assert.doesNotMatch(log, /push --force/, 'no command text in the instrumentation log');
  assert.doesNotMatch(log, /anyserver/);
});

test('a personal config with a signed allowlist lets the DB command through', async () => {
  const cfg = defaultConfig({ setting: 'personal' });
  cfg.db = { allowlist: [{ server: 'sql-test', marked: 'test' }] };
  cfg.db.markedHash = hashJson(cfg.db.allowlist);
  writeJson(configPath(), cfg);
  const ok = await handle(bash('sqlcmd -S sql-test -Q "select 1"'), ctx);
  assert.equal(ok.exitCode, 0);
  const no = await handle(bash('sqlcmd -S other -Q "select 1"'), ctx);
  assert.equal(no.exitCode, 2);
  assert.match(no.stderr ?? '', /sql-test/);
  const push = await handle(bash('git push'), ctx);
  assert.equal(push.exitCode, 0, 'personal setting allows plain push');
  process.env.SQLCMDSERVER = 'sql-test';
  assert.equal((await handle(bash('sqlcmd -Q "select 1"'), ctx)).exitCode, 0);
  process.env.SQLCMDSERVER = 'other';
  assert.equal((await handle(bash('sqlcmd -Q "select 1"'), ctx)).exitCode, 2);
  delete process.env.SQLCMDSERVER;
});

test('handle() finishes quickly for ordinary commands', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) await handle(bash('npm test'), ctx);
  const ms = Date.now() - t0;
  process.stdout.write(`  50 handle() calls: ${ms} ms\n`);
  assert.ok(ms < 2000, `took ${ms} ms`);
});
