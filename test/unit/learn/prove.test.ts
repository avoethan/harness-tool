import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckSpec } from '../../../src/discover/checks';
import { astGrepProof, eslintProof, gateEventProof, proveLesson, regexProof, regressionProof } from '../../../src/learn/prove';
import type { LessonRecord } from '../../../src/learn/store';
import type { Occurrence } from '../../../src/learn/capture';
import { CONSOLE_RULE, astGrepOrSkip, commitAll, demoRepo, put, tempHome } from './helpers';

const NOW = '2026-10-01T00:00:00.000Z';

function lesson(p: Partial<LessonRecord> = {}): LessonRecord {
  return {
    version: 1,
    id: 'l-test-000000',
    key: 'rule:logging.logger-not-console',
    class: 'rule:logging.logger-not-console',
    kind: 'rule',
    description: 'd',
    occurrences: 2,
    firstSeen: NOW,
    lastSeen: NOW,
    sources: [],
    status: 'proposed',
    tier: 0,
    touchedRail: false,
    repos: [],
    counts: {},
    followUps: 0,
    capturedAt: NOW,
    updatedAt: NOW,
    history: [],
    ...p,
  };
}

const consoleSpec = { version: 1, id: 'logging.logger-not-console', engine: 'ast-grep', mode: 'block', statement: 's', scope: { repos: ['*'] }, rules: [CONSOLE_RULE] } as unknown as CheckSpec;

test('ast-grep proof: the rule must report the mistake sample (ast-grep test) and not the valid one', (t) => {
  const { bin, skip } = astGrepOrSkip();
  if (skip) return t.skip(skip);
  const ok = astGrepProof(consoleSpec, { invalid: ["console.log('order', id);"], valid: ["logger.info('order', { id });"], source: 'user' }, bin, NOW);
  assert.equal(ok.result, 'proven', ok.detail);
  assert.equal(ok.method, 'ast-grep-test');
  assert.equal(ok.fixtureSource, 'user');
  const missing = astGrepProof(consoleSpec, { invalid: ["logger.info('x');"], valid: [], source: 'user' }, bin, NOW);
  assert.equal(missing.result, 'not-proven');
  assert.match(missing.detail, /0 of 1/);
  const noisy = astGrepProof(consoleSpec, { invalid: ["console.log('x');"], valid: ["console.error('y');"], source: 'judgment' }, bin, NOW);
  assert.equal(noisy.result, 'not-proven');
  assert.match(noisy.detail, /1 valid sample/);
});

test('ast-grep proof without ast-grep stays unproven with the reason', () => {
  const r = astGrepProof(consoleSpec, { invalid: ['console.log(1)'], valid: [], source: 'user' }, null, NOW);
  assert.equal(r.result, 'not-proven');
  assert.match(r.detail, /not installed/);
});

test('regex proof: every mistake sample matches, no valid sample does', () => {
  const spec = { version: 1, id: 'a.learned-b', engine: 'regex', mode: 'block', statement: 's', scope: { repos: ['*'] }, target: 'match', violate: ['\\bdebugger\\b'] } as unknown as CheckSpec;
  assert.equal(regexProof(spec, { invalid: ['x(); debugger;'], valid: ['const debuggerName = 1;'], source: 'judgment' }, NOW).result, 'proven');
  assert.equal(regexProof(spec, { invalid: ['nothing here'], valid: [], source: 'judgment' }, NOW).result, 'not-proven');
});

test("ESLint proof runs the repository's own ESLint on the samples through --stdin", () => {
  const h = tempHome('harness-learn-eslint-');
  try {
    const repo = path.join(h.workspace, 'repo');
    put(repo, 'package.json', '{"name":"r"}\n');
    put(repo, 'node_modules/eslint/package.json', JSON.stringify({ name: 'eslint', version: '9.0.0', bin: { eslint: 'bin/eslint.js' } }));
    // A stand-in ESLint: reports no-console when the stdin text calls console.*; checks the flags it is given.
    put(
      repo,
      'node_modules/eslint/bin/eslint.js',
      "#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);if(!a.includes('--stdin')||!a.includes('--stdin-filename')){process.exit(9)}\nconst t=fs.readFileSync(0,'utf8');const f=a[a.indexOf('--stdin-filename')+1];\nconst m=/console\\.\\w+\\(/.test(t)?[{ruleId:'no-console',line:1,message:'Unexpected console statement.'}]:[];\nprocess.stdout.write(JSON.stringify([{filePath:f,messages:m}]));process.exit(m.length?1:0);\n",
    );
    const ok = eslintProof(repo, 'no-console', { invalid: ["console.log('x');"], valid: ["logger.info('x');"], source: 'user' }, NOW);
    assert.equal(ok.result, 'proven', ok.detail);
    assert.equal(ok.method, 'eslint-fixture');
    const wrongRule = eslintProof(repo, 'eqeqeq', { invalid: ["console.log('x');"], valid: [], source: 'user' }, NOW);
    assert.equal(wrongRule.result, 'not-proven');
    const none = eslintProof(path.join(h.workspace, 'no-eslint'), 'no-console', { invalid: ['x'], valid: [], source: 'user' }, NOW);
    assert.match(none.detail, /not installed/);
  } finally {
    h.cleanup();
  }
});

