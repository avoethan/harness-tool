/**
 * applyPlan(plan, opts): the write step of the lifecycle (DESIGN §2.3).
 *
 * A Plan from types.ts is all it needs. In order:
 *
 *  1. Validate every target and compare its beforeSha with the file now.
 *     One drift refuses the WHOLE plan; nothing is written. The result says
 *     which paths changed.
 *  2. Team setting: before any write, refuse any path tracked by a git
 *     repository under the workspace root, and require `git check-ignore -v`
 *     to match for every in-tree path (adding it to .git/info/exclude first
 *     when the target says `exclude`). One guard failure refuses the plan.
 *  3. Back up every file that exists under backups/<planId>/<stamp>/.
 *  4. Write: create/modify atomically; merge-json = parseJsonc + unionJson
 *     (existing entries are never removed or narrowed); delete only when the
 *     file is pristine and generated. After each write the bytes are re-read
 *     and the target is refused (backup restored) on a hash mismatch or
 *     hidden Unicode. In-tree team paths are re-checked with check-ignore.
 *  5. Write the cumulative manifest and the per-plan record, make the apply
 *     commit in the personal setting when asked, re-sign integrity.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan, PlanTarget, Setting, SettingsEdit } from '../types';
import { readTextOr, removeFile, writeTextAtomic, exists, isDir } from '../lib/fsx';
import { sha256, sha256File } from '../lib/hash';
import { parseJsonc, unionJson } from '../lib/jsonc';
import { ownedArrayElements, pruneStaleOwned } from './owned';
import { checkIgnore, headSha, isTracked, nearestRepoRoot, rawGit } from '../lib/git';
import { inboxHome, harnessHome, subPath, toPosix } from '../lib/paths';
import { scanHiddenUnicode } from '../lib/unicode';
import { instrument } from '../lib/log';
import { resolveConfig } from '../lib/config';
import {
  addCreatedDirs,
  addSettingsEdit,
  emptyManifest,
  findEntry,
  loadManifest,
  manifestPathFor,
  mergeEntry,
  resignIntegrity,
  saveManifest,
} from './manifest';
import { backupFile, backupRoot, newBackupStamp, savePlanRecord, type PlanRecord } from './backup';

export interface ApplyOptions {
  /** Report what would happen; write nothing. */
  dryRun?: boolean;
  /** Personal setting: make one commit `harness: apply <planId>` of the manifest-owned paths. */
  commit?: boolean;
  /** Team guard root; defaults to the configured workspace root. */
  workspaceRoot?: string;
  /** Personal setting: the repository root; defaults to plan.repoRoot, then the nearest git root of the first target. */
  repoRoot?: string;
  /** Clock, for tests. */
  now?: Date;
}

export interface ApplyWritten {
  path: string;
  action: PlanTarget['action'];
  owner: PlanTarget['owner'];
  beforeSha: string | null;
  /** Empty for a delete. */
  afterSha: string;
  backup: string | null;
}

export interface ApplyNote {
  path: string;
  reason: string;
}

export interface ApplyResult {
  /** True when nothing was refused (skips are fine). */
  ok: boolean;
  planId: string;
  setting: Setting;
  dryRun: boolean;
  manifestPath: string | null;
  backupDir: string | null;
  written: ApplyWritten[];
  skipped: ApplyNote[];
  refused: ApplyNote[];
  settingsEdits: SettingsEdit[];
  /** Team: the `git check-ignore -v` rule that matched each in-tree path, after the write. */
  excluded: Array<{ path: string; rule: string }>;
  commit: string | null;
  notes: string[];
}

/** Marker in ManifestFile.afterSha for a file the harness deleted. */
export const DELETED_SHA = '';

type Guard = { repoRoot: string; ruleBefore: string } | null;

