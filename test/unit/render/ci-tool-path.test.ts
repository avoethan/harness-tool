/**
 * The personal CI workflow checks out the harness tool repository named by
 * HARNESS_TOOL_REPO. A published tool can have its package at the repository
 * root (a clean tool repository) or in a `harness/` folder (a repository that
 * holds more than the tool). The gate step must find it in both layouts.
 * The rendered shell lines are run with `sh` in a temp folder for each layout.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ciWorkflow } from '../../../src/render/personal';
import { run } from '../../../src/lib/exec';

function gateScript(): string[] {
  const text = ciWorkflow(undefined);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === '- name: harness gate');
  assert.ok(i >= 0, 'the workflow has a harness gate step');
  const out: string[] = [];
  for (let j = lines.indexOf('        run: |', i) + 1; j < lines.length && lines[j].startsWith('          '); j++) out.push(lines[j].slice(10));
  return out;
}

test('the CI gate step runs npm and the gate from the folder that holds the tool', () => {
  const script = gateScript();
  assert.ok(script.some((l) => l.includes('npm ci --ignore-scripts')), 'install scripts stay off in CI');
  assert.ok(script.some((l) => /node "\$tool\/dist\/src\/cli\.js" gate --hook ci/.test(l)), 'the gate runs from the detected folder');
  assert.ok(!script.some((l) => /\bcd \.\.\b/.test(l)), 'no cd back out: the install runs in a subshell');
});

test('the CI tool detection finds the package at the root or in harness/', { skip: process.platform === 'win32' ? 'needs a POSIX sh' : false }, () => {
  const detect = gateScript().filter((l) => l.startsWith('tool=') || l.startsWith('if '));
  assert.equal(detect.length, 2, 'two detection lines');
  const script = [...detect, 'printf %s "$tool"'].join('\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ci-tool-'));
  try {
    const layouts: Array<[string, string, string]> = [
      ['root', 'package.json', '.harness-tool'],
      ['subfolder', 'harness/package.json', '.harness-tool/harness'],
      ['neither', 'README.md', '.harness-tool'],
    ];
    for (const [name, file, want] of layouts) {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, '.harness-tool', path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, '.harness-tool', file), '{}\n');
      const r = run('sh', ['-c', script], { cwd: dir, timeoutMs: 10_000 });
      assert.equal(r.code, 0, `${name}: the detection lines run (${r.stderr})`);
      assert.equal(r.stdout, want, `${name}: the tool folder`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
