import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function sha256File(p: string): string | null {
  try {
    return sha256(fs.readFileSync(p));
  } catch {
    return null;
  }
}

export function shortId(seed?: string): string {
  const base = seed ? sha256(seed) : crypto.randomBytes(16).toString('hex');
  return base.slice(0, 12);
}

/** Stable hash of a JSON value (keys sorted). */
export function hashJson(v: unknown): string {
  return sha256(stableStringify(v));
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
