/** L: lint.rules and fmt of vite.config / vitest.config are declared sources with their severities. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { collectDeclared, parseViteConfigText } from '../../../src/discover/declared';
import { inventoryWorkspace } from '../../../src/discover/inventory';
import { runDiscover } from '../../../src/discover/index';
import { findAstGrep } from '../../../src/discover/astgrep';
import { which } from '../../../src/lib/exec';
import { makeRepo, tempEnv, writeTree } from './helpers';

const VITE = `import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: { printWidth: 100, trailingComma: 'es5', tabWidth: 2, semi: false, singleQuote: true, endOfLine: 'lf' },
  lint: {
    options: { typeAware: false },
    rules: {
      curly: ['error', 'all'],
      'typescript/no-explicit-any': 'warn',
      'typescript/consistent-type-imports': 'error',
      'no-var': 'off',
    },
  },
})
`;

test('L: lint.rules and fmt of a vite config are read with their severities', () => {
  const v = parseViteConfigText(VITE);
  const by = new Map(v.rules.map((r) => [r.rule, r]));
  assert.equal(by.get('curly')?.severity, 'error');
  assert.equal(by.get('@typescript-eslint/no-explicit-any')?.severity, 'warn', 'plugin prefix mapped to the ESLint name');
  assert.equal(by.get('@typescript-eslint/consistent-type-imports')?.severity, 'error');
  assert.equal(by.get('no-var')?.severity, 'off');
  assert.equal(by.get('curly')?.line, 8, 'line in the config file');
  assert.deepEqual(v.fmt, { printWidth: 100, trailingComma: 'es5', tabWidth: 2, semi: false, singleQuote: true, endOfLine: 'lf' });
  assert.deepEqual(parseViteConfigText('export default { test: { include: ["a/**"] } }').rules, []);
});

test('L: vite.config.ts and vitest.config.ts become declared eslint and prettier settings', (t) => {
  if (!which('git')) {
    t.skip('git is not available on PATH');
    return;
  }
  const env = tempEnv();
  try {
    for (const name of ['vite.config.ts', 'vitest.config.ts']) {
      const dir = path.join(env.workspace, name.split('.')[0]);
      makeRepo(dir, { 'package.json': '{"name":"x"}\n', [name]: VITE, 'src/a.ts': 'export const a = 1\n' }, ['chore: init']);
      const inv = inventoryWorkspace(dir, {}).repos[0];
      const d = collectDeclared(inv, { exec: false });
      const es = d.settings.filter((s) => s.tool === 'eslint');
      assert.equal(es.find((s) => s.key === 'curly')?.severity, 'error', name);
      assert.equal(es.find((s) => s.key === '@typescript-eslint/no-explicit-any')?.severity, 'warn', name);
      assert.ok(es.every((s) => s.source.startsWith(name) && s.via === 'static' && s.explicit), name);
      const pr = d.settings.filter((s) => s.tool === 'prettier');
      assert.equal(pr.find((s) => s.key === 'singleQuote')?.value, true, name);
      assert.equal(pr.find((s) => s.key === 'semi')?.value, false, name);
    }
  } finally {
    env.cleanup();
  }
});

test('L: end to end, an error rule is declared with its source, and the formatter record does not say Prettier', async (t) => {
  if (!which('git') || !findAstGrep()) {
    t.skip('git or ast-grep is not available');
    return;
  }
  const env = tempEnv();
  try {
    const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'v', scripts: { format: 'vp fmt' } }) + '\n', 'vite.config.ts': VITE };
    for (let i = 0; i < 12; i++) files[`src/m${i}.ts`] = `export const m${i}: unknown = ${i}\nexport function f${i}(a: unknown) {\n  if (a) {\n    return 'x'\n  }\n  return 'y'\n}\n`;
    const dir = path.join(env.workspace, 'v');
    makeRepo(dir, files, ['chore: init']);
    const res = await runDiscover({ root: dir, exec: false, write: false });
    const by = new Map(res.ledger.records.map((r) => [r.id, r]));
    const curly = by.get('lint.curly');
    assert.equal(curly?.tier, 'declared');
    assert.equal(curly?.check.mode, 'block');
    assert.ok(curly!.evidence.sources.some((s) => s.startsWith('eslint:vite.config.ts#L')));
    const fmt = by.get('format.formatter');
    assert.ok(fmt, `records: ${[...by.keys()].join(', ')}`);
    assert.ok(!/Prettier/.test(fmt!.statement), fmt!.statement);
    assert.match(fmt!.statement, /configured in vite\.config\.ts/);
  } finally {
    env.cleanup();
  }
});
