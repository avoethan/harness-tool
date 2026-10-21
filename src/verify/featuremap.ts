/**
 * The generated layer of the feature map: an inventory re-derived from code
 * on every `verify launch` (and by `verify map build`), stored at
 * `~/.harness/runs/<repoId>/feature-map.json`.
 *
 *   services   every package in the workspace with a start/dev script: its
 *              scripts, the variables its .env.example declares (names; the
 *              values only for non-secret names), its port variable, its DB
 *              variables, its health route, and `needs` (other services an
 *              env variable points at: CATALOG_URL -> catalog-api)
 *   routes     Express / Koa-router / Fastify / NestJS registrations found
 *              with regexes (method, full path including the router's mount
 *              prefix, handler file:line, status codes seen in the handler)
 *   migrations ordered migration files per service, the tables they create
 *              or alter and the tables they reference
 *
 * Reads files as data; never runs repository code. `.env` files themselves
 * are never read (only `.env.example` and its siblings).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonOr, readTextOr, walkFiles, writeJson } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { repoIdFor } from '../lib/config';
import { nearestRepoRoot } from '../lib/git';
import { isSecretName } from '../lib/redact';
import { toPosix } from '../lib/paths';
import { envStem } from './runenv';
import { featureMapPath } from './state';

export type Framework = 'express' | 'koa' | 'fastify' | 'nestjs' | 'unknown';

export interface RouteEntry {
  /** `<METHOD> <full path>` — the overlay key and the gate's route id. */
  id: string;
  method: string;
  path: string;
  /** The path as written at the registration (without the mount prefix). */
  localPath: string;
  service: string;
  repoId: string;
  /** Repository-relative, forward slashes. */
  file: string;
  line: number;
  framework: Framework;
  statuses: number[];
  /** Hash of what maintain compares (method, path, file, statuses). */
  fingerprint: string;
}

export interface MigrationEntry {
  /** File name without extension (the gate's migration id). */
  id: string;
  service: string;
  repoId: string;
  /** Repository-relative. */
  file: string;
  kind: 'sql' | 'code';
  tables: string[];
  references: string[];
  sha256: string;
}

export interface ServiceEntry {
  name: string;
  repoId: string;
  repoRoot: string;
  /** Folder of the package (absolute). */
  dir: string;
  envName: string;
  scripts: { start?: string; dev?: string };
  /** Variables the .env.example declares, in order. */
  envVars: string[];
  /** Non-secret example values (secret-named variables never carry a value here). */
  envDefaults: Record<string, string>;
  portVar?: string;
  examplePort?: number;
  db: { serverVar?: string; portVar?: string; nameVar?: string; userVar?: string; passwordVar?: string; urlVar?: string; exampleName?: string };
  /** Other services this one calls: variable -> service name. */
  needs: Record<string, string>;
  health?: string;
  migrationsDir?: string;
  routes: number;
}

export interface FeatureMap {
  version: 1;
  generatedAt: string;
  workspaceRoot: string;
  services: ServiceEntry[];
  routes: RouteEntry[];
  migrations: MigrationEntry[];
  tables: string[];
  notes: string[];
}

