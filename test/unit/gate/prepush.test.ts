import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkPushLines, parsePushLines, refusalMessage } from '../../../src/gate/prepush';
import { commitAll, git, gitRepo, put } from './helpers';

const Z = '0'.repeat(40);

function repo(): { root: string; cleanup(): void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-prepush-'));
  const root = gitRepo(path.join(tmp, 'r'));
  return { root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('prepush: parses the four-field lines git sends and keeps malformed ones for refusal', () => {
  const a = 'a'.repeat(40);
  const lines = parsePushLines(`refs/heads/main ${a} refs/heads/main ${Z}\n\nnot a line\n`);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { localRef: 'refs/heads/main', localSha: a, remoteRef: 'refs/heads/main', remoteSha: Z });
  assert.ok('malformed' in lines[1]);
});

test('prepush: a new ref and a fast-forward pass; a non-fast-forward, a deletion and an unknown remote commit are refused', () => {
  const r = repo();
  try {
    const c1 = git(r.root, ['rev-parse', 'HEAD']).stdout.trim();
    put(r.root, 'a.txt', 'a\n');
    const c2 = commitAll(r.root, 'two');
    // a sibling of c2 (rewritten history): c1 -> c3
    git(r.root, ['checkout', '-q', '-b', 'other', c1]);
    put(r.root, 'b.txt', 'b\n');
    const c3 = commitAll(r.root, 'three');
    const unknown = 'f'.repeat(40);
    const check = (text: string) => checkPushLines(r.root, parsePushLines(text));
    assert.deepEqual(check(`refs/heads/main ${c2} refs/heads/main ${Z}`), [], 'new remote ref');
    assert.deepEqual(check(`refs/heads/main ${c2} refs/heads/main ${c1}`), [], 'fast-forward');
    assert.deepEqual(check(`refs/heads/main ${c2} refs/heads/main ${c2}`), [], 'no change');
    assert.deepEqual(check(`refs/heads/main ${c3} refs/heads/main ${c2}`), [{ remoteRef: 'refs/heads/main', why: 'non-fast-forward' }]);
    assert.deepEqual(check(`refs/heads/main ${c1} refs/heads/main ${c2}`), [{ remoteRef: 'refs/heads/main', why: 'non-fast-forward' }], 'moving a branch back');
    assert.deepEqual(check(`(delete) ${Z} refs/heads/main ${c2}`), [{ remoteRef: 'refs/heads/main', why: 'delete' }]);
    assert.deepEqual(check(`refs/heads/main ${c2} refs/heads/main ${unknown}`), [{ remoteRef: 'refs/heads/main', why: 'unknown-remote-commit' }]);
    assert.equal(check('garbage line').length, 1);
    // several refs: only the bad one is named
    const both = check(`refs/heads/main ${c2} refs/heads/main ${c1}\nrefs/heads/other ${c3} refs/heads/other ${c2}`);
    assert.deepEqual(both.map((x) => x.remoteRef), ['refs/heads/other']);
    assert.match(refusalMessage(both), /refs\/heads\/other: is not a fast-forward/);
  } finally {
    r.cleanup();
  }
});
