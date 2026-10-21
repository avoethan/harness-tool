/**
 * The landing lock (DESIGN §2.8): `~/.harness/runs/<repoId>/land.lock`, one
 * per repository, so landings are serial by construction and the culprit of
 * a red main is HEAD (R-17).
 *
 * The file holds `{pid, host, at, task}` and is created with `wx` (atomic:
 * exactly one process wins). A lock is stale after an hour, or at once when
 * its process is gone on this host. A stale lock is moved aside (rename,
 * also atomic) before the next attempt, so two waiters never both delete a
 * fresh lock. A second `harness land` waits (polling) up to its wait limit,
 * or fails fast with `--no-wait`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureDir } from '../lib/fsx';
import { runsDir } from '../lib/paths';

export const LOCK_STALE_MS = 60 * 60 * 1000;

export interface LockHolder {
  pid: number;
  host: string;
  at: string;
  task: string;
}

export type LockResult =
  | { ok: true; path: string; holder: LockHolder; release: () => void; tookOverStale: LockHolder | null; waitedMs: number }
  | { ok: false; path: string; holder: LockHolder | null; reason: string; waitedMs: number };

export interface LockOptions {
  task: string;
  /** Wait for a held lock (default) or fail fast. */
  wait?: boolean;
  /** How long to wait for a held lock (default 30 minutes). */
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
  now?: () => number;
  /** Whether a pid is alive on this host (tests override it). */
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export function landLockPath(repoId: string): string {
  return path.join(runsDir(), repoId, 'land.lock');
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readHolder(p: string): LockHolder | null {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<LockHolder>;
    if (typeof j.pid !== 'number' || typeof j.at !== 'string') return null;
    return { pid: j.pid, host: String(j.host ?? ''), at: j.at, task: String(j.task ?? '') };
  } catch {
    return null;
  }
}

/** Why a held lock is stale, or null when it is live. */
export function staleReason(holder: LockHolder | null, opts: { now: number; staleMs: number; alive: (pid: number) => boolean; mtimeMs?: number }): string | null {
  if (!holder) {
    // Unreadable content: judge by the file time only (a writer may be mid-write).
    if (opts.mtimeMs !== undefined && opts.now - opts.mtimeMs > 5000) return 'the lock file is unreadable';
    return null;
  }
  const at = Date.parse(holder.at);
  if (Number.isNaN(at)) return 'the lock has no valid time';
  if (opts.now - at > opts.staleMs) return `held since ${holder.at}, longer than ${Math.round(opts.staleMs / 60000)} minutes`;
  if (holder.host === os.hostname() && !opts.alive(holder.pid)) return `process ${holder.pid} is gone`;
  return null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Take the landing lock of a repository. */
export async function acquireLandLock(repoId: string, opts: LockOptions): Promise<LockResult> {
  const p = landLockPath(repoId);
  ensureDir(path.dirname(p));
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const alive = opts.alive ?? pidAlive;
  const sleep = opts.sleep ?? defaultSleep;
  const waitMs = opts.wait === false ? 0 : (opts.waitMs ?? 30 * 60 * 1000);
  const pollMs = opts.pollMs ?? 2000;
  const start = now();
  let tookOverStale: LockHolder | null = null;
  for (;;) {
    const holder: LockHolder = { pid: process.pid, host: os.hostname(), at: new Date(now()).toISOString(), task: opts.task };
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(holder) + '\n');
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const cur = readHolder(p);
        // Remove only our own lock.
        if (cur && cur.pid === holder.pid && cur.at === holder.at) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* already gone */
          }
        }
      };
      return { ok: true, path: p, holder, release, tookOverStale, waitedMs: now() - start };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const cur = readHolder(p);
    let mtimeMs: number | undefined;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue; // released between our attempts: try again at once
    }
    const why = staleReason(cur, { now: now(), staleMs, alive, mtimeMs });
    if (why) {
      const aside = `${p}.stale-${process.pid}-${now()}`;
      try {
        fs.renameSync(p, aside);
        fs.unlinkSync(aside);
        tookOverStale = cur ?? { pid: 0, host: '', at: '', task: '' };
      } catch {
        /* another process moved it first */
      }
      continue;
    }
    const waited = now() - start;
    if (waited >= waitMs) {
      const by = cur ? `process ${cur.pid} on ${cur.host || 'this host'} (task ${cur.task || '?'}, since ${cur.at})` : 'another process';
      return {
        ok: false,
        path: p,
        holder: cur,
        waitedMs: waited,
        reason: opts.wait === false ? `another landing holds the lock: ${by}. Run \`harness land\` again when it finishes (or without --no-wait to wait).` : `waited ${Math.round(waited / 1000)} s for the landing lock held by ${by}; try again later.`,
      };
    }
    await sleep(Math.min(pollMs, Math.max(1, waitMs - waited)));
  }
}
