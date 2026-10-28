import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFacts, repoInfos } from '../../../src/intake/classify';
import { evidenceLine, scout, scoutTerms } from '../../../src/intake/scout';
import { buildBrief, loadBrief, reassemble } from '../../../src/intake/brief';
import { main as intakeMain } from '../../../src/commands/intake';
import { repoIdFor, saveConfig, defaultConfig } from '../../../src/lib/config';
import { capture } from '../commands/capture';
import { gitRepo, tempHome, write, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-scout-');
});
after(() => h.cleanup());

let n = 0;
function repo(name: string, files: Record<string, string>): string {
  const p = path.join(h.workspace, `t${++n}`, name);
  gitRepo(p, { 'package.json': JSON.stringify({ name, scripts: { test: 'node -e 0' } }), ...files });
  return p;
}

test('scoutTerms: routes, tables, paths are strong; identifiers (quoted or bare), columns and commands are weak; plain words are not terms', () => {
  const text = 'GET /api/v1/inventory/low?limit=5 returns the rows of the stock_levels table below their threshold; the LowStockPanel shows them, see `docs/stock.md` and the read-only well-known flag.';
  const terms = scoutTerms(extractFacts(text), text);
  const by = (kind: string) => terms.filter((t) => t.kind === kind).map((t) => t.text);
  assert.deepEqual(by('route'), ['/inventory/low']);
  assert.ok(by('table').includes('stock_levels'));
  assert.ok(by('path').includes('docs/stock.md') && by('path').includes('stock.md'));
  assert.ok(by('quoted').includes('LowStockPanel'), JSON.stringify(terms));
  assert.ok(!terms.some((t) => /^(read-only|well-known|threshold|returns)$/i.test(t.text)), JSON.stringify(terms));
  assert.ok(terms.filter((t) => t.strong).every((t) => ['route', 'table', 'path'].includes(t.kind)));
  assert.deepEqual(scoutTerms(extractFacts('The dashboard lists them.'), 'The dashboard lists them.'), []);
});

test('scout: a criterion goes to every repository holding one of its routes or tables; a bare identifier alone places it when distinctive; nothing concrete places nothing', () => {
  const svc = repo('inventory-service', { 'src/report.ts': 'export const report = () => 1;\n' });
  const api = repo('stock-api', { 'src/routes.ts': "router.get('/inventory/low', (req, res) => res.json(db.query('select * from stock_levels')));\n" });
  const web = repo('web-dashboard', { 'src/dashboard.ts': "fetch('/api/inventory/low').then((r) => r.json()).then(LowStockPanel);\n", 'node_modules/x/index.js': '/inventory/low stock_levels LowStockPanel\n' });
  const infos = repoInfos({ repos: [svc, api, web].map((p) => ({ id: repoIdFor(p), name: path.basename(p), path: p })) } as never);
  const t = (s: string) => scoutTerms(extractFacts(s), s);
  const r = scout(
    {
      AC1: t('GET /inventory/low returns the rows of the stock_levels table below their threshold.'),
      AC2: t('The LowStockPanel shows them.'),
      AC3: t('The dashboard lists them.'),
    },
    infos,
  );
  assert.deepEqual(r.byCriterion.AC1, [repoIdFor(api), repoIdFor(web)], 'the endpoint and its caller, strongest first');
  assert.deepEqual(r.byCriterion.AC2, [repoIdFor(web)], 'one distinctive identifier');
  assert.deepEqual(r.byCriterion.AC3, []);
  assert.deepEqual(r.noTerms, ['AC3']);
  const apiHits = r.evidence.AC1[repoIdFor(api)];
  assert.ok(apiHits.some((x) => x.kind === 'table' && x.term === 'stock_levels' && x.sample[0] === 'src/routes.ts'));
  assert.ok(!r.repos.find((x) => x.repoId === repoIdFor(web))!.hits.some((x) => x.sample.some((f) => f.startsWith('node_modules'))), 'generated folders are skipped');
  assert.match(evidenceLine('stock-api', apiHits), /^stock-api: route \/inventory\/low in 1 file \(src\/routes\.ts\)/);
  assert.equal(r.budgetHit, false);
});

