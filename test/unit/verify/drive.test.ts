import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { Criterion } from '../../../src/types';
import { curlLine, fillPath, fillTemplate, httpRequest, matchCriterion, parseRouteArg, percentile, signIn } from '../../../src/verify/drive';
import { waitReady } from '../../../src/verify/services';
import { assertPath, compare, getPath, parseExpectation } from '../../../src/verify/dbassert';
import { secretValues, serviceEnv } from '../../../src/verify/launch';
import { reportedDatabase } from '../../../src/verify/doctor';
import { redactBody, redactHeaders } from '../../../src/verify/artifact';
import { findSecrets } from '../../../src/lib/redact';
import type { ServiceEntry } from '../../../src/verify/featuremap';

test('route arguments, path parameters and templates', () => {
  assert.deepEqual(parseRouteArg(['POST /orders']), { method: 'POST', path: '/orders' });
  assert.deepEqual(parseRouteArg(['get', '/orders/1']), { method: 'GET', path: '/orders/1' });
  assert.equal(parseRouteArg(['orders']), null);
  assert.deepEqual(fillPath('/orders/:id/items/{item}', { id: '5', item: 'a b' }), { path: '/orders/5/items/a%20b', missing: [] });
  assert.deepEqual(fillPath('/orders/:id', {}).missing, ['id']);
  const vars = { runId: 'r1', last: { order: { id: 9 } }, env: { E2E_PW: 'x' }, bases: { cat: 'http://127.0.0.1:1' } };
  assert.deepEqual(fillTemplate({ email: 'e2e-{{runId}}@example.com', id: '{{last.order.id}}', url: '{{base.cat}}/p' }, vars), { email: 'e2e-r1@example.com', id: 9, url: 'http://127.0.0.1:1/p' });
  const missing: string[] = [];
  fillTemplate('{{last.nope}}', vars, missing);
  assert.deepEqual(missing, ['last.nope']);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
});

test('expectations: json paths, operators, presence', () => {
  const body = { order: { id: 5, status: 'pending', total_cents: 5998, items: [{ product_id: 1 }] } };
  const e = parseExpectation('order.total_cents=5998')!;
  assert.equal(assertPath(body, e).pass, true);
  assert.equal(assertPath(body, parseExpectation('order.items[0].product_id=1')!).pass, true);
  assert.equal(assertPath(body, parseExpectation('order.status!=paid')!).pass, true);
  assert.equal(assertPath(body, parseExpectation('order.total_cents>=6000')!).pass, false);
  assert.equal(assertPath(body, parseExpectation('order.id=*')!).pass, true);
  assert.equal(assertPath(body, parseExpectation('order.missing=*')!).pass, false);
  assert.equal(parseExpectation('just text'), null);
  assert.equal(getPath({ A: { b: 1 } }, 'a.b'), 1);
  assert.equal(compare(true, { op: '=', value: 1 }), true);
  assert.equal(compare('Kettle large', { op: '~', value: 'Kettle' }), true);
  // a secret-named path never shows its value
  assert.equal(assertPath({ token: 'abc' }, parseExpectation('token=abc')!).actual, undefined);
});

test('brief criteria are linked by method and route pattern, or by table', () => {
  const c = (id: string, kind: 'e2e-http' | 'e2e-db', command: string): Criterion => ({ id, text: '', kind: kind === 'e2e-http' ? 'api' : 'db', check: { kind, description: '', command } });
  const criteria = [c('AC1', 'e2e-http', "harness verify drive --method POST --path '/orders' --expect-status 201"), c('AC2', 'e2e-http', 'harness verify drive --method GET --path /orders/:id --expect-status 200'), c('AC3', 'e2e-db', 'harness verify db --table orders --expect-columns total')];
  assert.equal(matchCriterion(criteria, 'http', { method: 'POST', path: '/orders' }), 'AC1');
  assert.equal(matchCriterion(criteria, 'http', { method: 'GET', path: '/orders/7' }), 'AC2');
  assert.equal(matchCriterion(criteria, 'http', { method: 'DELETE', path: '/orders/7' }), undefined);
  assert.equal(matchCriterion(criteria, 'db', { table: 'dbo.orders' }), 'AC3');
});

test('the curl line carries no token and no secret body field', () => {
  const line = curlLine('POST', 'http://127.0.0.1:1/login', { 'content-type': 'application/json' }, { user: 'a', password: 'hunter2-hunter2' }, 'authorization');
  assert.ok(!line.includes('hunter2'));
  assert.match(line, /-H "authorization: \$HARNESS_TOKEN"/);
});

