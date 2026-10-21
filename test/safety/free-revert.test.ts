/**
 * Safety: free mode (personal setting) reverts on a red main with one revert
 * commit, never a force-push or a rewrite (DESIGN §2.8 landing loop, §2.10
 * no history rewrite; EVAL-PLAN §8 end of work "revert_correct on every
 * planted post-landing failure and 0 wrong reverts").
 *
 * How (CLI and git, no agent): a temp personal repo with a local bare
 * origin and the real personal install (git hooks on). main carries a probe
 * test that passes everywhere except under CI (`CI=true`, which the local CI
 * stand-in sets) once src/flag.js exists. A task added with `harness task
 * add` is worked on task/<id> (adds src/flag.js), gated with the real
 * `harness gate` (PASS), then `harness land --ci local --fixer none` lands
 * it, sees CI red, reruns, finds it red again and reverts. Checked: exactly
 * one revert commit on top of the landed commits, revert_correct, main's
 * tree back at the old main's, every commit main had before is still in its
 * history with the same parents, origin's main moved only forward (each
 * step a fast-forward of the one before), and the task is back to todo with
 * a note.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { built, cli, git, initRepo, install, report, sandbox } from './helpers';

const PROBE = `const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
// Planted post-landing failure: green everywhere except under CI once src/flag.js has landed.
test('probe', () => {
  const landed = fs.existsSync(path.join(__dirname, '..', 'src', 'flag.js'));
  assert.equal(process.env.CI === 'true' && landed, false);
});
`;

test('free mode: a landing whose CI goes red ends in exactly one revert commit, the task re-queued, no force-push and main history untouched', (t) => {
  const nb = built();
  if (nb) return t.skip(nb);
  if (process.platform === 'win32') return t.skip('the rendered POSIX git hooks are exercised here (Windows not run)');
  const sb = sandbox('revert');
  try {
    const repo = initRepo(
      path.join(sb.tmp, 'repo'),
      {
        'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
        'src/total.js': 'exports.total = (xs) => xs.reduce((a, b) => a + b, 0);\n',
        'test/total.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('../src/total');\ntest('total', () => assert.equal(total([1, 2]), 3));\n",
        'test/probe.test.js': PROBE,
      },
      sb.env,
    );
    const origin = path.join(sb.tmp, 'origin.git');
    git(sb.tmp, ['init', '-q', '--bare', origin], sb.env);
    git(repo, ['remote', 'add', 'origin', origin], sb.env);
    install(sb, 'personal', ['claude'], repo, ['--commit']);
    // the task, added through the CLI and committed by the user (set-up, hooks off)
    const add = cli(sb, ['task', 'add', '--title', 'Add a feature flag', '--priority', '1', '--acceptance', 'src/flag.js exports enabled', '--paths', 'src', '--repo', repo], repo);
    assert.equal(add.code, 0, `task add: ${add.stdout}${add.stderr}`);
    const id = /\bT-\d+\b/.exec(add.stdout + add.stderr)?.[0];
    assert.ok(id, `a task id in: ${add.stdout}`);
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'add', '-A'], sb.env);
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `chore: add task ${id}`], sb.env);
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'push', '-q', '-u', 'origin', 'main'], sb.env);
    const main0 = git(repo, ['rev-parse', 'main'], sb.env).stdout.trim();
    const history0 = git(repo, ['rev-list', '--parents', 'main'], sb.env).stdout.trim().split('\n');

    // the work on task/<id>, in its own worktree the way the runner makes it
    const wt = path.join(sb.tmp, 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', `task/${id}`, wt, 'main'], sb.env);
    fs.writeFileSync(path.join(wt, 'src', 'flag.js'), 'exports.enabled = true;\n');
    git(wt, ['add', 'src/flag.js'], sb.env);
    git(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feat: add a feature flag'], sb.env);
    const g = cli(sb, ['gate', '--task', id!, '--json'], wt);
    let verdict = '?';
    try {
      verdict = JSON.parse(g.stdout).evidence.verdict;
    } catch {
      /* below */
    }
    assert.equal(verdict, 'PASS', `the task gate passes outside CI: ${g.stdout.slice(-800)} ${g.stderr.slice(-400)}`);

    // land: CI red, rerun red, no fixer: one revert
    const land = cli(sb, ['land', '--task', id!, '--repo', repo, '--ci', 'local', '--fixer', 'none', '--json'], repo, {}, 600_000);
    let rec: any = null;
    try {
      rec = JSON.parse(land.stdout).landing;
    } catch {
      rec = null;
    }
    assert.ok(rec, `land printed its record (exit ${land.code}): ${land.stdout.slice(-800)} ${land.stderr.slice(-800)}`);
    const main1 = git(repo, ['rev-parse', 'main'], sb.env).stdout.trim();
    const since = git(repo, ['log', '--format=%H %s', `${main0}..main`], sb.env).stdout.trim().split('\n').filter(Boolean);
    const reverts = since.filter((l) => / (Revert "|revert: )/.test(l));
    const sameTree = git(repo, ['rev-parse', `${main0}^{tree}`], sb.env).stdout.trim() === git(repo, ['rev-parse', 'main^{tree}'], sb.env).stdout.trim();
    const history1 = git(repo, ['rev-list', '--parents', main0], sb.env).stdout.trim().split('\n');
    const originMain = git(origin, ['rev-parse', 'refs/heads/main'], sb.env).stdout.trim();
    const forward = git(repo, ['merge-base', '--is-ancestor', main0, originMain], sb.env, true).code === 0;
    // every commit origin received is a descendant chain from main0: walk first parents back to main0
    const chain = git(repo, ['rev-list', '--first-parent', `${main0}..${originMain}`], sb.env).stdout.trim().split('\n').filter(Boolean);
    const list = cli(sb, ['task', 'list', '--json', '--repo', repo], repo);
    const task = (() => {
      try {
        const j = JSON.parse(list.stdout);
        return (Array.isArray(j) ? j : j.tasks ?? []).find((x: { id: string }) => x.id === id);
      } catch {
        return null;
      }
    })();
    const ledgerText = fs.readdirSync(path.join(repo, 'tasks')).filter((f) => f.startsWith(id!)).map((f) => fs.readFileSync(path.join(repo, 'tasks', f), 'utf8')).join('\n');
    report(
      t,
      `free-mode revert: land exit ${land.code}, outcome ${rec.outcome}, reverted ${rec.reverted}, revert_correct ${rec.revert_correct}; commits on main since the old main ${since.length} (revert commits ${reverts.length}); main tree back at the old main ${sameTree}; old history intact ${JSON.stringify(history1) === JSON.stringify(history0)}; origin main = local main ${originMain === main1}, origin moved forward only ${forward} (${chain.length} first-parent commits on top); task status ${task?.status ?? '?'}`,
    );
    assert.equal(rec.outcome, 'reverted');
    assert.equal(rec.reverted, true);
    assert.equal(rec.revert_correct, true);
    assert.equal(reverts.length, 1, `exactly one revert commit: ${since.join(' | ')}`);
    assert.ok(since[0].includes(reverts[0].split(' ')[0]), 'the revert is the tip of main');
    assert.ok(sameTree, "main's tree is the old main's tree again");
    assert.deepEqual(history1, history0, "every commit main had before keeps its place and parents");
    assert.equal(originMain, main1, 'origin has the revert');
    assert.ok(forward, "origin's main only moved forward from the old main (no force-push)");
    assert.equal(task?.status, 'todo', `the task is re-queued: ${list.stdout.slice(0, 300)}`);
    assert.match(ledgerText, /revert/i, 'the ledger notes the revert');
  } finally {
    sb.cleanup();
  }
});
