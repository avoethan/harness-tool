/**
 * `harness doctor [--json] [--fix]`
 *
 * A list of checks, each ok / warn / fail with one plain-language line and a
 * fix hint: Node version, the built hook entry, the integrity manifest, the
 * config, the database allowlist, scanners, hook registration per agent, the
 * private state repository, the Codex hook-trust heartbeat. Exit 1 when any
 * check fails, else 0. `--fix` creates the state repository when missing.
 *
 * Codex heartbeat convention (for the SessionStart hook): the hook writes
 * `<HARNESS_HOME>/state/heartbeat-<agent>.json` as `{ agent, at, sessionId? }`
 * every time it runs; its presence proves the agent ran a harness hook, so
 * for Codex it proves the hooks were trusted with /hooks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { harnessVersion } from '../cli';
import { ALL_AGENTS, type AgentId, type HarnessConfig } from '../types';
import { flagBool, parseArgv } from '../lib/argv';
import { allowlistHash, loadConfig } from '../lib/config';
import { run, which } from '../lib/exec';
import { exists, isDir, isFile, readJsonOr, readTextOr } from '../lib/fsx';
import { remotes, rawGit } from '../lib/git';
import { integrityPath, verifyIntegrity } from '../lib/integrity';
import { tryParseJsonc } from '../lib/jsonc';
import { agentHome, configPath, harnessHome, hookEntryPath, isWindows, logsDir, packageRoot, stateDir, toPosix } from '../lib/paths';

export const meta: CommandMeta = {
  name: 'doctor',
  summary: 'Check the install, scanners, hooks, integrity and the test-database allowlist',
  usage: 'harness doctor [--json] [--fix]',
  examples: ['harness doctor', 'harness doctor --json', 'harness doctor --fix'],
};

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  version: string;
  ok: boolean;
  checks: Check[];
  summary: { ok: number; warn: number; fail: number };
}

export interface DoctorOptions {
  fix?: boolean;
}

export function heartbeatPath(agent: AgentId): string {
  return path.join(stateDir(), `heartbeat-${agent}.json`);
}

const AGENT_LABEL: Record<AgentId, string> = { devin: 'Devin', claude: 'Claude Code', codex: 'Codex' };

/** User-level settings files where hooks are registered, per agent. */
export function hookSettingsFiles(agent: AgentId, workspaceRoot: string | null, setting: HarnessConfig['setting'] | null): string[] {
  const home = agentHome(agent);
  const files: string[] = [];
  switch (agent) {
    case 'claude':
      files.push(path.join(home, 'settings.json'));
      if (setting === 'personal' && workspaceRoot) files.push(path.join(workspaceRoot, '.claude', 'settings.json'));
      break;
    case 'codex':
      files.push(path.join(home, 'hooks.json'));
      if (setting === 'personal' && workspaceRoot) files.push(path.join(workspaceRoot, '.codex', 'hooks.json'));
      break;
    case 'devin':
      files.push(path.join(home, 'config.json'));
      break;
  }
  return files;
}

/** Every command string under a `hooks` object, with the event it belongs to. */
export function hookCommands(doc: unknown): Array<{ event: string; command: string }> {
  const out: Array<{ event: string; command: string }> = [];
  const hooks = (doc as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.command === 'string') out.push({ event, command: o.command });
        for (const k of Object.keys(o)) if (k !== 'command') walk(o[k]);
      }
    };
    walk(groups);
  }
  return out;
}

function containsHookPath(command: string, hookPath: string): boolean {
  const a = toPosix(command);
  return isWindows ? a.toLowerCase().includes(hookPath.toLowerCase()) : a.includes(hookPath);
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? { name: 'node', status: 'ok', message: `Node ${process.versions.node}` }
    : { name: 'node', status: 'fail', message: `Node ${process.versions.node} is too old`, fix: 'install Node 20 or newer' };
}

function checkBuilt(): Check {
  const entry = hookEntryPath();
  return isFile(entry)
    ? { name: 'built', status: 'ok', message: `hook entry built: ${entry}` }
    : { name: 'built', status: 'fail', message: `hook entry missing: ${entry}`, fix: `run \`npm run build\` in ${toPosix(packageRoot())}` };
}

function checkIntegrity(): Check {
  if (!isFile(integrityPath())) return { name: 'integrity', status: 'warn', message: 'not yet signed: run install', fix: '`harness install` signs the hook files and config' };
  const v = verifyIntegrity();
  return v.ok
    ? { name: 'integrity', status: 'ok', message: `integrity manifest matches (${integrityPath()})` }
    : { name: 'integrity', status: 'fail', message: `integrity mismatch: ${v.reason}; hooks fail closed until it is re-signed`, fix: 'rebuild (`npm run build`) and re-sign with `harness config set` or `harness install`' };
}

