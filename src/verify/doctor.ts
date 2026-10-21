/**
 * `harness verify doctor`: is the run safe and alive?
 *
 *   allowlist   non-empty and signed (else refuse with the marking instruction, exit 4)
 *   server      the run's server and database are marked test (and the guard agrees)
 *   migrations  the run database holds the tables of every applied migration, no
 *               migration file changed since launch, none is missing
 *   ports       each service port is in use by this run's process
 *   env         run.env matches the run; each service got the run's DB name and port
 *   services    each started service answers (health route or port)
 *   database    which database each service is connected to: a health/ready route
 *               that names it, else the environment the process runs with (indirect)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTextOr } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { instrument } from '../lib/log';
import { allowlistReady } from './sqlcmd';
import { planFromRun, recheckPlan, tablesIn } from './dbrun';
import { loadFeatureMap } from './featuremap';
import { probePort } from './ports';
import { parseRunEnv } from './runenv';
import { httpGet, ownsPid, pidAlive, tcpOpen } from './services';
import { runDirOf, runEnvPath, type VerifyContext, type VerifyRun } from './state';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorResult {
  code: number;
  checks: DoctorCheck[];
  /** Database name each service reports (or was launched with). */
  databases: Record<string, { name: string | null; how: 'reported' | 'process-env' | 'launch-env' | 'unknown' }>;
}

const DB_KEYS = ['database', 'databaseName', 'database_name', 'dbName', 'db_name', 'db', 'catalog', 'initialCatalog'];
const NOT_A_NAME = /^(up|down|ok|healthy|unhealthy|connected|disconnected|true|false|unknown|ready|degraded)$/i;

