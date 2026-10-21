export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Flags that never take a value, so `--yes file` keeps `file` positional. */
export const DEFAULT_BOOLEANS = new Set([
  'dry-run',
  'yes',
  'y',
  'force',
  'quiet',
  'q',
  'verbose',
  'v',
  'json',
  'help',
  'h',
  'all',
  'no-color',
  'interactive',
  'watch',
  'fix',
]);

/**
 * Tiny flag parser: `--key value`, `--key=value`, `--flag`, `--no-flag`,
 * repeated keys become arrays. `--` ends flag parsing. Flags named in
 * `booleans` never consume the next token; use `--key=value` when a value
 * could look like a flag. A lone `-` (standard input) is a value: `--from -`.
 */
export function parseArgv(argv: string[], booleans: Set<string> = DEFAULT_BOOLEANS): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let i = 0;
  const push = (k: string, v: string | boolean) => {
    if (k in flags) {
      const cur = flags[k];
      flags[k] = Array.isArray(cur) ? [...cur, String(v)] : [String(cur), String(v)];
    } else flags[k] = v;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        push(a.slice(2, eq), a.slice(eq + 1));
      } else if (a.startsWith('--no-')) {
        push(a.slice(5), false);
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        if (!booleans.has(k) && next !== undefined && (next === '-' || !next.startsWith('-'))) {
          push(k, next);
          i++;
        } else push(k, true);
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const k = a.slice(1);
      const next = argv[i + 1];
      if (!booleans.has(k) && next !== undefined && (next === '-' || !next.startsWith('-'))) {
        push(k, next);
        i++;
      } else push(k, true);
    } else positional.push(a);
    i++;
  }
  return { positional, flags };
}

export function flagStr(p: Parsed, k: string, def?: string): string | undefined {
  const v = p.flags[k];
  if (v === undefined) return def;
  if (Array.isArray(v)) return v[v.length - 1];
  return typeof v === 'boolean' ? (v ? '' : undefined) : v;
}

export function flagBool(p: Parsed, k: string, def = false): boolean {
  const v = p.flags[k];
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  return !['false', '0', 'no'].includes(String(v).toLowerCase());
}

export function flagList(p: Parsed, k: string): string[] {
  const v = p.flags[k];
  if (v === undefined || v === true || v === false) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
}

/** Every value of a repeatable flag, as given: no comma splitting (`host,port` or a path stays one value). */
export function flagValues(p: Parsed, k: string): string[] {
  const v = p.flags[k];
  if (v === undefined || v === true || v === false) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}
