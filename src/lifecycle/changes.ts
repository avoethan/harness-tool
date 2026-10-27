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
import { planFilePath } from './plans';
import type { Hunk, Plan } from '../types';
import { readJsonOr } from '../lib/fsx';

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
  /** Why: each change the plans made to this file, from the plan saved at install or self-update time. */
  reasons: Array<{ plan: string; checkId: string; reason: string; from: string }>;
}

/**
 * Why a kind of change helps, by the check id or classification the plan
 * recorded. One plain sentence each; an id not listed gets none.
 */
export const WHY_BETTER: Record<string, string> = {
  CONVERT: 'a rule a check can enforce is now enforced by the gate or a hook every time, instead of relying on the agent to remember a sentence',
  TRIM: 'text the agent can work out from the code (file maps, script lists) costs context on every turn and goes stale; removing it leaves room for the rules that matter',
  FIX: 'the instruction pointed at something that no longer exists or was wrong; the agent now follows a correct one',
  SPLIT: 'detail moved out of the always-on file into the task skill, which loads when a task needs it, so the always-on file stays short enough to be read in full',
  QUARANTINE: 'text that could steer the agent against your rules (hidden characters, instruction-like comments, autonomy grants) is set aside for you to review instead of being loaded',
  R04: 'a command that is not defined any more would make the agent fail or improvise',
  R05: 'a path that does not exist any more sends the agent to the wrong place',
  R06: 'the same text in several files is loaded several times and drifts apart; one copy is kept',
  R09: 'over the load limit the agent silently drops part of the file; it now fits',
  R10: 'hidden Unicode can carry instructions you cannot see',
  R11: 'an HTML comment is invisible when you read the file but the agent still reads it',
  R12: 'phrasing that reads like a prompt injection is not loaded until you review it',
  R13: 'an autonomy grant ("without asking", "merge it yourself") would override the safety rails',
  R14: 'a broad permission lets the agent run anything without a prompt; the rails narrow it',
  R22: 'a broken import or link loads nothing; the agent misses what it pointed to',
  R25: 'the rule is now checked by a lint rule, test, hook or gate step, so it holds even when the agent forgets it',
  R26: 'derived content (file maps, structure) goes stale and costs context on every turn',
  R29: 'the rule contradicted your formatter or linter config; the config wins and the agent no longer gets mixed signals',
  R30: 'two agent files said opposite things; the agent no longer has to guess which one holds',
  R31: 'the fact about an agent feature was out of date',
  safety: 'your safety rule is now also enforced by the guard on every command, not only written down',
  'render.alwayson': 'a short always-on block tells the agent the order of work (intake, tests first, gate) in every session',
  'render.hooks': 'the hooks run the guard before each command and the evidence check before the agent stops, so the rules hold without the agent choosing to follow them',
  'render.permissions': 'the rails as permission rules: a cheap first layer that blocks dangerous commands before they reach the guard',
  'render.scoped': 'standards for one part of the code load only around those files, so they do not crowd every session',
  'render.codex-trust': 'Codex only loads a project\'s hooks and rules when it is trusted; without this the rails would not load',
  'render.codex-sandbox': 'the gate can write its evidence from inside the Codex sandbox',
  'render.prettierignore': 'the repository\'s format check does not fail on the harness\'s own files',
  'render.skill': 'the skill holds the step-by-step order of work, and Devin loads it when a task needs it instead of every session carrying it',
  LEARN: 'a correction you approved in `harness learn review` is now part of the skill, so the agent does not repeat the mistake',
};

/** The reason sentence for a recorded hunk: by check id, else by the classification word it starts with. */
export function whyBetter(h: { checkId: string; reason: string }): string | undefined {
  const id = h.checkId.replace(/^self-update:\s*/, '');
  if (WHY_BETTER[id]) return WHY_BETTER[id];
  if (id.startsWith('render.skill.')) return WHY_BETTER['render.skill'];
  const cls = /^(?:self-update: )?(CONVERT|TRIM|FIX|SPLIT|QUARANTINE)\b/.exec(h.reason)?.[1];
  return cls ? WHY_BETTER[cls] : undefined;
}

function planHunks(planId: string, cache: Map<string, Map<string, Hunk[]> | null>): Map<string, Hunk[]> | null {
  if (cache.has(planId)) return cache.get(planId)!;
  const plan = readJsonOr<Plan | null>(planFilePath(planId), null);
  const m = plan && Array.isArray(plan.targets) ? new Map(plan.targets.map((t) => [t.path, t.hunks ?? []])) : null;
  cache.set(planId, m);
  return m;
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
  const cache = new Map<string, Map<string, Hunk[]> | null>();
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
    const reasons: FileChange['reasons'] = [];
    for (const planId of e.plans) {
      for (const h of planHunks(planId, cache)?.get(p) ?? []) reasons.push({ plan: planId, checkId: h.checkId, reason: h.reason, from: h.provenance });
    }
    files.push({ path: p, kind, owner: e.last.owner, now, plans: e.plans, backup: e.first.backup, settingsKeys: [...e.keys].sort(), reasons });
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

/** One line per reason: the same reason on consecutive lines of one file reads as one line range. */
export function groupReasons(rs: FileChange['reasons']): FileChange['reasons'] {
  const out: FileChange['reasons'] = [];
  let run: { r: FileChange['reasons'][number]; file: string; first: number; last: number } | null = null;
  const flush = () => {
    if (!run) return;
    out.push({ ...run.r, from: run.first === run.last ? `${run.file}:${run.first}` : `${run.file}:${run.first}-${run.last}` });
    run = null;
  };
  for (const r of rs) {
    const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(r.from);
    if (!m) {
      flush();
      out.push(r);
      continue;
    }
    const [file, a, b] = [m[1], Number(m[2]), Number(m[3] ?? m[2])];
    if (run && run.r.plan === r.plan && run.r.checkId === r.checkId && run.r.reason === r.reason && run.file === file && a <= run.last + 1) run.last = Math.max(run.last, b);
    else {
      flush();
      run = { r, file, first: a, last: b };
    }
  }
  flush();
  return out;
}

/** Where text the plan took out of a file is kept. */
function keptWhere(reason: string): string | undefined {
  if (/-> (check \+ )?archive\b/.test(reason)) return 'kept in ~/.harness/archive/, not deleted';
  if (/-> quarantine\b/.test(reason)) return 'kept in ~/.harness/quarantine/ for you to review; not loaded by the agents';
  if (/-> task skill reference\b/.test(reason)) return 'moved into the task skill\'s reference';
  return undefined;
}

export function formatChanges(r: ChangesResult, opts: { diff?: boolean; filtered?: boolean } = {}): string {
  const lines: string[] = [];
  if (!r.files.length) {
    lines.push(r.plans.length ? (opts.filtered ? 'No file the harness changed matches --path.' : 'The installs in effect changed no files.') : 'No install or self-update is in effect: the harness has changed none of your files.');
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
      if (f.reasons.length) {
        lines.push('    why:');
        const seen = new Set<string>();
        for (const r of groupReasons(f.reasons)) {
          lines.push(`      - ${r.reason}${r.from ? `  [from ${r.from}]` : ''}`);
          const better = whyBetter(r);
          if (better && !seen.has(better)) {
            seen.add(better);
            lines.push(`        better because: ${better}`);
          }
          const kept = keptWhere(r.reason);
          if (kept) lines.push(`        the text: ${kept}`);
        }
      } else lines.push('    why: not recorded (the plan file is gone from ~/.harness/plans)');
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
