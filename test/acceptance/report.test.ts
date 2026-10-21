/**
 * Acceptance: the code-free report on the team stand-in.
 *
 *   HARNESS_STANDIN_TEAM            the stand-in folder (setup.js); the test skips when unset
 *   HARNESS_STANDIN_TEAM_WORKSPACE  reuse a workspace setup.js already created
 *
 * In a temporary HARNESS_HOME, runs the real commands on the stand-in
 * workspace: discover, assess, intake (a ticket written here, mapped to the
 * first repository), gate (on that repository, with the brief's task), then
 * `harness report --json`, `--md`, `--check-scrub` and `harness status`.
 * Asserts the scrub passes with the stand-in's token set (and prints the
 * token count), the task row matches the brief and the evidence, and no
 * repository name or ticket word appears in either form of the report.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { packageRoot } from '../../src/lib/paths';
import { repoIdFor } from '../../src/lib/config';
import type { Report } from '../../src/types';

const CLI = path.join(packageRoot(), 'dist', 'src', 'cli.js');

function envFor(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: home, HARNESS_USER_HOME: path.dirname(home), GIT_TERMINAL_PROMPT: '0' };
  delete e.HARNESS_NO_INSTRUMENT;
  delete e.HARNESS_SESSION_ID;
  delete e.XDG_CONFIG_HOME;
  return e;
}

function cli(home: string, args: string[], cwd: string, timeoutMs = 600_000) {
  const t0 = Date.now();
  const r = run(process.execPath, [CLI, ...args], { cwd, env: envFor(home), timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ...r, ms: Date.now() - t0 };
}

test('acceptance: report on the team stand-in after discover, assess, intake and gate; the scrub passes with the stand-in token set', (t) => {
  const standin = process.env.HARNESS_STANDIN_TEAM;
  if (!standin) return t.skip('HARNESS_STANDIN_TEAM is not set (path to the team stand-in folder; see test/acceptance/README.md)');
  if (!fs.existsSync(path.join(standin, 'setup.js'))) return t.skip(`HARNESS_STANDIN_TEAM=${standin} has no setup.js`);
  if (!which('git')) return t.skip('git is not available on PATH');
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI} (run npm run build)`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-acc-report-')));
  try {
    const home = path.join(tmp, 'home', '.harness');
    fs.mkdirSync(home, { recursive: true });

    // 1. The workspace (no install, no database: the report needs neither).
    let ws = process.env.HARNESS_STANDIN_TEAM_WORKSPACE;
    if (!ws) {
      ws = path.join(tmp, 'workspace');
      const s = run(process.execPath, [path.join(standin, 'setup.js'), ws, '--no-db', '--no-install', '--harness-home', path.dirname(home)], { timeoutMs: 600_000 });
      assert.equal(s.code, 0, `setup.js failed: ${s.stderr.slice(-800)}`);
    } else t.diagnostic('reusing the workspace in HARNESS_STANDIN_TEAM_WORKSPACE');
    ws = fs.realpathSync(ws);
    const repos = fs
      .readdirSync(ws, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(ws!, d.name, '.git')))
      .map((d) => ({ id: repoIdFor(path.join(ws!, d.name)), name: d.name, path: path.join(ws!, d.name), isGit: true }));
    assert.ok(repos.length >= 2, `stand-in repositories: ${repos.length}`);
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ version: 1, setting: 'team', agents: ['devin', 'claude', 'codex'], workspaceRoot: ws, repos, db: { allowlist: [] }, mcp: { allowedServers: {} }, caps: { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8 }, include: [], reviews: { source: 'none' }, createdAt: now, updatedAt: now }, null, 2),
    );

    // 2. The real commands.
    const d = cli(home, ['discover', '--root', ws, '--json'], ws);
    assert.equal(d.code, 0, `discover: ${d.stderr.slice(-500)}`);
    const a = cli(home, ['assess', '--workspace', ws, '--setting', 'team', '--agents', 'devin,claude,codex', '--json'], ws);
    assert.equal(a.code, 0, `assess: ${a.stderr.slice(-500)}`);
    const target = repos[0];
    const ticketWord = 'pelicanrollup';
    const ticket = [
      `Title: Add a ${ticketWord} summary to the list endpoint`,
      'Acceptance Criteria:',
      `1. GET /items/summary returns the ${ticketWord} count as a number`,
      '2. The summary helper rounds half up to 2 decimals',
      '',
    ].join('\n');
    const ticketFile = path.join(tmp, 'ticket.txt');
    fs.writeFileSync(ticketFile, ticket);
    const i = cli(home, ['intake', '--from', ticketFile, '--repo', target.path, '--json'], target.path);
    assert.equal(i.code, 0, `intake: ${i.stderr.slice(-500)}`);
    const briefs = fs.readdirSync(path.join(home, 'briefs')).filter((f) => f.endsWith('.json'));
    assert.equal(briefs.length, 1);
    const brief = JSON.parse(fs.readFileSync(path.join(home, 'briefs', briefs[0]), 'utf8')) as { id: string; ticketHash: string; criteria: unknown[] };
    const g = cli(home, ['gate', '--task', brief.id, '--json'], target.path, 900_000);
    assert.ok(g.code === 0 || g.code === 1, `gate ran (exit ${g.code}): ${g.stderr.slice(-500)}`);
    const evidence = JSON.parse(fs.readFileSync(path.join(home, 'runs', target.id, brief.id, 'evidence.json'), 'utf8')) as { verdict: string; steps: Array<{ status: string }> };
    t.diagnostic(`discover ${d.ms} ms, assess ${a.ms} ms, intake ${i.ms} ms, gate ${g.ms} ms (verdict ${evidence.verdict}; the workspace has no node_modules, so declared tools are reported as not installed)`);

    // 3. The report.
    const j = cli(home, ['report', '--json'], tmp);
    assert.equal(j.code, 0, `report --json: ${j.stderr}`);
    const report = JSON.parse(j.stdout) as Report;
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'ledger', 'ledger.json'), 'utf8')) as { records: unknown[] };
    const assess = JSON.parse(fs.readFileSync(path.join(home, 'assess', 'assess.json'), 'utf8')) as { findings: unknown[] };
    assert.equal(Object.values(report.standards.byTier).reduce((n, x) => n + x, 0), ledger.records.length);
    assert.equal(Object.values(report.assessment.findingsByCheck).reduce((n, x) => n + x, 0), assess.findings.length);
    assert.equal(report.tasks.length, 1);
    const row = report.tasks[0];
    assert.equal(row.ticketHash, brief.ticketHash);
    assert.equal(row.criteria, brief.criteria.length);
    assert.equal(row.gateVerdict, evidence.verdict);
    assert.equal(row.checksRun, evidence.steps.filter((s) => s.status !== 'skip').length);
    assert.equal(row.gateRuns, 1);
    const md = cli(home, ['report', '--md'], tmp);
    assert.equal(md.code, 0, `report --md: ${md.stderr}`);
    assert.match(md.stdout, /## Standards by tier\n/);
    assert.match(md.stdout, /## Tasks\n/);
    for (const text of [j.stdout, md.stdout]) {
      for (const r of repos) assert.ok(!text.toLowerCase().includes(r.name.toLowerCase()), `repository name ${r.name} absent`);
      assert.ok(!text.includes(ticketWord), 'ticket word absent');
      assert.ok(!text.includes(ws), 'workspace path absent');
    }
    const sc = cli(home, ['report', '--check-scrub'], tmp);
    assert.equal(sc.code, 0, `scrub: ${sc.stdout}${sc.stderr}`);
    const m = /^scrub: ok\. (\d+) token\(s\) checked \(from (\d+) repo\(s\), (\d+) file path\(s\), (\d+) sampled source file\(s\), (\d+) brief\(s\); (\d+) dropped as the report's own words, (\d+) numeric, (\d+) too short\)/.exec(sc.stdout);
    assert.ok(m, sc.stdout);
    t.diagnostic(sc.stdout.trim());
    assert.ok(Number(m[1]) > 100, `tokens checked: ${m[1]}`);
    assert.equal(Number(m[5]), 1);
    const st = cli(home, ['status'], tmp);
    assert.equal(st.code, 0);
    assert.match(st.stdout, /harness status: team setting; agents devin, claude, codex/);
    assert.match(st.stdout, new RegExp(`Tasks {8}${evidence.verdict === 'PASS' ? '0 open, 1 passed' : '1 open, 0 passed'} the gate`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
