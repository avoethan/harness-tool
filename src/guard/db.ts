/**
 * Default-deny database rail.
 *
 * Given a parsed command segment, the hook's environment and the DB
 * allowlist, resolve every target a DB client would reach (server flags,
 * connection strings and URLs anywhere in the segment, env assignments in
 * the command, SQLCMDSERVER-style variables in the hook env, the container
 * or host of a docker/ssh/kubectl wrapper) and allow only when every
 * target matches an allowlist entry marked `test`. Everything the guard
 * cannot resolve (DSNs, config aliases, variables, script files,
 * interactive sessions, opaque wrappers) is denied with a reason that says
 * what to do instead.
 *
 * Pure: no I/O.
 */
import type { DbConfig, DbTarget } from '../types';
import { hashJson } from '../lib/hash';
import type { Segment } from './parse';
import { segmentText } from './parse';
import {
  DB_CLIENTS,
  DB_CLIENT_IMAGE_RE,
  DB_CMDLET_RE,
  DB_CREDENTIAL_ENV_RE,
  DB_ENV_NAME_RE,
  DB_IMAGE_RE,
  DB_KEYWORDS_PS,
  DB_KEYWORD_RE,
  DB_LOCAL_HOSTS,
  DB_MODULES_JS,
  DB_MODULES_PY,
  type DbClientSpec,
  type DbKind,
} from './rails';

export interface GuardDecisionLike {
  decision: 'allow' | 'deny';
  rail: string;
  reason: string;
  matched?: string;
}

export interface DbTargetRef {
  host: string;
  port?: string;
  database?: string;
  /** Where it came from: flag, conn-string, url, env:NAME, hookenv:NAME, container, default-local, code */
  source: string;
}

export interface DbResolution {
  client: string;
  kind: DbKind | 'docker-image' | 'env-only' | 'code';
  targets: DbTargetRef[];
  /** Human descriptions of targets the guard could not resolve. */
  unresolved: string[];
  /** Script files or :r / \i directives. */
  scriptInputs: string[];
  /** Statements that reach other servers or the OS. */
  dangerous: string[];
  interactive: boolean;
  outFiles: string[];
}

export const MARK_INSTRUCTION = 'ask the user to run `harness db mark` and mark the test server as test';

// ---------------------------------------------------------------------------
// Host normalisation and matching
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: Record<string, string> = { mssql: '1433', sqlpackage: '1433', dbatools: '1433', pg: '5432', mysql: '3306', mongo: '27017', redis: '6379' };

/** "tcp:Host,1433" -> { host: 'host', port: '1433' }; local spellings -> 'localhost'. */
export function parseServerSpec(raw: string): { host: string; port?: string } | null {
  let s = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  if (!s) return null;
  s = s.replace(/^(tcp|np|lpc|admin):/i, '');
  if (s.startsWith('\\\\')) s = s.slice(2).split('\\')[0] ?? s; // np:\\host\pipe\...
  s = s.toLowerCase();
  let port: string | undefined;
  // mssql "host,port" or "host\instance,port"
  const comma = s.indexOf(',');
  if (comma >= 0) {
    port = s.slice(comma + 1).trim() || undefined;
    s = s.slice(0, comma).trim();
  }
  // IPv6 [::1]:5432
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    s = v6[1];
    port = v6[2] ?? port;
  } else {
    const m = /^([^:]+):(\d+)$/.exec(s);
    if (m) {
      s = m[1];
      port = m[2];
    }
  }
  // "host\instance"
  const back = s.indexOf('\\');
  let host = back >= 0 ? s.slice(0, back) : s;
  const instance = back >= 0 ? s.slice(back + 1) : '';
  if (DB_LOCAL_HOSTS.has(host) || host === '') host = 'localhost';
  if (host.endsWith('.localhost')) host = 'localhost';
  const full = instance ? `${host}\\${instance}` : host;
  if (!/^[a-z0-9._\\()-]+$/i.test(full)) return null;
  return port ? { host: full, port } : { host: full };
}

function entryParts(server: string): { host: string; port?: string } | null {
  return parseServerSpec(server);
}

export interface MatchResult {
  ok: boolean;
  entry?: DbTarget;
  /** Why the best candidate did not match. */
  why?: 'no-entry' | 'not-test' | 'port' | 'database';
}

/** Does a resolved target match an allowlist entry marked test? */
export function matchAllowlist(t: DbTargetRef, allowlist: DbTarget[], kind?: string): MatchResult {
  let why: MatchResult['why'] = 'no-entry';
  let candidate: DbTarget | undefined;
  for (const e of allowlist) {
    const ep = entryParts(e.server);
    if (!ep) continue;
    if (ep.host !== t.host.toLowerCase()) continue;
    candidate = e;
    if (ep.port) {
      const tp = t.port ?? (kind ? DEFAULT_PORTS[kind] : undefined);
      if (tp !== ep.port) {
        why = 'port';
        continue;
      }
    }
    if (e.marked !== 'test') {
      why = 'not-test';
      continue;
    }
    if (e.database) {
      if (!t.database || t.database.toLowerCase() !== e.database.toLowerCase()) {
        why = 'database';
        continue;
      }
    }
    return { ok: true, entry: e };
  }
  return { ok: false, entry: candidate, why };
}

/** The allowlist is trusted only when its hash equals the one written at marking time. */
export function allowlistSigned(db: DbConfig): boolean {
  if (!db.markedHash) return false;
  return hashJson(db.allowlist) === db.markedHash;
}

// ---------------------------------------------------------------------------
// Text scanning: connection strings, URLs, code literals, env references
// ---------------------------------------------------------------------------

