import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main, markTarget, normaliseServer, unmarkTarget, validateServer, candidatesPath, interactiveMark, MARK_CHOICES } from '../../../src/commands/db';
import { allowlistHash, defaultConfig, loadConfig } from '../../../src/lib/config';
import { capture, withTty } from './capture';
import { tempHome, write, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-db-');
});
after(() => h.cleanup());

test('mark creates the config, stores hostnames only and the allowlist hash', async () => {
  const r = await capture(() => main(['mark', '--server', 'LocalHost, 1433', '--database', 'shop_test', '--test']));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Marked localhost,1433 shop_test as test/);
  const c = loadConfig()!;
  assert.ok(c, 'config created');
  assert.deepEqual(c.db.allowlist, [{ server: 'localhost,1433', database: 'shop_test', marked: 'test' }]);
  assert.equal(c.db.markedHash, allowlistHash(c));
  assert.ok(c.db.markedAt);
  assert.ok(fs.existsSync(path.join(h.harnessHome, 'integrity.json')), 'integrity re-signed');
  const hash1 = c.db.markedHash;

  const list = await capture(() => main(['list']));
  assert.equal(list.code, 0);
  assert.match(list.stdout, /localhost,1433\s+shop_test\s+test/);
  assert.match(list.stdout, new RegExp(`hash: ${hash1}`));

  // update the same entry: not-test; the hash moves
  const r2 = await capture(() => main(['mark', '--server', 'localhost,1433', '--database', 'SHOP_TEST', '--not-test']));
  assert.equal(r2.code, 0);
  const c2 = loadConfig()!;
  assert.equal(c2.db.allowlist.length, 1);
  assert.equal(c2.db.allowlist[0].marked, 'not-test');
  assert.notEqual(c2.db.markedHash, hash1);
  assert.equal(c2.db.markedHash, allowlistHash(c2));

  // a server-wide entry is separate from the database-specific one
  const r3 = await capture(() => main(['mark', '--server', 'devbox', '--test']));
  assert.equal(r3.code, 0);
  assert.equal(loadConfig()!.db.allowlist.length, 2);
  const j = await capture(() => main(['list', '--json']));
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.allowlist.length, 2);
  assert.equal(parsed.hashMatches, true);
  assert.equal(parsed.hash, parsed.markedHash);

  // unmark
  const r4 = await capture(() => main(['unmark', '--server', 'devbox']));
  assert.equal(r4.code, 0);
  assert.equal(loadConfig()!.db.allowlist.length, 1);
  const r5 = await capture(() => main(['unmark', '--server', 'devbox']));
  assert.match(r5.stdout, /Not in the list/);
});

test('mark refuses connection strings, credentials and URLs; needs --test or --not-test', async () => {
  for (const bad of ['Server=x;Password=y', 'sa:hunter2@host', 'mssql://host/db', 'host with space', 'my password host']) {
    const r = await capture(() => main(['mark', '--server', bad, '--test']));
    assert.equal(r.code, 2, bad);
    assert.match(r.stderr, /hostnames only|expected/);
  }
  const r = await capture(() => main(['mark', '--server', 'host']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--test, --read-only or --not-test/);
  const both = await capture(() => main(['mark', '--server', 'host', '--test', '--not-test']));
  assert.equal(both.code, 2);
  assert.equal(validateServer('db.example.test,1433'), null);
  assert.equal(validateServer('server\\instance'), null);
  assert.equal(validateServer('[::1],1433'), null);
  assert.notEqual(validateServer('host,99999'), null);
  assert.equal(normaliseServer(' TCP:Host , 1433 '), 'host,1433');
  // the stored config never carries a password-looking value
  const text = fs.readFileSync(path.join(h.harnessHome, 'config.json'), 'utf8');
  assert.doesNotMatch(text, /hunter2|Password/);
});

test('markTarget/unmarkTarget keep the hash in step and drop undefined databases', () => {
  const c = defaultConfig();
  assert.equal(markTarget(c, { server: 'a', marked: 'test' }), true);
  assert.equal(markTarget(c, { server: 'A', marked: 'not-test' }), false, 'case-insensitive update');
  assert.equal(c.db.allowlist.length, 1);
  assert.equal('database' in c.db.allowlist[0], false);
  assert.equal(c.db.markedHash, allowlistHash(c));
  assert.equal(unmarkTarget(c, { server: 'a' }), true);
  assert.equal(c.db.allowlist.length, 0);
  assert.equal(c.db.markedHash, allowlistHash(c));
});

test('candidates: explains how to mark by hand when none were discovered, lists them when present', async () => {
  const none = await capture(() => main(['candidates']));
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No discovered candidates yet/);
  assert.match(none.stdout, /harness db mark --server/);
  write(candidatesPath(), JSON.stringify({ version: 1, generatedAt: '2026-10-19T00:00:00Z', candidates: [{ server: 'localhost,1433', database: 'shop_test', sources: ['appsettings.json'] }, { server: 'prod-sql' }] }));
  const some = await capture(() => main(['candidates']));
  assert.equal(some.code, 0);
  assert.match(some.stdout, /localhost,1433\s+shop_test\s+\[not-test\]/);
  assert.match(some.stdout, /prod-sql\s+\[unmarked\]/);
  const j = await capture(() => main(['candidates', '--json']));
  assert.equal(JSON.parse(j.stdout).candidates.length, 2);
});

