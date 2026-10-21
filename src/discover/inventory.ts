/**
 * Inventory: repositories, packages, files and every configuration file the
 * tools document by name. Read-only; nothing is executed here except
 * `git ls-files` (argv array, timeout).
 *
 * Repositories are every folder with `.git` below the workspace root (up to
 * four levels, never inside node_modules or hidden folders), or the root
 * itself when it is a repository. Files come from `git ls-files -co
 * --exclude-standard` (tracked plus untracked-but-not-ignored), so generated
 * output the repository ignores is never scanned; folders without git are
 * walked with the default ignore list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../lib/exec';
import { DEFAULT_IGNORE_DIRS, walkFiles } from '../lib/fsx';
import { repoIdFor } from '../lib/config';
import { parseJsonc } from '../lib/jsonc';
import type { SkippedItem } from '../types';
import type { PackageInfo, RepoInfo, ScannedFile } from './model';
import { parseYaml } from './yaml';
import { matchGlob } from './glob';

export const MAX_FILE_BYTES = 1024 * 1024;
const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const TEST_RE = /(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/i;

export interface CiStep {
  name?: string;
  run?: string;
  uses?: string;
}
export interface CiJob {
  id: string;
  name: string;
  steps: CiStep[];
}
export interface CiWorkflow {
  file: string;
  name?: string;
  triggers: string[];
  jobs: CiJob[];
  /** Package scripts the workflow runs (npm/pnpm/yarn/bun run X, npm test). */
  scripts: string[];
  error?: string;
}

export interface RepoInventory {
  repo: RepoInfo;
  files: ScannedFile[];
  /** Every file name seen (relative), including the ones not scanned for code. */
  allFiles: string[];
  configs: Record<string, string[]>;
  ci: CiWorkflow[];
  tsconfigChains: Array<{ file: string; chain: string[]; unresolved: string[] }>;
  migrationDirs: string[];
  skipped: SkippedItem[];
}

export interface WorkspaceInventory {
  root: string;
  repos: RepoInventory[];
  /** Agent files at the workspace root (outside any repo). */
  workspaceAgentFiles: string[];
  skipped: SkippedItem[];
  truncated: boolean;
  totalFiles: number;
}

/** Documented config file names per tool (relative path patterns). */
export const CONFIG_PATTERNS: Record<string, string[]> = {
  eslint: ['**/eslint.config.{js,mjs,cjs,ts,mts,cts}', '**/.eslintrc', '**/.eslintrc.{js,cjs,yaml,yml,json}'],
  prettier: ['**/.prettierrc', '**/.prettierrc.{json,yaml,yml,json5,js,cjs,mjs,toml}', '**/prettier.config.{js,cjs,mjs,ts}'],
  biome: ['**/biome.json', '**/biome.jsonc'],
  editorconfig: ['**/.editorconfig'],
  tsconfig: ['**/tsconfig.json', '**/tsconfig.*.json'],
  vitest: ['**/vitest.config.{ts,js,mjs,cjs,mts}', '**/vitest.*.config.{ts,js,mjs,cjs,mts}', '**/vitest.workspace.{ts,js,mjs,json}', '**/vite.config.{ts,js,mjs}'],
  jest: ['**/jest.config.{ts,js,mjs,cjs,json}', '**/jest.*.config.{ts,js,mjs,cjs,json}'],
  mocha: ['**/.mocharc.{js,cjs,json,yaml,yml}', '**/.mocharc'],
  playwright: ['**/playwright.config.{ts,js,mjs}'],
  cypress: ['**/cypress.config.{ts,js,mjs}'],
  commitlint: ['**/commitlint.config.{js,cjs,mjs,ts}', '**/.commitlintrc', '**/.commitlintrc.{json,yaml,yml,js,cjs}'],
  husky: ['.husky/*'],
  lintStaged: ['**/.lintstagedrc', '**/.lintstagedrc.{json,yaml,yml,js,cjs,mjs}', '**/lint-staged.config.{js,cjs,mjs}'],
  ci: ['.github/workflows/*.{yml,yaml}', '.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'],
  contributing: ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', '**/CONTRIBUTING.md'],
  readme: ['README.md', '**/README.md'],
  prTemplate: ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE/*.md', 'docs/pull_request_template.md', 'pull_request_template.md'],
  codeowners: ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'],
  adr: ['docs/adr/**/*.md', 'docs/adrs/**/*.md', 'docs/decisions/**/*.md', 'adr/**/*.md', 'doc/adr/**/*.md'],
  agentFiles: [
    '**/AGENTS.md',
    '**/CLAUDE.md',
    '**/CLAUDE.local.md',
    '**/GEMINI.md',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/rules/**',
    '.claude/skills/**/SKILL.md',
    '.claude/commands/**',
    '.cursor/rules/**',
    '.cursorrules',
    '.windsurfrules',
    '.windsurf/rules/**',
    '.github/copilot-instructions.md',
    '.github/instructions/**',
    '.devin/**',
    '.agents/skills/**/SKILL.md',
    '.codex/**',
  ],
  sqlTools: ['**/.tsqllintrc', '**/.tsqllintrc.json', '**/.sqlfluff', '**/setup.cfg', '**/*.sqlproj', '**/flyway.conf', '**/liquibase.properties'],
  mcp: ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.codex/config.toml'],
  openapi: ['**/openapi*.{json,yaml,yml}', '**/swagger*.{json,yaml,yml}'],
  dependencyCruiser: ['.dependency-cruiser.{js,cjs,mjs,json}', '.dependency-cruiser.config.{js,cjs,mjs}'],
  knip: ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc', 'knip.config.{ts,js}'],
  docker: ['**/docker-compose*.{yml,yaml}', '**/compose.{yml,yaml}', '**/compose.*.{yml,yaml}', '**/Dockerfile'],
  env: ['**/.env', '**/.env.*', '**/*.env'],
  appConfig: ['**/appsettings*.json', '**/config/*.json', '**/config/*.{yml,yaml}', '**/ormconfig.{json,js,ts}', '**/knexfile.{js,ts}', '**/database.json', '**/datasource.{json,yml,yaml}'],
};

