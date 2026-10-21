/**
 * The scrubber: proves the report carries nothing from the workspace.
 *
 * Token set (lower case), built from:
 *   - the repository folder names and the workspace root, home folder, user and host names;
 *   - every path segment of the files in the workspace (a walk capped at `maxFiles`),
 *     with the parts of a segment split on `-`, `_` and `.` (4+ characters);
 *   - identifiers longer than 6 characters, harvested with one regular expression
 *     from an evenly spaced sample of source files (first 64 KiB of each);
 *   - the words of every brief's title and criteria.
 *
 * A token is dropped when it is a word of the report's own fixed vocabulary
 * (headings, column names, tiers, families, modes, classes, verdicts,
 * outcomes, self-check step ids, JSON keys; see `reportVocabulary`), purely
 * numeric, or shorter than 3 characters (2 for a repository name). Those
 * words are in every report by construction, so they say nothing about the
 * workspace; the counts of dropped tokens are printed with the result.
 *
 * Matching is case-insensitive and by whole word: the report is split into
 * runs of letters and digits, and into runs that also keep `-`, `_` and `.`
 * (so `orders-api` matches as one word as well as `orders`). A leak is
 * reported by field path (`tasks[2].outcome`, `assessment.findingsByCheck{key}`,
 * `markdown line 40`), never by the token or the value.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Report } from '../types';
import { DEFAULT_IGNORE_DIRS, walkFiles } from '../lib/fsx';
import { renderMarkdown } from './markdown';
import { CHECK_ID_RE, CHECK_TYPES, CLASSES, FAMILIES, MODES, OUTCOMES, TIERS } from './build';
import { CODEX_STEPS, DEVIN_STEPS } from './selfcheck';
import { LANDING_WORDS, RAILS } from './digest';

export interface TokenSources {
  workspaceRoot?: string;
  repos?: Array<{ name?: string; path?: string; id?: string }>;
  briefs?: Array<{ title?: string; criteria?: Array<{ text?: string; ears?: string }>; repoMap?: { repos?: Record<string, { name?: string; path?: string }> } }>;
  /** Extra names (user, host, home folder); `defaultExtras()` gives the machine's. */
  extra?: string[];
  maxFiles?: number;
  maxSourceFiles?: number;
  maxBytesPerFile?: number;
}

export interface TokenStats {
  /** Distinct candidate tokens before filtering. */
  candidates: number;
  vocabulary: number;
  numeric: number;
  short: number;
  /** Tokens checked (after filtering). */
  checked: number;
  repos: number;
  files: number;
  sourceFiles: number;
  briefs: number;
}

export interface TokenSet {
  tokens: Set<string>;
  stats: TokenStats;
}

export interface ScrubResult {
  ok: boolean;
  checked: number;
  /** Field paths that carry a workspace token (never the token itself). */
  leaks: string[];
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|cs|java|go|rb|kt|kts|php|sql|vue|svelte|swift|rs|scala|c|h|cc|cpp|hpp|m|fs|ps1|psm1|sh)$/i;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]{6,}/g;

/** Words of a text: runs of letters/digits, and runs that keep - _ . inside (lower case). */
export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (const m of t.match(/[a-z0-9]+/g) ?? []) out.add(m);
  for (const m of t.match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]/g) ?? []) out.add(m);
  return out;
}

/** Candidate tokens of one raw string (a name, segment, identifier or word). */
export function candidatesOf(raw: string, minWhole = 3): string[] {
  const lower = raw.toLowerCase().trim();
  if (!lower) return [];
  const out: string[] = [];
  for (const whole of lower.split(/[^a-z0-9_.-]+/)) {
    const w = whole.replace(/^[-_.]+|[-_.]+$/g, '');
    if (w.length >= minWhole) out.push(w);
    else if (w) out.push(`\u0000short`);
    if (/[-_.]/.test(w)) for (const part of w.split(/[-_.]+/)) if (part.length >= 4) out.push(part);
  }
  return out;
}

let vocabCache: Set<string> | null = null;

