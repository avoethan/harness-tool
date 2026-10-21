import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPlan } from '../../../src/lifecycle/apply';
import { releaseEdit, releaseFile, removeAdded, reverseEdit, undoPlan, undoRecord, uninstall, type UndoResult } from '../../../src/lifecycle/undo';
import { emptyManifest, loadManifest } from '../../../src/lifecycle/manifest';
import { loadPlanRecord } from '../../../src/lifecycle/backup';
import { sha256 } from '../../../src/lib/hash';
import { CLAUDE_SETTINGS, git, gitRepo, plan, read, target, tempHome, write, type TempHome } from './helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-undo-');
});
after(() => h.cleanup());

const HOOK = 'node "/opt/harness/dist/src/hook.js" PreToolUse';
const FRAGMENT = {
  permissions: { deny: ['Bash(git push --force *)', 'Bash(git reset --hard *)', 'Write(~/.harness/**)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash|Edit|Write', hooks: [{ type: 'command', command: HOOK, timeout: 20 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: HOOK.replace('PreToolUse', 'SessionStart'), timeout: 20 }] }],
  },
};

function asUndo(r: Awaited<ReturnType<typeof undoPlan>>): UndoResult {
  assert.ok(r.ok, 'error' in r ? r.error : 'undo failed');
  return r as UndoResult;
}

// ---------------------------------------------------------------------------
// removeAdded / reverseEdit: only what the harness added, and only when still present
// ---------------------------------------------------------------------------

test('removeAdded removes harness-added array entries only, keeps user and pre-existing ones', () => {
  const before = ['Read(./.env)'];
  const after = ['Read(./.env)', 'Bash(git push --force *)', 'Write(~/.harness/**)'];
  const cur = ['Read(./.env)', 'Bash(git push --force *)', 'Bash(rm -rf *)', 'Write(~/.harness/**)'];
  const r = removeAdded(cur, before, after);
  assert.deepEqual(r.value, ['Read(./.env)', 'Bash(rm -rf *)']);
  assert.equal(r.changed, true);
  assert.equal(r.remove, false);
  // the user removed one harness entry already: nothing else is touched
  const r2 = removeAdded(['Read(./.env)', 'Write(~/.harness/**)'], before, after);
  assert.deepEqual(r2.value, ['Read(./.env)']);
  // a key that did not exist before and holds nothing of the user's is dropped
  const r3 = removeAdded(['a', 'b'], undefined, ['a', 'b']);
  assert.equal(r3.remove, true);
  // ... but kept when the user added to it
  const r4 = removeAdded(['a', 'b', 'mine'], undefined, ['a', 'b']);
  assert.equal(r4.remove, false);
  assert.deepEqual(r4.value, ['mine']);
  // scalars: a value the harness set and the user changed is kept
  assert.equal(removeAdded('user', undefined, 'harness').changed, false);
  assert.equal(removeAdded('harness', undefined, 'harness').remove, true);
  assert.equal(removeAdded('x', 'x', 'x').changed, false, 'a scalar that existed before is never touched');
});

