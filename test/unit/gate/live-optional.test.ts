import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion } from '../../../src/types';
import { buildContext } from '../../../src/gate/context';
import { e2eOutcome } from '../../../src/gate/e2e';
import { proveRed } from '../../../src/gate/tests';
import { loadBrief } from '../../../src/intake/brief';
import { demoRepo, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-liveopt-');
});
after(() => h.cleanup());

const LIVE: Criterion = {
  id: 'AC1',
  text: 'GET /health returns 200',
  kind: 'api',
  check: {
    kind: 'e2e-http',
    description: 'GET /health -> 200; live drive, or a unit test named "AC1:" that names the route "GET /health"',
    command: 'harness verify drive --method GET --path /health --expect-status 200 --criterion AC1',
    redFirst: true,
    liveOptional: true,
    liveOptionalRoute: 'GET /health',
  },
};
const RICH: Criterion = { ...LIVE, id: 'AC2', check: { kind: 'e2e-http', description: 'GET /health -> 200; body has "ok"', command: 'harness verify drive --method GET --path /health --expect-status 200 --expect-body ok --criterion AC2', redFirst: true } };

const ROUTE_TEST = (id: string, route = '/health') => `const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('${id}: GET ${route} answers 200', () => {\n  assert.equal(require('../src/add').add(1, 1), 2);\n});\n`;

function ctxFor(r: string) {
  return buildContext({ repo: r });
}

test('a liveOptional check passes on a passing unit test named for the id that names the route', () => {
  const r = demoRepo(path.join(h.workspace, `r${++n}`));
  writeBrief(r, `t-lo-${n}`, [LIVE]);
  put(r, 'test/health.test.js', ROUTE_TEST('AC1'));
  const out = e2eOutcome(ctxFor(r), LIVE, 'http');
  assert.equal(out.status, 'pass', out.reasons.join('; '));
  assert.match(out.reasons.join(' '), /test\/health\.test\.js/);
});

test('the gate still fails with neither artefact nor test, with a test that does not name the route, and with a failing test', () => {
  const r = demoRepo(path.join(h.workspace, `r${++n}`));
  writeBrief(r, `t-lo-${n}`, [LIVE]);
  let out = e2eOutcome(ctxFor(r), LIVE, 'http');
  assert.equal(out.status, 'fail');
  assert.match(out.reasons.join('\n'), /no HTTP artefact/);
  assert.match(out.reasons.join('\n'), /unit test named "AC1:" that names the route "GET \/health"/);

  put(r, 'test/health.test.js', ROUTE_TEST('AC1', '/other'));
  out = e2eOutcome(ctxFor(r), LIVE, 'http');
  assert.equal(out.status, 'fail', 'the file does not contain the route path');

  put(r, 'test/health.test.js', ROUTE_TEST('AC1').replace('add(1, 1), 2', 'add(1, 1), 3'));
  out = e2eOutcome(ctxFor(r), LIVE, 'http');
  assert.equal(out.status, 'fail');
  assert.match(out.reasons.join('\n'), /acceptance test fails/);
});

test('a test for another id does not count', () => {
  const r = demoRepo(path.join(h.workspace, `r${++n}`));
  writeBrief(r, `t-lo-${n}`, [LIVE]);
  put(r, 'test/health.test.js', ROUTE_TEST('AC7'));
  assert.equal(e2eOutcome(ctxFor(r), LIVE, 'http').status, 'fail');
});

test('a check with a body expectation stays live-only: the unit test is not accepted', () => {
  const r = demoRepo(path.join(h.workspace, `r${++n}`));
  writeBrief(r, `t-lo-${n}`, [RICH]);
  put(r, 'test/health.test.js', ROUTE_TEST('AC2'));
  const out = e2eOutcome(ctxFor(r), RICH, 'http');
  assert.equal(out.status, 'fail');
  assert.match(out.reasons.join('\n'), /no HTTP artefact/);
});

test('a fresh live artefact still passes a liveOptional check, and a failed one on the current tree is not overridden by a test', () => {
  const r = demoRepo(path.join(h.workspace, `r${++n}`));
  writeBrief(r, `t-lo-${n}`, [LIVE]);
  put(r, 'test/health.test.js', ROUTE_TEST('AC1'));
  const ctx = ctxFor(r);
  const art = (pass: boolean) => {
    fs.mkdirSync(path.join(ctx.runDir, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(ctx.runDir, 'e2e', 'AC1-http.json'), JSON.stringify({ version: 1, id: 'AC1-http', kind: 'http', criterion: 'AC1', treeHash: ctx.tree, createdAt: new Date().toISOString(), pass }));
  };
  art(true);
  assert.match(e2eOutcome(ctx, LIVE, 'http').reasons.join(' '), /e2e\/AC1-http\.json/);
  art(false);
  assert.equal(e2eOutcome(ctx, LIVE, 'http').status, 'fail');
});

test('prove-red treats a liveOptional check like a unit check when a test names it, and leaves it alone otherwise', () => {
  const r = demoRepo(path.join(h.workspace, `r${++n}`));
  const task = `t-lo-${n}`;
  writeBrief(r, task, [LIVE, { ...LIVE, id: 'AC3', check: { ...LIVE.check!, liveOptional: true } }]);
  put(r, 'test/health.test.js', ROUTE_TEST('AC1').replace('add(1, 1), 2', 'add(1, 1), 3'));
  const res = proveRed(ctxFor(r));
  assert.equal(res.error, undefined);
  assert.deepEqual(res.results.map((x) => [x.criterion, x.proof.result]), [['AC1', 'red']]);
  assert.equal(loadBrief(task)!.criteria[0].check?.redProof?.result, 'red');
  assert.equal(loadBrief(task)!.criteria[1].check?.redProof, undefined);
});
