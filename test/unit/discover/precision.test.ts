/**
 * Precision fixes found by the discovery audit on public repositories: false positives that came from
 * comments and code templates, an unrelated-readers share, prose that is not a rule, a rule the config
 * turns off, and package-level configs read as repository-wide. Synthetic inputs only.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearTextCache, maskNonCode, parseImports, runBuiltin, type BuiltinContext } from '../../../src/discover/builtins';
import { isNormative } from '../../../src/discover/prose';
import { buildRecords, thresholdsFor, type TierInput } from '../../../src/discover/tiers';
import { Counter } from '../../../src/discover/scan';
import { recordAppliesTo } from '../../../src/discover/checks';
import type { DeclaredSetting, ProbeSpec, RepoInfo, ScannedFile } from '../../../src/discover/model';
import type { RepoInventory, WorkspaceInventory } from '../../../src/discover/inventory';
import { tempEnv, writeTree } from './helpers';

test('imports are read from code only: comments and template-literal text are not imports', () => {
  const text = [
    '/**',
    ' * This defaults to `require("mssql")`.',
    ' */',
    "// import pg from 'pg';",
    "const glob = 'src/**/*.ts';",
    'const generated = `import { Entity } from "demo-orm"',
    'import { ObjectId } from "mongodb"`;',
    'const lazy = `${require("ioredis")}`;',
    "import sql from 'mssql';",
  ].join('\n');
  const masked = maskNonCode(text);
  assert.equal(masked.length, text.length, 'same length');
  assert.equal(masked.split('\n').length, text.split('\n').length, 'lines kept');
  assert.deepEqual(
    parseImports(text).map((i) => [i.spec, i.line]),
    [
      ['ioredis', 8],
      ['mssql', 9],
    ],
    'only the template hole and the real import; a glob string does not open a comment',
  );
});

function inventory(root: string, pkgName: string, files: Record<string, string>): WorkspaceInventory {
  writeTree(root, files);
  const repo: RepoInfo = {
    id: 'r',
    name: 'r',
    path: root,
    relPath: '.',
    isGit: true,
    packageManager: 'npm',
    packages: [{ id: 'r', repoId: 'r', name: pkgName, dir: '', scripts: {}, deps: ['mssql'], devDeps: [] }],
  };
  const scanned: ScannedFile[] = Object.keys(files).map((rel) => ({ abs: path.join(root, rel), rel, repoId: 'r', pkg: 'r', bytes: 10, kind: 'code', isTest: false }));
  const inv: RepoInventory = { repo, files: scanned, allFiles: Object.keys(files), configs: {}, ci: [], tsconfigChains: [], migrationDirs: [], skipped: [] };
  return { root, repos: [inv] } as unknown as WorkspaceInventory;
}

function builtinProbe(builtin: string, params: Record<string, unknown>): ProbeSpec {
  return { id: `layout.${builtin}`, family: 'layout', engine: 'builtin', file: 'x.yml', title: 't', site: 's', conforming: 'c', polarity: 'fixed', check: { type: 'regex' }, builtin, params, variants: [{ name: 'gateway', statement: 'Only {GATEWAY}.' }, { name: 'bypass' }] };
}

test('driver gateway: a JSDoc require is not an importer, and the workspace’s own package is never a driver', () => {
  const env = tempEnv();
  try {
    clearTextCache();
    const ws = inventory(path.join(env.workspace, 'orm'), 'demo-orm', {
      'src/db.ts': "import sql from 'mssql';\nexport const pool = sql;\n",
      'src/options.ts': '/** This defaults to `require("mssql")`. */\nexport interface Options { x: number }\n',
      'src/entity.ts': "import { Entity } from 'demo-orm';\nexport const e = Entity;\n",
    });
    const ctx: BuiltinContext = { ws, declared: new Map() };
    const outs = runBuiltin(builtinProbe('import-gateway', { drivers: ['mssql', 'demo-orm'] }), ctx);
    assert.deepEqual(outs.map((o) => o.sub), ['mssql'], 'no record for the package itself');
    const bypass = outs[0].sites.filter((s) => s.variants.includes('bypass')).map((s) => s.file.rel);
    assert.deepEqual(bypass, [], 'the JSDoc mention is not a second importer');
    assert.deepEqual(outs[0].check.gatewayFiles, ['src/db.ts']);
  } finally {
    clearTextCache();
    env.cleanup();
  }
});

