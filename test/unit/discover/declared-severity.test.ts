/** J: a rule the lint config declares at warn is never promoted to a blocking tier by a probe hit. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildRecords, thresholdsFor, type TierInput } from '../../../src/discover/tiers';
import { Counter, type CountedProbe } from '../../../src/discover/scan';
import type { DeclaredSetting, ProbeSpec, RepoInfo, ScannedFile } from '../../../src/discover/model';
import type { WorkspaceInventory } from '../../../src/discover/inventory';

function repo(id: string): RepoInfo {
  return { id, name: id, path: `/ws/${id}`, relPath: id, isGit: true, packageManager: 'npm', packages: [{ id, repoId: id, name: id, dir: '', scripts: {}, deps: [], devDeps: [] }] };
}
const REPOS = [repo('a'), repo('b'), repo('c')];
const WS = { root: '/ws', repos: REPOS.map((r) => ({ repo: r, files: [] })) } as unknown as WorkspaceInventory;

function lintProbe(): ProbeSpec {
  return {
    id: 'lint.demo-rule',
    family: 'lint',
    engine: 'filename',
    file: 'lint/demo.yml',
    title: 'Demo',
    site: 's',
    conforming: 'c',
    polarity: 'fixed',
    declaredBy: { eslint: ['demo-rule'] },
    check: { type: 'eslint', ref: 'demo-rule' },
    variants: [{ name: 'ok', pattern: 'x', statement: 'Do the thing.', fixText: 'Fix.' }, { name: 'bad', pattern: 'y' }],
  };
}

function allConforming(p: ProbeSpec): CountedProbe {
  const c = new Counter(WS);
  for (const r of REPOS) {
    for (let i = 0; i < 30; i++) {
      const f: ScannedFile = { abs: `/ws/${r.id}/src/f${i}.ts`, rel: `src/f${i}.ts`, repoId: r.id, pkg: r.id, bytes: 10, kind: 'code', isTest: false };
      c.add(p.id, f.abs, f, 1, 'ok', `f${i}.ts`);
    }
  }
  return c.tally(p.id, p);
}

function tierInput(c: CountedProbe, declared: Map<string, DeclaredSetting[]>): TierInput {
  return { counted: [c], declared, repos: REPOS, prose: [], histories: new Map(), thresholds: thresholdsFor(300, 3), now: '2026-01-01T00:00:00.000Z', previous: new Map() };
}

const setting = (repoId: string, severity: 'error' | 'warn'): DeclaredSetting => ({ repoId, source: 'vite.config.ts#L9', tool: 'eslint', key: 'demo-rule', value: undefined, severity, via: 'static', explicit: true });

test('J: a rule declared at warn is never promoted to a blocking tier by a probe hit', () => {
  const p = lintProbe();
  const c = allConforming(p);
  // Declared at warn in one repository, counted (100% of 90 sites) in the other two: the strong tier would block.
  const warnOne = buildRecords(tierInput(c, new Map([['a', [setting('a', 'warn')]]])));
  assert.equal(warnOne.records.length, 1);
  assert.equal(warnOne.records[0].tier, 'counted-strong');
  assert.equal(warnOne.records[0].check.mode, 'warn', 'the declared severity wins over the count');
  // Declared at error in one repository: the strong tier blocks, as before.
  const errOne = buildRecords(tierInput(c, new Map([['a', [setting('a', 'error')]]])));
  assert.equal(errOne.records[0].check.mode, 'block');
  // Declared at warn everywhere: a declared record at warn, as before.
  const warnAll = buildRecords(tierInput(c, new Map(REPOS.map((r) => [r.id, [setting(r.id, 'warn')]]))));
  assert.equal(warnAll.records[0].tier, 'declared');
  assert.equal(warnAll.records[0].check.mode, 'warn');
  // Never declared: the strong tier blocks.
  assert.equal(buildRecords(tierInput(c, new Map())).records[0].check.mode, 'block');
});

const scoped = (repoId: string, severity: 'error' | 'warn', files: string[], line: number): DeclaredSetting => ({ ...setting(repoId, severity), source: `vite.config.ts#L${line}`, files, line });

test('F8: a unit that declares error keeps block when another unit declares warn', () => {
  const c = allConforming(lintProbe());
  const out = buildRecords(tierInput(c, new Map([['a', [setting('a', 'warn')]], ['b', [setting('b', 'error')]]])));
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].check.mode, 'block');
  assert.match(out.records[0].statement, /warning, not an error, in a\.\)/);
  // Every declaring unit at warn: warn, as before.
  const warns = buildRecords(tierInput(c, new Map([['a', [setting('a', 'warn')]], ['b', [setting('b', 'warn')]]])));
  assert.equal(warns.records[0].check.mode, 'warn');
  assert.ok(!/warning, not an error/.test(warns.records[0].statement));
});

test('F8: overrides resolve last-wins', () => {
  const c = allConforming(lintProbe());
  const later = buildRecords(tierInput(c, new Map([['a', [setting('a', 'warn'), { ...setting('a', 'error'), line: 12 }]]])));
  assert.equal(later.records[0].check.mode, 'block');
  const lastWarn = buildRecords(tierInput(c, new Map([['a', [setting('a', 'error'), setting('a', 'warn')]]])));
  assert.equal(lastWarn.records[0].check.mode, 'warn');
});

test('F8: an extension-wide override applies only to files it matches', () => {
  const c = allConforming(lintProbe()); // every site is a .ts file
  const jsOnly = buildRecords(tierInput(c, new Map([['a', [scoped('a', 'warn', ['**/*.js'], 9)]]])));
  assert.equal(jsOnly.records[0].check.mode, 'block', 'a warn for .js files says nothing about .ts sites');
  const tsWarn = buildRecords(tierInput(c, new Map([['a', [scoped('a', 'warn', ['**/*.ts'], 9)]]])));
  assert.equal(tsWarn.records[0].check.mode, 'warn');
  const tsError = buildRecords(tierInput(c, new Map([['a', [setting('a', 'warn'), scoped('a', 'error', ['**/*.ts'], 20)]]])));
  assert.equal(tsError.records[0].check.mode, 'block');
});
