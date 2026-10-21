/**
 * Harness-owned entries in merged settings files, and replacing stale ones.
 *
 * A settings file (Claude `settings.json`, Devin `config.json`, Codex
 * `hooks.json`) gets the harness's hook entries and allow rules by a union
 * merge. The hook command and the `node "<cli.js>"` rules carry the absolute
 * path of the harness copy that rendered them. Installing again from another
 * copy (a second clone, a moved folder) would add a second set next to the
 * first, and the first set points at a folder that may be gone.
 *
 * The manifest records each union as a settings edit (`before` / `after`).
 * An array element present in `after` but not in `before` is one the harness
 * added. Before the next union, such an element is dropped when it names a
 * harness entry point (`dist/src/hook.js` or `dist/src/cli.js`) and the new
 * fragment does not carry it unchanged. Elements the manifest does not record
 * as harness-added (the user's own entries) are never touched.
 */
import type { SettingsEdit } from '../types';
import { samePath } from './manifest';

/** Same key spelling as apply's diffUnion (a segment with a dot is bracketed); kept here to avoid an import cycle. */
function joinKey(prefix: string, k: string): string {
  const seg = k.includes('.') || k.includes('[') ? `[${k}]` : k;
  return prefix ? `${prefix}.${seg}` : seg;
}

/** A harness entry point inside a hook command or an allow rule. */
export const HARNESS_ENTRY_RE = /dist[\\/]+src[\\/]+(?:hook|cli)\.js(?![\w.])/;

const J = (v: unknown): string => JSON.stringify(v);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Collect, per dotted array key, the JSON of the elements `after` holds and `before` does not. */
function collectAdded(before: unknown, after: unknown, key: string, out: Map<string, Set<string>>): void {
  if (Array.isArray(after)) {
    const had = new Set(Array.isArray(before) ? before.map(J) : []);
    const set = out.get(key) ?? new Set<string>();
    for (const x of after) if (!had.has(J(x))) set.add(J(x));
    if (set.size) out.set(key, set);
    return;
  }
  if (isObj(after)) {
    for (const [k, v] of Object.entries(after)) collectAdded(isObj(before) ? before[k] : undefined, v, joinKey(key, k), out);
  }
}

/** The harness-added array elements of one settings file, keyed by dotted array path. */
export function ownedArrayElements(edits: SettingsEdit[], file: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of edits) {
    if (!samePath(e.path, file)) continue;
    // the edit's key is the dotted path of the value it recorded
    collectAdded(e.before, e.after, e.key, out);
  }
  return out;
}

export interface PruneResult {
  base: Record<string, unknown>;
  /** Dotted array keys and how many stale harness elements were dropped there. */
  replaced: Array<{ key: string; count: number }>;
}

/**
 * Drop stale harness-owned elements from the arrays the fragment is about to
 * union into. Returns a new object; `base` is not changed.
 */
export function pruneStaleOwned(base: Record<string, unknown>, fragment: Record<string, unknown>, owned: Map<string, Set<string>>, prefix = ''): PruneResult {
  const out: Record<string, unknown> = { ...base };
  const replaced: PruneResult['replaced'] = [];
  for (const [k, fv] of Object.entries(fragment)) {
    const key = joinKey(prefix, k);
    const bv = out[k];
    if (Array.isArray(bv) && Array.isArray(fv)) {
      const mine = owned.get(key);
      if (!mine) continue;
      const incoming = new Set(fv.map(J));
      const kept = bv.filter((x) => {
        const s = J(x);
        return !(mine.has(s) && !incoming.has(s) && HARNESS_ENTRY_RE.test(s));
      });
      if (kept.length !== bv.length) {
        out[k] = kept;
        replaced.push({ key, count: bv.length - kept.length });
      }
    } else if (isObj(bv) && isObj(fv)) {
      const r = pruneStaleOwned(bv, fv, owned, key);
      if (r.replaced.length) {
        out[k] = r.base;
        replaced.push(...r.replaced);
      }
    }
  }
  return { base: out, replaced };
}
