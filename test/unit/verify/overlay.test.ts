import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FeatureMap, RouteEntry, MigrationEntry } from '../../../src/verify/featuremap';
import { acceptEntries, addMissing, drift, loadOverlay, maintainDiff, saveOverlay, type Overlay } from '../../../src/verify/overlay';
import { driftFor, readOverlay } from '../../../src/gate/mapdrift';
import { tempHome } from '../lifecycle/helpers';

function route(id: string, file: string, statuses: number[], localPath: string, fingerprint = id + statuses.join()): RouteEntry {
  const [method, p] = id.split(' ');
  return { id, method, path: p, localPath, service: 'orders-api', repoId: 'orders-api-1', file, line: 1, framework: 'express', statuses, fingerprint };
}

function mig(id: string, sha: string): MigrationEntry {
  return { id, service: 'orders-api', repoId: 'orders-api-1', file: `migrations/${id}.sql`, kind: 'sql', tables: ['orders'], references: [], sha256: sha };
}

function map(routes: RouteEntry[], migrations: MigrationEntry[]): FeatureMap {
  return {
    version: 1,
    generatedAt: '',
    workspaceRoot: '/w',
    services: [{ name: 'orders-api', repoId: 'orders-api-1', repoRoot: '/w/o', dir: '/w/o', envName: 'ORDERS_API', scripts: {}, envVars: [], envDefaults: {}, db: {}, needs: {}, routes: routes.length }],
    routes,
    migrations,
    tables: [],
    notes: [],
  };
}

test('maintain reports clean, changed, blocked and missing per entry, and never needs product code', () => {
  const m = map(
    [route('POST /orders', 'src/routes/orders.ts', [201, 400], '/', 'fp-new'), route('GET /orders/:id', 'src/routes/orders.ts', [200], '/:id', 'fp-get'), route('GET /health', 'src/routes/health.ts', [200], '/', 'fp-h')],
    [mig('0001_create-orders', 'sha-1'), mig('0002_add-total', 'sha-2b')],
  );
  const o: Overlay = {
    version: 1,
    entries: {
      'POST /orders': { kind: 'route', file: 'src/routes/orders.ts', fingerprint: 'fp-old', statuses: [201], recipe: { expectStatus: 201 } },
      'GET /orders/:id': { kind: 'route', file: 'src/routes/orders.ts', fingerprint: 'fp-get', statuses: [200] },
      'DELETE /orders/:id': { kind: 'route', file: 'src/routes/orders.ts', fingerprint: 'x' },
      'GET /health': { kind: 'route', file: 'src/routes/health.ts', fingerprint: 'fp-h', recipe: { auth: 'nobody' } },
      '0001_create-orders': { kind: 'migration', sha256: 'sha-1' },
      '0002_add-total': { kind: 'migration', sha256: 'sha-2a' },
    },
  };
  const items = maintainDiff(m, 'orders-api-1', o);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by['POST /orders'].outcome, 'changed');
  assert.match(by['POST /orders'].reasons.join(), /status codes in the handler changed: 201 -> 201,400/);
  assert.equal(by['GET /orders/:id'].outcome, 'clean');
  assert.equal(by['DELETE /orders/:id'].outcome, 'blocked');
  assert.equal(by['GET /health'].outcome, 'blocked', 'a recipe that signs in as an unknown user is blocked');
  assert.equal(by['0001_create-orders'].outcome, 'clean');
  assert.equal(by['0002_add-total'].outcome, 'changed');
  assert.equal(items.filter((i) => i.outcome === 'missing').length, 0);
  // accept records the current inventory facts
  assert.deepEqual(acceptEntries(m, 'orders-api-1', o, ['POST /orders']), ['POST /orders']);
  assert.equal(maintainDiff(m, 'orders-api-1', o).find((i) => i.id === 'POST /orders')!.outcome, 'clean');
});

test('drift lists route and migration ids without an entry; add-missing writes skeletons the gate accepts', () => {
  const h = tempHome('harness-verify-ov-');
  try {
    const m = map([route('POST /orders', 'src/routes/orders.ts', [201], '/'), route('GET /orders/:id', 'src/routes/orders.ts', [200], '/:id')], [mig('0003_add-orders-updated-at', 's')]);
    const empty = loadOverlay('orders-api-1');
    assert.equal(empty.exists, false);
    const d = drift(m, 'orders-api-1', empty.overlay, false);
    assert.deepEqual(d.routes, ['POST /orders', 'GET /orders/:id']);
    assert.deepEqual(d.migrations, ['0003_add-orders-updated-at']);
    assert.deepEqual(maintainDiff(m, 'orders-api-1', empty.overlay).map((i) => i.outcome), ['missing', 'missing', 'missing']);
    const added = addMissing(m, 'orders-api-1', empty.overlay, ['POST /orders', '0003_add-orders-updated-at']);
    assert.deepEqual(added, ['POST /orders', '0003_add-orders-updated-at']);
    const file = saveOverlay('orders-api-1', empty.overlay);
    assert.equal(file, path.join(h.harnessHome, 'featuremap', 'orders-api-1', 'overlay.json'));
    // The gate reads the same file and the same ids.
    const gateEntries = readOverlay('orders-api-1')!;
    assert.deepEqual(gateEntries.map((e) => e.id).sort(), ['0003_add-orders-updated-at', 'POST /orders']);
    const ctx = {
      diff: [
        { status: 'M', path: 'src/routes/orders.ts' },
        { status: 'A', path: 'migrations/0003_add-orders-updated-at.sql' },
      ],
      nowText: (p: string) => (p.endsWith('orders.ts') ? "ordersRouter.post('/', h);\nordersRouter.get('/:id', h);\n" : 'ALTER TABLE x ADD y INT;'),
    } as unknown as Parameters<typeof driftFor>[0];
    assert.deepEqual(driftFor(ctx, gateEntries).missing, ['GET /:id (src/routes/orders.ts)']);
    const again = loadOverlay('orders-api-1');
    addMissing(m, 'orders-api-1', again.overlay);
    saveOverlay('orders-api-1', again.overlay);
    assert.deepEqual(driftFor(ctx, readOverlay('orders-api-1')!).missing, []);
    assert.deepEqual(drift(m, 'orders-api-1', loadOverlay('orders-api-1').overlay).routes, []);
    assert.ok(fs.existsSync(file));
  } finally {
    h.cleanup();
  }
});
