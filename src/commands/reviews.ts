/**
 * `harness reviews fetch --repo <owner/name> [--path <local repo>] [--max-pages <n>] [--json]`
 * `harness reviews import --from <file|-> --path <local repo> [--json]`
 *
 * Past review comments as an input to discovery (review-derived standards).
 *
 * fetch    read-only: GET https://api.github.com/repos/{owner}/{repo}/pulls/comments,
 *          following the Link header (api.github.com only). The token comes from
 *          GITHUB_TOKEN / GH_TOKEN or `gh auth token` (argv array, timeout); it is
 *          never stored, printed or logged. On no token, 401, 403 or 404 it prints
 *          the pasted-comments fallback and exits 0.
 * import   the fallback: comments pasted into a text file, one per paragraph.
 *
 * Both write ~/.harness/reviews/<repoId>.json, the file discovery reads:
 * comment bodies kept with secret-shaped tokens redacted and hidden characters
 * removed, author logins hashed, and clusters of similar comments. This is
 * the only network use of the harness, and it only reads.
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import { CERT_HELP, isCertChainError, trustedCa } from '../lib/tlsca';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { loadConfig, repoIdFor } from '../lib/config';
import { run } from '../lib/exec';
import { readJsonOr, writeJson } from '../lib/fsx';
import { nearestRepoRoot, rawGit } from '../lib/git';
import { sha256 } from '../lib/hash';
import { instrument } from '../lib/log';
import { harnessHome, slug } from '../lib/paths';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';

export const meta: CommandMeta = {
  name: 'reviews',
  summary: 'Fetch past review comments read-only (optional)',
  usage: 'harness reviews fetch --repo <owner/name> [--path <local repo>] [--max-pages <n>] [--json] | harness reviews import --from <file|-> --path <local repo> [--json]',
  examples: ['harness reviews fetch --repo acme/billing-api --path ~/work/billing-api', 'harness reviews import --from comments.txt --path ~/work/billing-api'],
};

// ---------------------------------------------------------------------------
// HTTP (injectable for tests; never used by the test suite against the network)
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type HttpGet = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpResponse>;

const MAX_BODY = 20 * 1024 * 1024;

export const defaultHttpGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, timeout: timeoutMs, ca: trustedCa() }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (body.length < MAX_BODY) body += c;
      });
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h[k.toLowerCase()] = v;
        resolve({ status: res.statusCode ?? 0, headers: h, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });

let httpGet: HttpGet = defaultHttpGet;
/** Tests replace the HTTP layer; returns the previous one. */
export function setHttpGet(fn: HttpGet): HttpGet {
  const prev = httpGet;
  httpGet = fn;
  return prev;
}