export async function applyPlan(plan: Plan, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const res: ApplyResult = {
    ok: true,
    planId: plan.id,
    setting: plan.setting,
    dryRun: !!opts.dryRun,
    manifestPath: null,
    backupDir: null,
    written: [],
    skipped: [],
    refused: [],
    settingsEdits: [],
    excluded: [],
    commit: null,
    notes: [],
  };
  const targets = plan.targets ?? [];
  if (!targets.length) {
    res.notes.push('the plan has no targets; nothing to do');
    return res;
  }

  // --- roots -------------------------------------------------------------
  let repoRoot: string | null = null;
  if (plan.setting === 'personal') {
    repoRoot = opts.repoRoot ?? plan.repoRoot ?? nearestRepoRoot(path.dirname(targets[0].path));
    if (!repoRoot || !isDir(repoRoot)) {
      return refuseAll(res, targets, 'personal setting: no repository root (set plan.repoRoot or run inside the repository)');
    }
  }
  let manifestP: string;
  try {
    manifestP = manifestPathFor(plan.setting, repoRoot);
  } catch (e) {
    return refuseAll(res, targets, (e as Error).message);
  }
  res.manifestPath = manifestP;
  const workspaceRoot = path.resolve(opts.workspaceRoot ?? resolveConfig(repoRoot ?? process.cwd()).config.workspaceRoot);

  // --- 1. validate + drift ----------------------------------------------
  const drift: ApplyNote[] = [];
  for (const t of targets) {
    const bad = validateTarget(t);
    if (bad) {
      drift.push({ path: t.path, reason: bad });
      continue;
    }
    const cur = sha256File(t.path);
    if (cur !== t.beforeSha) {
      drift.push({
        path: t.path,
        reason:
          cur === null
            ? 'the file is missing now, but the plan expected it'
            : t.beforeSha === null
              ? 'the file exists now, but the plan expected none'
              : 'the file changed since the plan was written',
      });
    }
  }
  if (drift.length) {
    res.refused.push(...drift);
    res.notes.push(`plan refused as a whole: ${drift.length} of ${targets.length} target(s) changed since the plan was written; run propose again`);
    res.ok = false;
    instrument({ event: 'apply.refused', ids: { plan: plan.id, why: 'drift' }, counts: { drift: drift.length } });
    return res;
  }

  // --- 2. team guard (before any write) --------------------------------
  const guards = new Map<string, Guard>();
  if (plan.setting === 'team') {
    const refusals: ApplyNote[] = [];
    for (const t of targets) {
      const g = teamGuardBefore(t, workspaceRoot, !!opts.dryRun, res.notes);
      if ('refuse' in g) refusals.push({ path: t.path, reason: g.refuse });
      else guards.set(t.path, g.guard);
    }
    if (refusals.length) {
      res.refused.push(...refusals);
      res.notes.push('plan refused as a whole: the team setting never writes tracked or unignored files inside a repository');
      res.ok = false;
      instrument({ event: 'apply.refused', ids: { plan: plan.id, why: 'team-guard' }, counts: { refused: refusals.length } });
      return res;
    }
  }

  // --- 3. dry run stops here --------------------------------------------
  const cumulative = loadManifest(manifestP) ?? emptyManifest();
  if (opts.dryRun) {
    for (const t of targets) {
      const d = planDry(t, cumulative);
      if ('skip' in d) res.skipped.push({ path: t.path, reason: d.skip });
      else if ('refuse' in d) {
        res.refused.push({ path: t.path, reason: d.refuse });
        res.ok = false;
      } else {
        res.written.push(d.written);
        res.settingsEdits.push(...d.edits);
      }
    }
    for (const [p, g] of guards) if (g) res.excluded.push({ path: p, rule: g.ruleBefore });
    return res;
  }

  // --- 4. backups + writes ----------------------------------------------
  const stamp = newBackupStamp(now);
  res.backupDir = backupRoot(plan.id, stamp);
  const rec: PlanRecord = {
    ...emptyManifest(),
    planId: plan.id,
    stamp,
    setting: plan.setting,
    repoRoot: repoRoot ?? undefined,
    manifestPath: manifestP,
    appliedAt: now.toISOString(),
  };
  const createdDirs: string[] = [];
  const manifestDirs = missingDirs(path.dirname(manifestP));

  for (const t of targets) {
    const backup = backupFile(plan.id, stamp, t.path);
    const guard = guards.get(t.path) ?? null;
    const outcome = writeTarget(t, cumulative, backup?.backup ?? null, res.notes);
    if ('skip' in outcome) {
      res.skipped.push({ path: t.path, reason: outcome.skip });
      continue;
    }
    if ('refuse' in outcome) {
      res.refused.push({ path: t.path, reason: outcome.refuse });
      res.ok = false;
      continue;
    }
    // Team: the path must still be ignored after the write.
    if (guard) {
      const after = checkIgnore(guard.repoRoot, t.path);
      if (!after) {
        restoreOrRemove(t.path, backup?.backup ?? null);
        res.refused.push({ path: t.path, reason: `not ignored by git after the write (it was: ${guard.ruleBefore}); restored` });
        res.ok = false;
        continue;
      }
      res.excluded.push({ path: t.path, rule: after });
    }
    createdDirs.push(...outcome.createdDirs);
    const entry = { path: t.path, owner: t.owner, beforeSha: t.beforeSha, afterSha: outcome.afterSha, backup: backup?.backup ?? null };
    rec.files.push(entry);
    mergeEntry(cumulative, entry);
    for (const e of outcome.edits) {
      rec.settingsEdits.push(e);
      addSettingsEdit(cumulative, e);
    }
    res.written.push({ ...entry, action: t.action });
    res.settingsEdits.push(...outcome.edits);
  }

  // --- 5. manifest, commit, integrity -----------------------------------
  cumulative.planId = plan.id;
  cumulative.appliedAt = now.toISOString();
  addCreatedDirs(cumulative, [...createdDirs, ...manifestDirs]);
  addCreatedDirs(rec, [...createdDirs, ...manifestDirs]);
  saveManifest(manifestP, cumulative);

  if (plan.setting === 'personal' && opts.commit && repoRoot) {
    const r = commitOwned(repoRoot, plan.id, [...res.written.map((w) => w.path), manifestP], res.notes);
    res.commit = r;
    rec.commit = r ?? undefined;
  }
  savePlanRecord(rec);
  resignIntegrity('apply');
  // the pasted-ticket inbox the task skill names (a sibling of the state folder; the agents' file tools are allowed there)
  try {
    fs.mkdirSync(inboxHome(), { recursive: true });
  } catch {
    /* reported by doctor if it is missing */
  }
  instrument({
    event: 'apply',
    ids: { plan: plan.id, setting: plan.setting },
    counts: { targets: targets.length, written: res.written.length, skipped: res.skipped.length, refused: res.refused.length },
  });
  return res;
}

