/**
 * Manifest: the record of every file the harness owns (DESIGN §2.3).
 *
 *   team setting      ~/.harness/manifest.json          (machine manifest)
 *   personal setting  <repoRoot>/.harness/manifest.json (committed with the repo)
 *
 * The manifest is cumulative: one entry per path. When a later plan touches a
 * path the harness already owns, the entry keeps the ORIGINAL before-state
 * (hash and backup), so `uninstall` restores what was there before the harness
 * ever touched the file. Per-plan records (what one apply did) live next to
 * that plan's backups; see backup.ts.
 *
 * Classification by hash:
 *   pristine  the file is exactly what the harness wrote (hash == afterSha)
 *   modified  the file exists but was edited since apply
 *   missing   the file is gone
 *   foreign   the path is not in the manifest at all (not owned)
 */
import * as path from 'node:path';
import type { Manifest, ManifestFile, Setting, SettingsEdit } from '../types';
import { readJsonOr, writeJson } from '../lib/fsx';
import { sha256File } from '../lib/hash';
import { writeIntegrity, type IntegrityManifest } from '../lib/integrity';
import { instrument } from '../lib/log';
import { isWindows, manifestPath } from '../lib/paths';
import { harnessVersion } from '../cli';

export type FileState = 'pristine' | 'modified' | 'missing';
export type PathState = FileState | 'foreign';

/** Where the manifest lives for a setting. Personal needs the repo root. */
export function manifestPathFor(setting: Setting, repoRoot?: string | null): string {
  if (setting === 'personal') {
    if (!repoRoot) throw new Error('personal setting: the repository root is required to locate .harness/manifest.json');
    return path.join(repoRoot, '.harness', 'manifest.json');
  }
  return manifestPath();
}

export function emptyManifest(): Manifest {
  return { version: 1, harnessVersion: harnessVersion(), files: [], settingsEdits: [], createdDirs: [] };
}

/** Load a manifest; null when absent or not a version-1 manifest. */
export function loadManifest(p: string): Manifest | null {
  const m = readJsonOr<Manifest | null>(p, null);
  if (!m || m.version !== 1 || !Array.isArray(m.files)) return null;
  if (!Array.isArray(m.settingsEdits)) m.settingsEdits = [];
  if (!Array.isArray(m.createdDirs)) m.createdDirs = [];
  return m;
}

export function saveManifest(p: string, m: Manifest): void {
  m.harnessVersion = harnessVersion();
  writeJson(p, m);
}

/** Normalise a path for comparison (resolved; case-folded on Windows). */
export function pathKey(p: string): string {
  const r = path.resolve(p);
  return isWindows ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Every path the manifest owns: files plus the settings files it edited. */
export function ownedPaths(m: Manifest): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of m.files) {
    const k = pathKey(f.path);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f.path);
    }
  }
  for (const e of m.settingsEdits) {
    const k = pathKey(e.path);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e.path);
    }
  }
  return out;
}

export function findEntry(m: Manifest, p: string): ManifestFile | undefined {
  return m.files.find((f) => samePath(f.path, p));
}

/**
 * State of one manifest entry, by the hash of the file now. An entry whose
 * afterSha is empty records a file the harness deleted: it is pristine while
 * the file is still absent, and modified when something re-created it.
 */
export function classifyEntry(entry: ManifestFile): FileState {
  const cur = sha256File(entry.path);
  if (entry.afterSha === '') return cur === null ? 'pristine' : 'modified';
  if (cur === null) return 'missing';
  return cur === entry.afterSha ? 'pristine' : 'modified';
}

/** State of an arbitrary path against the manifest. */
export function classifyPath(m: Manifest, p: string): PathState {
  const entry = findEntry(m, p);
  if (!entry) return 'foreign';
  return classifyEntry(entry);
}

/**
 * Add or replace an entry. When the harness already owned the path and the
 * file was still pristine when the new plan read it (the chain is intact),
 * the original before-state and backup are kept and only afterSha moves.
 */
export function mergeEntry(m: Manifest, entry: ManifestFile): ManifestFile {
  const idx = m.files.findIndex((f) => samePath(f.path, entry.path));
  if (idx < 0) {
    m.files.push(entry);
    return entry;
  }
  const prev = m.files[idx];
  const chained = prev.afterSha === entry.beforeSha;
  const merged: ManifestFile = chained
    ? { ...entry, beforeSha: prev.beforeSha, backup: prev.backup }
    : entry;
  m.files[idx] = merged;
  return merged;
}

export function removeEntry(m: Manifest, p: string): boolean {
  const before = m.files.length;
  m.files = m.files.filter((f) => !samePath(f.path, p));
  return m.files.length !== before;
}

export function addSettingsEdit(m: Manifest, e: SettingsEdit): void {
  const idx = m.settingsEdits.findIndex((x) => samePath(x.path, e.path) && x.key === e.key);
  if (idx < 0) m.settingsEdits.push(e);
  else {
    // Same key edited again: keep the original "before", take the new "after".
    const prev = m.settingsEdits[idx];
    m.settingsEdits[idx] = { ...e, before: prev.before };
  }
}

export function removeSettingsEdit(m: Manifest, p: string, key: string): void {
  m.settingsEdits = m.settingsEdits.filter((x) => !(samePath(x.path, p) && x.key === key));
}

export function addCreatedDirs(m: Manifest, dirs: string[]): void {
  const set = new Set((m.createdDirs ?? []).map(pathKey));
  for (const d of dirs) {
    if (!set.has(pathKey(d))) {
      set.add(pathKey(d));
      (m.createdDirs ??= []).push(d);
    }
  }
  // Deepest first, so uninstall can remove children before parents.
  m.createdDirs = (m.createdDirs ?? []).sort((a, b) => b.length - a.length);
}

/**
 * Manifest-aware integrity re-signing. Every lifecycle write that changes a
 * protected file (config.json, the machine manifest) ends here, so the hooks
 * keep trusting themselves. Instrumented with counts only.
 */
export function resignIntegrity(trigger: string): IntegrityManifest {
  const im = writeIntegrity();
  instrument({ event: 'integrity.resign', ids: { trigger }, counts: { files: Object.keys(im.files).length } });
  return im;
}
