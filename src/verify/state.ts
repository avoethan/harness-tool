/**
 * Where `harness verify` keeps its state, and the run record.
 *
 *   ~/.harness/runs/<repoId>/<taskId>/verify.json     VerifyRun (this file's type)
 *   ~/.harness/runs/<repoId>/<taskId>/run.env         KEY=value lines for the run (no password)
 *   ~/.harness/runs/<repoId>/<taskId>/logs/<svc>.log  service output (never read into the instrumentation log)
 *   ~/.harness/runs/<repoId>/<taskId>/e2e/<id>.json   artefacts (http, db)
 *   ~/.harness/runs/<otherRepoId>/<taskId>/verify-run.json  pointer to the owning run (cross-repo runs)
 *   ~/.harness/runs/<repoId>/feature-map.json         generated inventory (re-derived on every launch)
 *   ~/.harness/featuremap/<repoId>/overlay.json       hand-written overlay (recipes, gotchas), read by the gate's map-drift step
 *   ~/.harness/state/verify-ports.json                port reservations of live runs
 *
 * Nothing is ever written inside a repository.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessConfig, VerifyConfig } from '../types';
import { readJsonOr, readTextOr, writeJson } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { harnessHome, runsDir, stateDir, subPath } from '../lib/paths';
import { repoIdFor, resolveConfig } from '../lib/config';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export function validId(s: string): boolean {
  return ID_RE.test(s) && !s.includes('..');
}

/** Run ids are short and lower-case so `test_<runId>` is a safe SQL Server identifier. */
export const RUN_ID_RE = /^[a-z0-9]{6,16}$/;
export const RUN_DB_RE = /^test_[a-z0-9]{6,16}$/;

