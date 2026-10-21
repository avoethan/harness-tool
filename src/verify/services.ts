/**
 * Starting and stopping the services of a verify run.
 *
 * A service starts with its repository's own `dev` script (it runs the
 * working tree's source), else `start` (the overlay's `services.<name>.start`
 * picks another), resolved the way the gate resolves scripts: a simple body
 * is tokenised and its binary found inside the repository, else the package
 * manager runs it. Every start is an argv array; the process gets the run's
 * variables (and the DB password from the named variable, never written to
 * disk), its output goes to the run folder (`logs/<service>.log`, never
 * inside the repository), and readiness is a health route answering, else
 * the port accepting connections.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { readTextOr, ensureDir } from '../lib/fsx';
import { run } from '../lib/exec';
import { redactText } from '../lib/redact';
import { scriptCommand, type ScriptCommand } from '../gate/scripts';

export interface StartSpec {
  name: string;
  repoRoot: string;
  dir: string;
  script: string;
  env: Record<string, string>;
  /** Secret variables (name -> value) given to the process only. */
  secretEnv: Record<string, string>;
  logFile: string;
}

export interface Started {
  ok: boolean;
  pid?: number;
  command?: string[];
  display?: string;
  error?: string;
}

function pmOf(dir: string, repoRoot: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  for (const d of [dir, repoRoot]) {
    if (fs.existsSync(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(d, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(d, 'bun.lockb')) || fs.existsSync(path.join(d, 'bun.lock'))) return 'bun';
  }
  return 'npm';
}

/** The argv for a package script, read from the working tree. */
export function resolveStart(repoRoot: string, dir: string, script: string): { ok: true; cmd: ScriptCommand } | { ok: false; reason: string } {
  const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
  const read = (p: string) => readTextOr(path.join(repoRoot, p), null);
  const r = scriptCommand({ root: repoRoot, baseText: read, nowText: read, pm: pmOf(dir, repoRoot) }, script, rel);
  return r.ok ? { ok: true, cmd: r.cmd } : { ok: false, reason: r.reason };
}

/** Pick the script to start: the overlay's choice, else dev, else start. */
export function pickScript(scripts: { start?: string; dev?: string }, preferred?: string): string | null {
  if (preferred) return preferred;
  if (scripts.dev) return 'dev';
  if (scripts.start) return 'start';
  return null;
}

export function startService(s: StartSpec): Started {
  const r = resolveStart(s.repoRoot, s.dir, s.script);
  if (!r.ok) return { ok: false, error: r.reason };
  ensureDir(path.dirname(s.logFile));
  let fd: number;
  try {
    fd = fs.openSync(s.logFile, 'a');
  } catch (e) {
    return { ok: false, error: `cannot open the log file: ${(e as Error).message}` };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...r.cmd.env, ...s.env, ...s.secretEnv, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.SQLCMDPASSWORD;
  try {
    const child = spawn(r.cmd.argv[0], r.cmd.argv.slice(1), { cwd: r.cmd.cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.on('error', () => {
      /* reported through readiness */
    });
    child.unref();
    fs.closeSync(fd);
    if (!child.pid) return { ok: false, error: 'the process did not start' };
    return { ok: true, pid: child.pid, command: r.cmd.argv, display: r.cmd.display };
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
      /* closed */
    }
    return { ok: false, error: (e as Error).message };
  }
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The command line of a running process (Linux /proc, else ps), for checking a pid is still ours. */
export function processCommand(pid: number): string | null {
  try {
    const t = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return t.split('\0').join(' ').trim();
  } catch {
    /* not Linux */
  }
  if (process.platform === 'win32') return null;
  const r = run('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Whether the pid still runs the command the run started (pids get reused). */
export function ownsPid(pid: number | undefined, command: string[] | undefined): boolean {
  if (!pid || !pidAlive(pid)) return false;
  if (!command || !command.length) return true;
  const cmd = processCommand(pid);
  if (cmd === null) return true;
  const marker = command.slice(1).find((a) => a.length > 3) ?? command[0];
  return cmd.includes(marker) || cmd.includes(path.basename(command[0]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stop a started service and its children (process group; taskkill /T on Windows). */
export async function stopService(pid: number | undefined, command?: string[]): Promise<'stopped' | 'not-running' | 'not-ours'> {
  if (!pid || !pidAlive(pid)) return 'not-running';
  if (!ownsPid(pid, command)) return 'not-ours';
  if (process.platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(100);
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  }
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
  return pidAlive(pid) ? 'not-ours' : 'stopped';
}

export function tcpOpen(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export interface HttpProbe {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

export async function httpGet(url: string, timeoutMs = 3000): Promise<HttpProbe> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    const body = await res.text();
    return { ok: res.status < 500, status: res.status, body: body.slice(0, 4096) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

export interface Readiness {
  ready: boolean;
  ms: number;
  via: 'health' | 'port';
  status?: number;
  error?: string;
}

/** Poll the health route (2xx), else the port, until ready, the process exits, or the timeout. */
export async function waitReady(o: { port: number; baseUrl: string; health?: string; pid?: number; timeoutMs: number; anyStatus?: boolean }): Promise<Readiness> {
  const start = Date.now();
  let last: HttpProbe | null = null;
  while (Date.now() - start < o.timeoutMs) {
    if (o.pid && !pidAlive(o.pid)) return { ready: false, ms: Date.now() - start, via: o.health ? 'health' : 'port', error: 'the process exited before it answered' };
    if (o.health) {
      last = await httpGet(o.baseUrl + o.health, 2000);
      // anyStatus: the service is meant to answer with an error (its database is unreachable on purpose).
      if (last.status !== undefined && (o.anyStatus || (last.status >= 200 && last.status < 300))) return { ready: true, ms: Date.now() - start, via: 'health', status: last.status };
    } else if (await tcpOpen(o.port)) return { ready: true, ms: Date.now() - start, via: 'port' };
    await sleep(250);
  }
  return { ready: false, ms: Date.now() - start, via: o.health ? 'health' : 'port', status: last?.status, error: last?.status ? `the health route answered ${last.status}` : 'no answer before the timeout' };
}

/** The last lines of a log file, redacted (for failure messages; never logged to instrumentation). */
export function logTail(file: string, lines = 12): string[] {
  const t = readTextOr(file, '') ?? '';
  return t
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .map((l) => redactText(l).slice(0, 300));
}