test('reverseEdit on a realistic Claude settings.json keeps every pre-existing and user-added entry', () => {
  const base = JSON.parse(JSON.stringify({
    permissions: { allow: ['Read'], deny: ['Read(./.env)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/mine/pre.js' }] }] },
  }));
  const afterHooks = {
    PreToolUse: [...base.hooks.PreToolUse, FRAGMENT.hooks.PreToolUse[0]],
    SessionStart: FRAGMENT.hooks.SessionStart,
  };
  // what the file looks like now: harness entries present, plus a user-added hook and deny rule
  const doc: any = {
    permissions: { allow: ['Read'], deny: ['Read(./.env)', ...FRAGMENT.permissions.deny, 'Bash(curl *)'] },
    hooks: { ...afterHooks, Stop: [{ hooks: [{ type: 'command', command: 'node /opt/mine/stop.js' }] }] },
    model: 'sonnet',
  };
  assert.ok(reverseEdit(doc, { path: '/s', key: 'permissions.deny', before: base.permissions.deny, after: [...base.permissions.deny, ...FRAGMENT.permissions.deny] }));
  assert.ok(reverseEdit(doc, { path: '/s', key: 'hooks.PreToolUse', before: base.hooks.PreToolUse, after: afterHooks.PreToolUse }));
  assert.ok(reverseEdit(doc, { path: '/s', key: 'hooks.SessionStart', before: undefined, after: afterHooks.SessionStart }));
  assert.deepEqual(doc.permissions.deny, ['Read(./.env)', 'Bash(curl *)']);
  assert.deepEqual(doc.permissions.allow, ['Read']);
  assert.deepEqual(doc.hooks.PreToolUse, base.hooks.PreToolUse);
  assert.equal('SessionStart' in doc.hooks, false, 'key the harness created is gone');
  assert.equal(doc.hooks.Stop.length, 1, "the user's Stop hook stays");
  assert.equal(doc.model, 'sonnet');
  // a key that is already gone changes nothing
  assert.equal(reverseEdit(doc, { path: '/s', key: 'hooks.SessionStart', before: undefined, after: afterHooks.SessionStart }), false);
});

test('releaseFile/releaseEdit drop an entry or step the chain back one link', () => {
  const m = emptyManifest();
  m.files.push({ path: '/x/f', owner: 'generated', beforeSha: null, afterSha: 'v2', backup: null });
  // undo of plan 2 (v1 -> v2): the entry steps back to v1
  releaseFile(m, { path: '/x/f', owner: 'generated', beforeSha: 'v1', afterSha: 'v2', backup: '/b/f' });
  assert.equal(m.files[0].afterSha, 'v1');
  assert.equal(m.files[0].beforeSha, null);
  // undo of plan 1 (null -> v1): the entry goes
  releaseFile(m, { path: '/x/f', owner: 'generated', beforeSha: null, afterSha: 'v1', backup: null });
  assert.equal(m.files.length, 0);
  m.settingsEdits.push({ path: '/s', key: 'k', before: undefined, after: ['a', 'b'] });
  releaseEdit(m, { path: '/s', key: 'k', before: ['a'], after: ['a', 'b'] });
  assert.deepEqual(m.settingsEdits[0].after, ['a']);
  releaseEdit(m, { path: '/s', key: 'k', before: undefined, after: ['a'] });
  assert.equal(m.settingsEdits.length, 0);
});

// ---------------------------------------------------------------------------
// the round trip from the brief: three files incl. one merge-json; edit one by hand; undo
// ---------------------------------------------------------------------------

