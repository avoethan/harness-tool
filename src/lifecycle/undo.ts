/**
 * undoPlan(planId?) and uninstall(): the reverse of apply (DESIGN §2.3).
 *
 * For one plan (its per-plan record under backups/<planId>/<stamp>/):
 *
 *  1. Personal setting with an apply commit: `git revert --no-edit <commit>`
 *     first, when HEAD still contains it (never reset, never amend). A revert
 *     that fails (conflict, dirty path) is aborted and reported; the files are
 *     then restored from the backups instead.
 *  2. Every file whose hash now equals the recorded afterSha is restored from
 *     its backup, or deleted when beforeSha was null. A file whose hash
 *     differs is "edited since apply; kept" and listed with its backup path.
 *     A kept settings file still has the harness's merge-json entries removed:
 *     only the entries the harness added that are still present, never
 *     anything else.
 *  3. The cumulative manifest releases the plan's entries (stepping back one
 *     link when a later plan chained on an earlier one), empty folders the
 *     plan created are removed, integrity is re-signed.
 *
 * uninstall undoes every plan recorded for the manifest, newest first, then
 * restores whatever the manifest still owns from the original backups, removes
 * the empty harness-created folders and the manifest. Backups are kept.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManifestFile, Setting, SettingsEdit } from '../types';
import { exists, isDir, readTextOr, removeFile, writeTextAtomic } from '../lib/fsx';
import { sha256, sha256File } from '../lib/hash';
import { parseJsonc } from '../lib/jsonc';
import { headSha, rawGit } from '../lib/git';
import { instrument } from '../lib/log';
import { backupsDir, harnessHome } from '../lib/paths';
import { scanHiddenUnicode } from '../lib/unicode';
import { splitKey, verifyWritten } from './apply';
import { listPlanIds, listPlanStamps, loadPlanRecord, restoreFromBackup, savePlanRecord, type PlanRecord } from './backup';
import { emptyManifest, loadManifest, manifestPathFor, pathKey, resignIntegrity, samePath, saveManifest } from './manifest';
import type { Manifest } from '../types';

export interface UndoOptions {
  /** Report what would happen; write nothing. */
  dryRun?: boolean;
}

export type RestoreHow = 'backup' | 'deleted' | 'already-before' | 'revert';

export interface UndoRestored {
  path: string;
  how: RestoreHow;
}

export interface UndoKept {
  path: string;
  reason: string;
  /** Where the pre-apply copy is, for a restore by hand. */
  backup: string | null;
}

export interface SettingsReversal {
  path: string;
  /** Dotted keys whose harness-added entries were removed. */
  keys: string[];
  /** Keys whose entries were already gone or changed by the user (nothing removed). */
  untouched: string[];
}

export interface UndoResult {
  ok: boolean;
  planId: string;
  stamp: string;
  setting: Setting;
  dryRun: boolean;
  manifestPath: string;
  backupDir: string;
  restored: UndoRestored[];
  kept: UndoKept[];
  settingsReversed: SettingsReversal[];
  /** The revert commit made, when the apply commit was reverted. */
  reverted: string | null;
  removedDirs: string[];
  notes: string[];
}

export interface UninstallOptions extends UndoOptions {
  setting?: Setting;
  repoRoot?: string | null;
}