test('interactive marking needs a terminal; without one it says which flags to use', async () => {
  await withTty(false, false, async () => {
    const r = await capture(() => main(['mark']));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no terminal to ask in/);
  });
});

test('mark --read-only: stored, signed, listed; one mark flag only (exit 2 on two); a server-wide mark gets a note', async () => {
  const r = await capture(() => main(['mark', '--server', 'sql-shared', '--database', 'reporting', '--read-only']));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Marked sql-shared reporting as read-only/);
  const c = loadConfig()!;
  const e = c.db.allowlist.find((x) => x.server === 'sql-shared');
  assert.deepEqual(e, { server: 'sql-shared', database: 'reporting', marked: 'read-only' });
  assert.equal(c.db.markedHash, allowlistHash(c), 'the signature covers the new value');
  const list = await capture(() => main(['list']));
  assert.match(list.stdout, /sql-shared\s+reporting\s+read-only/);
  assert.match(list.stdout, /read-only: the agent may run only inline SELECT statements/);
  for (const pair of [['--test', '--read-only'], ['--read-only', '--not-test'], ['--test', '--not-test'], ['--test', '--read-only', '--not-test']]) {
    const two = await capture(() => main(['mark', '--server', 'sql-shared', '--database', 'reporting', ...pair]));
    assert.equal(two.code, 2, pair.join(' '));
    assert.match(two.stderr, /only one of --test, --read-only or --not-test/);
  }
  const none = await capture(() => main(['mark', '--server', 'sql-shared']));
  assert.equal(none.code, 2);
  assert.match(none.stderr, /--test, --read-only or --not-test/);
  const wide = await capture(() => main(['mark', '--server', 'ro-wide', '--read-only']));
  assert.equal(wide.code, 0);
  assert.match(wide.stdout, /server-wide read-only mark covers every database/);
  // unmark is unchanged
  assert.equal((await capture(() => main(['unmark', '--server', 'ro-wide']))).code, 0);
  assert.equal((await capture(() => main(['unmark', '--server', 'sql-shared', '--database', 'reporting']))).code, 0);
  assert.equal(loadConfig()!.db.allowlist.some((x) => x.marked === 'read-only'), false);
});

test('interactive marking offers test / read-only / not-test / skip and stores the answer', async () => {
  write(candidatesPath(), JSON.stringify({ version: 1, candidates: [{ server: 'cand-ro', database: 'facts' }, { server: 'cand-skip' }] }));
  const asked: string[][] = [];
  const answers = ['read-only', 'skip'];
  const r = await capture(() =>
    interactiveMark(
      false,
      [],
      async (_q, choices) => {
        asked.push(choices);
        return answers.shift() ?? 'skip';
      },
      () => true,
    ),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(asked[0], ['test', 'read-only', 'not-test', 'skip']);
  assert.deepEqual(MARK_CHOICES, ['test', 'read-only', 'not-test', 'skip']);
  const c = loadConfig()!;
  assert.deepEqual(c.db.allowlist.find((x) => x.server === 'cand-ro'), { server: 'cand-ro', database: 'facts', marked: 'read-only' });
  assert.equal(c.db.allowlist.some((x) => x.server === 'cand-skip'), false);
  assert.equal(c.db.markedHash, allowlistHash(c));
});
