/**
 * Declared standards: what the repository's own configs say, read exactly.
 *
 * Static reading (always): ESLint rule entries and their `files` overrides
 * from the config text, Prettier / Biome / EditorConfig options, tsconfig
 * chains, test-runner include globs, commitlint presets, CI scripts.
 *
 * Resolved reading (sampled; when the repo's own binaries exist in its
 * node_modules and --no-exec is not given): `eslint --print-config <file>`
 * and `tsc --showConfig -p <tsconfig>` run with node, an argv array and a
 * 30-second timeout. Sample: up to three files per package (one source
 * module, one test file, one more source module), documented in the report.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../lib/exec';
import { parseJsonc } from '../lib/jsonc';
import type { DeclaredSetting, EffectiveConfigRun, ScannedFile } from './model';
import type { RepoInventory } from './inventory';
import { parseYaml } from './yaml';
import { globToRegExp } from './glob';

type Sev = 'error' | 'warn' | 'off';

export function normSeverity(v: unknown): Sev | null {
  if (v === 2 || v === '2' || v === 'error') return 'error';
  if (v === 1 || v === '1' || v === 'warn') return 'warn';
  if (v === 0 || v === '0' || v === 'off') return 'off';
  return null;
}

/** Index of the bracket that closes the one at `open` (skips strings and comments). */
export function matchBracket(s: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Start of the object literal that encloses position `pos`. */
function enclosingObjectStart(s: string, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = s[i];
    if (c === '}' || c === ']') depth++;
    else if (c === '{' || c === '[') {
      if (depth === 0) return c === '{' ? i : -1;
      depth--;
    }
  }
  return -1;
}

function quotedList(text: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[2]);
  return out;
}

function lineAt(s: string, i: number): number {
  return s.slice(0, i).split('\n').length;
}

export interface StaticEslintRule {
  rule: string;
  severity: Sev;
  options: string;
  files?: string[];
  line: number;
}

/**
 * Read rule entries from an ESLint config's text (flat config JS or legacy
 * JSON/YAML). Entries inside an object with `files: [...]` carry those globs.
 */
