/**
 * Running the repository's own scripts the way the gate must: the script
 * body comes from package.json *at the base commit*, and it runs as an argv
 * array, never through a shell string.
 *
 * A simple script body (`vitest run`, `tsc -p tsconfig.build.json`,
 * `NODE_ENV=test node --test test/`, `npm run other`) is tokenised and its
 * binary resolved inside the repository (`node_modules/.bin`, then the
 * package's `bin` field), then run with the current Node. A body with shell
 * operators (`&&`, `|`, `;`, redirections, `$VAR`) runs through the package
 * manager (`npm run <name>`), and only when the working tree's script is
 * byte-identical to the base commit's, so a change cannot rewrite what the
 * gate runs. Nothing is ever installed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateContext, PackageJson } from './context';
import { run, type ExecResult } from '../lib/exec';
import { tryParseJsonc } from '../lib/jsonc';
import { redactText } from '../lib/redact';
import { subPath } from '../lib/paths';

export type Runner = 'vitest' | 'jest' | 'mocha' | 'node' | 'ava' | 'tap' | 'playwright' | 'unknown';

export interface ScriptCommand {
  /** argv[0] is the program (usually the current Node), the rest its arguments. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** What a person would type, for the report. */
  display: string;
  how: 'direct' | 'package-manager';
  runner: Runner;
  /** Index in argv where the tool's own arguments start (after the program and script path). */
  toolArgsAt: number;
}

export type ScriptLookup = { ok: true; cmd: ScriptCommand } | { ok: false; reason: string; missing?: boolean };

const KNOWN_PKG: Record<string, string> = { tsc: 'typescript', tsserver: 'typescript', 'ts-node': 'ts-node', vitest: 'vitest', jest: 'jest', eslint: 'eslint', prettier: 'prettier', mocha: 'mocha', c8: 'c8', nyc: 'nyc', ava: 'ava', tsx: 'tsx', nx: 'nx', turbo: 'turbo', playwright: '@playwright/test' };

