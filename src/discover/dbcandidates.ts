/**
 * Database candidates for `harness db mark`: server and database names found
 * in .env files, app config files, connection strings and docker-compose
 * files. Hostnames, ports and database names only: values of other keys are
 * never kept, user names and passwords inside connection strings are
 * dropped before anything is stored, and the result is re-checked with the
 * secret scanner before it is returned.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findSecrets } from '../lib/redact';
import type { WorkspaceInventory } from './inventory';
import { parseYaml } from './yaml';
import { matchGlob } from './glob';

export interface DbCandidate {
  server: string;
  database?: string;
  sources?: string[];
}

export interface DbCandidatesFile {
  version: 1;
  generatedAt: string;
  candidates: DbCandidate[];
}

const HOST_KEY = /^(?:(?:DB|DATABASE|SQL|MSSQL|SQLSERVER|SQL_SERVER|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB|REDIS|ORACLE)_?(?:SERVER|HOST|HOSTNAME|ADDR|ADDRESS)|PGHOST)$/i;
const PORT_KEY = /^(?:(?:DB|DATABASE|SQL|MSSQL|SQLSERVER|SQL_SERVER|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB|REDIS|ORACLE)_?PORT|PGPORT)$/i;
const NAME_KEY = /^(?:(?:DB|DATABASE|SQL|MSSQL|SQLSERVER|SQL_SERVER|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB)_?(?:NAME|DATABASE|DB|CATALOG)|PGDATABASE|POSTGRES_DB|MYSQL_DATABASE|MSSQL_DB)$/i;
const URL_KEY = /(?:^|_)(?:URL|URI|CONNECTION|CONNECTION_STRING|CONN|CONNSTR|DSN)$/i;
const HOST_OK = /^[A-Za-z0-9._-]+(?:\\[A-Za-z0-9_$-]+)?$/;
const DB_OK = /^[A-Za-z0-9_$.-]{1,128}$/;
const DB_IMAGES = /(mssql|sqlserver|azure-sql-edge|postgres|postgis|mysql|mariadb|mongo|redis|oracle)/i;

function clean(v: string): string {
  return v.trim().replace(/^['"]|['"]$/g, '').trim();
}

function server(host: string, port?: string): string | null {
  const h = clean(host).replace(/^tcp:/i, '');
  if (!HOST_OK.test(h) || h.includes('${') || h === '') return null;
  const p = port ? clean(port) : '';
  return /^\d{1,5}$/.test(p) ? `${h},${p}` : h;
}

/** Parse one connection string or URL; only host, port and database survive. */
export function parseConnectionString(s: string): { server: string; database?: string } | null {
  const t = s.trim();
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]*@)?([^/:;?\s,]+)(?::(\d{1,5}))?(?:\/([^?;\s]*))?/i.exec(t);
  if (url && /(sql|postgres|mysql|maria|mongo|redis|oracle|tds)/i.test(url[1])) {
    const sv = server(url[2], url[3]);
    if (!sv) return null;
    const db = url[4] ? decodeURIComponent(url[4]).split('/')[0] : '';
    const dbm = /databaseName=([^;]+)/i.exec(t);
    const name = dbm ? dbm[1] : db;
    return { server: sv, database: name && DB_OK.test(name) ? name : undefined };
  }
  if (/(?:^|;)\s*(?:server|data source|address|addr|host)\s*=/i.test(t)) {
    const parts = new Map<string, string>();
    for (const kv of t.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) parts.set(kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim());
    }
    const raw = parts.get('server') ?? parts.get('data source') ?? parts.get('address') ?? parts.get('addr') ?? parts.get('host');
    if (!raw) return null;
    const [h, p] = raw.replace(/^tcp:/i, '').split(',');
    const sv = server(h, p ?? parts.get('port'));
    if (!sv) return null;
    const db = parts.get('database') ?? parts.get('initial catalog');
    return { server: sv, database: db && DB_OK.test(db) ? db : undefined };
  }
  return null;
}