// ---------------------------------------------------------------------------

function refuseAll(res: ApplyResult, targets: PlanTarget[], reason: string): ApplyResult {
  for (const t of targets) res.refused.push({ path: t.path, reason });
  res.notes.push(`plan refused as a whole: ${reason}`);
  res.ok = false;
  return res;
}

function validateTarget(t: PlanTarget): string | null {
  if (!t.path || !path.isAbsolute(t.path)) return 'target path must be absolute';
  if (subPath(harnessHome(), t.path)) return 'targets inside the harness state folder are not allowed';
  switch (t.action) {
    case 'create':
      if (t.beforeSha !== null) return 'create target carries a beforeSha; use modify';
      if (typeof t.after !== 'string') return 'create target has no content';
      return null;
    case 'modify':
      if (t.beforeSha === null) return 'modify target has no beforeSha; use create';
      if (typeof t.after !== 'string') return 'modify target has no content';
      return null;
    case 'delete':
      if (t.beforeSha === null) return 'delete target has no beforeSha';
      return null;
    case 'merge-json': {
      if (typeof t.after !== 'string') return 'merge-json target has no fragment';
      try {
        const v = JSON.parse(t.after);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return 'merge-json fragment must be a JSON object';
      } catch {
        return 'merge-json fragment is not valid JSON';
      }
      return null;
    }
    default:
      return `unknown action ${String((t as PlanTarget).action)}`;
  }
}

/** Team: the repository (under the workspace root) that holds a path, if any. The harness state repo never counts. */
export function inTreeRepo(absPath: string, workspaceRoot: string): string | null {
  const r = nearestRepoRoot(path.dirname(absPath));
  if (!r) return null;
  if (subPath(harnessHome(), r)) return null; // the private state repo, or something inside it
  return subPath(workspaceRoot, r) ? r : null;
}

