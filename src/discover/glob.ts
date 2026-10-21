/**
 * Minimal glob matching for probe scopes and check scopes: `**` (any number
 * of folders, including none), `*` (anything but `/`), `?`, `{a,b}` and
 * `[...]` classes. Paths are relative and use forward slashes.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        const atSegEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atSegStart && atSegEnd) {
          if (glob[i + 2] === '/') {
            re += '(?:[^/]*/)*';
            i += 3;
          } else {
            re += '.*';
            i += 2;
          }
          continue;
        }
        re += '[^/]*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      inBrace++;
      re += '(?:';
      i++;
      continue;
    }
    if (c === '}' && inBrace) {
      inBrace--;
      re += ')';
      i++;
      continue;
    }
    if (c === ',' && inBrace) {
      re += '|';
      i++;
      continue;
    }
    if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i++;
  }
  const out = new RegExp('^' + re + '$');
  cache.set(glob, out);
  return out;
}

export function matchGlob(rel: string, glob: string): boolean {
  return globToRegExp(glob).test(rel);
}

export function matchAny(rel: string, globs: string[] | undefined): boolean {
  if (!globs || !globs.length) return false;
  return globs.some((g) => matchGlob(rel, g));
}

/** Include/exclude test: no include list means everything is included. */
export function inScope(rel: string, include: string[] | undefined, exclude: string[] | undefined): boolean {
  if (include && include.length && !matchAny(rel, include)) return false;
  if (exclude && exclude.length && matchAny(rel, exclude)) return false;
  return true;
}
