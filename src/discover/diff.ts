/**
 * A small unified-diff writer (line based, LCS) for proposal files. Inputs
 * are config and doc files, so a quadratic LCS is fine; very large inputs
 * are diffed as a whole replacement.
 */

interface Op {
  t: ' ' | '-' | '+';
  line: string;
}

function splitLines(s: string): string[] {
  const l = s.split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
}

function lcsOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 25_000_000) return [...a.map((line) => ({ t: '-' as const, line })), ...b.map((line) => ({ t: '+' as const, line }))];
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', line: a[i++] });
    else out.push({ t: '+', line: b[j++] });
  }
  while (i < n) out.push({ t: '-', line: a[i++] });
  while (j < m) out.push({ t: '+', line: b[j++] });
  return out;
}

/** Unified diff of `file` from `before` (null: a new file) to `after`; empty string when equal. */
export function unifiedDiff(file: string, before: string | null, after: string, context = 3): string {
  const ops = lcsOps(before === null ? [] : splitLines(before), splitLines(after));
  const changes = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (!changes.length) return '';
  const groups: Array<[number, number]> = [];
  for (const c of changes) {
    const last = groups[groups.length - 1];
    if (last && c - last[1] <= context * 2) last[1] = c;
    else groups.push([c, c]);
  }
  let out = `--- ${before === null ? '/dev/null' : `a/${file}`}\n+++ b/${file}\n`;
  for (const [first, lastChange] of groups) {
    const s = Math.max(0, first - context);
    const e = Math.min(ops.length, lastChange + context + 1);
    const before0 = ops.slice(0, s);
    const slice = ops.slice(s, e);
    const aStart = before0.filter((o) => o.t !== '+').length;
    const bStart = before0.filter((o) => o.t !== '-').length;
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    out += `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n`;
    for (const o of slice) out += `${o.t}${o.line}\n`;
  }
  return out;
}
