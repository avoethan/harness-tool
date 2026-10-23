/**
 * The per-run database: `test_<runId>` on a server the user marked as test.
 *
 * Built one of three ways, in this order of preference:
 *   1. `verify.db.snapshot`: a server-side `.bak` path, `db:<source>` (copied
 *      with BACKUP ... COPY_ONLY + RESTORE) or `clone:<source>` (DBCC
 *      CLONEDATABASE, schema only). The source database must be marked test too.
 *   2. CREATE DATABASE, then every `.sql` migration of the services that share
 *      the schema (ordered by file version; services ordered so a migration
 *      that references another service's table runs after it), then the seed
 *      scripts (`verify.db.seed`, else `db/seed.sql`, `seed.sql`,
 *      `scripts/seed.sql` in each repository), or "no seed".
 *   3. `verify.db.mode: existing`: the named database as it is (never dropped).
 *
 * Every statement goes through sqlcmd as an argv array after the guard's DB
 * rail accepted the command line (src/verify/sqlcmd.ts). Cleanup drops only
 * a database whose name is `test_<runId>` of this run.
 */
import * as path from 'node:path';
import type { DbConfig, VerifyConfig } from '../types';
import { readTextOr } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { rawGit } from '../lib/git';
import { which } from '../lib/exec';
import { parseServerSpec } from '../guard/db';
import type { FeatureMap, MigrationEntry, ServiceEntry } from './featuremap';
import { objectsOfSql, orderSchemaServices } from './featuremap';
import type { AppliedMigration, RunDb } from './state';
import { RUN_DB_RE } from './state';
import {
  allowlistReady,
  checkScript,
  chooseTransport,
  guardCheck,
  nLiteral,
  queryRows,
  quoteIdent,
  runSql,
  validIdent,
  serviceServerCheck,
  type ContainerInfo,
  type DbLogin,
  type Transport,
  DEFAULT_CONTAINER_SQLCMD,
  sqlServerContainers,
} from './sqlcmd';

export const SEED_CANDIDATES = ['db/seed.sql', 'seed.sql', 'scripts/seed.sql', 'database/seed.sql', 'sql/seed.sql'];

export interface DbPlan {
  server: string;
  host: string;
  port?: string;
  database: string;
  mode: 'per-run' | 'existing';
  transport: Transport;
  container?: ContainerInfo;
  login: DbLogin;
  snapshot?: string;
}

export interface PlanResult {
  ok: boolean;
  plan?: DbPlan;
  reason?: string;
  /** True when the refusal is the DB rail (exit 4). */
  rail?: boolean;
}

/** The only server-wide test entry of the allowlist (when there is exactly one). */
export function onlyServerWideTest(db: DbConfig): string | undefined {
  const xs = db.allowlist.filter((e) => e.marked === 'test' && !e.database);
  return xs.length === 1 ? xs[0].server : undefined;
}

/** Work out where the run database lives and check every identity against the allowlist. */
export function planDb(o: { vcfg: VerifyConfig; db: DbConfig; runId: string; env?: NodeJS.ProcessEnv; deps?: Parameters<typeof chooseTransport>[2] }): PlanResult {
  const ready = allowlistReady(o.db);
  if (!ready.ok) return { ok: false, reason: ready.reason, rail: true };
  const v = o.vcfg.db ?? {};
  const mode = v.mode ?? 'per-run';
  const database = mode === 'existing' ? v.database ?? '' : `test_${o.runId}`;
  if (mode === 'existing' && !database) return { ok: false, reason: 'verify.db.mode is "existing" but verify.db.database names no database' };
  let server = v.server;
  // Transport first (a container can tell which local port it publishes).
  const tc = chooseTransport(o.vcfg, server ?? onlyServerWideTest(o.db), o.deps);
  if (!tc.ok || !tc.transport) return { ok: false, reason: tc.reason ?? 'no way to reach sqlcmd' };
  const t = tc.transport;
  if (!server && t.mode === 'docker' && tc.container?.hostPorts.length) server = `localhost,${tc.container.hostPorts[0]}`;
  if (!server) server = onlyServerWideTest(o.db);
  if (!server) return { ok: false, reason: 'no database server is known: set verify.db.server (host[,port]) with `harness config set`, or mark exactly one server as test' };
  if (t.mode === 'local') t.innerServer = server;
  const sp = parseServerSpec(server);
  if (!sp) return { ok: false, reason: `verify.db.server "${server.slice(0, 60)}" is not a host[,port] name` };
  const login: DbLogin = { user: v.user, passwordEnv: v.passwordEnv };
  const svc = serviceServerCheck(server, database, o.db, tc.container);
  if (!svc.ok) return { ok: false, reason: svc.reason, rail: true };
  const g = guardCheck(t, database, login, o.db, tc.container);
  if (!g.ok) return { ok: false, reason: g.reason, rail: true };
  if (mode === 'per-run') {
    const gm = guardCheck(t, 'master', login, o.db, tc.container);
    if (!gm.ok) return { ok: false, reason: `creating ${database} needs the server's master database: ${gm.reason}`, rail: true };
  }
  if (v.snapshot && /^(db|clone):/i.test(v.snapshot)) {
    const src = v.snapshot.replace(/^(db|clone):/i, '');
    const s1 = serviceServerCheck(server, src, o.db, tc.container);
    if (!s1.ok) return { ok: false, reason: `the snapshot source ${src}: ${s1.reason}`, rail: true };
    const s2 = guardCheck(t, src, login, o.db, tc.container);
    if (!s2.ok) return { ok: false, reason: `the snapshot source ${src}: ${s2.reason}`, rail: true };
  }
  return { ok: true, plan: { server, host: sp.host, port: sp.port, database, mode, transport: t, container: tc.container, login, snapshot: v.snapshot } };
}

