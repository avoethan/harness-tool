import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion, Ledger } from '../../../src/types';
import { buildContext } from '../../../src/gate/context';
import { changedLines, overallLines, runCoverage, type IstanbulReport } from '../../../src/gate/coverage';
import { driftFor, migrationId, overlayHasRoute, overlayPath, routesIn, runMapDrift } from '../../../src/gate/mapdrift';
import { e2eOutcome, e2eSteps, listArtefacts } from '../../../src/gate/e2e';
import { affectedPackages, runAffected, workspacePackages } from '../../../src/gate/affected';
import { runStandards } from '../../../src/gate/standards';
import { runBuild, runLint, runTypecheck } from '../../../src/gate/build';
import { writeJson } from '../../../src/lib/fsx';
import { repoIdFor } from '../../../src/lib/config';
import { commitAll, demoRepo, gitRepo, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-steps-');
});
after(() => h.cleanup());

test('coverage: changed-line coverage from Istanbul JSON, base line coverage, and the skip reason without a coverage script', () => {
  const root = '/r';
  const rep: IstanbulReport = {
    '/r/src/a.js': { path: '/r/src/a.js', statementMap: { 0: { start: { line: 1 }, end: { line: 1 } }, 1: { start: { line: 2 }, end: { line: 2 } }, 2: { start: { line: 5 }, end: { line: 5 } } }, s: { 0: 1, 1: 0, 2: 3 } },
  };
  assert.deepEqual(overallLines(rep), { covered: 2, total: 3 });
  const ch = changedLines(rep, root, new Map([['src/a.js', [{ line: 2 }, { line: 3 }, { line: 5 }]], ['test/a.test.js', [{ line: 1 }]]]));
  assert.deepEqual(ch, { covered: 1, total: 2, uncovered: ['src/a.js:2'] });
  const r = demoRepo(path.join(h.workspace, `c${++n}`));
  const out = runCoverage(buildContext({ repo: r }));
  assert.equal(out.status, 'skip');
  assert.match(out.reasons[0], /no coverage output configured/);
});

test('coverage: a repo coverage script that writes Istanbul JSON; changed lines below the base FAIL with the uncovered lines', () => {
  // The "coverage" script is a tiny node program standing in for c8: it marks
  // every statement covered except lines containing UNCOVERED.
  const writer = [
    "const fs = require('fs'); const path = require('path');",
    "const out = {}; for (const f of fs.readdirSync('src')) { const p = path.resolve('src', f); const lines = fs.readFileSync(p, 'utf8').split('\\n');",
    "  const sm = {}; const s = {}; lines.forEach((l, i) => { if (!l.trim()) return; sm[i] = { start: { line: i + 1 }, end: { line: i + 1 } }; s[i] = /UNCOVERED/.test(l) ? 0 : 1; });",
    "  out[p] = { path: p, statementMap: sm, s }; }",
    "fs.mkdirSync('coverage', { recursive: true }); fs.writeFileSync('coverage/coverage-final.json', JSON.stringify(out));",
  ].join('\n');
  const r = gitRepo(path.join(h.workspace, `c${++n}`), {
    'package.json': JSON.stringify({ name: 'cov', scripts: { coverage: 'node cov.js' } }),
    'cov.js': writer,
    '.gitignore': 'coverage/\n',
    'src/a.js': 'const a = 1;\nconst b = 2;\nconst c = 3; // UNCOVERED\nconst d = 4;\n',
  });
  put(r, 'src/b.js', 'const x = 1; // UNCOVERED\nconst y = 2; // UNCOVERED\nconst z = 3;\n');
  const out = runCoverage(buildContext({ repo: r }));
  assert.equal(out.status, 'fail', out.reasons.join('\n'));
  assert.match(out.reasons[0], /changed-line coverage 33\.3% \(1 of 3 lines\) vs base 75\.0% \(3 of 4\): below the base/);
  assert.match(out.reasons.join('\n'), /uncovered: src\/b\.js:1,2/);
  put(r, 'src/b.js', 'const x = 1;\nconst y = 2;\n');
  const ok = runCoverage(buildContext({ repo: r }));
  assert.equal(ok.status, 'pass', ok.reasons.join('\n'));
});

