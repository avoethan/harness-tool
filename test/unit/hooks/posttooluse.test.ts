import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handle } from '../../../src/hooks/PostToolUse';
import { editsOf, shellWrites, applyPatchPaths } from '../../../src/hooks/editlog';
import { lintFile, resolveRepoBin } from '../../../src/hooks/lint';
import { stagingCommands } from '../../../src/hooks/staging';
import { useLedgerChecks } from '../../../src/hooks/standards';
import { renderOutput } from '../../../src/hook';
import { loadSession } from '../../../src/lib/session';
import { repoIdFor } from '../../../src/lib/config';
import { ctxFor, events, git, lintRepo, makeRepo, payload, record, sandbox, writeFile, writeLedger, type Sandbox } from './helpers';

let sb: Sandbox;
let repo: string;
let repoId: string;

before(() => {
  sb = sandbox('harness-post-');
  repo = lintRepo(path.join(sb.tmp, 'svc'));
  repoId = repoIdFor(repo);
  writeLedger([
    record('logging.no-console', repoId, {
      statement: 'Log through the repo logger; never console.log in src.',
      family: 'logging',
      tier: 'counted-strong',
      check: { type: 'eslint', mode: 'block', ref: 'no-console', fixText: 'Replace console.log with logger.info.' },
    }),
    record('format.prettier', repoId, { statement: 'Files are formatted with the repo Prettier config.', family: 'format', tier: 'declared', check: { type: 'config', mode: 'block', ref: 'prettier' } }),
  ]);
});
after(() => sb.restore());

test('edit log: Claude Edit, Codex apply_patch and Devin edit payloads all land in the session log with the repo id', async () => {
  const f = writeFile(repo, 'src/ok2.ts', 'export const ok2 = 2;\n');
  await handle(payload.claudeEdit('post-claude', f, repo), ctxFor('claude', 'PostToolUse', 'post-claude'));
  assert.deepEqual(loadSession('post-claude').edits.map((e) => [e.path, e.repo]), [[f, repoId]]);

  await handle(payload.codexPatch('post-codex', ['src/ok.ts', 'src/new.ts'], repo), ctxFor('codex', 'PostToolUse', 'post-codex'));
  assert.deepEqual(loadSession('post-codex').edits.map((e) => path.relative(repo, e.path)).sort(), ['src/new.ts', 'src/ok.ts']);

  await handle(payload.devinEdit('post-devin', path.join(repo, 'src', 'ok.ts'), repo), ctxFor('devin', 'PostToolUse', 'post-devin'));
  const d = loadSession('post-devin');
  assert.equal(d.edits.length, 1);
  assert.equal(d.edits[0].repo, repoId);
  assert.equal(d.agent, 'devin');
});

test('edit log: relative paths resolve against cwd; paths outside any repo or in the harness state are not logged', async () => {
  await handle({ ...payload.claudeWrite('post-rel', 'src/rel.ts', repo) }, ctxFor('claude', 'PostToolUse', 'post-rel'));
  assert.equal(loadSession('post-rel').edits[0].path, path.join(repo, 'src', 'rel.ts'));
  const loose = path.join(sb.tmp, 'loose', 'x.txt');
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  await handle(payload.claudeWrite('post-loose', loose, sb.tmp), ctxFor('claude', 'PostToolUse', 'post-loose'));
  await handle(payload.claudeWrite('post-loose', path.join(sb.hh, 'state', 'x.json'), sb.tmp), ctxFor('claude', 'PostToolUse', 'post-loose'));
  assert.equal(loadSession('post-loose').edits.length, 0);
});

test('edit log: shell commands that write are logged, read-only ones are not; every shell call is counted', async () => {
  await handle(payload.bash('post-sh', 'ls -la && cat README.md', repo), ctxFor('claude', 'PostToolUse', 'post-sh'));
  let s = loadSession('post-sh');
  assert.equal(s.edits.length, 0);
  assert.equal(s.shellRuns, 1);
  await handle(payload.bash('post-sh', 'echo hi > src/out.txt', repo), ctxFor('claude', 'PostToolUse', 'post-sh'));
  await handle(payload.bash('post-sh', "sed -i 's/a/b/' src/ok.ts", repo, 'exec'), ctxFor('devin', 'PostToolUse', 'post-sh'));
  s = loadSession('post-sh');
  assert.deepEqual(s.edits.map((e) => path.relative(repo, e.path)).sort(), ['src/ok.ts', 'src/out.txt']);
  assert.equal(s.shellRuns, 3);
});

