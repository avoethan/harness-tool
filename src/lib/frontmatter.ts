/**
 * Minimal front matter parser for SKILL.md and rule files: the `key: value`
 * subset of YAML, with inline `[a, b]` arrays and `- item` lists, plus
 * quoted scalars. Anything else is kept as a raw string.
 */
export interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
  raw: string | null;
  /** 1-based line where the body starts. */
  bodyLine: number;
}

export function parseFrontMatter(text: string): FrontMatter {
  const m = /^(?:﻿)?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, raw: null, bodyLine: 1 };
  const raw = m[1];
  const body = text.slice(m[0].length);
  const data: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '' || val === '|' || val === '>') {
      // block list or block scalar
      const items: string[] = [];
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j].trim() === '')) {
        const l = lines[j];
        const li = /^\s*-\s+(.*)$/.exec(l);
        if (li) items.push(unquote(li[1].trim()));
        else block.push(l.replace(/^\s{0,2}/, ''));
        j++;
      }
      if (items.length) data[key] = items;
      else if (val === '|' || val === '>') data[key] = block.join('\n').trim();
      else data[key] = block.join('\n').trim() || '';
      i = j;
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = splitInlineList(val.slice(1, -1))
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== '');
    } else if (val === 'true' || val === 'false') data[key] = val === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(val)) data[key] = Number(val);
    else data[key] = unquote(val);
    i++;
  }
  const bodyLine = m[0].split('\n').length;
  return { data, body, raw, bodyLine };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // Double-quoted scalars carry JSON-style escapes (what renderFrontMatter writes).
    try {
      const v = JSON.parse(s);
      if (typeof v === 'string') return v;
    } catch {
      /* not valid JSON: fall back to stripping the quotes */
    }
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Split `a, "b, c", 'd'` on commas outside quotes. */
function splitInlineList(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i];
      } else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A plain scalar that would not read back as the same string needs quotes. */
function needsQuotes(v: string): boolean {
  return (
    v === '' ||
    /[:#\n"'\[\]{},\\]/.test(v) ||
    /^\s|\s$/.test(v) ||
    /^[-|>!&*?@`%]/.test(v) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)
  );
}

export function renderFrontMatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`);
    else if (typeof v === 'string' && needsQuotes(v)) lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${String(v)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}