test('undo round trip: two restored, one kept and reported, settings entries removed only where the harness added them', async () => {
  const skills = path.join(h.userHome, '.agents', 'skills', 'harness-task', 'SKILL.md');
  const agents = path.join(h.userHome, '.codex', 'AGENTS.md');
  const settings = path.join(h.userHome, '.claude', 'settings.json');
  write(settings, CLAUDE_SETTINGS);
  write(agents, '# my own AGENTS\n');
  const p = plan('rt-1', 'team', [
    target(skills, 'create', '# task skill\n'),
    target(agents, 'modify', '# my own AGENTS\n\n## harness\nrun harness gate\n'),
    target(settings, 'merge-json', JSON.stringify(FRAGMENT)),
  ]);
  const a = await applyPlan(p, { workspaceRoot: h.workspace });
  assert.equal(a.ok, true, JSON.stringify(a.refused));
  assert.equal(a.written.length, 3);

  // the user edits the skill file by hand, and adds their own deny rule + hook to settings
  write(skills, '# task skill\n\nmy notes\n');
  const cur = JSON.parse(read(settings)!);
  cur.permissions.deny.push('Bash(curl *)');
  cur.hooks.PostToolUse = [{ hooks: [{ type: 'command', command: 'node /opt/mine/post.js' }] }];
  write(settings, JSON.stringify(cur, null, 2) + '\n');

  const dry = asUndo(await undoPlan('rt-1', { dryRun: true }));
  assert.equal(dry.dryRun, true);
  assert.equal(read(skills), '# task skill\n\nmy notes\n', 'dry run writes nothing');
  assert.equal(read(agents)!.includes('harness gate'), true);

  const r = asUndo(await undoPlan('rt-1'));
  assert.equal(r.ok, true, r.notes.join('; '));
  // restored: AGENTS.md from its backup (bytes identical); the skill file kept
  assert.equal(read(agents), '# my own AGENTS\n');
  assert.ok(r.restored.some((x) => x.path === agents && x.how === 'backup'));
  assert.equal(read(skills), '# task skill\n\nmy notes\n');
  assert.equal(r.kept.length, 2, JSON.stringify(r.kept));
  const keptSkill = r.kept.find((k) => k.path === skills)!;
  assert.match(keptSkill.reason, /edited since apply; kept/);
  assert.equal(keptSkill.backup, null, 'a created file has no pre-apply copy');
  const keptSettings = r.kept.find((k) => k.path === settings)!;
  assert.ok(keptSettings.backup && fs.existsSync(keptSettings.backup), 'the settings backup is named');
  assert.equal(read(keptSettings.backup!), CLAUDE_SETTINGS);
  // settings: harness entries gone, everything of the user's kept
  const s = JSON.parse(read(settings)!);
  assert.deepEqual(s.permissions.deny, ['Bash(git push --force *)', 'Read(./.env)', 'Bash(rm -rf *)', 'Bash(curl *)']);
  assert.deepEqual(s.permissions.allow, ['Read', 'Bash(npm test)', 'Bash(npm run lint)']);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node /opt/mine/pre.js');
  assert.equal('SessionStart' in s.hooks, false);
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.PostToolUse.length, 1, "the user's new hook stays");
  assert.equal(s.model, 'sonnet');
  const rev = r.settingsReversed.find((x) => x.path === settings)!;
  assert.deepEqual(rev.keys.sort(), ['hooks.PreToolUse', 'hooks.SessionStart', 'permissions.deny']);
  // manifest: nothing owned any more, so it is gone; integrity re-signed
  assert.equal(loadManifest(path.join(h.harnessHome, 'manifest.json')), null);
  const integrity = JSON.parse(read(path.join(h.harnessHome, 'integrity.json'))!);
  assert.ok(integrity.writtenAt);
  // the backups are still there
  assert.ok(fs.existsSync(r.backupDir));
  // a second undo of the same plan touches nothing and reports it
  const again = asUndo(await undoPlan('rt-1'));
  assert.equal(again.restored.filter((x) => x.how !== 'already-before').length, 0);
});

test('undo restores a pristine settings file byte-for-byte from the backup (comments included)', async () => {
  const settings = path.join(h.workspace, 'pristine', '.claude', 'settings.json');
  write(settings, CLAUDE_SETTINGS);
  const a = await applyPlan(plan('pr-1', 'team', [target(settings, 'merge-json', JSON.stringify(FRAGMENT))]), { workspaceRoot: h.workspace });
  assert.equal(a.ok, true);
  assert.notEqual(read(settings), CLAUDE_SETTINGS);
  const r = asUndo(await undoPlan('pr-1'));
  assert.equal(read(settings), CLAUDE_SETTINGS);
  assert.equal(r.restored[0].how, 'backup');
  assert.equal(r.kept.length, 0);
});

