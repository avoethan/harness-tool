/**
 * Where a ticket's concrete details live in the code. For each criterion the
 * terms are its routes, tables, file paths and quoted identifiers (from
 * `extractFacts`); every repository of the workspace is searched for them,
 * read-only and bounded (files, size, time). The result places a criterion in
 * the repositories whose files hold those details (`how: 'code'` in the brief)
 * and backs `harness intake scout`, which shows the evidence and can add the
 * repositories the brief misses. Names in the ticket are a guess; a route
 * string or a table name found in a file is evidence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CriterionFacts, RepoInfo } from './classify';

const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'tmp', '.idea', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv', '.harness', '.gradle', '.terraform', 'packages-lock', 'bower_components']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md|py|cs|java|go|rb|php|yml|yaml|html|cshtml|razor|vue|svelte|css|scss|txt|xml|sh|ps1|toml|graphql|gql|proto|env\.example|csproj|tf|hcl|properties|ini|cfg|conf)$/i;
const SKIP_FILE = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.map|.*\.snap|.*\.d\.ts)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_REPO = 8000;
const DEFAULT_BUDGET_MS = 4000;
const MAX_SAMPLES = 3;

/** Words that are quoted in tickets without naming anything in the code. */
const NOT_A_NAME = new Set(['true', 'false', 'null', 'none', 'error', 'success', 'done', 'ok', 'yes', 'no', 'user', 'users', 'admin', 'test', 'tests', 'value', 'values', 'name', 'type', 'data', 'item', 'items', 'list', 'page', 'button', 'click', 'save', 'cancel', 'submit', 'default', 'string', 'number', 'date', 'time', 'today', 'status', 'active', 'inactive', 'enabled', 'disabled', 'open', 'closed', 'new', 'old', 'low', 'high', 'total', 'count', 'id', 'key', 'main', 'master', 'develop']);

export type TermKind = 'route' | 'table' | 'path' | 'column' | 'quoted' | 'command';

export interface ScoutTerm {
  text: string;
  kind: TermKind;
  /** Routes, tables and paths are evidence on their own; the rest only in numbers. */
  strong: boolean;
}

export interface ScoutHit {
  term: string;
  kind: TermKind;
  files: number;
  /** Repository-relative paths, a few. */
  sample: string[];
}

export interface ScoutRepo {
  repoId: string;
  name: string;
  path: string;
  hits: ScoutHit[];
  /** Distinct strong terms found. */
  strong: number;
  /** Distinct terms found. */
  score: number;
  /** The walk stopped early (file cap or time budget); what was found still holds. */
  partial: boolean;
}

export interface ScoutResult {
  at: string;
  /** Per criterion id, the repositories with evidence, best first. */
  byCriterion: Record<string, string[]>;
  /** Per criterion id and repository id, the hits. */
  evidence: Record<string, Record<string, ScoutHit[]>>;
  repos: ScoutRepo[];
  /** Criteria with no term worth searching for (vague text). */
  noTerms: string[];
  budgetHit: boolean;
}

function word(s: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i');
}

/** Identifiers written bare in a sentence: `LowStockPanel`, `stock_levels`, `order-service`, `getOrders`. */
const BARE_IDENT_RES = [/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g, /\b[a-z]+(?:_[a-z0-9]+)+\b/g, /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g];

/** The search terms of one criterion; `text` adds identifiers written bare in the sentence. */
export function scoutTerms(facts: CriterionFacts, text = ''): ScoutTerm[] {
  const out = new Map<string, ScoutTerm>();
  const add = (text: string, kind: TermKind, strong: boolean) => {
    const t = text.trim();
    if (t.length < 3) return;
    const k = `${kind}:${t.toLowerCase()}`;
    if (!out.has(k)) out.set(k, { text: t, kind, strong });
  };
  for (const r of facts.routes) {
    // the literal path with parameters cut off at the first one: `/orders/:id/items` -> `/orders/`
    const literal = r.path.split('?')[0].replace(/[:{][^/]*.*$/, '');
    const segs = literal.split('/').filter((s) => s && !/^(api|v\d+)$/i.test(s));
    if (segs.length) add('/' + segs.join('/'), 'route', true);
    const last = segs[segs.length - 1];
    if (segs.length > 1 && last.length >= 5) add(last, 'route', false);
  }
  for (const t of facts.tables) add(t, 'table', true);
  for (const p of facts.paths) {
    add(p, 'path', true);
    const base = path.posix.basename(p.replace(/\\/g, '/'));
    if (base && base !== p) add(base, 'path', true);
  }
  for (const c of facts.columns) add(c.includes('.') ? c.split('.').pop()! : c, 'column', false);
  for (const q of facts.quoted) {
    const t = q.replace(/^["'`]+|["'`]+$/g, '');
    if (t.length < 4 || /\s/.test(t) || !/[A-Za-z]/.test(t) || NOT_A_NAME.has(t.toLowerCase())) continue;
    if (/^(GET|POST|PUT|PATCH|DELETE)\b/i.test(t) || t.startsWith('/')) continue;
    // identifiers (camelCase, snake_case, kebab-case, dotted) are names in code; plain words are not
    if (/[A-Z_\-.]/.test(t.slice(1)) || /\d/.test(t)) add(t, 'quoted', false);
  }
  for (const c of facts.commands) {
    const first = c.split(/\s+/)[0];
    if (first && first.length >= 4 && !NOT_A_NAME.has(first.toLowerCase())) add(first, 'command', false);
  }
  const plain = text.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const re of BARE_IDENT_RES) {
    for (const m of plain.match(re) ?? []) {
      if (m.length < 6 || NOT_A_NAME.has(m.toLowerCase()) || /^(e\.g|i\.e)/i.test(m)) continue;
      // a hyphenated English pair ("well-known", "read-only") is not an identifier; a code-looking one is
      if (re === BARE_IDENT_RES[2] && !/\d/.test(m) && m.split('-').every((w) => w.length <= 5)) continue;
      add(m, 'quoted', false);
    }
  }
  return [...out.values()];
}

interface Walked {
  files: Array<{ rel: string; abs: string }>;
  partial: boolean;
}

function walkRepo(root: string, deadline: number): Walked {
  const files: Walked['files'] = [];
  const stack = [root];
  let partial = false;
  while (stack.length) {
    if (files.length >= MAX_FILES_PER_REPO || Date.now() > deadline) {
      partial = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_IGNORE.has(e.name) && !e.name.startsWith('.')) stack.push(abs);
        continue;
      }
      if (!e.isFile() || !TEXT_EXT.test(e.name) || SKIP_FILE.test(e.name)) continue;
      files.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs });
    }
  }
  return { files, partial };
}

