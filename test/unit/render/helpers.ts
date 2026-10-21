/** Shared fixtures for the render tests: a synthetic ledger, inventory and render context. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentId, HarnessConfig, Ledger, LedgerRecord, Setting } from '../../../src/types';
import { DEFAULT_CAPS } from '../../../src/types';
import { packageRoot } from '../../../src/lib/paths';
import type { LedgerInventory, RenderContext } from '../../../src/render/model';

export function tmpRoot(prefix = 'harness-render-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function record(id: string, statement: string, over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    id,
    statement,
    family: (id.split('.')[0] as LedgerRecord['family']) ?? 'other',
    scope: { repos: ['*'] },
    tier: 'declared',
    confidence: 1,
    evidence: { sites: 20, conforming: 20, packages: 2, examples: [], sources: [] },
    check: { type: 'eslint', mode: 'block', ref: 'eqeqeq', fixText: 'Fix it the way the rule says.' },
    conflicts: [],
    provenance: [],
    history: { firstSeen: '2026-01-01', lastCounted: '2026-01-01', disputes: 0 },
    ...over,
  };
}

/** Two repos, a handful of standards across tiers, one path-scoped record and one safety record. */
export function syntheticLedger(workspace: string): Ledger {
  return {
    version: 1,
    generatedAt: '2026-10-19T00:00:00.000Z',
    workspaceRoot: workspace,
    skipped: [],
    scanners: [],
    records: [
      record('lint.eqeqeq', 'Compare with === and !==, never == or !=.', { check: { type: 'eslint', mode: 'block', ref: 'eqeqeq', fixText: 'Replace == with ===.' } }),
      record('naming.ts-file-case-kebab', 'TypeScript file names are kebab-case.', { tier: 'counted-strong', check: { type: 'regex', mode: 'block', fixText: 'Rename the file to kebab-case.' } }),
      record('format.quotes-single', "Strings use single quotes ('like this').", { scope: { repos: ['alpha-111111'] }, check: { type: 'config', mode: 'block', fixText: 'Run the formatter.' } }),
      record('errors.http-helpers', 'Routes throw HTTP errors through the helpers in lib/http-error.', { tier: 'counted-majority', scope: { repos: ['alpha-111111', 'beta-222222'], paths: ['beta-222222:packages/api/**'] }, check: { type: 'ast-grep', mode: 'warn', fixText: 'Throw notFound(...).' } }),
      record('safety.never-edit-applied-migration', 'Never edit a migration that has been applied to a shared database; add a new one.', { family: 'safety', tier: 'single-source', check: { type: 'judgment', mode: 'judgment' } }),
    ],
  };
}

export function syntheticInventory(workspace: string): LedgerInventory {
  const scripts = { build: 'tsc -p tsconfig.json', typecheck: 'tsc --noEmit', lint: 'eslint .', 'format:check': 'prettier --check .', test: 'vitest run', 'test:e2e': 'vitest run -c e2e' };
  return {
    workspaceRoot: workspace,
    repos: [
      { id: 'alpha-111111', name: 'alpha', path: path.join(workspace, 'alpha'), relPath: 'alpha', isGit: true, packageManager: 'npm', packages: [{ dir: '', scripts }] },
      { id: 'beta-222222', name: 'beta', path: path.join(workspace, 'beta'), relPath: 'beta', isGit: true, packageManager: 'npm', packages: [{ dir: '', scripts: { ...scripts, test: 'jest' } }, { dir: 'packages/api', scripts: {} }] },
    ],
  };
}

export function config(workspace: string, setting: Setting, agents: AgentId[]): HarnessConfig {
  return {
    version: 1,
    setting,
    agents,
    workspaceRoot: workspace,
    repos: [],
    db: { allowlist: [{ server: 'localhost,1433', database: 'app_test', marked: 'test' }] },
    mcp: { allowedServers: {} },
    caps: { ...DEFAULT_CAPS },
    include: [],
    reviews: { source: 'none' },
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  };
}

/** A render context in a temp tree (the repos' folders exist; personal: workspace = repo). */
export function context(setting: Setting, agents: AgentId[], root = tmpRoot()): RenderContext {
  const userHome = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(workspace, 'alpha', 'packages', 'api'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'beta', 'packages', 'api'), { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const inv = syntheticInventory(workspace);
  if (setting === 'personal') {
    const repo = path.join(workspace, 'alpha');
    return {
      setting,
      agents,
      workspaceRoot: repo,
      repoRoot: repo,
      userHome,
      harnessHome: path.join(userHome, '.harness'),
      packageRoot: packageRoot(),
      platform: 'linux',
      ledger: { ...syntheticLedger(repo), records: syntheticLedger(repo).records.map((r) => ({ ...r, scope: { repos: ['*'], paths: r.scope.paths?.map((p) => p.replace(/^beta-222222:/, '')) } })) },
      inventory: { workspaceRoot: repo, repos: [{ ...inv.repos[1], id: 'alpha-111111', name: 'alpha', path: repo, relPath: '.' }] },
      config: config(repo, setting, agents),
      harnessVersion: '0.0.0-test',
    };
  }
  return {
    setting,
    agents,
    workspaceRoot: workspace,
    userHome,
    harnessHome: path.join(userHome, '.harness'),
    packageRoot: packageRoot(),
    platform: 'linux',
    ledger: syntheticLedger(workspace),
    inventory: inv,
    config: config(workspace, setting, agents),
    harnessVersion: '0.0.0-test',
  };
}

/** A ledger far too large for the always-on file (to prove the budget holds). */
export function hugeContext(setting: Setting, agents: AgentId[]): RenderContext {
  const ctx = context(setting, agents);
  const recs: LedgerRecord[] = [];
  for (let i = 0; i < 200; i++) recs.push(record(`lint.rule-${i}`, `Rule number ${i} says something long enough to take most of a table row in the always-on file of the harness.`));
  const repos = [];
  for (let i = 0; i < 40; i++) {
    const p = path.join(ctx.workspaceRoot, `svc-${i}`);
    repos.push({ id: `svc-${i}-aaaaaa`, name: `svc-${i}`, path: p, relPath: `svc-${i}`, isGit: true, packageManager: 'npm', packages: [{ dir: '', scripts: { test: i % 2 ? 'jest' : 'vitest run', lint: 'eslint .', [`custom-${i}`]: 'x' } }] });
  }
  return { ...ctx, ledger: { ...ctx.ledger!, records: recs }, inventory: { workspaceRoot: ctx.workspaceRoot, repos } };
}
