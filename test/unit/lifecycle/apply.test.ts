import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPlan, diffUnion, joinKey, mergeContent, missingDirs, splitKey, verifyWritten } from '../../../src/lifecycle/apply';
import { loadManifest } from '../../../src/lifecycle/manifest';
import { loadPlanRecord } from '../../../src/lifecycle/backup';
import { parseJsonc, unionJson } from '../../../src/lib/jsonc';
import { sha256 } from '../../../src/lib/hash';
import { CLAUDE_SETTINGS, CODEX_HOOKS, DEVIN_CONFIG, git, gitRepo, plan, read, shaOf, target, tempHome, write, type TempHome } from './helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-apply-');
});
after(() => h.cleanup());

const HOOK = 'node "/opt/harness/dist/src/hook.js" PreToolUse';

// ---------------------------------------------------------------------------
// unionJson invariants on realistic agent settings
// ---------------------------------------------------------------------------

function entries(v: unknown): string[] {
  return (v as unknown[]).map((x) => JSON.stringify(x));
}

test('merge-json keeps every existing Claude deny/allow rule and hook, adds the harness ones once', () => {
  const file = path.join(h.userHome, '.claude', 'settings.json');
  write(file, CLAUDE_SETTINGS);
  const base = parseJsonc<any>(CLAUDE_SETTINGS);
  const fragment = {
    permissions: { deny: ['Bash(git push --force *)', 'Bash(git reset --hard *)', 'Write(~/.harness/**)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash|Edit|Write', hooks: [{ type: 'command', command: HOOK, timeout: 20 }] }],
      Stop: [{ hooks: [{ type: 'command', command: HOOK.replace('PreToolUse', 'Stop'), timeout: 2 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: HOOK.replace('PreToolUse', 'SessionStart'), timeout: 20 }] }],
    },
  };
  const m = mergeContent(target(file, 'merge-json', JSON.stringify(fragment)));
  assert.ok(!('refuse' in m), 'merge content ok');
  if ('refuse' in m) return;
  const out = JSON.parse(m.text);
  // nothing existing removed or narrowed
  for (const d of base.permissions.deny) assert.ok(out.permissions.deny.includes(d), `deny kept: ${d}`);
  for (const a of base.permissions.allow) assert.ok(out.permissions.allow.includes(a), `allow kept: ${a}`);
  assert.ok(entries(out.hooks.PreToolUse).includes(JSON.stringify(base.hooks.PreToolUse[0])), 'existing PreToolUse hook kept');
  assert.ok(entries(out.hooks.Stop).includes(JSON.stringify(base.hooks.Stop[0])), 'existing Stop hook kept');
  assert.deepEqual(out.env, base.env);
  assert.equal(out.model, 'sonnet');
  // harness entries added, duplicates not repeated
  assert.equal(out.permissions.deny.filter((d: string) => d === 'Bash(git push --force *)').length, 1);
  assert.ok(out.permissions.deny.includes('Bash(git reset --hard *)'));
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.equal(out.hooks.SessionStart.length, 1);
  assert.ok(m.hadComments, 'the original had comments');
  // edits recorded at the right dotted keys
  const keys = m.edits.map((e) => e.key).sort();
  assert.deepEqual(keys, ['hooks.PreToolUse', 'hooks.SessionStart', 'hooks.Stop', 'permissions.deny']);
  const sess = m.edits.find((e) => e.key === 'hooks.SessionStart')!;
  assert.equal(sess.before, undefined);
  // applying the same fragment again changes nothing (idempotent)
  const again = unionJson(out, fragment);
  assert.equal(JSON.stringify(again), JSON.stringify(out));
});

test('merge-json keeps Devin deny/ask rules, hooks and MCP servers', () => {
  const file = path.join(h.userHome, '.config', 'devin', 'config.json');
  write(file, DEVIN_CONFIG);
  const base = JSON.parse(DEVIN_CONFIG);
  const fragment = {
    permissions: { deny: ['exec(git push *)', 'exec(sqlcmd *)'] },
    hooks: { PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: HOOK, timeout: 20 }] }] },
  };
  const m = mergeContent(target(file, 'merge-json', JSON.stringify(fragment)));
  assert.ok(!('refuse' in m));
  if ('refuse' in m) return;
  const out = JSON.parse(m.text);
  for (const d of base.permissions.deny) assert.ok(out.permissions.deny.includes(d));
  assert.deepEqual(out.permissions.ask, base.permissions.ask, 'ask rules untouched');
  assert.deepEqual(out.mcpServers, base.mcpServers, 'mcp servers untouched');
  assert.equal(out.mode, 'default');
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.equal(out.permissions.deny.length, 3);
  assert.ok(!m.hadComments);
});

