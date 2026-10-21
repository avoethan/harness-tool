/**
 * Per-step result cache: ~/.harness/runs/<repoId>/<task>/gate-cache.json
 *
 *   { version: 1, entries: { "<step>": { key, status, reasons, durationMs, at } } }
 *
 * A step's key hashes the step name, the base commit, the gate's own config
 * and code version, and the blobs of the inputs that step depends on (a
 * subset of the tree, the way `git write-tree` of those inputs would). A
 * re-run after a one-file fix therefore repeats only the steps whose inputs
 * include that file. Passing results are reused; failing results are reused
 * only for deterministic steps (file checks), never for steps that run the
 * repository's commands, so a flaky failure is retried.
 */
import * as path from 'node:path';
import type { TreeEntry } from './context';
import { readJsonOr, writeJson } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { packageRoot } from '../lib/paths';

/** Bump when a step's logic changes in a way that makes old results wrong. */
export const GATE_LOGIC_VERSION = 1;

export interface CacheEntry {
  key: string;
  status: 'pass' | 'fail';
  reasons: string[];
  durationMs: number;
  at: string;
}

export interface GateCacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

let toolVersion: string | null = null;
function harnessVersion(): string {
  if (toolVersion === null) toolVersion = readJsonOr<{ version?: string }>(path.join(packageRoot(), 'package.json'), {}).version ?? '0';
  return toolVersion;
}

export function cachePath(runDir: string): string {
  return path.join(runDir, 'gate-cache.json');
}

export function loadCache(runDir: string): GateCacheFile {
  const c = readJsonOr<GateCacheFile | null>(cachePath(runDir), null);
  if (!c || c.version !== 1 || !c.entries || typeof c.entries !== 'object') return { version: 1, entries: {} };
  return c;
}

export function saveCache(runDir: string, c: GateCacheFile): void {
  writeJson(cachePath(runDir), c);
}

/** The cache key of one step. */
export function stepKey(step: string, base: string, configHash: string, inputs: string[]): string {
  return sha256(JSON.stringify([GATE_LOGIC_VERSION, harnessVersion(), step, base, configHash, ...inputs]));
}

/** Digest of the tree entries a predicate selects (mode, blob and path of each), like a write-tree of that subset. */
export function entriesDigest(entries: Map<string, TreeEntry>, pick: (rel: string) => boolean): string {
  const lines: string[] = [];
  for (const [p, e] of entries) if (pick(p)) lines.push(`${e.mode} ${e.blob} ${p}`);
  lines.sort();
  return sha256(lines.join('\n'));
}

/** Look a step up: the entry when its key matches and it may be reused. */
export function lookup(c: GateCacheFile, step: string, key: string, reuseFail: boolean): CacheEntry | null {
  const e = c.entries[step];
  if (!e || e.key !== key) return null;
  if (e.status === 'pass' || (e.status === 'fail' && reuseFail)) return e;
  return null;
}

export function store(c: GateCacheFile, step: string, e: CacheEntry): void {
  c.entries[step] = e;
}