/** One GET through the current HTTP layer (so other read-only fetchers share the test mock). */
export function httpGetOnce(url: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpResponse> {
  return httpGet(url, headers, timeoutMs);
}

export type HttpPost = (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<HttpResponse>;

/** One JSON POST (used only by the Jira writes, which the user runs; never by the test suite against the network). */
export const defaultHttpPost: HttpPost = (url, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const h = { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    const req = https.request(url, { method: 'POST', headers: h, timeout: timeoutMs, ca: trustedCa() }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (text.length < MAX_BODY) text += c;
      });
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
        resolve({ status: res.statusCode ?? 0, headers: out, body: text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });

let httpPost: HttpPost = defaultHttpPost;
/** Tests replace the HTTP POST layer; returns the previous one. */
export function setHttpPost(fn: HttpPost): HttpPost {
  const prev = httpPost;
  httpPost = fn;
  return prev;
}

/** One POST through the current HTTP layer. */
export function httpPostOnce(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HttpResponse> {
  return httpPost(url, headers, body, timeoutMs);
}

// ---------------------------------------------------------------------------
// token (never stored, printed or logged)
// ---------------------------------------------------------------------------

export type TokenRunner = () => { code: number | null; stdout: string };
const ghAuthToken: TokenRunner = () => {
  const r = run('gh', ['auth', 'token'], { timeoutMs: 10000 });
  return { code: r.code, stdout: r.stdout };
};

export function resolveToken(env: NodeJS.ProcessEnv = process.env, gh: TokenRunner = ghAuthToken): { token: string; source: 'env' | 'gh' } | null {
  const fromEnv = (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  try {
    const r = gh();
    const t = r.code === 0 ? r.stdout.trim() : '';
    if (t && !/\s/.test(t)) return { token: t, source: 'gh' };
  } catch {
    /* gh absent */
  }
  return null;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface RawComment {
  body?: string;
  user?: { login?: string } | null;
  pull_request_url?: string;
  path?: string;
  created_at?: string;
  position?: number | null;
  original_position?: number | null;
  line?: number | null;
}

export type FetchResult = { ok: true; comments: RawComment[]; pages: number } | { ok: false; status: number; message: string };

const API_HOST = 'api.github.com';

export function nextLink(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) {
      try {
        const u = new URL(m[1]);
        return u.protocol === 'https:' && u.hostname === API_HOST ? u.toString() : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function fetchReviewComments(repo: string, token: string, maxPages = 10, timeoutMs = 30000): Promise<FetchResult> {
  let url: string | null = `https://${API_HOST}/repos/${repo}/pulls/comments?per_page=100&sort=created&direction=desc`;
  const comments: RawComment[] = [];
  let pages = 0;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'harness-reviews', 'X-GitHub-Api-Version': '2022-11-28' };
  while (url && pages < maxPages) {
    let res: HttpResponse;
    try {
      res = await httpGet(url, headers, timeoutMs);
    } catch (e) {
      return { ok: false, status: 0, message: `network error: ${redactText((e as Error).message)}${isCertChainError(e) ? `. ${CERT_HELP}` : ''}` };
    }
    pages++;
    if (res.status !== 200) return { ok: false, status: res.status, message: `GitHub answered ${res.status}` };
    let list: unknown;
    try {
      list = JSON.parse(res.body);
    } catch {
      return { ok: false, status: res.status, message: 'GitHub answered with something that is not JSON' };
    }
    if (!Array.isArray(list)) return { ok: false, status: res.status, message: 'unexpected answer shape' };
    comments.push(...(list as RawComment[]));
    url = nextLink(res.headers.link);
  }
  return { ok: true, comments, pages };
}

// ---------------------------------------------------------------------------
// the reviews file (read by src/discover/history.ts readReviews)
// ---------------------------------------------------------------------------

export interface StoredComment {
  body: string;
  pr: string;
  author: string;
  path?: string;
  createdAt?: string;
  accepted: boolean;
}

export interface ReviewCluster {
  id: string;
  summary: string;
  comments: number;
  prs: number;
  reviewers: number;
  accepted: number;
  codeOwner: boolean;
  examples: string[];
}

export interface ReviewFile {
  version: 1;
  repo: string;
  source: 'github-api' | 'pasted';
  fetchedAt: string;
  notes: string[];
  comments: StoredComment[];
  clusters: ReviewCluster[];
}

const STOP = new Set(['the', 'this', 'that', 'and', 'for', 'with', 'you', 'please', 'could', 'should', 'would', 'here', 'there', 'can', 'are', 'not', 'use', 'its', 'it\'s', 'also', 'just', 'think', 'maybe', 'nit', 'why', 'what', 'have', 'has', 'was', 'were', 'will', 'into', 'from', 'than', 'then', 'them', 'they', 'our', 'your', 'about', 'too', 'again', 'still']);

/** Key of a comment for clustering: the first sentence's content words, sorted (a crude but stable grouping). */
export function clusterKey(body: string): string {
  // dotted identifiers (console.log, res.json) stay whole, so they do not end the sentence
  const first = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\b(\w+)\.(\w+)\b/g, '$1$2').split(/[.!?\n]/)[0] ?? '';
  const words = first.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].sort().slice(0, 5).join(' ');
}

export function cleanBody(s: string): string {
  return redactText(stripHiddenUnicode(String(s ?? ''))).replace(/\r\n/g, '\n').trim().slice(0, 4000);
}

export function hashLogin(login: string | undefined): string {
  return login ? sha256(`github-login:${login.toLowerCase()}`).slice(0, 12) : 'unknown';
}

export function toStored(c: RawComment): StoredComment | null {
  const body = cleanBody(c.body ?? '');
  if (!body) return null;
  const pr = /\/pulls\/(\d+)$/.exec(c.pull_request_url ?? '')?.[1] ?? '';
  // "accepted": the commented line changed after the comment (GitHub marks it outdated). A proxy, not a verdict.
  const accepted = c.position === null && typeof c.original_position === 'number';
  return { body, pr, author: hashLogin(c.user?.login), path: c.path, createdAt: c.created_at, accepted };
}

export function clusterComments(comments: StoredComment[]): ReviewCluster[] {
  const groups = new Map<string, StoredComment[]>();
  for (const c of comments) {
    const k = clusterKey(c.body);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const out: ReviewCluster[] = [];
  for (const [k, list] of groups) {
    out.push({
      id: slug(k).slice(0, 48) || `cluster-${out.length + 1}`,
      summary: list[0].body.split('\n')[0].slice(0, 200),
      comments: list.length,
      prs: new Set(list.map((c) => c.pr).filter(Boolean)).size,
      reviewers: new Set(list.map((c) => c.author)).size,
      accepted: list.filter((c) => c.accepted).length,
      codeOwner: false,
      examples: list.slice(0, 3).map((c) => c.body.slice(0, 300)),
    });
  }
  return out.sort((a, b) => b.comments - a.comments || a.id.localeCompare(b.id));
}

export function reviewsFile(repoId: string): string {
  return path.join(harnessHome(), 'reviews', `${repoId}.json`);
}

/** Merge new comments into the saved file (dedupe by body + PR), recluster, write. */
export function saveReviews(repoId: string, repo: string, source: ReviewFile['source'], add: StoredComment[], notes: string[]): ReviewFile {
  const file = reviewsFile(repoId);
  const prev = readJsonOr<ReviewFile | null>(file, null);
  const seen = new Set<string>();
  const all: StoredComment[] = [];
  for (const c of [...(prev?.comments ?? []), ...add]) {
    const k = sha256(`${c.pr}\n${c.body}`);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(c);
  }
  const out: ReviewFile = { version: 1, repo, source, fetchedAt: new Date().toISOString(), notes: [...new Set([...(prev?.notes ?? []), ...notes])], comments: all, clusters: clusterComments(all) };
  writeJson(file, out);
  return out;
}

// ---------------------------------------------------------------------------
// local repository for owner/name
// ---------------------------------------------------------------------------

function remoteMatches(dir: string, repo: string): boolean {
  const r = rawGit(dir, ['remote', '-v'], 5000);
  if (r.code !== 0) return false;
  const want = repo.toLowerCase();
  return r.stdout.toLowerCase().split('\n').some((l) => l.includes(`/${want}.git`) || l.includes(`:${want}.git`) || l.includes(`/${want} `) || l.includes(`:${want} `) || l.endsWith(`/${want}`));
}

export function localRepoFor(repo: string, pathFlag?: string): { id: string; path: string | null; note?: string } {
  if (pathFlag) {
    const root = nearestRepoRoot(path.resolve(pathFlag)) ?? path.resolve(pathFlag);
    return { id: repoIdFor(root), path: root };
  }
  for (const r of loadConfig()?.repos ?? []) if (remoteMatches(r.path, repo)) return { id: r.id || repoIdFor(r.path), path: r.path };
  const here = nearestRepoRoot(process.cwd());
  if (here && remoteMatches(here, repo)) return { id: repoIdFor(here), path: here };
  return { id: slug(repo.replace('/', '-')), path: null, note: `no local clone of ${repo} found among the configured repositories; saved under ${slug(repo.replace('/', '-'))} (pass --path <local repo> so discovery finds it)` };
}

function fallbackText(reason: string, repo: string): string {
  return [
    `Could not read review comments for ${repo} from GitHub (${reason}). Nothing was stored.`,
    'To use review comments anyway, paste them into a text file, one comment per paragraph (a blank line between comments), and run:',
    `  harness reviews import --from comments.txt --path <local clone of ${repo}>`,
    'Discovery then counts them as review-derived evidence.',
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, new Set(['json', 'help', 'h']));
  const sub = a.positional[0];
  const json = flagBool(a, 'json');
  if (sub === 'import') return importMode(a, json);
  if (sub !== 'fetch') {
    process.stderr.write(`reviews: unknown subcommand ${sub ?? '(none)'}\nUsage: ${meta.usage}\n`);
    return 2;
  }
  const repo = flagStr(a, 'repo') ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    process.stderr.write('reviews: --repo <owner/name> is required\n');
    return 2;
  }
  const maxPages = Number(flagStr(a, 'max-pages') ?? '10');
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    process.stderr.write('reviews: --max-pages needs a positive whole number\n');
    return 2;
  }
  const tok = resolveToken();
  if (!tok) {
    process.stdout.write(fallbackText('no token: set GITHUB_TOKEN or GH_TOKEN, or sign in with `gh auth login`', repo) + '\n');
    instrument({ event: 'reviews.fetch', ids: { outcome: 'no-token' } });
    return 0;
  }
  const res = await fetchReviewComments(repo, tok.token, maxPages);
  if (!res.ok) {
    const why = res.status === 401 ? 'the token was not accepted (401)' : res.status === 403 ? 'access denied or rate limited (403)' : res.status === 404 ? 'repository not found, or the token cannot see it (404)' : res.message;
    process.stdout.write(fallbackText(why, repo) + '\n');
    instrument({ event: 'reviews.fetch', ids: { outcome: 'fallback' }, counts: { status: res.status } });
    return 0;
  }
  const local = localRepoFor(repo, flagStr(a, 'path'));
  const stored = res.comments.map(toStored).filter((x): x is StoredComment => !!x);
  const notes = ['accepted = the commented line changed after the comment (GitHub marks it outdated); a proxy, not a reviewer verdict', 'author logins are hashed; bodies have secret-shaped tokens redacted'];
  if (local.note) notes.push(local.note);
  const f = saveReviews(local.id, repo, 'github-api', stored, notes);
  instrument({ event: 'reviews.fetch', ids: { outcome: 'ok', source: tok.source }, counts: { comments: stored.length, clusters: f.clusters.length, pages: res.pages } });
  if (json) process.stdout.write(JSON.stringify({ repo, repoId: local.id, file: reviewsFile(local.id), comments: f.comments.length, clusters: f.clusters.length, pages: res.pages }, null, 2) + '\n');
  else {
    process.stdout.write(`Fetched ${stored.length} review comment(s) from ${res.pages} page(s) for ${repo}; ${f.comments.length} stored, ${f.clusters.length} cluster(s).\n`);
    for (const c of f.clusters.slice(0, 5)) process.stdout.write(`  ${String(c.comments).padStart(3)} x  ${c.summary.slice(0, 100)}\n`);
    if (local.note) process.stdout.write(`Note: ${local.note}\n`);
    process.stdout.write(`Saved ${reviewsFile(local.id)} (run \`harness discover\` to count them).\n`);
  }
  return 0;
}

/** Split pasted comments: paragraphs separated by blank lines or `---` lines. */
export function splitPasted(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*(?:---+\s*)?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function importMode(a: ReturnType<typeof parseArgv>, json: boolean): Promise<number> {
  const from = flagStr(a, 'from');
  const p = flagStr(a, 'path');
  if (!from || !p) {
    process.stderr.write('reviews import: --from <file|-> and --path <local repo> are required\n');
    return 2;
  }
  let text: string;
  try {
    text = from === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(from), 'utf8');
  } catch (e) {
    process.stderr.write(`reviews import: cannot read ${from}: ${(e as Error).message}\n`);
    return 2;
  }
  const local = localRepoFor('', p);
  const stored = splitPasted(text).map((b) => ({ body: cleanBody(b), pr: '', author: 'unknown', accepted: false })).filter((c) => c.body);
  const f = saveReviews(local.id, path.basename(local.path ?? p), 'pasted', stored, ['pasted comments: PR, author and acceptance unknown']);
  instrument({ event: 'reviews.import', counts: { comments: stored.length, clusters: f.clusters.length } });
  if (json) process.stdout.write(JSON.stringify({ repoId: local.id, file: reviewsFile(local.id), comments: f.comments.length, clusters: f.clusters.length }, null, 2) + '\n');
  else process.stdout.write(`Imported ${stored.length} comment(s); ${f.comments.length} stored, ${f.clusters.length} cluster(s). Saved ${reviewsFile(local.id)}.\n`);
  return 0;
}
