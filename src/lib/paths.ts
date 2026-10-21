import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentId } from '../types';

export const isWindows = process.platform === 'win32';

/** The user's home directory. Tests override it with HARNESS_USER_HOME. */
export function userHome(): string {
  return process.env.HARNESS_USER_HOME || os.homedir();
}

/** Harness state root. Tests override it with HARNESS_HOME. Default `~/.harness`. */
export function harnessHome(): string {
  return process.env.HARNESS_HOME || path.join(userHome(), '.harness');
}

/**
 * Task worktrees (`harness run`, `harness land`): a sibling of the harness home (`~/.harness-worktrees`
 * by default), never inside it. The agent edits its task there, while the harness state stays a
 * protected root the agent cannot write (the guard and the permission rules deny `~/.harness/**`).
 */
export function worktreesHome(): string {
  const hh = path.resolve(harnessHome());
  return path.join(path.dirname(hh), `${path.basename(hh)}-worktrees`);
}

/**
 * The inbox: where the agent saves a pasted ticket before `harness intake --from <file>`
 * (`~/.harness-inbox` by default). A sibling of the state folder for the same reason as the
 * worktrees: the agent must be able to write there, and `~/.harness/**` is protected. The
 * install pre-approves the agents' file tools for this folder, so a headless or
 * non-interactive session is not stopped by a "write outside the workspace" prompt
 * (found by the Devin CLI behaviour check, 2026-10-20: Devin's print mode ends the
 * run at the first unapproved tool call).
 */
export function inboxHomeFor(hh: string): string {
  const abs = path.resolve(hh);
  return path.join(path.dirname(abs), `${path.basename(abs)}-inbox`);
}

export function inboxHome(): string {
  return inboxHomeFor(harnessHome());
}

/** Root of the installed harness package (the folder holding package.json). */
export function packageRoot(): string {
  // dist/src/lib/paths.js -> ../../.. ; src/lib/paths.ts (ts-node) -> ../..
  const here = __dirname;
  const parts = here.split(path.sep);
  const idx = parts.lastIndexOf('dist');
  if (idx >= 0) return parts.slice(0, idx).join(path.sep);
  return path.resolve(here, '..', '..');
}

/** The hook entry point as an absolute, forward-slash path (byte-stable across updates). */
export function hookEntryPath(): string {
  return toPosix(path.join(packageRoot(), 'dist', 'src', 'hook.js'));
}

/** User-level config home for an agent. */
export function agentHome(agent: AgentId): string {
  const home = userHome();
  switch (agent) {
    case 'claude':
      return path.join(home, '.claude');
    case 'codex':
      return path.join(home, '.codex');
    case 'devin':
      if (isWindows && process.env.APPDATA) return path.join(process.env.APPDATA, 'devin');
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'devin');
  }
}

/** Shared Agent Skills folder read by Devin and Codex. */
export function sharedSkillsHome(): string {
  return path.join(userHome(), '.agents', 'skills');
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function subPath(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'x';
}

export function runsDir(): string {
  return path.join(harnessHome(), 'runs');
}
export function stateDir(): string {
  return path.join(harnessHome(), 'state');
}
export function logsDir(): string {
  return path.join(harnessHome(), 'logs');
}
export function backupsDir(): string {
  return path.join(harnessHome(), 'backups');
}
export function configPath(): string {
  return path.join(harnessHome(), 'config.json');
}
export function manifestPath(): string {
  return path.join(harnessHome(), 'manifest.json');
}
export function ledgerPath(): string {
  return path.join(harnessHome(), 'ledger', 'ledger.json');
}