/** Split a script body into env assignments and argv tokens; null when it needs a shell. */
export function tokenizeScript(body: string): { env: Record<string, string>; tokens: string[] } | null {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < body.length) cur += body[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (/[|;<>`&]/.test(c) || (c === '$' && /[({A-Za-z_]/.test(body[i + 1] ?? ''))) return null;
    if (c === '\\' && i + 1 < body.length) {
      cur += body[++i];
      continue;
    }
    cur += c;
  }
  if (q) return null;
  if (has || cur) tokens.push(cur);
  const env: Record<string, string> = {};
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const t = tokens.shift()!;
    const eq = t.indexOf('=');
    env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  if (tokens[0] === 'cross-env' || tokens[0] === 'env') {
    tokens.shift();
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      const t = tokens.shift()!;
      const eq = t.indexOf('=');
      env[t.slice(0, eq)] = t.slice(eq + 1);
    }
  }
  return tokens.length ? { env, tokens } : null;
}

function isNodeScript(p: string): boolean {
  if (/\.[cm]?js$/i.test(p)) return true;
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    return /^#!.*\bnode\b/.test(buf.toString('utf8'));
  } catch {
    return false;
  }
}

/**
 * Resolve a binary name inside the repository: the package's `bin` entry
 * (found from `from` upward, inside `root` only), else `node_modules/.bin`.
 * Returns the argv prefix to run it, or null when it is not installed.
 */
export function resolveBin(from: string, root: string, name: string): string[] | null {
  if (name === 'node') return [process.execPath];
  const pkgName = KNOWN_PKG[name] ?? name;
  try {
    const pj = require.resolve(`${pkgName}/package.json`, { paths: [from] });
    if (subPath(root, pj)) {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8')) as { bin?: string | Record<string, string> };
      const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[name];
      if (rel) {
        const p = path.join(path.dirname(pj), rel);
        if (fs.existsSync(p)) return isNodeScript(p) ? [process.execPath, p] : [p];
      }
    }
  } catch {
    /* not a resolvable package */
  }
  let dir = path.resolve(from);
  for (;;) {
    const bin = path.join(dir, 'node_modules', '.bin', name);
    if (fs.existsSync(bin) && process.platform !== 'win32') {
      try {
        const real = fs.realpathSync(bin);
        return isNodeScript(real) ? [process.execPath, real] : [real];
      } catch {
        /* broken link */
      }
    }
    if (path.resolve(dir) === path.resolve(root)) break;
    const up = path.dirname(dir);
    if (up === dir || !subPath(root, up)) break;
    dir = up;
  }
  return null;
}

/** Whether package.json (at the base) declares the package that provides a binary. */
export function declaresBin(pkg: PackageJson | null, bin: string): boolean {
  if (!pkg) return false;
  const name = KNOWN_PKG[bin] ?? bin;
  return [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies as Record<string, string> | undefined].some((d) => !!d && typeof d === 'object' && name in d);
}

/** npm's own CLI script next to the running Node (so npm runs without a shell on every platform). */
export function npmCli(): string | null {
  const dir = path.dirname(process.execPath);
  for (const p of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (fs.existsSync(p)) return p;
  return null;
}

/** The test runner a token list starts (looking through c8/nyc wrappers). */
export function runnerOf(tokens: string[]): Runner {
  const known: Record<string, Runner> = { vitest: 'vitest', jest: 'jest', mocha: 'mocha', _mocha: 'mocha', ava: 'ava', tap: 'tap', playwright: 'playwright' };
  for (const t of tokens) {
    const b = path.basename(t);
    if (known[b]) return known[b];
    if (b === 'node') return tokens.includes('--test') ? 'node' : 'unknown';
  }
  return 'unknown';
}

export function readPackageJson(text: string | null): PackageJson | null {
  if (!text) return null;
  const p = tryParseJsonc<PackageJson>(text);
  return p.ok && p.value && typeof p.value === 'object' ? p.value : null;
}

function display(env: Record<string, string>, tokens: string[]): string {
  return [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...tokens].join(' ');
}

/**
 * The command for script `name` of the package at `pkgRel` (repo-relative
 * folder; '' for the root), read from package.json at the base commit.
 */
export function scriptCommand(ctx: Pick<GateContext, 'root' | 'baseText' | 'nowText' | 'pm'>, name: string, pkgRel = '', depth = 0): ScriptLookup {
  const pjRel = pkgRel ? `${pkgRel.replace(/\/+$/, '')}/package.json` : 'package.json';
  const pkg = readPackageJson(ctx.baseText(pjRel));
  if (!pkg) return { ok: false, reason: `no ${pjRel} at the base commit`, missing: true };
  const body = pkg.scripts?.[name];
  if (typeof body !== 'string' || !body.trim()) return { ok: false, reason: `no "${name}" script in ${pjRel} at the base commit`, missing: true };
  const cwd = path.join(ctx.root, pkgRel);
  const tok = tokenizeScript(body.trim());
  if (tok && depth < 3) {
    let tokens = [...tok.tokens];
    if (tokens[0] === 'npx') tokens = tokens.slice(1).filter((t, i) => i > 0 || !t.startsWith('-'));
    // `npm run x` / `npm test` / `pnpm x` inside a script: follow it within the same package.
    const pm = tokens[0];
    if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn' || pm === 'bun') {
      const rest = tokens.slice(1);
      let sub: string | undefined;
      let extra: string[] = [];
      if ((rest[0] === 'run' || rest[0] === 'run-script') && rest[1] && !rest.slice(2).some((t) => /^(?:-w|--workspace|--workspaces|-ws|--filter|--prefix|-C|--dir)$/.test(t) || t.startsWith('--workspace'))) {
        sub = rest[1];
        extra = rest.slice(2);
      } else if (/^(?:test|t|tst)$/.test(rest[0] ?? '') && !rest.slice(1).some((t) => /^(?:-w|--workspace|--workspaces|-ws|--filter)/.test(t))) {
        sub = 'test';
        extra = rest.slice(1);
      } else if (pm !== 'npm' && rest[0] && !rest[0].startsWith('-') && pkg.scripts?.[rest[0]] && rest.length === 1) {
        sub = rest[0];
      }
      if (sub) {
        if (extra[0] === '--') extra = extra.slice(1);
        const inner = scriptCommand(ctx, sub, pkgRel, depth + 1);
        if (!inner.ok) return inner;
        const merged = { ...inner.cmd, env: { ...tok.env, ...inner.cmd.env }, argv: [...inner.cmd.argv, ...extra], display: `${inner.cmd.display}${extra.length ? ' ' + extra.join(' ') : ''}` };
        return { ok: true, cmd: merged };
      }
    } else {
      const prefix = resolveBin(cwd, ctx.root, tokens[0]);
      if (prefix) {
        return {
          ok: true,
          cmd: { argv: [...prefix, ...tokens.slice(1)], cwd, env: tok.env, display: display(tok.env, tokens), how: 'direct', runner: runnerOf(tokens), toolArgsAt: prefix.length },
        };
      }
      if (!/^(?:sh|bash|cmd|pwsh|powershell)$/.test(tokens[0]) && !fs.existsSync(path.join(cwd, tokens[0]))) {
        return { ok: false, reason: `"${name}" runs ${tokens[0]}, which is not installed in the repository (run the repository's install; the gate never installs)`, missing: false };
      }
    }
  }
  // Fallback: the package manager runs the working tree's script, so it must equal the base commit's.
  const nowPkg = readPackageJson(ctx.nowText(pjRel));
  if (nowPkg?.scripts?.[name] !== body) return { ok: false, reason: `the "${name}" script in ${pjRel} changed since the base commit; the gate runs scripts as they were at the base commit` };
  const pmName = ctx.pm;
  let argv: string[];
  if (pmName === 'npm') {
    const cli = npmCli();
    if (!cli) return { ok: false, reason: `"${name}" needs a shell and npm could not be located next to Node` };
    argv = [process.execPath, cli, 'run', '--silent', name];
  } else argv = [pmName, 'run', name];
  const tokens = tok?.tokens ?? [];
  return { ok: true, cmd: { argv, cwd, env: tok?.env ?? {}, display: `${pmName} run ${name}`, how: 'package-manager', runner: runnerOf(tokens), toolArgsAt: argv.length } };
}

