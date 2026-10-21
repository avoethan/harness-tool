import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildContext } from '../../../src/gate/context';
import { countAssertions, countSkipMarkers, harnessCommitted, isAllowed, packageJsonChanges, protectedKind, runTamper, tamperFindings } from '../../../src/gate/tamper';
import { savePlanRecord, type PlanRecord } from '../../../src/lifecycle/backup';
import { setTaskPhase } from '../../../src/intake/phase';
import { repoIdFor } from '../../../src/lib/config';
import { commitAll, demoRepo, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-tamper-');
});
after(() => h.cleanup());

function repo(extra: Record<string, string> = {}): string {
  return demoRepo(path.join(h.workspace, `r${++n}`), extra);
}

test('counting: assertions and focus/skip markers ignore comments', () => {
  const t = "// expect(a)\nexpect(x).toBe(1);\nassert.equal(a, b);\nassert(ok);\n/* expect(y) */\nfoo.should.equal(1);\n";
  assert.equal(countAssertions(t), 4);
  assert.deepEqual(countSkipMarkers("it.only('a', () => {});\n// it.skip('b')\nxit('c');\ntest('d', { skip: true }, () => {});\n"), { '.only': 1, 'xit/xdescribe': 1, '{ skip/only/todo }': 1 });
  assert.deepEqual(countSkipMarkers("@pytest.mark.xfail\ndef test_a(): pass\n", 'test_a.py'), { 'xfail/skip mark': 1 });
});

test('protected kinds and allowed paths', () => {
  assert.equal(protectedKind('.github/workflows/ci.yml'), 'CI configuration');
  assert.equal(protectedKind('packages/api/eslint.config.mjs'), 'lint or format configuration');
  assert.equal(protectedKind('tsconfig.build.json'), 'type-check configuration');
  assert.equal(protectedKind('vitest.config.ts'), 'test runner configuration');
  assert.equal(protectedKind('test/__snapshots__/a.test.ts.snap'), 'golden or snapshot file');
  assert.equal(protectedKind('CLAUDE.md'), 'harness file');
  assert.equal(protectedKind('src/app.ts'), null);
  assert.ok(isAllowed('.github/workflows/ci.yml', ['.github/workflows']));
  assert.ok(isAllowed('a/b/eslint.config.mjs', ['**/eslint.config.mjs']));
  assert.ok(!isAllowed('src/x.ts', ['.github']));
  assert.deepEqual(packageJsonChanges('{"scripts":{"test":"vitest run","dev":"x"}}', '{"scripts":{"test":"vitest run --passWithNoTests","dev":"y"}}'), ['script "test" changed']);
});

test('clean change passes', () => {
  const r = repo();
  put(r, 'src/add.js', 'exports.add = (a, b) => b + a;\n');
  const ctx = buildContext({ repo: r });
  const out = runTamper(ctx);
  assert.equal(out.status, 'pass', out.reasons.join('; '));
});

test('deleted test file FAILs naming the file', () => {
  const r = repo();
  fs.rmSync(path.join(r, 'test/add.test.js'));
  const f = tamperFindings(buildContext({ repo: r }));
  assert.equal(f.length, 1);
  assert.match(f[0], /^test\/add\.test\.js: test file deleted/);
});

test('.only added FAILs', () => {
  const r = repo();
  put(r, 'test/add.test.js', fs.readFileSync(path.join(r, 'test/add.test.js'), 'utf8').replace("test('adds'", "test.only('adds'"));
  const f = tamperFindings(buildContext({ repo: r }));
  assert.deepEqual(f, ['test/add.test.js: focus/skip markers added (.only x1)']);
});

test('assertion count drop FAILs', () => {
  const r = repo();
  put(r, 'test/add.test.js', fs.readFileSync(path.join(r, 'test/add.test.js'), 'utf8').replace('  assert.equal(add(2, 2), 4);\n', ''));
  const f = tamperFindings(buildContext({ repo: r }));
  assert.deepEqual(f, ['test/add.test.js: assertion count dropped from 2 to 1']);
});

test('lint config edit FAILs unless the brief or the base config allows it', () => {
  const r = repo({ 'eslint.config.mjs': 'export default [];\n' });
  put(r, 'eslint.config.mjs', "export default [{ rules: { eqeqeq: 'off' } }];\n");
  const f = tamperFindings(buildContext({ repo: r }));
  assert.equal(f.length, 1);
  assert.match(f[0], /^eslint\.config\.mjs: lint or format configuration changed \(protected/);
  writeBrief(r, `t-lint-${n}`, [], { allowedPaths: ['eslint.config.mjs'] });
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);
});