test('map drift: route and migration ids, mount prefixes, the exact missing ids, and the skip without a feature map', () => {
  assert.deepEqual(routesIn("router.get('/:id', asyncHandler(x));\napp.post(\"/orders\", h);\n@app.get('/py')\n", 'src/routes/orders.ts'), [
    { method: 'GET', path: '/:id', file: 'src/routes/orders.ts' },
    { method: 'POST', path: '/orders', file: 'src/routes/orders.ts' },
    { method: 'GET', path: '/py', file: 'src/routes/orders.ts' },
  ]);
  assert.equal(migrationId('migrations/0004_add-notes.sql'), '0004_add-notes');
  assert.ok(overlayHasRoute([{ id: 'GET /orders/:orderId' }], { method: 'GET', path: '/:id', file: 'src/routes/orders.ts' }));
  assert.ok(!overlayHasRoute([{ id: 'GET /orders/:id', file: 'src/routes/other.ts' }], { method: 'GET', path: '/:id', file: 'src/routes/orders.ts' }));
  const r = gitRepo(path.join(h.workspace, `m${++n}`), { 'src/routes/orders.ts': "router.get('/:id', h);\n", 'migrations/0001_init.sql': 'select 1;\n' });
  put(r, 'src/routes/orders.ts', "router.get('/:id', h);\nrouter.get('/:id/export.csv', h);\n");
  put(r, 'migrations/0002_add-notes.sql', 'select 2;\n');
  const ctx = buildContext({ repo: r });
  assert.equal(runMapDrift(ctx).status, 'skip');
  assert.match(runMapDrift(ctx).reasons[0], /no feature map yet.*verify maintain --add-missing/);
  writeJson(overlayPath(ctx.repoId), { version: 1, entries: { 'GET /orders/:id': { file: 'src/routes/orders.ts' }, '0001_init': {} } });
  const out = runMapDrift(ctx);
  assert.equal(out.status, 'fail');
  assert.deepEqual(out.reasons, ['no feature-map entry for GET /:id/export.csv (src/routes/orders.ts)', 'no feature-map entry for migration 0002_add-notes']);
  assert.deepEqual(driftFor(ctx, [{ id: 'GET /orders/:id' }, { id: 'GET /orders/:id/export.csv' }, { id: '0002_add-notes' }]).missing, []);
});

const API: Criterion = { id: 'AC1', text: 'GET /orders/:id returns total', kind: 'api', check: { kind: 'e2e-http', description: 'GET /orders/:id -> 200', command: 'harness verify drive --method GET --path /orders/:id --expect-status 200', redFirst: true } };
const DB: Criterion = { id: 'AC2', text: 'total stored', kind: 'db', check: { kind: 'e2e-db', description: 'orders.total', command: 'harness verify db --table orders --expect-columns total', redFirst: true } };

test('fresh E2E artefacts: missing, stale, failed and fresh; one step per api/db criterion; skip only without api/db checks', () => {
  const r = demoRepo(path.join(h.workspace, `e${++n}`));
  writeBrief(r, `t-e2e-${n}`, [API, DB]);
  const ctx = buildContext({ repo: r });
  assert.deepEqual(e2eSteps(ctx).map((s) => s.name), ['e2e:AC1', 'e2e:AC2']);
  let o = e2eOutcome(ctx, API, 'http');
  assert.equal(o.status, 'fail');
  assert.match(o.reasons[0], /AC1: no HTTP artefact \(AC1-http\) for this check\. Run: harness verify drive/);
  const dir = path.join(ctx.runDir, 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'AC1-http.json'), { version: 1, id: 'AC1-http', kind: 'http', treeHash: 'a'.repeat(40), createdAt: 'x', pass: true });
  o = e2eOutcome(ctx, API, 'http');
  assert.match(o.reasons[0], /from an older tree/);
  writeJson(path.join(dir, 'AC1-http.json'), { version: 1, id: 'AC1-http', kind: 'http', treeHash: ctx.tree, createdAt: 'x', pass: false });
  assert.match(e2eOutcome(ctx, API, 'http').reasons[0], /records a failed check/);
  writeJson(path.join(dir, 'AC1-http.json'), { version: 1, id: 'AC1-http', kind: 'http', treeHash: ctx.tree, createdAt: 'x', pass: true });
  assert.equal(e2eOutcome(ctx, API, 'http').status, 'pass');
  assert.equal(e2eOutcome(ctx, DB, 'db').status, 'fail');
  assert.deepEqual(listArtefacts(ctx.runDir).map((a) => [a.id, a.kind, a.rel]), [['AC1-http', 'http', 'e2e/AC1-http.json']]);
  const r2 = demoRepo(path.join(h.workspace, `e${++n}`));
  writeBrief(r2, `t-e2e-${n}`, [{ id: 'AC1', text: 'adds', kind: 'unit', check: { kind: 'unit', description: 'u', redFirst: true } }]);
  const only = e2eSteps(buildContext({ repo: r2 }));
  assert.deepEqual(only.map((s) => s.name), ['e2e']);
});

