/**
 * Known issue (d): a second install from another copy of the harness (a
 * second clone, a moved folder) replaces the hook entries and node "<cli.js>"
 * allow rules the first install wrote, instead of adding a second set. Only
 * entries the manifest records as harness-added are replaced; the user's own
 * entries stay, even one that names a hook.js of its own. Undo and uninstall
 * still restore the exact earlier bytes.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { applyPlan } from '../../../src/lifecycle/apply';
import { undoPlan, uninstall } from '../../../src/lifecycle/undo';
import { loadManifest } from '../../../src/lifecycle/manifest';
import { ownedArrayElements, pruneStaleOwned } from '../../../src/lifecycle/owned';
import { plan, read, target, tempHome, write } from './helpers';

const hook = (root: string, event: string) => ({ hooks: [{ type: 'command', command: `node "${root}/dist/src/hook.js" ${event} --agent claude`, timeout: 20 }] });
const fragment = (root: string) => ({
  hooks: { PreToolUse: [{ matcher: 'Bash', ...hook(root, 'PreToolUse') }], Stop: [hook(root, 'Stop')] },
  permissions: { allow: [`Bash(node "${root}/dist/src/cli.js" gate *)`, 'Bash(npm test)'] },
});
const USER = {
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /home/me/tools/dist/src/hook.js audit' }] }] },
  permissions: { allow: ['Bash(ls)'] },
};

test('a second install from another clone replaces the harness entries of the first, keeps the user\'s, and undo/uninstall restore the bytes', async () => {
  const h = tempHome('harness-reinstall-');
  try {
    const settings = path.join(h.userHome, '.claude', 'settings.json');
    const original = JSON.stringify(USER, null, 2) + '\n';
    write(settings, original);
    const A = '/opt/clone-a/harness';
    const B = '/opt/clone-b/harness';

    const a = await applyPlan(plan('ri-a', 'team', [target(settings, 'merge-json', JSON.stringify(fragment(A)))]), { workspaceRoot: h.workspace, now: new Date(Date.now()) });
    assert.equal(a.ok, true, JSON.stringify(a.refused));
    const afterA = read(settings)!;
    assert.equal((JSON.parse(afterA).hooks.PreToolUse as unknown[]).length, 2, 'user entry + clone A');

    const b = await applyPlan(plan('ri-b', 'team', [target(settings, 'merge-json', JSON.stringify(fragment(B)))]), { workspaceRoot: h.workspace, now: new Date(Date.now() + 60_000) });
    assert.equal(b.ok, true, JSON.stringify(b.refused));
    const s = JSON.parse(read(settings)!);
    const commands = (arr: Array<{ hooks: Array<{ command: string }> }>) => arr.flatMap((e) => e.hooks.map((x) => x.command));
    assert.deepEqual(commands(s.hooks.PreToolUse), ['node /home/me/tools/dist/src/hook.js audit', `node "${B}/dist/src/hook.js" PreToolUse --agent claude`], 'the user\'s own hook.js entry stays; clone A\'s is replaced by clone B\'s');
    assert.deepEqual(commands(s.hooks.Stop), [`node "${B}/dist/src/hook.js" Stop --agent claude`]);
    assert.deepEqual(s.permissions.allow, ['Bash(ls)', 'Bash(npm test)', `Bash(node "${B}/dist/src/cli.js" gate *)`], 'stale cli.js rule replaced; a shared rule (npm test) is kept once');
    assert.ok(b.notes.some((n) => /replaced 3 harness entries an earlier install wrote for another copy/.test(n)), b.notes.join('\n'));

    // the same clone again: nothing new to write
    const again = await applyPlan(plan('ri-b2', 'team', [target(settings, 'merge-json', JSON.stringify(fragment(B)))]), { workspaceRoot: h.workspace, now: new Date(Date.now() + 120_000) });
    assert.equal(again.ok, true);
    assert.equal(JSON.stringify(JSON.parse(read(settings)!)), JSON.stringify(s), 'a re-install from the same copy changes nothing');

    // undo the second install: exactly the bytes after the first
    const ub2 = await undoPlan('ri-b2');
    assert.ok(ub2.ok);
    const ub = await undoPlan('ri-b');
    assert.ok(ub.ok, JSON.stringify(ub));
    assert.equal(read(settings), afterA, 'undo restores the first install\'s bytes');

    // apply B again, then uninstall: the original bytes
    const b3 = await applyPlan(plan('ri-b3', 'team', [target(settings, 'merge-json', JSON.stringify(fragment(B)))]), { workspaceRoot: h.workspace, now: new Date(Date.now() + 180_000) });
    assert.equal(b3.ok, true);
    const un = await uninstall({ setting: 'team' });
    assert.ok(un.ok, JSON.stringify(un));
    assert.equal(read(settings), original, 'uninstall leaves the user\'s file as it was');
    assert.equal(loadManifest(path.join(h.harnessHome, 'manifest.json')), null);
  } finally {
    h.cleanup();
  }
});

test('pruneStaleOwned never drops an element the manifest does not record as harness-added, nor one the new fragment carries', () => {
  const stale = { hooks: [{ type: 'command', command: 'node "/old/dist/src/hook.js" Stop' }] };
  const fresh = { hooks: [{ type: 'command', command: 'node "/new/dist/src/hook.js" Stop' }] };
  const userOwn = { hooks: [{ type: 'command', command: 'node "/elsewhere/dist/src/hook.js" Stop' }] };
  const base = { hooks: { Stop: [userOwn, stale] } };
  const owned = ownedArrayElements([{ path: '/x/settings.json', key: 'hooks', before: undefined, after: { Stop: [stale] } }], '/x/settings.json');
  assert.deepEqual([...(owned.get('hooks.Stop') ?? [])], [JSON.stringify(stale)]);
  const r = pruneStaleOwned(base, { hooks: { Stop: [fresh] } }, owned);
  assert.deepEqual(r.base, { hooks: { Stop: [userOwn] } });
  assert.deepEqual(r.replaced, [{ key: 'hooks.Stop', count: 1 }]);
  // the fragment still carries it (same copy): kept
  assert.deepEqual(pruneStaleOwned(base, { hooks: { Stop: [stale] } }, owned).replaced, []);
  // no manifest knowledge: nothing is dropped
  assert.deepEqual(pruneStaleOwned(base, { hooks: { Stop: [fresh] } }, new Map()).base, base);
  // another file's edits do not count
  assert.equal(ownedArrayElements([{ path: '/y/other.json', key: 'hooks', before: undefined, after: { Stop: [stale] } }], '/x/settings.json').size, 0);
  // a harness-added element that is not a harness entry point (a plain rule) is never pruned
  const plain = ownedArrayElements([{ path: '/x/s.json', key: 'permissions.allow', before: ['Bash(ls)'], after: ['Bash(ls)', 'Bash(npm test)'] }], '/x/s.json');
  assert.deepEqual(pruneStaleOwned({ permissions: { allow: ['Bash(ls)', 'Bash(npm test)'] } }, { permissions: { allow: ['Bash(npm run lint)'] } }, plain).replaced, []);
});
