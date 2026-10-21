import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseJsonc, unionJson } from '../../src/lib/jsonc';
import { scanHiddenUnicode, stripHiddenUnicode } from '../../src/lib/unicode';
import { findSecrets, redactObject, isSecretFile } from '../../src/lib/redact';
import { parseArgv, flagList } from '../../src/lib/argv';
import { parseFrontMatter } from '../../src/lib/frontmatter';
import { slug, subPath } from '../../src/lib/paths';

test('jsonc parses comments, trailing commas, BOM', () => {
  const v = parseJsonc<{ a: number; b: string[] }>('﻿{ // c\n "a": 1, /* x */ "b": ["http://x", ], }');
  assert.equal(v.a, 1);
  assert.deepEqual(v.b, ['http://x']);
});

test('unionJson never removes existing entries', () => {
  const base = { permissions: { deny: ['Bash(git push *)'] }, hooks: { Stop: [{ hooks: [{ command: 'a' }] }] } };
  const add = { permissions: { deny: ['Bash(git push *)', 'Bash(git rebase *)'], allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ command: 'b' }] }] } };
  const out = unionJson(base, add) as typeof add;
  assert.deepEqual(out.permissions.deny, ['Bash(git push *)', 'Bash(git rebase *)']);
  assert.deepEqual(out.permissions.allow, ['Read']);
  assert.equal(out.hooks.Stop.length, 2);
});

test('hidden unicode scan and strip', () => {
  const s = 'hello​world\u{E0041}!';
  const hits = scanHiddenUnicode(s);
  assert.equal(hits.length, 2);
  assert.equal(stripHiddenUnicode(s), 'helloworld!');
  assert.equal(scanHiddenUnicode('﻿plain').length, 0);
});

test('secrets are found and redacted', () => {
  const hits = findSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz0123 and Server=x;Password=hunter22;');
  assert.ok(hits.some((h) => h.name === 'github-token'));
  assert.ok(hits.some((h) => h.name === 'connection-string-password'));
  const o = redactObject({ Authorization: 'Bearer abc', body: { password: 'x', ok: 'fine' } });
  assert.equal(o.Authorization, '[DROPPED]');
  assert.equal(o.body.password, '[DROPPED]');
  assert.equal(o.body.ok, 'fine');
  assert.ok(isSecretFile('.env.local'));
  assert.ok(isSecretFile('keys/id_rsa'));
  assert.ok(!isSecretFile('src/env.ts'));
});

test('argv parsing', () => {
  const p = parseArgv(['--setting', 'team', '--agents', 'devin,claude', '--agents', 'codex', '--dry-run', 'pos', '--', '--x']);
  assert.equal(p.flags.setting, 'team');
  assert.deepEqual(flagList(p, 'agents'), ['devin', 'claude', 'codex']);
  assert.equal(p.flags['dry-run'], true);
  assert.deepEqual(p.positional, ['pos', '--x']);
});

test('argv parsing: a lone dash is the value of the flag before it (standard input)', () => {
  const p = parseArgv(['submit', 'j1', '--from', '-', '--json']);
  assert.equal(p.flags.from, '-');
  assert.deepEqual(p.positional, ['submit', 'j1']);
  assert.equal(p.flags.json, true);
  // a flag-looking next word is still not a value
  assert.equal(parseArgv(['--from', '--json']).flags.from, true);
});

test('front matter', () => {
  const fm = parseFrontMatter('---\nname: task\ndescription: "Use when: starting"\npaths: [src/**, "lib/**"]\ntags:\n  - a\n  - b\n---\nbody here\n');
  assert.equal(fm.data.name, 'task');
  assert.equal(fm.data.description, 'Use when: starting');
  assert.deepEqual(fm.data.paths, ['src/**', 'lib/**']);
  assert.deepEqual(fm.data.tags, ['a', 'b']);
  assert.equal(fm.body, 'body here\n');
});

test('paths helpers', () => {
  assert.equal(slug('My Repo/Name!'), 'my-repo-name');
  assert.ok(subPath('/a/b', '/a/b/c'));
  assert.ok(!subPath('/a/b', '/a/bc'));
});