test('merge-json keeps Codex hooks and adds the harness hooks', () => {
  const file = path.join(h.userHome, '.codex', 'hooks.json');
  write(file, CODEX_HOOKS);
  const base = JSON.parse(CODEX_HOOKS);
  const fragment = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK, timeout: 20 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: HOOK.replace('PreToolUse', 'SessionStart'), timeout: 20 }] }],
      Stop: [{ hooks: [{ type: 'command', command: HOOK.replace('PreToolUse', 'Stop'), timeout: 2 }] }],
    },
  };
  const m = mergeContent(target(file, 'merge-json', JSON.stringify(fragment)));
  assert.ok(!('refuse' in m));
  if ('refuse' in m) return;
  const out = JSON.parse(m.text);
  assert.ok(entries(out.hooks.PreToolUse).includes(JSON.stringify(base.hooks.PreToolUse[0])));
  assert.ok(entries(out.hooks.SessionStart).includes(JSON.stringify(base.hooks.SessionStart[0])));
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.equal(out.hooks.SessionStart.length, 2);
  assert.equal(out.hooks.Stop.length, 1);
});

test('dotted keys: segments with dots are bracketed and split back', () => {
  assert.equal(joinKey('', 'hooks'), 'hooks');
  assert.equal(joinKey('a', 'b.c'), 'a.[b.c]');
  assert.deepEqual(splitKey('a.[b.c].d'), ['a', 'b.c', 'd']);
  assert.deepEqual(splitKey('permissions.deny'), ['permissions', 'deny']);
  const edits = diffUnion({ a: {} }, { a: { 'x.y': [1] } }, { a: { 'x.y': [1] } }, '', '/f');
  assert.equal(edits[0].key, 'a.[x.y]');
});

// ---------------------------------------------------------------------------
// applyPlan
// ---------------------------------------------------------------------------

test('apply refuses the whole plan when one target changed since the plan (and names it)', async () => {
  const a = path.join(h.workspace, 'drift', 'a.md');
  const b = path.join(h.workspace, 'drift', 'b.md');
  write(a, 'A\n');
  write(b, 'B\n');
  const p = plan('drift-1', 'team', [target(a, 'modify', 'A2\n'), target(b, 'modify', 'B2\n')]);
  write(b, 'B edited by hand\n');
  const r = await applyPlan(p, { workspaceRoot: h.workspace });
  assert.equal(r.ok, false);
  assert.equal(r.written.length, 0);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].path, b);
  assert.match(r.refused[0].reason, /changed since the plan/);
  assert.equal(read(a), 'A\n', 'nothing written');
  assert.equal(read(b), 'B edited by hand\n');
  assert.ok(r.notes.some((n) => /refused as a whole/.test(n)));
});

test('a create target over an existing git hook or file is refused, the file stays', async () => {
  const hook = path.join(h.workspace, 'hooky', '.git', 'hooks', 'pre-push');
  write(hook, '#!/bin/sh\nexit 1\n');
  const t = target(hook, 'create', '#!/bin/sh\nharness gate\n');
  t.beforeSha = null; // the plan believed there was none
  const r = await applyPlan(plan('hook-1', 'team', [t]), { workspaceRoot: h.workspace });
  assert.equal(r.ok, false);
  assert.match(r.refused[0].reason, /exists now/);
  assert.equal(read(hook), '#!/bin/sh\nexit 1\n');
});

