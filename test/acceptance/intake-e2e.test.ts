/**
 * End to end through the built CLI, in a temp HARNESS_HOME with a temp git
 * repo registered in a temp config:
 *   intake from a file -> brief written -> phase tests -> phase implement ->
 *   (fabricated evidence fixture) -> writeup with every criterion mapped,
 * and the instrumentation log holds no ticket key, title or secret.
 * Also runs the stdin form (`intake --from -`) on the brief's example ticket.
 * Needs git; skips with a printed reason when it is missing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { packageRoot } from '../../src/lib/paths';
import { repoIdFor } from '../../src/lib/config';
import { writeTree } from '../../src/lib/git';

const CLI = path.join(packageRoot(), 'dist', 'src', 'cli.js');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const TICKET = [
  'h1. SHOP-142 Add order total',
  'h2. Description',
  `Customers need the order total. Our old script called the API with ${TOKEN}.`,
  '{code}',
  '# not a criterion',
  '{code}',
  'h2. Acceptance Criteria',
  '# GET /orders/:id returns total',
  '# total stored in orders.total column',
  '# The order page shows the total',
  '# The rounding helper rounds half up to 2 decimals',
].join('\n');

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-intake-e2e-')));
}

function env(root: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: path.join(root, 'home', '.harness'), HARNESS_USER_HOME: path.join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  delete e.HARNESS_NO_INSTRUMENT;
  delete e.HARNESS_SESSION_ID;
  return e;
}

function cli(root: string, args: string[], cwd: string, input?: string) {
  return run(process.execPath, [CLI, ...args], { cwd, env: env(root), timeoutMs: 60000, ...(input !== undefined ? { input } : {}) });
}

function git(dir: string, args: string[]) {
  const r = run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, timeoutMs: 30000, env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}

test('acceptance: the example ticket on stdin gives two criteria, api and db, each with a check', (t) => {
  if (!fs.existsSync(CLI)) return t.skip('dist/src/cli.js missing: run npm run build first');
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, 'home', '.harness'), { recursive: true });
    const r = cli(root, ['intake', '--from', '-'], root, 'Title: Add order total\nAcceptance Criteria:\n1. GET /orders/:id returns total\n2. total stored in orders.total column\n');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Acceptance criteria \(2\):/);
    assert.match(r.stdout, /AC1 {2}\[api [0-9.]+\] GET \/orders\/:id returns total\n {8}check: e2e-http/);
    assert.match(r.stdout, /AC2 {2}\[db [0-9.]+\] total stored in orders\.total column\n {8}check: e2e-db/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acceptance: intake -> brief -> phase tests -> writeup with every criterion mapped (evidence is a fabricated fixture); no ticket key or secret in the log', (t) => {
  if (!which('git')) return t.skip('git not found on PATH');
  if (!fs.existsSync(CLI)) return t.skip('dist/src/cli.js missing: run npm run build first');
  const root = tempRoot();
  try {
    const home = path.join(root, 'home', '.harness');
    fs.mkdirSync(home, { recursive: true });
    const repo = path.join(root, 'ws', 'orders-api');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'orders-api', scripts: { test: 'node --test' } }, null, 2));
    fs.writeFileSync(path.join(repo, 'src', 'orders.ts'), 'export function total(): number {\n  return 0;\n}\n');
    git(repo, ['init', '-q', '-b', 'feature/order-total']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ version: 1, setting: 'team', agents: ['devin'], workspaceRoot: path.dirname(repo), repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }], db: { allowlist: [] }, mcp: { allowedServers: {} }, caps: { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8 }, include: [], reviews: { source: 'none' }, createdAt: now, updatedAt: now }, null, 2),
    );
    const ticketFile = path.join(root, 'ticket.txt');
    fs.writeFileSync(ticketFile, TICKET);

    // 1. intake from a file, run from the repo
    const intake = cli(root, ['intake', '--from', ticketFile], repo);
    assert.equal(intake.code, 0, intake.stderr + intake.stdout);
    const id = /Brief (t-[0-9a-f]{10})/.exec(intake.stdout)![1];
    const repoId = repoIdFor(repo);
    const brief = JSON.parse(fs.readFileSync(path.join(home, 'briefs', `${id}.json`), 'utf8'));
    assert.equal(brief.criteria.length, 4);
    assert.deepEqual(
      brief.criteria.map((c: { kind: string }) => c.kind),
      ['api', 'db', 'ui-artifact', 'unit'],
    );
    assert.ok(brief.criteria.every((c: { check?: { redFirst?: boolean } }) => c.check?.redFirst === true), 'every criterion has a red-first check');
    assert.equal(brief.baseShas[repoId], base);
    assert.equal(fs.readFileSync(path.join(home, 'runs', repoId, 'current-task'), 'utf8').trim(), id);
    assert.match(intake.stdout, /npm test -- --test-name-pattern "AC4:"/);

    // 2. tests phase, a test file and code change, implement phase
    const ph = cli(root, ['phase', 'tests'], repo);
    assert.equal(ph.code, 0, ph.stderr);
    fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'test', 'round.test.ts'), "test('AC4: rounds half up', () => {});\n");
    assert.equal(cli(root, ['phase', 'implement'], repo).code, 0);
    fs.writeFileSync(path.join(repo, 'src', 'orders.ts'), 'export function total(): number {\n  return 42;\n}\n');
    const status = JSON.parse(cli(root, ['phase', 'status', '--json'], repo).stdout);
    assert.equal(status.phase, 'implement');
    assert.equal(status.testsEntries, 1);

    // 3. fabricated evidence fixture standing in for a gate run (the gate is another component)
    const run1 = path.join(home, 'runs', repoId, id);
    const tree = writeTree(repo)!; // the fixture claims the current tree, as a fresh gate run would
    fs.mkdirSync(path.join(run1, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(run1, 'e2e', 'AC1-http.json'), '{}');
    fs.writeFileSync(path.join(run1, 'e2e', 'AC2-db.json'), '{}');
    const fixture = {
      version: 1,
      repo: repoId,
      task: id,
      verdict: 'PASS',
      reasons: [],
      treeHash: tree,
      baseSha: base,
      steps: [
        { name: 'build', status: 'pass', durationMs: 1 },
        { name: 'acceptance AC4', status: 'pass', durationMs: 1 },
      ],
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      e2e: [
        { id: 'AC1-http', kind: 'http', path: path.join(run1, 'e2e', 'AC1-http.json'), treeHash: tree, createdAt: now },
        { id: 'AC2-db', kind: 'db', path: path.join(run1, 'e2e', 'AC2-db.json'), treeHash: tree, createdAt: now },
      ],
    };
    fs.writeFileSync(path.join(run1, 'evidence.json'), JSON.stringify(fixture));

    // 4. the write-up
    const w = cli(root, ['writeup'], repo);
    assert.equal(w.code, 0, w.stderr);
    const saved = fs.readFileSync(path.join(run1, 'writeup.md'), 'utf8');
    for (const cid of ['AC1', 'AC2', 'AC3', 'AC4']) assert.match(saved, new RegExp(`^\\| ${cid} .+ \\| (e2e-http|e2e-db|manual|unit): .+ \\| .+ \\| .+ \\|$`, 'm'), `${cid} is in the verification table with its check`);
    assert.match(saved, /\| AC1 .* \| PASS \| e2e\/AC1-http\.json \|/);
    assert.match(saved, /\| AC2 .* \| PASS \| e2e\/AC2-db\.json \|/);
    assert.match(saved, /\| AC3 .* \| manual: no artifact linked \| - \|/);
    assert.match(saved, /\| AC4 .* \| PASS \| - \|/);
    assert.doesNotMatch(saved, /older tree/);
    assert.match(saved, /- `src\/orders\.ts` modified \(\+1 -1\)/);
    assert.match(saved, /- `test\/round\.test\.ts` new, untracked/);
    assert.match(saved, /entered 1 time\(s\)/);
    assert.match(saved, /Branch: `feature\/order-total`/);
    assert.ok(!saved.includes(TOKEN), 'token redacted in the write-up');
    assert.ok(!saved.includes(root), 'no local temp paths in the write-up');

    // 5. the instrumentation log carries names, ids and counts only
    const log = fs.readFileSync(path.join(home, 'logs', 'events.jsonl'), 'utf8');
    for (const ev of ['intake.brief', 'phase.set', 'writeup.render']) assert.match(log, new RegExp(`"event":"${ev.replace('.', '\\.')}"`));
    assert.doesNotMatch(log, /SHOP-142/);
    assert.ok(!log.includes(TOKEN));
    assert.doesNotMatch(log, /order total|orders\.total|rounding helper/i);
    for (const line of log.trim().split('\n')) JSON.parse(line);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
