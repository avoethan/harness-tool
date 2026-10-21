import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import * as path from 'node:path';
import { allocatePorts, findFreeRange, probePort, readPorts, releasePorts } from '../../../src/verify/ports';
import { allowedRunEnv, envStem, filterRunEnv, parseRunEnv, renderCmd, renderPosix, renderPowerShell } from '../../../src/verify/runenv';
import { tempHome } from '../lifecycle/helpers';

test('findFreeRange returns the first contiguous free range on a stride and skips excluded ports', async () => {
  const busy = new Set([20001, 20012]);
  const probe = async (p: number) => !busy.has(p);
  // 20000-20002 holds 20001, 20010-20012 holds 20012
  assert.deepEqual(await findFreeRange({ count: 3, base: 20000, probe }), [20020, 20021, 20022]);
  // 20000-20001 holds 20001, 20010-20011 is free
  assert.deepEqual(await findFreeRange({ count: 2, base: 20000, probe }), [20010, 20011]);
  assert.deepEqual(await findFreeRange({ count: 2, base: 20000, probe, exclude: [20010] }), [20020, 20021]);
  assert.equal(await findFreeRange({ count: 2, base: 20000, max: 20005, probe: async () => false }), null);
});

test('probePort sees a port held by another listener', async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    assert.equal(await probePort(port), false);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
  assert.equal(await probePort(port), true);
});

test('allocatePorts reserves a range that a second run does not get, and release frees it', async () => {
  const h = tempHome('harness-verify-ports-');
  try {
    const file = path.join(h.harnessHome, 'state', 'verify-ports.json');
    const probe = async () => true;
    const a = await allocatePorts({ runId: 'raaaaaa1', repoId: 'repo-1', taskId: 't1' }, { count: 2, base: 31000, probe }, file);
    const b = await allocatePorts({ runId: 'rbbbbbb2', repoId: 'repo-1', taskId: 't2' }, { count: 2, base: 31000, probe }, file);
    assert.deepEqual(a, [31000, 31001]);
    assert.deepEqual(b, [31010, 31011]);
    assert.equal(readPorts(file).reservations.length, 2);
    releasePorts('raaaaaa1', file);
    assert.deepEqual(readPorts(file).reservations.map((r) => r.runId), ['rbbbbbb2']);
  } finally {
    h.cleanup();
  }
});

test('run.env renders POSIX, PowerShell and cmd lines and drops secret names and values by construction', () => {
  const vars = {
    RUN_ID: 'r1abcdef',
    BASE_URL: 'http://127.0.0.1:20001',
    DB_NAME: 'test_r1abcdef',
    DB_USER: 'sa',
    DB_PASSWORD: 'not-written',
    API_TOKEN: 'not-written-either',
    NOTE: "it's here",
    LEAK: 'ghp_' + 'a'.repeat(36),
  };
  const posix = renderPosix(vars, ['header']);
  assert.match(posix, /^# header\n/);
  assert.match(posix, /^RUN_ID=r1abcdef$/m);
  assert.match(posix, /^BASE_URL=http:\/\/127\.0\.0\.1:20001$/m);
  assert.match(posix, /^NOTE='it'\\''s here'$/m);
  assert.doesNotMatch(posix, /PASSWORD|TOKEN|not-written|ghp_/);
  const ps = renderPowerShell(vars);
  assert.match(ps, /^\$env:DB_NAME = 'test_r1abcdef'$/m);
  assert.match(ps, /^\$env:NOTE = 'it''s here'$/m);
  assert.doesNotMatch(ps, /PASSWORD|TOKEN|ghp_/);
  assert.match(renderCmd(vars), /^set "RUN_ID=r1abcdef"$/m);
  assert.deepEqual(filterRunEnv(vars).dropped.sort(), ['API_TOKEN', 'DB_PASSWORD', 'LEAK']);
  assert.equal(allowedRunEnv('DB_SERVER', 'localhost'), true);
  assert.equal(allowedRunEnv('bad key', 'x'), false);
  const back = parseRunEnv(posix);
  assert.equal(back.NOTE, "it's here");
  assert.equal(back.DB_NAME, 'test_r1abcdef');
  assert.equal(back.DB_PASSWORD, undefined);
  assert.equal(envStem('orders-api'), 'ORDERS_API');
  assert.equal(envStem('3d-svc'), 'S_3D_SVC');
});