/**
 * Search `repos` for the terms of every criterion. `terms` maps a criterion id
 * to its terms; a term is searched once per file whoever asked for it.
 */
export function scout(terms: Record<string, ScoutTerm[]>, repos: RepoInfo[], opts: { budgetMs?: number; now?: Date } = {}): ScoutResult {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const all = new Map<string, { term: ScoutTerm; re: RegExp; needle: string }>();
  for (const list of Object.values(terms)) {
    for (const t of list) {
      const k = `${t.kind}:${t.text.toLowerCase()}`;
      if (!all.has(k)) all.set(k, { term: t, re: t.kind === 'route' || t.kind === 'path' ? new RegExp(t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : word(t.text), needle: t.text.toLowerCase() });
    }
  }
  const noTerms = Object.entries(terms)
    .filter(([, l]) => !l.length)
    .map(([id]) => id);
  const out: ScoutResult = { at: (opts.now ?? new Date()).toISOString(), byCriterion: {}, evidence: {}, repos: [], noTerms, budgetHit: false };
  if (!all.size) return out;

  for (const repo of repos) {
    const w = walkRepo(repo.path, deadline);
    const found = new Map<string, { files: number; sample: string[] }>();
    let partial = w.partial;
    for (const f of w.files) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      let text: string;
      try {
        const st = fs.statSync(f.abs);
        if (st.size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(f.abs, 'utf8');
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      for (const [k, t] of all) {
        if (!lower.includes(t.needle)) continue;
        if (!t.re.test(text)) continue;
        const e = found.get(k) ?? { files: 0, sample: [] };
        e.files += 1;
        if (e.sample.length < MAX_SAMPLES) e.sample.push(f.rel);
        found.set(k, e);
      }
    }
    if (partial) out.budgetHit = true;
    const hits: ScoutHit[] = [];
    for (const [k, e] of found) {
      const t = all.get(k)!.term;
      hits.push({ term: t.text, kind: t.kind, files: e.files, sample: e.sample });
    }
    hits.sort((a, b) => Number(isStrong(b)) - Number(isStrong(a)) || b.files - a.files);
    out.repos.push({ repoId: repo.id, name: repo.name, path: repo.path, hits, strong: hits.filter(isStrong).length, score: hits.length, partial });
  }

  for (const [id, list] of Object.entries(terms)) {
    out.byCriterion[id] = [];
    if (!list.length) continue;
    const keys = new Set(list.map((t) => `${t.kind}:${t.text.toLowerCase()}`));
    const ranked: Array<{ repoId: string; strong: number; score: number; hits: ScoutHit[] }> = [];
    for (const r of out.repos) {
      const hits = r.hits.filter((h) => keys.has(`${h.kind}:${h.term.toLowerCase()}`));
      if (!hits.length) continue;
      ranked.push({ repoId: r.repoId, strong: hits.filter(isStrong).length, score: hits.length, hits });
      (out.evidence[id] ??= {})[r.repoId] = hits;
    }
    ranked.sort((a, b) => b.strong - a.strong || b.score - a.score);
    // every repository holding a strong term (a route is defined in one and called from another); else weak
    // evidence counts when two terms agree, or one distinctive identifier (8+ characters) is in at most two repositories
    const strong = ranked.filter((r) => r.strong > 0);
    const reposPerTerm = new Map<string, number>();
    for (const r of ranked) for (const h of r.hits) reposPerTerm.set(h.term, (reposPerTerm.get(h.term) ?? 0) + 1);
    const distinctive = (r: (typeof ranked)[number]) => r.hits.some((h) => h.term.length >= 8 && (reposPerTerm.get(h.term) ?? 0) <= 2);
    const weak = ranked.filter((r) => r.score >= 2 || distinctive(r)).slice(0, 2);
    const picked = strong.length ? strong : weak;
    out.byCriterion[id] = picked.map((r) => r.repoId);
  }
  return out;
}

function isStrong(h: ScoutHit): boolean {
  return h.kind === 'route' || h.kind === 'table' || h.kind === 'path';
}

/** One line of evidence for people: `api: route /inventory/low in 3 files (src/routes/inventory.ts, ...)`. */
export function evidenceLine(name: string, hits: ScoutHit[]): string {
  const parts = hits.slice(0, 4).map((h) => `${h.kind} ${h.term} in ${h.files} file${h.files === 1 ? '' : 's'} (${h.sample.join(', ')})`);
  return `${name}: ${parts.join('; ')}${hits.length > 4 ? `; +${hits.length - 4} more` : ''}`;
}
