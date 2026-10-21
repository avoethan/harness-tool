/**
 * Runnable checks for ledger records, and the runner the gate and the
 * PostToolUse hook call:
 *
 *   runLedgerChecks(ledger, files, { mode }) -> Violation[]
 *
 * Each record has one spec at ~/.harness/ledger/checks/<id>.json (engine,
 * scope, the violating patterns, a baseline of violations that already
 * existed when discovery ran) and, for ast-grep checks, a runnable rule file
 * <id>.yml. The runner is file-scoped and fast: regex and built-in checks run
 * in process; ast-grep checks run as one `ast-grep scan` over the given files.
 * It never runs repository code. ESLint-only records (no equivalent probe)
 * run the repository's own ESLint on the files only when `eslint: true`
 * (the gate); the hook leaves them to its own lint step.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckMode, Ledger, LedgerRecord } from '../types';
import { harnessHome } from '../lib/paths';
import { repoIdFor } from '../lib/config';
import { nearestRepoRoot } from '../lib/git';
import { run } from '../lib/exec';
import { stringifyYaml } from './yaml';
import { compileAstRules } from './probes';
import { findAstGrep, scanRulesSync, type AstGrepBinary } from './astgrep';
import { inScope, matchAny } from './glob';
import { ddlGuards, maskNonCode, parseImports, packageNameOf, resolveRelative } from './builtins';
import { cleanSnippet } from './scan';
import type { ProbeSpec } from './model';
import { baselineKey } from './tiers';
import { resolveRepoBin } from './declared';

export type CheckEngine = 'ast-grep' | 'regex' | 'builtin' | 'eslint' | 'config' | 'judgment' | 'subjects';

export interface CheckSpec {
  version: 1;
  id: string;
  engine: CheckEngine;
  mode: CheckMode;
  statement: string;
  fixText?: string;
  scope: { repos: string[]; paths?: string[] };
  /** Include and exclude globs, relative to the repository root. */
  files?: string[];
  exclude?: string[];
  /** ast-grep: rules whose matches are violations (also written as <id>.yml). */
  rules?: Array<Record<string, unknown>>;
  /** regex: what the conforming target looks like, and what is matched. */
  target?: 'basename' | 'dirname' | 'content' | 'match';
  conform?: string;
  violate?: string[];
  flags?: string;
  /** builtin: implementation name and its data. */
  builtin?: string;
  data?: Record<string, unknown>;
  /** eslint: the rule (and fragment) the record stands for. */
  eslint?: { rule: string; fragment: Record<string, unknown> };
  /** Existing violations (`<workspace-relative file>::<snippet>`); only new ones are reported. */
  baseline?: string[];
  /** Why the runner does not check this record file by file (config, judgment). */
  note?: string;
}

export interface Violation {
  recordId: string;
  file: string;
  line: number;
  message: string;
  fixText?: string;
  mode: CheckMode;
  snippet?: string;
}

export interface CheckRunResult {
  violations: Violation[];
  checked: string[];
  skipped: Array<{ recordId: string; reason: string }>;
  durationMs: number;
}

export interface RunOptions {
  /** Which records: block-mode, warn-mode, or both (default both). */
  mode?: 'block' | 'warn' | 'all';
  checksDir?: string;
  /** Treat every file as belonging to this repository root (fixtures, tests). */
  repoRoot?: string;
  /** Ignore record scopes (fixtures, tests). */
  ignoreScope?: boolean;
  /** Run ESLint-only records through the repository's own ESLint (slow; the gate). */
  eslint?: boolean;
  astGrep?: AstGrepBinary | null;
  timeoutMs?: number;
  /**
   * Ignore each spec's stored `baseline`, so every matching site is reported.
   * The gate uses this to derive the baseline from the base commit instead of
   * trusting a baseline that a mid-task `harness discover` could have rewritten.
   */
  ignoreBaseline?: boolean;
}

export function checksDir(): string {
  return path.join(harnessHome(), 'ledger', 'checks');
}

// ---------------------------------------------------------------------------
// Spec building (discover writes these)
// ---------------------------------------------------------------------------

export interface SpecInput {
  record: LedgerRecord;
  probe?: ProbeSpec;
  variant?: string;
  others?: string[];
  data: Record<string, unknown>;
  offFiles?: string[];
  eslintRule?: string;
  baseline?: string[];
}

