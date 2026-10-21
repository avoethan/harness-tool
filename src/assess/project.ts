/**
 * Facts about the repositories in a workspace that the checks compare agent
 * files against: script names (package.json), Make and just targets, the
 * resolved Prettier / ESLint / EditorConfig options, CI workflows, git hooks,
 * and which agent-local files git tracks.
 *
 * Nothing here executes repository code: JavaScript config files are read as
 * text and only literal option values are picked out.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonc, tryParseJsonc } from '../lib/jsonc';
import { rawGit } from '../lib/git';
import { exists, isDir, isFile, readTextOr, walkFiles } from '../lib/fsx';
import { tryParseToml } from './toml';
import type { EslintInfo, PrettierInfo, RepoInfo, WorkflowInfo } from './model';

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs'];

export function hasGit(dir: string): boolean {
  return exists(path.join(dir, '.git'));
}

function looksLikeRepo(dir: string): boolean {
  if (hasGit(dir)) return true;
  if (MANIFESTS.some((m) => isFile(path.join(dir, m)))) return true;
  try {
    return fs.readdirSync(dir).some((n) => /\.(csproj|sln)$/.test(n));
  } catch {
    return false;
  }
}

/**
 * The repositories of a workspace. A workspace that is itself a git
 * repository is one repo (personal shape). Otherwise every child folder with
 * `.git` or a project manifest is a sub-repo, and grandchildren with `.git`.
 */
export function findRepos(workspace: string): string[] {
  if (hasGit(workspace)) return [workspace];
  const out: string[] = [];
  let children: fs.Dirent[] = [];
  try {
    children = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const c of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!c.isDirectory() || c.name.startsWith('.') || c.name === 'node_modules') continue;
    const dir = path.join(workspace, c.name);
    if (looksLikeRepo(dir)) {
      out.push(dir);
      continue;
    }
    try {
      for (const g of fs.readdirSync(dir, { withFileTypes: true })) {
        if (g.isDirectory() && !g.name.startsWith('.') && hasGit(path.join(dir, g.name))) out.push(path.join(dir, g.name));
      }
    } catch {
      /* unreadable */
    }
  }
  // A single project folder without .git (and without sub-repos) is one repo.
  if (!out.length && looksLikeRepo(workspace)) out.push(workspace);
  return out;
}

export function readRepo(root: string, show: (p: string) => string): RepoInfo {
  const unparsed: string[] = [];
  const scripts = new Map<string, Set<string>>();
  const pkgFiles = walkFiles(root, { filter: (_a, rel) => path.basename(rel) === 'package.json', maxFiles: 400 }).filter(
    (p) => path.relative(root, p).split(path.sep).length <= 5,
  );
  let rootPkg: Record<string, unknown> | null = null;
  for (const p of pkgFiles) {
    const r = tryParseJsonc<Record<string, unknown>>(readTextOr(p, '') ?? '');
    if (!r.ok) {
      unparsed.push(`${show(p)}: ${r.error}`);
      continue;
    }
    const s = r.value.scripts;
    scripts.set(path.dirname(p), new Set(s && typeof s === 'object' ? Object.keys(s as object) : []));
    if (path.dirname(p) === root) rootPkg = r.value;
  }
  return {
    root,
    name: path.basename(root),
    isGit: hasGit(root),
    scripts,
    makeTargets: readMakeTargets(root),
    justRecipes: readJustRecipes(root),
    prettier: readPrettier(root, rootPkg, show, unparsed),
    eslint: readEslint(root, rootPkg, show, unparsed),
    editorconfig: readEditorconfig(root, show),
    workflows: readWorkflows(root),
    gitHooks: readGitHooks(root, rootPkg, show),
    unparsed,
  };
}

// ---------------------------------------------------------------------------
// Make / just
// ---------------------------------------------------------------------------

function readMakeTargets(root: string): Set<string> | null {
  const f = ['GNUmakefile', 'Makefile', 'makefile'].map((n) => path.join(root, n)).find(isFile);
  if (!f) return null;
  const out = new Set<string>();
  for (const line of (readTextOr(f, '') ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.%/\- ]+?)\s*::?(?!=)/.exec(line);
    if (!m || line.startsWith('\t')) continue;
    for (const t of m[1].split(/\s+/)) if (t && !t.startsWith('.') && !t.includes('%')) out.add(t);
  }
  return out;
}

