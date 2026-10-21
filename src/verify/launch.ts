/**
 * `harness verify launch`: per run, a free port range, a per-run database on
 * a marked test server, run.env, and the touched services (plus the ones they
 * need) started from their repositories with the run's variables. Nothing is
 * written inside a repository: state, logs and run.env live in
 * `~/.harness/runs/<repoId>/<taskId>/`.
 */
import * as path from 'node:path';
import type { HarnessConfig } from '../types';
import { writeJson, writeTextAtomic } from '../lib/fsx';
import { headSha } from '../lib/git';
import { instrument } from '../lib/log';
import { loadBrief } from '../intake/brief';
import { buildFeatureMap, saveFeatureMap, withNeeds, type FeatureMap, type ServiceEntry } from './featuremap';
import { loadOverlay } from './overlay';
import { allocatePorts, releasePorts } from './ports';
import { renderPosix, envStem } from './runenv';
import { pickScript, startService, waitReady, logTail } from './services';
import { buildRunDb, findSeeds, orderedMigrations, planDb, schemaServices, type DbPlan } from './dbrun';
import { passwordEnvName, type DbLogin } from './sqlcmd';
import { loadRun, newRunId, pointerPath, runEnvPath, runFolder, saveRun, type ServiceRun, type VerifyContext, type VerifyRun } from './state';

export interface LaunchOptions {
  services?: string[];
  /** Skip the database (services that need none). */
  noDb?: boolean;
  /** Do not apply the migrations a restored snapshot lacks (`--no-migrate`). */
  noMigrate?: boolean;
  /** Point the services' database variables at a loopback port nothing listens on (`--db-unreachable`). */
  dbUnreachable?: boolean;
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface LaunchResult {
  code: number;
  lines: string[];
  run?: VerifyRun;
  map?: FeatureMap;
}

const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

/** The services a launch starts when --services is absent: the brief's repositories, else the current one. */
export function defaultServices(ctx: VerifyContext, map: FeatureMap): string[] {
  const brief = ctx.taskId !== 'adhoc' ? loadBrief(ctx.taskId) : null;
  const repos = new Set<string>();
  for (const u of brief?.units ?? []) if (u.repo) repos.add(u.repo);
  if (!repos.size && ctx.repoId) repos.add(ctx.repoId);
  const out = map.services.filter((s) => repos.has(s.repoId)).map((s) => s.name);
  if (!out.length && ctx.repoRoot) {
    const here = map.services.filter((s) => ctx.repoRoot && (s.repoRoot === ctx.repoRoot || s.dir === ctx.repoRoot));
    return here.map((s) => s.name);
  }
  return out;
}

/** Variables for one service's process: run values for the variables its .env.example declares. */
export function serviceEnv(
  s: ServiceEntry,
  port: number,
  urls: Record<string, string>,
  db: { host: string; port?: string; database: string; user?: string } | null,
  extra: Record<string, string> = {},
): { env: Record<string, string>; secretNames: string[]; notes: string[] } {
  const env: Record<string, string> = {};
  const notes: string[] = [];
  const secretNames: string[] = [];
  // Example values for the other declared variables, when they are safe (not secret, not a remote URL).
  for (const v of s.envVars) {
    const val = s.envDefaults[v];
    if (val === undefined) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(val) && !LOCAL_URL_RE.test(val)) continue;
    env[v] = val;
  }
  env[s.portVar ?? 'PORT'] = String(port);
  for (const [v, target] of Object.entries(s.needs)) {
    if (urls[target]) env[v] = urls[target];
    else notes.push(`${s.name}: ${v} points at ${target}, which this run does not start; it keeps its example value`);
  }
  if (db) {
    if (s.db.serverVar) env[s.db.serverVar] = s.db.portVar || !db.port ? db.host : `${db.host},${db.port}`;
    if (s.db.portVar && db.port) env[s.db.portVar] = db.port;
    else if (s.db.portVar && !db.port) delete env[s.db.portVar];
    if (s.db.nameVar) env[s.db.nameVar] = db.database;
    if (s.db.userVar && db.user) env[s.db.userVar] = db.user;
    if (s.db.passwordVar) secretNames.push(s.db.passwordVar);
    if (s.db.urlVar) secretNames.push(s.db.urlVar);
  }
  Object.assign(env, extra);
  return { env, secretNames, notes };
}

