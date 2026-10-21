/**
 * E2E artefacts written by `harness verify drive` and `harness verify db`,
 * read by the gate (src/gate/e2e.ts) and the write-up:
 *
 *   ~/.harness/runs/<repoId>/<taskId>/e2e/<id>.json
 *     { version: 1, id, kind: 'http' | 'db', criterion?, treeHash, createdAt, pass, ... }
 *
 * `<id>` is `<criterionId>-http` / `<criterionId>-db` when the artefact
 * proves a brief criterion (given with --criterion, or matched from the
 * brief's own `run:` line), else a name derived from the route or table.
 *
 * Redaction by construction: request and response headers named
 * Authorization, Cookie, Set-Cookie, X-Api-Key (and friends) are dropped,
 * secret-named body fields are replaced, secret-shaped values are masked,
 * bodies are capped at 16 KB, and a DB artefact stores only the columns an
 * assertion names.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonOr, writeJson } from '../lib/fsx';
import { DROP_HEADERS, findSecrets, isSecretName, redactObject, redactText } from '../lib/redact';
import { writeTree } from '../lib/git';
import { e2eDir } from './state';

export const BODY_CAP_BYTES = 16 * 1024;
export const DB_ROWS_CAP = 50;

export interface Assertion {
  /** status | json | body | header | rows | columns | p50 | p95 | p99 | value */
  kind: string;
  /** What was expected, as text (`201`, `order.status=pending`). */
  expect: string;
  /** What was seen, redacted (absent when it would be a secret). */
  actual?: string;
  pass: boolean;
  detail?: string;
}

export interface SchemaChange {
  service: string;
  id: string;
  file: string;
  sha256: string;
}

interface ArtefactBase {
  version: 1;
  id: string;
  criterion?: string;
  treeHash: string;
  /** Tree of every repository in the run (cross-repo mode). */
  trees?: Record<string, string>;
  createdAt: string;
  pass: boolean;
  runId?: string;
  repoId: string;
  taskId: string;
  assertions: Assertion[];
  /** Migrations added or changed by this work that make up the run's shared schema. */
  schemaChanges?: SchemaChange[];
  /** The equivalent command a person (or the agent) can run. */
  command?: string;
  /** The run's services had an unreachable database on purpose (`verify launch --db-unreachable`). */
  dbUnreachable?: boolean;
}

export interface HttpArtefact extends ArtefactBase {
  kind: 'http';
  service?: string;
  route: string;
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  headers: Record<string, string>;
  droppedHeaders: string[];
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  body?: unknown;
  bodyText?: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  repeat?: { n: number; statuses: Record<string, number>; p50: number; p95: number; p99: number; max: number };
  auth?: { user: string; via: string };
}

export interface DbArtefact extends ArtefactBase {
  kind: 'db';
  server: string;
  database: string;
  table?: string;
  recipe?: string;
  /** The SQL text as run (parameter values are listed separately and redacted). */
  query?: string;
  params?: Record<string, string>;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  rowsTruncated: boolean;
}

export type Artefact = HttpArtefact | DbArtefact;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Headers with the secret ones removed (names lower-cased); returns the dropped names too. */
export function redactHeaders(h: Record<string, string> | Array<[string, string]>): { headers: Record<string, string>; dropped: string[] } {
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  const entries = Array.isArray(h) ? h : Object.entries(h);
  for (const [k0, v] of entries) {
    const k = k0.toLowerCase();
    if (DROP_HEADERS.has(k) || isSecretName(k)) {
      if (!dropped.includes(k)) dropped.push(k);
      continue;
    }
    headers[k] = redactText(String(v));
  }
  return { headers, dropped: dropped.sort() };
}