// ---------------------------------------------------------------------------
// Schema sources
// ---------------------------------------------------------------------------

/** Services that share the run database: the ones started plus every service whose .env.example names the same database. */
export function schemaServices(map: FeatureMap, started: string[]): ServiceEntry[] {
  const byName = new Map(map.services.map((s) => [s.name, s]));
  const names = new Set(started);
  const dbNames = new Set(started.map((n) => byName.get(n)?.db.exampleName).filter((x): x is string => !!x));
  for (const s of map.services) if (s.db.exampleName && dbNames.has(s.db.exampleName)) names.add(s.name);
  return [...names].map((n) => byName.get(n)).filter((s): s is ServiceEntry => !!s && map.migrations.some((m) => m.service === s.name));
}

/** Migrations in apply order across the schema services. */
export function orderedMigrations(map: FeatureMap, services: ServiceEntry[]): { order: string[]; migrations: MigrationEntry[] } {
  const by = new Map<string, MigrationEntry[]>();
  for (const s of services) by.set(s.name, map.migrations.filter((m) => m.service === s.name));
  const order = orderSchemaServices(by);
  return { order, migrations: order.flatMap((s) => by.get(s) ?? []) };
}

/** Migration files added or changed since the base commit (committed or not). */
export function changedMigrationFiles(repoRoot: string, base: string | null, files: string[]): Set<string> {
  const out = new Set<string>();
  if (!files.length) return out;
  const b = base ?? 'HEAD';
  const d = rawGit(repoRoot, ['diff', '--name-only', b, '--', ...files], 20000);
  if (d.code === 0) for (const l of d.stdout.split(/\r?\n/)) if (l.trim()) out.add(l.trim());
  const u = rawGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', ...files], 20000);
  if (u.code === 0) for (const l of u.stdout.split(/\r?\n/)) if (l.trim()) out.add(l.trim());
  return out;
}

