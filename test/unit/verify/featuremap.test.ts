import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildFeatureMap,
  compareMigrations,
  extractRoutes,
  findRoute,
  joinRoute,
  matchPath,
  needsOf,
  orderMigrationFiles,
  orderSchemaServices,
  routesOfFiles,
  statusesIn,
  tablesOfSql,
  withNeeds,
  type MigrationEntry,
} from '../../../src/verify/featuremap';
import { defaultLogin, exampleDbUser } from '../../../src/verify/launch';
import { gitRepo, tempHome } from '../lifecycle/helpers';

test('exampleDbUser: the login the services declare in .env.example (a plain name only), else none', () => {
  const h = tempHome('harness-verify-user-');
  try {
    gitRepo(path.join(h.workspace, 'catalog-api'), {
      'package.json': JSON.stringify({ name: 'catalog-api', scripts: { dev: 'node src/server.js' } }),
      '.env.example': 'PORT=3001\nDB_SERVER=localhost\nDB_NAME=shop_test\nDB_USER=sa\nDB_PASSWORD=change-me\n',
      'src/app.ts': "import express from 'express';\nconst app = express();\n",
    });
    gitRepo(path.join(h.workspace, 'orders-api'), {
      'package.json': JSON.stringify({ name: 'orders-api', scripts: { start: 'node dist/server.js' } }),
      '.env.example': 'PORT=3002\nDB_NAME=shop_test\nDB_USER=$(whoami)\n',
      'src/app.ts': "import express from 'express';\nconst app = express();\n",
    });
    const map = buildFeatureMap({ workspaceRoot: h.workspace });
    const cat = map.services.find((s) => s.name === 'catalog-api')!;
    const ord = map.services.find((s) => s.name === 'orders-api')!;
    assert.deepEqual(exampleDbUser([cat]), { user: 'sa', from: 'catalog-api DB_USER' });
    assert.equal(exampleDbUser([ord]), undefined, 'a value that is not a plain login name is not taken');
    assert.equal(exampleDbUser([ord, cat])?.user, 'sa');
    // the default applies only with a password variable; without one the login stays integrated (Windows) authentication
    assert.equal(defaultLogin({}, [cat], {}).login.user, undefined);
    const withPw = defaultLogin({}, [cat], { HARNESS_VERIFY_DB_PASSWORD: 'x' });
    assert.equal(withPw.login.user, 'sa');
    assert.match(withPw.note ?? '', /example value of catalog-api DB_USER, with the password from HARNESS_VERIFY_DB_PASSWORD/);
    assert.deepEqual(defaultLogin({ user: 'tester' }, [cat], { DB_PASSWORD: 'x' }), { login: { user: 'tester' } }, 'verify.db.user wins');
  } finally {
    h.cleanup();
  }
});

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

const EXPRESS_APP = `import express from 'express';
import { ordersRouter } from './routes/orders';
import { healthRouter } from './routes/health';
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/health', healthRouter);
  app.use('/orders', ordersRouter);
  app.get('/version', (_req, res) => res.json({ v: 1 }));
  return app;
}
`;
const EXPRESS_ORDERS = `import { Router } from 'express';
import { badRequest } from '../lib/http-error';
export const ordersRouter = Router();
ordersRouter.get(
  '/',
  async (req, res) => {
    if (req.query.x) throw badRequest('x');
    res.json({ orders: [] });
  },
);
ordersRouter.post('/', async (req, res) => {
  res.status(201).json({ order: {} });
});
ordersRouter.post('/:id/pay', async (req, res) => {
  if (!req.params.id) return res.sendStatus(404);
  res.json({ ok: true });
});
const cache = new Map();
cache.get('/not-a-route');
`;
const EXPRESS_HEALTH = `import { Router } from 'express';
export const healthRouter = Router();
healthRouter.get('/', (_req, res) => res.json({ status: 'ok' }));
`;

