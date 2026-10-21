/**
 * Acceptance: the team setting end to end on the team stand-in.
 *
 *   1. the stand-in workspace with its database (`setup.js <tmp>/shop --db-name test_it<hex>`);
 *   2. the real install for devin, claude and codex into the stand-in's fake HOME
 *      (`harness install --setting team --agents devin,claude,codex --yes --db-test localhost,<port>`):
 *      every file where its agent loads it, nothing inside the three repositories,
 *      every changed file in the manifest, doctor (hooks for all three agents, the
 *      database allowlist, integrity), status;
 *   4. the round trip: a second install is a no-op plan; `undo` restores every file
 *      (hashes equal the backups, the fake HOME and the workspace as before); install
 *      again, a no-op again; `uninstall` leaves the fake HOME and the workspace as before;
 *   3. behind HARNESS_RUN_CLAUDE=1: one trap ticket (T02) driven by Claude Code headless
 *      through a fresh install, with tight caps; the harness invariants are asserted
 *      (a brief, a gate run, nothing committed, nothing harness-shaped inside the repo)
 *      and the outcome (verdict, turns, cost) is printed, whatever it is.
 *
 * Environment (skips with the reason when a dependency is missing):
 *   HARNESS_STANDIN_TEAM          the team stand-in folder (setup.js, db/sqlcmd.js, tasks/)
 *   HARNESS_STANDIN_INSTALL=1     let setup.js run `npm ci` (needed for the Claude case; implied by it)
 *   HARNESS_RUN_CLAUDE=1          also drive the ticket with `claude -p`
 *   HARNESS_CLAUDE_MODEL          model for that run (default claude-sonnet-5-5)
 *   HARNESS_STANDIN_DB_PASSWORD   password of the throw-away test container (default: the stand-in's documented one)
 *   HARNESS_KEEP_SCRATCH=1        keep the scratch folder for inspection
 *
 * Docker must answer and a SQL Server container must be running (the stand-in's
 * `harness-standin-mssql`). The test's own database is dropped at the end.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, which } from '../../src/lib/exec';
import { sqlServerContainers } from '../../src/verify/sqlcmd';
import { claudeAvailable, copyClaudeLogin } from '../behaviour/claude-runner';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');
const REPOS = ['catalog-api', 'orders-api', 'fulfillment'];
const AGENTS_FILES = ['.config/devin/AGENTS.md', '.claude/CLAUDE.md', '.codex/AGENTS.md'];
const SKILLS = ['task', 'learn', 'setup'];
/** Claude Code's own runtime files in a HOME it ran in; never the harness's, never compared. */
const CLAUDE_RUNTIME = [/^\.claude\.json/, /^\.claude\/(projects|todos|shell-snapshots|statsig|session-env|plugins|file-history|ide|backups)\//, /^\.cache\//, /^\.npm\//];

type Snap = Map<string, string>;

/** sha256 of every file (and a marker for every folder) under root; node_modules and .git internals hashed by git status instead. */
function snapshot(root: string, skip: (rel: string) => boolean = () => false): Snap {
  const out: Snap = new Map();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skip(rel) || skip(rel + '/')) continue;
      if (e.isDirectory()) {
        out.set(rel + '/', 'dir');
        walk(abs);
      } else if (e.isFile()) out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

function diff(a: Snap, b: Snap): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  return { added, removed, changed };
}

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const homeSkip = (rel: string) => rel.startsWith('.harness/') || CLAUDE_RUNTIME.some((r) => r.test(rel));