test('regression proof: the test fails on the commit before the fix and passes on the fix (temporary worktrees)', () => {
  const h = tempHome('harness-learn-regress-');
  try {
    const repo = demoRepo(path.join(h.workspace, 'repo'), { 'src/sub.js': 'exports.sub = (a, b) => a + b; // the mistake\n' });
    const preFix = commitAll(repo, 'pre');
    put(repo, 'src/sub.js', 'exports.sub = (a, b) => a - b;\n');
    put(repo, 'test/sub.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { sub } = require('../src/sub');\ntest('subtracts', () => assert.equal(sub(5, 3), 2));\n");
    const fix = commitAll(repo, 'fix with a regression test');
    const ok = regressionProof({ repo, files: ['test/sub.test.js'], preFix, fix }, NOW, 60_000);
    assert.equal(ok.result, 'proven', ok.detail);
    assert.equal(ok.counts?.fixExit, 0);
    assert.notEqual(ok.counts?.preFixExit, 0);
    // A test that passes before the fix proves nothing.
    put(repo, 'test/add2.test.js', "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add');\ntest('adds', () => assert.equal(add(1, 1), 2));\n");
    const fix2 = commitAll(repo, 'unrelated test');
    const no = regressionProof({ repo, files: ['test/add2.test.js'], preFix, fix: fix2 }, NOW, 60_000);
    assert.equal(no.result, 'not-proven');
    assert.match(no.detail, /passes on the commit before the fix/);
    const wt = require('node:child_process').spawnSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n');
    assert.equal(wt.length, 1, 'temporary worktrees are removed');
  } finally {
    h.cleanup();
  }
});

test('gate-event proof and prose: existing gate steps prove by their recorded failures; prose is unprovable', () => {
  const occ: Occurrence[] = [{ key: 'step:typecheck', eventId: 'e-abc', ts: NOW, t: Date.parse(NOW), event: 'gate.fail', rail: false }];
  const g = gateEventProof(lesson({ key: 'step:typecheck' }), occ, NOW, "the gate's typecheck step");
  assert.equal(g.result, 'proven');
  assert.match(g.detail, /e-abc/);
  assert.equal(gateEventProof(lesson(), [], NOW, 'x').result, 'not-proven');
  const prose = proveLesson(lesson({ proposal: { rung: 'instruction', ref: 'instruction', why: '', existing: false, source: 'judgment', text: 'Never x.' } }), { now: new Date(NOW) });
  assert.equal(prose.result, 'unprovable');
  const waiting = proveLesson(lesson({ needsJudgment: { reason: 'r', bundle: 'lj20261001-abcdef' } }), { now: new Date(NOW) });
  assert.match(waiting.detail, /import-judgment lj20261001-abcdef/);
});

test('proveLesson uses --fixture before the proposal samples', (t) => {
  const { bin, skip } = astGrepOrSkip();
  if (skip) return t.skip(skip);
  const h = tempHome('harness-learn-fixture-');
  try {
    const f = path.join(h.workspace, 'mistake.ts');
    fs.writeFileSync(f, "export function create() {\n  console.error('failed');\n}\n");
    const l = lesson({ proposal: { rung: 'lint', ref: 'learned/x.json', why: '', existing: false, source: 'ledger', check: { id: 'logging.logger-not-console', family: 'logging', statement: 's', fixText: 'f', overrides: 'logging.logger-not-console', engine: 'ast-grep', spec: { rules: [CONSOLE_RULE] }, scope: { repos: ['*'] } }, fixtures: { valid: [], invalid: ['nope'], source: 'probe-library' } } });
    const r = proveLesson(l, { fixture: f, ast: bin, now: new Date(NOW) });
    assert.equal(r.result, 'proven', r.detail);
    assert.equal(r.fixtureSource, 'user');
  } finally {
    h.cleanup();
  }
});