export interface UninstallResult {
  ok: boolean;
  setting: Setting;
  dryRun: boolean;
  manifestPath: string;
  /** Where every backup still is. */
  backupsDir: string;
  plans: UndoResult[];
  restored: UndoRestored[];
  kept: UndoKept[];
  settingsReversed: SettingsReversal[];
  removedDirs: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// undo one plan
// ---------------------------------------------------------------------------

/** Undo a plan by id (its latest apply), or the most recent apply when no id is given. */
export async function undoPlan(planId?: string, opts: UndoOptions = {}): Promise<UndoResult | { ok: false; error: string }> {
  let id = planId;
  if (!id) {
    const latest = listPlanIds()[0];
    if (!latest) return { ok: false, error: `nothing to undo: no applied plan has backups under ${backupsDir()}` };
    id = latest.planId;
  }
  const rec = loadPlanRecord(id);
  if (!rec) return { ok: false, error: `no apply record for plan "${id}" under ${backupsDir()} (was it applied?)` };
  return undoRecord(rec, opts);
}

/** Undo exactly what one apply record did. */
export async function undoRecord(rec: PlanRecord, opts: UndoOptions = {}): Promise<UndoResult> {
  const dryRun = !!opts.dryRun;
  const res: UndoResult = {
    ok: true,
    planId: rec.planId,
    stamp: rec.stamp,
    setting: rec.setting,
    dryRun,
    manifestPath: rec.manifestPath,
    backupDir: path.join(backupsDir(), rec.planId, rec.stamp),
    restored: [],
    kept: [],
    settingsReversed: [],
    reverted: null,
    removedDirs: [],
    notes: [],
  };
  const cumulative = loadManifest(rec.manifestPath) ?? emptyManifest();

  // 1. revert the apply commit first, so the committed paths come back through git
  if (rec.setting === 'personal' && rec.commit && rec.repoRoot) {
    revertApplyCommit(rec.repoRoot, rec.commit, rec.planId, dryRun, res);
  }

  // 2. files, newest write first
  const editsByPath = groupEdits(rec.settingsEdits);
  for (const f of [...rec.files].reverse()) {
    const edits = editsByPath.get(pathKey(f.path)) ?? [];
    restoreOne(f, edits, dryRun, res);
    editsByPath.delete(pathKey(f.path));
  }
  // settings edits whose file is not in the record's file list (defensive)
  for (const [, edits] of editsByPath) reverseSettingsFile(edits[0].path, edits, dryRun, res);

  // 3. release the plan's entries from the cumulative manifest
  for (const f of rec.files) releaseFile(cumulative, f);
  for (const e of rec.settingsEdits) releaseEdit(cumulative, e);
  res.removedDirs = removeEmptyDirs(rec.createdDirs ?? [], dryRun);
  cumulative.createdDirs = (cumulative.createdDirs ?? []).filter((d) => !res.removedDirs.some((r) => samePath(r, d)));
  if (!dryRun) {
    finishManifest(rec.manifestPath, cumulative, rec.setting, res.notes);
    resignIntegrity('undo');
    // mark the record, so a later uninstall does not undo (and release) this apply a second time
    try {
      savePlanRecord({ ...rec, undoneAt: new Date().toISOString() });
    } catch {
      res.notes.push(`could not mark the record of ${rec.planId} as undone`);
    }
  }
  instrument({
    event: 'undo',
    ids: { plan: rec.planId, setting: rec.setting },
    counts: { restored: res.restored.length, kept: res.kept.length, reversed: res.settingsReversed.length, reverted: res.reverted ? 1 : 0 },
  });
  return res;
}

function groupEdits(edits: SettingsEdit[]): Map<string, SettingsEdit[]> {
  const m = new Map<string, SettingsEdit[]>();
  for (const e of edits) {
    const k = pathKey(e.path);
    const arr = m.get(k) ?? [];
    arr.push(e);
    m.set(k, arr);
  }
  return m;
}

/** Restore one manifest entry by hash; a kept settings file still has its harness entries removed. */
function restoreOne(f: ManifestFile, edits: SettingsEdit[], dryRun: boolean, res: UndoResult): void {
  const cur = sha256File(f.path);
  const backupOk = !!f.backup && exists(f.backup);

  if (f.afterSha === '') {
    // the harness deleted this file
    if (cur === null) {
      if (!backupOk) {
        res.kept.push({ path: f.path, reason: 'the harness deleted it and no backup copy was found', backup: f.backup });
        return;
      }
      if (!dryRun) restoreFromBackup(f.backup!, f.path);
      res.restored.push({ path: f.path, how: 'backup' });
      return;
    }
    if (cur === f.beforeSha) {
      res.restored.push({ path: f.path, how: 'already-before' });
      return;
    }
    res.kept.push({ path: f.path, reason: 'created again since the harness deleted it; kept', backup: f.backup });
    return;
  }

  if (cur === f.afterSha) {
    // pristine
    if (f.beforeSha === null) {
      if (!dryRun) removeFile(f.path);
      res.restored.push({ path: f.path, how: 'deleted' });
      return;
    }
    if (!backupOk) {
      res.kept.push({ path: f.path, reason: 'no backup copy found to restore from; kept', backup: f.backup });
      return;
    }
    if (!dryRun) {
      const sha = restoreFromBackup(f.backup!, f.path);
      if (sha !== f.beforeSha) res.notes.push(`${f.path}: the backup copy does not hash to the recorded before-state (restored anyway)`);
    }
    res.restored.push({ path: f.path, how: 'backup' });
    return;
  }
  if (cur === f.beforeSha || (cur === null && f.beforeSha === null)) {
    res.restored.push({ path: f.path, how: 'already-before' });
    return;
  }
  if (cur === null) {
    res.notes.push(`${f.path}: already gone; nothing to restore`);
    res.restored.push({ path: f.path, how: 'already-before' });
    return;
  }
  // edited since apply
  res.kept.push({ path: f.path, reason: 'edited since apply; kept', backup: f.backup });
  if (edits.length) reverseSettingsFile(f.path, edits, dryRun, res);
}

// ---------------------------------------------------------------------------
// merge-json reversal
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const J = (v: unknown) => JSON.stringify(v);

/**
 * Remove from `cur` only what the harness added (`after` minus `before`) and
 * is still present. Returns the new value, whether anything changed, and
 * whether the key should be dropped altogether (it did not exist before and
 * nothing of the user's is left in it).
 */
export function removeAdded(cur: unknown, before: unknown, after: unknown): { value: unknown; changed: boolean; remove: boolean } {
  if (Array.isArray(after) && Array.isArray(cur)) {
    const beforeSet = new Set(Array.isArray(before) ? before.map(J) : []);
    const added = new Set(after.filter((x) => !beforeSet.has(J(x))).map(J));
    const next = cur.filter((x) => !added.has(J(x)));
    const changed = next.length !== cur.length;
    const remove = before === undefined && next.length === 0;
    return { value: next, changed, remove };
  }
  if (isObj(after) && isObj(cur)) {
    const out: Record<string, unknown> = { ...cur };
    let changed = false;
    for (const k of Object.keys(after)) {
      if (!(k in out)) continue;
      const b = isObj(before) ? before[k] : undefined;
      const r = removeAdded(out[k], b, after[k]);
      if (r.remove) {
        delete out[k];
        changed = true;
      } else if (r.changed) {
        out[k] = r.value;
        changed = true;
      }
    }
    const remove = before === undefined && Object.keys(out).length === 0;
    return { value: out, changed, remove };
  }
  if (before === undefined && J(cur) === J(after)) return { value: undefined, changed: true, remove: true };
  return { value: cur, changed: false, remove: false };
}

/** Apply removeAdded at a dotted key inside a parsed document. True when the document changed. */
export function reverseEdit(doc: Record<string, unknown>, e: SettingsEdit): boolean {
  const keys = splitKey(e.key);
  let parent: Record<string, unknown> = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    const v = parent[keys[i]];
    if (!isObj(v)) return false;
    parent = v;
  }
  const last = keys[keys.length - 1];
  if (!(last in parent)) return false;
  const r = removeAdded(parent[last], e.before, e.after);
  if (r.remove) {
    delete parent[last];
    return true;
  }
  if (r.changed) {
    parent[last] = r.value;
    return true;
  }
  return false;
}

