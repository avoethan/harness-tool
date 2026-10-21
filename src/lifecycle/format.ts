/**
 * Plain-language rendering of lifecycle results for the apply, undo and
 * uninstall commands. Paths are printed; file content never is.
 */
import type { Plan } from '../types';
import type { ApplyResult } from './apply';
import type { UndoResult, UninstallResult } from './undo';

const n = (c: number, one: string, many = one + 's') => `${c} ${c === 1 ? one : many}`;

export function formatPlanSummary(plan: Plan, file: string | null): string {
  const lines: string[] = [];
  lines.push(`Plan ${plan.id} (${plan.setting} setting, agents: ${plan.agents.join(', ') || 'none'})${file ? ` from ${file}` : ''}`);
  const counts: Record<string, number> = {};
  for (const t of plan.targets) counts[t.action] = (counts[t.action] ?? 0) + 1;
  lines.push(`  ${n(plan.targets.length, 'target')}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
  for (const t of plan.targets) lines.push(`  ${t.action.padEnd(10)} ${t.path}${t.exclude ? '  (excluded from git)' : ''}${t.owner === 'user' ? '  (your file: diff proposal)' : ''}`);
  for (const note of plan.notes ?? []) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

export function formatApply(r: ApplyResult): string {
  const lines: string[] = [];
  const head = r.dryRun ? 'Dry run: nothing was written.' : r.ok ? `Applied plan ${r.planId}.` : `Plan ${r.planId} was refused.`;
  lines.push(head);
  if (r.written.length) {
    lines.push(`${r.dryRun ? 'Would write' : 'Wrote'} ${n(r.written.length, 'file')}:`);
    for (const w of r.written) lines.push(`  ${w.action.padEnd(10)} ${w.path}${w.backup ? '  (backup taken)' : ''}`);
  }
  if (r.settingsEdits.length) {
    lines.push(`Settings entries ${r.dryRun ? 'to add' : 'added'} (existing entries untouched):`);
    for (const e of r.settingsEdits) lines.push(`  ${e.path}: ${e.key}`);
  }
  if (r.excluded.length) {
    lines.push('Git ignores every in-tree path (proven with git check-ignore -v):');
    for (const e of r.excluded) lines.push(`  ${e.path}: ${e.rule}`);
  }
  if (r.skipped.length) {
    lines.push(`Skipped ${n(r.skipped.length, 'target')}:`);
    for (const s of r.skipped) lines.push(`  ${s.path}: ${s.reason}`);
  }
  if (r.refused.length) {
    lines.push(`Refused ${n(r.refused.length, 'target')}:`);
    for (const s of r.refused) lines.push(`  ${s.path}: ${s.reason}`);
  }
  if (r.commit) lines.push(`Commit: ${r.commit.slice(0, 12)} (the apply commit of ${r.planId})`);
  if (r.backupDir && !r.dryRun) lines.push(`Backups: ${r.backupDir}`);
  if (r.manifestPath && !r.dryRun && r.written.length) lines.push(`Manifest: ${r.manifestPath}`);
  for (const note of r.notes) lines.push(`Note: ${note}`);
  if (!r.dryRun && r.ok && r.written.length) lines.push(`Undo with: harness undo --plan ${r.planId}`);
  return lines.join('\n');
}

export function formatUndo(r: UndoResult): string {
  const lines: string[] = [];
  lines.push(r.dryRun ? `Dry run of undo for plan ${r.planId}: nothing was changed.` : `Undid plan ${r.planId}.`);
  if (r.reverted) lines.push(`Reverted the apply commit as ${r.reverted.slice(0, 12)}.`);
  const restored = r.restored.filter((x) => x.how !== 'already-before');
  const already = r.restored.length - restored.length;
  if (restored.length) {
    lines.push(`${r.dryRun ? 'Would restore' : 'Restored'} ${n(restored.length, 'file')}:`);
    for (const x of restored) lines.push(`  ${x.how === 'deleted' ? 'removed ' : 'restored'} ${x.path}`);
  }
  if (already) lines.push(`${n(already, 'file')} already back to the pre-apply state (nothing to do).`);
  if (r.kept.length) {
    lines.push(`Kept ${n(r.kept.length, 'file')} (edited since apply):`);
    for (const k of r.kept) lines.push(`  ${k.path}: ${k.reason}${k.backup ? `\n    pre-apply copy: ${k.backup}` : ''}`);
  }
  for (const s of r.settingsReversed) {
    if (s.keys.length) lines.push(`Removed the harness entries from ${s.path}: ${s.keys.join(', ')} (your own entries kept)`);
    if (s.untouched.length) lines.push(`  nothing to remove at ${s.untouched.join(', ')}`);
  }
  if (r.removedDirs.length) lines.push(`Removed ${n(r.removedDirs.length, 'empty folder')} the harness had created.`);
  for (const note of r.notes) lines.push(`Note: ${note}`);
  lines.push(`Backups kept: ${r.backupDir}`);
  return lines.join('\n');
}

export function formatUninstall(r: UninstallResult): string {
  const lines: string[] = [];
  lines.push(r.dryRun ? `Dry run of uninstall (${r.setting} setting): nothing was changed.` : `Uninstalled the harness (${r.setting} setting).`);
  if (r.plans.length) lines.push(`${n(r.plans.length, 'plan')} undone: ${r.plans.map((p) => p.planId).join(', ')}`);
  const restored = r.restored.filter((x) => x.how !== 'already-before');
  if (restored.length) {
    lines.push(`${r.dryRun ? 'Would restore' : 'Restored'} ${n(restored.length, 'file')}:`);
    for (const x of restored) lines.push(`  ${x.how === 'deleted' ? 'removed ' : 'restored'} ${x.path}`);
  }
  if (r.kept.length) {
    lines.push(`Kept ${n(r.kept.length, 'file')} (edited since apply):`);
    for (const k of r.kept) lines.push(`  ${k.path}: ${k.reason}${k.backup ? `\n    pre-apply copy: ${k.backup}` : ''}`);
  }
  for (const s of r.settingsReversed) if (s.keys.length) lines.push(`Removed the harness entries from ${s.path}: ${s.keys.join(', ')}`);
  for (const p of r.plans) if (p.reverted) lines.push(`Reverted the apply commit of ${p.planId} as ${p.reverted.slice(0, 12)}.`);
  if (r.removedDirs.length) lines.push(`Removed ${n(r.removedDirs.length, 'empty folder')} the harness had created.`);
  for (const note of r.notes) lines.push(`Note: ${note}`);
  lines.push(`Backups are kept under ${r.backupsDir}; delete that folder yourself when you no longer need them.`);
  return lines.join('\n');
}
