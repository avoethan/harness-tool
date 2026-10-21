/**
 * Shared helpers for the safety suite (test/safety). Every test drives the
 * built artefacts as processes, the way an agent or the user does:
 *
 *   dist/src/hook.js <Event> --agent <agent>   with the agent's JSON on stdin
 *   dist/src/cli.js <command> ...              the user's (or the gate's) CLI
 *
 * in a temp HARNESS_HOME and a temp user home, never the real home. Payloads
 * are built per agent dialect:
 *
 *   claude  tool names Bash / Edit / Write / MultiEdit, `file_path`
 *   codex   tool names Bash / apply_patch (Codex hooks speak the Claude dialect)
 *   devin   lower-case tool names exec / edit / write, `path` or `file_path`
 *
 * Nothing here calls a guard or hook function in-process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/** dist/ of this build (this file runs as dist/test/safety/helpers.js). */
export const DIST = path.resolve(__dirname, '..', '..');
export const PKG_ROOT = path.resolve(DIST, '..');
export const HOOK_JS = path.join(DIST, 'src', 'hook.js');
export const CLI_JS = path.join(DIST, 'src', 'cli.js');

export type Dialect = 'claude' | 'codex' | 'devin';
export const DIALECTS: Dialect[] = ['claude', 'codex', 'devin'];

export interface Sandbox {
  tmp: string;
  /** HARNESS_USER_HOME and HOME of every child process. */
  userHome: string;
  /** HARNESS_HOME. */
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** Variables of the surrounding run that would change what the children do. */
const SCRUB = ['CI', 'NODE_TEST_CONTEXT', 'HARNESS_REQUIRE_INTEGRITY', 'HARNESS_NO_INSTRUMENT', 'HARNESS_AGENT', 'HARNESS_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'CODEX_HOME', 'CODEX_SANDBOX', 'DEVIN_PROJECT_DIR', 'DEVIN_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'APPDATA'];

export function sandbox(prefix: string): Sandbox {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `harness-safety-${prefix}-`)));
  const userHome = path.join(tmp, 'home');
  const home = path.join(userHome, '.harness');
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, {
    HOME: userHome,
    USERPROFILE: userHome,
    XDG_CONFIG_HOME: path.join(userHome, '.config'),
    HARNESS_HOME: home,
    HARNESS_USER_HOME: userHome,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'harness-test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'harness-test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
  return {
    tmp,
    userHome,
    home,
    env,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

export interface Proc {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export function proc(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }): Proc {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : ''), ms: Date.now() - t0 };
}

/** The user's CLI (no TTY: stdin is a pipe). */
export function cli(sb: Sandbox, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}, timeoutMs = 300_000, cliJs = CLI_JS): Proc {
  return proc(process.execPath, [cliJs, ...args], { cwd, env: { ...sb.env, ...extra }, input: '', timeoutMs });
}

export interface HookRun extends Proc {
  json: any;
  denied: boolean;
  blocked: boolean;
  reason: string;
}

/** Run the hook process for one event with the payload on stdin. */
export function hook(sb: Sandbox, event: string, payload: Record<string, unknown>, agent: Dialect, opts: { cwd?: string; hookJs?: string; env?: NodeJS.ProcessEnv } = {}): HookRun {
  const cwd = opts.cwd ?? (typeof payload.cwd === 'string' ? payload.cwd : sb.tmp);
  const r = proc(process.execPath, [opts.hookJs ?? HOOK_JS, event, '--agent', agent], { cwd, env: { ...sb.env, ...(opts.env ?? {}) }, input: JSON.stringify(payload), timeoutMs: 30_000 });
  let json: any = null;
  try {
    const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    json = line ? JSON.parse(line) : null;
  } catch {
    json = null;
  }
  const denied = r.code === 2 && json?.hookSpecificOutput?.permissionDecision === 'deny';
  const blocked = r.code === 2 && json?.decision === 'block';
  const reason = String(json?.hookSpecificOutput?.permissionDecisionReason ?? json?.reason ?? r.stderr ?? '');
  return { ...r, json, denied, blocked, reason };
}

let seq = 0;
/** A fresh session id per call, so the dispatcher's dedupe never answers from an earlier call. */
export function sid(tag = 's'): string {
  seq += 1;
  return `${tag}-${process.pid}-${seq}`;
}