/** Remove the harness entries from a settings file the user edited after apply. */
function reverseSettingsFile(file: string, edits: SettingsEdit[], dryRun: boolean, res: UndoResult): void {
  const text = readTextOr(file, null);
  if (text === null) return;
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch (e) {
    res.notes.push(`${file}: cannot parse it to remove the harness entries (${(e as Error).message}); remove keys ${edits.map((x) => x.key).join(', ')} by hand`);
    return;
  }
  if (!isObj(doc)) {
    res.notes.push(`${file}: not a JSON object; harness entries not removed`);
    return;
  }
  const keys: string[] = [];
  const untouched: string[] = [];
  for (const e of edits) (reverseEdit(doc, e) ? keys : untouched).push(e.key);
  if (!keys.length) {
    res.settingsReversed.push({ path: file, keys, untouched });
    return;
  }
  const out = JSON.stringify(doc, null, 2) + '\n';
  if (scanHiddenUnicode(out).length) {
    res.notes.push(`${file}: carries hidden Unicode, so the harness will not rewrite it; remove keys ${keys.join(', ')} by hand`);
    return;
  }
  if (!dryRun) {
    writeTextAtomic(file, out);
    const v = verifyWritten(file, sha256(out));
    if (!v.ok) {
      res.ok = false;
      res.notes.push(`${file}: ${v.reason}`);
      return;
    }
    let hadComments = false;
    try {
      JSON.parse(text);
    } catch {
      hadComments = true;
    }
    if (hadComments) res.notes.push(`${file}: comments or trailing commas were not preserved (the pre-apply copy is in the backup)`);
  }
  res.settingsReversed.push({ path: file, keys, untouched });
}

// ---------------------------------------------------------------------------
// git revert
// ---------------------------------------------------------------------------

function headContains(repoRoot: string, commit: string): boolean {
  return rawGit(repoRoot, ['merge-base', '--is-ancestor', commit, 'HEAD'], 10000).code === 0;
}

