/**
 * What the harness has done to files outside its own state, across every
 * install and self-update that was not undone: each file it added, changed
 * or removed, with how the file stands now (as the harness left it, edited
 * since, deleted since, back to the original). Read-only; the source is the
 * plan records kept with the backups (lifecycle/backup.ts).
 */
import * as fs from 'node:fs';
import type { SettingsEdit } from '../types';
import { sha256File } from '../lib/hash';
import { unifiedDiff } from '../discover/diff';
import { listPlanIds, listPlanStamps, loadPlanRecord, type PlanRecord } from './backup';
import { DELETED_SHA } from './apply';

export type ChangeKind = 'added' | 'changed' | 'removed';
export type ChangeNow = 'as-left' | 'edited-since' | 'deleted-since' | 'back-to-original';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  owner: 'user' | 'generated';
  now: ChangeNow;
  /** Plan ids that wrote the file, oldest first. */
  plans: string[];
  /** The copy taken before the harness first wrote it; null for a file the harness added. */
  backup: string | null;
  /** Settings keys the harness added to this file (merge-json targets). */
  settingsKeys: string[];
}

export interface ChangesResult {
  plans: Array<{ planId: string; stamp: string; appliedAt?: string; setting: string; files: number }>;
  files: FileChange[];
}

/** Every apply record that is still in effect, oldest first. */
export function liveRecords(): PlanRecord[] {
  const out: PlanRecord[] = [];
  for (const { planId } of listPlanIds()) {
    for (const stamp of listPlanStamps(planId)) {
      const rec = loadPlanRecord(planId, stamp);
      if (rec && !rec.undoneAt) out.push(rec);
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
}

export function collectChanges(records: PlanRecord[] = liveRecords()): ChangesResult {
  const by = new Map<string, { first: PlanRecord['files'][number]; last: PlanRecord['files'][number]; plans: string[]; keys: Set<string> }>();
  for (const rec of records) {
    for (const f of rec.files) {
      const e = by.get(f.path);
      if (!e) by.set(f.path, { first: f, last: f, plans: [rec.planId], keys: new Set() });
      else {
        e.last = f;
        if (!e.plans.includes(rec.planId)) e.plans.push(rec.planId);
      }
    }
    for (const s of rec.settingsEdits as SettingsEdit[]) {
      const e = by.get(s.path);
      if (e) e.keys.add(s.key);
    }
  }
  const files: FileChange[] = [];
  for (const [p, e] of by) {
    const original = e.first.beforeSha;
    const left = e.last.afterSha;
    const kind: ChangeKind | null = original === null ? (left === DELETED_SHA ? null : 'added') : left === DELETED_SHA ? 'removed' : 'changed';
    if (!kind) continue; // added and removed again: nothing of it is left
    const cur = sha256File(p);
    let now: ChangeNow;
    if (left === DELETED_SHA ? cur === null : cur === left) now = 'as-left';
    else if (cur === original) now = 'back-to-original';
    else if (cur === null) now = 'deleted-since';
    else now = 'edited-since';
    files.push({ path: p, kind, owner: e.last.owner, now, plans: e.plans, backup: e.first.backup, settingsKeys: [...e.keys].sort() });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    plans: records.map((r) => ({ planId: r.planId, stamp: r.stamp, appliedAt: r.appliedAt, setting: r.setting, files: r.files.length })),
    files,
  };
}

function readText(p: string | null): string | null {
  if (!p) return null;
  try {
    const b = fs.readFileSync(p);
    return b.includes(0) ? null : b.toString('utf8');
  } catch {
    return null;
  }
}

/** The diff from the file before the harness first touched it to the file now; '' when nothing to show. */
export function changeDiff(c: FileChange): string {
  const before = c.kind === 'added' ? null : readText(c.backup);
  if (c.kind !== 'added' && before === null) return '';
  const now = readText(c.path) ?? '';
  return unifiedDiff(c.path, before, now);
}

const NOW_TEXT: Record<ChangeNow, string> = {
  'as-left': 'as the harness left it',
  'edited-since': 'edited since (by you or an agent)',
  'deleted-since': 'deleted since',
  'back-to-original': 'back to how it was before the harness',
};

export function formatChanges(r: ChangesResult, opts: { diff?: boolean } = {}): string {
  const lines: string[] = [];
  if (!r.files.length) {
    lines.push(r.plans.length ? 'The installs in effect changed no files.' : 'No install or self-update is in effect: the harness has changed none of your files.');
    return lines.join('\n') + '\n';
  }
  lines.push(`${r.plans.length} install${r.plans.length === 1 ? '' : 's'} or self-update${r.plans.length === 1 ? '' : 's'} in effect (oldest first):`);
  for (const p of r.plans) lines.push(`  ${p.planId}  ${p.appliedAt ?? p.stamp}  ${p.setting} setting, ${p.files} file${p.files === 1 ? '' : 's'}`);
  const groups: Array<[ChangeKind, string]> = [
    ['changed', 'Changed (a copy of the original is kept)'],
    ['added', 'Added by the harness'],
    ['removed', 'Removed by the harness (only files it had generated; a copy is kept)'],
  ];
  for (const [kind, title] of groups) {
    const fs_ = r.files.filter((f) => f.kind === kind);
    if (!fs_.length) continue;
    lines.push('', `${title}: ${fs_.length}`);
    for (const f of fs_) {
      lines.push(`  ${f.path}`);
      lines.push(`    now: ${NOW_TEXT[f.now]}${f.owner === 'user' ? '; your file' : ''}`);
      if (f.settingsKeys.length) lines.push(`    settings entries added: ${f.settingsKeys.join(', ')} (your own entries untouched)`);
      if (f.backup) lines.push(`    original: ${f.backup}`);
      if (opts.diff && kind !== 'removed') {
        const d = changeDiff(f);
        if (d) lines.push(...d.trimEnd().split('\n').map((l) => `    ${l}`));
      }
    }
  }
  const edited = r.files.filter((f) => f.now === 'edited-since' || f.now === 'deleted-since').length;
  lines.push('');
  if (edited) lines.push(`${edited} file${edited === 1 ? ' was' : 's were'} changed after the harness wrote ${edited === 1 ? 'it' : 'them'}; \`harness undo\` keeps such files and lists them.`);
  lines.push(`See the lines: \`harness changes --diff\` (original to now). Restore: \`harness undo --dry-run\` first, then \`harness undo\`.`);
  return lines.join('\n') + '\n';
}