/** A shell tool call in the agent's dialect. */
export function shellPayload(dialect: Dialect, command: string, cwd: string, sessionId = sid()): Record<string, unknown> {
  const tool_name = dialect === 'devin' ? 'exec' : 'Bash';
  return { session_id: sessionId, hook_event_name: 'PreToolUse', cwd, tool_name, tool_input: { command } };
}

/** A whole-file write in the agent's dialect (Devin: `write` with `path`). */
export function writePayload(dialect: Dialect, file: string, content: string, cwd: string, sessionId = sid()): Record<string, unknown> {
  if (dialect === 'devin') return { session_id: sessionId, hook_event_name: 'PreToolUse', cwd, tool_name: 'write', tool_input: { path: file, content } };
  return { session_id: sessionId, hook_event_name: 'PreToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file, content } };
}

/** An edit in the agent's dialect (Codex: apply_patch; Devin: `edit` with both path fields, unknown which it sends). */
export function editPayload(dialect: Dialect, file: string, oldText: string, newText: string, cwd: string, sessionId = sid()): Record<string, unknown> {
  if (dialect === 'devin') return { session_id: sessionId, hook_event_name: 'PreToolUse', cwd, tool_name: 'edit', tool_input: { path: file, file_path: file, old_string: oldText, new_string: newText } };
  if (dialect === 'codex') {
    const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-${oldText}\n+${newText}\n*** End Patch\n`;
    return { session_id: sessionId, hook_event_name: 'PreToolUse', cwd, tool_name: 'apply_patch', tool_input: { input: patch } };
  }
  return { session_id: sessionId, hook_event_name: 'PreToolUse', cwd, tool_name: 'Edit', tool_input: { file_path: file, old_string: oldText, new_string: newText } };
}

/** PreToolUse through the hook process for a shell command; returns the run. */
export function preShell(sb: Sandbox, dialect: Dialect, command: string, cwd: string, opts: { hookJs?: string; env?: NodeJS.ProcessEnv } = {}): HookRun {
  return hook(sb, 'PreToolUse', shellPayload(dialect, command, cwd), dialect, { cwd, ...opts });
}

/** git with a fixed identity, no signing, no user hooks unless the caller sets core.hooksPath. */
export function git(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env, allowFail = false): Proc {
  const r = proc('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000 });
  if (!allowFail && r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}`);
  return r;
}

/** A git repository with the given files committed on main. */
export function initRepo(dir: string, files: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main'], env);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  git(dir, ['-c', 'core.hooksPath=/dev/null', 'add', '-A'], env);
  git(dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init'], env);
  return dir;
}

/** Every file under `dir` (relative, forward slashes), skipping `.git` and node_modules. */
export function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** Files under `dir` whose bytes contain `needle` (binary-safe), relative paths. */
export function grepTree(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(p);
      } else if (e.isFile()) {
        try {
          if (fs.readFileSync(p).includes(needle)) hits.push(path.relative(dir, p).split(path.sep).join('/'));
        } catch {
          /* unreadable */
        }
      }
    }
  };
  walk(dir);
  return hits;
}