function revertApplyCommit(repoRoot: string, commit: string, planId: string, dryRun: boolean, res: UndoResult): void {
  if (!isDir(repoRoot) || !headContains(repoRoot, commit)) {
    res.notes.push(`the apply commit ${commit.slice(0, 12)} is no longer in HEAD; files are restored from the backups without a revert`);
    return;
  }
  if (dryRun) {
    res.notes.push(`would revert commit ${commit.slice(0, 12)} (the apply commit of ${planId}) with git revert --no-edit`);
    return;
  }
  const before = headSha(repoRoot);
  // The revert of the harness's own apply commit: its subject follows the repository's commit-subject
  // standard (the pre-push gate checks every subject it pushes; `Revert "..."` is not a Conventional
  // Commits subject), and like the apply commit it is made with the repository's git hooks off.
  const { pickSubject } = require('../land/gitops') as typeof import('../land/gitops');
  const { repoIdFor } = require('../lib/config') as typeof import('../lib/config');
  const applySubject = rawGit(repoRoot, ['log', '-1', '--format=%s', commit], 10000).stdout.trim() || `harness: apply ${planId}`;
  const subject = pickSubject([`Revert "${applySubject}"`, `revert: ${applySubject}`], repoIdFor(repoRoot));
  const noHooks = path.join(harnessHome(), 'state', 'no-git-hooks');
  try {
    fs.mkdirSync(noHooks, { recursive: true });
  } catch {
    /* the commit below reports any failure */
  }
  let r = rawGit(repoRoot, ['revert', '--no-commit', commit], 60000);
  if (r.code === 0) r = rawGit(repoRoot, ['-c', `core.hooksPath=${noHooks}`, 'commit', '-q', '--allow-empty', '-m', subject, '-m', `This reverts commit ${commit}.`], 60000);
  if (r.code === 0) {
    const after = headSha(repoRoot);
    if (after && after !== before) {
      res.reverted = after;
      res.notes.push(`reverted the apply commit ${commit.slice(0, 12)} as ${after.slice(0, 12)}`);
      return;
    }
  }
  // abort a half-done revert, never leave the repository mid-operation
  const rh = rawGit(repoRoot, ['rev-parse', '--git-path', 'REVERT_HEAD'], 5000);
  if (rh.code === 0 && exists(path.resolve(repoRoot, rh.stdout.trim()))) rawGit(repoRoot, ['revert', '--abort'], 30000);
  res.notes.push(`could not revert ${commit.slice(0, 12)} (${(r.stderr || r.stdout).trim().split('\n')[0] || 'git revert failed'}); files are restored from the backups instead`);
}

// ---------------------------------------------------------------------------
// manifest release
// ---------------------------------------------------------------------------

/** Drop a plan's file entry from the cumulative manifest, or step the chain back one link. */
export function releaseFile(cum: Manifest, f: ManifestFile): void {
  const idx = cum.files.findIndex((x) => samePath(x.path, f.path));
  if (idx < 0) return;
  const prev = cum.files[idx];
  const chained = prev.afterSha === f.afterSha && prev.beforeSha !== f.beforeSha && f.beforeSha !== null;
  if (chained) cum.files[idx] = { ...prev, afterSha: f.beforeSha as string };
  else cum.files.splice(idx, 1);
}

export function releaseEdit(cum: Manifest, e: SettingsEdit): void {
  const idx = cum.settingsEdits.findIndex((x) => samePath(x.path, e.path) && x.key === e.key);
  if (idx < 0) return;
  const prev = cum.settingsEdits[idx];
  const chained = J(prev.after) === J(e.after) && J(prev.before) !== J(e.before) && e.before !== undefined;
  if (chained) cum.settingsEdits[idx] = { ...prev, after: e.before };
  else cum.settingsEdits.splice(idx, 1);
}

/** Remove the listed folders when empty, deepest first. Returns what was removed. */
export function removeEmptyDirs(dirs: string[], dryRun: boolean): string[] {
  const out: string[] = [];
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (!isDir(d) || fs.readdirSync(d).length) continue;
      if (!dryRun) fs.rmdirSync(d);
      out.push(d);
    } catch {
      /* leave it */
    }
  }
  return out;
}