test('scout: the time budget stops the walk and says so; what was found holds', () => {
  const big = repo('big', Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/f${i}.ts`, `export const v${i} = '/orders/open';\n`])));
  const infos = repoInfos({ repos: [{ id: repoIdFor(big), name: 'big', path: big }] } as never);
  const r = scout({ AC1: scoutTerms(extractFacts('GET /orders/open lists the open orders.')) }, infos, { budgetMs: 0 });
  assert.equal(r.budgetHit, true);
  assert.ok(r.repos[0].partial);
});

test('brief: code evidence places a criterion where names would not (and keeps the user\'s --repo and a named repository above it); the search is stored and reused', () => {
  const svc = repo('inventory-service', { 'src/report.ts': 'export const report = () => 1;\n' });
  const api = repo('stock-api', { 'src/routes.ts': "router.get('/inventory/low', (req, res) => res.json(db.query('select * from stock_levels')));\n" });
  const web = repo('web-dashboard', { 'src/dashboard.ts': "fetch('/api/inventory/low').then(LowStockPanel);\n" });
  const config = { repos: [svc, api, web].map((p) => ({ id: repoIdFor(p), name: path.basename(p), path: p })) } as never;
  const ticket = 'Title: Show low stock on the dashboard\nAcceptance Criteria:\n1. GET /inventory/low returns the rows of the stock_levels table below their threshold.\n2. The dashboard shows them in the LowStockPanel.\n3. In inventory-service the nightly report counts them.\n';
  const b = buildBrief(ticket, { config });
  assert.deepEqual(b.repoMap.byCriterion.AC1, [repoIdFor(api), repoIdFor(web)]);
  assert.equal(b.criteriaMeta.AC1.repoHow, 'code');
  assert.deepEqual(b.repoMap.byCriterion.AC2, [repoIdFor(web)]);
  assert.deepEqual(b.repoMap.byCriterion.AC3, [repoIdFor(svc)], 'a repository named in the text still wins');
  assert.equal(b.criteriaMeta.AC3.repoHow, 'mention');
  assert.ok(b.scout && b.scout.evidence.AC1[repoIdFor(api)].length);
  // the name guess alone would have sent AC1 to inventory-service
  const named = buildBrief(ticket, { config, noScout: true });
  assert.deepEqual(named.repoMap.byCriterion.AC1, [repoIdFor(svc)]);
  // a rebuild (an answer) reuses the stored search even when the files changed since
  fs.rmSync(path.join(api, 'src', 'routes.ts'));
  const again = reassemble(b, { config });
  assert.deepEqual(again.repoMap.byCriterion.AC1, [repoIdFor(api), repoIdFor(web)]);
  assert.deepEqual(reassemble(b, { config, rescout: true }).repoMap.byCriterion.AC1, [repoIdFor(web)], 'rescout searches again');
  // the user's word wins
  const pinned = buildBrief(ticket, { config, defaultRepoPath: svc, repoPinned: true });
  assert.deepEqual(pinned.repoMap.byCriterion.AC1, [repoIdFor(svc)]);
});

test('a plain word of a distinctive repository name places a criterion with nothing concrete; generic parts never do', () => {
  const web = repo('web-dashboard', {});
  const svc = repo('billing-service', {});
  const config = { repos: [web, svc].map((p) => ({ id: repoIdFor(p), name: path.basename(p), path: p })) } as never;
  const b = buildBrief('Title: t\nAcceptance Criteria:\n1. The dashboard lists the items.\n2. The service restarts cleanly.\n', { config, noScout: true });
  assert.deepEqual(b.repoMap.byCriterion.AC1, [repoIdFor(web)]);
  assert.equal(b.criteriaMeta.AC1.repoHow, 'resource');
  assert.deepEqual(b.repoMap.byCriterion.AC2 ?? [], []);
});

test('harness intake scout: prints the evidence per criterion and the repositories the brief lacks; --apply adds them with the evidence as the reason', async () => {
  const api = repo('orders-api', { 'src/routes.ts': "router.get('/orders/open', list);\n" });
  const web = repo('orders-web', { 'src/page.ts': "fetch('/orders/open');\n" });
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: [{ id: repoIdFor(api), name: 'orders-api', path: api, packageManager: 'npm', isGit: true }] }));
  const ticket = path.join(h.root, 'orders.txt');
  write(ticket, 'Title: Open orders\nAcceptance Criteria:\n1. GET /orders/open lists the open orders.\n');
  const first = await capture(() => intakeMain(['--from', ticket, '--json']));
  const b = JSON.parse(first.stdout) as { id: string; repos: string[] };
  assert.deepEqual(b.repos, [repoIdFor(api)], 'orders-web is not in the workspace list, so intake could not see it');
  // the workspace list grows; scout sees the caller now
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: [api, web].map((p) => ({ id: repoIdFor(p), name: path.basename(p), path: p, packageManager: 'npm' as const, isGit: true })) }));
  const shown = await capture(() => intakeMain(['scout', b.id]));
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /AC1: orders-api, orders-web/);
  assert.match(shown.stdout, /Repositories with evidence the brief does not list:\n {2}orders-web for AC1/);
  const applied = await capture(() => intakeMain(['scout', b.id, '--apply']));
  assert.equal(applied.code, 0, applied.stderr);
  const after = loadBrief(b.id)!;
  assert.ok(after.repos.includes(repoIdFor(web)));
  assert.match(after.addedRepos![0].reason, /^found in the code: orders-web: route \/orders\/open in 1 file \(src\/page\.ts\)/);
  assert.deepEqual(after.addedRepos![0].criteria, ['AC1']);
  assert.ok(after.baseShas[repoIdFor(web)]);
});