test('integration (team setting): stand-in with database, install for three agents, round trip; Claude-driven ticket behind HARNESS_RUN_CLAUDE=1', async (t) => {
  const standin = process.env.HARNESS_STANDIN_TEAM;
  if (!standin) return t.skip('HARNESS_STANDIN_TEAM is not set (path to the team stand-in folder; see test/acceptance/README.md)');
  if (!fs.existsSync(path.join(standin, 'setup.js'))) return t.skip(`HARNESS_STANDIN_TEAM=${standin} has no setup.js`);
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI} (run npm run build)`);
  if (!which('git')) return t.skip('git is not on PATH');
  if (!which('docker')) return t.skip('docker is not on PATH (the stand-in database runs in a SQL Server container)');
  if (run('docker', ['info'], { timeoutMs: 20_000 }).code !== 0) return t.skip('the Docker daemon does not answer (start it, then the SQL Server container)');
  const containers = sqlServerContainers();
  if (!containers.length) return t.skip('no SQL Server container is running (start harness-standin-mssql as the stand-in README says)');
  const port = containers[0].hostPorts[0] ?? '1433';
  const withClaude = process.env.HARNESS_RUN_CLAUDE === '1';
  const claude = withClaude ? claudeAvailable() : null;

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-it-team-')));
  const ws = path.join(tmp, 'shop');
  const fake = path.join(tmp, 'rough-harness-home');
  const dbName = `test_it${crypto.randomBytes(3).toString('hex')}`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fake, USERPROFILE: fake, HARNESS_USER_HOME: fake, HARNESS_HOME: path.join(fake, '.harness'), XDG_CONFIG_HOME: path.join(fake, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  const cli = (args: string[], cwd = tmp, timeoutMs = 600_000) => {
    const t0 = Date.now();
    const r = run(process.execPath, [CLI, ...args], { cwd, env, timeoutMs });
    return { ...r, ms: Date.now() - t0 };
  };
  const installArgs = ['install', '--setting', 'team', '--agents', 'devin,claude,codex', '--workspace', ws, '--yes', '--db-test', `localhost,${port}`];
  // trailing whitespace only: a porcelain line starts with a status column that may be a space (" M src/x.ts")
  const gitStatus = (repo: string) => run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: path.join(ws, repo), timeoutMs: 30_000 }).stdout.replace(/\s+$/, '');
  const heads: Record<string, string> = {};

  try {
    // ------------------------------------------------------------------ step 1
    await t.test('step 1: the stand-in workspace with its database', () => {
      const setupArgs = [path.join(standin, 'setup.js'), ws, '--db-name', dbName];
      if (process.env.HARNESS_STANDIN_INSTALL !== '1' && !withClaude) setupArgs.push('--no-install');
      const t0 = Date.now();
      const r = run(process.execPath, setupArgs, { cwd: standin, timeoutMs: 900_000 });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /repos created: 3\/3/);
      assert.match(r.stdout, new RegExp(`db: ${dbName}`));
      for (const repo of REPOS) {
        assert.equal(gitStatus(repo), '', `${repo} starts clean`);
        heads[repo] = run('git', ['rev-parse', 'HEAD'], { cwd: path.join(ws, repo), timeoutMs: 20_000 }).stdout.trim();
      }
      assert.ok(fs.existsSync(path.join(fake, '.claude', 'CLAUDE.md')), 'the rough harness is in the fake HOME');
      t.diagnostic(`setup: ${Date.now() - t0} ms, database ${dbName}, ${process.env.HARNESS_STANDIN_INSTALL === '1' || withClaude ? 'with' : 'without'} npm ci`);
    });

    const homeBefore = snapshot(fake, homeSkip);
    const wsBefore = snapshot(ws);

    // ------------------------------------------------------------------ step 2
    let planId = '';
    await t.test('step 2: the real install for three agents; placement, repos untouched, manifest, doctor, integrity, status', () => {
      const r = cli([...installArgs, '--json']);
      assert.equal(r.code, 0, r.stdout.slice(-3000) + r.stderr.slice(-2000));
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      planId = j.plan;
      assert.equal(j.applied, true);
      t.diagnostic(`install: ${r.ms} ms, plan ${planId}, ${j.targets} file(s)`);

      // every file where its agent loads it (RESEARCH section 7)
      for (const f of AGENTS_FILES) {
        const p = path.join(fake, f);
        assert.ok(fs.existsSync(p), `missing ${f}`);
        assert.ok(fs.statSync(p).size <= 4096, `${f} is ${fs.statSync(p).size} bytes (limit 4096)`);
        assert.match(fs.readFileSync(p, 'utf8'), /harness gate/, `${f} carries the harness instructions`);
      }
      for (const s of SKILLS) {
        assert.ok(fs.existsSync(path.join(fake, '.claude', 'skills', s, 'SKILL.md')), `claude skill ${s}`);
        assert.ok(fs.existsSync(path.join(fake, '.agents', 'skills', s, 'SKILL.md')), `devin/codex skill ${s}`);
      }
      for (const repo of REPOS) {
        assert.ok(fs.existsSync(path.join(fake, '.devin', 'rules', `${repo}.md`)), `devin rules ${repo}`);
        assert.ok(fs.existsSync(path.join(fake, '.claude', 'rules', `${repo}.md`)), `claude rules ${repo}`);
      }
      const devin = JSON.parse(fs.readFileSync(path.join(fake, '.config', 'devin', 'config.json'), 'utf8'));
      const claudeSettings = JSON.parse(fs.readFileSync(path.join(fake, '.claude', 'settings.json'), 'utf8'));
      const codexHooks = JSON.parse(fs.readFileSync(path.join(fake, '.codex', 'hooks.json'), 'utf8'));
      assert.ok(devin.hooks && devin.permissions, 'devin hooks and permissions');
      assert.ok(claudeSettings.hooks?.PreToolUse && claudeSettings.hooks?.Stop && claudeSettings.permissions?.deny?.length, 'claude hooks and rules');
      assert.ok(codexHooks.hooks?.PreToolUse, 'codex hooks');
      assert.match(fs.readFileSync(path.join(fake, '.codex', 'rules', 'harness.rules'), 'utf8'), /prefix_rule\(pattern=\["git", "push", "--force"/);
      const cliPath = path.join(path.dirname(CLI), 'cli.js').split(path.sep).join('/');
      for (const spelling of [`node "${cliPath}" gate *`, `node ${cliPath} gate *`]) assert.ok(claudeSettings.permissions.allow.includes(`Bash(${spelling})`), `allow rule ${spelling}`);

      // nothing inside the three repositories
      for (const repo of REPOS) assert.equal(gitStatus(repo), '', `${repo}: the install wrote inside the repository`);
      const wsDiff = diff(wsBefore, snapshot(ws));
      assert.deepEqual([...wsDiff.added, ...wsDiff.removed], [], 'no file added or removed in the workspace');
      assert.deepEqual(wsDiff.changed, ['AGENTS.md'], 'only the parent-folder AGENTS.md (the user\'s file, a proposal) changed');

      // the manifest lists every file
      const manifest = JSON.parse(fs.readFileSync(path.join(fake, '.harness', 'manifest.json'), 'utf8'));
      const listed = new Set<string>(manifest.files.map((f: { path: string }) => path.resolve(f.path)));
      const homeDiff = diff(homeBefore, snapshot(fake, homeSkip));
      const touched = [...homeDiff.added, ...homeDiff.changed].filter((p) => !p.endsWith('/')).map((p) => path.resolve(fake, p));
      touched.push(path.join(ws, 'AGENTS.md'));
      const missing = touched.filter((p) => !listed.has(p));
      assert.deepEqual(missing, [], 'every file the install touched is in the manifest');
      t.diagnostic(`placement ok; workspace: 1 file changed (AGENTS.md); fake HOME: ${homeDiff.added.filter((p) => !p.endsWith('/')).length} added, ${homeDiff.changed.length} changed; manifest ${manifest.files.length} file(s), ${missing.length} missing`);

      // doctor, integrity, status
      const doc = cli(['doctor']);
      assert.match(doc.stdout, /ok\s+hooks:devin/);
      assert.match(doc.stdout, /ok\s+hooks:claude/);
      assert.match(doc.stdout, /ok\s+hooks:codex/);
      assert.match(doc.stdout, new RegExp(`ok\\s+db-allowlist\\s+localhost,${port}=test`));
      assert.match(doc.stdout, /ok\s+integrity\s+integrity manifest matches/);
      const sum = /(\d+) ok, (\d+) warnings?, (\d+) failures?/.exec(doc.stdout);
      assert.ok(sum && sum[3] === '0', `doctor failures: ${doc.stdout.slice(-1500)}`);
      const integrity = JSON.parse(fs.readFileSync(path.join(fake, '.harness', 'integrity.json'), 'utf8'));
      const hashed = Object.keys(integrity.files ?? integrity.hashes ?? integrity).length;
      assert.ok(hashed >= 10, `integrity manifest holds ${hashed} entries`);
      const st = cli(['status']);
      assert.equal(st.code, 0, st.stderr);
      assert.match(st.stdout, /team setting/);
      assert.match(st.stdout, /devin, claude, codex/);
      t.diagnostic(`doctor: ${sum?.[1]} ok, ${sum?.[2]} warnings, ${sum?.[3]} failures (${doc.ms} ms); integrity entries ${hashed}`);
    });

    // ------------------------------------------------------------------ step 4
    await t.test('step 4: install again is a no-op; undo restores every file; install, no-op, uninstall leaves the fake HOME as before', () => {
      assert.ok(planId, 'step 2 applied a plan');
      const again = cli([...installArgs, '--json']);
      assert.equal(again.code, 0, again.stderr);
      const ja = JSON.parse(again.stdout.slice(again.stdout.indexOf('{')));
      assert.equal(ja.targets, 0, `a second install is a no-op plan (got ${ja.targets} target(s))`);

      // undo: every file of the plan back to its before-state, hash-equal to its backup
      const recDir = path.join(fake, '.harness', 'backups', planId);
      const stamp = fs.readdirSync(recDir).sort().pop()!;
      const rec = JSON.parse(fs.readFileSync(path.join(recDir, stamp, 'manifest.json'), 'utf8'));
      const u = cli(['undo', '--plan', planId, '--yes']);
      assert.equal(u.code, 0, u.stdout + u.stderr);
      let compared = 0;
      for (const f of rec.files as Array<{ path: string; beforeSha: string | null; backup: string | null }>) {
        if (f.beforeSha === null) assert.equal(fs.existsSync(f.path), false, `${f.path} was created by the install and is gone`);
        else {
          assert.equal(sha(f.path), f.beforeSha, `${f.path} is back to its before-state`);
          if (f.backup) assert.equal(sha(f.path), sha(f.backup), `${f.path} hashes equal its backup`);
          compared++;
        }
      }
      const afterUndo = diff(homeBefore, snapshot(fake, homeSkip));
      assert.deepEqual(afterUndo, { added: [], removed: [], changed: [] }, 'the fake HOME is as before after undo');
      assert.deepEqual(diff(wsBefore, snapshot(ws)), { added: [], removed: [], changed: [] }, 'the workspace is as before after undo');
      t.diagnostic(`undo: ${rec.files.length} file(s) in the record, ${compared} restored from backups with equal hashes, the rest removed (${u.ms} ms)`);

      // install again, then a no-op, then uninstall
      const re = cli([...installArgs, '--json']);
      assert.equal(re.code, 0, re.stderr);
      const jr = JSON.parse(re.stdout.slice(re.stdout.indexOf('{')));
      assert.equal(jr.applied, true);
      assert.equal(jr.targets, rec.files.length, 'the re-install writes the same set of files');
      const noop = cli([...installArgs, '--json']);
      assert.equal(JSON.parse(noop.stdout.slice(noop.stdout.indexOf('{'))).targets, 0, 'and is a no-op the next time');
      const un = cli(['uninstall', '--yes']);
      assert.equal(un.code, 0, un.stdout + un.stderr);
      assert.deepEqual(diff(homeBefore, snapshot(fake, homeSkip)), { added: [], removed: [], changed: [] }, 'uninstall leaves the fake HOME as before (the state folder ~/.harness keeps its backups by design)');
      assert.deepEqual(diff(wsBefore, snapshot(ws)), { added: [], removed: [], changed: [] }, 'and the workspace');
      for (const repo of REPOS) assert.equal(gitStatus(repo), '', `${repo} clean after uninstall`);
      t.diagnostic(`round trip: no-op ${again.ms} ms; re-install ${jr.targets} file(s) ${re.ms} ms; uninstall ${un.ms} ms`);
    });

    // ------------------------------------------------------------------ step 3
    await t.test('step 3: one trap ticket (T02) driven by Claude Code headless through the installed harness', async (st) => {
      if (!withClaude) return st.skip('HARNESS_RUN_CLAUDE is not 1 (a real Claude Code run costs money; run it on purpose)');
      if (!claude || !claude.ok) return st.skip(`claude is not available: ${claude && !claude.ok ? claude.reason : 'unknown'}`);
      const ticketFile = path.join(standin, 'tasks', '02-low-stock', 'ticket.md');
      if (!fs.existsSync(ticketFile)) return st.skip(`no ticket at ${ticketFile}`);
      if (!fs.existsSync(path.join(ws, 'catalog-api', 'node_modules'))) return st.skip('catalog-api has no node_modules (setup.js ran with --no-install)');
      // a fresh install (step 4 uninstalled), the user's verify setting, the login
      const ins = cli(installArgs);
      assert.equal(ins.code, 0, ins.stderr);
      const cs = cli(['config', 'set', 'verify.db.snapshot', `db:${dbName}`, '--from-install']); // stands in for the user at a terminal
      assert.equal(cs.code, 0, cs.stderr);
      copyClaudeLogin(fake);
      const sqlcmdMod = require(path.join(standin, 'db', 'sqlcmd.js')) as { settings: () => { password: string } };
      const password = process.env.HARNESS_STANDIN_DB_PASSWORD ?? sqlcmdMod.settings().password;
      const prompt = `Here is a ticket for this repository. Work it through with the task skill, phase by phase, using the harness commands the skill names (if \`harness\` is not on your PATH, use the node form your instructions give). Do not commit and do not push. When you are done, show me the write-up.\n\n${fs.readFileSync(ticketFile, 'utf8')}`;
      const model = process.env.HARNESS_CLAUDE_MODEL ?? 'claude-sonnet-5-5';
      const cenv: NodeJS.ProcessEnv = { ...env, HARNESS_VERIFY_DB_PASSWORD: password, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1' };
      for (const k of ['CLAUDE_ADDITIONAL_DIRECTORIES', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_CODE_SYNC_SKILLS', 'CLAUDE_CODE_SYNC_PLUGINS']) delete cenv[k];
      const t0 = Date.now();
      const r = run('claude', ['-p', prompt, '--model', model, '--max-turns', '50', '--max-budget-usd', '1', '--permission-mode', 'default', '--allowedTools', 'Edit', 'Write', 'MultiEdit', '--output-format', 'json'], { cwd: path.join(ws, 'catalog-api'), env: cenv, timeoutMs: 1_500_000 });
      let j: { num_turns?: number; total_cost_usd?: number; subtype?: string; permission_denials?: unknown[] } = {};
      try {
        j = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}');
      } catch {
        /* reported below */
      }
      const events = fs.readFileSync(path.join(fake, '.harness', 'logs', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; ids?: Record<string, string> });
      const verdicts = events.filter((e) => e.event === 'gate.verdict').map((e) => e.ids?.verdict ?? '?');
      const count = (name: string) => events.filter((e) => e.event === name).length;
      st.diagnostic(`claude (${model}): exit ${r.code}, ${Math.round((Date.now() - t0) / 1000)} s, ${j.num_turns ?? '?'} turns, $${j.total_cost_usd ?? '?'}, ${j.subtype ?? 'no result'}; gate verdicts: ${verdicts.join(', ') || 'none'}; guard denies ${count('guard.deny')}; stop.pass ${count('stop.pass')} stop.block ${count('stop.block')}; Claude Code refusals ${(j.permission_denials ?? []).length}`);
      // harness invariants, whatever the model did
      assert.ok(count('intake.brief') >= 1, 'intake wrote a brief');
      assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: path.join(ws, 'catalog-api'), timeoutMs: 20_000 }).stdout.trim(), heads['catalog-api'], 'nothing was committed');
      const changed = gitStatus('catalog-api').split('\n').filter(Boolean).map((l) => l.slice(3));
      assert.ok(changed.every((p) => /^(src|test)\//.test(p)), `only product and test files changed in the repository: ${changed.join(', ')}`);
      for (const repo of ['orders-api', 'fulfillment']) assert.equal(gitStatus(repo), '', `${repo} untouched`);
      cli(['verify', 'cleanup'], path.join(ws, 'catalog-api')); // services and the run database, if the agent left them
    });
  } finally {
    try {
      const mod = require(path.join(standin, 'db', 'sqlcmd.js')) as { detect: () => unknown; runQuery: (t: unknown, db: string, sql: string) => unknown };
      if (/^test_it[0-9a-f]{6}$/.test(dbName)) mod.runQuery(mod.detect(), 'master', `IF DB_ID(N'${dbName}') IS NOT NULL BEGIN ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${dbName}]; END`);
    } catch (e) {
      t.diagnostic(`could not drop ${dbName}: ${(e as Error).message.slice(0, 200)}`);
    }
    if (process.env.HARNESS_KEEP_SCRATCH === '1') t.diagnostic(`scratch kept: ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
});
