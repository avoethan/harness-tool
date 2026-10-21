/**
 * History: commit subjects (the subject probes count them), revert and
 * lint-fix ratios, CODEOWNERS, and review comments when `harness reviews
 * fetch` (another command) has saved them to ~/.harness/reviews/<repoId>.json.
 *
 * Only `git log` runs here (argv array, timeout). Subjects are data: they
 * are matched against probe patterns and quoted (redacted) as examples.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../lib/exec';
import { harnessHome } from '../lib/paths';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import type { RepoInventory } from './inventory';

export const HISTORY_LIMIT = 2000;

export interface Commit {
  sha: string;
  subject: string;
  merge: boolean;
}

export interface HistoryStats {
  repoId: string;
  total: number;
  merges: number;
  conventional: number;
  types: Record<string, number>;
  scopes: Record<string, number>;
  maxLength: number;
  p95Length: number;
  lowerCaseSummary: number;
  trailingPeriod: number;
  reverts: number;
  lintFixes: number;
  error?: string;
}

export interface CodeOwnersEntry {
  pattern: string;
  owners: string[];
  line: number;
}

export interface ReviewCluster {
  id: string;
  summary: string;
  comments: number;
  prs: number;
  reviewers: number;
  accepted: number;
  codeOwner: boolean;
  probe?: string;
  family?: string;
  examples: string[];
}

export interface RepoHistory {
  repoId: string;
  commits: Commit[];
  stats: HistoryStats;
  codeowners: { file: string; entries: CodeOwnersEntry[] } | null;
  reviews: { file: string; clusters: ReviewCluster[]; note?: string } | null;
}

const CONVENTIONAL = /^(feat|fix|chore|docs|style|refactor|perf|test|tests|build|ci|revert)(?:\(([\w./ -]+)\))?!?: (\S.*)$/;

export function readCommits(repoPath: string, limit = HISTORY_LIMIT): { commits: Commit[]; error?: string } {
  const r = run('git', ['-c', 'core.quotepath=off', 'log', `-n${limit}`, '--format=%H%x1f%P%x1f%s'], { cwd: repoPath, timeoutMs: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.code !== 0) return { commits: [], error: r.stderr.trim().split('\n')[0] || `git log exit ${r.code}` };
  const commits: Commit[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, parents, ...rest] = line.split('\x1f');
    commits.push({ sha, subject: rest.join('\x1f'), merge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1 });
  }
  return { commits };
}

export function subjectStats(repoId: string, commits: Commit[]): HistoryStats {
  const s: HistoryStats = { repoId, total: 0, merges: 0, conventional: 0, types: {}, scopes: {}, maxLength: 0, p95Length: 0, lowerCaseSummary: 0, trailingPeriod: 0, reverts: 0, lintFixes: 0 };
  const lens: number[] = [];
  for (const c of commits) {
    if (c.merge || /^Merge (branch|pull request|remote-tracking)/.test(c.subject)) {
      s.merges++;
      continue;
    }
    s.total++;
    lens.push(c.subject.length);
    if (/^revert\b|^Revert "/i.test(c.subject)) s.reverts++;
    if (/\b(lint|linting|prettier|format(ting)?|eslint)\b/i.test(c.subject) || /^style\b/i.test(c.subject)) s.lintFixes++;
    const m = CONVENTIONAL.exec(c.subject);
    if (m) {
      s.conventional++;
      s.types[m[1]] = (s.types[m[1]] ?? 0) + 1;
      if (m[2]) s.scopes[m[2]] = (s.scopes[m[2]] ?? 0) + 1;
      if (/^[a-z0-9`(]/.test(m[3])) s.lowerCaseSummary++;
      if (/\.$/.test(m[3])) s.trailingPeriod++;
    }
  }
  lens.sort((a, b) => a - b);
  s.maxLength = lens.length ? lens[lens.length - 1] : 0;
  s.p95Length = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.95))] : 0;
  return s;
}

export function parseCodeowners(text: string): CodeOwnersEntry[] {
  const out: CodeOwnersEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.replace(/#.*$/, '').trim();
    if (!l) return;
    const [pattern, ...owners] = l.split(/\s+/);
    if (owners.length) out.push({ pattern, owners, line: i + 1 });
  });
  return out;
}

function sanitize(s: unknown, max = 200): string {
  const t = redactText(stripHiddenUnicode(String(s ?? ''))).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Review clusters saved by `harness reviews fetch`. Accepted shape:
 * `{ clusters: [{ id, summary, comments, prs, reviewers, accepted, codeOwner?, probe?, family?, examples? }] }`
 * or raw `{ comments: [{ body, pr, author, accepted?, codeOwner? }] }`, which
 * are grouped by their normalised first sentence (a crude grouping; the
 * fetch command is expected to cluster properly).
 */