test('package.json test script change FAILs', () => {
  const r = repo();
  put(r, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test || true' } }));
  const f = tamperFindings(buildContext({ repo: r }));
  assert.equal(f.length, 1);
  assert.match(f[0], /package\.json: script "test" changed/);
});

test('test edit outside the tests phase: implement-only task FAILs, tests phase passes, implement after tests FAILs on later edits', () => {
  const r = repo();
  const repoId = repoIdFor(r);
  const task = `t-phase-${n}`;
  writeBrief(r, task, []);
  setTaskPhase(repoId, task, 'implement');
  put(r, 'test/add.test.js', fs.readFileSync(path.join(r, 'test/add.test.js'), 'utf8') + "test('more', () => { assert.equal(add(0, 0), 0); });\n");
  let f = tamperFindings(buildContext({ repo: r }));
  assert.equal(f.length, 1);
  assert.match(f[0], /never entered the tests phase/);

  // In the tests phase the same edit is fine.
  setTaskPhase(repoId, task, 'tests');
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);

  // Back to implement: the earlier edit (before the switch) is fine; a later edit is not.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(r, 'test/add.test.js'), past, past);
  setTaskPhase(repoId, task, 'implement');
  assert.deepEqual(tamperFindings(buildContext({ repo: r })), []);
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(r, 'test/add.test.js'), future, future);
  f = tamperFindings(buildContext({ repo: r }));
  assert.equal(f.length, 1);
  assert.match(f[0], /edited during the implement phase/);
});

test('renamed test file FAILs', () => {
  const r = repo();
  fs.renameSync(path.join(r, 'test/add.test.js'), path.join(r, 'test/add.spec.js'));
  const f = tamperFindings(buildContext({ repo: r }));
  assert.ok(f.some((x) => /test\/add\.test\.js -> test\/add\.spec\.js: test file renamed/.test(x)), f.join('\n'));
});

test("the harness's own apply commit (recorded under the harness home) is not tampering; a later edit of the same file, or a commit that only looks like one, still is", () => {
  const r = repo({ 'eslint.config.mjs': 'export default [];\n', 'CLAUDE.md': '# notes\n' });
  const base = commitAll(r, 'chore: base');
  // what an install's apply commit changes: harness files and a format ignore file
  put(r, 'CLAUDE.md', '<!-- harness:begin -->\n@AGENTS.md\n<!-- harness:end -->\n\n# notes\n');
  put(r, '.claude/settings.json', '{"hooks":{}}\n');
  put(r, '.prettierignore', '/AGENTS.md\n');
  const applySha = commitAll(r, 'chore(harness): apply p-t1');
  savePlanRecord({ version: 1, harnessVersion: 't', files: [], settingsEdits: [], planId: 'p-t1', stamp: 's1', setting: 'personal', repoRoot: r, commit: applySha, manifestPath: '' } as PlanRecord);
  put(r, 'src/add.js', 'exports.add = (a, b) => b + a;\n');
  commitAll(r, 'fix: order');
  const ctx = buildContext({ repo: r, hook: 'pre-push', base });
  assert.deepEqual([...harnessCommitted(ctx)].sort(), ['.claude/settings.json', '.prettierignore', 'CLAUDE.md']);
  assert.deepEqual(tamperFindings(ctx), [], 'the first push after an install carries the apply commit');
  // the same file changed again after the apply: a finding
  put(r, 'CLAUDE.md', '# notes, edited after the install\n');
  commitAll(r, 'docs: notes');
  assert.ok(tamperFindings(buildContext({ repo: r, hook: 'pre-push', base })).some((x) => /^CLAUDE\.md: harness file changed/.test(x)));
  // a commit that only looks like an apply commit (not recorded under the harness home): a finding
  const r2 = repo({ 'eslint.config.mjs': 'export default [];\n' });
  const base2 = commitAll(r2, 'chore: base');
  put(r2, 'eslint.config.mjs', "export default [{ rules: { eqeqeq: 'off' } }];\n");
  commitAll(r2, 'chore(harness): apply p-forged');
  assert.ok(tamperFindings(buildContext({ repo: r2, hook: 'pre-push', base: base2 })).some((x) => /^eslint\.config\.mjs: lint or format configuration changed/.test(x)));
  // the apply commit already in the base: nothing to exempt
  assert.equal(harnessCommitted(buildContext({ repo: r, hook: 'pre-push', base: applySha })).size, 0);
});