test('service environment: port, DB variables, upstream URLs; secrets only in the process env', () => {
  const s: ServiceEntry = {
    name: 'orders-api',
    repoId: 'o',
    repoRoot: '/w/o',
    dir: '/w/o',
    envName: 'ORDERS_API',
    scripts: { dev: 'tsx src/server.ts' },
    envVars: ['DB_SERVER', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'PORT', 'CATALOG_URL', 'LOG_LEVEL', 'PAYMENTS_URL'],
    envDefaults: { DB_SERVER: 'localhost', DB_PORT: '1433', DB_NAME: 'shop_test', DB_USER: 'sa', PORT: '3002', CATALOG_URL: 'http://localhost:3001', LOG_LEVEL: 'info', PAYMENTS_URL: 'https://payments.example.com' },
    portVar: 'PORT',
    db: { serverVar: 'DB_SERVER', portVar: 'DB_PORT', nameVar: 'DB_NAME', userVar: 'DB_USER', passwordVar: 'DB_PASSWORD' },
    needs: { CATALOG_URL: 'catalog-api' },
    routes: 3,
  };
  const db = { host: 'localhost', port: '14333', database: 'test_r1', user: 'sa' };
  const e = serviceEnv(s, 20001, { 'catalog-api': 'http://127.0.0.1:20000' }, db);
  assert.equal(e.env.PORT, '20001');
  assert.equal(e.env.DB_NAME, 'test_r1');
  assert.equal(e.env.DB_PORT, '14333');
  assert.equal(e.env.CATALOG_URL, 'http://127.0.0.1:20000');
  assert.equal(e.env.LOG_LEVEL, 'info');
  assert.equal(e.env.PAYMENTS_URL, undefined, 'a remote URL from the example is never copied');
  assert.equal(e.env.DB_PASSWORD, undefined);
  assert.deepEqual(e.secretNames, ['DB_PASSWORD']);
  assert.deepEqual(secretValues(s, e.secretNames, db, 'pw'), { DB_PASSWORD: 'pw' });
});

test('doctor reads a database name from a health body, not a status word', () => {
  assert.equal(reportedDatabase('{"status":"ok","database":"up"}'), null);
  assert.equal(reportedDatabase('{"status":"ok","database":"test_r1"}'), 'test_r1');
  assert.equal(reportedDatabase('{"checks":{"db":{"name":"test_r1","ok":true}}}'), 'test_r1');
  assert.equal(reportedDatabase('not json'), null);
});

test('a live response with Set-Cookie and a token field is recorded redacted', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXRlc3QtMTIzNDU2';
  const srv = http.createServer((_req, res) => {
    res.setHeader('Set-Cookie', ['sid=s3cr3t-session; HttpOnly', 'other=1']);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 201;
    res.end(JSON.stringify({ id: 1, accessToken: token, profile: { email: 'a@example.com' } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await httpRequest(`http://127.0.0.1:${port}/login`, 'POST', { 'content-type': 'application/json' }, '{}', 5000);
    assert.equal(res.status, 201);
    assert.equal(res.setCookie.length, 2);
    const h = redactHeaders(res.headers);
    const b = redactBody(res.text, res.contentType);
    const text = JSON.stringify({ h, b });
    assert.ok(!text.includes('s3cr3t-session'));
    assert.ok(!text.includes(token));
    assert.ok(h.dropped.includes('set-cookie'));
    assert.equal((b.body as { id: number }).id, 1);
    assert.deepEqual(findSecrets(text), []);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('the auth slot: a login recipe signs in and the token goes in the header, in memory only', async () => {
  const token = 'tok-' + 'x'.repeat(24);
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/auth/login' && JSON.parse(body || '{}').email === 'e2e-r1@example.com') res.end(JSON.stringify({ data: { accessToken: token } }));
      else res.end(JSON.stringify({ error: 'no' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const run = { services: [{ name: 'api', role: 'entry', baseUrl: `http://127.0.0.1:${port}` }] } as unknown as Parameters<typeof signIn>[0];
    const overlay = { version: 1 as const, entries: {}, users: { buyer: { login: { route: 'POST /auth/login', body: { email: 'e2e-{{runId}}@example.com', password: '{{env.E2E_PW}}' }, tokenPath: 'data.accessToken' } } } };
    const vars = { runId: 'r1', env: { E2E_PW: 'pw' }, bases: {} };
    const ok = await signIn(run, overlay, 'buyer', vars, 5000);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.header, ['authorization', `Bearer ${token}`]);
    const missing = await signIn(run, overlay, 'admin', vars, 5000);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /no login recipe for "admin"/);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('readiness: a health route answering 2xx, a port, or a process that exited', async () => {
  const srv = http.createServer((req, res) => {
    res.statusCode = req.url === '/health' ? 200 : 404;
    res.end('{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    const a = await waitReady({ port, baseUrl: `http://127.0.0.1:${port}`, health: '/health', timeoutMs: 3000 });
    assert.equal(a.ready, true);
    assert.equal(a.via, 'health');
    const b = await waitReady({ port, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
    assert.equal(b.via, 'port');
    assert.equal(b.ready, true);
    const c = await waitReady({ port, baseUrl: `http://127.0.0.1:${port}`, health: '/nope', timeoutMs: 700 });
    assert.equal(c.ready, false);
    assert.match(c.error ?? '', /404/);
    const d = await waitReady({ port: 1, baseUrl: 'http://127.0.0.1:1', pid: 2 ** 22 + 12345, timeoutMs: 3000 });
    assert.equal(d.ready, false);
    assert.match(d.error ?? '', /exited/);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