/** A report with every key of the fixed vocabulary filled in. */
export function vocabularySample(): Report {
  const all = (keys: readonly string[]) => Object.fromEntries([...keys, 'other'].map((k) => [k, 1]));
  const steps = [...DEVIN_STEPS, ...CODEX_STEPS].map((s) => s.id);
  return {
    version: 1,
    generatedAt: '2000-01-01T00:00:00.000Z',
    harnessVersion: '0.0.0',
    period: { since: '2000-01-01', from: '2000-01-01', to: '2000-01-01' },
    standards: { byTier: all(TIERS), byFamily: all(FAMILIES) },
    checks: { generated: 1, byMode: all(MODES), byType: all(CHECK_TYPES) },
    assessment: { findingsByCheck: { R1: 1 }, classifications: all(CLASSES) },
    teamProposals: 1,
    tasks: [...OUTCOMES, 'none'].map((o, i) => ({
      ticketHash: '0'.repeat(64),
      criteria: 1,
      checksRun: 1,
      checksFailedThenFixed: 1,
      gateVerdict: (['PASS', 'FAIL', 'BLOCKED', 'none'] as const)[i % 4],
      verificationEvidence: 1,
      standardsFlagged: 1,
      clarificationsAsked: 1,
      repeatCorrections: 1,
      steeringMessages: 1,
      ...(i % 2 ? { reworkRounds: 1 } : {}),
      outcome: o,
      gateRuns: 1,
      capReached: true,
    })),
    learning: { captured: 1, proven: 1, approved: 1, expired: 1 },
    caps: { tasksAtGateCap: 1, stopReleasesAtCap: 1 },
    selfcheck: { devin: { steps: 1, recorded: 1, confirmed: steps, different: steps }, codex: { steps: 1, recorded: 1, confirmed: steps, different: steps }, claude: { steps: 1, recorded: 1, confirmed: [], different: [] } },
    worklogRows: 1,
    perTicket: [...LANDING_WORDS].map((w, i) => ({
      ticketHash: '0'.repeat(64),
      criteria: 1,
      gateAttempts: 1,
      gateVerdict: (['PASS', 'FAIL', 'BLOCKED', 'none'] as const)[i % 4],
      denials: 1,
      testsEntries: 1,
      expectChanges: 1,
      sessions: 1,
      costUsd: 1,
      landing: w,
      pullRequest: true,
      minutes: 1,
    })),
    rails: all(RAILS),
  };
}

function keysOf(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      for (const w of wordsOf(k)) out.add(w);
      keysOf(x, out);
    }
  } else if (typeof v === 'string') for (const w of wordsOf(v)) out.add(w);
}

/** Every word the report can carry by construction. */
export function reportVocabulary(): Set<string> {
  if (vocabCache) return vocabCache;
  const sample = vocabularySample();
  const v = new Set<string>();
  for (const w of wordsOf(renderMarkdown(sample))) v.add(w);
  keysOf(sample, v);
  for (const w of ['pass', 'fail', 'blocked', 'none', 'true', 'false', 'null']) v.add(w);
  vocabCache = v;
  return v;
}

/** The machine's own names: user, host, home folder segments. */
export function defaultExtras(): string[] {
  const out: string[] = [];
  try {
    out.push(os.userInfo().username);
  } catch {
    /* no user info */
  }
  out.push(os.hostname());
  out.push(...os.homedir().split(/[\\/]+/));
  return out.filter(Boolean);
}

function sampleEvenly<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const out: T[] = [];
  const step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