/**
 * The SQL login the started services declare in their `.env.example` (the
 * example value of their user variable), when `verify.db.user` is not set.
 * The services get that same value through serviceEnv, so the harness's own
 * sqlcmd uses the login the services use instead of integrated auth. Only a
 * plain login name is taken; the password never comes from a file.
 */
export function exampleDbUser(services: ServiceEntry[]): { user: string; from: string } | undefined {
  for (const s of services) {
    const v = s.db.userVar ? s.envDefaults[s.db.userVar] : undefined;
    if (v && /^[A-Za-z0-9_.@\\-]{1,128}$/.test(v)) return { user: v, from: `${s.name} ${s.db.userVar}` };
  }
  return undefined;
}

/**
 * The login the harness's own sqlcmd uses: `verify.db.user` when set; else,
 * when a password variable is present, the services' example login (a SQL
 * login needs both); else none, which is integrated (Windows) authentication.
 */
export function defaultLogin(login: DbLogin, services: ServiceEntry[], env: NodeJS.ProcessEnv): { login: DbLogin; note?: string } {
  if (login.user) return { login };
  const pw = passwordEnvName(login, env);
  if (!pw) return { login };
  const ex = exampleDbUser(services);
  if (!ex) return { login };
  return { login: { ...login, user: ex.user }, note: `database login ${ex.user}: the example value of ${ex.from}, with the password from ${pw} (verify.db.user is not set; \`harness config set verify.db.user <login>\` changes it)` };
}

/** Values of the secret variables a service needs (read from the environment, never stored). */
export function secretValues(s: ServiceEntry, names: string[], db: { host: string; port?: string; database: string; user?: string } | null, password: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!db || password === undefined) return out;
  for (const n of names) {
    if (n === s.db.passwordVar) out[n] = password;
    else if (n === s.db.urlVar) out[n] = `Server=${db.host}${db.port ? ',' + db.port : ''};Database=${db.database};User Id=${db.user ?? ''};Password=${password};TrustServerCertificate=true`;
  }
  return out;
}