/** A body redacted and capped: parsed JSON when it parses and fits, else text. */
export function redactBody(raw: string, contentType = ''): { body?: unknown; bodyText?: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(raw, 'utf8');
  let parsed: unknown;
  let isJson = false;
  if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) {
    try {
      parsed = JSON.parse(raw);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  if (isJson) {
    const red = redactObject(parsed);
    const text = JSON.stringify(red);
    if (Buffer.byteLength(text, 'utf8') <= BODY_CAP_BYTES) return { body: red, bytes, truncated: false };
    return { bodyText: capText(text), bytes, truncated: true };
  }
  const text = redactText(raw);
  if (Buffer.byteLength(text, 'utf8') <= BODY_CAP_BYTES) return { bodyText: text, bytes, truncated: false };
  return { bodyText: capText(text), bytes, truncated: true };
}

function capText(text: string): string {
  let out = text.slice(0, BODY_CAP_BYTES);
  while (Buffer.byteLength(out, 'utf8') > BODY_CAP_BYTES) out = out.slice(0, -64);
  // Never cut through a masked marker in a way that leaves a secret prefix: re-mask the tail.
  return redactText(out);
}

/** A display value for an assertion: masked when the path or the value is secret-like. */
export function safeActual(pathOrName: string, v: unknown): string | undefined {
  if (pathOrName && pathOrName.split(/[.[\]]/).some((seg) => seg && isSecretName(seg))) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return 'undefined';
  if (findSecrets(s).length) return '[REDACTED]';
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

/** Keep only the named columns of each row (and at most DB_ROWS_CAP rows). */
export function keepColumns(rows: Array<Record<string, unknown>>, columns: string[]): { rows: Array<Record<string, unknown>>; truncated: boolean } {
  const want = columns.map((c) => c.toLowerCase());
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows.slice(0, DB_ROWS_CAP)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!want.includes(k.toLowerCase())) continue;
      o[k] = isSecretName(k) ? '[DROPPED]' : typeof v === 'string' ? redactText(v) : v;
    }
    out.push(o);
  }
  return { rows: out, truncated: rows.length > DB_ROWS_CAP };
}

// ---------------------------------------------------------------------------
// Ids and files
// ---------------------------------------------------------------------------

const ART_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function validArtefactId(id: string): boolean {
  return ART_ID_RE.test(id) && !id.includes('..');
}

/** `POST /orders/:id/pay` -> `post-orders-id-pay`. */
export function routeSlug(method: string, p: string): string {
  const s = `${method}-${p}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'request';
}

export function artefactId(kind: 'http' | 'db', criterion: string | undefined, fallback: string): string {
  if (criterion) return `${criterion}-${kind}`;
  const id = `${fallback}-${kind}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 110);
  return id;
}

export function artefactPath(runDir: string, id: string): string {
  if (!validArtefactId(id)) throw new Error(`invalid artefact id ${JSON.stringify(id.slice(0, 40))}`);
  return path.join(e2eDir(runDir), `${id}.json`);
}

/** Write an artefact after a last secret check over its serialised form (masked if anything slipped through). */
export function writeArtefact(runDir: string, art: Artefact): string {
  const p = artefactPath(runDir, art.id);
  let text = JSON.stringify(art, null, 2);
  if (findSecrets(text).length) {
    const masked = JSON.parse(redactText(text)) as Artefact;
    text = JSON.stringify(masked, null, 2);
    art = masked;
  }
  writeJson(p, art);
  return p;
}

export interface ListedArtefact {
  id: string;
  kind: string;
  file: string;
  /** Relative to the run folder. */
  rel: string;
  treeHash: string;
  createdAt: string;
  pass: boolean | null;
  criterion?: string;
  summary: string;
}

export function readArtefacts(runDir: string): ListedArtefact[] {
  const dir = e2eDir(runDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: ListedArtefact[] = [];
  for (const n of names) {
    const j = readJsonOr<Record<string, unknown> | null>(path.join(dir, n), null);
    if (!j || typeof j !== 'object') continue;
    const id = typeof j.id === 'string' ? j.id : n.slice(0, -5);
    const kind = typeof j.kind === 'string' ? j.kind : 'http';
    const pass = j.pass === false || j.ok === false ? false : j.pass === true || j.ok === true ? true : null;
    let summary = '';
    if (kind === 'http') summary = `${typeof j.route === 'string' && j.route ? j.route : `${String(j.method ?? '')} ${String(j.url ?? '')}`} -> ${String(j.status ?? '?')}`;
    else if (kind === 'db') summary = `${j.table ? `table ${String(j.table)}` : j.recipe ? `recipe ${String(j.recipe)}` : 'query'}: ${String(j.rowCount ?? '?')} row(s)`;
    out.push({ id, kind, file: path.join(dir, n), rel: `e2e/${n}`, treeHash: typeof j.treeHash === 'string' ? j.treeHash : '', createdAt: typeof j.createdAt === 'string' ? j.createdAt : '', pass, criterion: typeof j.criterion === 'string' ? j.criterion : undefined, summary });
  }
  return out;
}

/** The tree hash the gate and the Stop hook compare against. */
export function currentTree(repoRoot: string): string {
  return writeTree(repoRoot) ?? '';
}