/** The instrumentation events written under HARNESS_HOME. */
export function events(sb: Sandbox): Array<{ event: string; ids?: Record<string, string>; counts?: Record<string, number> }> {
  const p = path.join(sb.home, 'logs', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Mark one server as test through the user's CLI (keeps markedHash and integrity in step). */
export function markTest(sb: Sandbox, server: string, database?: string): void {
  const r = cli(sb, ['db', 'mark', '--server', server, ...(database ? ['--database', database] : []), '--test'], sb.tmp);
  if (r.code !== 0) throw new Error(`db mark failed: ${r.stderr}`);
}

/** Set a machine-config key through the installer's non-interactive path (`--from-install`), which re-signs integrity. */
export function configSet(sb: Sandbox, key: string, value: string): void {
  const r = cli(sb, ['config', 'set', key, value, '--from-install'], sb.tmp);
  if (r.code !== 0) throw new Error(`config set ${key} failed: ${r.stderr}`);
}

/**
 * `harness install --yes` for a setting through the user's CLI (no repo binaries run, no database marked
 * unless `extra` says so). Returns the run; throws with its output when it fails.
 */
export function install(sb: Sandbox, setting: 'team' | 'personal', agents: Dialect[], workspace: string, extra: string[] = []): Proc {
  const r = cli(sb, ['install', '--setting', setting, '--agents', agents.join(','), '--workspace', workspace, '--yes', '--no-exec', ...(extra.some((x) => x.startsWith('--db-')) ? [] : ['--db-none']), ...extra], workspace);
  if (r.code !== 0) throw new Error(`install --setting ${setting} failed (exit ${r.code}): ${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`);
  return r;
}

export interface TeamWorkspace {
  root: string;
  repos: string[];
  /** 'standin' (HARNESS_STANDIN_TEAM's setup.js) or 'synthetic' (built here). */
  kind: 'standin' | 'synthetic';
}

/**
 * A team workspace: the team stand-in when HARNESS_STANDIN_TEAM names its
 * folder (setup.js --no-db --no-install, rough harness into the sandbox home),
 * else two small repositories built here, one of them tracking the team's own
 * CLAUDE.md and CI workflow (files the harness must leave alone).
 */
export function teamWorkspace(sb: Sandbox): TeamWorkspace {
  const root = path.join(sb.tmp, 'workspace');
  const standin = process.env.HARNESS_STANDIN_TEAM;
  if (standin && fs.existsSync(path.join(standin, 'setup.js'))) {
    const r = proc(process.execPath, [path.join(standin, 'setup.js'), root, '--no-db', '--no-install', '--harness-home', sb.userHome], { cwd: sb.tmp, env: sb.env, timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`stand-in setup.js failed: ${r.stderr.slice(-800)}`);
    const repos = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, '.git')))
      .map((e) => path.join(root, e.name));
    return { root, repos, kind: 'standin' };
  }
  const pkg = (name: string) => JSON.stringify({ name, private: true, scripts: { test: 'node --test' } }, null, 2) + '\n';
  const a = initRepo(path.join(root, 'billing-svc'), { 'package.json': pkg('billing-svc'), 'src/invoice.js': 'exports.total = (lines) => lines.reduce((s, l) => s + l.qty * l.price, 0);\n', 'test/invoice.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/invoice');\ntest('total', () => assert.equal(total([{ qty: 2, price: 3 }]), 6));\n" }, sb.env);
  const b = initRepo(path.join(root, 'ledger-web'), { 'package.json': pkg('ledger-web'), 'src/app.js': "exports.title = 'ledger';\n", 'CLAUDE.md': '# Team notes\n\nRun npm test before pushing.\n', '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n' }, sb.env);
  return { root, repos: [a, b], kind: 'synthetic' };
}

/** git with the repository's rendered hooks switched on (core.hooksPath at `hooksDir`). */
export function gitWithHooks(dir: string, hooksDir: string, args: string[], env: NodeJS.ProcessEnv): Proc {
  return git(dir, ['-c', `core.hooksPath=${hooksDir}`, ...args], env, true);
}

/**
 * A private copy of the built package (dist/ + package.json + templates) for
 * tests that tamper with the hook files, so parallel test files never see a
 * modified dist/src/hook.js.
 */
export function copyPackage(dest: string): { root: string; hookJs: string; cliJs: string } {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(DIST, 'src'), path.join(dest, 'dist', 'src'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'package.json'), path.join(dest, 'package.json'));
  for (const d of ['templates', 'probes', 'selfcheck']) {
    if (fs.existsSync(path.join(PKG_ROOT, d))) fs.cpSync(path.join(PKG_ROOT, d), path.join(dest, d), { recursive: true });
  }
  return { root: dest, hookJs: path.join(dest, 'dist', 'src', 'hook.js'), cliJs: path.join(dest, 'dist', 'src', 'cli.js') };
}

/** A one-line, names-and-counts summary for t.diagnostic and stdout (the recorded numbers come from here). */
export function report(t: { diagnostic(msg: string): void }, line: string): void {
  t.diagnostic(line);
  process.stdout.write(`# ${line}\n`);
}

export const built = (): string | null => (fs.existsSync(HOOK_JS) && fs.existsSync(CLI_JS) ? null : `not built: ${HOOK_JS} (run npm run build)`);