export function findSeeds(vcfg: VerifyConfig, entryRepo: string, repos: string[]): string[] {
  const conf = vcfg.db?.seed;
  if (conf) return [path.isAbsolute(conf) ? conf : path.resolve(entryRepo, conf)];
  const out: string[] = [];
  for (const r of repos) {
    for (const c of SEED_CANDIDATES) {
      const p = path.join(r, c);
      if (readTextOr(p, null) !== null) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building and dropping
// ---------------------------------------------------------------------------

export interface BuildInput {
  plan: DbPlan;
  migrations: MigrationEntry[];
  repoRoots: Record<string, string>;
  /** Base commit per service's repository (for the shared-schema change record). */
  bases: Record<string, string | null>;
  seeds: string[];
  env?: NodeJS.ProcessEnv;
  /** After a snapshot restore, apply the migrations the snapshot lacks (default true). */
  migrateAfterSnapshot?: boolean;
}

export interface BuildResult {
  ok: boolean;
  db: RunDb;
  error?: string;
  notes: string[];
}

function fail(db: RunDb, notes: string[], error: string): BuildResult {
  return { ok: false, db, error, notes };
}

async function restoreFrom(plan: DbPlan, bak: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const t = plan.transport;
  const files = queryRows(t, 'master', plan.login, `SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) AS dataPath, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400)) AS logPath`, { env });
  if (!files.ok || !files.rows[0]) return files.error ?? 'could not read the server default paths';
  const dataPath = String(files.rows[0].dataPath ?? '');
  const logPath = String(files.rows[0].logPath ?? dataPath);
  const list = runSql(t, 'master', plan.login, { query: `SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK = ${nLiteral(bak)}`, output: 'plain', env });
  if (!list.ok) return list.error ?? 'RESTORE FILELISTONLY failed';
  // Columns: LogicalName PhysicalName Type ... (whitespace separated, fixed width); take the first token and the type letter.
  const moves: string[] = [];
  let n = 0;
  for (const line of list.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+\S.*?\s+([DLSF])\s+/.exec(line.trim());
    if (!m || m[1] === 'LogicalName' || /^-+$/.test(m[1])) continue;
    const dir = m[2] === 'L' ? logPath : dataPath;
    const ext = m[2] === 'L' ? 'ldf' : n === 0 ? 'mdf' : 'ndf';
    moves.push(`MOVE ${nLiteral(m[1])} TO ${nLiteral(`${dir}${plan.database}_${n}.${ext}`)}`);
    n++;
  }
  if (!moves.length) return 'the backup lists no files';
  const r = runSql(t, 'master', plan.login, { query: `RESTORE DATABASE ${quoteIdent(plan.database)} FROM DISK = ${nLiteral(bak)} WITH ${moves.join(', ')}, RECOVERY`, output: 'plain', timeoutMs: 600_000, env });
  return r.ok ? null : r.error ?? 'RESTORE failed';
}

/** Per service, the migration files added or changed since the service's base commit. */
function changedByService(i: BuildInput): Map<string, Set<string>> {
  const changedBy = new Map<string, Set<string>>();
  for (const m of i.migrations) {
    const root = i.repoRoots[m.service];
    if (!root || changedBy.has(m.service)) continue;
    const files = i.migrations.filter((x) => x.service === m.service).map((x) => x.file);
    changedBy.set(m.service, changedMigrationFiles(root, i.bases[m.service] ?? null, files));
  }
  return changedBy;
}

/** What the restored database already holds, read once from it. */
export interface SnapshotObjects {
  tables: string[];
  /** `table.column`, lower-case. */
  columns: string[];
  /** Index names, lower-case. */
  indexes: string[];
  /** The migration-history table, when the database has one. */
  historyTable?: string;
  /** Every value of the history table (ids, file names), lower-case. */
  history: string[];
}

/** Names of the tables migration tools keep their history in. */
export const HISTORY_TABLES = ['__migrations', 'migrations', 'schema_migrations', '_migrations', 'migration_history', 'flyway_schema_history', '__efmigrationshistory', 'knex_migrations'];

export interface SnapshotDecision {
  m: MigrationEntry;
  changed: boolean;
  /** Objects the migration creates that the run database lacks. */
  missing: string[];
  /** Why it is applied. */
  why: 'missing-objects' | 'changed-no-objects';
}
export interface SnapshotHeld {
  m: MigrationEntry;
  changed: boolean;
  why: 'recorded' | 'present' | 'unchanged-no-objects';
  detail: string;
}

function historyNames(m: MigrationEntry): string[] {
  const base = m.file.split('/').pop() ?? m.file;
  return [m.id, m.file, base, base.replace(/\.[^.]+$/, '')].map((x) => x.toLowerCase());
}

/**
 * Decide, object by object, which migrations a restored snapshot lacks, in
 * apply order. `.sql` files only; a code migration is never selected.
 *   - recorded in the database's migration-history table: never applied;
 *   - creates objects (tables, added columns, indexes): applied when any is
 *     missing, held back as "already in the snapshot" when all are present,
 *     whether or not the file changed since the base commit;
 *   - creates nothing detectable (data-only, drops, alters): applied only
 *     when it changed since the base commit.
 */
export function migrationsAfterSnapshot(migrations: MigrationEntry[], changedBy: Map<string, Set<string>>, have: SnapshotObjects, textOf: (m: MigrationEntry) => string | null): { todo: SnapshotDecision[]; held: SnapshotHeld[] } {
  const tables = new Set(have.tables.map((t) => t.toLowerCase()));
  const columns = new Set(have.columns.map((t) => t.toLowerCase()));
  const indexes = new Set(have.indexes.map((t) => t.toLowerCase()));
  const history = new Set(have.history.map((t) => t.toLowerCase()));
  const todo: SnapshotDecision[] = [];
  const held: SnapshotHeld[] = [];
  for (const m of migrations) {
    if (m.kind !== 'sql') continue;
    const changed = changedBy.get(m.service)?.has(m.file) ?? false;
    if (have.historyTable && historyNames(m).some((n) => history.has(n))) {
      held.push({ m, changed, why: 'recorded', detail: `recorded in ${have.historyTable}` });
      continue;
    }
    const text = textOf(m);
    if (text === null) {
      todo.push({ m, changed, missing: [], why: 'changed-no-objects' }); // the apply step reports the unreadable file
      continue;
    }
    const o = objectsOfSql(text);
    const wanted = [...o.tables.map((t) => `table ${t}`), ...o.columns.map((c) => `column ${c.table}.${c.column}`), ...o.indexes.map((x) => `index ${x.index}`)];
    const missing = [
      ...o.tables.filter((t) => !tables.has(t)).map((t) => `table ${t}`),
      ...o.columns.filter((c) => !columns.has(`${c.table}.${c.column}`)).map((c) => `column ${c.table}.${c.column}`),
      ...o.indexes.filter((x) => !indexes.has(x.index)).map((x) => `index ${x.index}`),
    ];
    if (!wanted.length) {
      if (changed) todo.push({ m, changed, missing: [], why: 'changed-no-objects' });
      else held.push({ m, changed, why: 'unchanged-no-objects', detail: 'it creates no table, column or index to check and did not change since the base commit' });
    } else if (missing.length) todo.push({ m, changed, missing, why: 'missing-objects' });
    else held.push({ m, changed, why: 'present', detail: `already in the snapshot (${wanted.join(', ')})${changed ? '; the file changed since the base commit but its objects are present' : ''}` });
  }
  return { todo, held };
}

/** Read the tables, columns, indexes and migration-history rows of the run database (a few SELECTs, run database only). */
export function readSnapshotObjects(plan: Pick<DbPlan, 'transport' | 'database' | 'login'>, env?: NodeJS.ProcessEnv): { ok: boolean; objects: SnapshotObjects; error?: string } {
  const empty: SnapshotObjects = { tables: [], columns: [], indexes: [], history: [] };
  const t = tablesIn(plan, env);
  if (!t.ok) return { ok: false, objects: empty, error: `cannot list the tables of the restored database: ${t.error}` };
  const c = queryRows(plan.transport, plan.database, plan.login, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS', { env });
  if (!c.ok) return { ok: false, objects: empty, error: `cannot list the columns of the restored database: ${c.error}` };
  const ix = queryRows(plan.transport, plan.database, plan.login, 'SELECT i.name AS i, OBJECT_NAME(i.object_id) AS t FROM sys.indexes AS i WHERE i.name IS NOT NULL', { env });
  if (!ix.ok) return { ok: false, objects: empty, error: `cannot list the indexes of the restored database: ${ix.error}` };
  const objects: SnapshotObjects = {
    tables: t.tables,
    columns: c.rows.map((r) => `${String(r.t).toLowerCase()}.${String(r.c).toLowerCase()}`),
    indexes: ix.rows.map((r) => String(r.i).toLowerCase()),
    history: [],
  };
  const ht = t.tables.find((n) => HISTORY_TABLES.includes(n.toLowerCase()));
  if (ht && validIdent(ht)) {
    const h = queryRows(plan.transport, plan.database, plan.login, `SELECT TOP 5000 * FROM ${quoteIdent(ht)}`, { env });
    // An unreadable history table is not fatal: the object checks still decide.
    if (h.ok) {
      objects.historyTable = ht;
      for (const r of h.rows) for (const v of Object.values(r)) if (typeof v === 'string' || typeof v === 'number') objects.history.push(String(v).toLowerCase());
    }
  }
  return { ok: true, objects };
}

/** Create (or restore) the run database and bring its schema up. */
export async function buildRunDb(i: BuildInput): Promise<BuildResult> {
  const p = i.plan;
  const t = p.transport;
  const notes: string[] = [];
  const db: RunDb = {
    server: p.server,
    host: p.host,
    port: p.port,
    database: p.database,
    mode: p.mode,
    transport: t.mode,
    container: t.container,
    containerSqlcmd: t.mode === 'docker' ? t.sqlcmd : undefined,
    user: p.login.user,
    passwordEnv: p.login.passwordEnv,
    created: false,
    source: p.mode === 'existing' ? 'existing' : p.snapshot ? 'snapshot' : 'migrations',
    snapshot: p.snapshot,
    seed: null,
    migrations: [],
    schemaServices: [],
  };
  if (p.mode === 'existing') {
    const r = queryRows(t, p.database, p.login, 'SELECT DB_NAME() AS name', { env: i.env });
    if (!r.ok) return fail(db, notes, `cannot reach ${p.database}: ${r.error}`);
    notes.push(`using the existing test database ${p.database} as it is (verify.db.mode existing); it is never dropped`);
    return { ok: true, db, notes };
  }
  if (!RUN_DB_RE.test(p.database)) return fail(db, notes, `refusing to create ${p.database}: per-run databases are named test_<runid>`);
  const exists = queryRows(t, 'master', p.login, `SELECT name FROM sys.databases WHERE name = ${nLiteral(p.database)}`, { env: i.env });
  if (!exists.ok) return fail(db, notes, `cannot reach the server: ${exists.error}`);
  if (exists.rows.length) return fail(db, notes, `${p.database} already exists on the server; run \`harness verify cleanup\` first`);

  if (p.snapshot) {
    const snap = p.snapshot;
    let err: string | null = null;
    if (/^clone:/i.test(snap)) {
      const src = snap.slice(6);
      const r = runSql(t, 'master', p.login, { query: `DBCC CLONEDATABASE (${quoteIdent(src)}, ${quoteIdent(p.database)}) WITH VERIFY_CLONEDB, NO_STATISTICS, NO_QUERYSTORE`, output: 'plain', timeoutMs: 600_000, env: i.env });
      if (!r.ok) err = r.error ?? 'DBCC CLONEDATABASE failed';
      else {
        db.created = true;
        const rw = runSql(t, 'master', p.login, { query: `ALTER DATABASE ${quoteIdent(p.database)} SET READ_WRITE WITH ROLLBACK IMMEDIATE`, output: 'plain', env: i.env });
        if (!rw.ok) err = rw.error ?? 'could not make the clone writable';
        notes.push(`schema cloned from ${src} with DBCC CLONEDATABASE (no data)`);
      }
    } else if (/^db:/i.test(snap)) {
      const src = snap.slice(3);
      const dir = queryRows(t, 'master', p.login, `SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(400)) AS backupPath`, { env: i.env });
      const bdir = dir.ok && dir.rows[0]?.backupPath ? String(dir.rows[0].backupPath) : '';
      if (!bdir) err = dir.error ?? 'the server reports no default backup folder';
      else {
        const sep = bdir.includes('\\') && !bdir.includes('/') ? '\\' : '/';
        const bak = `${bdir.replace(/[\\/]+$/, '')}${sep}harness_${p.database}.bak`;
        const b = runSql(t, 'master', p.login, { query: `BACKUP DATABASE ${quoteIdent(src)} TO DISK = ${nLiteral(bak)} WITH COPY_ONLY, INIT`, output: 'plain', timeoutMs: 600_000, env: i.env });
        if (!b.ok) err = b.error ?? 'BACKUP failed';
        else {
          err = await restoreFrom(p, bak, i.env);
          if (!err) {
            db.created = true;
            db.backupFile = bak;
            notes.push(`restored from a copy-only backup of ${src} (${bak} on the server; removed at cleanup when the server runs in a container)`);
          }
        }
      }
    } else {
      err = await restoreFrom(p, snap, i.env);
      if (!err) {
        db.created = true;
        notes.push(`restored from the backup ${snap}`);
      }
    }
    if (err) return fail(db, notes, `snapshot ${snap}: ${err}`);
    if (i.migrateAfterSnapshot === false) {
      db.migrationsSkipped = true;
      notes.push('migrations were not applied after the snapshot (--no-migrate or verify.db.migrateAfterSnapshot is false); a column or table added by this work will be missing');
      return { ok: true, db, notes };
    }
    const have = readSnapshotObjects(p, i.env);
    if (!have.ok) return fail(db, notes, `snapshot ${snap}: ${have.error}`);
    const textOf = (m: MigrationEntry): string | null => {
      const root = i.repoRoots[m.service];
      return root ? readTextOr(path.join(root, m.file), null) : null;
    };
    const { todo, held } = migrationsAfterSnapshot(i.migrations, changedByService(i), have.objects, textOf);
    for (const h of held) notes.push(`${h.m.service}/${h.m.id}: not applied, ${h.detail}`);
    for (const d of todo) {
      if (d.why === 'changed-no-objects') notes.push(`${d.m.service}/${d.m.id}: creates no table, column or index it could check, so it is applied because it changed since the base commit`);
      else notes.push(`${d.m.service}/${d.m.id}: applied after the snapshot; the snapshot lacks ${d.missing.join(', ')}`);
    }
    const codeOnes = i.migrations.filter((m) => m.kind !== 'sql');
    for (const m of codeOnes) notes.push(`${m.service}: ${m.file} is a code migration; harness verify applies .sql files only (run the repository's own migration command against DB_NAME from \`harness verify env\`, or configure verify.db.snapshot)`);
    const services: string[] = [];
    for (const { m, changed } of todo) {
      const root = i.repoRoots[m.service];
      if (!root) continue;
      const text = readTextOr(path.join(root, m.file), null);
      if (text === null) return fail(db, notes, `cannot read ${m.service}/${m.file}`);
      const bad = checkScript(text, p.database);
      if (bad) return fail(db, notes, `${m.service}/${m.file} was not applied: ${bad}`);
      const r = runSql(t, p.database, p.login, { script: text, output: 'plain', timeoutMs: 300_000, env: i.env });
      if (!r.ok) return fail(db, notes, `${m.service}/${m.file} failed after the snapshot: ${r.error}`);
      const am: AppliedMigration = { service: m.service, id: m.id, file: m.file, sha256: sha256(text), afterSnapshot: true };
      if (changed) am.changed = true;
      db.migrations.push(am);
      if (!services.includes(m.service)) services.push(m.service);
    }
    db.schemaServices = services;
    return { ok: true, db, notes };
  }

  const c = runSql(t, 'master', p.login, { query: `CREATE DATABASE ${quoteIdent(p.database)}`, output: 'plain', timeoutMs: 120_000, env: i.env });
  if (!c.ok) return fail(db, notes, `CREATE DATABASE failed: ${c.error}`);
  db.created = true;

  // Migrations, shared-schema services in order.
  const services: string[] = [];
  const changedBy = changedByService(i);
  for (const m of i.migrations) {
    if (!services.includes(m.service)) services.push(m.service);
    const root = i.repoRoots[m.service];
    if (!root) continue;
    if (m.kind !== 'sql') {
      notes.push(`${m.service}: ${m.file} is a code migration; harness verify applies .sql files only (run the repository's own migration command against DB_NAME from \`harness verify env\`, or configure verify.db.snapshot)`);
      continue;
    }
    const text = readTextOr(path.join(root, m.file), null);
    if (text === null) return fail(db, notes, `cannot read ${m.service}/${m.file}`);
    const bad = checkScript(text, p.database);
    if (bad) return fail(db, notes, `${m.service}/${m.file} was not applied: ${bad}`);
    const r = runSql(t, p.database, p.login, { script: text, output: 'plain', timeoutMs: 300_000, env: i.env });
    if (!r.ok) return fail(db, notes, `${m.service}/${m.file} failed: ${r.error}`);
    const am: AppliedMigration = { service: m.service, id: m.id, file: m.file, sha256: sha256(text) };
    if (changedBy.get(m.service)?.has(m.file)) am.changed = true;
    db.migrations.push(am);
  }
  db.schemaServices = services;

  for (const s of i.seeds) {
    const text = readTextOr(s, null);
    if (text === null) return fail(db, notes, `cannot read the seed script ${s}`);
    const bad = checkScript(text, p.database);
    if (bad) return fail(db, notes, `the seed ${path.basename(s)} was not applied: ${bad}`);
    const r = runSql(t, p.database, p.login, { script: text, output: 'plain', timeoutMs: 300_000, env: i.env });
    if (!r.ok) return fail(db, notes, `the seed ${path.basename(s)} failed: ${r.error}`);
    db.seed = db.seed ? `${db.seed}, ${path.basename(path.dirname(s))}/${path.basename(s)}` : `${path.basename(path.dirname(s))}/${path.basename(s)}`;
    db.seedFiles = [...(db.seedFiles ?? []), s];
  }
  if (!i.seeds.length) notes.push('no seed: neither verify.db.seed nor db/seed.sql, seed.sql or scripts/seed.sql exists, so the run database holds the schema only');
  return { ok: true, db, notes };
}

/** Tables of the run database (dbo and other schemas), lower-cased. */
export function tablesIn(plan: Pick<DbPlan, 'transport' | 'database' | 'login'>, env?: NodeJS.ProcessEnv): { ok: boolean; tables: string[]; error?: string } {
  const r = queryRows(plan.transport, plan.database, plan.login, "SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'", { env });
  if (!r.ok) return { ok: false, tables: [], error: r.error };
  return { ok: true, tables: r.rows.map((x) => String(x.t).toLowerCase()) };
}

/** Drop the run database (only `test_<runId>` of a per-run database). */
export function dropRunDb(plan: Pick<DbPlan, 'transport' | 'database' | 'login' | 'mode'>, env?: NodeJS.ProcessEnv): { ok: boolean; error?: string; skipped?: string } {
  if (plan.mode !== 'per-run') return { ok: true, skipped: `${plan.database} is an existing database; it is never dropped` };
  if (!RUN_DB_RE.test(plan.database)) return { ok: false, error: `refusing to drop ${plan.database}: only test_<runid> databases are dropped` };
  const ex = queryRows(plan.transport, 'master', plan.login, `SELECT name FROM sys.databases WHERE name = ${nLiteral(plan.database)}`, { env });
  if (!ex.ok) return { ok: false, error: ex.error };
  if (!ex.rows.length) return { ok: true, skipped: `${plan.database} does not exist (already dropped)` };
  const q = `ALTER DATABASE ${quoteIdent(plan.database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteIdent(plan.database)};`;
  const r = runSql(plan.transport, 'master', plan.login, { query: q, output: 'plain', timeoutMs: 120_000, env });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Whether a database exists on the run's server. */
export function databaseExists(plan: Pick<DbPlan, 'transport' | 'login'>, name: string, env?: NodeJS.ProcessEnv): boolean | null {
  const r = queryRows(plan.transport, 'master', plan.login, `SELECT name FROM sys.databases WHERE name = ${nLiteral(name)}`, { env });
  return r.ok ? r.rows.length > 0 : null;
}

/** Rebuild the plan of a launched run from its record (later commands run in new processes). */
export function planFromRun(db: RunDb, vcfg: VerifyConfig): { ok: boolean; plan?: DbPlan; reason?: string } {
  let t: Transport;
  if (db.transport === 'docker') {
    const docker = which('docker');
    if (!docker) return { ok: false, reason: 'docker is not available any more' };
    t = { mode: 'docker', docker, container: db.container, sqlcmd: db.containerSqlcmd ?? vcfg.db?.containerSqlcmd ?? DEFAULT_CONTAINER_SQLCMD, innerServer: 'localhost' };
  } else {
    const p = vcfg.db?.sqlcmdPath ?? which('sqlcmd');
    if (!p) return { ok: false, reason: 'sqlcmd is not on PATH any more' };
    t = { mode: 'local', sqlcmd: p, innerServer: db.server };
  }
  return { ok: true, plan: { server: db.server, host: db.host, port: db.port, database: db.database, mode: db.mode, transport: t, login: { user: db.user, passwordEnv: db.passwordEnv }, snapshot: db.snapshot } };
}

/**
 * The DB rail again for a saved plan (the allowlist may have changed since launch). With
 * `allowReadOnly` (verify db) a run database now marked read-only passes with `readOnly: true`,
 * and the caller may only read it.
 */
export function recheckPlan(plan: DbPlan, db: DbConfig, container?: ContainerInfo, opts: { allowReadOnly?: boolean } = {}): { ok: boolean; reason: string; readOnly?: boolean } {
  const ready = allowlistReady(db);
  if (!ready.ok) return ready;
  let c = container;
  if (!c && plan.transport.mode === 'docker' && plan.transport.container) c = sqlServerContainers(plan.transport.docker).find((x) => x.name === plan.transport.container);
  const s = serviceServerCheck(plan.server, plan.database, db, c, opts);
  if (!s.ok) return s;
  const g = guardCheck(plan.transport, plan.database, plan.login, db, c, opts);
  if (!g.ok) return g;
  return { ok: true, reason: `${s.reason}; ${g.reason}`, readOnly: s.readOnly };
}
