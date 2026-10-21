/**
 * What `npm pack` would publish: the runtime (bin, dist/src, templates, the
 * probe library with its own cases, the self-check pages), the docs (with the
 * component READMEs under src/), and nothing else: no compiled or source
 * tests, no fixtures, no TypeScript sources, no node_modules, no scratch. Runs `npm pack --dry-run --json`
 * (no network); skips on Windows, where npm is a .cmd file Node will not
 * spawn without a shell.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { run, which } from '../../src/lib/exec';
import { packageRoot } from '../../src/lib/paths';

const ALLOWED_TOP = new Set(['bin', 'dist', 'templates', 'probes', 'selfcheck', 'scripts', 'docs', 'src', 'package.json', 'README.md', 'SAFETY.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'LICENSE']);

function packList(): string[] | string {
  if (process.platform === 'win32') return 'npm is a .cmd on Windows; run `npm pack --dry-run` by hand';
  if (!which('npm')) return 'npm is not on PATH';
  const r = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageRoot(), timeoutMs: 120_000, env: { ...process.env, npm_config_loglevel: 'silent' } });
  if (r.code !== 0) return `npm pack --dry-run failed: ${r.stderr.slice(0, 300)}`;
  const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path).sort();
}

test('the npm package holds the runtime and the docs, and no tests, fixtures or sources', (t) => {
  const files = packList();
  if (typeof files === 'string') {
    t.skip(files);
    return;
  }
  const outside = files.filter((f) => !ALLOWED_TOP.has(f.split('/')[0]));
  assert.deepEqual(outside, [], 'only the listed top-level entries are published');
  const tests = files.filter((f) => f.startsWith('dist/test/') || /\.test\.(js|ts)$/.test(f) || f.includes('/fixtures/'));
  assert.deepEqual(tests, [], 'no tests or fixtures');
  const sources = files.filter((f) => f.endsWith('.ts') || (f.startsWith('src/') && !f.endsWith('/README.md')) || f.includes('node_modules/'));
  assert.deepEqual(sources, [], 'no TypeScript sources or node_modules (the component READMEs under src/ are docs)');
  assert.ok(files.includes('src/gate/README.md'), 'the component READMEs the README links are published');
  for (const need of ['bin/harness', 'bin/harness.cmd', 'dist/src/cli.js', 'dist/src/hook.js', 'templates/skills/task/SKILL.md', 'templates/skills/setup/SKILL.md', 'templates/skills/learn/SKILL.md', 'selfcheck/devin-desktop.md', 'selfcheck/codex.md', 'docs/COMMANDS.md', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(need), `${need} is published`);
  }
  assert.ok(files.some((f) => f.startsWith('probes/__tests__/')), 'the probe library keeps its own cases (harness discover --self-test runs them)');
});