export function readReviews(repoId: string): RepoHistory['reviews'] {
  const file = path.join(harnessHome(), 'reviews', `${repoId}.json`);
  if (!fs.existsSync(file)) return null;
  let j: { clusters?: unknown[]; comments?: unknown[] };
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, clusters: [], note: `unreadable: ${(e as Error).message}` };
  }
  const clusters: ReviewCluster[] = [];
  if (Array.isArray(j.clusters)) {
    for (const c of j.clusters) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      clusters.push({
        id: sanitize(o.id, 64) || `cluster-${clusters.length + 1}`,
        summary: sanitize(o.summary),
        comments: Number(o.comments) || 0,
        prs: Number(o.prs) || 0,
        reviewers: Number(o.reviewers) || 0,
        accepted: Number(o.accepted) || 0,
        codeOwner: o.codeOwner === true,
        probe: typeof o.probe === 'string' ? o.probe : undefined,
        family: typeof o.family === 'string' ? o.family : undefined,
        examples: Array.isArray(o.examples) ? o.examples.slice(0, 3).map((x) => sanitize(x)) : [],
      });
    }
  } else if (Array.isArray(j.comments)) {
    const groups = new Map<string, { bodies: string[]; prs: Set<string>; reviewers: Set<string>; accepted: number; owner: boolean }>();
    for (const c of j.comments) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      const body = sanitize(o.body, 400);
      const key = body.toLowerCase().replace(/`[^`]*`/g, '').split(/[.!?\n]/)[0].replace(/[^a-z ]/g, '').trim().split(/\s+/).slice(0, 6).join(' ');
      if (!key) continue;
      const g = groups.get(key) ?? { bodies: [], prs: new Set<string>(), reviewers: new Set<string>(), accepted: 0, owner: false };
      g.bodies.push(body);
      g.prs.add(String(o.pr ?? ''));
      g.reviewers.add(String(o.author ?? ''));
      if (o.accepted === true) g.accepted++;
      if (o.codeOwner === true && o.accepted === true) g.owner = true;
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      clusters.push({ id: key.replace(/\s+/g, '-').slice(0, 48), summary: g.bodies[0], comments: g.bodies.length, prs: g.prs.size, reviewers: g.reviewers.size, accepted: g.accepted, codeOwner: g.owner, examples: g.bodies.slice(0, 3) });
    }
  }
  return { file, clusters };
}

export function repoHistory(inv: RepoInventory): RepoHistory {
  const { commits, error } = inv.repo.isGit ? readCommits(inv.repo.path) : { commits: [], error: 'not a git repository' };
  const stats = subjectStats(inv.repo.id, commits);
  if (error) stats.error = error;
  let codeowners: RepoHistory['codeowners'] = null;
  for (const rel of inv.configs.codeowners ?? []) {
    try {
      codeowners = { file: rel, entries: parseCodeowners(fs.readFileSync(path.join(inv.repo.path, rel), 'utf8')) };
      break;
    } catch {
      /* next */
    }
  }
  return { repoId: inv.repo.id, commits, stats, codeowners, reviews: readReviews(inv.repo.id) };
}