export function runDbName(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}`);
  return `test_${runId}`;
}

export function newRunId(now: Date = new Date()): string {
  const t = now.getTime().toString(36).slice(-5);
  const r = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `r${t}${r}`;
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

export interface ServiceRun {
  name: string;
  repoId: string;
  path: string;
  /** Upper-case env stem: `orders-api` -> `ORDERS_API`. */
  envName: string;
  role: 'entry' | 'touched' | 'dependency';
  port: number;
  baseUrl: string;
  script?: string;
  /** argv the service was started with (no secrets in it). */
  command?: string[];
  pid?: number;
  /** Relative to the run folder. */
  logFile: string;
  health?: string;
  startedAt?: string;
  readyMs?: number;
  ready: boolean;
  /** Non-secret variables given to the process (name -> value). */
  launchEnv: Record<string, string>;
  /** Names of secret variables given to the process (values never stored). */
  secretEnvNames: string[];
  error?: string;
}

export interface AppliedMigration {
  service: string;
  id: string;
  /** Path relative to the service's repository. */
  file: string;
  sha256: string;
  /** Added or changed in the working tree or since the base commit (a shared-schema change). */
  changed?: boolean;
  /** Applied to a restored snapshot because the snapshot did not hold it. */
  afterSnapshot?: boolean;
}

export interface RunDb {
  /** `host[,port]` the services connect to. */
  server: string;
  host: string;
  port?: string;
  database: string;
  mode: 'per-run' | 'existing';
  transport: 'local' | 'docker';
  container?: string;
  user?: string;
  passwordEnv?: string;
  created: boolean;
  source: 'migrations' | 'snapshot' | 'existing';
  snapshot?: string;
  /** Seed script applied, or null when there was none (said so at launch). */
  seed: string | null;
  /** Absolute paths of the seed scripts applied. */
  seedFiles?: string[];
  /** Server-side copy-only backup made for a `db:` snapshot (removed at cleanup when possible). */
  backupFile?: string;
  /** sqlcmd inside the container (docker transport). */
  containerSqlcmd?: string;
  migrations: AppliedMigration[];
  /** Services whose migrations make up the shared schema, in apply order. */
  schemaServices: string[];
  /** The snapshot was restored and the migrations it lacks were deliberately not applied (--no-migrate or verify.db.migrateAfterSnapshot false). */
  migrationsSkipped?: boolean;
  dropped?: boolean;
}

export interface VerifyRun {
  version: 1;
  runId: string;
  repoId: string;
  taskId: string;
  repoRoot: string;
  workspaceRoot: string;
  entry: string;
  services: ServiceRun[];
  db?: RunDb;
  ports: number[];
  createdAt: string;
  launchMs?: number;
  status: 'launching' | 'launched' | 'partial' | 'stopped' | 'cleaned';
  notes: string[];
  /** The services were started with their database variables pointing at a port nothing listens on (`--db-unreachable`). */
  dbUnreachable?: boolean;
  /** The reserved loopback port that nothing listens on. */
  unreachablePort?: number;
  /** The services (roles entry and touched) that were given the unreachable port; dependency services keep the real run database. */
  unreachableServices?: string[];
  /** The last HTTP response body (redacted, capped), for `{{last.<path>}}` templates. */
  last?: { status: number; body: unknown; at: string };
}

export function runFolder(repoId: string, taskId: string): string {
  if (!validId(repoId) || !validId(taskId)) throw new Error('invalid repo or task id');
  return path.join(runsDir(), repoId, taskId);
}

export function runStatePath(repoId: string, taskId: string): string {
  return path.join(runFolder(repoId, taskId), 'verify.json');
}

export function runEnvPath(dir: string): string {
  return path.join(dir, 'run.env');
}

export function e2eDir(dir: string): string {
  return path.join(dir, 'e2e');
}

export function pointerPath(repoId: string, taskId: string): string {
  return path.join(runFolder(repoId, taskId), 'verify-run.json');
}

export function featureMapPath(repoId: string): string {
  if (!validId(repoId)) throw new Error('invalid repo id');
  return path.join(runsDir(), repoId, 'feature-map.json');
}

/** The overlay the gate reads (`featuremap/<repoId>/overlay.json`). */
export function overlayPath(repoId: string): string {
  if (!validId(repoId)) throw new Error('invalid repo id');
  return path.join(harnessHome(), 'featuremap', repoId, 'overlay.json');
}

/** Older spelling of the overlay location; read when the gate's location has none. */
export function legacyOverlayPath(repoId: string): string {
  return path.join(harnessHome(), 'verify', repoId, 'overlay.json');
}

export function portsPath(): string {
  return path.join(stateDir(), 'verify-ports.json');
}

export function loadRun(repoId: string, taskId: string): VerifyRun | null {
  let p: string;
  try {
    p = runStatePath(repoId, taskId);
  } catch {
    return null;
  }
  const r = readJsonOr<VerifyRun | null>(p, null);
  if (r && r.version === 1 && typeof r.runId === 'string') return r;
  // A pointer from another repository of a cross-repo run.
  const ptr = readJsonOr<{ repoId?: string; taskId?: string } | null>(pointerPath(repoId, taskId), null);
  if (ptr && ptr.repoId && ptr.taskId && validId(ptr.repoId) && validId(ptr.taskId) && ptr.repoId !== repoId) {
    const o = readJsonOr<VerifyRun | null>(runStatePath(ptr.repoId, ptr.taskId), null);
    if (o && o.version === 1) return o;
  }
  return null;
}

export function saveRun(r: VerifyRun): void {
  writeJson(runStatePath(r.repoId, r.taskId), r);
}

export function runDirOf(r: Pick<VerifyRun, 'repoId' | 'taskId'>): string {
  return runFolder(r.repoId, r.taskId);
}

// ---------------------------------------------------------------------------
// Context: which repository, task and workspace a command works on
// ---------------------------------------------------------------------------

export interface VerifyContext {
  cwd: string;
  repoRoot: string | null;
  repoId: string | null;
  taskId: string;
  taskSource: 'flag' | 'current-task' | 'adhoc';
  workspaceRoot: string;
  config: HarnessConfig;
  vcfg: VerifyConfig;
}

export function currentTaskOf(repoId: string): string | null {
  if (!validId(repoId)) return null;
  const t = (readTextOr(path.join(runsDir(), repoId, 'current-task'), '') ?? '').trim();
  return t && validId(t) ? t : null;
}

export function resolveContext(opts: { cwd?: string; repo?: string; task?: string } = {}): VerifyContext {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const start = opts.repo ? path.resolve(cwd, opts.repo) : cwd;
  const repoRoot = nearestRepoRoot(start);
  const { config } = resolveConfig(repoRoot ?? cwd);
  const repoId = repoRoot ? repoIdFor(repoRoot) : null;
  let taskId = 'adhoc';
  let taskSource: VerifyContext['taskSource'] = 'adhoc';
  if (opts.task) {
    if (!validId(opts.task)) throw new Error(`invalid task id ${JSON.stringify(opts.task.slice(0, 40))}`);
    taskId = opts.task;
    taskSource = 'flag';
  } else if (repoId) {
    const cur = currentTaskOf(repoId);
    if (cur) {
      taskId = cur;
      taskSource = 'current-task';
    }
  }
  let workspaceRoot: string;
  const cfgRoot = config.workspaceRoot ? path.resolve(config.workspaceRoot) : '';
  if (repoRoot) {
    if (cfgRoot && subPath(cfgRoot, repoRoot) && cfgRoot !== repoRoot) workspaceRoot = cfgRoot;
    else if (cfgRoot === repoRoot && config.setting === 'personal') workspaceRoot = repoRoot;
    else workspaceRoot = path.dirname(repoRoot);
  } else {
    workspaceRoot = cfgRoot && subPath(cfgRoot, start) ? cfgRoot : start;
  }
  return { cwd, repoRoot, repoId, taskId, taskSource, workspaceRoot, config, vcfg: config.verify ?? {} };
}

/** Folder names of the run folder's artefacts, newest first. */
export function listRunDirs(repoId: string): string[] {
  try {
    return fs
      .readdirSync(path.join(runsDir(), repoId), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