test('apply writes, backs up, records the manifest and re-signs integrity (team)', async () => {
  const agents = path.join(h.userHome, '.agents', 'skills', 'harness-task', 'SKILL.md');
  const claude = path.join(h.userHome, '.claude', 'settings.json');
  write(claude, CLAUDE_SETTINGS);
  const fragment = { permissions: { deny: ['Bash(git push --force *)', 'Write(~/.harness/**)'] } };
  const p = plan('team-1', 'team', [target(agents, 'create', '# task skill\n'), target(claude, 'merge-json', JSON.stringify(fragment))]);
  const r = await applyPlan(p, { workspaceRoot: h.workspace });
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  assert.equal(r.written.length, 2);
  assert.equal(read(agents), '# task skill\n');
  const settings = JSON.parse(read(claude)!);
  assert.ok(settings.permissions.deny.includes('Write(~/.harness/**)'));
  assert.ok(settings.permissions.deny.includes('Read(./.env)'));
  assert.ok(settings.permissions.allow.includes('Bash(npm test)'));
  // backup of the settings file holds the original bytes (comments included)
  const w = r.written.find((x) => x.path === claude)!;
  assert.ok(w.backup && fs.existsSync(w.backup));
  assert.equal(read(w.backup!), CLAUDE_SETTINGS);
  assert.ok(r.backupDir && w.backup!.startsWith(r.backupDir));
  // manifest
  const m = loadManifest(path.join(h.harnessHome, 'manifest.json'))!;
  assert.equal(m.planId, 'team-1');
  assert.equal(m.files.length, 2);
  assert.equal(m.settingsEdits.length, 1);
  assert.equal(m.settingsEdits[0].key, 'permissions.deny');
  assert.ok(m.createdDirs!.some((d) => d.endsWith('harness-task')));
  // per-plan record + integrity
  const rec = loadPlanRecord('team-1')!;
  assert.equal(rec.files.length, 2);
  assert.equal(rec.setting, 'team');
  const integrity = JSON.parse(read(path.join(h.harnessHome, 'integrity.json'))!);
  assert.ok(integrity.files[path.join(h.harnessHome, 'manifest.json')], 'manifest signed');
  assert.ok(r.notes.some((n) => /comments/.test(n)), 'comment loss reported');
});

test('hidden Unicode in a target is refused and the original file is kept', async () => {
  const f = path.join(h.workspace, 'uni', 'AGENTS.md');
  write(f, 'clean\n');
  const t = target(f, 'modify', 'clean​ with a zero-width space\n');
  const r = await applyPlan(plan('uni-1', 'team', [t]), { workspaceRoot: h.workspace });
  assert.equal(r.ok, false);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].reason, /hidden Unicode/);
  assert.equal(read(f), 'clean\n', 'original content intact');
  // the backup was taken before the attempt
  assert.ok(r.backupDir && fs.existsSync(r.backupDir));
  // and verifyWritten catches bytes that arrived with hidden code points or a wrong hash
  const bad = path.join(h.workspace, 'uni', 'bad.txt');
  fs.writeFileSync(bad, 'x⁠y');
  const v = verifyWritten(bad, sha256('x⁠y'));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /hidden Unicode/);
  const v2 = verifyWritten(f, sha256('something else'));
  assert.equal(v2.ok, false);
  assert.match((v2 as { reason: string }).reason, /hash mismatch/);
});

test('team guard: a tracked path is refused before any write, and an unignored in-tree path too', async () => {
  const repo = gitRepo(path.join(h.workspace, 'team-repo'), { 'README.md': '# r\n', 'AGENTS.md': '# agents\n' });
  const tracked = path.join(repo, 'AGENTS.md');
  const other = path.join(h.userHome, '.claude', 'CLAUDE.md');
  const r = await applyPlan(plan('guard-1', 'team', [target(tracked, 'modify', '# changed\n'), target(other, 'create', 'x\n')]), { workspaceRoot: h.workspace });
  assert.equal(r.ok, false);
  assert.equal(r.written.length, 0);
  assert.match(r.refused[0].reason, /tracked by the repository/);
  assert.equal(read(tracked), '# agents\n');
  assert.equal(read(other), null, 'the other target was not written either');

  const untracked = path.join(repo, 'CLAUDE.local.md');
  const r2 = await applyPlan(plan('guard-2', 'team', [target(untracked, 'create', 'x\n')]), { workspaceRoot: h.workspace });
  assert.equal(r2.ok, false);
  assert.match(r2.refused[0].reason, /not ignored by git/);
  assert.equal(read(untracked), null);
});

test('team guard: exclude=true adds the path to .git/info/exclude and check-ignore proves it before and after', async () => {
  const repo = gitRepo(path.join(h.workspace, 'team-repo-2'));
  const local = path.join(repo, 'CLAUDE.local.md');
  const r = await applyPlan(plan('guard-3', 'team', [target(local, 'create', '# private pointer\n', { exclude: true })]), { workspaceRoot: h.workspace });
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  assert.equal(read(local), '# private pointer\n');
  const exclude = read(path.join(repo, '.git', 'info', 'exclude'))!;
  assert.ok(exclude.split('\n').includes('/CLAUDE.local.md'));
  assert.equal(r.excluded.length, 1);
  assert.match(r.excluded[0].rule, /info\/exclude/);
  const status = git(repo, ['status', '--porcelain']).stdout.trim();
  assert.equal(status, '', 'git sees nothing new in the team repo');
  // dry run of the same kind of plan writes nothing and says what it would do
  const local2 = path.join(repo, 'AGENTS.local.md');
  const d = await applyPlan(plan('guard-4', 'team', [target(local2, 'create', 'x\n', { exclude: true })]), { workspaceRoot: h.workspace, dryRun: true });
  assert.equal(d.dryRun, true);
  assert.equal(d.written.length, 1);
  assert.equal(read(local2), null);
  assert.ok(!read(path.join(repo, '.git', 'info', 'exclude'))!.includes('AGENTS.local.md'));
});

