import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256File } from './hash';
import { configPath, harnessHome, manifestPath, packageRoot } from './paths';
import { readJsonOr, writeJson } from './fsx';

export interface IntegrityManifest {
  version: 1;
  writtenAt: string;
  files: Record<string, string>; // absolute path -> sha256
}

export function integrityPath(): string {
  return path.join(harnessHome(), 'integrity.json');
}

/** Protected files that may legitimately be absent (before install, after uninstall). */
function optionalProtected(): Set<string> {
  return new Set([configPath(), manifestPath()]);
}

/**
 * The files whose hashes the hooks verify before trusting themselves: the
 * hook entry, the hook and guard modules, config.json and the machine
 * manifest (what undo/uninstall trust). The lifecycle re-signs after every
 * write to the last two.
 */
export function protectedFiles(): string[] {
  const root = packageRoot();
  const list = [path.join(root, 'dist', 'src', 'hook.js'), configPath(), manifestPath()];
  const hooksDir = path.join(root, 'dist', 'src', 'hooks');
  try {
    for (const f of fs.readdirSync(hooksDir)) if (f.endsWith('.js')) list.push(path.join(hooksDir, f));
  } catch {
    /* not built */
  }
  const guardDir = path.join(root, 'dist', 'src', 'guard');
  try {
    for (const f of fs.readdirSync(guardDir)) if (f.endsWith('.js')) list.push(path.join(guardDir, f));
  } catch {
    /* none */
  }
  return list;
}

/** Called by `harness config`, `apply` and `self-update` after writing. */
export function writeIntegrity(): IntegrityManifest {
  const files: Record<string, string> = {};
  for (const f of protectedFiles()) {
    const h = sha256File(f);
    if (h) files[f] = h;
  }
  const m: IntegrityManifest = { version: 1, writtenAt: new Date().toISOString(), files };
  writeJson(integrityPath(), m);
  return m;
}

/**
 * Verify. When no manifest exists yet (fresh checkout, tests), integrity
 * passes unless HARNESS_REQUIRE_INTEGRITY=1: the install step writes it.
 */
export function verifyIntegrity(): { ok: true } | { ok: false; reason: string } {
  const m = readJsonOr<IntegrityManifest | null>(integrityPath(), null);
  if (!m) {
    if (process.env.HARNESS_REQUIRE_INTEGRITY === '1') return { ok: false, reason: 'no integrity manifest' };
    return { ok: true };
  }
  for (const [f, h] of Object.entries(m.files)) {
    const cur = sha256File(f);
    if (cur === null) {
      if (optionalProtected().has(f)) continue; // config/manifest may be absent before install
      return { ok: false, reason: `missing ${path.basename(f)}` };
    }
    if (cur !== h) return { ok: false, reason: `changed ${path.basename(f)}` };
  }
  return { ok: true };
}