const AGENT_ROOT_NAMES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', '.cursorrules', '.windsurfrules'];

/** Folders with `.git` below `root` (root included when it is a repository). */
export function findRepos(root: string, maxDepth = 4): string[] {
  const abs = path.resolve(root);
  const out: string[] = [];
  if (fs.existsSync(path.join(abs, '.git'))) out.push(abs);
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || DEFAULT_IGNORE_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, '.git'))) {
        out.push(p);
        continue;
      }
      walk(p, depth + 1);
    }
  };
  walk(abs, 1);
  return out;
}

function gitFiles(repo: string): string[] | null {
  const r = run('git', ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: repo, timeoutMs: 120000, maxBuffer: 512 * 1024 * 1024 });
  if (r.code !== 0) return null;
  return r.stdout.split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
}

function readJsonFile<T>(p: string): T | null {
  try {
    return parseJsonc<T>(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function packageManagerOf(repo: string, files: Set<string>, pkg: { packageManager?: string } | null): RepoInfo['packageManager'] {
  const pm = pkg?.packageManager?.split('@')[0];
  if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn' || pm === 'bun') return pm;
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun';
  if (files.has('package-lock.json') || files.has('npm-shrinkwrap.json')) return 'npm';
  return fs.existsSync(path.join(repo, 'package.json')) ? 'npm' : 'unknown';
}

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

function workspaceGlobs(repo: string, pkg: PkgJson | null): string[] {
  const globs: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws.map(String));
  else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages.map(String));
  const pnpm = path.join(repo, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    try {
      const y = parseYaml(fs.readFileSync(pnpm, 'utf8')) as { packages?: unknown };
      if (Array.isArray(y?.packages)) globs.push(...y.packages.map(String).filter((g) => !g.startsWith('!')));
    } catch {
      /* reported elsewhere */
    }
  }
  return globs.map((g) => g.replace(/^\.\//, '').replace(/\/$/, ''));
}

function packageOf(repo: string, id: string, dir: string, pkg: PkgJson | null): PackageInfo {
  return {
    id: dir ? `${id}:${dir}` : id,
    repoId: id,
    name: pkg?.name ?? (dir ? path.basename(dir) : path.basename(repo)),
    dir,
    scripts: pkg?.scripts ?? {},
    deps: Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.peerDependencies ?? {}) }),
    devDeps: Object.keys(pkg?.devDependencies ?? {}),
  };
}

function scriptsInCommand(cmd: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:npm|pnpm|yarn|bun)(?:\s+(?:-w|--workspace|--filter|-F)\s+\S+)*\s+(run(?:-script)?\s+)?([\w:.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const word = m[2];
    if (m[1]) out.add(word);
    else if (['test', 'start', 'build', 'lint', 'typecheck'].includes(word)) out.add(word);
    else if (!['ci', 'install', 'i', 'exec', 'npx', 'dlx', 'add', 'publish', 'pack', 'audit', 'config', 'cache', 'set'].includes(word)) out.add(word);
  }
  return [...out];
}