test('undo of a deleted file brings it back; a chained second plan steps the manifest back one link', async () => {
  const gen = path.join(h.workspace, 'chain', 'gen.md');
  write(gen, 'v0\n');
  const a1 = await applyPlan(plan('ch-1', 'team', [target(gen, 'modify', 'v1\n')]), { workspaceRoot: h.workspace });
  assert.equal(a1.ok, true);
  const a2 = await applyPlan(plan('ch-2', 'team', [target(gen, 'modify', 'v2\n')]), { workspaceRoot: h.workspace });
  assert.equal(a2.ok, true);
  const mp = path.join(h.harnessHome, 'manifest.json');
  assert.equal(loadManifest(mp)!.files[0].afterSha, sha256('v2\n'));
  const r2 = asUndo(await undoPlan('ch-2'));
  assert.equal(read(gen), 'v1\n');
  assert.equal(r2.restored[0].how, 'backup');
  const m = loadManifest(mp)!;
  assert.equal(m.files[0].afterSha, sha256('v1\n'), 'the chain stepped back');
  assert.equal(m.files[0].beforeSha, sha256('v0\n'));
  const r1 = asUndo(await undoPlan('ch-1'));
  assert.equal(read(gen), 'v0\n');
  assert.equal(r1.restored[0].how, 'backup');
  assert.equal(loadManifest(mp), null);
  // delete + undo
  const a3 = await applyPlan(plan('ch-3', 'team', [target(gen, 'delete')]), { workspaceRoot: h.workspace });
  assert.equal(a3.ok, true);
  assert.equal(read(gen), null);
  const r3 = asUndo(await undoPlan('ch-3'));
  assert.equal(read(gen), 'v0\n');
  assert.equal(r3.restored[0].how, 'backup');
});

test('undo without an id picks the latest apply; unknown ids are reported', async () => {
  const f = path.join(h.workspace, 'latest', 'x.md');
  const a = await applyPlan(plan('latest-1', 'team', [target(f, 'create', 'x\n')]), { workspaceRoot: h.workspace, now: new Date(Date.now() + 60_000) });
  assert.equal(a.ok, true);
  const r = asUndo(await undoPlan());
  assert.equal(r.planId, 'latest-1');
  assert.equal(read(f), null);
  const bad = await undoPlan('never-applied');
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /no apply record/);
});

// ---------------------------------------------------------------------------
// personal setting: the apply commit is reverted, never reset
// ---------------------------------------------------------------------------

test('personal: undo reverts the apply commit with git revert and leaves the user\'s later commit alone', async () => {
  const repo = gitRepo(path.join(h.workspace, 'pers-undo'), { 'README.md': '# p\n' });
  const agents = path.join(repo, 'AGENTS.md');
  const settings = path.join(repo, '.claude', 'settings.json');
  const p = plan('pu-1', 'personal', [target(agents, 'create', '# AGENTS\n'), target(settings, 'merge-json', JSON.stringify(FRAGMENT))], { repoRoot: repo });
  const a = await applyPlan(p, { commit: true });
  assert.equal(a.ok, true, JSON.stringify(a.refused));
  assert.ok(a.commit);
  // the user commits unrelated work on top
  write(path.join(repo, 'src.ts'), 'export {};\n');
  git(repo, ['add', 'src.ts']);
  git(repo, ['commit', '-q', '-m', 'user work']);
  const headBefore = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

  const r = asUndo(await undoPlan('pu-1'));
  assert.ok(r.reverted, r.notes.join('; '));
  const log = git(repo, ['log', '--format=%s', '-n4']).stdout.trim().split('\n');
  assert.match(log[0], /^Revert "harness: apply pu-1"/);
  assert.equal(log[1], 'user work');
  assert.equal(log[2], 'harness: apply pu-1');
  assert.ok(git(repo, ['merge-base', '--is-ancestor', headBefore, 'HEAD']).code === 0, 'history was not rewritten');
  assert.equal(read(agents), null);
  assert.equal(read(settings), null);
  assert.equal(read(path.join(repo, '.harness', 'manifest.json')), null);
  assert.equal(fs.existsSync(path.join(repo, '.harness')), false, 'empty .harness folder removed');
  assert.equal(git(repo, ['status', '--porcelain']).stdout.trim(), '', 'working tree clean after undo');
  assert.ok(r.restored.every((x) => x.how === 'already-before' || x.how === 'deleted'));
  assert.equal(read(path.join(repo, 'src.ts')), 'export {};\n');
});

