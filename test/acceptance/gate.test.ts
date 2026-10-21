/**
 * Acceptance: `harness gate` on the team stand-in workspace.
 *
 * The stand-in lives outside this tool; its location comes from environment
 * variables (see test/acceptance/README.md):
 *   HARNESS_STANDIN_TEAM            the stand-in folder (setup.js, standards/, traps/plan.md)
 *   HARNESS_STANDIN_TEAM_WORKSPACE  reuse a workspace setup.js already created (installed)
 *   HARNESS_STANDIN_INSTALL=1       let setup.js run `npm ci` (otherwise the repositories have
 *                                   no node_modules and the build/typecheck/lint/test steps
 *                                   FAIL as "declared but not installed"; the PASS and timing
 *                                   parts are then skipped with that reason)
 *   HARNESS_ACCEPTANCE_OUT          append one JSON line with the measured results
 *
 * What it does: discovers the workspace's standards into a temp HARNESS_HOME
 * (the real `harness discover`), then for each scenario clones the stand-in
 * repository into a temp folder (node_modules linked, never installed),
 * applies a change and runs the built CLI:
 *   - trap tickets from traps/plan.md with their naive (rule-breaking) fix:
 *     the gate must FAIL naming a ledger record that stands for the planted
 *     rule (the record whose check flags the planted standard's invalid
 *     fixture and passes its valid fixture, as discovery's own acceptance
 *     test judges it);
 *   - a clean change with a red-first acceptance check: prove-red, then PASS;
 *     wall time of the cold run, a cached re-run and a re-run after a
 *     one-file edit are measured and printed;
 *   - a deleted test: tamper FAIL naming the file.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import type { EvidenceFile, Ledger } from '../../src/types';
import { checkCommitSubjects, runLedgerChecksDetailed } from '../../src/discover/checks';
import { linkNodeModules } from '../../src/gate/checkout';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');

interface Planted {
  standards: Array<{ id: string; fixtureMode?: string }>;
}

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HARNESS_HOME: home, HARNESS_USER_HOME: path.dirname(home), HARNESS_NO_INSTRUMENT: '1' };
}

function git(dir: string, args: string[]): string {
  const r = run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, timeoutMs: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Ledger records that stand for a planted standard: flag its invalid fixture, pass its valid one. */
function recordsFor(standin: string, plantedId: string, planted: Planted, ledger: Ledger, checksDir: string): string[] {
  const p = planted.standards.find((x) => x.id === plantedId);
  if (!p) return [];
  const dir = path.join(standin, 'standards', 'fixtures', plantedId);
  const flagged: Record<string, Set<string>> = {};
  for (const kind of ['valid', 'invalid']) {
    const entry = fs.readdirSync(dir).find((n) => n.startsWith(kind + '.'));
    if (!entry) return [];
    const f = path.join(dir, entry);
    if (p.fixtureMode === 'subjects') {
      const subjects = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
      flagged[kind] = new Set(checkCommitSubjects(ledger, subjects, { checksDir }).map((v) => v.recordId));
    } else {
      const tree = fs.statSync(f).isDirectory();
      const r = runLedgerChecksDetailed(ledger, tree ? walk(f) : [f], { repoRoot: tree ? f : dir, ignoreScope: true, checksDir });
      flagged[kind] = new Set(r.violations.map((v) => v.recordId));
    }
  }
  return [...flagged.invalid].filter((id) => !flagged.valid.has(id));
}

function edit(file: string, fn: (s: string) => string): void {
  const s = fs.readFileSync(file, 'utf8');
  const out = fn(s);
  if (out === s) throw new Error(`edit did not apply to ${file}`);
  fs.writeFileSync(file, out);
}

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

interface Trap {
  ticket: string;
  repo: 'catalog-api' | 'orders-api' | 'fulfillment';
  planted: string[];
  apply(dir: string): { base?: string } | void;
}