export function parseWorkflow(file: string, text: string): CiWorkflow {
  const wf: CiWorkflow = { file, triggers: [], jobs: [], scripts: [] };
  let y: Record<string, unknown>;
  try {
    y = parseYaml(text) as Record<string, unknown>;
  } catch (e) {
    wf.error = (e as Error).message;
    return wf;
  }
  if (!y || typeof y !== 'object') return wf;
  if (typeof y.name === 'string') wf.name = y.name;
  const on = y.on ?? y.true;
  if (typeof on === 'string') wf.triggers = [on];
  else if (Array.isArray(on)) wf.triggers = on.map(String);
  else if (on && typeof on === 'object') wf.triggers = Object.keys(on);
  const jobs = y.jobs && typeof y.jobs === 'object' ? (y.jobs as Record<string, unknown>) : {};
  const scripts = new Set<string>();
  for (const [id, raw] of Object.entries(jobs)) {
    const j = (raw ?? {}) as { name?: string; steps?: unknown[] };
    const steps: CiStep[] = [];
    for (const s of Array.isArray(j.steps) ? j.steps : []) {
      if (!s || typeof s !== 'object') continue;
      const st = s as Record<string, unknown>;
      const step: CiStep = {};
      if (typeof st.name === 'string') step.name = st.name;
      if (typeof st.run === 'string') {
        step.run = st.run;
        for (const sc of scriptsInCommand(st.run)) scripts.add(sc);
      }
      if (typeof st.uses === 'string') step.uses = st.uses;
      steps.push(step);
    }
    wf.jobs.push({ id, name: typeof j.name === 'string' ? j.name : id, steps });
  }
  wf.scripts = [...scripts];
  return wf;
}

function classify(rel: string): ScannedFile['kind'] {
  if (CODE_EXT.test(rel)) return 'code';
  if (/\.sql$/i.test(rel)) return 'sql';
  return 'other';
}

export function isTestPath(rel: string): boolean {
  return TEST_RE.test(rel);
}

function looksBinary(abs: string): boolean {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  }
}

function resolveTsconfigChain(repo: string, rel: string): { chain: string[]; unresolved: string[] } {
  const chain: string[] = [rel];
  const unresolved: string[] = [];
  let cur = path.join(repo, rel);
  for (let i = 0; i < 10; i++) {
    const j = readJsonFile<{ extends?: string | string[] }>(cur);
    const ext = j?.extends;
    const first = Array.isArray(ext) ? ext[0] : ext;
    if (!first) break;
    let next: string | null = null;
    if (first.startsWith('.')) {
      next = path.resolve(path.dirname(cur), first);
      if (!fs.existsSync(next) && fs.existsSync(next + '.json')) next += '.json';
    } else {
      try {
        next = require.resolve(first.endsWith('.json') ? first : `${first}`, { paths: [path.dirname(cur)] });
      } catch {
        try {
          next = require.resolve(`${first}/tsconfig.json`, { paths: [path.dirname(cur)] });
        } catch {
          next = null;
        }
      }
    }
    if (!next || !fs.existsSync(next)) {
      unresolved.push(first);
      break;
    }
    chain.push(path.relative(repo, next).split(path.sep).join('/'));
    cur = next;
  }
  return { chain, unresolved };
}

export interface InventoryOptions {
  maxFiles?: number;
  progress?: (line: string) => void;
}