export function buildCheckSpec(i: SpecInput): CheckSpec {
  const r = i.record;
  const base: CheckSpec = { version: 1, id: r.id, engine: 'judgment', mode: r.check.mode, statement: r.statement, fixText: r.check.fixText, scope: r.scope };
  if (i.baseline?.length) base.baseline = i.baseline;
  const eslint = i.eslintRule ? { rule: i.eslintRule, fragment: { rules: { [i.eslintRule]: [r.check.mode === 'warn' ? 'warn' : 'error'] } } } : undefined;
  if (eslint) base.eslint = eslint;
  const p = i.probe;
  if (!p) {
    if (r.check.type === 'eslint') return { ...base, engine: 'eslint' };
    if (r.check.type === 'judgment') return { ...base, engine: 'judgment', note: 'judgment check: the agent reviews the change against the statement; never blocking' };
    return { ...base, engine: 'config', note: "enforced by the repository's own command (formatter, typecheck or CI); the gate runs it" };
  }
  base.files = p.files;
  base.exclude = [...(p.exclude ?? []), ...(i.offFiles ?? [])];
  if (p.formatterOwned || p.check.type === 'config' && p.engine !== 'builtin') return { ...base, engine: 'config', note: "enforced by the repository's formatter" };
  const others = i.others ?? [];
  if (p.engine === 'ast-grep') {
    const violating: ProbeSpec = { ...p, variants: p.variants.filter((v) => others.includes(v.name)) };
    return { ...base, engine: 'ast-grep', rules: compileAstRules(violating) };
  }
  const chosen = p.variants.find((v) => v.name === i.variant);
  if (p.engine === 'filename') return { ...base, engine: 'regex', target: 'basename', conform: chosen?.pattern, flags: chosen?.flags };
  if (p.engine === 'path') return { ...base, engine: 'regex', target: 'dirname', conform: chosen?.pattern, flags: chosen?.flags };
  if (p.engine === 'content') {
    const unit = String(p.params?.unit ?? 'file');
    const violate = p.variants.filter((v) => others.includes(v.name) && v.pattern).map((v) => v.pattern!);
    return { ...base, engine: 'regex', target: unit === 'match' ? 'match' : 'content', conform: chosen?.pattern, violate, flags: chosen?.flags };
  }
  if (p.engine === 'subjects') return { ...base, engine: 'subjects', conform: chosen?.pattern, flags: chosen?.flags, data: { maxLength: Number((i.data.params as Record<string, string> | undefined)?.MAXLEN ?? 0) || undefined } };
  if (p.engine === 'builtin') {
    if (p.builtin === 'ci-scripts' || p.builtin === 'import-shape') return { ...base, engine: 'config', note: 'not file-scoped; the gate mirrors the CI steps' };
    return { ...base, engine: 'builtin', builtin: p.builtin, data: { ...i.data, variant: i.variant } };
  }
  return base;
}

/** Write a spec (and the ast-grep rule file next to it). */
export function writeCheckSpec(dir: string, spec: CheckSpec, write: (p: string, text: string) => void): string[] {
  const out: string[] = [];
  const json = path.join(dir, `${spec.id}.json`);
  write(json, JSON.stringify(spec, null, 2) + '\n');
  out.push(json);
  if (spec.engine === 'ast-grep' && spec.rules?.length) {
    const yml = path.join(dir, `${spec.id}.yml`);
    write(yml, spec.rules.map((r) => stringifyYaml({ ...r, message: spec.statement, note: spec.fixText })).join('---\n'));
    out.push(yml);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** `learned/<file>.json`: a check the learning loop wrote under checks/learned/ (src/learn/learned.ts). */
const LEARNED_REF_RE = /^learned\/[A-Za-z0-9][\w.-]*\.json$/;

function loadSpec(dir: string, r: LedgerRecord): CheckSpec | null {
  const ref = r.check.ref && LEARNED_REF_RE.test(r.check.ref) ? r.check.ref : r.check.ref ? path.basename(r.check.ref) : `${r.id}.json`;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ref), 'utf8')) as CheckSpec;
  } catch {
    return null;
  }
}