test('single accessor: comments do not read process.env, and three readers in a package are no gateway', () => {
  const env = tempEnv();
  try {
    clearTextCache();
    const one = inventory(path.join(env.workspace, 'one'), 'one', {
      'src/config.ts': 'export const port = process.env.PORT;\n',
      'src/client.ts': '/** const c = new Client(process.env.URL) */\nexport const c = 1;\n',
      'src/app.ts': 'export const a = 1;\n',
    });
    const probe = builtinProbe('single-accessor', { pattern: '\\bprocess\\.env\\b', what: 'process.env' });
    const outs = runBuiltin(probe, { ws: one, declared: new Map() });
    assert.equal(outs.length, 1);
    assert.deepEqual(outs[0].check.gateways, ['src/config.ts']);
    assert.ok(outs[0].sites.every((s) => s.variants.includes('gateway')), 'the JSDoc example is not a bypass');
    clearTextCache();
    const three = inventory(path.join(env.workspace, 'three'), 'three', {
      'src/cli.ts': 'if (process.env.NODE_OPTIONS) {}\n',
      'src/pg.ts': 'process.env.PGTZ = "UTC";\n',
      'src/ora.ts': 'process.env.ORA_SDTZ = "UTC";\n',
      ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};\n`])),
    });
    assert.deepEqual(runBuiltin(probe, { ws: three, declared: new Map() }), [], 'no gateway although 30 of 33 modules never read it');
    fs.rmSync(path.join(env.workspace, 'three'), { recursive: true, force: true });
  } finally {
    clearTextCache();
    env.cleanup();
  }
});

test('written rules: definitions, relative clauses and "you don\'t want to" are not rules; real rules still are', () => {
  const rules = [
    'Never edit a migration that has been applied to a shared database; add a new one.',
    'The catalog is reached only through `src/clients/catalog-client.ts`, which owns the base URL.',
    'They mock `src/db` and never open a database connection.',
    'Do not report vulnerabilities through public issues, discussions, or pull requests.',
    '> **Security fixes:** Do not submit security fixes as public PRs.',
    '**Breaking Changes** should start with the word `BREAKING CHANGE:` with a space or two newlines.',
    'Make sure that no other module imports `mssql`.',
    'Check that you never commit the build folder.',
  ];
  const notRules = [
    "**chore**: Other changes that don't amend functionality (e.g. updating development dependencies)",
    '**docs**: Documentation only changes',
    '**style**: Changes that do not affect the meaning of the code (white-space, formatting)',
    'List any dependencies that are required for this change.',
    'You can create a question on [the forum](https://example.invalid/q) where the questions should be tagged with tag `x`.',
    "You don't want to duplicate effort.",
    'Should this be a rule?',
  ];
  for (const s of rules) assert.ok(isNormative(s), `rule: ${s}`);
  for (const s of notRules) assert.ok(!isNormative(s), `not a rule: ${s}`);
});

const ONE_REPO: RepoInfo = { id: 'r', name: 'r', path: '/ws/r', relPath: 'r', isGit: true, packageManager: 'npm', packages: [{ id: 'r', repoId: 'r', name: 'r', dir: '', scripts: {}, deps: [], devDeps: [] }] };

function tierInput(over: Partial<TierInput>): TierInput {
  return { counted: [], declared: new Map(), repos: [ONE_REPO], prose: [], histories: new Map(), thresholds: thresholdsFor(300, 1), now: '2026-01-01T00:00:00.000Z', previous: new Map(), ...over };
}

function eslintSetting(key: string, severity: 'error' | 'warn' | 'off', pkgDir = ''): DeclaredSetting {
  return { repoId: 'r', source: `${pkgDir ? pkgDir + '/' : ''}eslint.config.mjs#L9`, tool: 'eslint', key, value: undefined, severity, via: 'static', explicit: true, files: ['**/*.ts'], line: 9, pkgDir };
}

test('a probe whose ESLint rule the repository turns off makes no standard there, only a finding', () => {
  const p: ProbeSpec = {
    id: 'lint.no-explicit-any',
    family: 'lint',
    engine: 'ast-grep',
    file: 'lint/no-explicit-any.yml',
    title: 'No explicit any',
    site: 's',
    conforming: 'c',
    polarity: 'fixed',
    declaredBy: { eslint: ['@typescript-eslint/no-explicit-any'] },
    check: { type: 'ast-grep' },
    variants: [{ name: 'typed', statement: 'No explicit `any`.', fixText: 'Use unknown.' }, { name: 'any' }],
  };
  const ws = { root: '/ws', repos: [{ repo: ONE_REPO, files: [] }] } as unknown as WorkspaceInventory;
  const c = new Counter(ws);
  for (let i = 0; i < 1000; i++) {
    const f: ScannedFile = { abs: `/ws/r/src/f${i}.ts`, rel: `src/f${i}.ts`, repoId: 'r', pkg: 'r', bytes: 10, kind: 'code', isTest: false };
    c.add(p.id, f.abs, f, 1, i < 40 ? 'any' : 'typed', `f${i}.ts`);
  }
  const counted = c.tally(p.id, p, {});
  const without = buildRecords(tierInput({ counted: [counted] }));
  assert.deepEqual(without.records.map((r) => [r.id, r.tier]), [['lint.no-explicit-any', 'counted-strong']], 'a 96% count alone is a standard');
  const off = buildRecords(tierInput({ counted: [counted], declared: new Map([['r', [eslintSetting('@typescript-eslint/no-explicit-any', 'off')]]]) }));
  assert.equal(off.records.length, 0, 'switched off by the repository: no standard');
  assert.ok(off.findings.some((f) => /turns `@typescript-eslint\/no-explicit-any` off/.test(f.message) && f.counts?.sites === 1000));
  const elsewhere = buildRecords(tierInput({ counted: [counted], declared: new Map([['r', [eslintSetting('@typescript-eslint/no-explicit-any', 'off', 'packages/legacy')]]]) }));
  assert.equal(elsewhere.records.length, 1, 'off in another package only: the repository-wide count still stands');
});

test('ESLint rules and strictness declared by a package-level config are scoped to that package', () => {
  const strict = (pkgDir: string): DeclaredSetting => ({ repoId: 'r', source: `${pkgDir}/tsconfig.json`, tool: 'tsconfig', key: 'strict', value: true, via: 'static', explicit: true, pkgDir });
  const out = buildRecords(tierInput({ declared: new Map([['r', [eslintSetting('prefer-const', 'error', 'packages/core'), strict('packages/core'), strict('playground')]]]) }));
  const pc = out.records.find((r) => r.id === 'lint.prefer-const')!;
  assert.deepEqual(pc.scope, { repos: ['r'], paths: ['packages/core/**'] });
  assert.ok(recordAppliesTo(pc, 'r', 'packages/core/src/a.ts'));
  assert.ok(!recordAppliesTo(pc, 'r', 'packages/codemod/src/a.ts'), 'a sibling package with its own config is not covered');
  assert.deepEqual(out.records.find((r) => r.id === 'types.strict')!.scope, { repos: ['r'], paths: ['packages/core/**', 'playground/**'] });
  const root = buildRecords(tierInput({ declared: new Map([['r', [eslintSetting('prefer-const', 'error'), eslintSetting('prefer-const', 'error', 'packages/core')]]]) }));
  assert.deepEqual(root.records.find((r) => r.id === 'lint.prefer-const')!.scope, { repos: ['*'] }, 'a root config covers the whole repository');
});
