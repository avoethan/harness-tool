/**
 * Runner for Claude Code behaviour tests: an isolated HOME seeded with the
 * settings under test, a headless `claude -p` run, and the parsed JSON result.
 * Tests that use it must skip when `claude` is not on PATH or not logged in.
 *
 * Isolation: HOME is a temp folder; the Claude login is read from the real
 * ~/.claude.json credentials only when CLAUDE_CONFIG_DIR is unset, so we copy
 * the credential file into the temp HOME when present (the only credential
 * allowed in a probe, per the harness's isolation rules).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  /** Written to <home>/.claude/settings.json */
  userSettings?: Record<string, unknown>;
  /** Extra files to write under the temp HOME, relative path -> content. */
  homeFiles?: Record<string, string>;
  maxTurns?: number;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ClaudeRunResult {
  ok: boolean;
  exitCode: number | null;
  home: string;
  result?: string;
  json?: any;
  permissionDenials?: any[];
  costUsd?: number;
  numTurns?: number;
  stderr: string;
  stdout: string;
}

export function claudeAvailable(): { ok: true; version: string } | { ok: false; reason: string } {
  if (process.env.HARNESS_SKIP_CLAUDE === '1') return { ok: false, reason: 'HARNESS_SKIP_CLAUDE=1' };
  const bin = which('claude');
  if (!bin) return { ok: false, reason: 'claude not on PATH' };
  const v = run('claude', ['--version'], { timeoutMs: 20000 });
  if (v.code !== 0) return { ok: false, reason: 'claude --version failed' };
  return { ok: true, version: v.stdout.trim() };
}

export function makeIsolatedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-home-'));
  copyClaudeLogin(home);
  return home;
}

/** Carry the Claude login into an existing isolated HOME (the only credential allowed), nothing else. */
export function copyClaudeLogin(home: string): void {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const realHome = os.homedir();
  for (const f of ['.claude.json']) {
    const src = path.join(realHome, f);
    if (fs.existsSync(src)) {
      try {
        const j = JSON.parse(fs.readFileSync(src, 'utf8'));
        const keep: Record<string, unknown> = {};
        for (const k of ['oauthAccount', 'hasCompletedOnboarding', 'primaryApiKey', 'userID', 'numStartups']) if (k in j) keep[k] = j[k];
        keep.hasCompletedOnboarding = true;
        fs.writeFileSync(path.join(home, f), JSON.stringify(keep));
      } catch {
        fs.copyFileSync(src, path.join(home, f));
      }
    }
  }
  const cred = path.join(realHome, '.claude', '.credentials.json');
  if (fs.existsSync(cred)) fs.copyFileSync(cred, path.join(home, '.claude', '.credentials.json'));
}

export function runClaude(opts: ClaudeRunOptions): ClaudeRunResult {
  const home = makeIsolatedHome();
  if (opts.userSettings) {
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(opts.userSettings, null, 2));
  }
  for (const [rel, content] of Object.entries(opts.homeFiles ?? {})) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const args = ['-p', opts.prompt, '--output-format', 'json', '--max-turns', String(opts.maxTurns ?? 6)];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools);
  if (opts.disallowedTools?.length) args.push('--disallowedTools', ...opts.disallowedTools);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_TELEMETRY: '1',
    ...opts.env,
  };
  delete env.CLAUDE_CONFIG_DIR;
  const r = run('claude', args, { cwd: opts.cwd, env, timeoutMs: opts.timeoutMs ?? 180000 });
  const out: ClaudeRunResult = { ok: r.code === 0, exitCode: r.code, home, stderr: r.stderr, stdout: r.stdout };
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}');
    out.json = j;
    out.result = j.result;
    out.permissionDenials = j.permission_denials;
    out.costUsd = j.total_cost_usd;
    out.numTurns = j.num_turns;
  } catch {
    /* non-JSON output */
  }
  return out;
}

/** A hook config entry pointing at the harness hook entry for one event. */
export function harnessHookEntry(hookJs: string, event: string, matcher?: string, timeout = 20): Record<string, unknown> {
  const entry: Record<string, unknown> = { hooks: [{ type: 'command', command: `node "${hookJs}" ${event}`, timeout }] };
  if (matcher !== undefined) entry.matcher = matcher;
  return entry;
}
