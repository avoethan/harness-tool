/**
 * Backups: a copy of every file apply touches, under
 *
 *   ~/.harness/backups/<planId>/<stamp>/<mirrored absolute path>
 *
 * The mirror keeps the whole absolute path under a safe folder name, so a
 * backup can always be traced back to where it came from:
 *
 *   /home/me/.claude/settings.json      -> home/me/.claude/settings.json
 *   C:\Users\me\.codex\hooks.json       -> c/Users/me/.codex/hooks.json
 *   \\server\share\x\AGENTS.md          -> unc/server/share/x/AGENTS.md
 *
 * Next to the mirrored files, `manifest.json` holds the per-plan record: the
 * files and settings edits that one apply made, and the apply commit when
 * the personal setting made one. undo reads it; uninstall reads the
 * cumulative manifest instead (see manifest.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Manifest, Setting } from '../types';
import { ensureDir, readJsonOr, writeJson } from '../lib/fsx';
import { sha256, sha256File } from '../lib/hash';
import { backupsDir } from '../lib/paths';

export interface BackupRecord {
  /** The original absolute path. */
  path: string;
  /** Absolute path of the backup copy. */
  backup: string;
  /** sha256 of the backed-up bytes. */
  sha: string;
}

/** What one apply did, stored with its backups so a specific plan can be undone. */
export interface PlanRecord extends Manifest {
  planId: string;
  stamp: string;
  setting: Setting;
  repoRoot?: string;
  /** The `harness: apply <planId>` commit in the personal setting, when made. */
  commit?: string;
  /** Where the cumulative manifest lived at apply time. */
  manifestPath: string;
  /** Set when this apply was undone; uninstall then leaves the record alone (it keeps the record and its backups). */
  undoneAt?: string;
}

/** A folder-safe timestamp (ISO 8601 with ':' replaced, since ':' is not allowed on Windows). */
export function newBackupStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-');
}

/** Mirror an absolute path (any platform's spelling) under a relative, forward-slash folder path. */
export function mirrorPath(absPath: string): string {
  let p = absPath.replace(/\\/g, '/');
  let prefix = '';
  const drive = /^([A-Za-z]):\//.exec(p);
  if (drive) {
    prefix = drive[1].toLowerCase();
    p = p.slice(3);
  } else if (p.startsWith('//')) {
    prefix = 'unc';
    p = p.slice(2);
  } else if (p.startsWith('/')) {
    p = p.slice(1);
  }
  const parts = p
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .map((s) => (s === '..' ? '__' : s.replace(/[:*?"<>|]/g, '_')));
  return [prefix, ...parts].filter(Boolean).join('/');
}

export function backupRoot(planId: string, stamp: string): string {
  return path.join(backupsDir(), safeName(planId), safeName(stamp));
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_') || 'x';
}

/** Copy `absPath` into the backup folder. Returns null when the file does not exist. */
export function backupFile(planId: string, stamp: string, absPath: string): BackupRecord | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  const dest = path.join(backupRoot(planId, stamp), ...mirrorPath(path.resolve(absPath)).split('/'));
  ensureDir(path.dirname(dest));
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
  return { path: path.resolve(absPath), backup: dest, sha: sha256(bytes) };
}

/**
 * Put a backup copy back at `absPath` (atomic: temp file + rename). The bytes
 * are restored exactly as they were, which is the point of a backup, so no
 * hidden-Unicode scan runs here. Returns the sha256 of what was written.
 */
export function restoreFromBackup(backupPath: string, absPath: string): string {
  const bytes = fs.readFileSync(backupPath);
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, absPath);
  const sha = sha256File(absPath);
  if (sha !== sha256(bytes)) throw new Error(`restore of ${absPath} did not land intact`);
  return sha;
}

export function planRecordPath(planId: string, stamp: string): string {
  return path.join(backupRoot(planId, stamp), 'manifest.json');
}

export function savePlanRecord(rec: PlanRecord): string {
  const p = planRecordPath(rec.planId, rec.stamp);
  writeJson(p, rec);
  return p;
}

/** Stamps recorded for a plan, newest first. */
export function listPlanStamps(planId: string): string[] {
  const dir = path.join(backupsDir(), safeName(planId));
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Plan ids that have backups, newest apply first. */
export function listPlanIds(): Array<{ planId: string; stamp: string }> {
  const out: Array<{ planId: string; stamp: string }> = [];
  try {
    for (const e of fs.readdirSync(backupsDir(), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const stamps = listPlanStamps(e.name);
      if (stamps.length) out.push({ planId: e.name, stamp: stamps[0] });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/** The record of a plan's latest apply (or of one stamp), null when none. */
export function loadPlanRecord(planId: string, stamp?: string): PlanRecord | null {
  const s = stamp ?? listPlanStamps(planId)[0];
  if (!s) return null;
  const rec = readJsonOr<PlanRecord | null>(planRecordPath(planId, s), null);
  if (!rec || rec.version !== 1 || !Array.isArray(rec.files)) return null;
  rec.settingsEdits ??= [];
  rec.createdDirs ??= [];
  return rec;
}