const SRC_RE = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_RE = /(^|\/)(?:__tests__|tests?|specs?|e2e|fixtures?|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/i;
const METHODS = 'get|post|put|patch|delete|options|head|all';
const DEFAULT_ROUTER_NAME = /^(?:app|router|server|fastify|api|routes?|[A-Za-z_$][\w$]*Router|[A-Za-z_$][\w$]*router|[A-Za-z_$][\w$]*Routes|instance)$/;
const NON_ROUTER_NAME = /^(?:axios|http|https|client|[A-Za-z_$][\w$]*Client|request|got|superagent|ky|fetch|res|req|reply|ctx|map|cache|params|headers|searchParams|query|store|redis|localStorage|sessionStorage|config|env|process|object|json|db|pool|repo|repository|knex|prisma)$/;
export const MIGRATION_DIRS = ['migrations', 'db/migrations', 'database/migrations', 'sql/migrations', 'src/migrations', 'db/migrate', 'migrations/sql'];
const HEALTH_PATH_RE = /^\/(?:health|healthz|healthcheck|ready|readyz|readiness|status|livez|ping)$/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function joinRoute(prefix: string, local: string): string {
  const parts = [prefix, local]
    .map((p) => p.trim())
    .filter((p) => p && p !== '/')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return '/' + parts.join('/');
}

export function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function routeId(method: string, p: string): string {
  return `${method.toUpperCase()} ${p}`;
}

function fingerprintOf(r: Pick<RouteEntry, 'method' | 'path' | 'file' | 'statuses'>): string {
  return sha256(JSON.stringify([r.method, r.path, r.file, r.statuses])).slice(0, 16);
}

/** Status codes visible in a handler's text. */
export function statusesIn(text: string): number[] {
  const out = new Set<number>();
  const res = [/\.(?:status|sendStatus|code)\(\s*(\d{3})\s*\)/g, /\bstatus(?:Code)?\s*[:=]\s*(\d{3})\b/g, /@HttpCode\(\s*(\d{3})\s*\)/g, /\b[A-Za-z_$][\w$]*(?:Error|Exception|error)\(\s*(\d{3})\b/g, /\bHttpException\([^)]*,\s*(\d{3})\s*\)/g];
  for (const re of res) for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 599) out.add(n);
  }
  // Helpers named after a status (`badRequest(`, `notFound(`, `conflict(`)
  const named: Array<[RegExp, number]> = [
    [/\bbadRequest\s*\(/, 400],
    [/\bunauthori[sz]ed\s*\(/i, 401],
    [/\bforbidden\s*\(/i, 403],
    [/\bnotFound\s*\(/, 404],
    [/\bconflict\s*\(/, 409],
    [/\bunprocessable\w*\s*\(/i, 422],
  ];
  for (const [re, n] of named) if (re.test(text)) out.add(n);
  if (![...out].some((n) => n >= 200 && n < 300)) out.add(200);
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Route extraction (one file)
// ---------------------------------------------------------------------------

export interface RawRoute {
  method: string;
  localPath: string;
  /** Router object name, or the controller class for NestJS. */
  router: string;
  line: number;
  index: number;
  framework: Framework;
  statuses: number[];
  /** A prefix declared on the router itself (Koa `new Router({ prefix })`, Nest `@Controller('x')`). */
  ownPrefix?: string;
}

export interface Mount {
  /** Object the router is mounted on (`app`, `router`). */
  on: string;
  prefix: string;
  /** Identifier of the mounted router or plugin. */
  target: string;
  line: number;
}

export interface FileRoutes {
  routes: RawRoute[];
  mounts: Mount[];
  /** Router identifiers this file declares (`const x = Router()`), with their own prefix. */
  declares: Record<string, { prefix?: string; framework: Framework }>;
  /** Named imports: identifier -> module specifier. */
  imports: Record<string, string>;
  /** Exported names (functions or consts). */
  exports: string[];
}

function frameworkOf(text: string): Framework {
  if (/@nestjs\/common/.test(text)) return 'nestjs';
  if (/\bfrom\s+['"]fastify['"]|require\(\s*['"]fastify['"]\s*\)|FastifyInstance|FastifyPluginAsync/.test(text)) return 'fastify';
  if (/['"](?:@koa\/router|koa-router)['"]/.test(text)) return 'koa';
  if (/['"]express['"]/.test(text)) return 'express';
  return 'unknown';
}

/** Extract registrations, mounts, router declarations and imports from one source file. */
export function extractRoutes(text: string): FileRoutes {
  const fw = frameworkOf(text);
  const declares: FileRoutes['declares'] = {};
  const imports: Record<string, string> = {};
  const exportsList: string[] = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/);
      const local = (nm[1] ?? nm[0]).trim();
      if (local) imports[local] = m[2];
    }
  }
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g)) imports[m[1]] = m[2];
  for (const m of text.matchAll(/(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[2]) imports[m[2]] = m[3];
    else for (const part of (m[1] ?? '').split(',')) {
      const nm = part.trim().split(/\s*:\s*/);
      const local = (nm[1] ?? nm[0]).trim();
      if (local) imports[local] = m[3];
    }
  }
  for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) exportsList.push(m[1]);
  for (const m of text.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) exportsList.push(m[1]);
  // Router / app declarations
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>]+\s*)?=\s*(?:express\s*\.\s*)?Router\s*\(/g)) declares[m[1]] = { framework: 'express' };
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>]+\s*)?=\s*express\s*\(\s*\)/g)) declares[m[1]] = { framework: 'express' };
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>]+\s*)?=\s*(?:Fastify|fastify)\s*\(/g)) declares[m[1]] = { framework: 'fastify' };
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>]+\s*)?=\s*new\s+(?:Koa)?Router\s*\(\s*(\{[^}]*\})?/g)) {
    const pm = m[2] ? /prefix\s*:\s*['"`]([^'"`]+)['"`]/.exec(m[2]) : null;
    declares[m[1]] = { framework: 'koa', prefix: pm?.[1] };
  }
  // Fastify plugin parameters: `async function plugin(fastify: FastifyInstance)` / `(app) => { app.get(...) }`
  for (const m of text.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*FastifyInstance/g)) declares[m[1]] = { framework: 'fastify' };
  const known = (name: string) => !!declares[name] || (DEFAULT_ROUTER_NAME.test(name) && !NON_ROUTER_NAME.test(name));

  const raw: Array<Omit<RawRoute, 'statuses'>> = [];
  // obj.method('path', handler...)
  const callRe = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${METHODS})\\s*(?:<[^>()]*>)?\\s*\\(\\s*(['"\`])([^'"\`]*)\\3\\s*,`, 'gi');
  for (const m of text.matchAll(callRe)) {
    const obj = m[1];
    if (NON_ROUTER_NAME.test(obj) || !known(obj)) continue;
    const local = m[4];
    if (local && !local.startsWith('/') && !local.startsWith('*') && fw !== 'nestjs') continue;
    const idx = m.index ?? 0;
    raw.push({ method: m[2].toUpperCase(), localPath: local || '/', router: obj, line: lineOf(text, idx), index: idx, framework: declares[obj]?.framework ?? (fw === 'unknown' ? 'express' : fw), ownPrefix: declares[obj]?.prefix });
  }
  // obj.route('/path').get(h).post(h)  (Express chain)
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(['"`])([^'"`]+)\2\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|options|head|all)\s*\([^)]*\))+)/gi)) {
    const obj = m[1];
    if (!known(obj)) continue;
    const idx = m.index ?? 0;
    for (const mm of m[4].matchAll(/\.\s*(get|post|put|patch|delete|options|head|all)\s*\(/gi)) raw.push({ method: mm[1].toUpperCase(), localPath: m[3], router: obj, line: lineOf(text, idx), index: idx, framework: 'express' });
  }
  // fastify.route({ method: 'GET', url: '/x' })
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
    const body = m[2];
    const um = /\b(?:url|path)\s*:\s*(['"`])([^'"`]+)\1/.exec(body);
    const mm = /\bmethod\s*:\s*(?:\[([^\]]*)\]|(['"`])([A-Za-z]+)\2)/.exec(body);
    if (!um || !mm) continue;
    const methods = mm[1] ? [...mm[1].matchAll(/['"`]([A-Za-z]+)['"`]/g)].map((x) => x[1]) : [mm[3]];
    const idx = m.index ?? 0;
    for (const meth of methods) raw.push({ method: meth.toUpperCase(), localPath: um[2], router: m[1], line: lineOf(text, idx), index: idx, framework: 'fastify' });
  }
  // NestJS: @Controller('prefix') ... @Get(':id')
  if (fw === 'nestjs' || /@Controller\s*\(/.test(text)) {
    const ctrls = [...text.matchAll(/@Controller\s*\(\s*(?:(['"`])([^'"`]*)\1|\{[^}]*path\s*:\s*(['"`])([^'"`]*)\3[^}]*\})?\s*\)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)];
    for (let i = 0; i < ctrls.length; i++) {
      const c = ctrls[i];
      const start = c.index ?? 0;
      const end = i + 1 < ctrls.length ? ctrls[i + 1].index ?? text.length : text.length;
      const body = text.slice(start, end);
      const prefix = c[2] ?? c[4] ?? '';
      for (const d of body.matchAll(/@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g)) {
        const idx = start + (d.index ?? 0);
        raw.push({ method: d[1].toUpperCase(), localPath: d[3] ? (d[3].startsWith('/') ? d[3] : '/' + d[3]) : '/', router: c[5], line: lineOf(text, idx), index: idx, framework: 'nestjs', ownPrefix: '/' + prefix.replace(/^\/+/, '') });
      }
    }
  }
  raw.sort((a, b) => a.index - b.index);
  const routes: RawRoute[] = raw.map((r, i) => {
    const end = i + 1 < raw.length ? raw[i + 1].index : Math.min(text.length, r.index + 4000);
    return { ...r, statuses: statusesIn(text.slice(r.index, Math.max(end, r.index + 1))) };
  });

  // Mounts: obj.use('/prefix', target)  /  obj.use('/prefix', target.routes())  /  fastify.register(target, { prefix: '/x' })
  const mounts: Mount[] = [];
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*([^)]*?)\)/g)) {
    const args = m[4];
    const ids = [...args.matchAll(/([A-Za-z_$][\w$]*)(?:\s*\.\s*routes\s*\(\s*)?/g)].map((x) => x[1]).filter((x) => !/^(async|function|req|res|next|ctx|await|new|routes|allowedMethods)$/.test(x));
    const target = ids[ids.length - 1];
    if (target) mounts.push({ on: m[1], prefix: m[3], target, line: lineOf(text, m.index ?? 0) });
  }
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*register\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}/g)) {
    const pm = /prefix\s*:\s*(['"`])([^'"`]+)\1/.exec(m[3]);
    if (pm) mounts.push({ on: m[1], prefix: pm[2], target: m[2], line: lineOf(text, m.index ?? 0) });
  }
  return { routes, mounts, declares, imports, exports: exportsList };
}

// ---------------------------------------------------------------------------
// Routes of a package (mount prefixes resolved across files)
// ---------------------------------------------------------------------------

function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].map((e) => base + e), ...['index.ts', 'index.js', 'index.mjs'].map((i) => path.join(base, i))];
  const stripped = base.replace(/\.(?:js|mjs|cjs)$/, '');
  if (stripped !== base) cands.push(stripped + '.ts', stripped + '.tsx', stripped + '.mts');
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface PackageRoutes {
  routes: Array<Omit<RouteEntry, 'service' | 'repoId'>>;
  files: number;
}

/** Every route in a set of source files of one package, with mount prefixes applied. */
export function routesOfFiles(files: string[], repoRoot: string): PackageRoutes {
  const parsed = new Map<string, FileRoutes>();
  for (const f of files) {
    const text = readTextOr(f, '') ?? '';
    if (!/\.(?:get|post|put|patch|delete|options|head|all|route|use|register)\s*\(|@Controller/i.test(text)) continue;
    parsed.set(f, extractRoutes(text));
  }
  // Which file defines a router identifier (export or declaration).
  const definers = (ident: string, fromFile: string): string[] => {
    const fr = parsed.get(fromFile);
    const spec = fr?.imports[ident];
    if (spec) {
      const r = resolveModule(fromFile, spec);
      if (r) return [r];
    }
    if (fr?.declares[ident] || fr?.routes.some((x) => x.router === ident)) return [fromFile];
    const out: string[] = [];
    for (const [f, p] of parsed) if (p.exports.includes(ident) && (p.declares[ident] || p.routes.length)) out.push(f);
    return out;
  };
  // mountsInto[file] = list of { parentFile, parentRouter, prefix }
  const mountsInto = new Map<string, Array<{ parent: string; on: string; prefix: string; target: string }>>();
  for (const [f, p] of parsed) {
    for (const m of p.mounts) {
      for (const d of definers(m.target, f)) {
        const arr = mountsInto.get(d) ?? [];
        arr.push({ parent: f, on: m.on, prefix: m.prefix, target: m.target });
        mountsInto.set(d, arr);
      }
    }
  }
  const routerNames = (file: string): Set<string> => new Set((parsed.get(file)?.routes ?? []).map((r) => r.router));
  const prefixesOf = (file: string, router: string, depth: number): string[] => {
    if (depth > 6) return [''];
    const names = routerNames(file);
    // A mount reaches this router when it names it, or when the file has one router (imported under another name).
    const relevant = (mountsInto.get(file) ?? []).filter((m) => m.target === router || (names.size === 1 && names.has(router) && m.parent !== file));
    if (!relevant.length) return [''];
    const out: string[] = [];
    for (const m of relevant) for (const pp of prefixesOf(m.parent, m.on, depth + 1)) out.push(joinRoute(pp, m.prefix));
    return [...new Set(out)];
  };
  const out: PackageRoutes['routes'] = [];
  const seen = new Set<string>();
  for (const [f, p] of parsed) {
    const rel = toPosix(path.relative(repoRoot, f));
    for (const r of p.routes) {
      const prefixes = prefixesOf(f, r.router, 0);
      for (const pre of prefixes) {
        const full = joinRoute(joinRoute(pre, r.ownPrefix ?? ''), r.localPath === '*' ? '*' : r.localPath);
        const key = `${r.method} ${full} ${rel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const e = { id: routeId(r.method, full), method: r.method, path: full, localPath: r.localPath, file: rel, line: r.line, framework: r.framework, statuses: r.statuses, fingerprint: '' };
        e.fingerprint = fingerprintOf(e);
        out.push(e);
      }
    }
  }
  out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return { routes: out, files: parsed.size };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/** Version key of a migration file name: numeric prefixes compared as numbers. */
export function migrationKey(name: string): { version: number[] | null; rest: string; repeatable: boolean } {
  const base = name.replace(/\.[^.]+$/, '');
  if (/^R__/i.test(base)) return { version: null, rest: base.slice(3).toLowerCase(), repeatable: true };
  const m = /^[Vv]?(\d+(?:[._]\d+)*)(?:__|[_.-])?(.*)$/.exec(base);
  if (m) return { version: m[1].split(/[._]/).map((x) => Number(x)), rest: m[2].toLowerCase(), repeatable: false };
  return { version: null, rest: base.toLowerCase(), repeatable: false };
}

export function compareMigrations(a: string, b: string): number {
  const ka = migrationKey(path.basename(a));
  const kb = migrationKey(path.basename(b));
  if (ka.repeatable !== kb.repeatable) return ka.repeatable ? 1 : -1;
  if (ka.version && kb.version) {
    for (let i = 0; i < Math.max(ka.version.length, kb.version.length); i++) {
      const x = ka.version[i] ?? 0;
      const y = kb.version[i] ?? 0;
      if (x !== y) return x - y;
    }
    return ka.rest.localeCompare(kb.rest) || path.basename(a).localeCompare(path.basename(b));
  }
  if (ka.version && !kb.version) return -1;
  if (!ka.version && kb.version) return 1;
  return path.basename(a).localeCompare(path.basename(b));
}

/** Files that are migrations to apply (down/undo files excluded), ordered. */
export function orderMigrationFiles(names: string[]): string[] {
  return names.filter((n) => !/(^|[._-])(down|undo|rollback)(\.|$)|^U\d/i.test(path.basename(n))).sort(compareMigrations);
}

export function tablesOfSql(sql: string): { tables: string[]; references: string[] } {
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const name = (s: string) =>
    s
      .replace(/[[\]"`]/g, '')
      .split('.')
      .pop()!
      .toLowerCase();
  const tables = new Set<string>();
  const refs = new Set<string>();
  for (const m of clean.matchAll(/\b(?:create|alter)\s+table\s+((?:\[?[\w$]+\]?\s*\.\s*)?\[?[\w$]+\]?)/gi)) tables.add(name(m[1]));
  for (const m of clean.matchAll(/\bcreateTable\s*\(\s*['"`]([\w$.]+)['"`]/g)) tables.add(name(m[1]));
  for (const m of clean.matchAll(/\breferences\s+((?:\[?[\w$]+\]?\s*\.\s*)?\[?[\w$]+\]?)/gi)) refs.add(name(m[1]));
  for (const t of tables) refs.delete(t);
  return { tables: [...tables].sort(), references: [...refs].sort() };
}

/** The database objects a SQL migration creates: tables, columns added to a table, indexes. Names are lower-cased, without schema or quotes. */
export interface SqlObjects {
  tables: string[];
  columns: Array<{ table: string; column: string }>;
  indexes: Array<{ index: string; table: string }>;
}

const NOT_A_COLUMN = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'default', 'index', 'key', 'period', 'periodmap']);

/**
 * Parse a `.sql` migration for what it creates: `CREATE TABLE <t>`,
 * `ALTER TABLE <t> ADD <col> ...` (also `ADD COLUMN`, and several columns in
 * one ADD), and `CREATE [UNIQUE] [CLUSTERED] INDEX <i> ON <t>`. Comments are
 * ignored. A migration that only changes or removes things has no objects.
 */
export function objectsOfSql(sql: string): SqlObjects {
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const bare = (s: string) =>
    s
      .replace(/[[\]"`]/g, '')
      .split('.')
      .pop()!
      .trim()
      .toLowerCase();
  const ident = '(?:\\[?[\\w$]+\\]?\\s*\\.\\s*)?\\[?[\\w$]+\\]?';
  const tables = new Set<string>();
  const columns = new Map<string, { table: string; column: string }>();
  const indexes = new Map<string, { index: string; table: string }>();
  for (const m of clean.matchAll(new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${ident})`, 'gi'))) tables.add(bare(m[1]));
  for (const m of clean.matchAll(new RegExp(`\\bcreate\\s+(?:unique\\s+)?(?:(?:non)?clustered\\s+)?(?:columnstore\\s+)?index\\s+(?:if\\s+not\\s+exists\\s+)?(${ident})\\s+on\\s+(${ident})`, 'gi'))) {
    const index = bare(m[1]);
    indexes.set(`${index}@${bare(m[2])}`, { index, table: bare(m[2]) });
  }
  for (const m of clean.matchAll(new RegExp(`\\balter\\s+table\\s+(${ident})\\s+add\\b`, 'gi'))) {
    const table = bare(m[1]);
    let rest = clean.slice((m.index ?? 0) + m[0].length);
    const stop = rest.search(/;|\n\s*(?:go|update|insert|delete|create|alter|drop|select|if|begin|exec|execute|print|with|merge|declare|set)\b|\bend\b/i);
    if (stop >= 0) rest = rest.slice(0, stop);
    rest = rest.replace(/'(?:[^']|'')*'/g, "''");
    // Split at top-level commas.
    const items: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of rest) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        items.push(cur);
        cur = '';
      } else cur += ch;
    }
    items.push(cur);
    for (const raw of items) {
      const it = raw.replace(/^\s*add\s+/i, '').replace(/^\s*column\s+/i, '').replace(/^\s*if\s+not\s+exists\s+/i, '').trim();
      const t = /^(\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)/.exec(it);
      if (!t) continue;
      const column = bare(t[1]);
      if (!column || (NOT_A_COLUMN.has(column) && !/^[\["`]/.test(t[1]))) continue;
      columns.set(`${table}.${column}`, { table, column });
    }
  }
  return { tables: [...tables].sort(), columns: [...columns.values()], indexes: [...indexes.values()] };
}

export function findMigrationsDir(dir: string, override?: string): string | null {
  const cands = override ? [override] : MIGRATION_DIRS;
  for (const c of cands) {
    const p = path.resolve(dir, c);
    try {
      if (fs.statSync(p).isDirectory() && fs.readdirSync(p).some((n) => /\.(sql|[cm]?[jt]s)$/i.test(n))) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function migrationsOf(service: { name: string; repoId: string; repoRoot: string; dir: string }, override?: string): MigrationEntry[] {
  const d = findMigrationsDir(service.dir, override) ?? (service.dir !== service.repoRoot ? findMigrationsDir(service.repoRoot, override) : null);
  if (!d) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(d).filter((n) => /\.(sql|[cm]?[jt]s)$/i.test(n) && !/\.d\.ts$/.test(n));
  } catch {
    return [];
  }
  const out: MigrationEntry[] = [];
  for (const n of orderMigrationFiles(names)) {
    const abs = path.join(d, n);
    const text = readTextOr(abs, '') ?? '';
    const t = tablesOfSql(text);
    out.push({ id: n.replace(/\.[^.]+$/, ''), service: service.name, repoId: service.repoId, file: toPosix(path.relative(service.repoRoot, abs)), kind: /\.sql$/i.test(n) ? 'sql' : 'code', tables: t.tables, references: t.references, sha256: sha256(text) });
  }
  return out;
}

/**
 * Apply order across services sharing a schema: a service whose migrations
 * reference tables another service creates comes after it; ties by name.
 */
export function orderSchemaServices(byService: Map<string, MigrationEntry[]>): string[] {
  const names = [...byService.keys()].sort();
  const creates = new Map<string, Set<string>>();
  for (const [s, ms] of byService) creates.set(s, new Set(ms.flatMap((m) => m.tables)));
  const deps = new Map<string, Set<string>>();
  for (const [s, ms] of byService) {
    const d = new Set<string>();
    for (const ref of ms.flatMap((m) => m.references)) for (const [o, t] of creates) if (o !== s && t.has(ref) && !creates.get(s)?.has(ref)) d.add(o);
    deps.set(s, d);
  }
  const out: string[] = [];
  const state = new Map<string, number>();
  const visit = (s: string) => {
    if (state.get(s) === 2) return;
    if (state.get(s) === 1) return; // cycle: keep name order
    state.set(s, 1);
    for (const d of [...(deps.get(s) ?? [])].sort()) visit(d);
    state.set(s, 2);
    out.push(s);
  };
  for (const n of names) visit(n);
  return out;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env', '.env.defaults'];

export function readEnvExample(dir: string): { vars: string[]; values: Record<string, string> } {
  for (const n of ENV_EXAMPLES) {
    const text = readTextOr(path.join(dir, n), null);
    if (text === null) continue;
    const vars: string[] = [];
    const values: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
      if (!m) continue;
      vars.push(m[1]);
      let v = m[2].trim();
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (!isSecretName(m[1]) && !/password|passwd|pwd/i.test(m[1])) values[m[1]] = v;
    }
    return { vars, values };
  }
  return { vars: [], values: {} };
}

function pick(vars: string[], res: RegExp[]): string | undefined {
  for (const re of res) {
    const v = vars.find((x) => re.test(x));
    if (v) return v;
  }
  return undefined;
}

export function dbVarsOf(vars: string[], values: Record<string, string>): ServiceEntry['db'] {
  return {
    serverVar: pick(vars, [/^(DB|DATABASE|SQL|MSSQL|SQLSERVER)_(SERVER|HOST|HOSTNAME)$/i, /^(DB|MSSQL)HOST$/i, /_DB_(SERVER|HOST)$/i]),
    portVar: pick(vars, [/^(DB|DATABASE|SQL|MSSQL|SQLSERVER)_PORT$/i, /_DB_PORT$/i]),
    nameVar: pick(vars, [/^(DB|DATABASE|SQL|MSSQL|SQLSERVER)_(NAME|DATABASE|DB)$/i, /^DATABASE$/i, /_DB_NAME$/i]),
    userVar: pick(vars, [/^(DB|DATABASE|SQL|MSSQL|SQLSERVER)_(USER|USERNAME|LOGIN)$/i, /_DB_USER$/i]),
    passwordVar: pick(vars, [/^(DB|DATABASE|SQL|MSSQL|SQLSERVER)_(PASSWORD|PASS|PWD)$/i, /_DB_PASSWORD$/i]),
    urlVar: pick(vars, [/^DATABASE_URL$/i, /^(DB|SQL|MSSQL)_(URL|CONNECTION_STRING|CONN(ECTION)?(_STR)?)$/i, /CONNECTION_STRING$/i]),
    exampleName: (() => {
      const nv = pick(vars, [/^(DB|DATABASE|SQL|MSSQL|SQLSERVER)_(NAME|DATABASE|DB)$/i]);
      return nv ? values[nv] : undefined;
    })(),
  };
}

export function portVarOf(vars: string[], stem: string): string | undefined {
  return pick(vars, [/^PORT$/, new RegExp(`^${stem}_PORT$`), /^(HTTP|APP|SERVER|API|SERVICE)_PORT$/]);
}

const URL_VAR_RE = /^([A-Z0-9_]+?)_(?:BASE_URL|URL|URI|ENDPOINT|HOST|ADDR|ADDRESS|API|API_URL|SERVICE_URL)$/;

/** Which other service an env variable points at: by name stem, else by the example URL's port. */
export function needsOf(svc: { name: string; envVars: string[]; envDefaults: Record<string, string> }, others: Array<{ name: string; examplePort?: number }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of svc.envVars) {
    const m = URL_VAR_RE.exec(v);
    if (!m || /^(DB|DATABASE|SQL|MSSQL|REDIS|MONGO|POSTGRES|PG|MYSQL|SMTP|MAIL|S3|AWS|SENTRY|OTEL|LOG)/.test(m[1])) continue;
    const stem = m[1].toLowerCase().replace(/_/g, '-');
    const tokens = stem.split('-').filter(Boolean);
    let hit = others.find((o) => o.name !== svc.name && (o.name.toLowerCase() === stem || o.name.toLowerCase().split(/[-_.]/).filter((t) => !/^(api|service|svc|app|server)$/.test(t)).join('-') === tokens.filter((t) => !/^(api|service|svc|app|server)$/.test(t)).join('-')));
    if (!hit) {
      const val = svc.envDefaults[v] ?? '';
      const pm = /:(\d{2,5})(?:\/|$)/.exec(val);
      if (pm) hit = others.find((o) => o.name !== svc.name && o.examplePort === Number(pm[1]));
    }
    if (hit) out[v] = hit.name;
  }
  return out;
}

interface PackageJsonLite {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

/** Repositories (or packages) in the workspace that can be started as services. */
export function discoverServiceDirs(workspaceRoot: string, extraRepos: string[] = []): string[] {
  const out = new Set<string>();
  const consider = (dir: string) => {
    const pj = readJsonOr<PackageJsonLite | null>(path.join(dir, 'package.json'), null);
    if (pj && pj.scripts && (pj.scripts.start || pj.scripts.dev)) out.add(path.resolve(dir));
  };
  consider(workspaceRoot);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    consider(path.join(workspaceRoot, e.name));
  }
  for (const r of extraRepos) consider(r);
  return [...out].sort();
}

function sourceFiles(dir: string): string[] {
  return walkFiles(dir, { filter: (_abs, rel) => SRC_RE.test(rel) && !TEST_RE.test(toPosix(rel)), maxFiles: 20000 });
}

export interface BuildOptions {
  workspaceRoot: string;
  extraRepos?: string[];
  migrationsOverride?: string;
}

export function buildFeatureMap(o: BuildOptions): FeatureMap {
  const notes: string[] = [];
  const dirs = discoverServiceDirs(o.workspaceRoot, o.extraRepos);
  const services: ServiceEntry[] = [];
  const routes: RouteEntry[] = [];
  const migrations: MigrationEntry[] = [];
  const usedNames = new Set<string>();
  for (const dir of dirs) {
    const repoRoot = nearestRepoRoot(dir) ?? dir;
    const repoId = repoIdFor(repoRoot);
    const pj = readJsonOr<PackageJsonLite>(path.join(dir, 'package.json'), {});
    let name = path.basename(dir);
    if (usedNames.has(name)) name = `${name}-${repoId.slice(-6)}`;
    usedNames.add(name);
    const env = readEnvExample(dir);
    const stem = envStem(name);
    const portVar = portVarOf(env.vars, stem);
    const examplePort = portVar && /^\d+$/.test(env.values[portVar] ?? '') ? Number(env.values[portVar]) : undefined;
    const pr = routesOfFiles(sourceFiles(dir), repoRoot);
    for (const r of pr.routes) routes.push({ ...r, service: name, repoId });
    const svc: ServiceEntry = {
      name,
      repoId,
      repoRoot,
      dir,
      envName: stem,
      scripts: { start: pj.scripts?.start, dev: pj.scripts?.dev },
      envVars: env.vars,
      envDefaults: env.values,
      portVar,
      examplePort,
      db: dbVarsOf(env.vars, env.values),
      needs: {},
      health: pr.routes.find((r) => r.method === 'GET' && HEALTH_PATH_RE.test(r.path))?.path,
      routes: pr.routes.length,
    };
    const ms = migrationsOf({ name, repoId, repoRoot, dir }, o.migrationsOverride);
    if (ms.length) svc.migrationsDir = path.dirname(path.join(repoRoot, ms[0].file));
    migrations.push(...ms);
    if (!env.vars.length) notes.push(`${name}: no .env.example; the variables it needs are not known (run.env still sets PORT and the DB variables)`);
    services.push(svc);
  }
  for (const s of services) s.needs = needsOf(s, services);
  const tables = [...new Set(migrations.flatMap((m) => m.tables))].sort();
  return { version: 1, generatedAt: new Date().toISOString(), workspaceRoot: o.workspaceRoot, services, routes, migrations, tables, notes };
}

export function saveFeatureMap(repoId: string, map: FeatureMap): string {
  const p = featureMapPath(repoId);
  writeJson(p, map);
  return p;
}

export function loadFeatureMap(repoId: string): FeatureMap | null {
  const m = readJsonOr<FeatureMap | null>(featureMapPath(repoId), null);
  return m && m.version === 1 && Array.isArray(m.routes) ? m : null;
}

/** Services to start: the named ones plus everything they need, dependencies first. */
export function withNeeds(map: FeatureMap, names: string[]): { order: string[]; missing: string[] } {
  const byName = new Map(map.services.map((s) => [s.name, s]));
  const missing = names.filter((n) => !byName.has(n));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, depth: number) => {
    if (seen.has(n) || depth > 20) return;
    seen.add(n);
    const s = byName.get(n);
    if (!s) return;
    for (const dep of Object.values(s.needs).sort()) visit(dep, depth + 1);
    order.push(n);
  };
  for (const n of names) visit(n, 0);
  return { order, missing };
}

/** Routes of one repository (for its overlay and the drift check). */
export function routesOfRepo(map: FeatureMap, repoId: string): RouteEntry[] {
  return map.routes.filter((r) => r.repoId === repoId);
}

export function migrationsOfRepo(map: FeatureMap, repoId: string): MigrationEntry[] {
  return map.migrations.filter((m) => m.repoId === repoId);
}

/** Match a concrete path (`/orders/5`) against a route pattern (`/orders/:id`). */
export function matchPath(pattern: string, concrete: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = concrete.split('?')[0].split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i];
    if (seg.startsWith(':')) params[seg.slice(1).replace(/\?$/, '')] = decodeURIComponent(b[i]);
    else if (/^\{.+\}$/.test(seg)) params[seg.slice(1, -1)] = decodeURIComponent(b[i]);
    else if (seg === '*') continue;
    else if (seg !== b[i]) return null;
  }
  return params;
}

/** The route of the map a request hits (exact pattern, then concrete path). */
export function findRoute(map: FeatureMap, method: string, p: string, service?: string): RouteEntry | null {
  const cands = map.routes.filter((r) => r.method === method.toUpperCase() || r.method === 'ALL').filter((r) => !service || r.service === service);
  const exact = cands.find((r) => r.path === p);
  if (exact) return exact;
  const norm = (x: string) => x.replace(/:[A-Za-z_][\w]*\??|\{[^}]+\}/g, ':param');
  const byPattern = cands.find((r) => norm(r.path) === norm(p));
  if (byPattern) return byPattern;
  return cands.find((r) => matchPath(r.path, p)) ?? null;
}
