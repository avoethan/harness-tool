/**
 * How `harness verify` reaches SQL Server: `sqlcmd` on PATH, or `sqlcmd`
 * inside a running SQL Server container (`docker exec -i <container>
 * /opt/mssql-tools18/bin/sqlcmd ...`). Every call is an argv array; the
 * password travels in the child's environment as SQLCMDPASSWORD (never on
 * the command line, never in a file the harness writes) and is read from
 * the variable the config names (`verify.db.passwordEnv`).
 *
 * The DB rail applies to the harness's own access too: before any call, the
 * equivalent command line (what the agent would type) is parsed by the
 * guard (src/guard/parse + src/guard/db) and must resolve to targets the
 * user marked `test`; an empty or unsigned allowlist refuses everything. A
 * target marked `read-only` is never created, restored, copied or seeded;
 * only `verify db` may read it, through the guard's read-only classifier.
 */
import * as fs from 'node:fs';
import type { DbConfig, VerifyConfig } from '../types';
import { run, which, type ExecResult } from '../lib/exec';
import { redactText } from '../lib/redact';
import { allSegments, parseCommand } from '../guard/parse';
import { allowlistSigned, evaluateDbSegment, MARK_INSTRUCTION, matchAllowlist, parseServerSpec } from '../guard/db';
import { classifyReadOnlySql } from '../guard/sqlreadonly';

export const DEFAULT_CONTAINER_SQLCMD = '/opt/mssql-tools18/bin/sqlcmd';
export const SQL_SERVER_IMAGE_RE = /(mssql\/server|azure-sql-edge|sql-?server)/i;
export const DEFAULT_PASSWORD_ENVS = ['HARNESS_VERIFY_DB_PASSWORD', 'SQLCMDPASSWORD', 'DB_PASSWORD', 'MSSQL_SA_PASSWORD'];
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface Transport {
  mode: 'local' | 'docker';
  /** Local sqlcmd path, or sqlcmd inside the container. */
  sqlcmd: string;
  docker?: string;
  container?: string;
  /** What -S names: the server itself (local) or the server as seen inside the container. */
  innerServer: string;
}

export interface DbLogin {
  user?: string;
  /** Name of the variable that holds the password (never the password). */
  passwordEnv?: string;
}

