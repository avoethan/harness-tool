/**
 * Acceptance: the EVAL-PLAN section 8 learning protocol in miniature, driven
 * through the built CLI on a temp repository and a temp HARNESS_HOME.
 *
 *   1. A ledger (as discovery writes it) holds the probe library's
 *      `logging.logger-not-console` standard in warn mode with its real ast-grep check.
 *   2. Plant a mistake class: a scripted gate.fail naming that rule plus two
 *      scripted corrections in the same session (events.jsonl).
 *   3. `harness learn --scan`: one lesson, three occurrences, a lint enforcer, tier 0.
 *   4. `harness learn prove <id> --fixture <the original mistake>`: ast-grep
 *      test reports the mistake; tier 0, so it is approved at once and the
 *      learned check is written under ledger/checks/learned/.
 *   5. Feed a new event of the same class (scripted), and run the real
 *      `harness gate --steps standards` on the repository with the mistake in
 *      the working tree: the learned check blocks it, and the gate logs
 *      its own gate.fail.
 *   6. `harness learn stats`: repeats after the enforcer landed are counted.
 *
 * Skips with a printed reason when git or ast-grep is missing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { findAstGrep } from '../../src/discover/astgrep';
import { compileAstRules, loadProbeLibrary } from '../../src/discover/probes';
import { repoIdFor } from '../../src/lib/config';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');
const RULE = 'logging.logger-not-console';

function git(dir: string, args: string[]): string {
  const r = run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, timeoutMs: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function put(root: string, rel: string, text: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

test('learning protocol in miniature: plant, scan, prove (tier 0), repeat, stats', (t) => {
  if (!which('git')) return t.skip('git is not installed');
  const ast = findAstGrep();
  if (!ast) return t.skip('ast-grep is not installed (npm install in harness/ adds @ast-grep/cli)');
  const probe = loadProbeLibrary().probes.find((p) => p.id === RULE);
  if (!probe) return t.skip(`the probe library has no ${RULE} probe`);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-learn-protocol-')));
  const home = path.join(root, 'home');
  const hh = path.join(home, '.harness');
  const repo = path.join(root, 'shop');
  fs.mkdirSync(hh, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: hh, HARNESS_USER_HOME: home };
  delete env.HARNESS_NO_INSTRUMENT;
  delete env.NODE_TEST_CONTEXT;
  const cli = (args: string[], opts: { cwd?: string } = {}) => run(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? root, env, timeoutMs: 180_000 });
  try {
    // ---- a repository that logs through its logger ---------------------------
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    put(repo, 'package.json', JSON.stringify({ name: 'shop', version: '1.0.0', private: true }, null, 2) + '\n');
    put(repo, 'src/logger.ts', "export const logger = { info: (m: string, f?: object) => void [m, f], error: (m: string, f?: object) => void [m, f] };\n");
    put(repo, 'src/orders.ts', "import { logger } from './logger';\n\nexport function createOrder(id: string): string {\n  logger.info('order created', { id });\n  return id;\n}\n");
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const repoId = repoIdFor(repo);

    // ---- the ledger discovery would write (warn tier) ------------------------
    const violating = { ...probe, variants: probe.variants.filter((v) => v.name === 'console') };
    const rules = compileAstRules(violating);
    assert.ok(rules.length > 0);
    const rec = {
      id: RULE,
      statement: 'Log through the project logger (logger.info / .warn / .error), never console.*.',
      family: 'logging',
      scope: { repos: ['*'] },
      tier: 'counted-majority',
      confidence: 0.86,
      evidence: { sites: 14, conforming: 12, packages: 1, examples: [], sources: [] },
      check: { type: 'ast-grep', mode: 'warn', ref: `${RULE}.json`, fixText: 'Replace console.log/error with logger.info/logger.error and pass values in the fields object.' },
      conflicts: [],
      provenance: [{ kind: 'count', ref: 'probe' }],
      history: { firstSeen: '2026-01-01T00:00:00Z', lastCounted: '2026-01-01T00:00:00Z', disputes: 0 },
    };
    put(hh, 'ledger/ledger.json', JSON.stringify({ version: 1, generatedAt: '2026-01-01T00:00:00Z', workspaceRoot: repo, records: [rec], skipped: [], scanners: [] }));
    put(hh, `ledger/checks/${RULE}.json`, JSON.stringify({ version: 1, id: RULE, engine: 'ast-grep', mode: 'warn', statement: rec.statement, fixText: rec.check.fixText, scope: rec.scope, files: probe.files, exclude: probe.exclude, rules }));

    // ---- 2. plant the mistake class --------------------------------------------
    const t0 = Date.now() - 2 * 3600_000;
    const ts = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const planted = [
      { ts: ts(0), event: 'gate.fail', repo: repoId, task: 't-1', sessionId: 's-1', ids: { step: 'standards', kind: 'standards', mode: 'task', rules: RULE }, counts: { reasons: 2, attempt: 1 } },
      { ts: ts(2), event: 'correction', sessionId: 's-1', agent: 'claude', class: 'style', ids: { ticket: 'h1' } },
      { ts: ts(4), event: 'correction', sessionId: 's-1', agent: 'claude', class: 'style', ids: { ticket: 'h1' } },
    ];
    put(hh, 'logs/events.jsonl', planted.map((e) => JSON.stringify(e)).join('\n') + '\n');

    // ---- 3. scan ------------------------------------------------------------------
    const s = cli(['learn', '--scan', '--json']);
    assert.equal(s.code, 0, s.stderr);
    const scanOut = JSON.parse(s.stdout) as { lessons: Array<{ id: string; key: string; status: string; tier: number; occurrences: number; rung: string | null }> };
    const lesson = scanOut.lessons.find((l) => l.key === `rule:${RULE}`);
    assert.ok(lesson, `a lesson for the planted class: ${s.stdout}`);
    assert.equal(lesson!.occurrences, 3);
    assert.equal(lesson!.status, 'proposed');
    assert.equal(lesson!.tier, 0);
    assert.equal(lesson!.rung, 'lint');

    // ---- 4. prove on the original mistake (tier 0: approved at once) -------------
    const mistake = "import { logger } from './logger';\n\nexport function createOrder(id: string): string {\n  console.log('order created', id);\n  return id;\n}\n";
    const fixture = put(root, 'mistake/orders.ts', mistake);
    const p = cli(['learn', 'prove', lesson!.id, '--fixture', fixture, '--json']);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    const proved = JSON.parse(p.stdout) as { status: string; proof: { result: string; method: string; fixtureSource: string }; approved: boolean; installed: string[] };
    assert.equal(proved.proof.result, 'proven');
    assert.equal(proved.proof.method, 'ast-grep-test');
    assert.equal(proved.proof.fixtureSource, 'user');
    assert.equal(proved.approved, true);
    assert.equal(proved.status, 'approved');
    const specFile = path.join(hh, 'ledger', 'checks', 'learned', `${RULE}.json`);
    assert.ok(fs.existsSync(specFile), 'the proven check is present under ledger/checks');
    assert.ok(fs.existsSync(path.join(hh, 'ledger', 'checks', 'learned', `${RULE}.yml`)));
    const learned = JSON.parse(fs.readFileSync(path.join(hh, 'ledger', 'learned.json'), 'utf8')) as { records: Array<{ id: string; check: { mode: string } }> };
    assert.equal(learned.records.find((r) => r.id === RULE)?.check.mode, 'block');
    const statsBefore = JSON.parse(cli(['learn', 'stats', '--json']).stdout) as { rows: Array<{ lesson: string; repeats: number; repeatsAfter: number }> };
    const before = statsBefore.rows.find((r) => r.lesson === lesson!.id)!;
    assert.equal(before.repeats, 0, 'nothing repeated yet');

    // ---- 5. a new event of the same class, and the check firing in the real gate --
    const fed = { ts: new Date(Date.now() + 1000).toISOString(), event: 'gate.fail', repo: repoId, task: 't-2', sessionId: 's-2', ids: { step: 'standards', kind: 'standards', mode: 'task', rules: RULE }, counts: { reasons: 1, attempt: 1 } };
    fs.appendFileSync(path.join(hh, 'logs', 'events.jsonl'), JSON.stringify(fed) + '\n');
    put(repo, 'src/orders.ts', mistake);
    const g = cli(['gate', '--steps', 'standards', '--task', 't-3', '--repo', repo], { cwd: repo });
    assert.equal(g.code, 1, `the gate fails on the mistake: ${g.stdout}${g.stderr}`);
    assert.match(g.stdout + g.stderr, new RegExp(`${RULE.replace(/\./g, '\\.')} at src/orders\\.ts:4`), 'the learned check names the rule and the line');
    assert.doesNotMatch(g.stdout, new RegExp(`warn: ${RULE.replace(/\./g, '\\.')}`), 'it blocks now; it is not a warning any more');
    const ev = fs.readFileSync(path.join(hh, 'logs', 'events.jsonl'), 'utf8');
    assert.match(ev, new RegExp(`"event":"gate.fail"[^\\n]*"task":"t-3"|"task":"t-3"[^\\n]*"event":"gate.fail"`), 'the gate logged its own failure');

    // ---- 6. stats count the repeats after the enforcer landed --------------------
    const st = cli(['learn', 'stats', '--json']);
    assert.equal(st.code, 0, st.stderr);
    const stats = JSON.parse(st.stdout) as { rows: Array<{ lesson: string; occurrences: number; repeats: number; repeatsBefore: number; repeatsAfter: number; landedAt?: string }> };
    const row = stats.rows.find((r) => r.lesson === lesson!.id)!;
    assert.ok(row.landedAt);
    assert.equal(row.repeatsBefore, 0);
    assert.ok(row.repeatsAfter >= 1, `a repeat after landing is counted: ${JSON.stringify(row)}`);
    t.diagnostic(`measured: occurrences ${row.occurrences}, repeats ${row.repeats} (before landing ${row.repeatsBefore}, after ${row.repeatsAfter}: the fed event and the real gate run)`);
    // the human report says the same
    const human = cli(['learn', 'stats']).stdout;
    assert.match(human, new RegExp(`after ${row.repeatsAfter} over`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
