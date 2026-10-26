/**
 * Local changes present when a ticket starts are not the ticket's.
 *
 * Users keep private, uncommitted files in their repositories (notes,
 * investigations, write-ups). At intake (team), `task claim` (personal) and,
 * for a task that has none, the first gate run, the harness records a *start
 * snapshot* per repository and task:
 *
 *   ~/.harness/runs/<repoId>/<taskId>/start-snapshot.json
 *   {version: 1, repoId, taskId, base, recordedAt, by, entries: [{path, state}], withheld}
 *
 * `entries` lists every path `git status --porcelain=v1 -z --untracked-files=all`
 * showed (modified, added, deleted, renamed, untracked; never ignored files),
 * each with its git object id at that moment (the blob id `git hash-object`
 * gives, taken from a `git write-tree` of the working tree so filters, symlinks
 * and nested repositories hash exactly as the gate sees them) or `deleted`.
 * No file content is stored.
 *
 * `isTicketPath` / `partitionChanges` are the one place that decides whether a
 * changed path is part of the ticket's change; the gate's diff, the write-up
 * and every step that reads the diff use them. A path whose current state
 * equals its snapshot entry is left out; one that changed since is in, and
 * marked; a path that was clean at the start is in as before. A recorded path
 * that has been committed since the start is always in (it ships).
 *
 * The agent must never be able to hide its own work this way, so a snapshot an
 * agent's command can trigger (intake, claim, the gate) does not record a path
 * that an agent session edited in the last hours (the session edit log), nor,
 * when it is taken after the task started, a path changed after the start
 * (file time) or deleted. Those are counted as `withheld` and stay part of
 * the change. Only the user's `harness task snapshot` (an admin command the
 * guard denies to agents) records the tree as it is.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rawGit } from '../lib/git';
import { readJsonOr, writeJson } from '../lib/fsx';
import { stateDir } from '../lib/paths';
import { repoIdFor } from '../lib/config';
import { runDir, validId, type BriefFile } from './brief';

export const DELETED = 'deleted';
export const SNAPSHOT_FILE = 'start-snapshot.json';
/** Session edits newer than this keep a path out of an agent-triggered snapshot. */
export const AGENT_EDIT_WINDOW_MS = 12 * 3600_000;
/** File times within this of the task start count as "after the start" (clock and file-system granularity). */
const START_SLACK_MS = 2000;
/** A snapshot taken this long after the task started is a late one. */
const LATE_AFTER_MS = 60_000;

export type SnapshotBy = 'intake' | 'claim' | 'gate' | 'runner' | 'user';

export interface LocalEntry {
  /** Repository-relative, forward slashes, exactly as git prints it. */
  path: string;
  /** The git object id of the path at the start, or `deleted`. */
  state: string;
}

export interface StartSnapshot {
  version: 1;
  repoId: string;
  taskId: string;
  /** HEAD when the snapshot was taken (null before the first commit). */
  base: string | null;
  recordedAt: string;
  by: SnapshotBy;
  entries: LocalEntry[];
  /** Local changes not recorded because an agent may have made them (they stay part of the change). */
  withheld: number;
}

export type PathVerdict = 'ticket' | 'local' | 'local-changed';

export interface LocalSplit<T> {
  kept: T[];
  /** Paths left out: present at the start and unchanged since. */
  leftOut: string[];
  /** Paths kept although they were in the snapshot: changed during the ticket. */
  changedSince: string[];
}

/** Git paths compare exactly; a path from the file system is made repository-relative with forward slashes. */
export function normRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function snapshotPath(repoId: string, taskId: string): string {
  return path.join(runDir(repoId, taskId), SNAPSHOT_FILE);
}

export function readStartSnapshot(repoId: string, taskId: string): StartSnapshot | null {
  if (!validId(repoId) || !validId(taskId)) return null;
  const s = readJsonOr<StartSnapshot | null>(snapshotPath(repoId, taskId), null);
  if (!s || s.version !== 1 || !Array.isArray(s.entries)) return null;
  const entries = s.entries.filter((e) => e && typeof e.path === 'string' && typeof e.state === 'string').map((e) => ({ path: normRel(e.path), state: e.state }));
  return { ...s, entries, withheld: typeof s.withheld === 'number' ? s.withheld : 0 };
}

export function writeStartSnapshot(s: StartSnapshot): string {
  const p = snapshotPath(s.repoId, s.taskId);
  writeJson(p, s);
  return p;
}

/** Paths with local changes (`git status --porcelain=v1 -z --untracked-files=all`): both sides of a rename, never ignored files. */
export function localChangePaths(root: string): string[] {
  // --no-optional-locks: status never refreshes (writes) the user's index.
  const r = rawGit(root, ['--no-optional-locks', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], 120_000);
  if (r.code !== 0) return [];
  const out = new Set<string>();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    if (xy === '!!') continue;
    out.add(normRel(rec.slice(3)));
    // With renames on, the original path follows as its own field.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = parts[i + 1];
      if (orig) out.add(normRel(orig));
      i++;
    }
  }
  return [...out].filter(Boolean).sort();
}