interface FileCtx {
  abs: string;
  repoRoot: string;
  repoId: string;
  /** Relative to the repository root, forward slashes. */
  rel: string;
  /** Relative to the ledger's workspace root (baseline keys). */
  display: string;
  text?: string;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

function pkgRootOf(ctx: FileCtx): string {
  let dir = path.dirname(ctx.abs);
  while (dir.startsWith(ctx.repoRoot)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return path.relative(ctx.repoRoot, dir).split(path.sep).join('/');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

function readText(ctx: FileCtx): string {
  if (ctx.text === undefined) {
    try {
      ctx.text = fs.readFileSync(ctx.abs, 'utf8');
    } catch {
      ctx.text = '';
    }
  }
  return ctx.text;
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MODULE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IS_TEST = /(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

function existsAny(base: string, exts: string[]): boolean {
  return exts.some((e) => fs.existsSync(base + e));
}

function runBuiltinCheck(spec: CheckSpec, ctx: FileCtx): Array<{ line: number; message?: string; snippet?: string }> {
  const d = spec.data ?? {};
  const pkg = pkgRootOf(ctx);
  const inPkg = pkg ? ctx.rel.slice(pkg.length + 1) : ctx.rel;
  const out: Array<{ line: number; message?: string; snippet?: string }> = [];
  switch (spec.builtin) {
    case 'tests-per-module': {
      if (IS_TEST.test(ctx.rel) || !inPkg.startsWith('src/') || !MODULE_EXT.test(inPkg) || /\.d\.ts$/.test(inPkg)) return out;
      const noExt = inPkg.replace(MODULE_EXT, '');
      const baseName = noExt.split('/').pop()!;
      if (((d.exempt as string[]) ?? []).includes(baseName) || ((d.exemptPaths as string[]) ?? []).includes(noExt)) return out;
      const rest = noExt.slice('src/'.length);
      const root = String(d.testRoot ?? 'test');
      const suffix = String(d.suffix ?? 'test');
      const pkgAbs = path.join(ctx.repoRoot, pkg);
      const exts = ['.ts', '.tsx', '.js', '.mts', '.mjs'];
      const candidates = [path.join(pkgAbs, root, `${rest}.${suffix}`), path.join(pkgAbs, path.dirname(noExt), `${baseName}.${suffix}`), path.join(pkgAbs, path.dirname(noExt), '__tests__', `${baseName}.${suffix}`)];
      if (!candidates.some((c) => existsAny(c, exts))) out.push({ line: 1, snippet: inPkg, message: `no test for ${inPkg}: expected ${pkg ? pkg + '/' : ''}${root}/${rest}.${suffix}.ts` });
      return out;
    }
    case 'test-placement': {
      const name = path.posix.basename(ctx.rel);
      if (!TEST_FILE.test(name) || /\.e2e\./.test(name) || /(^|\/)e2e\//.test(inPkg)) return out;
      const variant = String(d.variant ?? 'mirror');
      const root = String(d.testRoot ?? 'test');
      const suffix = String(d.suffix ?? 'test');
      const sm = TEST_FILE.exec(name)!;
      const stem = name.replace(TEST_FILE, '');
      if (variant === 'mirror' || variant === 'separate') {
        if (!inPkg.startsWith(root + '/')) {
          out.push({ line: 1, snippet: inPkg, message: `test file outside ${root}/: put it at ${pkg ? pkg + '/' : ''}${root}/<path under src>.${suffix}.ts` });
          return out;
        }
        if (sm[1] !== suffix) out.push({ line: 1, snippet: inPkg, message: `test file named .${sm[1]}.; this codebase uses .${suffix}.` });
        if (variant === 'mirror') {
          const rest = path.posix.dirname(inPkg.slice(root.length + 1));
          const target = path.join(ctx.repoRoot, pkg, 'src', rest === '.' ? '' : rest, stem);
          if (!existsAny(target, ['.ts', '.tsx', '.js', '.mts', '.mjs'])) out.push({ line: 1, snippet: inPkg, message: `test does not mirror a module: no src/${rest === '.' ? '' : rest + '/'}${stem}.ts` });
        }
      } else if (variant === 'colocated') {
        if (!existsAny(path.join(path.dirname(ctx.abs), stem), ['.ts', '.tsx', '.js'])) out.push({ line: 1, snippet: inPkg, message: 'test is not next to the module it tests' });
      } else if (variant === 'dunder' && !/(^|\/)__tests__\//.test(inPkg)) out.push({ line: 1, snippet: inPkg, message: 'test is not in a __tests__/ folder' });
      return out;
    }
    case 'import-gateway': {
      if (IS_TEST.test(ctx.rel)) return out;
      const driver = String(d.driver ?? '');
      const gateways = (d.gateways as string[]) ?? [];
      if (gateways.includes(inPkg)) return out;
      for (const i of parseImports(readText(ctx))) {
        if (!i.typeOnly && packageNameOf(i.spec) === driver) out.push({ line: i.line, snippet: `import from '${driver}'` });
      }
      return out;
    }
    case 'single-accessor': {
      if (IS_TEST.test(ctx.rel) || !/(^|\/)src\//.test(ctx.rel) || /\.config\.[cm]?[jt]s$/.test(ctx.rel)) return out;
      const gateways = (d.gateways as string[]) ?? [];
      if (gateways.includes(inPkg)) return out;
      const re = new RegExp(String(d.pattern ?? '\\bprocess\\.env\\b'), 'g');
      const raw = readText(ctx);
      const text = maskNonCode(raw);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ line, snippet: cleanSnippet(lines(raw)[line - 1]) });
        break;
      }
      return out;
    }
    case 'sql-ddl-guards': {
      if (!/\.sql$/i.test(ctx.rel)) return out;
      for (const g of ddlGuards(readText(ctx))) if (!g.guarded) out.push({ line: g.line, snippet: g.statement, message: `${g.statement} is not guarded` });
      return out;
    }
    case 'workspace-imports': {
      const pkgs = ((d.packages as Array<{ repo: string; name: string; dir: string }>) ?? []).filter((x) => x.repo === ctx.repoId || !ctx.repoId);
      const own = pkgs.find((x) => ctx.rel.startsWith(x.dir + '/'));
      if (!own) return out;
      for (const i of parseImports(readText(ctx))) {
        if (!i.spec.startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(ctx.rel), i.spec));
        const into = pkgs.find((x) => x !== own && (target === x.dir || target.startsWith(x.dir + '/')));
        if (into) out.push({ line: i.line, snippet: `from '${i.spec}'`, message: `import ${into.name} by its package name, not '${i.spec}'` });
      }
      return out;
    }
    case 'barrel-imports': {
      const variant = String(d.variant ?? 'direct');
      for (const i of parseImports(readText(ctx))) {
        const r = resolveRelative(ctx.repoRoot, ctx.rel, i.spec);
        if (!r) continue;
        if ((variant === 'direct' && r.barrel) || (variant === 'barrel' && !r.barrel)) out.push({ line: i.line, snippet: `from '${i.spec}'` });
      }
      return out;
    }
    default:
      return out;
  }
}

function runRegexCheck(spec: CheckSpec, ctx: FileCtx): Array<{ line: number; snippet?: string }> {
  const out: Array<{ line: number; snippet?: string }> = [];
  const flags = spec.flags ?? '';
  if (spec.target === 'basename') {
    const name = path.posix.basename(ctx.rel);
    if (spec.conform && !new RegExp(spec.conform, flags).test(name)) out.push({ line: 1, snippet: name });
    return out;
  }
  if (spec.target === 'dirname') {
    const parts = ctx.rel.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      const n = parts[i];
      if (n.startsWith('.') || /^__\w+__$/.test(n)) continue;
      if (spec.conform && !new RegExp(spec.conform, flags).test(n)) out.push({ line: 1, snippet: parts.slice(0, i + 1).join('/') + '/' });
    }
    return out;
  }
  const text = readText(ctx);
  if (spec.target === 'content') {
    if (spec.conform && new RegExp(spec.conform, flags).test(text)) return out;
    for (const v of spec.violate ?? []) {
      const m = new RegExp(v, flags).exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ line, snippet: (lines(text)[line - 1] ?? '').slice(0, 120) });
        break;
      }
    }
    return out;
  }
  if (spec.target === 'match') {
    for (const v of spec.violate ?? []) {
      const re = new RegExp(v, flags.includes('g') ? flags : flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ line, snippet: lines(text)[line - 1] });
        if (!m[0].length) re.lastIndex++;
      }
    }
  }
  return out;
}

