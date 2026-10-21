/**
 * scripts/publish-copy.js, run as a process on temporary repositories: a fake
 * development repository (a `harness/` folder plus private material outside it)
 * and a bare "public" repository. Covers the drift check, the first publish
 * (one root commit), a later publish (a child commit, history of two), and the
 * refusals (dirty tree, same version without --force). `--skip-build` is the
 * test-only switch that skips the npm steps.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../../src/lib/exec';
import { packageRoot } from '../../../src/lib/paths';

const SCRIPT = path.join(packageRoot(), 'scripts', 'publish-copy.js');
const CHECK_PUBLIC = path.join(packageRoot(), 'scripts', 'check-public.js');

function git(cwd: string, ...args: string[]): string {
  const r = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, timeoutMs: 30_000 });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function fakeDev(version: string): string {
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pc-dev-'));
  git(dev, 'init', '-q', '-b', 'main');
  write(dev, 'harness/package.json', JSON.stringify({ name: 'tool', version }) + '\n');
  write(dev, 'harness/README.md', '# tool\n');
  write(dev, 'harness/.gitignore', 'node_modules/\ndist/\n');
  write(dev, 'harness/src/a.txt', 'a\n');
  fs.mkdirSync(path.join(dev, 'harness', 'scripts'));
  fs.copyFileSync(CHECK_PUBLIC, path.join(dev, 'harness', 'scripts', 'check-public.js'));
  write(dev, 'notes/private.txt', 'private research\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'start');
  return dev;
}

function commitChange(dev: string, rel: string, text: string, version?: string): void {
  write(dev, rel, text);
  if (version) write(dev, 'harness/package.json', JSON.stringify({ name: 'tool', version }) + '\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'change');
}

function barePublic(): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pc-pub-'));
  git(p, 'init', '-q', '--bare', '-b', 'main');
  return p;
}

function script(dev: string, args: string[]): { code: number | null; out: string } {
  const r = run(process.execPath, [SCRIPT, '--dev', dev, ...args], { timeoutMs: 60_000 });
  return { code: r.code, out: r.stdout + r.stderr };
}

test('publish-copy --publish on an empty public repository makes one root commit whose tree is HEAD:harness; --check then passes', () => {
  const dev = fakeDev('1.0.0');
  const pub = barePublic();
  const r = script(dev, ['--publish', pub, '--skip-build']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /root commit/);
  assert.equal(git(pub, 'rev-parse', 'main^{tree}'), git(dev, 'rev-parse', 'HEAD:harness'));
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '1');
  assert.equal(git(pub, 'log', '-1', '--format=%s', 'main'), 'harness 1.0.0');
  assert.match(git(pub, 'log', '-1', '--format=%b', 'main'), new RegExp(`development commit ${git(dev, 'rev-parse', '--short=7', 'HEAD')}`));
  assert.ok(!git(pub, 'ls-tree', '-r', '--name-only', 'main').includes('private'), 'nothing from outside harness/ is published');
  const c = script(dev, ['--check', pub]);
  assert.equal(c.code, 0, c.out);
});

test('publish-copy --check names a changed file and exits 1; a missing public main exits 1', () => {
  const dev = fakeDev('1.0.0');
  const pub = barePublic();
  assert.equal(script(dev, ['--check', pub]).code, 1, 'an empty public repository is not in step');
  assert.equal(script(dev, ['--publish', pub, '--skip-build']).code, 0);
  commitChange(dev, 'harness/src/a.txt', 'changed\n');
  write(dev, 'harness/src/new.txt', 'new\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'add');
  const c = script(dev, ['--check', pub]);
  assert.equal(c.code, 1);
  assert.match(c.out, /differs: src\/a\.txt/);
  assert.match(c.out, /only in the development repository: src\/new\.txt/);
  assert.doesNotMatch(c.out, /README/);
});

test('publish-copy --publish after a change and a version bump adds a child commit: history of two, tree updated', () => {
  const dev = fakeDev('1.0.0');
  const pub = barePublic();
  assert.equal(script(dev, ['--publish', pub, '--skip-build']).code, 0);
  const first = git(pub, 'rev-parse', 'main');
  commitChange(dev, 'harness/src/a.txt', 'second\n', '1.1.0');
  const r = script(dev, ['--publish', pub, '--version', '1.1.0', '--skip-build']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /child of the public main/);
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '2');
  assert.equal(git(pub, 'rev-parse', 'main~1'), first, 'the earlier public commit is the parent');
  assert.equal(git(pub, 'rev-parse', 'main^{tree}'), git(dev, 'rev-parse', 'HEAD:harness'));
  assert.equal(git(pub, 'log', '-1', '--format=%s', 'main'), 'harness 1.1.0');
  assert.equal(script(dev, ['--check', pub]).code, 0);
  const again = script(dev, ['--publish', pub, '--skip-build']);
  assert.equal(again.code, 0, 'nothing new to publish is not an error');
  assert.match(again.out, /Nothing to publish/);
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '2');
});

test('publish-copy --publish refuses a dirty tree under harness/, and the same version without --force', () => {
  const dev = fakeDev('1.0.0');
  const pub = barePublic();
  assert.equal(script(dev, ['--publish', pub, '--skip-build']).code, 0);
  commitChange(dev, 'harness/src/a.txt', 'second\n');

  const same = script(dev, ['--publish', pub, '--skip-build']);
  assert.equal(same.code, 1);
  assert.match(same.out, /already at version 1\.0\.0/);
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '1', 'nothing was pushed');

  write(dev, 'harness/src/a.txt', 'uncommitted\n');
  const dirty = script(dev, ['--publish', pub, '--skip-build', '--force']);
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /uncommitted changes/);
  git(dev, 'checkout', '--', 'harness/src/a.txt');

  const forced = script(dev, ['--publish', pub, '--skip-build', '--force']);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '2');
});

test('publish-copy --publish stops when the denylist finds a token, and pushes nothing; --version must match package.json', () => {
  const dev = fakeDev('1.0.0');
  commitChange(dev, 'harness/README.md', 'mentions acme-internal-billing\n');
  const pub = barePublic();
  const lists = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pc-list-'));
  const deny = path.join(lists, 'tokens.txt');
  fs.writeFileSync(deny, 'acme-internal-billing\n');
  const bad = script(dev, ['--publish', pub, '--skip-build', '--denylist', deny]);
  assert.notEqual(bad.code, 0);
  assert.equal(git(pub, 'for-each-ref', 'refs/heads').trim(), '', 'nothing was pushed');
  const wrong = script(dev, ['--publish', pub, '--skip-build', '--version', '9.9.9']);
  assert.equal(wrong.code, 2);
  assert.match(wrong.out, /does not match/);
});

test('publish-copy --publish --tag pushes v<version>; a tag push that fails is reported, not fatal', () => {
  const dev = fakeDev('1.0.0');
  const pub = barePublic();
  const ok = script(dev, ['--publish', pub, '--skip-build', '--tag']);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(git(pub, 'rev-parse', 'refs/tags/v1.0.0^{tree}'), git(dev, 'rev-parse', 'HEAD:harness'));

  commitChange(dev, 'harness/src/a.txt', 'two\n', '1.0.1');
  const hook = path.join(pub, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/tags/*) echo "tags refused" >&2; exit 1;; esac; done\n', { mode: 0o755 });
  if (process.platform === 'win32') return; // hooks are shell scripts
  const refused = script(dev, ['--publish', pub, '--skip-build', '--tag']);
  assert.equal(refused.code, 0, refused.out);
  assert.match(refused.out, /tag v1\.0\.1 was not pushed/);
  assert.equal(git(pub, 'rev-list', '--count', 'main'), '2');
});

test('publish-copy refuses to run from a repository with no harness/ folder (the public copy)', () => {
  const notDev = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pc-notdev-'));
  git(notDev, 'init', '-q', '-b', 'main');
  write(notDev, 'package.json', '{}\n');
  git(notDev, 'add', '-A');
  git(notDev, 'commit', '-q', '-m', 'x');
  const r = script(notDev, ['--check', barePublic()]);
  assert.equal(r.code, 2);
  assert.match(r.out, /not from the public copy/);
});