test('F6: a --db-unreachable check counts only artefacts of a launch with the database unreachable', () => {
  const r = demoRepo(path.join(h.workspace, `e${++n}`));
  const DOWN: Criterion = { ...API, check: { ...API.check!, command: 'harness verify launch --db-unreachable\nharness verify drive --method GET --path /health --expect-status 503 --criterion AC1' } };
  writeBrief(r, `t-e2e-${n}`, [DOWN]);
  const ctx = buildContext({ repo: r });
  const dir = path.join(ctx.runDir, 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'AC1-http.json'), { version: 1, id: 'AC1-http', kind: 'http', treeHash: ctx.tree, createdAt: 'x', pass: true });
  const o = e2eOutcome(ctx, DOWN, 'http');
  assert.equal(o.status, 'fail');
  assert.match(o.reasons[0], /needs an artefact from a `--db-unreachable` launch/);
  writeJson(path.join(dir, 'AC1-http.json'), { version: 1, id: 'AC1-http', kind: 'http', treeHash: ctx.tree, createdAt: 'x', pass: true, dbUnreachable: true });
  assert.equal(e2eOutcome(ctx, DOWN, 'http').status, 'pass');
  // an ordinary check still takes either
  assert.equal(e2eOutcome(ctx, API, 'http').status, 'pass');
});

test('affected scope: workspace packages, transitive dependents, their own scripts run; single package skips', () => {
  const r = gitRepo(path.join(h.workspace, `w${++n}`), {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'packages/core/package.json': JSON.stringify({ name: '@x/core', scripts: { test: 'node -e "process.exit(0)"' } }),
    'packages/core/index.js': 'module.exports = 1;\n',
    'packages/api/package.json': JSON.stringify({ name: '@x/api', dependencies: { '@x/core': '*' }, scripts: { test: 'node -e "process.exit(3)"' } }),
    'packages/web/package.json': JSON.stringify({ name: '@x/web' }),
  });
  const ctx0 = buildContext({ repo: r });
  const pkgs = workspacePackages(ctx0);
  assert.deepEqual(pkgs.map((p) => p.name), ['@x/api', '@x/core', '@x/web']);
  const a = affectedPackages(pkgs, ['packages/core/index.js']);
  assert.deepEqual(a.direct.map((p) => p.name), ['@x/core']);
  assert.deepEqual(a.all.map((p) => p.name).sort(), ['@x/api', '@x/core']);
  put(r, 'packages/core/index.js', 'module.exports = 2;\n');
  const out = runAffected(buildContext({ repo: r }));
  assert.equal(out.status, 'fail', out.reasons.join('\n'));
  assert.match(out.reasons[0], /@x\/api: `node -e process.exit\(3\)` exited 3/);
  const single = demoRepo(path.join(h.workspace, `w${++n}`));
  assert.equal(runAffected(buildContext({ repo: single })).status, 'skip');
});