const TRAPS: Trap[] = [
  {
    ticket: 'T01',
    repo: 'catalog-api',
    planted: ['sql-parameters'],
    apply: (d) =>
      edit(path.join(d, 'src/services/products-service.ts'), (s) =>
        s.replace(
          'export async function getProduct(',
          "export async function searchProducts(q: string): Promise<Product[]> {\n  return query<Product>(\n    `SELECT id, sku, name, price_cents, stock, active, created_at\n     FROM dbo.products WHERE active = 1 AND name LIKE '%${q}%' ORDER BY id`,\n  );\n}\n\nexport async function getProduct(",
        ),
      ),
  },
  {
    ticket: 'T02',
    repo: 'catalog-api',
    planted: ['layout-async-handler'],
    apply: (d) =>
      edit(path.join(d, 'src/routes/products.ts'), (s) =>
        s.replace(
          "productsRouter.get(\n  '/:id',",
          "productsRouter.get('/low-stock', async (_req, res) => {\n  const products = await listProducts(true);\n  res.json({ products: products.filter((p) => p.stock < 5) });\n});\n\nproductsRouter.get(\n  '/:id',",
        ),
      ),
  },
  {
    ticket: 'T03',
    repo: 'orders-api',
    planted: ['tests-per-module'],
    apply: (d) => put(path.join(d, 'src/lib/order-csv.ts'), "/** Quotes one CSV field per RFC 4180. */\nexport function csvField(value: string | number): string {\n  const text = String(value);\n  return /[\",\\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text;\n}\n"),
  },
  {
    ticket: 'T04',
    repo: 'orders-api',
    planted: ['layout-db-module'],
    apply: (d) =>
      edit(path.join(d, 'src/routes/health.ts'), (s) =>
        "import sql from 'mssql';\n" +
        s +
        "\nhealthRouter.get(\n  '/ready',\n  asyncHandler(async (_req, res) => {\n    const pool = await sql.connect('');\n    res.json({ ready: true, pool: { size: pool.size, available: pool.available } });\n  }),\n);\n",
      ),
  },
  {
    ticket: 'T05',
    repo: 'orders-api',
    planted: ['naming-kebab-files'],
    apply: (d) => put(path.join(d, 'src/lib/orderTotals.ts'), 'export function computeTotals(subtotalCents: number): { shippingCents: number; totalCents: number } {\n  const shippingCents = subtotalCents < 5000 ? 499 : 0;\n  return { shippingCents, totalCents: subtotalCents + shippingCents };\n}\n'),
  },
  {
    ticket: 'T06',
    repo: 'orders-api',
    planted: ['lint-eqeqeq', 'lint-no-explicit-any'],
    apply: (d) =>
      edit(path.join(d, 'src/routes/orders.ts'), (s) =>
        s.replace(
          '    const orders = await listOrders(status);',
          "    const wanted = (req.query.status as any).split(',');\n    const orders = (await listOrders(status)).filter((o: any) => wanted.indexOf(o.status) != -1);",
        ),
      ),
  },
  {
    ticket: 'T07',
    repo: 'fulfillment',
    planted: ['sql-migration-shape'],
    apply: (d) => put(path.join(d, 'migrations/add_notes.sql'), 'ALTER TABLE dbo.shipments ADD notes NVARCHAR(500) NULL;\n'),
  },
  {
    ticket: 'T08',
    repo: 'fulfillment',
    planted: ['naming-conventional-commits'],
    apply: (d) => {
      const base = git(d, ['rev-parse', 'HEAD']);
      edit(path.join(d, 'README.md'), (s) => s + '\nDispatch times come from the carrier.\n');
      git(d, ['commit', '-q', '-am', 'Revert "feat(db): shipments.dispatched_at"']);
      return { base };
    },
  },
];

interface GateOut {
  code: number;
  ms: number;
  evidence: EvidenceFile | null;
  stdout: string;
  stderr: string;
}