/** Build the inventory of one repository. `budget` is the remaining --max-files allowance. */
export function inventoryRepo(root: string, repoPath: string, budget: { left: number }): RepoInventory {
  const id = repoIdFor(repoPath);
  const isGit = fs.existsSync(path.join(repoPath, '.git'));
  let listed = isGit ? gitFiles(repoPath) : null;
  if (!listed) listed = walkFiles(repoPath).map((f) => path.relative(repoPath, f).split(path.sep).join('/'));
  listed = listed.filter((f) => !/(^|\/)node_modules\//.test(f)).sort();
  const fileSet = new Set(listed);
  const rootPkg = readJsonFile<PkgJson>(path.join(repoPath, 'package.json'));
  const packages: PackageInfo[] = [packageOf(repoPath, id, '', rootPkg)];
  const wsGlobs = workspaceGlobs(repoPath, rootPkg);
  if (wsGlobs.length) {
    for (const f of listed) {
      if (!f.endsWith('/package.json') || f.includes('node_modules/')) continue;
      const dir = f.slice(0, -'/package.json'.length);
      if (wsGlobs.some((g) => matchGlob(dir, g))) packages.push(packageOf(repoPath, id, dir, readJsonFile<PkgJson>(path.join(repoPath, f))));
    }
  }
  packages.sort((a, b) => b.dir.length - a.dir.length);
  const repo: RepoInfo = {
    id,
    name: path.basename(repoPath),
    path: repoPath,
    relPath: path.relative(root, repoPath).split(path.sep).join('/') || '.',
    isGit,
    packageManager: packageManagerOf(repoPath, fileSet, rootPkg),
    packages: [...packages].sort((a, b) => a.dir.localeCompare(b.dir)),
  };
  const skipped: SkippedItem[] = [];
  const files: ScannedFile[] = [];
  for (const rel of listed) {
    const kind = classify(rel);
    if (kind === 'other') continue;
    const abs = path.join(repoPath, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const display = `${repo.relPath === '.' ? '' : repo.relPath + '/'}${rel}`;
    if (budget.left <= 0) {
      skipped.push({ path: display, reason: 'over the --max-files limit' });
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      skipped.push({ path: display, reason: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
      continue;
    }
    if (/\.min\.js$/i.test(rel)) {
      skipped.push({ path: display, reason: 'minified file' });
      continue;
    }
    if (looksBinary(abs)) {
      skipped.push({ path: display, reason: 'binary content' });
      continue;
    }
    budget.left--;
    const pkg = packages.find((p) => p.dir === '' || rel === p.dir || rel.startsWith(p.dir + '/'))!;
    files.push({ abs, rel, repoId: id, pkg: pkg.id, bytes: st.size, kind, isTest: isTestPath(rel) });
  }
  const configs: Record<string, string[]> = {};
  for (const [tool, globs] of Object.entries(CONFIG_PATTERNS)) {
    const hits = listed.filter((f) => !f.includes('node_modules/') && globs.some((g) => matchGlob(f, g)));
    if (hits.length) configs[tool] = hits;
  }
  const ci: CiWorkflow[] = [];
  for (const f of configs.ci ?? []) {
    if (!/\.ya?ml$/.test(f)) {
      ci.push({ file: f, triggers: [], jobs: [], scripts: [], error: 'not parsed (only YAML workflows are read)' });
      continue;
    }
    try {
      ci.push(parseWorkflow(f, fs.readFileSync(path.join(repoPath, f), 'utf8')));
    } catch (e) {
      ci.push({ file: f, triggers: [], jobs: [], scripts: [], error: (e as Error).message });
    }
  }
  const tsconfigChains = (configs.tsconfig ?? []).map((f) => ({ file: f, ...resolveTsconfigChain(repoPath, f) }));
  const migrationDirs = [...new Set(listed.filter((f) => /(^|\/)(migrations?|db\/migrate)\/.*\.sql$/i.test(f)).map((f) => f.slice(0, f.lastIndexOf('/'))))];
  return { repo, files, allFiles: listed, configs, ci, tsconfigChains, migrationDirs, skipped };
}

/** Inventory of the whole workspace. */
export function inventoryWorkspace(root: string, opts: InventoryOptions = {}): WorkspaceInventory {
  const abs = path.resolve(root);
  const repoPaths = findRepos(abs);
  if (!repoPaths.length) repoPaths.push(abs);
  const budget = { left: opts.maxFiles ?? Infinity };
  const repos: RepoInventory[] = [];
  for (const rp of repoPaths) {
    const inv = inventoryRepo(abs, rp, budget);
    opts.progress?.(`discover: inventory ${inv.repo.relPath}: ${inv.files.length} source files, ${inv.repo.packages.length} package(s), ${inv.skipped.length} skipped`);
    repos.push(inv);
  }
  const workspaceAgentFiles: string[] = [];
  if (!repoPaths.includes(abs)) {
    for (const n of AGENT_ROOT_NAMES) if (fs.existsSync(path.join(abs, n))) workspaceAgentFiles.push(n);
    for (const d of ['.claude', '.cursor', '.devin', '.codex', '.agents', '.github']) {
      const p = path.join(abs, d);
      if (!fs.existsSync(p)) continue;
      for (const f of walkFiles(p, { maxFiles: 200 })) {
        const rel = path.relative(abs, f).split(path.sep).join('/');
        if (CONFIG_PATTERNS.agentFiles.some((g) => matchGlob(rel, g))) workspaceAgentFiles.push(rel);
      }
    }
  }
  const skipped = repos.flatMap((r) => r.skipped);
  return {
    root: abs,
    repos,
    workspaceAgentFiles,
    skipped,
    truncated: budget.left <= 0 && skipped.some((s) => s.reason.startsWith('over the --max-files')),
    totalFiles: repos.reduce((n, r) => n + r.files.length, 0),
  };
}