const URL_RE = /\b(mssql|sqlserver|postgres(?:ql)?(?:\+[a-z0-9_]+)?|mysql(?:\+[a-z0-9_]+)?|mariadb|mongodb(?:\+srv)?|rediss?|odbc|oracle|jdbc:[a-z]+|mssql\+[a-z0-9_]+|sqlite):\/\/([^\s'"`;)>]+)/gi;
const KV_HOST_RE = /\b(server|data source|datasource|addr|address|network address|host|hostname|server name|sqlinstance|serverinstance)\s*[=:]\s*(?!\s*[=:])(["']?)([^;'"`\s,]+(?:,\d+)?)\2/gi;
const KV_DB_RE = /\b(database|initial catalog|dbname|db name|databasename|database name)\s*[=:]\s*(["']?)([^;'"`\s,]+)\2/gi;
const DSN_RE = /\b(dsn|filedsn)\s*=/i;
const ENV_REF_RE = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])|os\.environ(?:\.get)?\s*[\[(]\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|os\.getenv\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Z_][A-Z0-9_]*)\}?/g;
const TEMPLATE_RE = /\$\{[^}]*\}|%[A-Za-z_][A-Za-z0-9_]*%|\$[A-Za-z_(]/;

interface Found {
  targets: DbTargetRef[];
  unresolved: string[];
  /** Database names found without a host (apply to the nearest host). */
  databases: string[];
}

function envLookup(name: string, cmdEnv: Record<string, string>, hookEnv: NodeJS.ProcessEnv): string | undefined {
  if (name in cmdEnv) return cmdEnv[name];
  const v = hookEnv[name];
  return typeof v === 'string' ? v : undefined;
}

/** Scan free text (query strings, code, heredocs, env values) for targets. */
export function findTargetsInText(text: string, source: string, cmdEnv: Record<string, string>, hookEnv: NodeJS.ProcessEnv, depth = 0): Found {
  const out: Found = { targets: [], unresolved: [], databases: [] };
  if (!text || depth > 3) return out;
  if (DSN_RE.test(text)) out.unresolved.push('a DSN name');
  // matchAll clones the regex, so nested calls (env values that hold more
  // references) cannot reset a shared lastIndex and loop forever.
  for (const m of text.matchAll(URL_RE)) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'sqlite') continue;
    const rest = m[2];
    if (TEMPLATE_RE.test(rest)) {
      out.unresolved.push(`a ${scheme} URL built from variables`);
      continue;
    }
    const noAuth = rest.includes('@') ? rest.slice(rest.lastIndexOf('@') + 1) : rest;
    const hostPart = noAuth.split(/[/?;]/)[0];
    const pathPart = noAuth.slice(hostPart.length);
    const hosts = hostPart.split(',');
    for (const h of hosts) {
      const spec = parseServerSpec(h);
      if (!spec) {
        out.unresolved.push(`a ${scheme} URL host "${h.slice(0, 40)}"`);
        continue;
      }
      const dbm = /^\/([^?;/]+)/.exec(pathPart) ?? /;databaseName=([^;]+)/i.exec(pathPart) ?? /[?&;]database=([^&;]+)/i.exec(pathPart);
      out.targets.push({ ...spec, database: dbm ? decodeURIComponent(dbm[1]) : undefined, source: `${source} url` });
    }
  }
  for (const m of text.matchAll(KV_HOST_RE)) {
    const v = m[3];
    if (TEMPLATE_RE.test(v)) {
      out.unresolved.push(`a server name built from variables (${m[1]}=${v.slice(0, 30)})`);
      continue;
    }
    const spec = parseServerSpec(v);
    if (spec) out.targets.push({ ...spec, source: `${source} ${m[1].toLowerCase()}=` });
    else out.unresolved.push(`a server name the guard cannot read (${v.slice(0, 40)})`);
  }
  for (const m of text.matchAll(KV_DB_RE)) {
    const v = m[3];
    if (!TEMPLATE_RE.test(v)) out.databases.push(v);
  }
  for (const m of text.matchAll(ENV_REF_RE)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
    if (!name || !DB_ENV_NAME_RE.test(name)) continue;
    const val = envLookup(name, cmdEnv, hookEnv);
    if (val === undefined) {
      out.unresolved.push(`the variable ${name} (not set in the hook environment)`);
      continue;
    }
    const sub = envValueTargets(name, val, `env:${name}`, cmdEnv, hookEnv, depth + 1);
    out.targets.push(...sub.targets);
    out.unresolved.push(...sub.unresolved);
    out.databases.push(...sub.databases);
  }
  // Attach loose database names to hosts that have none.
  if (out.databases.length) for (const t of out.targets) if (!t.database) t.database = out.databases[0];
  return out;
}

const SERVER_VAR_RE = /^(SQLCMDSERVER|OSQLSERVER|PGHOST|PGHOSTADDR|MYSQL_HOST|DB_HOST|DB_SERVER|MSSQL_HOST|MSSQL_SERVER|SQLSERVER_HOST|TDSHOST|REDIS_HOST|REDISCLI_HOST|MONGO_HOST|MONGODB_HOST|TYPEORM_HOST|MSSQL_CLI_SERVER)$/i;
const DB_VAR_RE = /^(SQLCMDDBNAME|PGDATABASE|DB_NAME|DB_DATABASE|MYSQL_DATABASE|TYPEORM_DATABASE|MSSQL_DB|MSSQL_DATABASE|MSSQL_CLI_DATABASE)$/i;
const ALIAS_VAR_RE = /^(PGSERVICE|PGSERVICEFILE|SQLCMDINI)$/i;