/** Candidates from KEY=VALUE text (.env files). Values of other keys are never read into the result. */
export function fromEnvText(text: string): Array<{ server: string; database?: string; keys: string[] }> {
  const vars = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    if (HOST_KEY.test(key) || PORT_KEY.test(key) || NAME_KEY.test(key) || URL_KEY.test(key)) vars.set(key, m[2].replace(/\s+#.*$/, ''));
  }
  const out: Array<{ server: string; database?: string; keys: string[] }> = [];
  const hostKey = [...vars.keys()].find((k) => HOST_KEY.test(k));
  if (hostKey) {
    const portKey = [...vars.keys()].find((k) => PORT_KEY.test(k));
    const nameKey = [...vars.keys()].find((k) => NAME_KEY.test(k));
    const sv = server(vars.get(hostKey)!, portKey ? vars.get(portKey) : undefined);
    const db = nameKey ? clean(vars.get(nameKey)!) : undefined;
    if (sv) out.push({ server: sv, database: db && DB_OK.test(db) ? db : undefined, keys: [hostKey, portKey, nameKey].filter((k): k is string => !!k) });
  }
  for (const [k, v] of vars) {
    if (!URL_KEY.test(k)) continue;
    const c = parseConnectionString(clean(v));
    if (c) out.push({ ...c, keys: [k] });
  }
  return out;
}

/** Candidates from a docker-compose file: database images with published ports. */
export function fromCompose(text: string): Array<{ server: string; database?: string; keys: string[] }> {
  const out: Array<{ server: string; database?: string; keys: string[] }> = [];
  let y: { services?: Record<string, { image?: string; ports?: unknown[]; environment?: unknown }> };
  try {
    y = parseYaml(text) as typeof y;
  } catch {
    return out;
  }
  for (const [name, svc] of Object.entries(y?.services ?? {})) {
    if (!svc || typeof svc.image !== 'string' || !DB_IMAGES.test(svc.image)) continue;
    let db: string | undefined;
    const env = svc.environment;
    const envPairs: Array<[string, string]> = Array.isArray(env)
      ? env.map((e) => String(e).split('=')).map(([k, ...v]) => [k, v.join('=')] as [string, string])
      : env && typeof env === 'object'
        ? Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')] as [string, string])
        : [];
    for (const [k, v] of envPairs) if (NAME_KEY.test(k) && DB_OK.test(clean(v))) db = clean(v);
    const ports = Array.isArray(svc.ports) ? svc.ports.map(String) : [];
    for (const p of ports) {
      const m = /^(?:([\d.]+):)?(\d{1,5})(?:-\d+)?:(\d{1,5})/.exec(p.replace(/^["']|["']$/g, ''));
      if (!m) continue;
      const host = !m[1] || m[1] === '0.0.0.0' || m[1] === '127.0.0.1' ? 'localhost' : m[1];
      out.push({ server: `${host},${m[2]}`, database: db, keys: [`services.${name}.ports`] });
    }
    if (!ports.length) out.push({ server: name, database: db, keys: [`services.${name}`] });
  }
  return out;
}

const STRING_CONN = /(['"`])((?:[a-z][a-z0-9+.-]*:\/\/[^'"`\s]+)|(?:[^'"`]*(?:server|data source)\s*=[^'"`]+))\1/gi;

/** Collect candidates across the workspace. */
export function collectDbCandidates(ws: WorkspaceInventory): DbCandidate[] {
  const found = new Map<string, DbCandidate>();
  const add = (c: { server: string; database?: string; keys: string[] }, file: string) => {
    const key = `${c.server.toLowerCase()}|${(c.database ?? '').toLowerCase()}`;
    const e = found.get(key) ?? { server: c.server, database: c.database, sources: [] };
    const src = `${file} (${c.keys.join(', ')})`;
    if (!e.sources!.includes(src)) e.sources!.push(src);
    found.set(key, e);
  };
  for (const r of ws.repos) {
    const prefix = r.repo.relPath === '.' ? '' : r.repo.relPath + '/';
    const read = (rel: string): string | null => {
      try {
        const st = fs.statSync(path.join(r.repo.path, rel));
        if (st.size > 512 * 1024) return null;
        return fs.readFileSync(path.join(r.repo.path, rel), 'utf8');
      } catch {
        return null;
      }
    };
    // .env files: listed by git when tracked or untracked-but-not-ignored; ignored ones are looked up by name too.
    const envFiles = new Set(r.configs.env ?? []);
    for (const n of ['.env', '.env.local', '.env.development', '.env.test', '.env.example', '.env.sample']) if (fs.existsSync(path.join(r.repo.path, n))) envFiles.add(n);
    for (const rel of envFiles) {
      const t = read(rel);
      if (t) for (const c of fromEnvText(t)) add(c, prefix + rel);
    }
    for (const rel of (r.configs.docker ?? []).filter((f) => /\.ya?ml$/.test(f))) {
      const t = read(rel);
      if (t) for (const c of fromCompose(t)) add(c, prefix + rel);
    }
    for (const rel of r.configs.appConfig ?? []) {
      const t = read(rel);
      if (!t) continue;
      let m: RegExpExecArray | null;
      const re = new RegExp(STRING_CONN.source, 'gi');
      while ((m = re.exec(t))) {
        const c = parseConnectionString(m[2]);
        if (c) add({ ...c, keys: ['connection string'] }, prefix + rel);
      }
    }
    for (const f of r.files) {
      if (f.kind !== 'code' || f.bytes > 256 * 1024 || matchGlob(f.rel, '**/node_modules/**')) continue;
      let t: string;
      try {
        t = fs.readFileSync(f.abs, 'utf8');
      } catch {
        continue;
      }
      if (!/(server|data source)\s*=|:\/\//i.test(t)) continue;
      let m: RegExpExecArray | null;
      const re = new RegExp(STRING_CONN.source, 'gi');
      while ((m = re.exec(t))) {
        const c = parseConnectionString(m[2]);
        if (c) add({ ...c, keys: ['connection string'] }, prefix + f.rel);
      }
    }
  }
  // Belt and braces: nothing secret-shaped leaves this function.
  return [...found.values()].filter((c) => !findSecrets(JSON.stringify(c)).length).sort((a, b) => a.server.localeCompare(b.server) || (a.database ?? '').localeCompare(b.database ?? ''));
}
