import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureWorktree, harnessWorktreePath, listWorktrees, mainWorktreeRoot, pickSubject, subjectTitle, summaryCase } from '../../../src/land/gitops';
import { writeTree } from '../../../src/lib/git';
import { cleanupEnv, git, gitRepo, hermeticGit, put, tempHome, tree } from './helpers';

test('worktrees share the main checkout\'s node_modules (a folder of links) that git never sees', () => {
  const h = tempHome('harness-gitops-');
  try {
    hermeticGit(h);
    const root = gitRepo(path.join(h.workspace, 'repo'), { '.gitignore': 'node_modules/\n', 'package.json': '{"name":"x"}\n' });
    put(root, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    const wt = harnessWorktreePath('repo-1', 'T-1');
    const made = ensureWorktree(root, wt, 'task/T-1', 'main');
    assert.ok(made.ok);
    assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isDirectory());
    assert.ok(fs.lstatSync(path.join(wt, 'node_modules', 'dep')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(wt, 'node_modules/dep/index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(git(wt, ['status', '--porcelain']).stdout.trim(), '', 'the link is not an untracked file');
    assert.equal(writeTree(wt), tree(wt, 'HEAD'), 'the tree hash the gate uses ignores the link');
    assert.equal(git(root, ['status', '--porcelain']).stdout.trim(), '', 'the main checkout is unchanged');
    // Reusing the worktree is a no-op; the main working tree is found from either.
    const again = ensureWorktree(root, wt, 'task/T-1', 'main');
    assert.ok(again.ok && !again.created);
    assert.equal(mainWorktreeRoot(wt), fs.realpathSync(root));
    assert.deepEqual(listWorktrees(root).map((w) => w.branch), ['main', 'task/T-1']);
  } finally {
    h.cleanup();
    cleanupEnv();
  }
});

test('pickSubject follows the repository\'s commit-subject standard from the ledger', () => {
  const h = tempHome('harness-gitops-');
  try {
    const cands = ['T-1: Make a 42', 'chore: Make a 42 (T-1)'];
    assert.equal(pickSubject(cands), 'T-1: Make a 42', 'no ledger: the first');
    const ledgerDir = path.join(h.harnessHome, 'ledger');
    fs.mkdirSync(path.join(ledgerDir, 'checks'), { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, 'ledger.json'), JSON.stringify({ version: 1, records: [{ id: 'naming.conventional-commits', scope: { repos: ['*'] }, statement: 'Conventional subjects', check: { mode: 'block' } }] }));
    fs.writeFileSync(path.join(ledgerDir, 'checks', 'naming.conventional-commits.json'), JSON.stringify({ engine: 'subjects', conform: '^(feat|fix|chore|docs|test|refactor|revert)(\\([^)]+\\))?!?: .+' }));
    assert.equal(pickSubject(cands), 'chore: Make a 42 (T-1)');
    assert.equal(pickSubject(['Merge branch \'main\' into task/T-1', 'chore: merge main into task/T-1']), 'chore: merge main into task/T-1');
    assert.equal(pickSubject(['nope', 'still nope']), 'nope', 'nothing conforms: the first');
    assert.equal(subjectTitle('x'.repeat(80), 20), 'x'.repeat(17) + '...');
    // a conventional summary starts in lower case; acronyms stay
    assert.equal(summaryCase('Say how long ago something expired'), 'say how long ago something expired');
    assert.equal(summaryCase('API errors as JSON'), 'API errors as JSON');
    assert.equal(summaryCase('iOS build'), 'iOS build');
  } finally {
    h.cleanup();
  }
});