function teamGuardBefore(
  t: PlanTarget,
  workspaceRoot: string,
  dryRun: boolean,
  notes: string[],
): { guard: Guard } | { refuse: string } {
  const repo = inTreeRepo(t.path, workspaceRoot);
  if (!repo) return { guard: null };
  if (isTracked(repo, t.path)) return { refuse: `tracked by the repository at ${repo}; the harness never writes tracked team files` };
  let rule = checkIgnore(repo, t.path);
  if (!rule && t.exclude) {
    if (dryRun) {
      notes.push(`would add ${t.path} to .git/info/exclude of ${repo}`);
      rule = '(dry run: would be added to .git/info/exclude)';
    } else {
      const added = addToInfoExclude(repo, t.path);
      if (!added.ok) return { refuse: `could not add to .git/info/exclude: ${added.error}` };
      notes.push(`added ${toPosix(path.relative(repo, t.path))} to ${added.file}`);
      rule = checkIgnore(repo, t.path);
      if (!rule) return { refuse: `added to .git/info/exclude but git check-ignore still does not match it` };
    }
  }
  if (!rule) return { refuse: `not ignored by git in ${repo} (it would show up as an untracked file); the plan did not ask to exclude it` };
  return { guard: { repoRoot: repo, ruleBefore: rule } };
}

/** Append `/relative/path` to the repository's info/exclude (resolved through git, so worktrees work). */
export function addToInfoExclude(repoRoot: string, absPath: string): { ok: true; file: string } | { ok: false; error: string } {
  const r = rawGit(repoRoot, ['rev-parse', '--git-path', 'info/exclude'], 5000);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'git rev-parse failed' };
  const file = path.resolve(repoRoot, r.stdout.trim());
  const line = '/' + toPosix(path.relative(repoRoot, absPath));
  const cur = readTextOr(file, '') ?? '';
  const lines = cur.split(/\r?\n/);
  if (lines.includes(line)) return { ok: true, file };
  const next = (cur.length && !cur.endsWith('\n') ? cur + '\n' : cur) + line + '\n';
  try {
    writeTextAtomic(file, next);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, file };
}

type WriteOutcome = { skip: string } | { refuse: string } | { afterSha: string; edits: SettingsEdit[]; createdDirs: string[] };

function planDry(t: PlanTarget, cumulative: ReturnType<typeof emptyManifest>): { skip: string } | { refuse: string } | { written: ApplyWritten; edits: SettingsEdit[] } {
  if (t.action === 'delete') {
    const d = deleteAllowed(t, cumulative);
    if (d) return { skip: d };
    return { written: { path: t.path, action: t.action, owner: t.owner, beforeSha: t.beforeSha, afterSha: DELETED_SHA, backup: null }, edits: [] };
  }
  if (t.action === 'merge-json') {
    const m = mergeContent(t, ownedArrayElements(cumulative.settingsEdits, t.path));
    if ('refuse' in m) return { refuse: m.refuse };
    return { written: { path: t.path, action: t.action, owner: t.owner, beforeSha: t.beforeSha, afterSha: sha256(m.text), backup: null }, edits: m.edits };
  }
  const content = t.after as string;
  const hits = scanHiddenUnicode(content);
  if (hits.length) return { refuse: `content carries hidden Unicode at offset ${hits[0].offset}` };
  return { written: { path: t.path, action: t.action, owner: t.owner, beforeSha: t.beforeSha, afterSha: sha256(content), backup: null }, edits: [] };
}

function deleteAllowed(t: PlanTarget, cumulative: ReturnType<typeof emptyManifest>): string | null {
  if (t.owner === 'user') return 'user-authored files are never deleted; the plan should propose a diff instead';
  const entry = findEntry(cumulative, t.path);
  const cur = sha256File(t.path);
  if (entry && entry.afterSha !== cur) return 'not pristine: edited since the harness wrote it; kept';
  return null;
}