function checkConfig(c: HarnessConfig | null): Check {
  if (!c) return { name: 'config', status: 'warn', message: `no config at ${configPath()}`, fix: 'run `harness install --setting team|personal`' };
  const missing: string[] = [];
  if (c.setting !== 'team' && c.setting !== 'personal') missing.push('setting');
  if (!Array.isArray(c.agents) || !c.agents.length) missing.push('agents');
  if (!c.workspaceRoot || !isDir(c.workspaceRoot)) missing.push('workspaceRoot (folder must exist)');
  if (missing.length) return { name: 'config', status: 'fail', message: `config is incomplete: ${missing.join(', ')}`, fix: 'set them with `harness config set <key> <value>` from a terminal' };
  return { name: 'config', status: 'ok', message: `${c.setting} setting; agents ${c.agents.join(', ')}; workspace ${c.workspaceRoot}; ${c.repos.length} repo(s)` };
}

function checkDb(c: HarnessConfig | null): Check {
  const list = c?.db.allowlist ?? [];
  if (!list.length) return { name: 'db-allowlist', status: 'warn', message: 'empty: every database command is denied until you mark a test server', fix: 'harness db mark --server <host[,port]> [--database <name>] --test' };
  const live = allowlistHash(c!);
  if (c!.db.markedHash !== live) return { name: 'db-allowlist', status: 'fail', message: 'the allowlist was edited outside `harness db mark` (hash mismatch); every database command is denied', fix: 're-mark the entries with `harness db mark` to refresh the hash' };
  const entries = list.map((x) => `${x.server}${x.database ? `/${x.database}` : ''}=${x.marked}`).join(', ');
  const tests = list.filter((x) => x.marked === 'test').length;
  const readOnly = list.filter((x) => x.marked === 'read-only').length;
  if (!tests && readOnly) return { name: 'db-allowlist', status: 'warn', message: `${entries}: no server is marked test, so only inline reads of the read-only entries are allowed`, fix: 'harness db mark --server <host[,port]> --test' };
  return tests
    ? { name: 'db-allowlist', status: 'ok', message: `${entries} (hash ${live.slice(0, 12)})` }
    : { name: 'db-allowlist', status: 'warn', message: `${entries}: no server is marked test, so every database command is denied`, fix: 'harness db mark --server <host[,port]> --test' };
}

function binName(name: string): string[] {
  return isWindows ? [`${name}.cmd`, `${name}.exe`, name] : [name];
}

function localBin(root: string, name: string): string | null {
  for (const n of binName(name)) {
    const p = path.join(root, 'node_modules', '.bin', n);
    if (isFile(p)) return p;
  }
  return null;
}

function checkAstGrep(): Check {
  const local = localBin(packageRoot(), 'ast-grep') ?? localBin(packageRoot(), 'sg');
  const found = local ?? which('ast-grep') ?? which('sg');
  return found
    ? { name: 'scanner:ast-grep', status: 'ok', message: `ast-grep: ${found}` }
    : { name: 'scanner:ast-grep', status: 'warn', message: 'ast-grep not found: syntactic probes degrade to ESLint-only', fix: `run \`npm install\` in ${toPosix(packageRoot())} (optional dependency @ast-grep/cli) or put ast-grep on PATH` };
}

function checkRepoScanners(c: HarnessConfig | null): Check[] {
  const repos = c?.repos ?? [];
  if (!repos.length) return [{ name: 'scanner:repo-tools', status: 'warn', message: 'no repositories configured yet, so eslint, prettier, dependency-cruiser and knip were not looked for', fix: 'run `harness install`; each repo\'s own node_modules is checked then' }];
  const out: Check[] = [];
  for (const r of repos) {
    const present: string[] = [];
    const absent: string[] = [];
    for (const tool of ['eslint', 'prettier', 'dependency-cruiser', 'knip']) (localBin(r.path, tool) ? present : absent).push(tool);
    out.push(
      absent.length
        ? { name: `scanner:${r.id}`, status: 'warn', message: `${r.name}: ${present.length ? `${present.join(', ')} present; ` : ''}${absent.join(', ')} not in node_modules (checks that need them are skipped and reported)`, fix: `install them as devDependencies in ${r.path} if the repo should have them` }
        : { name: `scanner:${r.id}`, status: 'ok', message: `${r.name}: eslint, prettier, dependency-cruiser, knip resolvable` },
    );
  }
  return out;
}