function fileCtx(abs: string, ledger: Ledger, opts: RunOptions): FileCtx | null {
  const a = path.resolve(abs);
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : nearestRepoRoot(a);
  if (!repoRoot) return null;
  const rel = path.relative(repoRoot, a).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  const ws = ledger.workspaceRoot ? path.resolve(ledger.workspaceRoot) : repoRoot;
  const display = path.relative(ws, a).split(path.sep).join('/');
  return { abs: a, repoRoot, repoId: opts.repoRoot && opts.ignoreScope ? '' : repoIdFor(repoRoot), rel, display: display.startsWith('..') ? rel : display };
}

function inRecordScope(r: LedgerRecord, ctx: FileCtx, opts: RunOptions): boolean {
  if (opts.ignoreScope) return true;
  return recordAppliesTo(r, ctx.repoId, ctx.rel);
}

/** Whether a record's scope covers a file (repository id + path relative to its root). */
export function recordAppliesTo(r: Pick<LedgerRecord, 'scope'>, repoId: string, rel: string): boolean {
  const ctx = { repoId, rel };
  if (!r.scope.repos.includes('*') && !r.scope.repos.includes(ctx.repoId)) return false;
  const paths = r.scope.paths ?? [];
  if (!paths.length) return true;
  // Repository-qualified globs (`<repoId>:<glob>`) apply to that repository only; plain globs to every repository in scope.
  const qualified = paths.filter((p) => /^[^/*:]+:/.test(p));
  const mine = qualified.filter((p) => p.startsWith(ctx.repoId + ':')).map((p) => p.slice(ctx.repoId.length + 1));
  const plain = paths.filter((p) => !qualified.includes(p));
  if (mine.length) return matchAny(ctx.rel, mine);
  if (plain.length) return matchAny(ctx.rel, plain);
  return qualified.length === 0 || !qualified.some((p) => p.startsWith(ctx.repoId + ':'));
}

/** Run the ledger's file-scoped checks on `files`; detailed result. */
export function runLedgerChecksDetailed(ledger: Ledger, files: string[], opts: RunOptions = {}): CheckRunResult {
  const start = Date.now();
  const dir = opts.checksDir ?? checksDir();
  const want = opts.mode ?? 'all';
  const records = ledger.records.filter((r) => (want === 'all' ? r.check.mode !== 'judgment' : r.check.mode === want));
  const violations: Violation[] = [];
  const checked = new Set<string>();
  const skipped: CheckRunResult['skipped'] = [];
  const ctxs = files.map((f) => fileCtx(f, ledger, opts)).filter((c): c is FileCtx => !!c);
  const astJobs: Array<{ spec: CheckSpec; r: LedgerRecord; files: FileCtx[] }> = [];
  const eslintJobs: Array<{ spec: CheckSpec; r: LedgerRecord; files: FileCtx[] }> = [];
  const report = (r: LedgerRecord, spec: CheckSpec, ctx: FileCtx, hits: Array<{ line: number; message?: string; snippet?: string }>) => {
    const base = new Set(opts.ignoreBaseline ? [] : spec.baseline ?? []);
    for (const h of hits) {
      const snip = cleanSnippet(h.snippet);
      if (base.has(baselineKey(ctx.display, snip))) continue;
      violations.push({ recordId: r.id, file: ctx.abs, line: h.line, message: h.message ? `${r.statement} (${h.message})` : r.statement, fixText: r.check.fixText, mode: r.check.mode, snippet: snip });
    }
  };
  for (const r of records) {
    const spec = loadSpec(dir, r);
    if (!spec) {
      skipped.push({ recordId: r.id, reason: 'no check spec on disk (run harness discover)' });
      continue;
    }
    if (spec.engine === 'config' || spec.engine === 'judgment' || spec.engine === 'subjects') {
      skipped.push({ recordId: r.id, reason: spec.engine === 'subjects' ? 'commit-subject check (checkCommitSubjects)' : spec.note ?? spec.engine });
      continue;
    }
    const mine = ctxs.filter((c) => inRecordScope(r, c, opts) && inScope(c.rel, spec.files, spec.exclude));
    if (!mine.length) continue;
    if (spec.engine === 'ast-grep') {
      astJobs.push({ spec, r, files: mine });
      continue;
    }
    if (spec.engine === 'eslint') {
      if (opts.eslint) eslintJobs.push({ spec, r, files: mine });
      else skipped.push({ recordId: r.id, reason: "ESLint-only rule: covered by the repository's lint step" });
      continue;
    }
    checked.add(r.id);
    for (const c of mine) report(r, spec, c, spec.engine === 'builtin' ? runBuiltinCheck(spec, c) : runRegexCheck(spec, c));
  }
  if (astJobs.length) {
    const bin = opts.astGrep === undefined ? findAstGrep() : opts.astGrep;
    if (!bin) for (const j of astJobs) skipped.push({ recordId: j.r.id, reason: 'ast-grep not found' });
    else {
      const rules: Array<Record<string, unknown>> = [];
      const owner = new Map<string, { spec: CheckSpec; r: LedgerRecord; files: Set<string> }>();
      astJobs.forEach((j, n) => {
        for (const rule of j.spec.rules ?? []) {
          const id = `c${n}:${String(rule.id)}`;
          rules.push({ ...rule, id });
          owner.set(id, { spec: j.spec, r: j.r, files: new Set(j.files.map((f) => f.abs)) });
        }
      });
      const allFiles = [...new Set(astJobs.flatMap((j) => j.files.map((f) => f.abs)))];
      const res = scanRulesSync(bin, rules, allFiles, opts.timeoutMs ?? 15000);
      if (!res.ok) for (const j of astJobs) skipped.push({ recordId: j.r.id, reason: `ast-grep failed: ${res.error}` });
      else {
        for (const j of astJobs) checked.add(j.r.id);
        for (const m of res.matches) {
          const o = owner.get(m.ruleId);
          const abs = path.resolve(m.file);
          if (!o || !o.files.has(abs)) continue;
          const c = ctxs.find((x) => x.abs === abs)!;
          report(o.r, o.spec, c, [{ line: m.line + 1, snippet: m.lines.split('\n')[0] }]);
        }
      }
    }
  }
  for (const j of eslintJobs) {
    const root = j.files[0].repoRoot;
    const bin = resolveRepoBin(root, 'eslint', 'eslint');
    if (!bin) {
      skipped.push({ recordId: j.r.id, reason: 'eslint not installed in the repository' });
      continue;
    }
    const r = run(process.execPath, [bin, '--format', 'json', ...j.files.map((f) => f.rel)], { cwd: root, timeoutMs: opts.timeoutMs ?? 30000 });
    try {
      const out = JSON.parse(r.stdout) as Array<{ filePath: string; messages: Array<{ ruleId: string | null; line: number; message: string }> }>;
      checked.add(j.r.id);
      for (const f of out) {
        const c = j.files.find((x) => x.abs === path.resolve(f.filePath));
        if (!c) continue;
        report(j.r, j.spec, c, f.messages.filter((m) => m.ruleId === j.spec.eslint?.rule).map((m) => ({ line: m.line, message: m.message, snippet: cleanSnippet(lines(readText(c))[m.line - 1]) })));
      }
    } catch {
      skipped.push({ recordId: j.r.id, reason: `eslint did not return JSON (exit ${r.code})` });
    }
  }
  return { violations, checked: [...checked], skipped, durationMs: Date.now() - start };
}

/** Run the ledger's file-scoped checks on `files` and return the violations. */
export function runLedgerChecks(ledger: Ledger, files: string[], opts: RunOptions = {}): Violation[] {
  return runLedgerChecksDetailed(ledger, files, opts).violations;
}

/** Check commit subjects against the ledger's commit-subject records. */
export function checkCommitSubjects(ledger: Ledger, subjects: string[], opts: { checksDir?: string; repoId?: string } = {}): Violation[] {
  const dir = opts.checksDir ?? checksDir();
  const out: Violation[] = [];
  for (const r of ledger.records) {
    if (opts.repoId && !r.scope.repos.includes('*') && !r.scope.repos.includes(opts.repoId)) continue;
    const spec = loadSpec(dir, r);
    if (!spec || spec.engine !== 'subjects' || !spec.conform) continue;
    const re = new RegExp(spec.conform, spec.flags ?? '');
    const max = Number(spec.data?.maxLength ?? 0);
    for (const s of subjects) {
      const problems: string[] = [];
      if (!re.test(s)) problems.push('does not follow the convention');
      if (max && s.length > max) problems.push(`longer than ${max} characters`);
      if (problems.length) out.push({ recordId: r.id, file: '(commit subject)', line: 0, message: `${r.statement} (${problems.join('; ')})`, fixText: r.check.fixText, mode: r.check.mode, snippet: cleanSnippet(s) });
    }
  }
  return out;
}