test('Express: registrations with mount prefixes across files, statuses, no false routes', () => {
  const h = tempHome('harness-verify-fm-');
  try {
    const root = path.join(h.workspace, 'orders-api');
    put(root, { 'src/app.ts': EXPRESS_APP, 'src/routes/orders.ts': EXPRESS_ORDERS, 'src/routes/health.ts': EXPRESS_HEALTH, 'test/orders.test.ts': "app.get('/test-only', h)" });
    const files = ['src/app.ts', 'src/routes/orders.ts', 'src/routes/health.ts'].map((f) => path.join(root, f));
    const r = routesOfFiles(files, root);
    const ids = r.routes.map((x) => `${x.id} ${x.file}`).sort();
    assert.deepEqual(ids, [
      'GET /health src/routes/health.ts',
      'GET /orders src/routes/orders.ts',
      'GET /version src/app.ts',
      'POST /orders src/routes/orders.ts',
      'POST /orders/:id/pay src/routes/orders.ts',
    ]);
    const post = r.routes.find((x) => x.id === 'POST /orders')!;
    assert.deepEqual(post.statuses, [201]);
    assert.equal(post.line, 11);
    assert.deepEqual(r.routes.find((x) => x.id === 'POST /orders/:id/pay')!.statuses, [200, 404]);
    assert.deepEqual(r.routes.find((x) => x.id === 'GET /orders')!.statuses, [200, 400]);
  } finally {
    h.cleanup();
  }
});

test('Fastify: register prefix, route({ method, url }) and plugin parameters', () => {
  const h = tempHome('harness-verify-fm-');
  try {
    const root = path.join(h.workspace, 'catalog');
    put(root, {
      'src/server.ts': `import Fastify from 'fastify';\nimport { productRoutes } from './products';\nconst app = Fastify();\napp.register(productRoutes, { prefix: '/api/products' });\napp.get('/health', async () => ({ ok: true }));\n`,
      'src/products.ts': `import type { FastifyInstance } from 'fastify';\nexport async function productRoutes(fastify: FastifyInstance) {\n  fastify.get('/:id', async (req, reply) => { reply.code(404); });\n  fastify.route({ method: ['PUT', 'PATCH'], url: '/:id', handler: async () => ({}) });\n  fastify.post('/', async (req, reply) => reply.code(201).send({}));\n}\n`,
    });
    const r = routesOfFiles([path.join(root, 'src/server.ts'), path.join(root, 'src/products.ts')], root);
    assert.deepEqual(r.routes.map((x) => x.id).sort(), ['GET /api/products/:id', 'GET /health', 'PATCH /api/products/:id', 'POST /api/products', 'PUT /api/products/:id']);
    assert.ok(r.routes.find((x) => x.id === 'POST /api/products')!.statuses.includes(201));
    assert.equal(r.routes.find((x) => x.id === 'GET /health')!.framework, 'fastify');
  } finally {
    h.cleanup();
  }
});

test('Koa router prefix and NestJS controllers', () => {
  const koa = extractRoutes(`import Router from '@koa/router';\nconst router = new Router({ prefix: '/users' });\nrouter.get('/:id', async (ctx) => { ctx.status = 200; });\nrouter.post('/', async (ctx) => { ctx.status = 201; });\n`);
  assert.deepEqual(koa.routes.map((r) => `${r.method} ${joinRoute(r.ownPrefix ?? '', r.localPath)}`), ['GET /users/:id', 'POST /users']);
  const nest = extractRoutes(`import { Controller, Get, Post, HttpCode } from '@nestjs/common';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id')\n  one() {}\n  @Post()\n  @HttpCode(201)\n  create() {}\n}\n`);
  assert.deepEqual(nest.routes.map((r) => `${r.method} ${joinRoute(r.ownPrefix ?? '', r.localPath)}`), ['GET /orders/:id', 'POST /orders']);
  assert.ok(nest.routes[1].statuses.includes(201));
});

test('migrations order by numeric version, flyway style, repeatables last, down files out', () => {
  const names = ['0010_c.sql', '0002_b.sql', '2_x.sql', 'V1_1__y.sql', 'V1__a.sql', 'R__views.sql', '0003_b.down.sql', 'U2__undo.sql', '0001_a.sql'];
  assert.deepEqual(orderMigrationFiles(names), ['0001_a.sql', 'V1__a.sql', 'V1_1__y.sql', '0002_b.sql', '2_x.sql', '0010_c.sql', 'R__views.sql']);
  assert.ok(compareMigrations('20240101120000_a.sql', '20240102000000_b.sql') < 0);
  assert.ok(compareMigrations('9_a.sql', '10_a.sql') < 0);
  const t = tablesOfSql('-- create table ignored\nCREATE TABLE dbo.order_items (id INT, order_id INT REFERENCES dbo.orders (id), product_id INT REFERENCES [dbo].[products](id));\nALTER TABLE [dbo].[orders] ADD x INT;');
  assert.deepEqual(t.tables, ['order_items', 'orders']);
  assert.deepEqual(t.references, ['products']);
});