function readHead(file: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function buildTokenSet(src: TokenSources): TokenSet {
  const raw = new Set<string>();
  let short = 0;
  const add = (s: string | undefined, minWhole = 3) => {
    if (!s) return;
    for (const c of candidatesOf(s, minWhole)) {
      if (c === '\u0000short') short++;
      else raw.add(c);
    }
  };
  const maxFiles = src.maxFiles ?? 20000;
  const maxSource = src.maxSourceFiles ?? 400;
  const maxBytes = src.maxBytesPerFile ?? 64 * 1024;

  // Names and roots.
  const roots: string[] = [];
  if (src.workspaceRoot) {
    roots.push(src.workspaceRoot);
    for (const seg of src.workspaceRoot.split(/[\\/]+/)) add(seg);
  }
  let repos = 0;
  for (const r of src.repos ?? []) {
    repos++;
    add(r.name, 2);
    add(r.id, 2);
    if (r.path) {
      add(path.basename(r.path), 2);
      for (const seg of r.path.split(/[\\/]+/)) add(seg);
      if (!roots.some((root) => r.path!.startsWith(root))) roots.push(r.path);
    }
  }
  for (const e of src.extra ?? []) add(e);

  // Path segments and the source sample.
  const sources: string[] = [];
  let files = 0;
  for (const root of roots) {
    let list: string[] = [];
    try {
      list = walkFiles(root, { ignoreDirs: DEFAULT_IGNORE_DIRS, maxFiles: Math.max(0, maxFiles - files) });
    } catch {
      list = [];
    }
    for (const f of list) {
      files++;
      const rel = path.relative(root, f);
      for (const seg of rel.split(/[\\/]+/)) {
        add(seg);
        const ext = path.extname(seg);
        if (ext) add(seg.slice(0, -ext.length));
      }
      if (SOURCE_EXT.test(f)) sources.push(f);
    }
    if (files >= maxFiles) break;
  }
  const sample = sampleEvenly(sources.sort(), maxSource);
  for (const f of sample) {
    const text = readHead(f, maxBytes);
    for (const m of text.match(IDENT_RE) ?? []) add(m.replace(/\$/g, ''), 7);
  }

  // Briefs: titles, criteria and the repositories they mapped.
  let briefs = 0;
  for (const b of src.briefs ?? []) {
    briefs++;
    add(b.title);
    for (const c of b.criteria ?? []) {
      add(c.text);
      add(c.ears);
    }
    for (const r of Object.values(b.repoMap?.repos ?? {})) {
      add(r?.name, 2);
      if (r?.path) add(path.basename(r.path), 2);
    }
  }

  // Filter.
  const vocab = reportVocabulary();
  const tokens = new Set<string>();
  let vocabulary = 0;
  let numeric = 0;
  for (const t of raw) {
    if (!/[a-z]/.test(t)) {
      numeric++;
      continue;
    }
    if (vocab.has(t) || CHECK_ID_RE.test(t.toUpperCase())) {
      vocabulary++;
      continue;
    }
    tokens.add(t);
  }
  return {
    tokens,
    stats: { candidates: raw.size, vocabulary, numeric, short, checked: tokens.size, repos, files, sourceFiles: sample.length, briefs },
  };
}

function hits(text: string, tokens: Set<string>): boolean {
  for (const w of wordsOf(text)) if (tokens.has(w)) return true;
  return false;
}

/** Maps whose keys come from data (masked as `{key}` in a leak path). */
const DYNAMIC_MAPS = new Set(['byTier', 'byFamily', 'byMode', 'byType', 'findingsByCheck', 'classifications', 'selfcheck', 'rails']);

export function scrubValue(value: unknown, tokens: Set<string>, at = '', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scrubValue(v, tokens, `${at}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    const parentKey = at.split('.').pop() ?? '';
    const dynamic = DYNAMIC_MAPS.has(parentKey.replace(/\[\d+\]$/, ''));
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = dynamic ? `${at}{key}` : at ? `${at}.${k}` : k;
      if (hits(k, tokens)) out.push(dynamic ? `${at}{key}` : child);
      scrubValue(v, tokens, dynamic ? `${at}{key}` : child, out);
    }
  } else if (typeof value === 'string') {
    if (hits(value, tokens)) out.push(at || '(root)');
  }
  return out;
}

export function scrubMarkdown(md: string, tokens: Set<string>): string[] {
  const out: string[] = [];
  md.split('\n').forEach((line, i) => {
    if (hits(line, tokens)) out.push(`markdown line ${i + 1}`);
  });
  return out;
}

/** Check the report object (and its Markdown, when given) against the token set. */
export function scrubReport(report: Report, markdown: string | null, ts: TokenSet): ScrubResult {
  const leaks = [...new Set([...scrubValue(report, ts.tokens), ...(markdown !== null ? scrubMarkdown(markdown, ts.tokens) : [])])];
  return { ok: leaks.length === 0, checked: ts.tokens.size, leaks };
}

export function formatTokenStats(s: TokenStats): string {
  return `${s.checked} token(s) checked (from ${s.repos} repo(s), ${s.files} file path(s), ${s.sourceFiles} sampled source file(s), ${s.briefs} brief(s); ${s.vocabulary} dropped as the report's own words, ${s.numeric} numeric, ${s.short} too short)`;
}