/** A database name in a health/ready body (`{database: "test_x"}`, `{db: {name: "test_x"}}`), or null. */
export function reportedDatabase(body: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  const visit = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== 'object' || depth > 4) return null;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!DB_KEYS.some((d) => d.toLowerCase() === k.toLowerCase())) continue;
      const x = o[k];
      if (typeof x === 'string' && x && !NOT_A_NAME.test(x)) return x;
      if (x && typeof x === 'object') {
        const inner = x as Record<string, unknown>;
        for (const nk of ['name', 'database', 'databaseName', 'catalog']) if (typeof inner[nk] === 'string' && !NOT_A_NAME.test(inner[nk] as string)) return inner[nk] as string;
      }
    }
    for (const x of Object.values(o)) {
      const r = visit(x, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return visit(j, 0);
}

/** One variable of a running process's environment (Linux /proc only). */
export function processEnvVar(pid: number, name: string): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`);
    for (const kv of raw.toString('utf8').split('\0')) {
      const eq = kv.indexOf('=');
      if (eq > 0 && kv.slice(0, eq) === name) return kv.slice(eq + 1);
    }
    return null;
  } catch {
    return null;
  }
}

export async function doctor(ctx: VerifyContext, run: VerifyRun | null): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const databases: DoctorResult['databases'] = {};
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  // 1. The allowlist, before anything else: an empty list refuses.
  const ready = allowlistReady(ctx.config.db);
  if (!ready.ok) {
    add('allowlist', 'fail', ready.reason);
    instrument({ event: 'verify.doctor', repo: ctx.repoId ?? undefined, task: ctx.taskId, counts: { refused: 1 } });
    return { code: 4, checks, databases };
  }
  const tests = ctx.config.db.allowlist.filter((e) => e.marked === 'test').map((e) => e.server + (e.database ? '/' + e.database : ''));
  add('allowlist', 'ok', `${ctx.config.db.allowlist.length} entr${ctx.config.db.allowlist.length === 1 ? 'y' : 'ies'}, signed; test: ${tests.join(', ')}`);
  if (!run) {
    add('run', 'fail', `no verify run for task ${ctx.taskId}; start one with \`harness verify launch\``);
    return { code: 1, checks, databases };
  }
  add('run', run.status === 'launched' ? 'ok' : run.status === 'partial' ? 'warn' : 'fail', `run ${run.runId} (${run.status}), ${run.services.length} service(s)`);
  const dir = runDirOf(run);
  if (run.dbUnreachable) add('database connectivity', 'warn', `database deliberately unreachable (--db-unreachable): the services were given 127.0.0.1,${run.unreachablePort ?? '?'}, where nothing listens; their own database errors are expected`);

  // 2. Server and database.
  let plan = null as ReturnType<typeof planFromRun>['plan'] | null;
  if (run.db) {
    const pf = planFromRun(run.db, ctx.vcfg);
    if (!pf.ok || !pf.plan) add('server', 'fail', pf.reason ?? 'cannot rebuild the database plan');
    else {
      const rc = recheckPlan(pf.plan, ctx.config.db);
      if (!rc.ok) {
        add('server', 'fail', rc.reason);
        instrument({ event: 'verify.doctor', repo: ctx.repoId ?? undefined, task: ctx.taskId, counts: { refused: 1 } });
        return { code: 4, checks, databases };
      }
      plan = pf.plan;
      add('server', 'ok', `${run.db.database} on ${run.db.server}: ${rc.reason}`);
    }
  } else add('server', 'skip', 'this run has no database');

  // 3. Migrations.
  if (run.db && plan) {
    const t = tablesIn(plan);
    if (!t.ok) add('migrations', 'fail', `cannot read the tables of ${run.db.database}: ${t.error}`);
    else {
      const map = loadFeatureMap(run.repoId);
      const problems: string[] = [];
      const applied = new Set(run.db.migrations.map((m) => `${m.service}/${m.id}`));
      const wantTables = new Set<string>();
      for (const m of run.db.migrations) {
        const svc = run.services.find((s) => s.name === m.service);
        const root = map?.services.find((s) => s.name === m.service)?.repoRoot ?? svc?.path;
        const text = root ? readTextOr(path.join(root, m.file), null) : null;
        if (text === null) problems.push(`${m.service}/${m.file} is gone since launch`);
        else if (sha256(text) !== m.sha256) problems.push(`${m.service}/${m.file} changed since launch (cleanup and launch again to apply it)`);
        for (const tb of map?.migrations.find((x) => x.service === m.service && x.id === m.id)?.tables ?? []) wantTables.add(tb);
      }
      if (map && run.db.source === 'migrations') {
        for (const m of map.migrations) if (run.db.schemaServices.includes(m.service) && m.kind === 'sql' && !applied.has(`${m.service}/${m.id}`)) problems.push(`${m.service}/${m.file} is not applied (added after launch?)`);
      }
      const absent = [...wantTables].filter((x) => !t.tables.includes(x));
      if (absent.length) problems.push(`tables missing from ${run.db.database}: ${absent.join(', ')}`);
      if (problems.length) add('migrations', 'fail', problems.join('; '));
      else add('migrations', 'ok', run.db.source === 'migrations' ? `${run.db.migrations.length} migration(s) applied, ${t.tables.length} table(s) present${run.db.seed ? `, seed ${run.db.seed}` : ', no seed'}` : `${run.db.source}: ${t.tables.length} table(s) present${run.db.source === 'snapshot' ? (run.db.migrationsSkipped ? ', migrations after the snapshot skipped on request (--no-migrate)' : `, ${applied.size} migration(s) applied after the snapshot`) : ''}`);
    }
  }

  // 4. Env.
  const envText = readTextOr(runEnvPath(dir), null);
  if (envText === null) add('env', 'fail', 'run.env is missing; launch again');
  else {
    const vars = parseRunEnv(envText);
    const bad: string[] = [];
    if (vars.RUN_ID !== run.runId) bad.push(`RUN_ID is ${vars.RUN_ID ?? 'unset'}`);
    if (run.db && vars.DB_NAME !== run.db.database) bad.push(`DB_NAME is ${vars.DB_NAME ?? 'unset'}`);
    if (!vars.BASE_URL) bad.push('BASE_URL is unset');
    const map = loadFeatureMap(run.repoId);
    for (const s of run.services) {
      const se = map?.services.find((x) => x.name === s.name);
      const portVar = se?.portVar ?? 'PORT';
      if (s.launchEnv[portVar] !== String(s.port)) bad.push(`${s.name} was not given ${portVar}=${s.port}`);
      if (run.db && se?.db.nameVar && s.launchEnv[se.db.nameVar] !== run.db.database) bad.push(`${s.name} was not given ${se.db.nameVar}=${run.db.database}`);
    }
    if (bad.length) add('env', 'fail', bad.join('; '));
    else add('env', 'ok', `run.env has ${Object.keys(vars).length} variable(s) for run ${run.runId}; every service was launched with its port${run.db ? ' and the run database' : ''}`);
  }

  // 5. Ports, services, databases.
  for (const s of run.services) {
    if (!s.pid) {
      add(`service ${s.name}`, 'fail', `not started: ${s.error ?? 'unknown'}`);
      continue;
    }
    const alive = pidAlive(s.pid);
    const owned = alive && ownsPid(s.pid, s.command);
    const free = await probePort(s.port);
    if (free) add(`port ${s.port}`, 'fail', `nothing listens on ${s.port} (${s.name} ${alive ? 'runs but does not listen' : 'is not running'})`);
    else add(`port ${s.port}`, owned ? 'ok' : 'warn', owned ? `in use by ${s.name} (pid ${s.pid}, this run)` : `in use, but ${s.name}'s process (pid ${s.pid}) ${alive ? 'is not the one this run started' : 'is gone'}: another process holds the port`);
    let answered = false;
    let body = '';
    if (s.health) {
      const h = await httpGet(s.baseUrl + s.health, 3000);
      answered = h.status !== undefined && (run.dbUnreachable ? true : h.status >= 200 && h.status < 300);
      body = h.body ?? '';
      add(`service ${s.name}`, answered ? 'ok' : 'fail', answered ? `${s.baseUrl}${s.health} answered ${h.status}` : `${s.baseUrl}${s.health} ${h.status ? `answered ${h.status}` : `did not answer (${h.error ?? 'no response'})`}`);
    } else {
      answered = await tcpOpen(s.port);
      add(`service ${s.name}`, answered ? 'ok' : 'fail', answered ? `${s.baseUrl} accepts connections (no health route found)` : `${s.baseUrl} does not accept connections`);
    }
    if (!run.db) continue;
    if (run.dbUnreachable) {
      add(`database ${s.name}`, 'skip', 'database deliberately unreachable (--db-unreachable); the connected-database check does not apply');
      continue;
    }
    let name = body ? reportedDatabase(body) : null;
    let how: DoctorResult['databases'][string]['how'] = name ? 'reported' : 'unknown';
    if (!name) {
      for (const p of ['/ready', '/readyz', '/health/db', '/status']) {
        if (p === s.health) continue;
        const h = await httpGet(s.baseUrl + p, 2000);
        if (h.status && h.status < 300 && h.body) {
          name = reportedDatabase(h.body);
          if (name) {
            how = 'reported';
            break;
          }
        }
      }
    }
    const map = loadFeatureMap(run.repoId);
    const nameVar = map?.services.find((x) => x.name === s.name)?.db.nameVar;
    if (!name && nameVar && alive) {
      const v = processEnvVar(s.pid, nameVar);
      if (v !== null) {
        name = v;
        how = 'process-env';
      }
    }
    if (!name && nameVar && s.launchEnv[nameVar]) {
      name = s.launchEnv[nameVar];
      how = 'launch-env';
    }
    databases[s.name] = { name, how };
    if (!name) add(`database ${s.name}`, 'warn', `${s.name} names no database (no health/ready route reports one, and its .env.example has no database variable)`);
    else if (name.toLowerCase() !== run.db.database.toLowerCase()) add(`database ${s.name}`, 'fail', `${s.name} uses ${name}, not the run database ${run.db.database}`);
    else
      add(
        `database ${s.name}`,
        'ok',
        how === 'reported'
          ? `${s.name} reports it is connected to ${name}`
          : how === 'process-env'
            ? `${s.name} runs with ${nameVar}=${name} (read from the process environment; indirect: no route reports the connected database)`
            : `${s.name} was launched with ${nameVar}=${name} (indirect: no route reports the connected database)`,
      );
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  instrument({ event: 'verify.doctor', repo: run.repoId, task: run.taskId, ids: { runId: run.runId }, counts: { checks: checks.length, failed, warned: checks.filter((c) => c.status === 'warn').length } });
  return { code: failed ? 1 : 0, checks, databases };
}