test('standards: FAIL lists rule id, statement, file:line and fix for block tiers; warn tiers do not fail', () => {
  const r = demoRepo(path.join(h.workspace, `st${++n}`));
  commitAll(r, 'base');
  put(r, 'src/bad.js', 'if (a == b) {}\n');
  const ctx = buildContext({ repo: r });
  const dir = path.join(h.root, `checks-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const rec = (id: string, tier: 'declared' | 'counted-majority') => ({
    id,
    statement: 'Compare with ===.',
    family: 'lint' as const,
    scope: { repos: [repoIdFor(r)] },
    tier,
    confidence: 1,
    evidence: { sites: 10 },
    check: { type: 'regex' as const, mode: tier === 'declared' ? ('block' as const) : ('warn' as const), fixText: 'Use === instead of ==.' },
    conflicts: [],
    provenance: [],
    history: { firstSeen: '', lastCounted: '', disputes: 0 },
  });
  for (const id of ['lint.eqeqeq', 'lint.eqeqeq-soft']) writeJson(path.join(dir, `${id}.json`), { version: 1, id, engine: 'regex', mode: 'block', statement: 'Compare with ===.', scope: { repos: ['*'] }, files: ['**/*.js'], target: 'content', violate: ['[^=!]==[^=]'] });
  const ledger = { version: 1, generatedAt: '', workspaceRoot: h.workspace, records: [rec('lint.eqeqeq', 'declared'), rec('lint.eqeqeq-soft', 'counted-majority')], skipped: [], scanners: [] } as unknown as Ledger;
  const out = runStandards(ctx, ledger, { checksDir: dir });
  assert.equal(out.status, 'fail', out.reasons.join('\n'));
  assert.equal(out.reasons[0], 'lint.eqeqeq at src/bad.js:1: Compare with ===. Fix: Use === instead of ==.');
  assert.match(out.reasons[1], /^warn: lint\.eqeqeq-soft at src\/bad\.js:1/);
  assert.equal(runStandards(ctx, null).status, 'skip');
});

test('base checkouts link node_modules entry by entry and re-point workspace links into the checkout', async () => {
  const { linkNodeModules } = await import('../../../src/gate/checkout');
  const root = path.join(h.root, `nm${++n}`);
  const wt = path.join(h.root, `nm${n}-wt`);
  put(root, 'packages/core/index.js', 'module.exports = "root";\n');
  put(root, 'node_modules/dep/index.js', 'module.exports = 1;\n');
  fs.mkdirSync(path.join(root, 'node_modules/@x'), { recursive: true });
  fs.symlinkSync(path.join(root, 'packages/core'), path.join(root, 'node_modules/@x/core'), 'dir');
  put(wt, 'packages/core/index.js', 'module.exports = "checkout";\n');
  assert.ok(linkNodeModules(root, wt) >= 2);
  assert.equal(fs.realpathSync(path.join(wt, 'node_modules/@x/core')), fs.realpathSync(path.join(wt, 'packages/core')));
  assert.equal(fs.realpathSync(path.join(wt, 'node_modules/dep')), fs.realpathSync(path.join(root, 'node_modules/dep')));
  assert.ok(!fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), 'a real folder of links, ignored by node_modules/ patterns');
});

test('declared but not installed tools FAIL (deleting node_modules cannot turn checks into skips); undeclared ones skip', () => {
  const r = gitRepo(path.join(h.workspace, `ni${++n}`), {
    'package.json': JSON.stringify({ name: 'ni', scripts: { build: 'tsc -p tsconfig.json' }, devDependencies: { typescript: '^5.0.0', eslint: '^9.0.0' } }),
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
    'eslint.config.mjs': 'export default [];\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  put(r, 'src/a.ts', 'export const a = 2;\n');
  const ctx = buildContext({ repo: r });
  const tc = runTypecheck(ctx);
  assert.equal(tc.status, 'fail');
  assert.match(tc.reasons[0], /declared in package\.json but not installed/);
  const li = runLint(ctx);
  assert.equal(li.status, 'fail');
  assert.match(li.reasons[0], /ESLint is declared in package\.json but not installed/);
  const bu = runBuild(ctx);
  assert.equal(bu.status, 'fail');
  assert.match(bu.reasons[0], /runs tsc, which is not installed/);
  const r2 = gitRepo(path.join(h.workspace, `ni${++n}`), { 'package.json': '{"name":"x"}', 'tsconfig.json': '{}' });
  assert.equal(runTypecheck(buildContext({ repo: r2 })).status, 'skip');
});
