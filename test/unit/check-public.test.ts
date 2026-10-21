/**
 * scripts/check-public.js, run as a process the way CI and a publisher run it:
 * denylist tokens and this machine's absolute paths (home folder, the checked
 * folder) are caught with file and line; the token itself is not printed in
 * full; a missing denylist is an error, not a silent pass.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/lib/exec';
import { packageRoot } from '../../src/lib/paths';

const SCRIPT = path.join(packageRoot(), 'scripts', 'check-public.js');

function check(root: string, args: string[], home: string): { code: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.HARNESS_PUBLIC_DENYLIST;
  const r = run(process.execPath, [SCRIPT, '--root', root, ...args], { env, timeoutMs: 30_000 });
  return { code: r.code, out: r.stdout + r.stderr };
}

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-public-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('check-public: a clean folder passes; a denylist token fails with file and line, the token shortened', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-public-home-'));
  const lists = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-public-list-'));
  const deny = path.join(lists, 'tokens.txt');
  fs.writeFileSync(deny, '# private\nacme-internal-billing\n');
  const clean = tree({ 'README.md': '# tool\n', 'src/a.ts': 'export const a = 1;\n' });
  const dirty = tree({ 'README.md': '# tool\n', 'docs/x.md': 'line one\nsee ACME-Internal-Billing for details\n' });
  try {
    const ok = check(clean, ['--denylist', deny], home);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /check-public: ok/);
    const bad = check(dirty, ['--denylist', deny], home);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /docs[\\/]x\.md:2: contains a forbidden token/);
    assert.doesNotMatch(bad.out, /acme-internal-billing/i, 'the token is not printed in full');
  } finally {
    for (const d of [home, lists, clean, dirty]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('check-public: this machine\'s home folder and the checked folder\'s absolute path are caught without a denylist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-public-home-'));
  const homeRef = tree({ 'docs/run.md': `ran it from ${path.join(home, 'work', 'repo')}\n` });
  const selfRef = tree({});
  fs.writeFileSync(path.join(selfRef, 'notes.md'), `cloned into ${selfRef.split(path.sep).join('/')}\n`);
  const generic = tree({ 'a.md': 'the home folder is ~/.harness\n' });
  try {
    const a = check(homeRef, [], home);
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /docs[\\/]run\.md:1/);
    const b = check(selfRef, [], home);
    assert.equal(b.code, 1, b.out);
    assert.match(b.out, /notes\.md:1/);
    const c = check(generic, [], home);
    assert.equal(c.code, 0, `a generic ~ path is fine: ${c.out}`);
  } finally {
    for (const d of [home, homeRef, selfRef, generic]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('check-public: a denylist that does not exist is an error, not a pass', () => {
  const root = tree({ 'a.md': 'x\n' });
  try {
    const r = check(root, ['--denylist', path.join(root, 'missing.txt')], os.homedir());
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check-public: the harness folder itself carries no absolute path of this machine', () => {
  const r = run(process.execPath, [SCRIPT], { timeoutMs: 60_000, env: { ...process.env, HARNESS_PUBLIC_DENYLIST: '' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});