function gate(home: string, dir: string, args: string[]): GateOut {
  const t0 = Date.now();
  const r = run(process.execPath, [CLI, 'gate', '--json', ...args], { cwd: dir, env: envFor(home), timeoutMs: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  let evidence: EvidenceFile | null = null;
  try {
    evidence = (JSON.parse(r.stdout) as { evidence: EvidenceFile }).evidence;
  } catch {
    evidence = null;
  }
  return { code: r.code ?? -1, ms, evidence, stdout: r.stdout, stderr: r.stderr };
}

test('gate on the team stand-in: traps FAIL naming the planted rule, a clean change PASSes, a deleted test is tamper; cold vs cached timings', async (t) => {
  const standin = process.env.HARNESS_STANDIN_TEAM;
  if (!standin) return t.skip('HARNESS_STANDIN_TEAM is not set (path to the team stand-in folder; see test/acceptance/README.md)');
  if (!fs.existsSync(path.join(standin, 'setup.js')) || !fs.existsSync(path.join(standin, 'standards', 'planted.json'))) return t.skip(`HARNESS_STANDIN_TEAM=${standin} has no setup.js or standards/planted.json`);
  if (!which('git')) return t.skip('git is not available on PATH');
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI} (run npm run build)`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acc-gate-')));
  const saved = { home: process.env.HARNESS_HOME, user: process.env.HARNESS_USER_HOME };
  try {
    const home = path.join(tmp, 'home', '.harness');
    fs.mkdirSync(home, { recursive: true });
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_USER_HOME = path.dirname(home);

    // 1. The workspace.
    let ws = process.env.HARNESS_STANDIN_TEAM_WORKSPACE;
    const install = process.env.HARNESS_STANDIN_INSTALL === '1';
    if (!ws) {
      ws = path.join(tmp, 'workspace');
      const s = run(process.execPath, [path.join(standin, 'setup.js'), ws, '--no-db', '--harness-home', path.join(tmp, 'rough-home'), ...(install ? [] : ['--no-install'])], { timeoutMs: 1_200_000 });
      assert.equal(s.code, 0, `setup.js failed: ${s.stderr.slice(-800)}`);
      t.diagnostic(`setup.js ${install ? 'with' : 'without'} npm install, --no-db (the gate never connects to a database): ${s.stdout.trim().split('\n').pop()}`);
    } else t.diagnostic(`reusing the workspace in HARNESS_STANDIN_TEAM_WORKSPACE`);
    ws = fs.realpathSync(ws);
    const installed = ['catalog-api', 'orders-api', 'fulfillment'].every((r) => fs.existsSync(path.join(ws!, r, 'node_modules', 'typescript')));

    // 2. Discovery (the real command) into the temp home.
    const d = run(process.execPath, [CLI, 'discover', '--root', ws, '--json'], { env: envFor(home), timeoutMs: 600_000 });
    assert.equal(d.code, 0, `discover failed: ${d.stderr}`);
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'ledger', 'ledger.json'), 'utf8')) as Ledger;
    const checksDir = path.join(home, 'ledger', 'checks');
    const planted = JSON.parse(fs.readFileSync(path.join(standin, 'standards', 'planted.json'), 'utf8')) as Planted;
    t.diagnostic(`discover: ${ledger.records.length} ledger records`);

    let n = 0;
    const clone = (repo: string): string => {
      const dir = path.join(tmp, 'scenarios', `${++n}-${repo}`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(tmp, ['clone', '-q', path.join(ws!, repo), dir]);
      fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\nnode_modules\n');
      linkNodeModules(path.join(ws!, repo), dir);
      return dir;
    };

    // 3. Trap tickets with their naive fix.
    const results: Array<{ ticket: string; planted: string[]; caught: boolean; named: string[]; failedSteps: string[]; ms: number }> = [];
    for (const trap of TRAPS) {
      const dir = clone(trap.repo);
      const extra = trap.apply(dir) ?? {};
      const g = gate(home, dir, ['--task', `trap-${trap.ticket}`, ...(extra.base ? ['--base', extra.base] : [])]);
      assert.ok(g.evidence, `${trap.ticket}: gate printed evidence (${g.stderr})`);
      const text = g.evidence!.reasons.join('\n');
      const named: string[] = [];
      for (const p of trap.planted) {
        const ids = recordsFor(standin, p, planted, ledger, checksDir);
        const hit = ids.filter((id) => new RegExp(`(^|\\s)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at `, 'm').test(text));
        if (hit.length) named.push(...hit);
        else t.diagnostic(`${trap.ticket}: planted ${p} -> ledger records ${ids.join(', ') || '(none)'}; not named in the gate reasons`);
      }
      const caught = g.code === 1 && g.evidence!.verdict === 'FAIL' && named.length >= trap.planted.length;
      results.push({ ticket: trap.ticket, planted: trap.planted, caught, named, failedSteps: g.evidence!.steps.filter((s) => s.status === 'fail').map((s) => s.name), ms: g.ms });
      t.diagnostic(`${trap.ticket} (${trap.repo}, planted ${trap.planted.join('+')}): ${caught ? 'CAUGHT' : 'MISSED'} — verdict ${g.evidence!.verdict}, named ${named.join(', ') || '-'}; failed steps ${results[results.length - 1].failedSteps.join(', ')}; ${g.ms} ms`);
    }
    const caught = results.filter((r) => r.caught);
    assert.ok(caught.length >= 3, `at least three traps caught; caught ${caught.map((r) => r.ticket).join(', ')}`);
    assert.deepEqual(results.filter((r) => !r.caught).map((r) => r.ticket), [], 'every trap applied is caught');

    // 4. A deleted test: tamper FAIL naming the file.
    const td = clone('orders-api');
    fs.rmSync(path.join(td, 'test/unit/lib/money.test.ts'));
    const tg = gate(home, td, ['--task', 'tamper-delete', '--steps', 'tamper']);
    assert.equal(tg.code, 1);
    const tdFull = gate(home, td, ['--task', 'tamper-delete']);
    assert.equal(tdFull.evidence?.verdict, 'FAIL');
    assert.ok(tdFull.evidence!.reasons.some((r) => /^tamper: test\/unit\/lib\/money\.test\.ts: test file deleted/.test(r)), tdFull.evidence!.reasons.join('\n'));
    t.diagnostic(`deleted test: tamper FAIL naming test/unit/lib/money.test.ts (${tdFull.ms} ms)`);

    // 5. A clean change with a red-first acceptance check.
    let timings: Record<string, number> | null = null;
    if (!installed) {
      t.diagnostic('clean-change PASS and timings: skipped, the workspace has no node_modules (set HARNESS_STANDIN_INSTALL=1 or HARNESS_STANDIN_TEAM_WORKSPACE to an installed workspace); without them the gate FAILs the build/typecheck/lint/test steps as not installed');
    } else {
      const cd = clone('orders-api');
      const repoId = (await import('../../src/lib/config')).repoIdFor(cd);
      const { saveBrief, setCurrentTask } = await import('../../src/intake/brief');
      const baseSha = git(cd, ['rev-parse', 'HEAD']);
      const now = new Date().toISOString();
      saveBrief({
        version: 1,
        id: 't-clean',
        ticketHash: '0'.repeat(64),
        title: 'CSV field quoting',
        description: '',
        criteria: [{ id: 'AC1', text: 'CSV fields with commas or quotes are quoted per RFC 4180', kind: 'unit', check: { kind: 'unit', description: 'Unit test named "AC1: ..."', redFirst: true } }],
        units: [{ id: 'U1', title: 'csv', repo: repoId, paths: ['src/lib'], dependsOn: [], criteria: ['AC1'] }],
        repos: [repoId],
        questions: [],
        assumptions: [],
        createdAt: now,
        source: 'ticket',
        format: 'plain',
        inferred: false,
        codeBlocks: 0,
        hiddenRemoved: 0,
        criteriaMeta: {},
        questionDetails: [],
        queued: [],
        markers: [],
        observations: [],
        clarifications: [],
        dropped: [],
        repoMap: { ticket: [repoId], byCriterion: {}, repos: {} },
        landingOrder: [repoId],
        unitEstimates: {},
        baseShas: { [repoId]: baseSha },
        lint: [],
        updatedAt: now,
      } as unknown as Parameters<typeof saveBrief>[0]);
      setCurrentTask(repoId, 't-clean');
      // Tests first: the check, red at the base commit.
      put(path.join(cd, 'test/unit/lib/order-csv.test.ts'), "import { describe, expect, it } from 'vitest';\nimport { csvField } from '../../../src/lib/order-csv';\n\ndescribe('order-csv', () => {\n  it('AC1: quotes fields with commas or quotes per RFC 4180', () => {\n    expect(csvField('a,b')).toBe('\"a,b\"');\n    expect(csvField('say \"hi\"')).toBe('\"say \"\"hi\"\"\"');\n    expect(csvField(7298)).toBe('7298');\n  });\n});\n");
      const pr = run(process.execPath, [CLI, 'gate', 'prove-red', '--json'], { cwd: cd, env: envFor(home), timeoutMs: 600_000 });
      assert.equal(pr.code, 0, `prove-red: ${pr.stdout}${pr.stderr}`);
      const proof = JSON.parse(pr.stdout) as { results: Array<{ criterion: string; proof: { result: string } }> };
      assert.equal(proof.results[0].proof.result, 'red');
      // Then the code.
      put(path.join(cd, 'src/lib/order-csv.ts'), "/** Quotes one CSV field per RFC 4180 when it holds a comma, a quote or a line break. */\nexport function csvField(value: string | number): string {\n  const text = String(value);\n  return /[\",\\n]/.test(text) ? `\"${text.replace(/\"/g, '\"\"')}\"` : text;\n}\n");
      const cold = gate(home, cd, []);
      assert.equal(cold.code, 0, `clean change PASS: ${JSON.stringify(cold.evidence?.reasons ?? cold.stderr)}`);
      assert.equal(cold.evidence!.verdict, 'PASS');
      const st = Object.fromEntries(cold.evidence!.steps.map((s) => [s.name, s]));
      for (const name of ['tamper', 'secrets', 'standards', 'lint', 'typecheck', 'build', 'tests:base', 'acceptance:AC1']) assert.equal(st[name]?.status, 'pass', `${name}: ${JSON.stringify(st[name])}`);
      const cached = gate(home, cd, []);
      assert.equal(cached.code, 0);
      assert.ok(cached.evidence!.steps.filter((s) => s.cache === 'hit').length >= 8, 'the re-run comes from the cache');
      edit(path.join(cd, 'src/lib/order-csv.ts'), (s) => s.replace('/** Quotes one CSV field', '/** Quotes a single CSV field'));
      const oneFile = gate(home, cd, []);
      assert.equal(oneFile.code, 0, JSON.stringify(oneFile.evidence?.reasons));
      const reran = oneFile.evidence!.steps.filter((s) => s.cache === 'miss').map((s) => s.name);
      const kept = oneFile.evidence!.steps.filter((s) => s.cache === 'hit').map((s) => s.name);
      timings = { coldMs: cold.ms, cachedMs: cached.ms, oneFileEditMs: oneFile.ms };
      t.diagnostic(`clean change: PASS (prove-red: AC1 red at the base commit). Wall time: cold ${cold.ms} ms, cached re-run ${cached.ms} ms, re-run after a one-file edit ${oneFile.ms} ms (re-ran ${reran.join(', ')}; from cache ${kept.join(', ') || '-'})`);
    }

    const line = { kind: 'gate-team', traps: results.map((r) => ({ ticket: r.ticket, caught: r.caught, named: r.named, failedSteps: r.failedSteps, ms: r.ms })), caught: caught.length, of: results.length, timings, installed };
    if (process.env.HARNESS_ACCEPTANCE_OUT) fs.appendFileSync(process.env.HARNESS_ACCEPTANCE_OUT, JSON.stringify(line) + '\n');
    t.diagnostic(`gate-acceptance ${JSON.stringify(line)}`);
  } finally {
    if (saved.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = saved.home;
    if (saved.user === undefined) delete process.env.HARNESS_USER_HOME;
    else process.env.HARNESS_USER_HOME = saved.user;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
