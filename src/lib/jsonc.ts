/**
 * Parse JSON that may carry a BOM, // and /* comments, and trailing commas
 * (agent settings files are often written that way). Strings are respected.
 */
export function parseJsonc<T = unknown>(text: string): T {
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  s = stripComments(s);
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(s) as T;
}

export function tryParseJsonc<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseJsonc<T>(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function stripComments(s: string): string {
  let out = '';
  let i = 0;
  let inStr: string | null = null;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Deep union: arrays are concatenated without duplicates (by JSON value); objects merge; scalars from `add` win only when `base` has none. Existing entries are never removed. */
export function unionJson(base: unknown, add: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(add)) {
    const seen = new Set(base.map((x) => JSON.stringify(x)));
    const out = [...base];
    for (const x of add) {
      const k = JSON.stringify(x);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(x);
      }
    }
    return out;
  }
  if (isObj(base) && isObj(add)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(add as Record<string, unknown>)) {
      out[k] = k in out ? unionJson(out[k], v) : v;
    }
    return out;
  }
  return base === undefined ? add : base;
}

function isObj(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function getPath(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const k of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur: any = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
