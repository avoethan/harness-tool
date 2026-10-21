import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handle as preCompact } from '../../../src/hooks/PreCompact';
import { handle as postCompaction } from '../../../src/hooks/PostCompaction';
import { handle as sessionEnd } from '../../../src/hooks/SessionEnd';
import { porcelainPaths, wipCommit } from '../../../src/hooks/pause';
import { trailPath } from '../../../src/runctl/trail';
import { loadSession, recordEdit, updateSession } from '../../../src/lib/session';
import { defaultConfig, repoIdFor, saveConfig } from '../../../src/lib/config';
import { ctxFor, git, makeRepo, record, sandbox, treeOf, writeEvidence, writeFile, writeLedger, type Sandbox } from './helpers';

let sb: Sandbox;

before(() => {
  sb = sandbox('harness-pause-');
});
after(() => sb.restore());

function personal(on: boolean) {
  if (on) saveConfig(defaultConfig({ setting: 'personal' }));
  else fs.rmSync(path.join(sb.hh, 'config.json'), { force: true });
}

function subjects(repo: string): string[] {
  return git(repo, 'log', '--format=%s').split('\n').filter(Boolean);
}

test('PreCompact writes the trail: intent from the brief, progress, verified state, next command, gotchas', async () => {
  const repo = makeRepo(path.join(sb.tmp, 'svc'), { 'src/a.ts': 'export const a = 1;\n' });
  const id = repoIdFor(repo);
  const sid = 'pause-trail';
  fs.mkdirSync(path.join(sb.hh, 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(sb.hh, 'briefs', 't-abc1234567.json'), JSON.stringify({ id: 't-abc1234567', title: 'Products list supports pagination' }));
  writeFile(repo, 'src/a.ts', 'export const a = 2;\n');
  recordEdit(sid, { path: path.join(repo, 'src', 'a.ts'), repo: id });
  recordEdit(sid, { path: path.join(repo, 'src', 'b.ts'), repo: id });
  writeEvidence(repo, 't-abc1234567', { verdict: 'FAIL', reasons: ['unit: 1 failing (products paging)'], treeHash: treeOf(repo) });
  writeLedger([record('logging.no-console', id, { statement: 'Use the logger.', check: { type: 'eslint', mode: 'block', ref: 'no-console', fixText: 'logger.info' } })]);
  updateSession(sid, (s) => void (s.notes = [{ repo: id, rule: 'logging.no-console', file: 'src/a.ts', ts: new Date().toISOString() }]));
  const r = await preCompact({ session_id: sid, hook_event_name: 'PreCompact', trigger: 'auto', cwd: repo }, ctxFor('claude', 'PreCompact', sid));
  assert.equal(r.exitCode, 0);
  const text = fs.readFileSync(trailPath('t-abc1234567'), 'utf8');
  assert.match(text, /^status: open$/m);
  assert.ok(text.includes(`repo: ${repo}`));
  assert.match(text, /## Intent\nProducts list supports pagination/);
  assert.match(text, /2 edits to 2 files in the last session/);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /Last gate verdict: FAIL/);
  assert.match(text, /unit: 1 failing \(products paging\)/);
  assert.match(text, /Inherited verified claims are never trusted/);
  assert.match(text, /## Next\nFix the failures listed above, then run `harness gate --repo/);
  assert.match(text, /logging\.no-console in src\/a\.ts: Use the logger\. Fix: logger\.info/);
  assert.doesNotMatch(text, /Pause commit/, 'team setting: no pause-commit section');
  assert.equal(subjects(repo).length, 1, 'team setting: no commit');
});

test('the trail keeps earlier sessions\' progress for the same task', async () => {
  const repo = makeRepo(path.join(sb.tmp, 'svc2'), { 'x.ts': '1\n' });
  const id = repoIdFor(repo);
  fs.mkdirSync(path.join(sb.hh, 'runs', id), { recursive: true });
  fs.writeFileSync(path.join(sb.hh, 'runs', id, 'current-task'), 't-keep\n');
  recordEdit('pause-s1', { path: path.join(repo, 'first.ts'), repo: id });
  await preCompact({ session_id: 'pause-s1', cwd: repo }, ctxFor('codex', 'PreCompact', 'pause-s1'));
  recordEdit('pause-s2', { path: path.join(repo, 'second.ts'), repo: id });
  await sessionEnd({ session_id: 'pause-s2', cwd: repo }, ctxFor('codex', 'SessionEnd', 'pause-s2'));
  const text = fs.readFileSync(trailPath('t-keep'), 'utf8');
  assert.match(text, /first\.ts/);
  assert.match(text, /second\.ts/);
  assert.match(text, /No gate evidence for this task yet/);
});

test('wip: pause commit happens off main in the personal setting, never on main', async () => {
  personal(true);
  try {
    const repo = makeRepo(path.join(sb.tmp, 'mine'), { 'a.ts': '1\n' });
    const id = repoIdFor(repo);
    // On main: no commit, even with changes.
    writeFile(repo, 'a.ts', '2\n');
    recordEdit('pause-main', { path: path.join(repo, 'a.ts'), repo: id });
    await preCompact({ session_id: 'pause-main', cwd: repo }, ctxFor('claude', 'PreCompact', 'pause-main'));
    assert.deepEqual(subjects(repo), ['init']);
    const trail = fs.readFileSync(trailPath(`adhoc-${id}`), 'utf8');
    assert.match(trail, /No pause commit: on main: a pause commit is never made on the main branch/);

    // On a feature branch: the commit is made, nothing is pushed.
    git(repo, 'checkout', '-q', '-b', 'feature/paging');
    writeFile(repo, 'b.ts', 'new\n');
    await sessionEnd({ session_id: 'pause-main', cwd: repo }, ctxFor('claude', 'SessionEnd', 'pause-main'));
    assert.deepEqual(subjects(repo), ['wip: pause', 'init']);
    assert.equal(git(repo, 'status', '--porcelain').trim(), '');
    assert.equal(git(repo, 'remote').trim(), '');
    const trail2 = fs.readFileSync(trailPath(`adhoc-${id}`), 'utf8');
    assert.match(trail2, /wip: pause commit [0-9a-f]+ on branch feature\/paging \(not pushed\)/);
    // SessionEnd closed the session.
    const s = loadSession('pause-main');
    assert.equal(s.status, 'closed');
    assert.ok(s.endedAt);

    // Nothing to commit: no empty commit.
    const w = wipCommit(repo, { session_id: 'x' }, ctxFor('claude', 'SessionEnd', 'x'), 'SessionEnd');
    assert.equal(w.made, false);
    assert.match(w.reason, /no uncommitted changes/);
  } finally {
    personal(false);
  }
});

test("the pause commit's subject follows the repository's commit-subject standard; a harness run session gets no pause commit at its end (the runner commits and pauses itself)", async () => {
  personal(true);
  const ledgerDir = path.join(sb.hh, 'ledger');
  fs.mkdirSync(path.join(ledgerDir, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, 'ledger.json'), JSON.stringify({ version: 1, records: [{ id: 'naming.conventional-commits', scope: { repos: ['*'] }, statement: 'Conventional subjects', check: { mode: 'block' } }] }));
  fs.writeFileSync(path.join(ledgerDir, 'checks', 'naming.conventional-commits.json'), JSON.stringify({ engine: 'subjects', conform: '^(feat|fix|chore|docs|test|refactor|revert)(\\([^)]+\\))?!?: [a-z].+' }));
  const saved = process.env.HARNESS_RUN;
  try {
    const repo = makeRepo(path.join(sb.tmp, 'conv'), { 'a.ts': '1\n' });
    git(repo, 'checkout', '-q', '-b', 'task/T-9');
    writeFile(repo, 'b.ts', 'new\n');
    recordEdit('pause-run', { path: path.join(repo, 'b.ts'), repo: repoIdFor(repo) });
    process.env.HARNESS_RUN = 'task';
    await sessionEnd({ session_id: 'pause-run', cwd: repo }, ctxFor('claude', 'SessionEnd', 'pause-run'));
    assert.deepEqual(subjects(repo), ['init'], 'no pause commit at the end of a runner session');
    delete process.env.HARNESS_RUN;
    const w = wipCommit(repo, { session_id: 'y' }, ctxFor('claude', 'SessionEnd', 'y'), 'SessionEnd');
    assert.equal(w.made, true, w.reason);
    assert.deepEqual(subjects(repo), ['chore(wip): pause the work', 'init'], 'not `wip: pause`, which the gate refuses under Conventional Commits');
  } finally {
    if (saved === undefined) delete process.env.HARNESS_RUN;
    else process.env.HARNESS_RUN = saved;
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    personal(false);
  }
});

test('wip: pause is refused for secret files, secret content, master and detached HEAD', () => {
  personal(true);
  try {
    const ctx = ctxFor('claude', 'PreCompact', 'pause-secret');
    const repo = makeRepo(path.join(sb.tmp, 'sec'), { 'a.ts': '1\n' }, 'work');
    writeFile(repo, '.env', 'DB_PASSWORD=hunter2hunter2\n');
    let w = wipCommit(repo, { session_id: 'pause-secret' }, ctx, 'PreCompact');
    assert.equal(w.made, false);
    assert.match(w.reason, /\.env must never be committed/);
    fs.rmSync(path.join(repo, '.env'));
    writeFile(repo, 'config.ts', 'export const key = "AKIAABCDEFGHIJKLMNOP";\n');
    w = wipCommit(repo, { session_id: 'pause-secret' }, ctx, 'PreCompact');
    assert.equal(w.made, false);
    assert.match(w.reason, /config\.ts may contain a secret/);
    assert.deepEqual(subjects(repo), ['init']);

    const m = makeRepo(path.join(sb.tmp, 'mast'), { 'a.ts': '1\n' }, 'master');
    writeFile(m, 'a.ts', '2\n');
    assert.match(wipCommit(m, {}, ctx, 'PreCompact').reason, /never made on the main branch/);
    git(m, 'checkout', '-q', '--detach');
    assert.match(wipCommit(m, {}, ctx, 'PreCompact').reason, /detached HEAD/);
  } finally {
    personal(false);
  }
});

test('PostCompaction writes the trail and hands it back as context; porcelain parsing keeps both sides of a rename', async () => {
  const repo = makeRepo(path.join(sb.tmp, 'devin'), { 'a.ts': '1\n' });
  const id = repoIdFor(repo);
  recordEdit('pause-devin', { path: path.join(repo, 'a.ts'), repo: id });
  const r = await postCompaction({ session_id: 'pause-devin', cwd: repo }, ctxFor('devin', 'PostCompaction', 'pause-devin'));
  assert.match(String(r.additionalContext), /context was compacted; resume from this trail/);
  assert.match(String(r.additionalContext), /harness trail: adhoc-/);
  assert.deepEqual(porcelainPaths('R  new.ts\0old.ts\0 M a.ts\0?? b.ts\0'), ['new.ts', 'old.ts', 'a.ts', 'b.ts']);
});

test('SessionEnd with no edits closes the session and writes no trail', async () => {
  const before = fs.existsSync(path.join(sb.hh, 'trail')) ? fs.readdirSync(path.join(sb.hh, 'trail')).length : 0;
  const r = await sessionEnd({ session_id: 'pause-none', cwd: sb.tmp }, ctxFor('codex', 'SessionEnd', 'pause-none'));
  assert.equal(r.exitCode, 0);
  assert.equal(loadSession('pause-none').status, 'closed');
  const after = fs.existsSync(path.join(sb.hh, 'trail')) ? fs.readdirSync(path.join(sb.hh, 'trail')).length : 0;
  assert.equal(after, before);
});