/** Object id of every path in a tree (blobs and nested repositories). */
export function treeStates(root: string, tree: string): Map<string, string> {
  const out = new Map<string, string>();
  const r = rawGit(root, ['ls-tree', '-r', '-z', '--full-tree', tree], 120_000);
  if (r.code !== 0) return out;
  for (const rec of r.stdout.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, id] = rec.slice(0, tab).split(' ');
    if (type === 'blob' || type === 'commit') out.set(rec.slice(tab + 1), id);
  }
  return out;
}

/** The working tree's `git write-tree` (the gate's own hashing; the user's index is never written). */
export function workingTreeOf(root: string): string | null {
  // Lazy: src/gate/context imports this module.
  const { workingTree } = require('../gate/context') as typeof import('../gate/context');
  return workingTree(root);
}

/** Paths an agent session edited in this repository lately (repository-relative; '' means "anything": a shell write to the folder). */
export function recentAgentEdits(root: string, repoId: string, now = Date.now(), windowMs = AGENT_EDIT_WINDOW_MS): string[] {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(stateDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const rootAbs = path.resolve(root);
  for (const n of names) {
    const s = readJsonOr<{ edits?: Array<{ path?: unknown; repo?: unknown; ts?: unknown }> } | null>(path.join(stateDir(), n), null);
    if (!s || !Array.isArray(s.edits)) continue;
    for (const e of s.edits) {
      if (!e || typeof e.path !== 'string') continue;
      const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
      if (Number.isFinite(ts) && ts < now - windowMs) continue;
      const rel = path.relative(rootAbs, path.resolve(e.path));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        if (e.repo === repoId) out.add('');
        continue;
      }
      out.add(normRel(rel));
    }
  }
  return [...out];
}

function under(rel: string, edited: string[]): boolean {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const p = ci ? rel.toLowerCase() : rel;
  return edited.some((e) => {
    const q = ci ? e.toLowerCase() : e;
    return q === '' || p === q || p.startsWith(q + '/');
  });
}

export interface TakeOptions {
  repoId: string;
  taskId: string;
  by: SnapshotBy;
  /** The working tree's write-tree (default: computed). */
  tree?: string | null;
  /** When the task started (brief createdAt): an agent-triggered snapshot records only what predates it. */
  taskStart?: string | Date;
  now?: number;
  /** Record nothing (a harness-made worktree holds no notes of the user's). */
  empty?: boolean;
}

/** Take a start snapshot of the repository now (not saved). */
export function takeStartSnapshot(root: string, o: TakeOptions): StartSnapshot {
  const now = o.now ?? Date.now();
  const head = rawGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 10_000);
  const snap: StartSnapshot = { version: 1, repoId: o.repoId, taskId: o.taskId, base: head.code === 0 ? head.stdout.trim() : null, recordedAt: new Date(now).toISOString(), by: o.by, entries: [], withheld: 0 };
  if (o.empty) return snap;
  const paths = localChangePaths(root);
  if (!paths.length) return snap;
  const tree = o.tree === undefined ? workingTreeOf(root) : o.tree;
  const states = tree ? treeStates(root, tree) : new Map<string, string>();
  const guarded = o.by !== 'user';
  const edited = guarded ? recentAgentEdits(root, o.repoId, now) : [];
  const start = o.taskStart === undefined ? NaN : new Date(o.taskStart).getTime();
  const late = guarded && Number.isFinite(start) && now - start > LATE_AFTER_MS;
  for (const p of paths) {
    const state = states.get(p) ?? DELETED;
    if (guarded) {
      if (under(p, edited)) {
        snap.withheld++;
        continue;
      }
      if (Number.isFinite(start)) {
        if (state === DELETED) {
          if (late) {
            snap.withheld++;
            continue;
          }
        } else {
          let m = NaN;
          try {
            m = fs.lstatSync(path.join(root, p)).mtimeMs;
          } catch {
            /* gone since the status */
          }
          if (!Number.isFinite(m) || m >= start - START_SLACK_MS) {
            snap.withheld++;
            continue;
          }
        }
      }
    }
    snap.entries.push({ path: p, state });
  }
  return snap;
}

/**
 * Record the snapshot for a task unless one is already there (`replace: true`
 * overwrites: the user's `harness task snapshot`, and the runner's empty one).
 */
export function recordStartSnapshot(root: string, o: TakeOptions & { replace?: boolean }): { snapshot: StartSnapshot; written: boolean; file: string } {
  const file = snapshotPath(o.repoId, o.taskId);
  if (!o.replace) {
    const have = readStartSnapshot(o.repoId, o.taskId);
    if (have) return { snapshot: have, written: false, file };
  }
  const snapshot = takeStartSnapshot(root, o);
  writeStartSnapshot(snapshot);
  return { snapshot, written: true, file };
}

// ---------------------------------------------------------------------------
// The one decision: is this path part of the ticket's change?
// ---------------------------------------------------------------------------