function readJustRecipes(root: string): Set<string> | null {
  const f = ['justfile', 'Justfile', '.justfile'].map((n) => path.join(root, n)).find(isFile);
  if (!f) return null;
  const out = new Set<string>();
  for (const line of (readTextOr(f, '') ?? '').split(/\r?\n/)) {
    const m = /^@?([A-Za-z0-9_-]+)(?:\s+[^:=]*)?:(?!=)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prettier / ESLint / EditorConfig
// ---------------------------------------------------------------------------

const PRETTIER_DEFAULTS = { useTabs: false, semi: true, singleQuote: false, tabWidth: 2, printWidth: 80, trailingComma: 'all' };

function simpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    out[m[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

function literalOptions(text: string, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = new RegExp(`\\b(${keys.join('|')})\\s*:\\s*(true|false|\\d+|'[^']*'|"[^"]*")`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = m[2];
    out[m[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v.slice(1, -1);
  }
  return out;
}

function readPrettier(root: string, pkg: Record<string, unknown> | null, show: (p: string) => string, unparsed: string[]): PrettierInfo | null {
  const keys = Object.keys(PRETTIER_DEFAULTS);
  let opts: Record<string, unknown> | null = null;
  let file = '';
  const candidates = ['.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.toml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts'];
  for (const name of candidates) {
    const p = path.join(root, name);
    if (!isFile(p)) continue;
    const text = readTextOr(p, '') ?? '';
    file = show(p);
    if (/\.(js|cjs|mjs|ts)$/.test(name)) opts = literalOptions(text, keys);
    else if (name.endsWith('.toml')) {
      const r = tryParseToml(text);
      if (r.ok) opts = r.value as Record<string, unknown>;
      else unparsed.push(`${file}: ${r.error}`);
    } else if (/\.ya?ml$/.test(name)) opts = simpleYaml(text);
    else {
      const r = tryParseJsonc<Record<string, unknown>>(text);
      if (r.ok && r.value && typeof r.value === 'object') opts = r.value;
      else if (name === '.prettierrc') opts = simpleYaml(text);
      else unparsed.push(`${file}: ${r.ok ? 'not an object' : r.error}`);
    }
    break;
  }
  if (!opts && pkg && pkg.prettier && typeof pkg.prettier === 'object') {
    opts = pkg.prettier as Record<string, unknown>;
    file = show(path.join(root, 'package.json')) + '#prettier';
  }
  if (!opts) return null;
  const explicit = new Set(Object.keys(opts).filter((k) => keys.includes(k)));
  return {
    file,
    useTabs: typeof opts.useTabs === 'boolean' ? opts.useTabs : PRETTIER_DEFAULTS.useTabs,
    semi: typeof opts.semi === 'boolean' ? opts.semi : PRETTIER_DEFAULTS.semi,
    singleQuote: typeof opts.singleQuote === 'boolean' ? opts.singleQuote : PRETTIER_DEFAULTS.singleQuote,
    tabWidth: typeof opts.tabWidth === 'number' ? opts.tabWidth : PRETTIER_DEFAULTS.tabWidth,
    printWidth: typeof opts.printWidth === 'number' ? opts.printWidth : PRETTIER_DEFAULTS.printWidth,
    trailingComma: typeof opts.trailingComma === 'string' ? opts.trailingComma : PRETTIER_DEFAULTS.trailingComma,
    explicit,
  };
}

function severityOf(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (x === 0 || x === '0' || x === 'off') return 'off';
  if (x === 1 || x === '1' || x === 'warn') return 'warn';
  if (x === 2 || x === '2' || x === 'error') return 'error';
  return null;
}

function readEslint(root: string, pkg: Record<string, unknown> | null, show: (p: string) => string, unparsed: string[]): EslintInfo | null {
  const rules = new Map<string, string>();
  const candidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.js', '.eslintrc.cjs'];
  for (const name of candidates) {
    const p = path.join(root, name);
    if (!isFile(p)) continue;
    const text = readTextOr(p, '') ?? '';
    if (/\.(js|cjs|mjs|ts)$/.test(name)) {
      const re = /['"]?((?:@[\w-]+\/)?[\w-]+(?:\/[\w-]+)?)['"]?\s*:\s*\[?\s*(?:'(off|warn|error)'|"(off|warn|error)"|([012])\b)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) rules.set(m[1], severityOf(m[2] ?? m[3] ?? m[4]) ?? 'error');
    } else if (/\.ya?ml$/.test(name)) {
      readYamlRules(text, rules);
    } else {
      const r = tryParseJsonc<Record<string, unknown>>(text);
      if (r.ok) addJsonRules(r.value, rules);
      else if (name === '.eslintrc') readYamlRules(text, rules);
      else unparsed.push(`${show(p)}: ${r.error}`);
    }
    return { file: show(p), rules };
  }
  if (pkg && pkg.eslintConfig && typeof pkg.eslintConfig === 'object') {
    addJsonRules(pkg.eslintConfig as Record<string, unknown>, rules);
    return { file: show(path.join(root, 'package.json')) + '#eslintConfig', rules };
  }
  return null;
}

function addJsonRules(cfg: unknown, rules: Map<string, string>): void {
  const r = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).rules : undefined;
  if (!r || typeof r !== 'object') return;
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    const s = severityOf(v);
    if (s) rules.set(k, s);
  }
}

function readYamlRules(text: string, rules: Map<string, string>): void {
  let inRules = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^rules\s*:/.test(line)) {
      inRules = true;
      continue;
    }
    if (inRules && /^\S/.test(line)) inRules = false;
    if (!inRules) continue;
    const m = /^\s+['"]?([@\w/-]+)['"]?\s*:\s*\[?\s*['"]?(off|warn|error|[012])\b/.exec(line);
    if (m) rules.set(m[1], severityOf(m[2]) ?? 'error');
  }
}

function readEditorconfig(root: string, show: (p: string) => string): RepoInfo['editorconfig'] {
  const p = path.join(root, '.editorconfig');
  if (!isFile(p)) return null;
  let section = '';
  let style: 'tab' | 'space' | undefined;
  let size: number | undefined;
  for (const raw of (readTextOr(p, '') ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const s = /^\[(.*)\]$/.exec(line);
    if (s) {
      section = s[1];
      continue;
    }
    const relevant = section === '*' || /\b(ts|js|tsx|jsx)\b/.test(section);
    if (!relevant) continue;
    const kv = /^(indent_style|indent_size)\s*=\s*(\S+)/i.exec(line);
    if (!kv) continue;
    if (kv[1].toLowerCase() === 'indent_style' && (kv[2] === 'tab' || kv[2] === 'space')) style = kv[2];
    if (kv[1].toLowerCase() === 'indent_size' && /^\d+$/.test(kv[2])) size = Number(kv[2]);
  }
  return { file: show(p), indentStyle: style, indentSize: size };
}

// ---------------------------------------------------------------------------
// CI workflows (text-level YAML reading, enough for triggers and job names)
// ---------------------------------------------------------------------------

export function parseWorkflow(text: string, file: string): WorkflowInfo {
  const lines = text.split(/\r?\n/);
  const triggers = new Set<string>();
  const jobs: WorkflowInfo['jobs'] = [];
  for (let i = 0; i < lines.length; i++) {
    const on = /^(?:on|"on"|'on'|true)\s*:\s*(.*)$/.exec(lines[i]);
    if (on) {
      const inline = on[1].replace(/#.*$/, '').trim();
      if (inline) {
        for (const t of inline.replace(/[[\]{}]/g, ' ').split(/[\s,]+/)) if (/^[a-z_]+$/.test(t)) triggers.add(t);
      } else {
        let indent = -1;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (l.trim() === '' || l.trim().startsWith('#')) continue;
          const ind = /^\s*/.exec(l)![0].length;
          if (ind === 0) break;
          if (indent < 0) indent = ind;
          if (ind !== indent) continue;
          const k = /^\s*-?\s*([a-z_]+)\s*:?/.exec(l);
          if (k) triggers.add(k[1]);
        }
      }
    }
    if (/^jobs\s*:\s*$/.test(lines[i])) {
      let indent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        const ind = /^\s*/.exec(l)![0].length;
        if (ind === 0) break;
        if (indent < 0) indent = ind;
        if (ind !== indent) continue;
        const k = /^\s*([A-Za-z0-9_-]+)\s*:\s*$/.exec(l);
        if (!k) continue;
        let name = k[1];
        let childIndent = -1;
        for (let x = j + 1; x < lines.length; x++) {
          const lx = lines[x];
          if (lx.trim() === '' || lx.trim().startsWith('#')) continue;
          const ix = /^\s*/.exec(lx)![0].length;
          if (ix <= indent) break;
          if (childIndent < 0) childIndent = ix;
          if (ix !== childIndent) continue;
          const nm = /^\s*name\s*:\s*(.+?)\s*$/.exec(lx);
          if (nm) {
            name = nm[1].replace(/^['"]|['"]$/g, '');
            break;
          }
        }
        jobs.push({ id: k[1], name, line: j + 1 });
      }
    }
  }
  return { file, triggers, jobs, text };
}

function readWorkflows(root: string): WorkflowInfo[] {
  const dir = path.join(root, '.github', 'workflows');
  if (!isDir(dir)) return [];
  const out: WorkflowInfo[] = [];
  for (const n of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(n)) continue;
    const p = path.join(dir, n);
    out.push(parseWorkflow(readTextOr(p, '') ?? '', p));
  }
  return out;
}

/** Other CI systems: job or stage names, for the safety inventory. */
export function otherCiJobs(root: string): Array<{ file: string; name: string; line: number; text: string }> {
  const out: Array<{ file: string; name: string; line: number; text: string }> = [];
  const gl = path.join(root, '.gitlab-ci.yml');
  if (isFile(gl)) {
    const text = readTextOr(gl, '') ?? '';
    const reserved = new Set(['stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'before_script', 'after_script', 'cache']);
    text.split(/\r?\n/).forEach((l, i) => {
      const m = /^([A-Za-z0-9_][A-Za-z0-9_ :-]*?)\s*:\s*$/.exec(l);
      if (m && !reserved.has(m[1]) && !m[1].startsWith('.')) out.push({ file: gl, name: m[1], line: i + 1, text });
    });
  }
  for (const n of ['azure-pipelines.yml', 'azure-pipelines.yaml']) {
    const p = path.join(root, n);
    if (!isFile(p)) continue;
    const text = readTextOr(p, '') ?? '';
    text.split(/\r?\n/).forEach((l, i) => {
      const m = /^\s*-\s*(?:job|stage)\s*:\s*(\S+)/.exec(l) ?? /^\s*displayName\s*:\s*['"]?(.+?)['"]?\s*$/.exec(l);
      if (m) out.push({ file: p, name: m[1], line: i + 1, text });
    });
  }
  const jf = path.join(root, 'Jenkinsfile');
  if (isFile(jf)) {
    const text = readTextOr(jf, '') ?? '';
    text.split(/\r?\n/).forEach((l, i) => {
      const m = /\bstage\s*\(\s*['"]([^'"]+)['"]/.exec(l);
      if (m) out.push({ file: jf, name: m[1], line: i + 1, text });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git hooks and tracked files
// ---------------------------------------------------------------------------

function readGitHooks(root: string, pkg: Record<string, unknown> | null, show: (p: string) => string): RepoInfo['gitHooks'] {
  const out: RepoInfo['gitHooks'] = [];
  for (const d of ['.husky', '.githooks']) {
    const dir = path.join(root, d);
    if (!isDir(dir)) continue;
    for (const n of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, n);
      if (n.startsWith('.') || n === '_' || !isFile(p) || n.endsWith('.sample')) continue;
      out.push({ abs: p, source: show(p), text: readTextOr(p, '') ?? '' });
    }
  }
  for (const n of ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', '.pre-commit-config.yaml', '.pre-commit-config.yml', '.simple-git-hooks.json', '.simple-git-hooks.js', '.simple-git-hooks.cjs']) {
    const p = path.join(root, n);
    if (isFile(p)) out.push({ abs: p, source: show(p), text: readTextOr(p, '') ?? '' });
  }
  const pj = path.join(root, 'package.json');
  if (pkg && pkg['simple-git-hooks'] && typeof pkg['simple-git-hooks'] === 'object') {
    for (const [k, v] of Object.entries(pkg['simple-git-hooks'] as Record<string, unknown>)) out.push({ abs: pj, source: `${show(pj)}#simple-git-hooks.${k}`, text: `${k}: ${String(v)}` });
  }
  const husky4 = pkg && pkg.husky && typeof pkg.husky === 'object' ? (pkg.husky as Record<string, unknown>).hooks : undefined;
  if (husky4 && typeof husky4 === 'object') {
    for (const [k, v] of Object.entries(husky4 as Record<string, unknown>)) out.push({ abs: pj, source: `${show(pj)}#husky.hooks.${k}`, text: `${k}: ${String(v)}` });
  }
  return out;
}

/** Which of the given repo-relative paths (or pathspecs) git tracks; null when not a git repo or git failed. */
export function trackedAmong(root: string, specs: string[]): Set<string> | null {
  if (!hasGit(root) || !specs.length) return null;
  const r = rawGit(root, ['ls-files', '-z', '--', ...specs], 15000);
  if (r.code !== 0) return null;
  return new Set(r.stdout.split('\0').filter(Boolean).map((s) => s.replace(/\\/g, '/')));
}

/** Script names anywhere in the repos (for files that are not inside one repo). */
export function allScripts(repos: RepoInfo[]): Set<string> {
  const out = new Set<string>();
  for (const r of repos) for (const s of r.scripts.values()) for (const x of s) out.add(x);
  return out;
}

/** The scripts of the package.json nearest to `file` inside `repo` (walking up), or null. */
export function nearestScripts(repo: RepoInfo, file: string): Set<string> | null {
  let dir = path.dirname(file);
  for (;;) {
    const s = repo.scripts.get(dir);
    if (s) return s;
    if (dir === repo.root || path.dirname(dir) === dir) break;
    if (!dir.startsWith(repo.root)) break;
    dir = path.dirname(dir);
  }
  return repo.scripts.get(repo.root) ?? null;
}

export { parseJsonc };