/** Save the manifest, or remove it (and an empty .harness folder) when nothing is owned any more. */
function finishManifest(manifestP: string, cum: Manifest, setting: Setting, notes: string[]): void {
  if (cum.files.length || cum.settingsEdits.length) {
    saveManifest(manifestP, cum);
    if (setting === 'personal') notes.push(`manifest updated at ${manifestP}; commit it with your next change`);
    return;
  }
  removeFile(manifestP);
  const dir = path.dirname(manifestP);
  if (setting === 'personal') removeEmptyDirs([dir], false);
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

export async function uninstall(opts: UninstallOptions = {}): Promise<UninstallResult | { ok: false; error: string }> {
  const setting: Setting = opts.setting ?? (opts.repoRoot ? 'personal' : 'team');
  let manifestP: string;
  try {
    manifestP = manifestPathFor(setting, opts.repoRoot);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const dryRun = !!opts.dryRun;
  const res: UninstallResult = {
    ok: true,
    setting,
    dryRun,
    manifestPath: manifestP,
    backupsDir: backupsDir(),
    plans: [],
    restored: [],
    kept: [],
    settingsReversed: [],
    removedDirs: [],
    notes: [],
  };
  let cum = loadManifest(manifestP);
  if (!cum) {
    res.notes.push(`nothing installed: no manifest at ${manifestP}`);
    return res;
  }

  // 1. undo every recorded apply that still owns something here, newest first
  const records: PlanRecord[] = [];
  for (const { planId } of listPlanIds()) {
    for (const stamp of listPlanStamps(planId)) {
      const rec = loadPlanRecord(planId, stamp);
      if (rec && samePath(rec.manifestPath, manifestP)) records.push(rec);
    }
  }
  records.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  const owned = () => new Set([...cum!.files.map((f) => pathKey(f.path)), ...cum!.settingsEdits.map((e) => pathKey(e.path))]);
  for (const rec of records) {
    if (rec.undoneAt) continue; // undone before: its entries were released then
    const own = owned();
    const touches = rec.files.some((f) => own.has(pathKey(f.path))) || rec.settingsEdits.some((e) => own.has(pathKey(e.path)));
    if (!touches) continue;
    const r = await undoRecord(rec, { dryRun });
    res.plans.push(r);
    res.ok = res.ok && r.ok;
    if (dryRun) {
      // simulate the release so later records are not re-reported
      for (const f of rec.files) releaseFile(cum, f);
      for (const e of rec.settingsEdits) releaseEdit(cum, e);
    } else cum = loadManifest(manifestP) ?? emptyManifest();
  }

  // 2. whatever the manifest still owns (records lost): restore from the original backups
  if (cum.files.length || cum.settingsEdits.length) {
    const rest: UndoResult = { ...emptyUndo(manifestP, setting, dryRun) };
    const editsByPath = groupEdits(cum.settingsEdits);
    for (const f of [...cum.files].reverse()) {
      restoreOne(f, editsByPath.get(pathKey(f.path)) ?? [], dryRun, rest);
      editsByPath.delete(pathKey(f.path));
    }
    for (const [, edits] of editsByPath) reverseSettingsFile(edits[0].path, edits, dryRun, rest);
    res.restored.push(...rest.restored);
    res.kept.push(...rest.kept);
    res.settingsReversed.push(...rest.settingsReversed);
    res.notes.push(...rest.notes);
    res.ok = res.ok && rest.ok;
    cum.files = [];
    cum.settingsEdits = [];
  }
  for (const p of res.plans) {
    res.restored.push(...p.restored);
    res.kept.push(...p.kept);
    res.settingsReversed.push(...p.settingsReversed);
    res.removedDirs.push(...p.removedDirs);
    res.notes.push(...p.notes.map((n) => `${p.planId}: ${n}`));
  }

  // 3. folders, manifest, integrity
  const dirs = [...(cum.createdDirs ?? []), path.dirname(manifestP)];
  if (!dryRun) {
    removeFile(manifestP);
    res.removedDirs.push(...removeEmptyDirs(dirs, false).filter((d) => !res.removedDirs.some((x) => samePath(x, d))));
    resignIntegrity('uninstall');
  } else {
    res.removedDirs.push(...removeEmptyDirs(dirs, true).filter((d) => !res.removedDirs.some((x) => samePath(x, d))));
  }
  res.notes.push(`backups kept under ${backupsDir()}`);
  instrument({
    event: 'uninstall',
    ids: { setting },
    counts: { plans: res.plans.length, restored: res.restored.length, kept: res.kept.length },
  });
  return res;
}

function emptyUndo(manifestP: string, setting: Setting, dryRun: boolean): UndoResult {
  return {
    ok: true,
    planId: '',
    stamp: '',
    setting,
    dryRun,
    manifestPath: manifestP,
    backupDir: backupsDir(),
    restored: [],
    kept: [],
    settingsReversed: [],
    reverted: null,
    removedDirs: [],
    notes: [],
  };
}
