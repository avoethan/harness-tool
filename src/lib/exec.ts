import { spawnSync, spawn, type SpawnSyncOptions } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  signal: NodeJS.Signals | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Max bytes of stdout/stderr kept. */
  maxBuffer?: number;
  /** Run through the platform shell. Avoid; prefer argv arrays. */
  shell?: boolean;
}

/**
 * Run a command synchronously with an argv array (no shell by default).
 * Never throws; inspect `code`.
 */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): ExecResult {
  const start = Date.now();
  const sopts: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    encoding: 'utf8',
    shell: opts.shell ?? false,
    windowsHide: true,
  };
  const r = spawnSync(cmd, args, sopts);
  const timedOut = !!(r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return {
    code: r.error && !timedOut ? -1 : r.status,
    stdout: (r.stdout as unknown as string) ?? '',
    stderr: ((r.stderr as unknown as string) ?? '') + (r.error && !timedOut ? `\n${r.error.message}` : ''),
    timedOut,
    durationMs: Date.now() - start,
    signal: r.signal ?? null,
  };
}

/** Like run() but resolves a promise, so long steps can be awaited with other work. */
export function runAsync(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
    });
    const max = opts.maxBuffer ?? 16 * 1024 * 1024;
    child.stdout?.on('data', (d) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < max) stderr += d.toString();
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    if (opts.input != null) child.stdin?.end(opts.input);
    else child.stdin?.end();
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, timedOut, durationMs: Date.now() - start, signal: null });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - start, signal });
    });
  });
}

export function which(cmd: string): string | null {
  const r = run(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeoutMs: 5000 });
  if (r.code !== 0) return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}
