/**
 * Acceptance: `harness verify` end to end on the team stand-in workspace and a
 * local SQL Server container.
 *
 * Environment (see test/acceptance/README.md); the test skips with the reason
 * when one is missing:
 *   HARNESS_STANDIN_TEAM             the stand-in folder (setup.js, db/seed.sql)
 *   HARNESS_STANDIN_TEAM_WORKSPACE   a workspace setup.js already created and installed (else one is created)
 *   HARNESS_STANDIN_INSTALL=1        let setup.js run `npm ci` when it creates the workspace
 *   HARNESS_STANDIN_DB_PASSWORD      password of the throw-away test container's login (never written anywhere)
 *   HARNESS_STANDIN_DB_USER          login (default sa)
 *   HARNESS_STANDIN_DB_CONTAINER     the container (default: the only running SQL Server container)
 *   HARNESS_ACCEPTANCE_OUT           append one JSON line with the measured numbers
 *
 * Steps: mark the container as a test server in a temp HARNESS_HOME
 * (`harness db mark`), `verify launch` catalog-api and orders-api with a
 * per-run database built from the migrations and the stand-in's seed,
 * `verify doctor` (passes and reports the database), the cross-service
 * POST /orders recipe from the overlay (orders-api calls catalog-api; the
 * recipe also asserts the order row and the stock change), a GET, a
 * `verify db` row assertion, `verify evidence` (all fresh, and the gate's
 * own reader counts them), `verify map build` (the routes the stand-in lists),
 * `verify cleanup` (the database is gone, checked with sqlcmd; ports free).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { sqlServerContainers } from '../../src/verify/sqlcmd';
import { probePort } from '../../src/verify/ports';
import { e2eOutcome, listArtefacts } from '../../src/gate/e2e';
import { writeTree } from '../../src/lib/git';
import { loadConfig, saveConfig, repoIdFor } from '../../src/lib/config';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');

// The routes the stand-in README counts (15 route registrations), with their mount prefixes.
const STANDIN_ROUTES = [
  'catalog-api GET /health',
  'catalog-api GET /products',
  'catalog-api GET /products/:id',
  'catalog-api PATCH /products/:id/stock',
  'catalog-api POST /products',
  'fulfillment GET /health',
  'fulfillment GET /shipments',
  'fulfillment GET /shipments/:id',
  'fulfillment POST /shipments/:id/dispatch',
  'orders-api GET /health',
  'orders-api GET /orders',
  'orders-api GET /orders/:id',
  'orders-api POST /orders',
  'orders-api POST /orders/:id/cancel',
  'orders-api POST /orders/:id/pay',
];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

test('verify on the team stand-in: launch two services with a per-run database, doctor, drive, db, evidence, map, cleanup', async (t) => {
  const standin = process.env.HARNESS_STANDIN_TEAM;
  if (!standin) return t.skip('HARNESS_STANDIN_TEAM is not set (path to the team stand-in folder; see test/acceptance/README.md)');
  if (!fs.existsSync(path.join(standin, 'setup.js')) || !fs.existsSync(path.join(standin, 'db', 'seed.sql'))) return t.skip(`HARNESS_STANDIN_TEAM=${standin} has no setup.js or db/seed.sql`);
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI} (run npm run build)`);
  if (!which('git')) return t.skip('git is not available on PATH');
  const password = process.env.HARNESS_STANDIN_DB_PASSWORD;
  if (!password) return t.skip('HARNESS_STANDIN_DB_PASSWORD is not set (the login password of the throw-away SQL Server test container)');
  const docker = which('docker');
  if (!docker) return t.skip('docker is not available on PATH (the SQL Server test container runs in Docker)');
  if (run(docker, ['info'], { timeoutMs: 20_000 }).code !== 0) return t.skip('the Docker daemon is not reachable');
  const containers = sqlServerContainers(docker);
  const wantName = process.env.HARNESS_STANDIN_DB_CONTAINER;
  const container = wantName ? containers.find((c) => c.name === wantName) : containers.length === 1 ? containers[0] : undefined;
  if (!container) return t.skip(wantName ? `the container ${wantName} is not running a SQL Server image` : `${containers.length} SQL Server containers are running; set HARNESS_STANDIN_DB_CONTAINER`);
  if (!container.hostPorts.length) return t.skip(`the container ${container.name} publishes no port for 1433`);
  const user = process.env.HARNESS_STANDIN_DB_USER ?? 'sa';

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acc-verify-')));
  const home = path.join(tmp, 'home', '.harness');
  fs.mkdirSync(home, { recursive: true });
  const saved = { home: process.env.HARNESS_HOME, user: process.env.HARNESS_USER_HOME };
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_USER_HOME = path.dirname(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: home, HARNESS_USER_HOME: path.dirname(home), HARNESS_NO_INSTRUMENT: '1', HARNESS_STANDIN_DB_PASSWORD: password };
  let ordersDir = '';
  const cli = (args: string[], timeoutMs = 300_000): CliResult => {
    const t0 = Date.now();
    const r = run(process.execPath, [CLI, ...args], { cwd: ordersDir || tmp, env, timeoutMs });
    return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
  };
  let launched = false;
  try {
    // 1. The workspace (installed: the services start with their own dev script).
    let ws = process.env.HARNESS_STANDIN_TEAM_WORKSPACE;
    if (!ws) {
      ws = path.join(tmp, 'workspace');
      const install = process.env.HARNESS_STANDIN_INSTALL === '1';
      const s = run(process.execPath, [path.join(standin, 'setup.js'), ws, '--no-db', '--harness-home', path.join(tmp, 'rough-home'), ...(install ? [] : ['--no-install'])], { timeoutMs: 1_200_000 });
      assert.equal(s.code, 0, `setup.js failed: ${s.stderr.slice(-800)}`);
    }
    ws = fs.realpathSync(ws);
    const installed = ['catalog-api', 'orders-api'].every((r) => fs.existsSync(path.join(ws!, r, 'node_modules', 'express')));
    if (!installed) return t.skip('the workspace has no node_modules, so the services cannot start (set HARNESS_STANDIN_INSTALL=1 or HARNESS_STANDIN_TEAM_WORKSPACE to an installed workspace)');
    ordersDir = path.join(ws, 'orders-api');
    const treeBefore = writeTree(ordersDir);

    // 2. Mark the container as a test server; verify settings name the password variable only.
    const mark = cli(['db', 'mark', '--server', container.name, '--test']);
    assert.equal(mark.code, 0, `db mark failed: ${mark.stderr}`);
    const cfg = loadConfig()!;
    cfg.workspaceRoot = ws;
    cfg.verify = { db: { user, passwordEnv: 'HARNESS_STANDIN_DB_PASSWORD', container: container.name, seed: path.join(standin, 'db', 'seed.sql') }, readyTimeoutMs: 90_000 };
    saveConfig(cfg);
    assert.ok(!fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes(password), 'the password is never in the config');

    // 3. Launch.
    const launch = cli(['verify', 'launch', '--services', 'orders-api,catalog-api', '--json']);
    launched = true;
    assert.equal(launch.code, 0, `launch failed:\n${launch.stdout}\n${launch.stderr}`);
    const lj = JSON.parse(launch.stdout) as { run: { runId: string; launchMs: number; db: { database: string; migrations: unknown[]; seed: string | null }; services: Array<{ name: string; ready: boolean; baseUrl: string; port: number }> } };
    const runRec = lj.run;
    const dbName = runRec.db.database;
    assert.match(dbName, /^test_[a-z0-9]+$/);
    assert.equal(runRec.services.length, 2);
    assert.ok(runRec.services.every((s) => s.ready));
    t.diagnostic(`launch: ${runRec.launchMs} ms inside the command (${launch.ms} ms wall), database ${dbName}: ${runRec.db.migrations.length} migrations, seed ${runRec.db.seed}`);
    const repoId = repoIdFor(ordersDir);
    const runDir = path.join(home, 'runs', repoId, 'adhoc');
    const runEnv = fs.readFileSync(path.join(runDir, 'run.env'), 'utf8');
    assert.ok(!runEnv.includes(password), 'run.env holds no password');
    assert.match(runEnv, new RegExp(`^DB_NAME=${dbName}$`, 'm'));
    assert.match(runEnv, /^CATALOG_URL=http:\/\/127\.0\.0\.1:\d+$/m);

    // 4. Doctor: passes and reports the database each service uses.
    const doc = cli(['verify', 'doctor', '--json']);
    assert.equal(doc.code, 0, `doctor failed:\n${doc.stdout}\n${doc.stderr}`);
    const dj = JSON.parse(doc.stdout) as { databases: Record<string, { name: string; how: string }>; checks: Array<{ name: string; status: string }> };
    assert.equal(dj.databases['orders-api'].name, dbName);
    assert.equal(dj.databases['catalog-api'].name, dbName);
    t.diagnostic(`doctor: ${dj.checks.length} checks ok; orders-api uses ${dj.databases['orders-api'].name} (${dj.databases['orders-api'].how})`);

    // 5. The cross-service recipe: POST /orders (orders-api asks catalog-api for prices and stock).
    const add = cli(['verify', 'maintain', '--add-missing', '--json']);
    assert.equal(add.code, 0, add.stderr);
    const overlayFile = path.join(home, 'featuremap', repoId, 'overlay.json');
    const ov = JSON.parse(fs.readFileSync(overlayFile, 'utf8')) as { entries: Record<string, Record<string, unknown>> };
    ov.entries['POST /orders'].recipe = {
      body: { customerEmail: 'e2e-{{runId}}@example.com', items: [{ productId: 2, quantity: 1 }] },
      expectStatus: 201,
      expect: { 'order.status': 'pending', 'order.total_cents': 3499 },
      db: [
        { table: 'orders', where: { id: '{{last.order.id}}' }, expect: { status: 'pending', total_cents: 3499 } },
        { table: 'products', where: { id: 2 }, expect: { stock: 9 } },
      ],
    };
    fs.writeFileSync(overlayFile, JSON.stringify(ov, null, 2));
    const post = cli(['verify', 'drive', 'POST /orders', '--criterion', 'AC1', '--json']);
    assert.equal(post.code, 0, `POST /orders failed:\n${post.stdout}\n${post.stderr}`);
    const pj = JSON.parse(post.stdout) as { artefact: { status: number; body: { order: { id: number } }; assertions: Array<{ kind: string; pass: boolean }> } };
    assert.equal(pj.artefact.status, 201);
    assert.ok(pj.artefact.assertions.some((a) => a.kind.startsWith('db:products') && a.pass), 'the stock change on the shared schema is asserted');
    const orderId = pj.artefact.body.order.id;

    // 6. A GET, and a DB row assertion.
    const get = cli(['verify', 'drive', '--method', 'GET', '--path', '/orders/:id', '--param', `id=${orderId}`, '--expect-status', '200', '--expect-body', 'total', '--criterion', 'AC2']);
    assert.equal(get.code, 0, `GET failed:\n${get.stdout}\n${get.stderr}`);
    const db = cli(['verify', 'db', '--table', 'orders', '--where', `id=${orderId}`, '--expect', 'status=pending', '--expect', 'total_cents=3499', '--criterion', 'AC3', '--json']);
    assert.equal(db.code, 0, `verify db failed:\n${db.stdout}\n${db.stderr}`);
    const dbj = JSON.parse(db.stdout) as { artefact: { rows: Array<Record<string, unknown>>; columns: string[] } };
    assert.deepEqual(dbj.artefact.columns.sort(), ['id', 'status', 'total_cents']);
    assert.ok(!('customer_email' in dbj.artefact.rows[0]), 'only asserted columns are stored');
    const refused = cli(['verify', 'db', '--query', 'SELECT name FROM master.sys.databases']);
    assert.equal(refused.code, 4, 'a query outside the run database is refused');
    const failing = cli(['verify', 'drive', '--method', 'GET', '--path', `/orders/${orderId}`, '--expect-status', '404']);
    assert.equal(failing.code, 1, 'a failed assertion exits non-zero');

    // 7. Evidence: every artefact fresh; the gate's reader counts the criteria.
    const ev = cli(['verify', 'evidence', '--json']);
    assert.equal(ev.code, 0);
    const evj = JSON.parse(ev.stdout) as { fresh: number; stale: number; failed: number; rows: Array<{ id: string; fresh: boolean; pass: boolean | null }> };
    assert.equal(evj.stale, 0);
    const tree = writeTree(ordersDir)!;
    assert.equal(tree, treeBefore, 'verify wrote nothing inside the repository');
    for (const [id, kind] of [['AC1', 'http'], ['AC2', 'http'], ['AC3', 'db']] as const) {
      const out = e2eOutcome({ runDir, tree }, { id, text: '', kind: kind === 'db' ? 'db' : 'api' }, kind, listArtefacts(runDir));
      assert.equal(out.status, 'pass', `${id}: ${JSON.stringify(out)}`);
    }
    t.diagnostic(`evidence: ${evj.rows.length} artefacts (${evj.fresh} fresh, ${evj.stale} stale, ${evj.failed} recording a failure): ${evj.rows.map((r) => r.id).join(', ')}`);

    // 8. Feature map: the routes the stand-in lists.
    const mb = cli(['verify', 'map', 'build', '--json']);
    assert.equal(mb.code, 0);
    const mj = JSON.parse(mb.stdout) as { routes: Array<{ service: string; id: string }>; migrations: unknown[]; services: Array<{ name: string; needs: Record<string, string> }> };
    const found = mj.routes.map((r) => `${r.service} ${r.id}`).sort();
    assert.deepEqual(found, STANDIN_ROUTES);
    assert.deepEqual(mj.services.find((s) => s.name === 'orders-api')!.needs, { CATALOG_URL: 'catalog-api' });
    t.diagnostic(`map build: ${mj.routes.length} routes, ${mj.migrations.length} migrations, ${mj.services.length} services`);

    // 9. Cleanup: services stopped, the database dropped (checked with sqlcmd), evidence kept.
    const cl = cli(['verify', 'cleanup']);
    launched = false;
    assert.equal(cl.code, 0, `cleanup failed:\n${cl.stdout}\n${cl.stderr}`);
    const q = run(docker, ['exec', '-e', 'SQLCMDPASSWORD', container.name, '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', user, '-C', '-h', '-1', '-Q', `SET NOCOUNT ON; SELECT COUNT(*) FROM sys.databases WHERE name = N'${dbName}'`], { env: { ...process.env, SQLCMDPASSWORD: password }, timeoutMs: 30_000 });
    assert.equal(q.code, 0, q.stderr);
    assert.equal(q.stdout.trim(), '0', `${dbName} still exists after cleanup`);
    for (const s of runRec.services) assert.equal(await probePort(s.port), true, `port ${s.port} is free after cleanup`);
    const kept = listArtefacts(runDir);
    assert.equal(kept.length, evj.rows.length, 'the evidence is kept');
    const failedRecords = kept.filter((a) => a.passed === false).map((a) => a.id);
    assert.deepEqual(failedRecords, ['get-orders-id-http'], 'only the deliberate --expect-status 404 run records a failure');
    t.diagnostic(`cleanup: ${dbName} dropped (sqlcmd count 0), ${runRec.services.length} services stopped; artefacts kept: ${kept.length} (${failedRecords.length} records the deliberate failed assertion)`);
    if (process.env.HARNESS_ACCEPTANCE_OUT) {
      fs.appendFileSync(process.env.HARNESS_ACCEPTANCE_OUT, JSON.stringify({ test: 'verify-e2e', launchMs: runRec.launchMs, launchWallMs: launch.ms, artefacts: evj.rows.length, routes: mj.routes.length, migrations: runRec.db.migrations.length }) + '\n');
    }
  } finally {
    if (launched && ordersDir) cli(['verify', 'cleanup']);
    process.env.HARNESS_HOME = saved.home;
    process.env.HARNESS_USER_HOME = saved.user;
    if (saved.home === undefined) delete process.env.HARNESS_HOME;
    if (saved.user === undefined) delete process.env.HARNESS_USER_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