test('services sharing a schema are ordered so referenced tables exist first', () => {
  const m = (service: string, tables: string[], references: string[]): MigrationEntry => ({ id: `${service}-1`, service, repoId: service, file: 'migrations/1.sql', kind: 'sql', tables, references, sha256: 'x' });
  const by = new Map<string, MigrationEntry[]>([
    ['fulfillment', [m('fulfillment', ['shipments'], ['orders'])]],
    ['orders-api', [m('orders-api', ['orders', 'order_items'], ['products'])]],
    ['catalog-api', [m('catalog-api', ['products'], [])]],
  ]);
  assert.deepEqual(orderSchemaServices(by), ['catalog-api', 'orders-api', 'fulfillment']);
});

test('needs come from env variables naming another service (by name, else by the example port)', () => {
  const others = [
    { name: 'catalog-api', examplePort: 3001 },
    { name: 'orders-api', examplePort: 3002 },
    { name: 'payments', examplePort: 3009 },
  ];
  const svc = { name: 'orders-api', envVars: ['CATALOG_URL', 'BILLING_URL', 'DB_HOST', 'SENTRY_URL'], envDefaults: { CATALOG_URL: 'http://localhost:3001', BILLING_URL: 'http://localhost:3009', SENTRY_URL: 'https://x' } };
  assert.deepEqual(needsOf(svc, others), { CATALOG_URL: 'catalog-api', BILLING_URL: 'payments' });
});

test('statuses: explicit codes, helpers named after a status, 200 when none is 2xx', () => {
  assert.deepEqual(statusesIn('res.status(201).json(x)'), [201]);
  assert.deepEqual(statusesIn('throw notFound("x")'), [200, 404]);
  assert.deepEqual(statusesIn('reply.code(204)'), [204]);
});

test('buildFeatureMap: services, health route, needs, migrations, and route lookup by concrete path', () => {
  const h = tempHome('harness-verify-fm-');
  try {
    const cat = gitRepo(path.join(h.workspace, 'catalog-api'), {
      'package.json': JSON.stringify({ name: 'catalog-api', scripts: { dev: 'node src/server.js' } }),
      '.env.example': 'PORT=3001\nDB_SERVER=localhost\nDB_NAME=shop_test\nDB_PASSWORD=change-me\n',
      'src/app.ts': EXPRESS_HEALTH.replace('healthRouter', 'healthRouter') + "import express from 'express';\nconst app = express();\napp.use('/health', healthRouter);\n",
      'migrations/0001_create-products.sql': 'CREATE TABLE dbo.products (id INT);\nGO\n',
    });
    const ord = gitRepo(path.join(h.workspace, 'orders-api'), {
      'package.json': JSON.stringify({ name: 'orders-api', scripts: { start: 'node dist/server.js' } }),
      '.env.example': 'PORT=3002\nCATALOG_URL=http://localhost:3001\nDB_NAME=shop_test\n',
      'src/app.ts': EXPRESS_APP,
      'src/routes/orders.ts': EXPRESS_ORDERS,
      'src/routes/health.ts': EXPRESS_HEALTH,
      'migrations/0001_create-orders.sql': 'CREATE TABLE dbo.orders (id INT, product_id INT REFERENCES dbo.products(id));\n',
    });
    fs.mkdirSync(path.join(h.workspace, 'docs'));
    const map = buildFeatureMap({ workspaceRoot: h.workspace });
    assert.deepEqual(map.services.map((s) => s.name), ['catalog-api', 'orders-api']);
    const o = map.services.find((s) => s.name === 'orders-api')!;
    assert.deepEqual(o.needs, { CATALOG_URL: 'catalog-api' });
    assert.equal(o.health, '/health');
    assert.equal(o.portVar, 'PORT');
    assert.equal(map.services[0].envDefaults.DB_PASSWORD, undefined, 'secret example values are never kept');
    assert.deepEqual(map.tables, ['orders', 'products']);
    assert.deepEqual(withNeeds(map, ['orders-api']).order, ['catalog-api', 'orders-api']);
    assert.equal(findRoute(map, 'POST', '/orders/42/pay')?.id, 'POST /orders/:id/pay');
    assert.deepEqual(matchPath('/orders/:id', '/orders/42'), { id: '42' });
    assert.equal(matchPath('/orders/:id', '/orders'), null);
    assert.ok(cat && ord);
  } finally {
    h.cleanup();
  }
});