test("personal: undo's revert commit follows the repository's commit-subject standard (the pre-push gate checks it)", async () => {
  const ledgerDir = path.join(h.harnessHome, 'ledger');
  fs.mkdirSync(path.join(ledgerDir, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, 'ledger.json'), JSON.stringify({ version: 1, records: [{ id: 'naming.conventional-commits', scope: { repos: ['*'] }, statement: 'Conventional subjects', check: { mode: 'block' } }] }));
  fs.writeFileSync(path.join(ledgerDir, 'checks', 'naming.conventional-commits.json'), JSON.stringify({ engine: 'subjects', conform: '^(feat|fix|chore|docs|test|refactor|revert)(\\([^)]+\\))?!?: [a-z].+' }));
  try {
    const repo = gitRepo(path.join(h.workspace, 'pers-undo-conv'), { 'README.md': '# p\n' });
    const p = plan('pu-conv', 'personal', [target(path.join(repo, 'AGENTS.md'), 'create', '# AGENTS\n')], { repoRoot: repo });
    const a = await applyPlan(p, { commit: true });
    assert.equal(a.ok, true, JSON.stringify(a.refused));
    const r = asUndo(await undoPlan('pu-conv'));
    assert.ok(r.reverted, r.notes.join('; '));
    const log = git(repo, ['log', '--format=%s', '-n2']).stdout.trim().split('\n');
    assert.deepEqual(log, ['revert: chore(harness): apply pu-conv', 'chore(harness): apply pu-conv']);
    assert.match(git(repo, ['log', '-1', '--format=%b']).stdout, new RegExp(`This reverts commit ${a.commit}\\.`));
    assert.equal(git(repo, ['status', '--porcelain']).stdout.trim(), '');
  } finally {
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test('personal: when the revert cannot apply, files are still restored from the backups and the repo is not left mid-revert', async () => {
  const repo = gitRepo(path.join(h.workspace, 'pers-conflict'), { 'README.md': '# p\n' });
  const agents = path.join(repo, 'AGENTS.md');
  const a = await applyPlan(plan('pc-1', 'personal', [target(agents, 'create', '# AGENTS\n')], { repoRoot: repo }), { commit: true });
  assert.ok(a.commit);
  // the user rewrites and commits AGENTS.md: the revert will conflict
  write(agents, '# AGENTS\nmine\n');
  git(repo, ['add', 'AGENTS.md']);
  git(repo, ['commit', '-q', '-m', 'user edit']);
  const r = asUndo(await undoPlan('pc-1'));
  assert.equal(r.reverted, null);
  assert.ok(r.notes.some((n) => /could not revert/.test(n)), r.notes.join('; '));
  assert.equal(fs.existsSync(path.join(repo, '.git', 'REVERT_HEAD')), false, 'revert aborted');
  assert.equal(read(agents), '# AGENTS\nmine\n', 'the user\'s edited file is kept');
  assert.equal(r.kept.length, 1);
  assert.equal(git(repo, ['log', '--format=%s', '-n1']).stdout.trim(), 'user edit');
});

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

test('uninstall undoes every plan the manifest owns, removes empty folders, keeps backups', async () => {
  const home = tempHome('harness-uninstall-');
  try {
    const skill = path.join(home.userHome, '.agents', 'skills', 'harness-task', 'SKILL.md');
    const rules = path.join(home.userHome, '.claude', 'rules', 'harness.md');
    const settings = path.join(home.userHome, '.claude', 'settings.json');
    write(settings, '{ "permissions": { "deny": ["Read(./.env)"] } }\n');
    const a1 = await applyPlan(plan('un-1', 'team', [target(skill, 'create', '# skill\n'), target(settings, 'merge-json', JSON.stringify(FRAGMENT))]), { workspaceRoot: home.workspace });
    assert.equal(a1.ok, true, JSON.stringify(a1.refused));
    const a2 = await applyPlan(plan('un-2', 'team', [target(rules, 'create', '# rules\n')]), { workspaceRoot: home.workspace, now: new Date(Date.now() + 60_000) });
    assert.equal(a2.ok, true, JSON.stringify(a2.refused));
    const mp = path.join(home.harnessHome, 'manifest.json');
    assert.equal(loadManifest(mp)!.files.length, 3);

    const dry = await uninstall({ setting: 'team', dryRun: true });
    assert.ok(dry.ok && 'plans' in dry);
    assert.equal(dry.plans.length, 2);
    assert.equal(read(skill), '# skill\n', 'dry run writes nothing');

    const r = await uninstall({ setting: 'team' });
    assert.ok(r.ok && 'plans' in r, JSON.stringify(r));
    assert.deepEqual(r.plans.map((p) => p.planId), ['un-2', 'un-1'], 'newest first');
    assert.equal(read(skill), null);
    assert.equal(read(rules), null);
    assert.equal(read(settings), '{ "permissions": { "deny": ["Read(./.env)"] } }\n');
    assert.equal(fs.existsSync(path.dirname(skill)), false, 'harness-created folder removed');
    assert.equal(fs.existsSync(path.dirname(rules)), false);
    assert.equal(fs.existsSync(path.join(home.userHome, '.claude')), true, 'pre-existing folder stays');
    assert.equal(loadManifest(mp), null);
    assert.ok(fs.existsSync(r.backupsDir));
    assert.ok(loadPlanRecord('un-1'), 'backups and records kept');
    assert.ok(r.notes.some((n) => /backups kept under/.test(n)));
    // a second uninstall has nothing to do and says so
    const again = await uninstall({ setting: 'team' });
    assert.ok(again.ok && 'notes' in again && again.notes.some((n) => /nothing installed/.test(n)));
  } finally {
    home.cleanup();
    // restore this file's temp home for later tests
    process.env.HARNESS_HOME = h.harnessHome;
    process.env.HARNESS_USER_HOME = h.userHome;
  }
});

test('uninstall falls back to the original backups when a plan record is missing', async () => {
  const home = tempHome('harness-uninstall2-');
  try {
    const f = path.join(home.workspace, 'nr', 'AGENTS.md');
    write(f, 'orig\n');
    const a = await applyPlan(plan('nr-1', 'team', [target(f, 'modify', 'harness\n')]), { workspaceRoot: home.workspace });
    assert.equal(a.ok, true);
    // lose the per-plan record but not the backup copy
    fs.unlinkSync(path.join(a.backupDir!, 'manifest.json'));
    const r = await uninstall({ setting: 'team' });
    assert.ok(r.ok && 'plans' in r);
    assert.equal(r.plans.length, 0);
    assert.equal(read(f), 'orig\n');
    assert.equal(r.restored[0].how, 'backup');
  } finally {
    home.cleanup();
    process.env.HARNESS_HOME = h.harnessHome;
    process.env.HARNESS_USER_HOME = h.userHome;
  }
});

test('undoRecord is exported for uninstall and accepts a record directly', async () => {
  const f = path.join(h.workspace, 'direct', 'x.md');
  const a = await applyPlan(plan('dr-1', 'team', [target(f, 'create', 'x\n')]), { workspaceRoot: h.workspace });
  assert.equal(a.ok, true);
  const rec = loadPlanRecord('dr-1')!;
  const r = await undoRecord(rec);
  assert.equal(r.restored[0].how, 'deleted');
  assert.equal(read(f), null);
});