export function parseEslintConfigText(text: string, file: string): StaticEslintRule[] {
  if (/\.(json|ya?ml)$/.test(file) || /(^|\/)\.eslintrc$/.test(file)) {
    let obj: unknown = null;
    try {
      obj = /\.ya?ml$/.test(file) ? parseYaml(text) : parseJsonc(text);
    } catch {
      try {
        obj = parseYaml(text);
      } catch {
        obj = null;
      }
    }
    const out: StaticEslintRule[] = [];
    const take = (rules: unknown, files?: string[]) => {
      if (!rules || typeof rules !== 'object') return;
      for (const [rule, v] of Object.entries(rules as Record<string, unknown>)) {
        const sev = normSeverity(Array.isArray(v) ? v[0] : v);
        if (!sev) continue;
        const at = text.indexOf(rule);
        out.push({ rule, severity: sev, options: Array.isArray(v) ? JSON.stringify(v.slice(1)) : '', files, line: at >= 0 ? lineAt(text, at) : 1 });
      }
    };
    const o = (obj ?? {}) as { rules?: unknown; overrides?: Array<{ files?: unknown; rules?: unknown }> };
    take(o.rules);
    for (const ov of Array.isArray(o.overrides) ? o.overrides : []) {
      const files = Array.isArray(ov.files) ? ov.files.map(String) : typeof ov.files === 'string' ? [ov.files] : undefined;
      take(ov.rules, files);
    }
    return out;
  }
  const out: StaticEslintRule[] = [];
  const re = /\brules\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const body = text.slice(open + 1, close);
    const objStart = enclosingObjectStart(text, m.index);
    let files: string[] | undefined;
    if (objStart >= 0) {
      const objEnd = matchBracket(text, objStart);
      const objText = objEnd > 0 ? text.slice(objStart, objEnd + 1) : '';
      const fm = /\bfiles\s*:\s*\[/.exec(objText);
      if (fm) {
        const fOpen = fm.index + fm[0].length - 1;
        const fClose = matchBracket(objText, fOpen);
        if (fClose > 0) files = quotedList(objText.slice(fOpen + 1, fClose));
      }
    }
    // Entries: 'rule': 'error' | 2 | ['error', ...]
    const entry = /(['"])(@?[\w-]+(?:\/[\w-]+)*)\1\s*:\s*|(?:^|[\s,{])([a-z][\w-]*)\s*:\s*/g;
    let e: RegExpExecArray | null;
    while ((e = entry.exec(body))) {
      const rule = e[2] ?? e[3];
      const after = body.slice(e.index + e[0].length);
      let sev: Sev | null = null;
      let options = '';
      if (after.startsWith('[')) {
        const end = matchBracket(after, 0);
        const arr = end > 0 ? after.slice(1, end) : '';
        const first = /^\s*(['"]?)(error|warn|off|0|1|2)\1/.exec(arr);
        sev = first ? normSeverity(first[2]) : null;
        options = arr.slice(first ? first[0].length : 0).replace(/^\s*,/, '').trim();
        entry.lastIndex = e.index + e[0].length + (end > 0 ? end + 1 : 1);
      } else {
        const v = /^(['"]?)(error|warn|off|0|1|2)\1/.exec(after);
        sev = v ? normSeverity(v[2]) : null;
      }
      if (!sev || ['files', 'ignores', 'rules', 'languageOptions', 'plugins', 'settings'].includes(rule)) continue;
      out.push({ rule, severity: sev, options, files, line: lineAt(text, open + 1 + e.index) });
    }
  }
  return out;
}

/** Oxlint / Vite+ rule names are ESLint names without the plugin package prefix. */
export function eslintNameOf(rule: string): string {
  return rule.replace(/^typescript\//, '@typescript-eslint/');
}

export interface ViteConfigDecl {
  rules: StaticEslintRule[];
  /** Formatter options of the `fmt` section (Prettier-compatible names). */
  fmt: Record<string, unknown>;
}

/**
 * Read the `lint.rules` and `fmt` sections of a `vite.config.*` / `vitest.config.*` text (Vite+ keeps its
 * linter and formatter settings there, with ESLint-style severities). Only these two sections are read;
 * nothing in the file is run.
 */
export function parseViteConfigText(text: string): ViteConfigDecl {
  const out: ViteConfigDecl = { rules: [], fmt: {} };
  const section = (name: string): { body: string; offset: number } | null => {
    const m = new RegExp(`\\b${name}\\s*:\\s*\\{`).exec(text);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    return close < 0 ? null : { body: text.slice(open, close + 1), offset: open };
  };
  const lint = section('lint');
  if (lint) {
    const base = lineAt(text, lint.offset) - 1;
    for (const r of parseEslintConfigText(lint.body, 'vite.config.ts')) out.rules.push({ ...r, rule: eslintNameOf(r.rule), line: r.line + base });
  }
  const fmt = section('fmt');
  if (fmt) {
    const re = /\b(singleQuote|semi|trailingComma|tabWidth|useTabs|printWidth|endOfLine|bracketSpacing|arrowParens|jsxSingleQuote)\s*:\s*(true|false|\d+|'[^']*'|"[^"]*")/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fmt.body))) {
      const v = m[2];
      out.fmt[m[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v.slice(1, -1);
    }
  }
  return out;
}

/** Resolve a package's CLI script from a repository's own node_modules. */
export function resolveRepoBin(repoPath: string, pkg: string, binName: string): string | null {
  try {
    const pj = require.resolve(`${pkg}/package.json`, { paths: [repoPath] });
    if (!pj.startsWith(path.resolve(repoPath))) return null; // only the repo's own install
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[binName];
    if (!rel) return null;
    const p = path.join(path.dirname(pj), rel);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Sample files for effective-config resolution: up to 3 per package. */
export function sampleFiles(files: ScannedFile[]): ScannedFile[] {
  const byPkg = new Map<string, ScannedFile[]>();
  for (const f of files) {
    if (f.kind !== 'code') continue;
    const l = byPkg.get(f.pkg) ?? [];
    l.push(f);
    byPkg.set(f.pkg, l);
  }
  const out: ScannedFile[] = [];
  for (const l of byPkg.values()) {
    const src = l.filter((f) => !f.isTest && /(^|\/)src\//.test(f.rel));
    const tests = l.filter((f) => f.isTest);
    const pick = [src[0], tests[0], src[Math.floor(src.length / 2)]].filter((x): x is ScannedFile => !!x);
    for (const p of pick) if (!out.includes(p)) out.push(p);
  }
  return out;
}

interface PrettierLike {
  [k: string]: unknown;
}

function readPrettier(repoPath: string, rel: string): PrettierLike | null {
  const abs = path.join(repoPath, rel);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  if (/\.(json|json5)$/.test(rel) || /\.prettierrc$/.test(rel)) {
    try {
      return parseJsonc<PrettierLike>(text);
    } catch {
      /* maybe YAML */
    }
  }
  if (/\.ya?ml$/.test(rel) || /\.prettierrc$/.test(rel)) {
    try {
      const y = parseYaml(text);
      return y && typeof y === 'object' ? (y as PrettierLike) : null;
    } catch {
      return null;
    }
  }
  // JS config: read simple `key: value` pairs.
  const out: PrettierLike = {};
  const re = /\b(singleQuote|semi|trailingComma|tabWidth|useTabs|printWidth|endOfLine|bracketSpacing|arrowParens|jsxSingleQuote)\s*:\s*(true|false|\d+|'[^']*'|"[^"]*")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = m[2];
    out[m[1]] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v.slice(1, -1);
  }
  return Object.keys(out).length ? out : null;
}

/** EditorConfig properties that apply to a file name. */
export function editorconfigFor(text: string, fileName: string): Record<string, string> {
  const out: Record<string, string> = {};
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const pat = sec[1];
      const target = pat.includes('/') ? fileName : path.posix.basename(fileName);
      applies = globToRegExp(pat.replace(/^\//, '')).test(target);
      continue;
    }
    const kv = /^([\w-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (kv && applies) out[kv[1].toLowerCase()] = kv[2].trim().toLowerCase();
  }
  return out;
}

export interface TestRunnerDecl {
  tool: string;
  source: string;
  include: string[];
  pkgDir: string;
}

export function testRunnerIncludes(repoPath: string, inv: RepoInventory): TestRunnerDecl[] {
  const out: TestRunnerDecl[] = [];
  for (const rel of [...(inv.configs.vitest ?? []), ...(inv.configs.jest ?? [])]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      continue;
    }
    const tool = /jest/.test(rel) ? 'jest' : 'vitest';
    const key = tool === 'jest' ? /\b(testMatch|roots)\s*:\s*\[/g : /\binclude\s*:\s*\[/g;
    let m: RegExpExecArray | null;
    const globs: string[] = [];
    while ((m = key.exec(text))) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(text, open);
      if (close > 0) globs.push(...quotedList(text.slice(open + 1, close)));
    }
    if (globs.length) out.push({ tool, source: rel, include: globs, pkgDir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' });
  }
  const pj = path.join(repoPath, 'package.json');
  try {
    const j = JSON.parse(fs.readFileSync(pj, 'utf8')) as { jest?: { testMatch?: string[] } };
    if (j.jest?.testMatch?.length) out.push({ tool: 'jest', source: 'package.json#jest', include: j.jest.testMatch, pkgDir: '' });
  } catch {
    /* no package.json */
  }
  return out;
}

function tsconfigOptions(repoPath: string, chain: string[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const rel of [...chain].reverse()) {
    try {
      const j = parseJsonc<{ compilerOptions?: Record<string, unknown> }>(fs.readFileSync(path.resolve(repoPath, rel), 'utf8'));
      Object.assign(merged, j.compilerOptions ?? {});
    } catch {
      /* unreadable link in the chain */
    }
  }
  return merged;
}

export interface DeclaredResult {
  settings: DeclaredSetting[];
  effective: EffectiveConfigRun[];
  testRunners: TestRunnerDecl[];
}

/** Read every declared setting of one repository. */
export function collectDeclared(inv: RepoInventory, opts: { exec: boolean; timeoutMs?: number }): DeclaredResult {
  const repoPath = inv.repo.path;
  const repoId = inv.repo.id;
  const settings: DeclaredSetting[] = [];
  const effective: EffectiveConfigRun[] = [];
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pkgDirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

  // ESLint, static.
  const explicit = new Set<string>();
  for (const rel of inv.configs.eslint ?? []) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      continue;
    }
    for (const r of parseEslintConfigText(text, rel)) {
      if (!r.files) explicit.add(r.rule);
      settings.push({ repoId, source: `${rel}#L${r.line}`, tool: 'eslint', key: r.rule, value: r.options || undefined, severity: r.severity, via: 'static', explicit: true, files: r.files, line: r.line, pkgDir: pkgDirOf(rel) });
    }
  }
  // Vite+ keeps lint rules and formatter options in vite.config / vitest.config (`lint.rules`, `fmt`).
  for (const rel of (inv.configs.vitest ?? []).filter((f) => /(^|\/)vite(st)?\.config\.[cm]?[jt]s$/.test(f))) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      continue;
    }
    const v = parseViteConfigText(text);
    for (const r of v.rules) {
      if (!r.files) explicit.add(r.rule);
      settings.push({ repoId, source: `${rel}#L${r.line}`, tool: 'eslint', key: r.rule, value: r.options || undefined, severity: r.severity, via: 'static', explicit: true, files: r.files, line: r.line, pkgDir: pkgDirOf(rel) });
    }
    for (const [k, val] of Object.entries(v.fmt)) settings.push({ repoId, source: rel, tool: 'prettier', key: k, value: val, via: 'static', explicit: true, pkgDir: pkgDirOf(rel) });
  }
  // ESLint, resolved per sampled file.
  const eslintBin = opts.exec && (inv.configs.eslint ?? []).length ? resolveRepoBin(repoPath, 'eslint', 'eslint') : null;
  if ((inv.configs.eslint ?? []).length) {
    if (!opts.exec) effective.push({ repoId, tool: 'eslint', file: '-', ok: false, note: 'not run (--no-exec)' });
    else if (!eslintBin) effective.push({ repoId, tool: 'eslint', file: '-', ok: false, note: 'eslint not installed in the repository (node_modules absent); config read statically' });
    else {
      for (const f of sampleFiles(inv.files)) {
        const r = run(process.execPath, [eslintBin, '--print-config', f.rel], { cwd: repoPath, timeoutMs });
        if (r.code !== 0) {
          effective.push({ repoId, tool: 'eslint', file: f.rel, ok: false, note: r.timedOut ? 'timed out' : `exit ${r.code}: ${r.stderr.trim().split('\n')[0]?.slice(0, 160) ?? ''}` });
          continue;
        }
        try {
          const cfg = JSON.parse(r.stdout) as { rules?: Record<string, unknown> };
          let n = 0;
          for (const [rule, v] of Object.entries(cfg.rules ?? {})) {
            const sev = normSeverity(Array.isArray(v) ? v[0] : v);
            if (!sev || sev === 'off') continue;
            n++;
            settings.push({ repoId, source: `eslint --print-config ${f.rel}`, tool: 'eslint', key: rule, value: Array.isArray(v) && v.length > 1 ? JSON.stringify(v.slice(1)) : undefined, severity: sev, via: 'resolved', explicit: explicit.has(rule), files: [f.rel], pkgDir: '' });
          }
          effective.push({ repoId, tool: 'eslint', file: f.rel, ok: true, note: `${n} rules on` });
        } catch {
          effective.push({ repoId, tool: 'eslint', file: f.rel, ok: false, note: 'output was not JSON' });
        }
      }
    }
  }

  // Prettier: the root config, then package-level configs.
  for (const rel of inv.configs.prettier ?? []) {
    const cfg = readPrettier(repoPath, rel);
    if (!cfg) continue;
    for (const [k, v] of Object.entries(cfg)) settings.push({ repoId, source: rel, tool: 'prettier', key: k, value: v, via: 'static', explicit: true, pkgDir: pkgDirOf(rel) });
  }
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')) as { prettier?: unknown; commitlint?: unknown };
    if (pj.prettier && typeof pj.prettier === 'object') {
      for (const [k, v] of Object.entries(pj.prettier as Record<string, unknown>)) settings.push({ repoId, source: 'package.json#prettier', tool: 'prettier', key: k, value: v, via: 'static', explicit: true, pkgDir: '' });
    }
    if (pj.commitlint) settings.push({ repoId, source: 'package.json#commitlint', tool: 'commitlint', key: 'extends', value: JSON.stringify(pj.commitlint), via: 'static', explicit: true });
  } catch {
    /* no package.json */
  }

  // Biome.
  for (const rel of inv.configs.biome ?? []) {
    try {
      const b = parseJsonc<Record<string, any>>(fs.readFileSync(path.join(repoPath, rel), 'utf8'));
      const q = b?.javascript?.formatter?.quoteStyle;
      if (q) settings.push({ repoId, source: rel, tool: 'biome', key: 'javascript.formatter.quoteStyle', value: q, via: 'static', explicit: true, pkgDir: pkgDirOf(rel) });
      const s = b?.javascript?.formatter?.semicolons;
      if (s) settings.push({ repoId, source: rel, tool: 'biome', key: 'javascript.formatter.semicolons', value: s, via: 'static', explicit: true, pkgDir: pkgDirOf(rel) });
      const is = b?.formatter?.indentStyle;
      if (is) settings.push({ repoId, source: rel, tool: 'biome', key: 'formatter.indentStyle', value: is, via: 'static', explicit: true, pkgDir: pkgDirOf(rel) });
    } catch {
      /* unreadable */
    }
  }

  // EditorConfig (properties that apply to a .ts file).
  for (const rel of inv.configs.editorconfig ?? []) {
    try {
      const props = editorconfigFor(fs.readFileSync(path.join(repoPath, rel), 'utf8'), 'x.ts');
      for (const [k, v] of Object.entries(props)) settings.push({ repoId, source: rel, tool: 'editorconfig', key: k, value: v, via: 'static', explicit: true, pkgDir: pkgDirOf(rel) });
    } catch {
      /* unreadable */
    }
  }

  // tsconfig: strict and friends, through the extends chain.
  const tscBin = opts.exec ? resolveRepoBin(repoPath, 'typescript', 'tsc') : null;
  for (const t of inv.tsconfigChains) {
    let opts2 = tsconfigOptions(repoPath, t.chain);
    let via: DeclaredSetting['via'] = 'static';
    if (tscBin && t.file === (inv.configs.tsconfig ?? [])[0]) {
      const r = run(process.execPath, [tscBin, '--showConfig', '-p', t.file], { cwd: repoPath, timeoutMs });
      if (r.code === 0) {
        try {
          const shown = JSON.parse(r.stdout) as { compilerOptions?: Record<string, unknown> };
          opts2 = { ...opts2, ...(shown.compilerOptions ?? {}) };
          via = 'resolved';
          effective.push({ repoId, tool: 'tsc', file: t.file, ok: true, note: 'tsc --showConfig' });
        } catch {
          effective.push({ repoId, tool: 'tsc', file: t.file, ok: false, note: 'output was not JSON' });
        }
      } else effective.push({ repoId, tool: 'tsc', file: t.file, ok: false, note: r.timedOut ? 'timed out' : `exit ${r.code}` });
    }
    for (const k of ['strict', 'noImplicitAny', 'strictNullChecks', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
      if (opts2[k] !== undefined) settings.push({ repoId, source: t.chain.join(' -> '), tool: 'tsconfig', key: k, value: opts2[k], via, explicit: true, pkgDir: pkgDirOf(t.file) });
    }
  }
  if ((inv.configs.tsconfig ?? []).length && opts.exec && !tscBin) effective.push({ repoId, tool: 'tsc', file: '-', ok: false, note: 'typescript not installed in the repository; tsconfig chain read statically' });

  // Test runners.
  const testRunners = testRunnerIncludes(repoPath, inv);
  for (const t of testRunners) settings.push({ repoId, source: t.source, tool: 'test-runner', key: `${t.tool}.include`, value: t.include, via: 'static', explicit: true, pkgDir: t.pkgDir });

  // commitlint and husky.
  for (const rel of inv.configs.commitlint ?? []) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      /* unreadable */
    }
    settings.push({ repoId, source: rel, tool: 'commitlint', key: 'extends', value: /config-conventional/.test(text) ? 'conventional' : 'custom', via: 'static', explicit: true });
  }
  for (const rel of inv.configs.husky ?? []) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      continue;
    }
    settings.push({ repoId, source: rel, tool: 'hook', key: path.posix.basename(rel), value: text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' && ').slice(0, 200), via: 'static', explicit: true });
  }

  // CI: the scripts each workflow runs.
  for (const wf of inv.ci) {
    for (const s of wf.scripts) settings.push({ repoId, source: wf.file, tool: 'ci', key: 'runs', value: s, via: 'static', explicit: true });
  }
  return { settings, effective, testRunners };
}