function writeTarget(t: PlanTarget, cumulative: ReturnType<typeof emptyManifest>, backup: string | null, notes: string[]): WriteOutcome {
  if (t.action === 'delete') {
    const d = deleteAllowed(t, cumulative);
    if (d) return { skip: d };
    removeFile(t.path);
    if (exists(t.path)) return { refuse: 'could not delete the file' };
    return { afterSha: DELETED_SHA, edits: [], createdDirs: [] };
  }
  let text: string;
  let edits: SettingsEdit[] = [];
  if (t.action === 'merge-json') {
    const m = mergeContent(t, ownedArrayElements(cumulative.settingsEdits, t.path));
    if ('refuse' in m) return { refuse: m.refuse };
    text = m.text;
    edits = m.edits;
    if (m.replaced) notes.push(`${t.path}: replaced ${m.replaced} harness entr${m.replaced === 1 ? 'y' : 'ies'} an earlier install wrote for another copy of the harness (your own entries are untouched)`);
    if (m.hadComments) notes.push(`${t.path}: comments or trailing commas in the original were not preserved (the original is in the backup)`);
  } else {
    text = t.after as string;
  }
  const createdDirs = missingDirs(path.dirname(t.path));
  try {
    writeTextAtomic(t.path, text, t.mode !== undefined ? { mode: t.mode } : {});
    if (t.mode !== undefined) {
      try {
        fs.chmodSync(t.path, t.mode);
      } catch {
        /* Windows: modes do not apply */
      }
    }
  } catch (e) {
    // Nothing was written (the atomic writer refuses before touching the file).
    return { refuse: `refused before writing: ${(e as Error).message.replace(/^refusing to write [^:]*: /, '')}` };
  }
  const expected = sha256(text);
  const v = verifyWritten(t.path, expected);
  if (!v.ok) {
    restoreOrRemove(t.path, backup);
    return { refuse: `${v.reason}; ${backup ? 'backup restored' : 'file removed'}` };
  }
  return { afterSha: expected, edits, createdDirs };
}

/** Union a merge-json fragment into the file's current content. */
export function mergeContent(t: PlanTarget, owned?: Map<string, Set<string>>): { refuse: string } | { text: string; edits: SettingsEdit[]; hadComments: boolean; replaced: number } {
  const cur = readTextOr(t.path, null);
  let base: unknown = {};
  let hadComments = false;
  if (cur !== null && cur.trim() !== '') {
    try {
      base = parseJsonc(cur);
    } catch (e) {
      return { refuse: `cannot parse the existing JSON (${(e as Error).message}); fix the file by hand first` };
    }
    try {
      JSON.parse(cur);
    } catch {
      hadComments = true;
    }
  }
  if (!base || typeof base !== 'object' || Array.isArray(base)) return { refuse: 'the existing file is not a JSON object' };
  const fragment = JSON.parse(t.after as string) as Record<string, unknown>;
  // Harness entries an earlier install added that point at another copy of the harness are replaced, never duplicated.
  const pruned = owned && owned.size ? pruneStaleOwned(base as Record<string, unknown>, fragment, owned) : { base: base as Record<string, unknown>, replaced: [] };
  const merged = unionJson(pruned.base, fragment) as Record<string, unknown>;
  const edits = diffUnion(base as Record<string, unknown>, fragment, merged, '', t.path);
  return { text: JSON.stringify(merged, null, 2) + '\n', edits, hadComments, replaced: pruned.replaced.reduce((n, r) => n + r.count, 0) };
}

/** A key segment that contains a dot is wrapped in brackets so the dotted path stays unambiguous. */
export function joinKey(prefix: string, k: string): string {
  const seg = k.includes('.') || k.includes('[') ? `[${k}]` : k;
  return prefix ? `${prefix}.${seg}` : seg;
}

export function splitKey(key: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < key.length) {
    if (key[i] === '[') {
      const j = key.indexOf(']', i);
      if (j < 0) {
        out.push(key.slice(i + 1));
        break;
      }
      out.push(key.slice(i + 1, j));
      i = j + 1;
      if (key[i] === '.') i++;
    } else {
      let j = key.indexOf('.', i);
      if (j < 0) j = key.length;
      out.push(key.slice(i, j));
      i = j + 1;
    }
  }
  return out;
}