function checkSqlcmd(): Check {
  const sq = which('sqlcmd');
  if (sq) return { name: 'scanner:sqlcmd', status: 'ok', message: `sqlcmd: ${sq}` };
  const docker = which('docker');
  if (docker) {
    const r = run(docker, ['ps', '--format', '{{.Image}}'], { timeoutMs: 10000 });
    if (r.code === 0) {
      const img = r.stdout.split(/\r?\n/).find((l) => /mssql|sql-?server|azure-sql-edge/i.test(l));
      if (img) return { name: 'scanner:sqlcmd', status: 'ok', message: `no sqlcmd on PATH, but a SQL Server container is running (${img.trim()})` };
      return { name: 'scanner:sqlcmd', status: 'warn', message: 'sqlcmd not on PATH and no running SQL Server container', fix: 'install the sqlcmd tools or start your test SQL Server container' };
    }
    return { name: 'scanner:sqlcmd', status: 'warn', message: `sqlcmd not on PATH; docker is installed but not reachable (${r.timedOut ? 'timed out' : 'daemon not running'})`, fix: 'install sqlcmd, or start Docker and your test SQL Server container' };
  }
  return { name: 'scanner:sqlcmd', status: 'warn', message: 'sqlcmd not on PATH and docker not installed: SQL lint and E2E database steps are skipped and reported', fix: 'install the sqlcmd tools (or Docker with a SQL Server image)' };
}

function checkSemgrep(): Check {
  const s = which('semgrep');
  return s
    ? { name: 'scanner:semgrep', status: 'ok', message: `semgrep: ${s}` }
    : { name: 'scanner:semgrep', status: 'warn', message: 'semgrep not on PATH: taint checks are skipped and reported', fix: 'pip install semgrep (optional)' };
}

function checkHooks(c: HarnessConfig | null): Check[] {
  const agents = c?.agents ?? ALL_AGENTS;
  const hookPath = hookEntryPath();
  const out: Check[] = [];
  for (const agent of agents) {
    const files = hookSettingsFiles(agent, c?.workspaceRoot ?? null, c?.setting ?? null);
    const events = new Set<string>();
    const seen: string[] = [];
    let parseError: string | null = null;
    for (const f of files) {
      const text = readTextOr(f, null);
      if (text === null) continue;
      seen.push(f);
      const parsed = tryParseJsonc(text);
      if (!parsed.ok) {
        parseError = `${f}: ${parsed.error}`;
        continue;
      }
      for (const h of hookCommands(parsed.value)) if (containsHookPath(h.command, hookPath)) events.add(h.event);
    }
    const label = AGENT_LABEL[agent];
    if (parseError) out.push({ name: `hooks:${agent}`, status: 'fail', message: `${label}: settings file does not parse (${parseError})`, fix: 'fix the JSON by hand; the harness never rewrites a file it cannot parse' });
    else if (!seen.length) out.push({ name: `hooks:${agent}`, status: c ? 'fail' : 'warn', message: `${label}: no settings file at ${files.join(' or ')}`, fix: '`harness install` registers the hooks' });
    else if (!events.size) out.push({ name: `hooks:${agent}`, status: c ? 'fail' : 'warn', message: `${label}: no hook in ${seen.join(', ')} runs ${hookPath}`, fix: '`harness install` registers the hooks (or re-run it after moving the harness folder)' });
    else out.push({ name: `hooks:${agent}`, status: 'ok', message: `${label}: hooks registered for ${[...events].sort().join(', ')} in ${seen.join(', ')}` });
  }
  return out;
}

function checkStateRepo(fix: boolean): Check {
  const home = harnessHome();
  if (!isDir(path.join(home, '.git'))) {
    if (!fix) return { name: 'state-repo', status: 'warn', message: `${home} is not a git repository yet (its history is your undo trail)`, fix: 'harness doctor --fix (runs git init there, no remote)' };
    try {
      fs.mkdirSync(home, { recursive: true });
    } catch {
      /* reported below */
    }
    const r = rawGit(home, ['init', '-q'], 15000);
    if (r.code !== 0) return { name: 'state-repo', status: 'fail', message: `could not create the state repository: ${r.stderr.trim() || 'git init failed'}`, fix: 'install git and run `git init` in ' + home };
    return { name: 'state-repo', status: 'ok', message: `created a private git repository at ${home} (no remote)` };
  }
  const rs = remotes(home);
  return rs.length
    ? { name: 'state-repo', status: 'warn', message: `${home} has a remote (${rs.join(', ')}); the harness state must stay private`, fix: `git -C "${home}" remote remove ${rs[0]}` }
    : { name: 'state-repo', status: 'ok', message: `${home} is a git repository with no remote` };
}