/** Run a command with a timeout and a quiet, colour-free environment. */
export function runScript(cmd: ScriptCommand, extraArgs: string[], timeoutMs: number, opts: { cwd?: string; env?: Record<string, string> } = {}): ExecResult {
  const argv = cmd.how === 'package-manager' && extraArgs.length ? [...cmd.argv, '--', ...extraArgs] : [...cmd.argv, ...extraArgs];
  const env: NodeJS.ProcessEnv = { ...process.env, ...cmd.env, ...(opts.env ?? {}), CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' };
  // A gate started from inside a test runner must not make the repository's runner report to that parent.
  delete env.NODE_TEST_CONTEXT;
  return run(argv[0], argv.slice(1), { cwd: opts.cwd ?? cmd.cwd, env, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

/** The interesting lines of a failed command's output, redacted and shortened. */
export function failureLines(r: ExecResult, max = 15, pick?: RegExp): string[] {
  // eslint-disable-next-line no-control-regex
  const text = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const re = pick ?? /\b(?:error|fail(?:ed|ing|ure)?|FAIL|not ok|✗|×|AssertionError|Expected|Received|TS\d{4})\b/i;
  let hits = lines.filter((l) => re.test(l));
  if (!hits.length) hits = lines.slice(-max);
  const out = hits.slice(0, max).map((l) => redactText(l.trim()).slice(0, 240));
  if (r.timedOut) out.unshift('timed out (raise gate.timeoutsMs in the config if the repository is slow)');
  return out;
}