/** The settings edits a union made: one per fragment key that was new or (for arrays) grew. */
export function diffUnion(base: Record<string, unknown>, fragment: Record<string, unknown>, merged: Record<string, unknown>, prefix: string, file: string): SettingsEdit[] {
  const out: SettingsEdit[] = [];
  for (const k of Object.keys(fragment)) {
    const key = joinKey(prefix, k);
    const b = base[k];
    const m = merged[k];
    if (b === undefined) {
      out.push({ path: file, key, before: undefined, after: m });
    } else if (isObj(b) && isObj(fragment[k]) && isObj(m)) {
      out.push(...diffUnion(b as Record<string, unknown>, fragment[k] as Record<string, unknown>, m as Record<string, unknown>, key, file));
    } else if (Array.isArray(b) && Array.isArray(m)) {
      if (JSON.stringify(b) !== JSON.stringify(m)) out.push({ path: file, key, before: b, after: m });
    }
    // scalars: unionJson keeps the existing value, so nothing changed
  }
  return out;
}

function isObj(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Re-read a written file: the bytes must hash to what was intended and carry no hidden Unicode. */
export function verifyWritten(p: string, expectedSha: string): { ok: true } | { ok: false; reason: string } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(p);
  } catch {
    return { ok: false, reason: 'the file could not be read back after writing' };
  }
  const sha = sha256(bytes);
  if (sha !== expectedSha) return { ok: false, reason: 'the bytes on disk do not match what was written (hash mismatch)' };
  const hits = scanHiddenUnicode(bytes.toString('utf8'));
  if (hits.length) return { ok: false, reason: `hidden Unicode (${hits[0].kind}) found at offset ${hits[0].offset} after writing` };
  return { ok: true };
}

function restoreOrRemove(p: string, backup: string | null): void {
  if (backup) {
    try {
      fs.copyFileSync(backup, p);
      return;
    } catch {
      /* fall through */
    }
  }
  removeFile(p);
}

/** Folders that do not exist yet on the way to `dir`, deepest first. */
export function missingDirs(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    if (isDir(cur)) break;
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * Personal: one commit of exactly the given paths (pathspec-limited, so the
 * user's own staged work is untouched). Paths inside the git directory (the
 * repository's own git hooks, which hold this machine's absolute paths) are
 * local only and never part of the commit; git would refuse the whole
 * pathspec otherwise. The commit runs with the repository's git hooks
 * switched off (as the pause commit does): it carries only files apply just
 * wrote and verified, and an admin action must not run repository code.
 */
function commitOwned(repoRoot: string, planId: string, absPaths: string[], notes: string[]): string | null {
  const rels: string[] = [];
  for (const p of absPaths) {
    if (!subPath(repoRoot, p)) {
      notes.push(`${p} lies outside the repository and is not part of the apply commit`);
      continue;
    }
    const rel = toPosix(path.relative(repoRoot, p));
    if (rel === '.git' || rel.startsWith('.git/')) {
      notes.push(`${rel} is local to this clone (inside .git) and is not part of the apply commit`);
      continue;
    }
    rels.push(rel);
  }
  if (!rels.length) {
    notes.push('nothing inside the repository to commit');
    return null;
  }
  const add = rawGit(repoRoot, ['add', '-A', '--', ...rels], 60000);
  if (add.code !== 0) {
    notes.push(`git add failed: ${add.stderr.trim()}`);
    return null;
  }
  const before = headSha(repoRoot);
  const noHooks = path.join(harnessHome(), 'state', 'no-git-hooks');
  try {
    fs.mkdirSync(noHooks, { recursive: true });
  } catch {
    /* the commit below reports any failure */
  }
  // The subject follows the repository's own commit-subject standard when the ledger has one (the
  // pre-push gate checks the subjects it pushes, this one included).
  const { pickSubject } = require('../land/gitops') as typeof import('../land/gitops');
  const { repoIdFor } = require('../lib/config') as typeof import('../lib/config');
  const subject = pickSubject([`harness: apply ${planId}`, `chore(harness): apply ${planId}`, `chore: apply harness plan ${planId}`], repoIdFor(repoRoot));
  const commit = rawGit(repoRoot, ['-c', `core.hooksPath=${noHooks}`, 'commit', '-q', '-m', subject, '--', ...rels], 60000);
  if (commit.code !== 0) {
    notes.push(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
    return null;
  }
  const after = headSha(repoRoot);
  if (!after || after === before) {
    notes.push('git commit made no new commit');
    return null;
  }
  notes.push(`committed ${rels.length} path(s) as ${after.slice(0, 12)} "${subject}"`);
  return after;
}