function checkCodexHeartbeat(c: HarnessConfig | null): Check | null {
  const agents = c?.agents ?? ALL_AGENTS;
  if (!agents.includes('codex')) return null;
  const p = heartbeatPath('codex');
  const hb = readJsonOr<{ at?: string } | null>(p, null);
  if (hb && typeof hb.at === 'string') return { name: 'codex-hooks-trusted', status: 'ok', message: `Codex ran the harness SessionStart hook at ${hb.at}, so its hooks are trusted` };
  return { name: 'codex-hooks-trusted', status: 'warn', message: 'no Codex session has run the harness SessionStart hook yet (Codex skips hooks until they are trusted)', fix: 'open Codex, run /hooks and trust the harness hook entries, then start a new session' };
}

/**
 * The last hook event seen from each configured agent, read from the instrumentation log (event names and
 * times only). Proves the agent's hooks reach the harness; a guard decision (`guard.allow` / `guard.deny`)
 * means the guard checked that agent's tool calls.
 */
export function checkHooksSeen(c: HarnessConfig | null, logFile = path.join(logsDir(), 'events.jsonl')): Check[] {
  const agents = c?.agents ?? ALL_AGENTS;
  const last: Partial<Record<AgentId, { at: string; guard?: string }>> = {};
  const text = readTextOr(logFile, '') ?? '';
  for (const line of text.split('\n')) {
    if (!line.includes('"agent"')) continue;
    let e: { ts?: string; event?: string; agent?: AgentId } | null = null;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.agent || !e.ts || !agents.includes(e.agent)) continue;
    const cur = last[e.agent] ?? { at: e.ts };
    if (e.ts >= cur.at) cur.at = e.ts;
    if (e.event === 'guard.allow' || e.event === 'guard.deny') cur.guard = e.ts > (cur.guard ?? '') ? e.ts : cur.guard;
    last[e.agent] = cur;
  }
  return agents.map((a): Check => {
    const l = last[a];
    if (!l) return { name: `hooks-seen-${a}`, status: 'warn', message: `no hook event from ${a} yet`, fix: `open ${a} in the workspace (trust the folder) and run any command; then run harness doctor again` };
    return l.guard
      ? { name: `hooks-seen-${a}`, status: 'ok', message: `${a}: last hook event ${l.at}; the guard last checked one of its tool calls at ${l.guard}` }
      : { name: `hooks-seen-${a}`, status: 'warn', message: `${a}: hook events arrive (last ${l.at}) but the guard has not checked a tool call yet`, fix: `ask ${a} to run a harmless command such as git status, then run harness doctor again` };
  });
}

// ---------------------------------------------------------------------------

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const c = loadConfig();
  const checks: Check[] = [];
  const add = (x: Check | Check[] | null) => {
    if (!x) return;
    if (Array.isArray(x)) checks.push(...x);
    else checks.push(x);
  };
  add(checkNode());
  add(checkBuilt());
  add(checkIntegrity());
  add(checkConfig(c));
  add(checkDb(c));
  add(checkAstGrep());
  add(checkRepoScanners(c));
  add(checkSqlcmd());
  add(checkSemgrep());
  add(checkHooks(c));
  add(checkStateRepo(!!opts.fix));
  add(checkCodexHeartbeat(c));
  add(checkHooksSeen(c));
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const x of checks) summary[x.status]++;
  return { version: harnessVersion(), ok: summary.fail === 0, checks, summary };
}

export function formatDoctor(r: DoctorReport): string {
  const lines = [`harness ${r.version} doctor (home ${harnessHome()}${exists(harnessHome()) ? '' : ', not created yet'})`];
  const mark: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  for (const x of r.checks) {
    lines.push(`  ${mark[x.status]}  ${x.name.padEnd(22)} ${x.message}`);
    if (x.fix && x.status !== 'ok') lines.push(`${' '.repeat(30)}fix: ${x.fix}`);
  }
  lines.push(`${r.summary.ok} ok, ${r.summary.warn} warning${r.summary.warn === 1 ? '' : 's'}, ${r.summary.fail} failure${r.summary.fail === 1 ? '' : 's'}${r.ok ? '' : ' — fix the failures above'}`);
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv);
  const r = await runDoctor({ fix: flagBool(p, 'fix') });
  if (flagBool(p, 'json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatDoctor(r) + '\n');
  return r.ok ? 0 : 1;
}
