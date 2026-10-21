import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BODY_CAP_BYTES, artefactId, currentTree, keepColumns, readArtefacts, redactBody, redactHeaders, routeSlug, writeArtefact, type HttpArtefact } from '../../../src/verify/artifact';
import { evidence } from '../../../src/verify/evidence';
import { e2eOutcome, listArtefacts } from '../../../src/gate/e2e';
import { findSecrets } from '../../../src/lib/redact';
import { writeTree } from '../../../src/lib/git';
import { gitRepo, tempHome } from '../lifecycle/helpers';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1';

test('redaction by construction: Set-Cookie, Authorization and token fields never reach the artefact', () => {
  const h = redactHeaders([
    ['Content-Type', 'application/json'],
    ['Set-Cookie', 'sid=abc123; HttpOnly'],
    ['Authorization', `Bearer ${JWT}`],
    ['X-Api-Key', 'k-123'],
    ['X-Request-Id', 'req-1'],
  ]);
  assert.deepEqual(Object.keys(h.headers).sort(), ['content-type', 'x-request-id']);
  assert.deepEqual(h.dropped, ['authorization', 'set-cookie', 'x-api-key']);
  const body = JSON.stringify({ user: { id: 7, name: 'Ann', token: JWT, refresh_token: 'r-1', password: 'pw' }, note: `see ${JWT}`, items: [{ apiKey: 'k' }] });
  const r = redactBody(body, 'application/json');
  const text = JSON.stringify(r.body);
  assert.equal(r.truncated, false);
  assert.ok(!text.includes(JWT), 'the token value is gone');
  assert.ok(!text.includes('"pw"'));
  assert.equal((r.body as { user: { id: number } }).user.id, 7);
  assert.equal((r.body as { user: { name: string } }).user.name, 'Ann');
  assert.equal((r.body as { user: { token: string } }).user.token, '[DROPPED]');
  assert.deepEqual(findSecrets(text), []);
});

test('bodies are capped at 16 KB (and stay redacted)', () => {
  const big = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, text: 'x'.repeat(20) })), secret: 'should-go' });
  const r = redactBody(big, 'application/json');
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.bodyText ?? '', 'utf8') <= BODY_CAP_BYTES);
  assert.ok(!(r.bodyText ?? '').includes('should-go'));
  assert.equal(r.bytes, Buffer.byteLength(big));
  const plain = redactBody(`token=${'a'.repeat(30)} and Bearer ${'b'.repeat(30)}`, 'text/plain');
  assert.ok(!(plain.bodyText ?? '').includes('a'.repeat(30)));
  assert.ok(!(plain.bodyText ?? '').includes('b'.repeat(30)));
});

test('only asserted columns are kept (secret-named ones dropped), rows capped', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, status: 'pending', password_hash: 'h', email: 'a@example.com' }));
  const k = keepColumns(rows, ['status', 'ID', 'password_hash']);
  assert.equal(k.rows.length, 50);
  assert.equal(k.truncated, true);
  assert.deepEqual(Object.keys(k.rows[0]).sort(), ['id', 'password_hash', 'status']);
  assert.equal(k.rows[0].password_hash, '[DROPPED]');
  assert.equal(k.rows[0].email, undefined);
});

test('artefact ids link to criteria; the artefact carries the tree hash the gate reads', () => {
  assert.equal(artefactId('http', 'AC1', 'x'), 'AC1-http');
  assert.equal(artefactId('db', undefined, 'orders'), 'orders-db');
  assert.equal(routeSlug('POST', '/orders/:id/pay'), 'post-orders-id-pay');
  const h = tempHome('harness-verify-art-');
  try {
    const repo = gitRepo(path.join(h.workspace, 'svc'), { 'src/a.ts': 'export const a = 1;\n' });
    const runDir = path.join(h.harnessHome, 'runs', 'svc-1', 'T1');
    const tree = currentTree(repo);
    assert.equal(tree, writeTree(repo));
    const art: HttpArtefact = {
      version: 1,
      id: 'AC1-http',
      kind: 'http',
      criterion: 'AC1',
      treeHash: tree,
      createdAt: new Date().toISOString(),
      pass: true,
      repoId: 'svc-1',
      taskId: 'T1',
      assertions: [{ kind: 'status', expect: '201', actual: '201', pass: true }],
      route: 'POST /orders',
      method: 'POST',
      url: 'http://127.0.0.1:20001/orders',
      status: 201,
      latencyMs: 12,
      headers: {},
      droppedHeaders: ['set-cookie'],
      requestHeaders: {},
      body: { note: `Bearer ${'z'.repeat(30)}` },
      bodyBytes: 10,
      bodyTruncated: false,
    };
    const file = writeArtefact(runDir, art);
    assert.equal(path.basename(file), 'AC1-http.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as HttpArtefact;
    for (const k of ['version', 'id', 'kind', 'criterion', 'treeHash', 'createdAt', 'pass']) assert.ok(k in saved, `artefact has ${k}`);
    assert.ok(!JSON.stringify(saved).includes('z'.repeat(30)), 'a secret that slipped into a field is masked at write time');
    // The gate's reader agrees: fresh on this tree, stale after an edit.
    const crit = { id: 'AC1', text: 'POST /orders returns 201', kind: 'api' as const, check: { kind: 'e2e-http' as const, description: 'x' } };
    assert.equal(listArtefacts(runDir)[0].id, 'AC1-http');
    assert.equal(e2eOutcome({ runDir, tree }, crit, 'http').status, 'pass');
    assert.equal(evidence(runDir, repo).fresh, 1);
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 2;\n');
    const ev = evidence(runDir, repo);
    assert.equal(ev.fresh, 0);
    assert.equal(ev.stale, 1);
    assert.equal(e2eOutcome({ runDir, tree: currentTree(repo) }, crit, 'http').status, 'fail');
    assert.equal(readArtefacts(runDir)[0].summary, 'POST /orders -> 201');
    // A failed assertion is recorded and the gate does not count it.
    writeArtefact(runDir, { ...art, pass: false, treeHash: currentTree(repo) });
    assert.equal(e2eOutcome({ runDir, tree: currentTree(repo) }, crit, 'http').status, 'fail');
  } finally {
    h.cleanup();
  }
});