export interface ContainerInfo {
  name: string;
  image: string;
  /** Host ports published for the container's 1433 (or the only published port). */
  hostPorts: string[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Running containers of a SQL Server image (`docker ps`). */
export function sqlServerContainers(docker = which('docker')): ContainerInfo[] {
  if (!docker) return [];
  const r = run(docker, ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], { timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  return parseDockerPs(r.stdout).filter((c) => SQL_SERVER_IMAGE_RE.test(c.image));
}

export function parseDockerPs(text: string): ContainerInfo[] {
  const out: ContainerInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [name, image, ports = ''] = line.split('\t');
    if (!name || !image) continue;
    const hostPorts: string[] = [];
    for (const m of ports.matchAll(/(?:[\d.]+|\[[^\]]*\]|::):(\d+)->(\d+)\/tcp/g)) if (m[2] === '1433' && !hostPorts.includes(m[1])) hostPorts.push(m[1]);
    out.push({ name: name.trim(), image: image.trim(), hostPorts });
  }
  return out;
}

export interface TransportChoice {
  ok: boolean;
  transport?: Transport;
  container?: ContainerInfo;
  reason?: string;
}

/** Pick how sqlcmd is reached, following `verify.db.sqlcmd` (auto: PATH first, then a SQL Server container). */
export function chooseTransport(vcfg: VerifyConfig, server: string | undefined, deps: { which?: (c: string) => string | null; containers?: () => ContainerInfo[] } = {}): TransportChoice {
  const w = deps.which ?? which;
  const mode = vcfg.db?.sqlcmd ?? 'auto';
  if (mode === 'local' || mode === 'auto') {
    const p = vcfg.db?.sqlcmdPath && fs.existsSync(vcfg.db.sqlcmdPath) ? vcfg.db.sqlcmdPath : w('sqlcmd');
    if (p) {
      if (!server) return { ok: false, reason: 'no database server is configured: set verify.db.server (host[,port]) or mark exactly one server as test' };
      return { ok: true, transport: { mode: 'local', sqlcmd: p, innerServer: server } };
    }
    if (mode === 'local') return { ok: false, reason: 'sqlcmd is not on PATH (verify.db.sqlcmd is "local"); install sqlcmd or set verify.db.sqlcmd to "docker"' };
  }
  const docker = w('docker');
  if (!docker) return { ok: false, reason: 'neither sqlcmd on PATH nor docker is available; install sqlcmd, or run SQL Server in a container' };
  const list = (deps.containers ?? (() => sqlServerContainers(docker)))();
  let c: ContainerInfo | undefined;
  if (vcfg.db?.container) {
    c = list.find((x) => x.name === vcfg.db?.container);
    if (!c) return { ok: false, reason: `the container ${vcfg.db.container} (verify.db.container) is not running a SQL Server image; start it or fix the setting` };
  } else if (list.length === 1) c = list[0];
  else if (list.length > 1) {
    const port = server ? parseServerSpec(server)?.port : undefined;
    const byPort = port ? list.filter((x) => x.hostPorts.includes(port)) : [];
    if (byPort.length === 1) c = byPort[0];
    else return { ok: false, reason: `${list.length} SQL Server containers are running (${list.map((x) => x.name).join(', ')}); set verify.db.container to the test one` };
  } else return { ok: false, reason: 'sqlcmd is not on PATH and no SQL Server container is running; start the test container or install sqlcmd' };
  return { ok: true, container: c, transport: { mode: 'docker', sqlcmd: vcfg.db?.containerSqlcmd ?? DEFAULT_CONTAINER_SQLCMD, docker, container: c.name, innerServer: 'localhost' } };
}

/** The password variable to read: the configured name, else the first default that is set. */
export function passwordEnvName(login: DbLogin, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (login.passwordEnv) return login.passwordEnv;
  return DEFAULT_PASSWORD_ENVS.find((n) => typeof env[n] === 'string' && env[n] !== '');
}

// ---------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------

/** sqlcmd's own arguments (no program). Without a user, integrated auth (-E). */
export function sqlcmdArgs(t: Transport, database: string, login: DbLogin, extra: { query?: string; script?: boolean; output?: 'json' | 'plain' }): string[] {
  const args = ['-S', t.innerServer, '-d', database];
  if (login.user) args.push('-U', login.user);
  else args.push('-E');
  args.push('-C', '-b', '-x');
  if (extra.output !== 'plain') args.push('-y', '0');
  if (extra.query !== undefined) args.push('-Q', extra.query);
  return args;
}

/** Full argv: program first. */
export function sqlcmdArgv(t: Transport, database: string, login: DbLogin, extra: { query?: string; script?: boolean; output?: 'json' | 'plain' }): string[] {
  const inner = sqlcmdArgs(t, database, login, extra);
  if (t.mode === 'local') return [t.sqlcmd, ...inner];
  const pre = [t.docker ?? 'docker', 'exec', '-i'];
  if (login.user) pre.push('-e', 'SQLCMDPASSWORD');
  return [...pre, t.container ?? '', t.sqlcmd, ...inner];
}

/** POSIX rendering of an argv (for the guard and for the agent to copy). */
export function shellQuote(argv: string[]): string {
  return argv
    .map((a) => {
      if (a === '') return "''";
      if (/^[A-Za-z0-9_./:,@%+=-]+$/.test(a)) return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

/** What a person types: program names without absolute local paths, password from SQLCMDPASSWORD. */
export function displayCommand(t: Transport, database: string, login: DbLogin, query: string): string {
  const argv = sqlcmdArgv(t, database, login, { query });
  if (t.mode === 'local') argv[0] = 'sqlcmd';
  else argv[0] = 'docker';
  return shellQuote(argv);
}

// ---------------------------------------------------------------------------
// The rail on the harness's own access
// ---------------------------------------------------------------------------

export interface RailCheck {
  ok: boolean;
  reason: string;
  /** The target is marked read-only (only with allowReadOnly): the caller may only read. */
  readOnly?: boolean;
}

export interface RailOptions {
  /** Accept a target marked read-only (verify db's reads); the default refuses it. */
  allowReadOnly?: boolean;
}

/** Refuse when the allowlist is empty or unsigned (the guard's own preconditions). */
export function allowlistReady(db: DbConfig): RailCheck {
  if (!db.allowlist.length) return { ok: false, reason: `No test database is marked yet, so harness verify refuses every database step; ${MARK_INSTRUCTION} (for example \`harness db mark --server <host[,port]> --test\`), then retry.` };
  if (!allowlistSigned(db)) return { ok: false, reason: 'The database allowlist is not signed (it changed since `harness db mark` ran), so harness verify refuses every database step; ask the user to run `harness db mark` again.' };
  if (!db.allowlist.some((e) => e.marked === 'test')) return { ok: false, reason: `No server in the allowlist is marked test; ${MARK_INSTRUCTION}.` };
  return { ok: true, reason: 'allowlist present and signed' };
}

/**
 * The guard's DB rail on the command line the harness is about to run (with
 * a harmless query in place of the real one, so admin statements are judged
 * by their targets only). Fails closed when the guard sees no DB target.
 *
 * With the docker transport the guard names the container; the user usually
 * marks the server the services use, `localhost,<port>`. When `container`
 * is given and it publishes that port (`docker ps` shows `<port>->1433`), the
 * two are the same server, so a `localhost,<port>` (or `127.0.0.1,<port>`)
 * entry marked test for this database also covers the harness's own call.
 * The agent's own commands are still judged by the guard as typed.
 */
export function guardCheck(t: Transport, database: string, login: DbLogin, db: DbConfig, container?: ContainerInfo, opts: RailOptions = {}): RailCheck {
  const ready = allowlistReady(db);
  if (!ready.ok) return ready;
  const line = shellQuote(sqlcmdArgv(t, database, login, { query: 'SELECT 1' }));
  const parsed = parseCommand(line, { dialect: 'posix' });
  let seen = false;
  for (const seg of allSegments(parsed)) {
    const d = evaluateDbSegment(seg, {}, db, undefined, { requireTest: !opts.allowReadOnly });
    if (!d) continue;
    seen = true;
    if (d.decision === 'deny') {
      const viaPort = t.mode === 'docker' && container && container.name === t.container ? publishedPortMarked(container, database, db) : undefined;
      if (viaPort) return { ok: true, reason: `the container ${container?.name} publishes ${viaPort}, which is marked test` };
      return { ok: false, reason: d.reason };
    }
  }
  if (!seen) return { ok: false, reason: 'the guard could not resolve the database command harness verify would run, so it is refused' };
  return { ok: true, reason: `the guard resolves ${t.mode === 'docker' ? `container ${t.container}` : t.innerServer}/${database} to a test target` };
}

/** The `localhost,<port>` spelling of a published port of the container that is marked test for this database, if any. */
function publishedPortMarked(container: ContainerInfo, database: string, db: DbConfig): string | undefined {
  for (const port of container.hostPorts) {
    for (const host of ['localhost', '127.0.0.1']) {
      const m = matchAllowlist({ host, port, database, source: 'container-port' }, db.allowlist, 'mssql');
      if (m.ok) return `${host},${port}`;
    }
  }
  return undefined;
}

/** Whether the server the services connect to is a marked test target (directly, or as the marked container's published port). */
export function serviceServerCheck(server: string, database: string, db: DbConfig, container?: ContainerInfo, opts: RailOptions = {}): RailCheck {
  const ready = allowlistReady(db);
  if (!ready.ok) return ready;
  const sp = parseServerSpec(server);
  if (!sp) return { ok: false, reason: `the server "${server.slice(0, 60)}" is not a host[,port] name` };
  const m = matchAllowlist({ ...sp, database, source: 'verify' }, db.allowlist, 'mssql');
  if (m.ok) return { ok: true, reason: `${server} is marked test` };
  if (m.why === 'read-only' && opts.allowReadOnly) return { ok: true, readOnly: true, reason: `${server}/${database} is marked read-only (reads only)` };
  if (m.why === 'read-only') return { ok: false, reason: `${server}/${database} is marked read-only (${m.entry?.database ? `the entry ${m.entry.server}/${m.entry.database}` : `the server-wide entry ${m.entry?.server ?? server}`}): harness verify never creates, restores, copies from or seeds a read-only database; use a server or database marked test, or ask the user to mark it test with \`harness db mark\`.` };
  if (container && sp.host === 'localhost' && sp.port && container.hostPorts.includes(sp.port)) {
    const mc = matchAllowlist({ host: container.name.toLowerCase(), database, source: 'container' }, db.allowlist, 'mssql');
    if (mc.ok) return { ok: true, reason: `${server} is the published port of the container ${container.name}, which is marked test` };
  }
  const why = m.why === 'not-test' ? 'is marked not-test' : m.why === 'database' ? `is marked test only for the database "${m.entry?.database}", not ${database}` : m.why === 'port' ? 'is marked test on another port' : 'is not marked as a test database';
  return { ok: false, reason: `${server} ${why}; ${MARK_INSTRUCTION}${m.why === 'database' ? ' (server-wide, so per-run databases test_<runid> are allowed), or set verify.db.mode to "existing"' : ''}.` };
}

// ---------------------------------------------------------------------------
// SQL text checks
// ---------------------------------------------------------------------------

const DANGER_RE = /\b(xp_cmdshell|xp_\w+|opendatasource|openrowset|openquery|sp_addlinkedserver|sp_oacreate|sp_oamethod|sp_configure|sp_execute_external_script|reconfigure|shutdown|enable_broker|bulk\s+insert|backup\s+(database|log)|restore\s+(database|log)|(create|alter|drop)\s+(database|login|server|endpoint|credential)|grant\s+control\s+server)\b/i;
const DIRECTIVE_RE = /(^|[\r\n])\s*(:(r|connect|setvar|out|error|perftrace|serverlist|listvar|exit|quit|xml|ed|reset|help)\b|!!)/i;

/** Strip string literals and comments (for scanning statement keywords). */
export function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function crossDatabase(code: string, runDb: string): string | null {
  const useM = /\buse\s+\[?([A-Za-z0-9_]+)\]?/i.exec(code);
  if (useM && useM[1].toLowerCase() !== runDb.toLowerCase()) return `USE ${useM[1]}`;
  // three- or four-part names: db.schema.object (brackets allowed)
  for (const m of code.matchAll(/(\[?[A-Za-z_][\w$]*\]?)\s*\.\s*(\[?[A-Za-z_][\w$]*\]?)?\s*\.\s*\[?[A-Za-z_][\w$]*\]?/g)) {
    const first = m[1].replace(/[[\]]/g, '').toLowerCase();
    // schema.table.column is a column reference, not another database
    if (first === runDb.toLowerCase() || first === 'dbo' || first === 'sys' || first === 'information_schema') continue;
    return `${m[0].replace(/\s+/g, '')}`;
  }
  return null;
}

/**
 * Agent-supplied --query: one read-only SELECT against the run database. The
 * checks below keep their plain messages; the guard's read-only classifier
 * (the same one the database rail applies to read-only targets) has the last word.
 */
export function checkSelectOnly(sql: string, runDb: string): string | null {
  if (DIRECTIVE_RE.test(sql)) return 'sqlcmd directives (:r, :connect, !!) are not allowed in a query';
  const code = stripSqlLiterals(sql).trim().replace(/;\s*$/, '');
  if (!code) return 'the query is empty';
  if (code.includes(';')) return 'one statement only (no ";" between statements)';
  if (!/^(select|with)\b/i.test(code)) return 'only a SELECT (or WITH ... SELECT) query is allowed; change data through the service, or with a recipe in the feature-map overlay';
  if (/\binto\b/i.test(code) && /^select\b[\s\S]*\binto\s+[#@\w[]/i.test(code)) return 'SELECT ... INTO creates a table; read only';
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny)\b/i.test(code)) return 'only reading statements are allowed in --query';
  if (DANGER_RE.test(code)) return `the query uses ${DANGER_RE.exec(code)?.[0]}, which reaches outside the run database`;
  const x = crossDatabase(code, runDb);
  if (x) return `the query names another database (${x}); it may read only ${runDb}`;
  const v = classifyReadOnlySql(sql, { databases: [runDb] });
  if (!v.ok) return `the query could write or reach outside ${runDb} (${v.word}); --query takes one read-only SELECT`;
  return null;
}

/** A recipe or query against a database marked read-only: refused unless the classifier proves it reads. */
export function checkReadOnlyTarget(sql: string, database: string): string | null {
  const v = classifyReadOnlySql(sql, { databases: [database] });
  return v.ok ? null : `${database} is marked read-only: this statement could write (${v.word}); stop and ask the user to run it or approve it`;
}

/** Hand-written recipe SQL: data statements allowed, nothing that leaves the run database. */
export function checkRecipeSql(sql: string, runDb: string): string | null {
  if (DIRECTIVE_RE.test(sql)) return 'sqlcmd directives (:r, :connect, !!) are not allowed in a recipe';
  const code = stripSqlLiterals(sql);
  if (DANGER_RE.test(code)) return `the recipe uses ${DANGER_RE.exec(code)?.[0]}, which reaches outside the run database`;
  const x = crossDatabase(code, runDb);
  if (x) return `the recipe names another database (${x}); it may touch only ${runDb}`;
  return null;
}

/** Migration and seed scripts from the repository: same rules (they run as given, batch by batch). */
export function checkScript(sql: string, runDb: string): string | null {
  return checkRecipeSql(sql, runDb);
}

// ---------------------------------------------------------------------------
// Quoting and parameters
// ---------------------------------------------------------------------------

export function validIdent(s: string): boolean {
  return IDENT_RE.test(s);
}

/** [name] with ] doubled; refuses anything that is not a plain identifier (schema.table allowed). */
export function quoteIdent(name: string): string {
  const parts = name.split('.');
  if (parts.length > 2 || !parts.every(validIdent)) throw new Error(`not a plain identifier: ${JSON.stringify(name.slice(0, 60))}`);
  return parts.map((p) => `[${p.replace(/]/g, ']]')}]`).join('.');
}

export function nLiteral(v: string): string {
  return `N'${v.replace(/'/g, "''")}'`;
}

export type SqlParam = string | number | boolean | null;

/**
 * A parameterised statement through sp_executesql: values become typed
 * parameters (@p0, @p1, ...), never text spliced into the statement.
 */
export function parameterised(sql: string, params: SqlParam[]): string {
  if (!params.length) return sql;
  const decl: string[] = [];
  const assigns: string[] = [];
  params.forEach((v, i) => {
    const n = `@p${i}`;
    if (v === null) {
      decl.push(`${n} nvarchar(4000)`);
      assigns.push(`${n} = NULL`);
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      decl.push(`${n} bigint`);
      assigns.push(`${n} = ${v}`);
    } else if (typeof v === 'number') {
      decl.push(`${n} float`);
      assigns.push(`${n} = ${v}`);
    } else if (typeof v === 'boolean') {
      decl.push(`${n} bit`);
      assigns.push(`${n} = ${v ? 1 : 0}`);
    } else {
      decl.push(`${n} nvarchar(max)`);
      assigns.push(`${n} = ${nLiteral(v)}`);
    }
  });
  return `EXEC sp_executesql ${nLiteral(sql)}, ${nLiteral(decl.join(', '))}, ${assigns.join(', ')}`;
}

/** Wrap a SELECT so sqlcmd prints one JSON array (FOR JSON PATH). */
export function jsonQuery(select: string): string {
  return `SET NOCOUNT ON; SELECT (${select} FOR JSON PATH, INCLUDE_NULL_VALUES) AS j;`;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface SqlResult {
  ok: boolean;
  /** First error lines, redacted (sqlcmd prints errors on stdout). */
  error?: string;
  stdout: string;
  durationMs: number;
}

function childEnv(login: DbLogin, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  delete out.SQLCMDPASSWORD;
  delete out.SQLCMDSERVER;
  delete out.SQLCMDDBNAME;
  delete out.SQLCMDINI;
  if (login.user) {
    const name = passwordEnvName(login, env);
    const pw = name ? env[name] : undefined;
    if (pw) out.SQLCMDPASSWORD = pw;
  }
  return out;
}

function errorLines(r: ExecResult): string {
  const text = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pick = text.filter((l) => /^(Msg \d+|Sqlcmd: Error|HResult|Login failed|error|Error)/i.test(l) || /error|failed|invalid/i.test(l));
  return redactText((pick.length ? pick : text).slice(0, 4).join(' | ').slice(0, 500)) || `sqlcmd exited with ${r.code}${r.timedOut ? ' (timed out)' : ''}`;
}

export interface RunSqlOptions {
  query?: string;
  /** A script (batches separated by GO) sent on stdin. */
  script?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  output?: 'json' | 'plain';
}

/** Run one query or script. The caller has already passed guardCheck for (transport, database). */
export function runSql(t: Transport, database: string, login: DbLogin, o: RunSqlOptions): SqlResult {
  if (!IDENT_RE.test(database) && database !== 'master') return { ok: false, error: `invalid database name ${JSON.stringify(database.slice(0, 40))}`, stdout: '', durationMs: 0 };
  const argv = sqlcmdArgv(t, database, login, { query: o.query, output: o.output });
  const env = childEnv(login, o.env ?? process.env);
  if (login.user && !env.SQLCMDPASSWORD) {
    const name = passwordEnvName(login, o.env ?? process.env);
    return { ok: false, error: `no password: set the environment variable ${name ?? login.passwordEnv ?? 'named by verify.db.passwordEnv'} (harness verify never stores it)`, stdout: '', durationMs: 0 };
  }
  const r = run(argv[0], argv.slice(1), { env, timeoutMs: o.timeoutMs ?? 120_000, input: o.script !== undefined ? o.script + '\nGO\n' : undefined });
  if (r.code !== 0 || r.timedOut) return { ok: false, error: errorLines(r), stdout: '', durationMs: r.durationMs };
  if (/^Msg \d+, Level (1[1-9]|2\d)/m.test(r.stdout)) return { ok: false, error: errorLines(r), stdout: '', durationMs: r.durationMs };
  return { ok: true, stdout: r.stdout, durationMs: r.durationMs };
}

/** Parse the output of a jsonQuery() run. */
export function parseJsonRows(stdout: string): Array<Record<string, unknown>> | null {
  const text = stdout
    .split(/\r?\n/)
    .filter((l) => !/^\(\d+ rows? affected\)$/.test(l.trim()))
    .join('')
    .trim();
  if (!text || text === 'NULL') return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/** Run a SELECT and return its rows. */
export function queryRows(t: Transport, database: string, login: DbLogin, select: string, o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; rows: Array<Record<string, unknown>>; error?: string; durationMs: number } {
  const r = runSql(t, database, login, { query: jsonQuery(select), timeoutMs: o.timeoutMs, env: o.env });
  if (!r.ok) return { ok: false, rows: [], error: r.error, durationMs: r.durationMs };
  const rows = parseJsonRows(r.stdout);
  if (!rows) return { ok: false, rows: [], error: 'could not read the result as JSON', durationMs: r.durationMs };
  return { ok: true, rows, durationMs: r.durationMs };
}