test('shellWrites and applyPatchPaths read the usual write shapes', () => {
  const cwd = '/w/r';
  assert.deepEqual(shellWrites('cd sub && sed -i -e s/a/b/ -e s/c/d/ x.ts', cwd), ['/w/r/sub/x.ts']);
  assert.deepEqual(shellWrites('echo x | tee -a log.txt', cwd), ['/w/r/log.txt']);
  assert.deepEqual(shellWrites('git -C ../other checkout -- a.ts', cwd), ['/w/other']);
  assert.deepEqual(shellWrites('bash -c "echo x > f.txt"', cwd), ['/w/r/f.txt']);
  assert.deepEqual(shellWrites('npx prettier --write src/a.ts', cwd), ['/w/r/src/a.ts']);
  assert.deepEqual(shellWrites('npm install', cwd), ['/w/r']);
  assert.deepEqual(shellWrites('cat a.ts 2>/dev/null; ls > /dev/null', cwd), []);
  assert.deepEqual(shellWrites("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch\nEOF", cwd), ['/w/r/n.ts']);
  assert.deepEqual(applyPatchPaths('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** Delete File: c.ts\n*** End Patch'), ['a.ts', 'b.ts', 'c.ts']);
});

test('lint: the repo\'s own (fake) ESLint runs on the one edited file and the note names the standard and its fix, once per rule', async () => {
  const f = writeFile(repo, 'src/bad.ts', 'export function f() {\n  console.log("x");\n}\n');
  const r = await handle(payload.claudeEdit('post-lint', f, repo), ctxFor('claude', 'PostToolUse', 'post-lint'));
  assert.equal(r.exitCode, 0, 'never blocks');
  const ctx = String(r.additionalContext);
  assert.match(ctx, /harness lint feedback for src\/bad\.ts/);
  assert.match(ctx, /eslint no-console \(line 2\): Unexpected console statement\./);
  assert.match(ctx, /Standard logging\.no-console: Log through the repo logger; never console\.log in src\. Fix: Replace console\.log with logger\.info\./);
  assert.ok(ctx.split('\n').length <= 20);
  const out = renderOutput('claude', 'PostToolUse', r) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');

  // Same rule again in the same session and repo: not injected again.
  const g = writeFile(repo, 'src/bad2.ts', 'console.log(1);\n');
  const again = await handle(payload.claudeEdit('post-lint', g, repo), ctxFor('claude', 'PostToolUse', 'post-lint'));
  assert.equal(again.additionalContext, undefined);
  // A different rule in the same file is new.
  const h = writeFile(repo, 'src/bad3.ts', 'var x = 1;\nconsole.log(x);\n');
  const third = await handle(payload.claudeEdit('post-lint', h, repo), ctxFor('claude', 'PostToolUse', 'post-lint'));
  assert.match(String(third.additionalContext), /no-var/);
  assert.doesNotMatch(String(third.additionalContext), /no-console/);
  const s = loadSession('post-lint');
  assert.ok(s.injected[repoId].includes('logging.no-console'));
  assert.ok(s.notes && s.notes.some((n) => n.rule === 'logging.no-console' && n.file === 'src/bad.ts'));
  // A new session hears about it again.
  const fresh = await handle(payload.claudeEdit('post-lint-2', g, repo), ctxFor('claude', 'PostToolUse', 'post-lint-2'));
  assert.match(String(fresh.additionalContext), /no-console/);
  const ev = events().filter((e) => e.event === 'post.tool');
  assert.ok(ev.length > 0);
  for (const e of ev) assert.deepEqual(Object.keys(e).sort(), ['agent', 'counts', 'event', 'ids', 'sessionId', 'ts']);
});

test('lint: the formatter check maps to the format standard', async () => {
  const f = writeFile(repo, 'src/fmt.ts', 'export const UNFORMATTED = 1;\n');
  const r = await handle(payload.devinEdit('post-fmt', f, repo), ctxFor('devin', 'PostToolUse', 'post-fmt'));
  assert.match(String(r.additionalContext), /prettier prettier\/format/);
  assert.match(String(r.additionalContext), /Standard format\.prettier/);
});

test('lint: an ESLint config with uncommitted changes is never run; the note says why', async () => {
  const other = lintRepo(path.join(sb.tmp, 'svc-untrusted'));
  writeFile(other, 'eslint.config.mjs', 'export default [{ rules: { "no-console": "off" } }];\n');
  const f = writeFile(other, 'src/bad.ts', 'console.log(1);\n');
  const r = await handle(payload.claudeEdit('post-untrusted', f, other), ctxFor('claude', 'PostToolUse', 'post-untrusted'));
  assert.match(String(r.additionalContext), /eslint: skipped: eslint\.config\.mjs is untracked or has uncommitted changes/);
  assert.ok(!fs.existsSync(path.join(other, '.fake-eslint-ran')), 'the fake ESLint did not run');
});

test('lint: editing the lint config itself never runs it', async () => {
  const runs = await lintFile(path.join(repo, 'eslint.config.mjs'), repo);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'skipped');
});

test('lint: a repo without ESLint installed reports it as absent, not silently', async () => {
  const bare = makeRepo(path.join(sb.tmp, 'bare'), { 'eslint.config.mjs': 'export default [];\n', 'a.ts': 'console.log(1);\n' });
  const runs = await lintFile(path.join(bare, 'a.ts'), bare);
  assert.ok(runs.some((r) => r.tool === 'eslint' && r.status === 'absent'));
  assert.equal(resolveRepoBin(bare, bare, 'eslint', 'eslint'), null);
});