export interface LocalIndex {
  states: Map<string, string>;
  /** Paths changed by commits since the snapshot's base: never left out. */
  committed: Set<string>;
}

export function indexOf(s: StartSnapshot | null, committed: Iterable<string> = []): LocalIndex | null {
  if (!s || !s.entries.length) return null;
  return { states: new Map(s.entries.map((e) => [e.path, e.state])), committed: new Set([...committed].map(normRel)) };
}

/**
 * Whether a changed path belongs to the ticket. `current` is the path's object
 * id now, or null when it does not exist now.
 */
export function isTicketPath(idx: LocalIndex | null, rel: string, current: string | null): PathVerdict {
  if (!idx) return 'ticket';
  const p = normRel(rel);
  const was = idx.states.get(p);
  if (was === undefined) return 'ticket';
  if (idx.committed.has(p)) return 'local-changed';
  const now = current ?? DELETED;
  return now === was ? 'local' : 'local-changed';
}

/**
 * Split changed entries into the ticket's and the pre-existing ones. An entry
 * with an old path (a rename) is left out only when both sides are.
 */
export function partitionChanges<T extends { path: string; oldPath?: string }>(items: T[], idx: LocalIndex | null, current: (rel: string) => string | null): LocalSplit<T> {
  if (!idx) return { kept: items, leftOut: [], changedSince: [] };
  const kept: T[] = [];
  const leftOut: string[] = [];
  const changedSince = new Set<string>();
  for (const it of items) {
    const sides = it.oldPath && it.oldPath !== it.path ? [it.path, it.oldPath] : [it.path];
    const v = sides.map((s) => ({ s, v: isTicketPath(idx, s, current(s)) }));
    if (v.every((x) => x.v === 'local')) {
      leftOut.push(...sides);
      continue;
    }
    for (const x of v) if (x.v === 'local-changed') changedSince.add(x.s);
    kept.push(it);
  }
  return { kept, leftOut: [...new Set(leftOut)].sort(), changedSince: [...changedSince].sort() };
}

/** Paths that commits changed between two commits (both sides of renames). */
export function committedSince(root: string, from: string | null, to: string | null): string[] {
  if (!from || !to || from === to) return [];
  const r = rawGit(root, ['diff-tree', '-r', '--no-renames', '-z', '--name-only', from, to], 60_000);
  return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

/** The one-line count the gate prints (never the names). */
export function leftOutLine(n: number): string {
  return `${n} local change${n === 1 ? '' : 's'} present when the ticket started ${n === 1 ? 'was' : 'were'} left out of this check (\`harness gate --json\` lists them for you).`;
}

// ---------------------------------------------------------------------------
// Per brief: the repositories a brief maps (the same ones intake sets the current task for)
// ---------------------------------------------------------------------------

export interface BriefRepoSnapshot {
  repoId: string;
  name: string;
  root: string;
  snapshot: StartSnapshot | null;
}

function briefRepos(b: BriefFile): Array<{ repoId: string; name: string; root: string }> {
  const out: Array<{ repoId: string; name: string; root: string }> = [];
  for (const r of b.repos) {
    const info = b.repoMap?.repos?.[r];
    if (!info?.path) continue;
    out.push({ repoId: repoIdFor(info.path), name: info.name ?? r, root: info.path });
  }
  return out;
}

/** Record the start snapshot of every git repository a brief maps, where none is recorded yet. */
export function recordBriefSnapshots(b: BriefFile, by: SnapshotBy): BriefRepoSnapshot[] {
  const out: BriefRepoSnapshot[] = [];
  for (const r of briefRepos(b)) {
    let snapshot: StartSnapshot | null = null;
    try {
      if (rawGit(r.root, ['rev-parse', '--git-dir'], 5000).code === 0) snapshot = recordStartSnapshot(r.root, { repoId: r.repoId, taskId: b.id, by, taskStart: b.createdAt }).snapshot;
    } catch {
      /* the snapshot only narrows the change; without it everything counts, as before */
    }
    out.push({ ...r, snapshot });
  }
  return out;
}

/** The recorded snapshots of a brief's repositories (read-only). */
export function briefSnapshots(b: BriefFile): BriefRepoSnapshot[] {
  return briefRepos(b).map((r) => ({ ...r, snapshot: readStartSnapshot(r.repoId, b.id) }));
}

/** Lines for `harness intake show`: counts only. */
export function snapshotLines(list: BriefRepoSnapshot[]): string[] {
  const L: string[] = [];
  for (const r of list) {
    if (!r.snapshot) continue;
    const n = r.snapshot.entries.length;
    const w = r.snapshot.withheld;
    if (!n && !w) continue;
    L.push(
      `Local changes present at the start in ${r.name}: ${n} (left out of the gate and the write-up while they stay unchanged)` +
        (w ? `; ${w} more not recorded because an agent may have made them (to record them, run \`harness task snapshot --task ${r.snapshot.taskId}\` yourself in a terminal in that repository)` : ''),
    );
  }
  return L;
}