export async function launch(ctx: VerifyContext, o: LaunchOptions = {}): Promise<LaunchResult> {
  const t0 = Date.now();
  const lines: string[] = [];
  if (!ctx.repoRoot || !ctx.repoId) return { code: 2, lines: ['harness verify launch needs a git repository: run it inside one, or pass --repo <path>.'] };
  const existing = loadRun(ctx.repoId, ctx.taskId);
  if (existing && existing.status !== 'cleaned' && existing.status !== 'stopped') {
    return { code: 1, lines: [`A verify run (${existing.runId}) is already up for task ${ctx.taskId}. Use it (\`harness verify doctor\`), or stop it first with \`harness verify cleanup\`.`] };
  }
  const cfg: HarnessConfig = ctx.config;
  const vcfg = ctx.vcfg;
  const env = o.env ?? process.env;

  // 1. Inventory (re-derived on every launch).
  const map = buildFeatureMap({ workspaceRoot: ctx.workspaceRoot, extraRepos: cfg.repos.map((r) => r.path), migrationsOverride: vcfg.db?.migrations });
  saveFeatureMap(ctx.repoId, map);
  const wanted = o.services?.length ? o.services : defaultServices(ctx, map);
  if (!wanted.length) return { code: 2, lines: [`No service to start: no package with a start or dev script was found for this repository under ${ctx.workspaceRoot}. Name them with --services a,b.`], map };
  const { order, missing } = withNeeds(map, wanted);
  if (missing.length) return { code: 2, lines: [`Unknown service(s): ${missing.join(', ')}. Known: ${map.services.map((s) => s.name).join(', ') || 'none'}.`], map };
  const byName = new Map(map.services.map((s) => [s.name, s]));
  const services = order.map((n) => byName.get(n)!);
  const entry = wanted[0];

  // 2. Database plan (the DB rail first: nothing starts while the allowlist would refuse).
  const runId = newRunId();
  const needsDb = !o.noDb && (services.some((s) => s.db.nameVar || s.db.serverVar || s.db.urlVar) || services.some((s) => map.migrations.some((m) => m.service === s.name)));
  let plan: DbPlan | undefined;
  if (needsDb) {
    const pr = planDb({ vcfg, db: cfg.db, runId, env });
    if (!pr.ok || !pr.plan) return { code: pr.rail ? 4 : 1, lines: [`Refused: ${pr.reason}`], map };
    plan = pr.plan;
    const dl = defaultLogin(plan.login, services, env);
    if (dl.note) {
      plan.login = dl.login;
      map.notes.push(dl.note);
    }
  }

  // 3. Ports.
  const dir = runFolder(ctx.repoId, ctx.taskId);
  const ports = await allocatePorts({ runId, repoId: ctx.repoId, taskId: ctx.taskId }, { count: services.length + (o.dbUnreachable ? 1 : 0), base: vcfg.portBase ?? 20000 });
  if (!ports) return { code: 1, lines: ['No free port range was found; free some ports or set verify.portBase.'], map };

  const runRec: VerifyRun = {
    version: 1,
    runId,
    repoId: ctx.repoId,
    taskId: ctx.taskId,
    repoRoot: ctx.repoRoot,
    workspaceRoot: ctx.workspaceRoot,
    entry,
    services: [],
    ports,
    createdAt: new Date().toISOString(),
    status: 'launching',
    notes: [...map.notes],
  };
  // --db-unreachable: the last port of the range is reserved and nothing listens on it.
  const deadPort = o.dbUnreachable ? ports[services.length] : undefined;
  if (deadPort !== undefined) {
    runRec.dbUnreachable = true;
    runRec.unreachablePort = deadPort;
    runRec.notes.push(`database deliberately unreachable (--db-unreachable): the services were told their database is at 127.0.0.1,${deadPort}, where nothing listens`);
  }
  saveRun(runRec);

  // 4. Database.
  let dbVals: { host: string; port?: string; database: string; user?: string } | null = plan ? { host: plan.host, port: plan.port, database: plan.database, user: plan.login.user } : null;
  if (plan) {
    const sharing = schemaServices(map, services.map((s) => s.name));
    const { migrations } = orderedMigrations(map, sharing);
    const repoRoots: Record<string, string> = {};
    const bases: Record<string, string | null> = {};
    const brief = ctx.taskId !== 'adhoc' ? loadBrief(ctx.taskId) : null;
    for (const s of sharing) {
      repoRoots[s.name] = s.repoRoot;
      bases[s.name] = brief?.baseShas?.[s.repoId] ?? headSha(s.repoRoot);
    }
    const seedRepos = [...new Set([ctx.repoRoot, ...sharing.map((s) => s.repoRoot)])];
    const seeds = plan.snapshot ? [] : findSeeds(vcfg, ctx.repoRoot, seedRepos);
    const b = await buildRunDb({ plan, migrations, repoRoots, bases, seeds, env, migrateAfterSnapshot: o.noMigrate ? false : vcfg.db?.migrateAfterSnapshot });
    runRec.db = b.db;
    runRec.notes.push(...b.notes);
    if (!b.ok) {
      runRec.status = 'partial';
      saveRun(runRec);
      lines.push(`Database: ${b.error}`);
      lines.push('Nothing was started. Run `harness verify cleanup` to drop what was created, fix the cause, then launch again.');
      return { code: 1, lines, run: runRec, map };
    }
  }

  // What the services are told about their database. With --db-unreachable it is the dead port;
  // the harness's own sqlcmd (plan) still reaches the real run database.
  // Only the entry and touched services get the dead port; dependency services keep the real run database.
  const realVals = dbVals;
  const deadVals = deadPort !== undefined ? { host: '127.0.0.1', port: String(deadPort), database: plan?.database ?? `test_${runId}`, user: plan?.login.user } : null;
  const roleOf = (n: string): ServiceRun['role'] => (n === entry ? 'entry' : wanted.includes(n) ? 'touched' : 'dependency');
  if (deadVals) {
    dbVals = deadVals;
    runRec.unreachableServices = services.filter((s) => roleOf(s.name) !== 'dependency').map((s) => s.name);
    const dep = services.filter((s) => roleOf(s.name) === 'dependency').map((s) => s.name);
    runRec.notes.push(`--db-unreachable: the dead port went to ${runRec.unreachableServices.join(', ') || 'no service'}${dep.length ? `; dependency service(s) ${dep.join(', ')} keep the real run database` : ''}`);
    saveRun(runRec);
  }

  // 5. run.env (no secrets) and the per-service environment.
  const urls: Record<string, string> = {};
  services.forEach((s, i) => (urls[s.name] = `http://127.0.0.1:${ports[i]}`));
  const runVars: Record<string, string> = { RUN_ID: runId, BASE_URL: urls[entry] ?? urls[services[services.length - 1].name] };
  for (const s of services) {
    runVars[`BASE_URL_${envStem(s.name)}`] = urls[s.name];
    runVars[`PORT_${envStem(s.name)}`] = String(ports[services.indexOf(s)]);
  }
  if (dbVals) {
    runVars.DB_SERVER = dbVals.host;
    if (dbVals.port) runVars.DB_PORT = dbVals.port;
    runVars.DB_NAME = dbVals.database;
    if (dbVals.user) runVars.DB_USER = dbVals.user;
  }
  for (const s of services) for (const [v, target] of Object.entries(s.needs)) if (urls[target] && !(v in runVars)) runVars[v] = urls[target];
  writeTextAtomic(runEnvPath(dir), renderPosix(runVars, [`harness verify run ${runId} (task ${ctx.taskId}); no secrets are written here`]));

  // 6. Start services, dependencies first.
  const overlay = loadOverlay(ctx.repoId).overlay;
  const pwName = plan ? passwordEnvName(plan.login, env) : undefined;
  const password = pwName ? env[pwName] : undefined;
  let allReady = true;
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    const port = ports[i];
    const ov = overlay.services?.[s.name];
    const script = pickScript(s.scripts, ov?.start);
    const svcVals = deadVals && roleOf(s.name) === 'dependency' ? realVals : dbVals;
    const se = serviceEnv(s, port, urls, svcVals, { ...(ov?.env ?? {}) });
    runRec.notes.push(...se.notes);
    const rec: ServiceRun = {
      name: s.name,
      repoId: s.repoId,
      path: s.dir,
      envName: s.envName,
      role: roleOf(s.name),
      port,
      baseUrl: urls[s.name],
      script: script ?? undefined,
      logFile: path.join('logs', `${s.name}.log`),
      health: ov?.health ?? s.health,
      ready: false,
      launchEnv: Object.fromEntries(Object.entries(se.env).filter(([k]) => !/pass|secret|token|key|credential/i.test(k))),
      secretEnvNames: se.secretNames,
    };
    runRec.services.push(rec);
    if (!script) {
      rec.error = 'no dev or start script';
      allReady = false;
      continue;
    }
    if (plan && se.secretNames.length && password === undefined) runRec.notes.push(`${s.name}: ${se.secretNames.join(', ')} not given (no password in ${pwName ?? plan.login.passwordEnv ?? 'the environment'})`);
    const st = startService({ name: s.name, repoRoot: s.repoRoot, dir: s.dir, script, env: se.env, secretEnv: secretValues(s, se.secretNames, svcVals, password), logFile: path.join(dir, rec.logFile) });
    if (!st.ok) {
      rec.error = st.error;
      allReady = false;
      saveRun(runRec);
      continue;
    }
    rec.pid = st.pid;
    rec.command = st.command;
    rec.startedAt = new Date().toISOString();
    saveRun(runRec);
    const r = await waitReady({ port, baseUrl: rec.baseUrl, health: rec.health, pid: st.pid, anyStatus: deadPort !== undefined, timeoutMs: o.readyTimeoutMs ?? ov?.readyTimeoutMs ?? vcfg.readyTimeoutMs ?? 90_000 });
    rec.ready = r.ready;
    rec.readyMs = r.ms;
    if (!r.ready) {
      rec.error = r.error;
      allReady = false;
    }
    saveRun(runRec);
  }

  // 7. Pointers from the other repositories of a cross-repo run.
  for (const rid of new Set(services.map((s) => s.repoId))) {
    if (rid === ctx.repoId) continue;
    try {
      writeJson(pointerPath(rid, ctx.taskId), { repoId: ctx.repoId, taskId: ctx.taskId, runId });
    } catch {
      /* invalid id: skip */
    }
  }

  runRec.status = allReady ? 'launched' : 'partial';
  runRec.launchMs = Date.now() - t0;
  saveRun(runRec);
  if (!allReady && !runRec.services.some((s) => s.ready)) releasePorts(runId);
  instrument({ event: 'verify.launch', repo: ctx.repoId, task: ctx.taskId, ids: { runId }, counts: { dbUnreachable: deadPort !== undefined ? 1 : 0, services: services.length, ready: runRec.services.filter((s) => s.ready).length, migrations: runRec.db?.migrations.length ?? 0, changedMigrations: runRec.db?.migrations.filter((m) => m.changed).length ?? 0, launchMs: runRec.launchMs } });

  lines.push(`Run ${runId} for task ${ctx.taskId} (${runRec.launchMs} ms)`);
  if (runRec.db) {
    const d = runRec.db;
    lines.push(`Database: ${d.database} on ${d.server} (${d.source}${d.source === 'migrations' ? `: ${d.migrations.length} migration(s) from ${d.schemaServices.join(', ') || 'no service'}` : ''}; seed: ${d.seed ?? 'no seed'})`);
    const after = d.migrations.filter((m) => m.afterSnapshot);
    if (after.length) lines.push(`Migrations applied after the snapshot: ${after.map((m) => `${m.service}/${m.id}${m.changed ? ' (changed)' : ''}`).join(', ')}`);
    else if (d.source === 'snapshot' && !d.migrationsSkipped) lines.push('Migrations applied after the snapshot: none (the snapshot already holds every migration of this work)');
    const ch = d.migrations.filter((m) => m.changed);
    if (ch.length) lines.push(`Shared-schema changes in this work: ${ch.map((m) => `${m.service}/${m.id}`).join(', ')} (recorded in every artefact)`);
  } else lines.push('Database: none (the started services declare no database)');
  if (deadPort !== undefined) lines.push(`Database deliberately unreachable (--db-unreachable): the services' database variables point at 127.0.0.1,${deadPort}, where nothing listens, for ${runRec.unreachableServices?.join(', ') || 'no service'}${runRec.services.some((x) => x.role === 'dependency') ? '; dependency services keep the real run database' : ''}. Drive the route that must still answer.`);
  for (const s of runRec.services) {
    const tail = s.ready ? `ready in ${s.readyMs} ms${s.health ? ` (${s.health})` : ' (port open)'}` : `NOT ready: ${s.error ?? 'unknown'}`;
    lines.push(`  ${s.name} [${s.role}] ${s.baseUrl}  ${s.script ? `npm script "${s.script}"` : ''}  ${tail}`);
    if (!s.ready && s.pid) for (const l of logTail(path.join(dir, s.logFile), 6)) lines.push(`      | ${l}`);
  }
  for (const n of runRec.notes) lines.push(`Note: ${n}`);
  lines.push(`run.env: ${runEnvPath(dir)}  (\`harness verify env\` prints it; \`--powershell\` for PowerShell)`);
  lines.push(allReady ? 'Next: harness verify doctor, then the brief\'s `harness verify drive` / `harness verify db` lines.' : 'Some services are not ready: read their logs under the run folder, fix, then `harness verify cleanup` and launch again.');
  return { code: allReady ? 0 : 1, lines, run: runRec, map };
}
