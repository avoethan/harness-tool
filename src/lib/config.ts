import { readJsonOr, writeJson } from './fsx';
import { configPath } from './paths';
import { hashJson } from './hash';
import { DEFAULT_CAPS, type HarnessConfig } from '../types';

export function defaultConfig(partial: Partial<HarnessConfig> = {}): HarnessConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    setting: 'team',
    agents: ['devin', 'claude', 'codex'],
    workspaceRoot: process.cwd(),
    repos: [],
    db: { allowlist: [] },
    mcp: { allowedServers: {} },
    caps: { ...DEFAULT_CAPS },
    include: [],
    reviews: { source: 'none' },
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function loadConfig(): HarnessConfig | null {
  const c = readJsonOr<HarnessConfig | null>(configPath(), null);
  return c && c.version === 1 ? c : null;
}

export function saveConfig(c: HarnessConfig): void {
  c.updatedAt = new Date().toISOString();
  writeJson(configPath(), c);
}

/** The hash the guard checks before trusting the DB allowlist. */
export function allowlistHash(c: HarnessConfig): string {
  return hashJson(c.db.allowlist);
}

import * as path from 'node:path';
import { nearestRepoRoot } from './git';
import { sha256 } from './hash';
import { slug } from './paths';

/** Personal-setting config file committed in a repo. */
export function repoConfigPath(repoRoot: string): string {
  return path.join(repoRoot, '.harness', 'config.json');
}

export interface ResolvedConfig {
  config: HarnessConfig;
  /** Where the overlay came from, if any. */
  repoRoot: string | null;
  source: 'machine' | 'repo+machine' | 'default';
}

/**
 * Effective config for a working directory: the machine config overlaid with
 * `<repoRoot>/.harness/config.json` when the nearest git root carries one.
 * DB allowlist, MCP allowlist and caps always come from the machine config.
 */
export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig {
  const machine = loadConfig();
  const repoRoot = nearestRepoRoot(cwd);
  const overlay = repoRoot ? readJsonOr<Partial<HarnessConfig> | null>(repoConfigPath(repoRoot), null) : null;
  if (!machine && !overlay) return { config: defaultConfig({ workspaceRoot: repoRoot ?? cwd }), repoRoot, source: 'default' };
  const base = machine ?? defaultConfig({ workspaceRoot: repoRoot ?? cwd });
  if (!overlay) return { config: base, repoRoot, source: 'machine' };
  const merged: HarnessConfig = {
    ...base,
    ...overlay,
    version: 1,
    db: base.db,
    mcp: base.mcp,
    caps: base.caps,
    workspaceRoot: overlay.workspaceRoot ?? repoRoot ?? base.workspaceRoot,
  };
  return { config: merged, repoRoot, source: 'repo+machine' };
}

/** Stable repo id: slug of the folder name plus a short hash of the absolute path. */
export function repoIdFor(repoPath: string): string {
  const abs = path.resolve(repoPath);
  return `${slug(path.basename(abs))}-${sha256(abs.replace(/\\/g, '/').toLowerCase()).slice(0, 6)}`;
}
