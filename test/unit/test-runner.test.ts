import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasTestConcurrency, testFiles, SUITES } from '../run';

test('the suite runner lists *.test.js files recursively, sorted, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-run-'));
  try {
    for (const f of ['b.test.js', 'a/z.test.js', 'a/helpers.js', 'a/y.test.js.map', 'c/d/e.test.js', 'notes.md']) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    const got = testFiles(dir).map((p) => path.relative(dir, p).split(path.sep).join('/'));
    assert.deepEqual(got, ['a/z.test.js', 'b.test.js', 'c/d/e.test.js']);
    assert.deepEqual(testFiles(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--test-concurrency is used from Node 20.10 on', () => {
  assert.equal(hasTestConcurrency('20.9.0'), false);
  assert.equal(hasTestConcurrency('20.10.0'), true);
  assert.equal(hasTestConcurrency('22.1.0'), true);
  assert.equal(hasTestConcurrency('18.20.0'), false);
});

test('the suites are the four test folders', () => {
  assert.deepEqual([...SUITES], ['unit', 'acceptance', 'behaviour', 'safety']);
  for (const s of SUITES) assert.ok(fs.existsSync(path.resolve(__dirname, '..', s)), `dist/test/${s} exists after the build`);
});