test('lint: .sql files with no SQL linter installed are reported as absent', async () => {
  const f = writeFile(repo, 'db/0001.sql', 'select 1;\n');
  const runs = await lintFile(f, repo);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'absent');
});

test('lint: a real ESLint, when one is installed for the harness, is resolved the same way', (t) => {
  const pkgRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const real = resolveRepoBin(pkgRoot, pkgRoot, 'eslint', 'eslint');
  if (!real) return t.skip('skipped: no real ESLint in node_modules (the harness has no ESLint dependency and tests install nothing)');
  assert.equal(real.cmd, process.execPath);
});

test('ledger checks: runLedgerChecks findings are injected with the standard text, once per rule', async () => {
  writeLedger([
    record('errors.http-error', repoId, { statement: 'Throw HttpError for HTTP failures.', tier: 'declared', check: { type: 'ast-grep', mode: 'block', ref: 'http-error', fixText: 'Use new HttpError(status, message).' } }),
  ]);
  const seen: string[][] = [];
  useLedgerChecks((o) => {
    seen.push(o.files);
    return [{ ruleId: 'errors.http-error', file: o.files[0], line: 3 }];
  });
  try {
    const f = writeFile(repo, 'src/route.ts', 'export const r = 1;\n');
    const r = await handle(payload.claudeEdit('post-ledger', f, repo), ctxFor('claude', 'PostToolUse', 'post-ledger'));
    assert.deepEqual(seen, [[f]], 'one file, the edited one');
    assert.match(String(r.additionalContext), /standard errors\.http-error \(line 3\): Throw HttpError for HTTP failures\. Fix: Use new HttpError/);
    const again = await handle(payload.claudeEdit('post-ledger', f, repo), ctxFor('claude', 'PostToolUse', 'post-ledger'));
    assert.equal(again.additionalContext, undefined);
  } finally {
    useLedgerChecks(undefined);
  }
});

test('staging check: after git add, staged secret and harness-shaped paths are named (team setting)', async () => {
  const team = makeRepo(path.join(sb.tmp, 'team'), { 'a.ts': 'export {};\n' });
  writeFile(team, '.env', 'API_TOKEN=abc\n');
  writeFile(team, 'AGENTS.md', '# agents\n');
  writeFile(team, 'b.ts', 'export {};\n');
  git(team, 'add', '-A');
  const r = await handle(payload.bash('post-stage', 'git add -A', team), ctxFor('claude', 'PostToolUse', 'post-stage'));
  const ctx = String(r.additionalContext);
  assert.match(ctx, /harness staging check/);
  assert.match(ctx, /\.env is staged/);
  assert.match(ctx, /AGENTS\.md is staged/);
  assert.doesNotMatch(ctx, /b\.ts/);
  const ev = events().filter((e) => e.event === 'post.tool' && e.sessionId === 'post-stage');
  assert.equal((ev[ev.length - 1].counts as Record<string, number>).staged, 2);
});

test('staging check: commands are recognised with -C, cd and commit -a', () => {
  assert.deepEqual(stagingCommands('git -C sub add x', '/r'), [{ kind: 'add', dir: '/r/sub' }]);
  assert.deepEqual(stagingCommands('cd x && git commit -am msg', '/r'), [{ kind: 'commit-all', dir: '/r/x' }]);
  assert.deepEqual(stagingCommands('git commit -m msg', '/r'), []);
  assert.deepEqual(stagingCommands('git status', '/r'), []);
});

test('a broken payload never throws and never blocks', async () => {
  const r = await handle({ session_id: 'post-broken', tool_name: 'Edit', tool_input: null }, ctxFor('claude', 'PostToolUse', 'post-broken'));
  assert.equal(r.exitCode, 0);
  const r2 = await handle({} as never, ctxFor('codex', 'PostToolUse', 'post-broken'));
  assert.equal(r2.exitCode, 0);
});

test('an edit to a path with hidden Unicode is still logged (as the repo root), so Stop still gates it', async () => {
  const f = writeFile(repo, 'src/a​b.ts', 'export {};\n');
  const r = await handle(payload.claudeWrite('post-hidden', f, repo), ctxFor('claude', 'PostToolUse', 'post-hidden'));
  assert.equal(r.exitCode, 0);
  const s = loadSession('post-hidden');
  assert.equal(s.edits.length, 1);
  assert.equal(s.edits[0].path, repo);
  assert.equal(s.edits[0].repo, repoId);
  const { handle: stop } = await import('../../../src/hooks/Stop');
  const st = await stop({ session_id: 'post-hidden' }, ctxFor('claude', 'Stop', 'post-hidden'));
  assert.equal(st.exitCode, 2);
});

test('editsOf ignores .git internals', () => {
  const hits = editsOf(payload.claudeWrite('x', path.join(repo, '.git', 'config'), repo));
  assert.equal(hits.length, 0);
});