/** Targets carried by one env var's value. */
export function envValueTargets(name: string, value: string, source: string, cmdEnv: Record<string, string>, hookEnv: NodeJS.ProcessEnv, depth = 0): Found {
  const out: Found = { targets: [], unresolved: [], databases: [] };
  if (ALIAS_VAR_RE.test(name)) {
    out.unresolved.push(`${name} (a service/config alias)`);
    return out;
  }
  if (TEMPLATE_RE.test(value)) {
    out.unresolved.push(`${name} built from variables`);
    return out;
  }
  if (SERVER_VAR_RE.test(name)) {
    const spec = parseServerSpec(value);
    if (spec) out.targets.push({ ...spec, source });
    else out.unresolved.push(`${name}="${value.slice(0, 40)}"`);
    return out;
  }
  if (DB_VAR_RE.test(name)) {
    out.databases.push(value);
    return out;
  }
  // URL / connection-string style variables
  const found = findTargetsInText(value, source, cmdEnv, hookEnv, depth + 1);
  if (!found.targets.length && !found.unresolved.length) {
    // A bare host name in a connection variable
    const spec = /^[A-Za-z0-9._\\()-]+(,\d+)?$/.test(value) ? parseServerSpec(value) : null;
    if (spec) found.targets.push({ ...spec, source });
    else found.unresolved.push(`${name}="${value.slice(0, 40)}" (no server name found)`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Flag parsing per client
// ---------------------------------------------------------------------------

interface FlagScan {
  /** A flag that leaves the client interactive after its query (sqlcmd -q). */
  interactive: boolean;
  servers: string[];
  databases: string[];
  queries: string[];
  scripts: string[];
  dsn: boolean;
  conn: string[];
  aliases: string[];
  out: string[];
  positionals: string[];
  unknownFlags: string[];
}

function flagMatches(token: string, flag: string, cmdlet: boolean): { hit: boolean; attached?: string } {
  if (cmdlet) {
    const t = token.toLowerCase();
    const f = flag.toLowerCase();
    const colon = t.indexOf(':');
    const name = colon >= 0 ? t.slice(0, colon) : t;
    if (name === f) return { hit: true, attached: colon >= 0 ? token.slice(colon + 1) : undefined };
    // unambiguous prefix: handled by the caller through psPrefix
    return { hit: false };
  }
  if (flag.startsWith('/')) {
    // sqlpackage: /tsn:value, /TargetServerName:value, also -tsn:value
    const t = token.replace(/^-/, '/');
    const colon = t.indexOf(':');
    const name = (colon >= 0 ? t.slice(0, colon) : t).toLowerCase();
    if (name === flag.toLowerCase()) return { hit: true, attached: colon >= 0 ? token.slice(colon + 1) : '' };
    return { hit: false };
  }
  if (token === flag) return { hit: true };
  if (flag.startsWith('--') && token.startsWith(flag + '=')) return { hit: true, attached: token.slice(flag.length + 1) };
  if (!flag.startsWith('--') && flag.length > 2 && token.startsWith(flag + '=')) return { hit: true, attached: token.slice(flag.length + 1) };
  if (!flag.startsWith('--') && flag.length === 2 && token.startsWith(flag) && token.length > 2 && !token.startsWith('--')) return { hit: true, attached: token.slice(2) };
  return { hit: false };
}

/** For cmdlets: which spec flag does `-Serv` abbreviate? */
function psPrefix(token: string, spec: DbClientSpec): { flag: string; group: keyof FlagGroups } | null {
  const t = token.toLowerCase().replace(/:.*$/, '');
  if (!t.startsWith('-')) return null;
  const groups: Array<[keyof FlagGroups, string[]]> = [
    ['servers', spec.serverFlags],
    ['databases', spec.dbFlags],
    ['queries', spec.queryFlags],
    ['scripts', spec.scriptFlags],
    ['conn', spec.connFlags],
    ['aliases', spec.aliasFlags],
    ['out', spec.outFlags],
    ['value', spec.valueFlags],
  ];
  const hits: Array<{ flag: string; group: keyof FlagGroups }> = [];
  for (const [group, flags] of groups) for (const f of flags) if (f.toLowerCase().startsWith(t)) hits.push({ flag: f, group });
  const exact = hits.find((h) => h.flag.toLowerCase() === t);
  if (exact) return exact;
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // ambiguous: prefer the dangerous interpretation (server/conn/script) so we fail closed
    const pref = hits.find((h) => h.group === 'servers' || h.group === 'conn' || h.group === 'scripts');
    return pref ?? hits[0];
  }
  return null;
}

interface FlagGroups {
  servers: string[];
  databases: string[];
  queries: string[];
  scripts: string[];
  conn: string[];
  aliases: string[];
  out: string[];
  value: string[];
}

function scanFlags(args: string[], spec: DbClientSpec): FlagScan {
  const r: FlagScan = { interactive: false, servers: [], databases: [], queries: [], scripts: [], dsn: false, conn: [], aliases: [], out: [], positionals: [], unknownFlags: [] };
  let i = 0;
  const take = (attached: string | undefined): string => {
    if (attached !== undefined) {
      i++;
      return attached;
    }
    const v = args[i + 1] ?? '';
    i += 2;
    return v;
  };
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      r.positionals.push(...args.slice(i + 1));
      break;
    }
    const isFlag = spec.cmdlet ? a.startsWith('-') && a.length > 1 : (a.startsWith('-') && a.length > 1) || (spec.kind === 'sqlpackage' && a.startsWith('/'));
    if (!isFlag) {
      r.positionals.push(a);
      i++;
      continue;
    }
    let matched = false;
    if (spec.cmdlet) {
      const p = psPrefix(a, spec);
      if (p) {
        const colon = a.indexOf(':');
        const attached = colon >= 0 ? a.slice(colon + 1) : undefined;
        const nextIsValue = attached === undefined && args[i + 1] !== undefined && !args[i + 1].startsWith('-');
        const v = attached !== undefined ? take(attached) : nextIsValue ? take(undefined) : (i++, '');
        switch (p.group) {
          case 'servers':
            r.servers.push(v);
            break;
          case 'databases':
            r.databases.push(v);
            break;
          case 'queries':
            r.queries.push(v);
            break;
          case 'scripts':
            r.scripts.push(v || '(file)');
            break;
          case 'conn':
            r.conn.push(v);
            break;
          case 'aliases':
            r.aliases.push(v);
            break;
          case 'out':
            r.out.push(v);
            break;
          default:
            break;
        }
        matched = true;
      }
      if (!matched) {
        // unknown switch parameter: no value
        r.unknownFlags.push(a);
        i++;
      }
      continue;
    }
    const groups: Array<[keyof FlagScan | 'value' | 'dsn' | 'interactive', string[]]> = [
      ['servers', spec.serverFlags],
      ['databases', spec.dbFlags],
      ['queries', spec.queryFlags],
      ['interactive', spec.interactiveFlags ?? []],
      ['scripts', spec.scriptFlags],
      ['dsn', spec.dsnFlags],
      ['conn', spec.connFlags],
      ['aliases', spec.aliasFlags],
      ['out', spec.outFlags],
      ['value', spec.valueFlags],
    ];
    for (const [group, flags] of groups) {
      for (const f of flags) {
        const fm = flagMatches(a, f, false);
        if (!fm.hit) continue;
        matched = true;
        if (group === 'dsn') {
          r.dsn = true;
          i++;
        } else if (group === 'value') {
          take(fm.attached);
        } else if (group === 'interactive') {
          r.interactive = true;
          r.queries.push(take(fm.attached));
        } else {
          const v = take(fm.attached);
          (r[group] as string[]).push(v);
        }
        break;
      }
      if (matched) break;
    }
    if (!matched) {
      r.unknownFlags.push(a);
      i++;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Dangerous statement scanning
// ---------------------------------------------------------------------------

const SQLCMD_DIRECTIVE_RE = /(^|[\r\n;])\s*(?::(r|connect|!!|out|error|setvar|exit|quit|ed|on|perftrace|serverlist)(?![A-Za-z0-9_])|!!)/i;
const PSQL_META_RE = /\\(c|connect|!|i|ir|include|include_relative|copy\b[^\n]*\bprogram|o|out|w|write|cd|setenv|lo_import|lo_export|gexec|gx)(?![A-Za-z0-9_])/;
const MYSQL_META_RE = /(^|[\r\n;])\s*(source\s|\\\.|system\s|\\!|tee\s|\\T|connect\s|\\r\b|use\s)/i;
const TSQL_DANGER_RE = /\b(xp_cmdshell|opendatasource|openrowset|openquery|sp_addlinkedserver|sp_oacreate|sp_oamethod|xp_reg\w+|sp_configure|xp_dirtree|xp_fileexist|bulk\s+insert|backup\s+(database|log)|restore\s+(database|log)|enable_broker|sp_execute_external_script)\b/i;
/** `EXEC ('...') AT linked_server`: runs on another server. */
const TSQL_EXEC_AT_RE = /\bexec(ute)?\s*\([\s\S]*\)\s*at\s+[\[\w"]/i;
/** server.database.schema.object (middle parts may be empty): a linked server. */
const TSQL_IDENT = '(?:\\[[^\\]\\r\\n]+\\]|"[^"\\r\\n]+"|[A-Za-z_][\\w$#@-]*)';
const TSQL_FOUR_PART_RE = new RegExp(`${TSQL_IDENT}\\s*\\.\\s*(?:${TSQL_IDENT})?\\s*\\.\\s*(?:${TSQL_IDENT})?\\s*\\.\\s*${TSQL_IDENT}`);
const MONGO_DANGER_RE = /\b(connect\s*\(|new\s+Mongo\s*\(|Mongo\s*\()/;
const KIND_SCRIPT_RE: Partial<Record<DbKind, RegExp>> = { mssql: SQLCMD_DIRECTIVE_RE, dbatools: SQLCMD_DIRECTIVE_RE, pg: PSQL_META_RE, mysql: MYSQL_META_RE, mongo: MONGO_DANGER_RE };

function scanStatements(kind: DbKind, text: string, restrictDb: boolean): { scripts: string[]; dangerous: string[] } {
  const scripts: string[] = [];
  const dangerous: string[] = [];
  if (!text) return { scripts, dangerous };
  const re = KIND_SCRIPT_RE[kind];
  if (re) {
    const m = re.exec(text);
    if (m) {
      const directive = m[0].trim();
      if (kind === 'mysql' && /^use\s/i.test(directive)) {
        if (restrictDb) dangerous.push('USE (switches database)');
      } else if (/^:?(r|\\i|\\ir|\\include|source|\\\.)/i.test(directive) || /^:r\b/i.test(directive)) scripts.push(directive);
      else dangerous.push(directive);
    }
  }
  if (kind === 'mssql' || kind === 'dbatools' || kind === 'sqlpackage') {
    const d = TSQL_DANGER_RE.exec(text);
    if (d) dangerous.push(d[0]);
    if (TSQL_EXEC_AT_RE.test(text)) dangerous.push('EXEC ... AT (a linked server)');
    if (TSQL_FOUR_PART_RE.test(text)) dangerous.push('a four-part name (a linked server)');
    if (restrictDb && /(^|[\s;])use\s+[\[\]\w.]+/i.test(text)) dangerous.push('USE (switches database)');
  }
  return { scripts, dangerous };
}

// ---------------------------------------------------------------------------
// Segment analysis
// ---------------------------------------------------------------------------

function wrapperTarget(seg: Segment): string | undefined {
  for (let i = seg.via.length - 1; i >= 0; i--) {
    const v = seg.via[i];
    if (!v.target) continue;
    if (/^(docker|podman) (run|create)/i.test(v.kind)) {
      // A client-only image (sqlcmd tools, psql) runs no server: its name is not a target.
      const img = seg.dockerImage ?? v.target;
      if (DB_CLIENT_IMAGE_RE.test(img) && !/^(mcr\.microsoft\.com\/)?mssql\/server/i.test(img)) continue;
      return v.target;
    }
    if (/^(docker|podman) exec|kubectl|oc |ssh|Invoke-Command/i.test(v.kind)) return v.target;
  }
  return undefined;
}

function modulesInCode(code: string, lang: Segment['innerLang']): Set<string> {
  const mods = new Set<string>();
  let m: RegExpExecArray | null;
  if (lang === 'js') {
    const re = /(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    while ((m = re.exec(code))) mods.add(m[1].replace(/^(node|npm|jsr|bun):/, '').replace(/^(@[^/@]+\/[^/@]+|[^/@]+)@[^/]*/, '$1'));
  } else if (lang === 'py') {
    const re = /(?:^|[\s;])(?:import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)|from\s+([A-Za-z_][\w.]*)\s+import|__import__\s*\(\s*['"]([^'"]+)['"])/g;
    while ((m = re.exec(code))) {
      if (m[1]) for (const x of m[1].split(',')) mods.add(x.trim());
      if (m[2]) mods.add(m[2]);
      if (m[3]) mods.add(m[3]);
    }
  }
  return mods;
}

/** Resolve a segment to a DB resolution, or null when it is not a DB command. `producer` is the pipeline segment feeding stdin. */
export function analyzeDbSegment(seg: Segment, hookEnv: NodeJS.ProcessEnv, producer?: Segment): DbResolution | null {
  const cmdEnv = seg.env;
  const container = wrapperTarget(seg);
  const res: DbResolution = { client: seg.prog, kind: 'env-only', targets: [], unresolved: [], scriptInputs: [], dangerous: [], interactive: false, outFiles: [] };
  const addFound = (f: Found) => {
    res.targets.push(...f.targets);
    res.unresolved.push(...f.unresolved);
  };
  let isDb = false;

  // 1. Env assignments in the command that carry DB targets.
  for (const [name, value] of Object.entries(cmdEnv)) {
    if (!DB_ENV_NAME_RE.test(name) || DB_CREDENTIAL_ENV_RE.test(name)) continue;
    isDb = true;
    if (seg.envDynamic.includes(name)) {
      res.unresolved.push(`${name} assigned from a variable`);
      continue;
    }
    addFound(envValueTargets(name, value, `env:${name}`, cmdEnv, hookEnv));
  }
  // `export DATABASE_URL=...` / `set X=...` / `setx X ...`
  if (seg.prog === 'export' || seg.prog === 'set' || seg.prog === 'setx' || seg.prog === 'declare') {
    for (let i = 0; i < seg.args.length; i++) {
      const a = seg.args[i];
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
      const name = m ? m[1] : seg.prog === 'setx' ? a : null;
      const value = m ? m[2] : seg.prog === 'setx' ? seg.args[i + 1] ?? '' : null;
      if (!name || value === null || !DB_ENV_NAME_RE.test(name) || DB_CREDENTIAL_ENV_RE.test(name)) continue;
      isDb = true;
      const tok = seg.argTokens[i];
      if (tok?.dynamic) res.unresolved.push(`${name} assigned from a variable`);
      else addFound(envValueTargets(name, value, `env:${name}`, cmdEnv, hookEnv));
      if (seg.prog === 'setx') i++;
    }
  }

  // 2. A DB docker image started directly (no inner command).
  if ((seg.prog === 'docker' || seg.prog === 'podman' || seg.prog === 'nerdctl') && seg.dockerImage && DB_IMAGE_RE.test(seg.dockerImage) && !(DB_CLIENT_IMAGE_RE.test(seg.dockerImage) && !/mssql\/server/i.test(seg.dockerImage))) {
    isDb = true;
    res.kind = 'docker-image';
    res.client = `${seg.prog} run ${seg.dockerImage.split('/').pop()}`;
    const name = seg.via[seg.via.length - 1]?.target || seg.dockerImage;
    res.targets.push({ host: name.toLowerCase(), source: 'container' });
    return res;
  }

  // 3. Known clients.
  let spec: DbClientSpec | undefined = DB_CLIENTS[seg.prog];
  let args = seg.args;
  if (seg.prog === 'dotnet' && args[0] === 'ef') {
    spec = DB_CLIENTS['dotnet-ef'];
    args = args.slice(1);
  }
  const otherDbaCmdlet = !spec && DB_CMDLET_RE.test(seg.prog) && seg.prog.includes('dba') && !seg.prog.startsWith('invoke-');
  if (!spec && DB_CMDLET_RE.test(seg.prog)) spec = seg.prog.includes('dba') ? DB_CLIENTS['invoke-dbaquery'] : DB_CLIENTS['invoke-sqlcmd'];
  if (spec) {
    const f = scanFlags(args, spec);
    if (spec.subcommands) {
      // Only some subcommands connect (knex migrate:make writes a file); a server or
      // connection flag names a target whatever the subcommand is.
      const sub = f.positionals[0] ?? '';
      const explicitTarget = f.servers.length > 0 || f.conn.length > 0 || f.dsn;
      if (!spec.subcommands.test(sub) && !explicitTarget) return isDb ? finish() : null;
    }
    isDb = true;
    res.kind = spec.kind;
    const restrictDbLater = true;
    // Arguments taken from variables (other than credentials) cannot be checked.
    for (let i = 0; i < seg.argTokens.length; i++) {
      const tok = seg.argTokens[i];
      if (!tok.dynamic || !/^\$|^%|\$\(|`/.test(tok.text)) continue;
      const prev = seg.args[i - 1] ?? '';
      const isCredential = /^(-P|-U|-p|-u|--password|--user|--username|-W|-Password|-Username|-Credential|-SqlCredential|--pass|-a)$/i.test(prev) || /^-[pu]./i.test(tok.text);
      const isServerFlag = spec.serverFlags.some((s) => s.toLowerCase() === prev.toLowerCase());
      const isQuery = spec.queryFlags.some((q) => q.toLowerCase() === prev.toLowerCase()) || /^--?(e|execute|eval|Query|c|command|Q|q)$/i.test(prev);
      if (isCredential || isServerFlag || isQuery) continue;
      if (/^-/.test(tok.text)) continue;
      const vm = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$|^%([A-Za-z_][A-Za-z0-9_]*)%$|^\$env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(tok.text);
      if (vm && envLookup(vm[1] ?? vm[2] ?? vm[3], cmdEnv, hookEnv) !== undefined) continue;
      res.unresolved.push(`the argument ${tok.text.slice(0, 30)} (a variable)`);
    }
    // Piped input: literal echo/printf text is scanned; anything else is an unreadable script.
    if (seg.stdinFromPipe && producer) {
      if (producer.prog === 'echo' || producer.prog === 'printf' || producer.prog === 'write-output') f.queries.push(producer.args.join(' '));
      else res.scriptInputs.push(`piped input from ${producer.prog || 'a pipeline'}`);
    }
    for (const s of f.servers) {
      const tok = seg.argTokens.find((t) => t.text === s);
      if (tok?.dynamic || TEMPLATE_RE.test(s)) {
        // try the hook env for $VAR spellings
        const vm = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$|^%([A-Za-z_][A-Za-z0-9_]*)%$|^\$env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
        const v = vm ? envLookup(vm[1] ?? vm[2] ?? vm[3], cmdEnv, hookEnv) : undefined;
        const spec2 = v !== undefined ? parseServerSpec(v) : null;
        if (spec2) res.targets.push({ ...spec2, source: `flag via env` });
        else res.unresolved.push(`the server argument "${s.slice(0, 40)}" (a variable)`);
        continue;
      }
      const sp = parseServerSpec(s);
      if (sp) res.targets.push({ ...sp, source: 'flag' });
      else addFound(findTargetsInText(s, 'flag', cmdEnv, hookEnv));
    }
    if (f.dsn) res.unresolved.push('a DSN (-D)');
    for (const a of f.aliases) res.unresolved.push(`a config alias or defaults file (${a.slice(0, 40)})`);
    for (const c of f.conn) {
      const tok = seg.argTokens.find((t) => t.text === c);
      if (tok?.dynamic) res.unresolved.push('a connection string built from variables');
      else {
        const found = findTargetsInText(c, 'connection string', cmdEnv, hookEnv);
        if (!found.targets.length && !found.unresolved.length) {
          const sp = parseServerSpec(c);
          if (sp) found.targets.push({ ...sp, source: 'connection string' });
          else found.unresolved.push(`a connection string without a readable server (${c.slice(0, 40)})`);
        }
        addFound(found);
      }
    }
    // database flags and positionals
    const dbNames: string[] = [];
    for (const d of f.databases) {
      const found = findTargetsInText(d, 'dbname', cmdEnv, hookEnv);
      if (found.targets.length || found.unresolved.length) addFound(found);
      else if (/^[A-Za-z_][\w$-]*$/.test(d)) dbNames.push(d);
      else dbNames.push(d);
    }
    if (spec.positionalDb) {
      const pos = f.positionals;
      if (pos.length) {
        const first = pos[0];
        const found = findTargetsInText(first, 'positional', cmdEnv, hookEnv);
        if (found.targets.length || found.unresolved.length) addFound(found);
        else if (spec.kind === 'mongo' && /[.:]/.test(first) && !/^[a-z+]+:\/\//i.test(first)) {
          // host:port/db or host/db
          const hostPart = first.split('/')[0];
          const dbPart = first.slice(hostPart.length + 1);
          const sp = parseServerSpec(hostPart);
          if (sp) res.targets.push({ ...sp, database: dbPart || undefined, source: 'positional' });
          else res.unresolved.push(`the connection target ${first.slice(0, 40)}`);
        } else if (spec.kind === 'pg' && /^(host|dbname|port|user|service)\s*=/.test(first)) {
          const found2 = findTargetsInText(first, 'conninfo', cmdEnv, hookEnv);
          if (/\bservice\s*=/.test(first)) found2.unresolved.push('a service alias in conninfo');
          addFound(found2);
          const dm = /\bdbname\s*=\s*([^\s]+)/.exec(first);
          if (dm) dbNames.push(dm[1]);
        } else if (/^[A-Za-z_][\w$-]*$/.test(first) && spec.kind !== 'mongo') dbNames.push(first);
      }
      if (spec.kind === 'redis' && pos.length) res.interactive = false;
    }
    // query text
    const queryText = [...f.queries, seg.heredoc ?? '', ...seg.redirects.filter((r) => r.op === '<<<').map((r) => r.target)].join('\n');
    const stdinFile = seg.redirects.find((r) => r.op === '<');
    if (stdinFile) res.scriptInputs.push(stdinFile.target || '(stdin file)');
    res.scriptInputs.push(...f.scripts);
    res.outFiles.push(...f.out);
    const hasQuery = f.queries.length > 0 || seg.heredoc !== undefined || seg.stdinFromPipe || seg.redirects.some((r) => r.op === '<<<' || r.op === '<') || f.scripts.length > 0;
    const nonInteractiveKinds: Set<DbKind> = new Set(['sqlpackage', 'migration']);
    const listing = spec.kind === 'pg' && (args.includes('-l') || args.includes('--list'));
    const bcpLike = seg.prog === 'bcp' || seg.prog === 'pg_dump' || seg.prog === 'pg_dumpall' || seg.prog === 'pg_restore' || seg.prog === 'mysqldump' || seg.prog === 'mysqladmin' || seg.prog === 'createdb' || seg.prog === 'dropdb' || seg.prog === 'vacuumdb';
    const redisArgs = spec.kind === 'redis' && f.positionals.length > 0;
    res.interactive = f.interactive || !(hasQuery || nonInteractiveKinds.has(spec.kind) || listing || bcpLike || redisArgs || otherDbaCmdlet);
    // env for server when no explicit server
    if (!res.targets.length && !f.dsn && !f.conn.length) {
      let fromEnv = false;
      for (const name of spec.envServer) {
        const v = envLookup(name, cmdEnv, hookEnv);
        if (v === undefined) continue;
        if (seg.envDynamic.includes(name)) {
          res.unresolved.push(`${name} assigned from a variable`);
          fromEnv = true;
          break;
        }
        addFound(envValueTargets(name, v, name in cmdEnv ? `env:${name}` : `hookenv:${name}`, cmdEnv, hookEnv));
        fromEnv = true;
        break;
      }
      if (!fromEnv) {
        if (spec.defaultLocal) res.targets.push({ host: 'localhost', source: 'default-local' });
        else if (spec.kind === 'migration') res.unresolved.push(`the connection ${seg.prog} reads from its configuration (not visible to the guard)`);
        else res.unresolved.push('no server name given');
      }
    }
    if (!dbNames.length) {
      for (const name of spec.envDb) {
        const v = envLookup(name, cmdEnv, hookEnv);
        if (v !== undefined && !seg.envDynamic.includes(name)) {
          dbNames.push(v);
          break;
        }
      }
    }
    if (dbNames.length) for (const t of res.targets) if (!t.database) t.database = dbNames[0];
    const st = scanStatements(spec.kind, queryText, restrictDbLater);
    res.scriptInputs.push(...st.scripts);
    res.dangerous.push(...st.dangerous);
    if (f.unknownFlags.length && spec.kind !== 'migration') {
      // unknown flags are tolerated for known clients (their values are not server names in any known client)
    }
    return finish();
  }

  // 4. Interpreter one-liners using a DB module.
  if (seg.innerCode && (seg.innerLang === 'js' || seg.innerLang === 'py')) {
    const mods = modulesInCode(seg.innerCode, seg.innerLang);
    const set = seg.innerLang === 'js' ? DB_MODULES_JS : DB_MODULES_PY;
    const used = [...mods].filter((m) => set.has(m) || set.has(m.split('/')[0]) || set.has(m.split('.')[0]));
    if (used.length) {
      isDb = true;
      res.kind = 'code';
      res.client = `${seg.prog} one-liner using ${used[0]}`;
      const found = findTargetsInText(seg.innerCode, 'code', cmdEnv, hookEnv);
      addFound(found);
      if (!found.targets.length && !found.unresolved.length) res.unresolved.push('no server name found in the code');
      const st = scanStatements(seg.innerLang === 'py' && used.some((u) => /psycopg|asyncpg|aiopg/.test(u)) ? 'pg' : 'mssql', seg.innerCode, true);
      res.dangerous.push(...st.dangerous);
      return finish();
    }
  }
  // 5. PowerShell inline ADO.NET usage.
  if (seg.dialect === 'powershell' && DB_KEYWORDS_PS.test(segmentText(seg))) {
    isDb = true;
    res.kind = 'code';
    res.client = 'PowerShell SqlClient';
    const found = findTargetsInText(segmentText(seg), 'code', cmdEnv, hookEnv);
    addFound(found);
    if (!found.targets.length && !found.unresolved.length) res.unresolved.push('no server name found in the script');
    return finish();
  }

  return isDb ? finish() : null;

  function finish(): DbResolution {
    // Wrapper target: the container/host/pod is a target of its own, and local spellings inside mean it.
    if (container) {
      const c = container.toLowerCase();
      for (const t of res.targets) if (t.host === 'localhost') t.host = c;
      if (!res.targets.some((t) => t.host === c)) res.targets.push({ host: c, source: 'container' });
    }
    // de-duplicate
    const seen = new Set<string>();
    res.targets = res.targets.filter((t) => {
      const k = `${t.host}|${t.port ?? ''}|${(t.database ?? '').toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return res;
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function listTestServers(db: DbConfig): string {
  const names = db.allowlist.filter((e) => e.marked === 'test').map((e) => e.server + (e.database ? '/' + e.database : ''));
  return names.length ? names.join(', ') : 'none';
}

/** Evaluate a resolution against the allowlist. */
export function decideDb(res: DbResolution, db: DbConfig): GuardDecisionLike {
  const who = res.client || 'the database client';
  if (!db.allowlist.length) {
    return { decision: 'deny', rail: 'db', reason: `No test database is marked yet, so ${who} is refused; ${MARK_INSTRUCTION}, then retry.`, matched: who };
  }
  if (!allowlistSigned(db)) {
    return { decision: 'deny', rail: 'db', reason: `The database allowlist is not signed (it changed since \`harness db mark\` ran), so ${who} is refused; ask the user to run \`harness db mark\` again.`, matched: who };
  }
  if (res.scriptInputs.length) {
    return { decision: 'deny', rail: 'db', reason: `${who} reads SQL from a script (${res.scriptInputs[0].slice(0, 60)}) that could switch servers inside, so the guard cannot check it; pass the statements inline (-Q for sqlcmd, -c for psql, -e for mysql) against a test server instead.`, matched: res.scriptInputs[0] };
  }
  if (res.dangerous.length) {
    return { decision: 'deny', rail: 'db', reason: `The statement uses ${res.dangerous[0]}, which reaches outside the test database or runs shell commands on the server; rewrite it with plain queries against the test server.`, matched: res.dangerous[0] };
  }
  if (res.interactive) {
    return { decision: 'deny', rail: 'db', reason: `An interactive ${who} session cannot be checked by the guard; pass the query inline (-Q for sqlcmd, -c for psql, -e for mysql, --eval for mongosh) against a test server.`, matched: who };
  }
  if (res.unresolved.length) {
    return { decision: 'deny', rail: 'db', reason: `${who} would connect to ${res.unresolved[0]}, which the guard cannot resolve to a server name; name the test server explicitly (for example -S <server>) instead of a DSN, alias or variable.`, matched: res.unresolved[0] };
  }
  if (!res.targets.length) {
    return { decision: 'deny', rail: 'db', reason: `${who} gives no server the guard can check; name the test server explicitly (for example -S <server>).`, matched: who };
  }
  for (const t of res.targets) {
    const m = matchAllowlist(t, db.allowlist, res.kind);
    if (m.ok) continue;
    const target = t.host + (t.port ? ',' + t.port : '') + (t.database ? '/' + t.database : '');
    if (m.why === 'not-test') return { decision: 'deny', rail: 'db', reason: `${who} would connect to ${target}, which is marked not-test; use a test server (${listTestServers(db)}) or ${MARK_INSTRUCTION}.`, matched: target };
    if (m.why === 'database') return { decision: 'deny', rail: 'db', reason: `${who} would use ${target}, but the test entry for ${t.host} allows only the database "${m.entry?.database}"; select that database (-d ${m.entry?.database}) or ${MARK_INSTRUCTION} for the one you need.`, matched: target };
    if (m.why === 'port') return { decision: 'deny', rail: 'db', reason: `${who} would connect to ${target}, but the test entry for ${t.host} names port ${entryParts(m.entry?.server ?? '')?.port}; use that port.`, matched: target };
    return { decision: 'deny', rail: 'db', reason: `${who} would connect to ${target}, which is not marked as a test database; use a test server (${listTestServers(db)}) or ${MARK_INSTRUCTION}.`, matched: target };
  }
  return { decision: 'allow', rail: 'db', reason: `all targets marked test (${res.targets.map((t) => t.host).join(', ')})` };
}

/** Full check of one segment: null when the segment is not a DB command. */
export function evaluateDbSegment(seg: Segment, hookEnv: NodeJS.ProcessEnv, db: DbConfig, producer?: Segment): GuardDecisionLike | null {
  // Opaque segments that mention a DB client are denied outright.
  if (seg.opaque && DB_KEYWORD_RE.test(segmentText(seg))) {
    return { decision: 'deny', rail: 'db', reason: `The command runs a database client through something the guard cannot read (${seg.opaqueReason ?? 'opaque'}); write the client call literally (for example sqlcmd -S <test-server> -Q "...") so it can be checked.`, matched: seg.opaqueReason ?? 'opaque' };
  }
  const res = analyzeDbSegment(seg, hookEnv, producer);
  if (!res) return null;
  return decideDb(res, db);
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const MCP_TARGET_FIELD_RE = /^(server|servers|host|hostname|hosts|connection|connectionstring|connection_string|connstr|dsn|url|uri|database_url|databaseurl|datasource|data_source|instance|serverinstance|sqlinstance|endpoint|address|addr|cluster|baseurl|base_url)$/i;

function collectMcpTargets(input: unknown, out: { targets: DbTargetRef[]; unresolved: string[] }, depth = 0): void {
  if (depth > 4 || !input || typeof input !== 'object') return;
  if (Array.isArray(input)) {
    for (const v of input) collectMcpTargets(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.replace(/[-\s]/g, '_');
    if (MCP_TARGET_FIELD_RE.test(key)) {
      if (typeof v === 'string') {
        const found = findTargetsInText(v, `field ${k}`, {}, {});
        if (found.targets.length) out.targets.push(...found.targets);
        else {
          const sp = /^[A-Za-z0-9._\\()[\]:-]+(,\d+)?$/.test(v) ? parseServerSpec(v.replace(/^https?:\/\//i, '').split('/')[0]) : null;
          if (sp) out.targets.push({ ...sp, source: `field ${k}` });
          else out.unresolved.push(`field ${k}="${v.slice(0, 40)}"`);
        }
        out.unresolved.push(...found.unresolved);
      } else if (Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string') collectMcpTargets({ [k]: x }, out, depth + 1);
      } else if (v && typeof v === 'object') collectMcpTargets(v, out, depth + 1);
      else if (v !== undefined && v !== null) out.unresolved.push(`field ${k} (${typeof v})`);
    } else if (v && typeof v === 'object') collectMcpTargets(v, out, depth + 1);
  }
}

export function evaluateMcp(toolName: string, toolInput: unknown, mcp: { allowedServers: Record<string, string[]> } | undefined): GuardDecisionLike {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const server = m ? m[1] : toolName.replace(/^mcp__/, '');
  const allowed = mcp?.allowedServers ?? {};
  const key = Object.keys(allowed).find((k) => k.toLowerCase() === server.toLowerCase());
  if (!key) {
    return { decision: 'deny', rail: 'mcp', reason: `MCP server "${server}" is not on the harness allowlist; use an allowed server${Object.keys(allowed).length ? ` (${Object.keys(allowed).join(', ')})` : ''} or ask the user to add it with its test targets through \`harness config\`.`, matched: server };
  }
  const targetsAllowed = allowed[key] ?? [];
  const found = { targets: [] as DbTargetRef[], unresolved: [] as string[] };
  collectMcpTargets(toolInput, found);
  if (found.unresolved.length) {
    return { decision: 'deny', rail: 'mcp', reason: `The MCP call to "${server}" names a target the guard cannot read (${found.unresolved[0]}); pass the test server name explicitly.`, matched: found.unresolved[0] };
  }
  if (!found.targets.length) return { decision: 'allow', rail: 'mcp', reason: `server ${server} allowed, no target field` };
  if (targetsAllowed.includes('*')) return { decision: 'allow', rail: 'mcp', reason: `server ${server} allowed for any target` };
  const entries: DbTarget[] = targetsAllowed.map((s) => {
    const [server2, database] = s.split('/');
    return { server: server2, database: database || undefined, marked: 'test' };
  });
  for (const t of found.targets) {
    const r = matchAllowlist(t, entries);
    if (!r.ok) {
      const target = t.host + (t.port ? ',' + t.port : '');
      return { decision: 'deny', rail: 'mcp', reason: `The MCP call to "${server}" targets ${target}, which is not among its allowed test targets (${targetsAllowed.join(', ') || 'none'}); use an allowed target or ask the user to add it through \`harness config\`.`, matched: target };
    }
  }
  return { decision: 'allow', rail: 'mcp', reason: `server ${server} allowed for ${found.targets.map((t) => t.host).join(', ')}` };
}
