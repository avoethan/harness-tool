/**
 * Markdown structure for classification: split a file into units (the
 * things that are classified together) and sections (heading scopes).
 *
 * A unit is a paragraph, one list item with its continuation lines, a whole
 * code fence, one table row, an HTML comment block, a heading, a blank line,
 * or one front-matter key with its continuation lines. Lines that belong
 * together are classified together; the user's wording is never changed.
 */

export type UnitKind =
  | 'blank'
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'fence'
  | 'table-row'
  | 'comment'
  | 'hr'
  | 'fm-delim'
  | 'fm-key';

export interface Unit {
  kind: UnitKind;
  /** 1-based first line. */
  start: number;
  /** 1-based last line (inclusive). */
  end: number;
  lines: string[];
  /** Heading level (1..6). */
  level?: number;
  /** Front-matter key. */
  key?: string;
  /** Index (into units) of the heading this unit sits under, or -1. */
  heading: number;
}

export interface Section {
  /** Index of the heading unit. */
  heading: number;
  title: string;
  level: number;
  start: number;
  /** Last line of the section (before the next heading of the same or a higher level). */
  end: number;
}

export interface MdDoc {
  lines: string[];
  units: Unit[];
  sections: Section[];
  /** Line range of front matter including delimiters, if any. */
  frontMatter: { start: number; end: number } | null;
}

export function splitLines(text: string): string[] {
  const t = text.replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(text: string, opts: { frontMatter?: boolean } = {}): MdDoc {
  const lines = splitLines(text);
  const units: Unit[] = [];
  let i = 0;
  let fm: MdDoc['frontMatter'] = null;
  let currentHeading = -1;

  const push = (u: Omit<Unit, 'heading'>) => {
    units.push({ ...u, heading: currentHeading });
  };

  // Front matter: only when the file starts with `---`.
  if ((opts.frontMatter ?? true) && lines.length > 1 && /^﻿?---\s*$/.test(lines[0])) {
    let close = -1;
    for (let j = 1; j < lines.length; j++) {
      if (/^---\s*$/.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close > 0) {
      fm = { start: 1, end: close + 1 };
      push({ kind: 'fm-delim', start: 1, end: 1, lines: [lines[0]] });
      let j = 1;
      while (j < close) {
        const kv = /^([A-Za-z0-9_.-]+)\s*:/.exec(lines[j]);
        let k = j + 1;
        while (k < close && (/^\s+/.test(lines[k]) || lines[k].trim() === '') && !/^([A-Za-z0-9_.-]+)\s*:/.test(lines[k])) k++;
        push({ kind: kv ? 'fm-key' : 'paragraph', start: j + 1, end: k, lines: lines.slice(j, k), key: kv ? kv[1] : undefined });
        j = k;
      }
      push({ kind: 'fm-delim', start: close + 1, end: close + 1, lines: [lines[close]] });
      i = close + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const n = i + 1;
    if (line.trim() === '') {
      push({ kind: 'blank', start: n, end: n, lines: [line] });
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      let j = i + 1;
      while (j < lines.length) {
        const close = FENCE_RE.exec(lines[j]);
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length && lines[j].trim().replace(/[`~]/g, '') === '') break;
        j++;
      }
      const end = Math.min(j, lines.length - 1);
      push({ kind: 'fence', start: n, end: end + 1, lines: lines.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      units.push({ kind: 'heading', start: n, end: n, lines: [line], level: h[1].length, heading: currentHeading });
      currentHeading = units.length - 1;
      i++;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      let j = i;
      while (j < lines.length && !lines[j].includes('-->')) j++;
      const end = Math.min(j, lines.length - 1);
      push({ kind: 'comment', start: n, end: end + 1, lines: lines.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (HR_RE.test(line)) {
      push({ kind: 'hr', start: n, end: n, lines: [line] });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      push({ kind: 'table-row', start: n, end: n, lines: [line] });
      i++;
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const indent = li[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') break;
        if (LIST_RE.test(l) || FENCE_RE.test(l) || HEADING_RE.test(l) || /^\s*\|/.test(l) || /^\s*<!--/.test(l)) break;
        // continuation: indented deeper than the marker, or a lazy continuation line
        if (/^\s*/.exec(l)![0].length < indent) break;
        j++;
      }
      push({ kind: 'list-item', start: n, end: j, lines: lines.slice(i, j) });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '' || LIST_RE.test(l) || FENCE_RE.test(l) || HEADING_RE.test(l) || /^\s*\|/.test(l) || /^\s*<!--/.test(l) || HR_RE.test(l)) break;
      j++;
    }
    const para = lines.slice(i, j);
    if (para.length > 1 && oneStatementPerLine(para)) {
      // Each line is a complete statement: the lines do not belong together.
      para.forEach((l, k) => push({ kind: 'paragraph', start: n + k, end: n + k, lines: [l] }));
    } else push({ kind: 'paragraph', start: n, end: j, lines: para });
    i = j;
  }

  const sections: Section[] = [];
  units.forEach((u, idx) => {
    if (u.kind !== 'heading') return;
    let end = lines.length;
    for (let k = idx + 1; k < units.length; k++) {
      const v = units[k];
      if (v.kind === 'heading' && (v.level ?? 6) <= (u.level ?? 6)) {
        end = v.start - 1;
        break;
      }
    }
    const m = HEADING_RE.exec(u.lines[0]);
    sections.push({ heading: idx, title: m ? m[2] : u.lines[0], level: u.level ?? 1, start: u.start, end });
  });
  return { lines, units, sections, frontMatter: fm };
}

/**
 * True when every line of a paragraph ends a sentence and the next one starts
 * a new one (the one-rule-per-line style). Hard-wrapped prose, where a
 * sentence runs on to the next line, stays one unit.
 */
export function oneStatementPerLine(lines: string[]): boolean {
  for (let k = 0; k < lines.length; k++) {
    const cur = lines[k].trim();
    if (!/[.!?]["')`*_]*$/.test(cur)) return false;
    if (k + 1 < lines.length && !/^["'(`*_]*[A-Z0-9`]/.test(lines[k + 1].trim())) return false;
  }
  return true;
}

/** Plain text of a unit: list markers, table pipes and emphasis removed; lines joined with spaces. */
export function unitText(u: Unit): string {
  return u.lines
    .map((l) => l.replace(LIST_RE, '').replace(/^\s*>\s?/, '').trim())
    .join(' ')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split prose into sentences, and by default into clauses at `;` too. */
export function sentences(text: string, opts: { semicolons?: boolean } = {}): string[] {
  const re = opts.semicolons === false ? /(?<=[.!?])\s+(?=[A-Z`*"'(\[0-9-])/ : /(?<=[.!?;])\s+(?=[A-Z`*"'(\[0-9-])|(?<=;)\s+/;
  return text
    .split(re)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Inline code spans in a line. */
export function codeSpans(line: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /(`+)([^`\n]+?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[2].trim(), index: m.index });
  return out;
}

/** True when a line sits inside a fenced code block (by unit). */
export function fenceLines(doc: MdDoc): Set<number> {
  const s = new Set<number>();
  for (const u of doc.units) if (u.kind === 'fence') for (let n = u.start + 1; n < u.end; n++) s.add(n);
  return s;
}

/** Normalise prose for duplicate detection: lower case, no markup, single spaces. */
export function normaliseProse(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_>#|]/g, ' ')
    .replace(/^\s*([-+]|\d+[.)])\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