test('delete: generated pristine files are deleted with a backup; user-owned files are skipped', async () => {
  const gen = path.join(h.workspace, 'del', 'gen.md');
  const usr = path.join(h.workspace, 'del', 'user.md');
  write(gen, 'g\n');
  write(usr, 'u\n');
  const r = await applyPlan(plan('del-1', 'team', [target(gen, 'delete'), target(usr, 'delete', undefined, { owner: 'user' })]), { workspaceRoot: h.workspace });
  assert.equal(r.ok, true);
  assert.equal(read(gen), null);
  assert.equal(read(usr), 'u\n');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /never deleted/);
  const w = r.written[0];
  assert.equal(w.afterSha, '');
  assert.equal(read(w.backup!), 'g\n');
});

test('personal setting: manifest lives in the repo and the apply commit holds exactly the owned paths', async () => {
  const repo = gitRepo(path.join(h.workspace, 'personal-repo'), { 'README.md': '# p\n', 'src/index.ts': 'export {};\n' });
  write(path.join(repo, 'src', 'index.ts'), 'export const dirty = 1;\n'); // the user's own uncommitted work
  const agents = path.join(repo, 'AGENTS.md');
  const settings = path.join(repo, '.claude', 'settings.json');
  const p = plan('pers-1', 'personal', [target(agents, 'create', '# AGENTS\n'), target(settings, 'merge-json', JSON.stringify({ permissions: { deny: ['Bash(git push --force *)'] } }))], { repoRoot: repo });
  const r = await applyPlan(p, { commit: true });
  assert.equal(r.ok, true, JSON.stringify(r.refused));
  assert.equal(r.manifestPath, path.join(repo, '.harness', 'manifest.json'));
  assert.ok(r.commit);
  const show = git(repo, ['show', '--name-only', '--format=%s', 'HEAD']).stdout.trim().split('\n');
  assert.equal(show[0], 'harness: apply pers-1');
  assert.deepEqual(show.slice(1).filter(Boolean).sort(), ['.claude/settings.json', '.harness/manifest.json', 'AGENTS.md']);
  assert.match(git(repo, ['status', '--porcelain']).stdout, /src\/index\.ts/, "the user's own change is still uncommitted");
  assert.equal(loadPlanRecord('pers-1')!.commit, r.commit);
  assert.equal(shaOf(agents), sha256('# AGENTS\n'));
});

test("personal setting: the apply commit's subject follows the repository's commit-subject standard from the ledger", async () => {
  const ledgerDir = path.join(h.harnessHome, 'ledger');
  fs.mkdirSync(path.join(ledgerDir, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, 'ledger.json'), JSON.stringify({ version: 1, records: [{ id: 'naming.conventional-commits', scope: { repos: ['*'] }, statement: 'Conventional subjects', check: { mode: 'block' } }] }));
  fs.writeFileSync(path.join(ledgerDir, 'checks', 'naming.conventional-commits.json'), JSON.stringify({ engine: 'subjects', conform: '^(feat|fix|chore|docs|test|refactor|revert)(\\([^)]+\\))?!?: [a-z].+' }));
  try {
    const repo = gitRepo(path.join(h.workspace, 'personal-conv'), { 'README.md': '# p\n' });
    const p = plan('pers-2', 'personal', [target(path.join(repo, 'AGENTS.md'), 'create', '# AGENTS\n')], { repoRoot: repo });
    const r = await applyPlan(p, { commit: true });
    assert.equal(r.ok, true, JSON.stringify(r.refused));
    assert.equal(git(repo, ['log', '-1', '--format=%s']).stdout.trim(), 'chore(harness): apply pers-2', 'the pre-push gate checks this subject too');
  } finally {
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('missingDirs lists folders to create, deepest first', () => {
  const base = path.join(h.workspace, 'md');
  fs.mkdirSync(base, { recursive: true });
  assert.deepEqual(missingDirs(path.join(base, 'a', 'b')), [path.join(base, 'a', 'b'), path.join(base, 'a')]);
  assert.deepEqual(missingDirs(base), []);
});
