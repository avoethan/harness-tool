/**
 * Built-in probes: conventions that need more than one node or one file to
 * count (test placement, a test per module, single importers of a driver,
 * re-runnable migrations, cross-package imports, CI coverage of scripts).
 * Each returns sites with the variants they follow, like the other engines,
 * plus the parameters the statement and the runnable check need.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProbeSpec, ScannedFile } from './model';
import type { RepoInventory, WorkspaceInventory } from './inventory';
import type { DeclaredResult } from './declared';
import { inScope, matchGlob } from './glob';

export interface BuiltinSite {
  file: ScannedFile;
  line: number;
  key: string;
  variants: string[];
  snippet?: string;
}

export interface BuiltinOutput {
  /** Suffix of the record id (`layout.driver-gateway-mssql`); empty for the probe itself. */
  sub: string;
  sites: BuiltinSite[];
  /** Statement placeholders ({GATEWAY}, {TESTROOT}, ...). */
  params: Record<string, string>;
  /** Data the runnable check needs. */
  check: Record<string, unknown>;
}

export interface BuiltinContext {
  ws: WorkspaceInventory;
  declared: Map<string, DeclaredResult>;
}

const textCache = new Map<string, string>();
export function readCached(abs: string): string {
  let t = textCache.get(abs);
  if (t === undefined) {
    try {
      t = fs.readFileSync(abs, 'utf8');
    } catch {
      t = '';
    }
    textCache.set(abs, t);
  }
  return t;
}
export function clearTextCache(): void {
  textCache.clear();
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ImportRef {
  spec: string;
  line: number;
  typeOnly: boolean;
}

const IMPORT_RES: RegExp[] = [
  /(?:^|\n)[ \t]*import\s+(type\s+)?[^'";]*?\bfrom\s*(['"])([^'"\n]+)\2/g,
  /(?:^|\n)[ \t]*import\s*(['"])([^'"\n]+)\1/g,
  /(?:^|\n)[ \t]*export\s+(type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*(['"])([^'"\n]+)\2/g,
  /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/**
 * The text with comments and template-literal text blanked out (same length, newlines kept), so
 * imports and accessor reads are taken from code only: a JSDoc line such as "defaults to
 * `require("mssql")`" or a code generator's template (`import { X } from "pkg"` inside backticks)
 * is not an import. Quoted strings stay (module specifiers live in them); `${...}` stays code.
 */
export function maskNonCode(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const n = text.length;
  const holes: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let inTemplate = false;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (inTemplate) {
      if (c === '\\') {
        blank(i, Math.min(i + 2, n));
        i += 2;
      } else if (c === '`') {
        inTemplate = false;
        i++;
      } else if (c === '$' && text[i + 1] === '{') {
        holes.push(depth++);
        inTemplate = false;
        i += 2;
      } else {
        blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
      i = k + 1;
    } else if (c === '`') {
      inTemplate = true;
      i++;
    } else {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (holes.length && holes[holes.length - 1] === depth) {
          holes.pop();
          inTemplate = true;
        }
      }
      i++;
    }
  }
  return out.join('');
}

/** Module specifiers a TS/JS file imports, with their 1-based lines (code only; see maskNonCode). */
export function parseImports(raw: string): ImportRef[] {
  const text = maskNonCode(raw);
  const out: ImportRef[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < IMPORT_RES.length; k++) {
    const re = new RegExp(IMPORT_RES[k].source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = k === 0 || k === 2 ? m[3] : m[2];
      const typeOnly = (k === 0 || k === 2) && !!m[1];
      const at = m.index + m[0].indexOf(spec);
      const key = `${at}:${spec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ spec, line: text.slice(0, at).split('\n').length, typeOnly });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const importCache = new Map<string, ImportRef[]>();
export function importsOf(f: ScannedFile): ImportRef[] {
  let r = importCache.get(f.abs);
  if (!r) {
    r = parseImports(readCached(f.abs));
    importCache.set(f.abs, r);
  }
  return r;
}

/** Bare package name of a specifier (`@scope/pkg/x` -> `@scope/pkg`). */
export function packageNameOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolve a relative specifier to a repo-relative file; `barrel` when it hit a folder index. */
export function resolveRelative(repoPath: string, fromRel: string, spec: string): { rel: string; barrel: boolean } | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
  const candidates: Array<[string, boolean]> = [];
  candidates.push([base, false]);
  for (const e of RESOLVE_EXT) candidates.push([stripped + e, false]);
  for (const e of RESOLVE_EXT) candidates.push([base + '/index' + e, true]);
  for (const [c, barrel] of candidates) {
    try {
      if (fs.statSync(path.join(repoPath, c)).isFile()) return { rel: c, barrel };
    } catch {
      /* next */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers over the inventory
// ---------------------------------------------------------------------------

function pkgDirOf(inv: RepoInventory, f: ScannedFile): string {
  const p = inv.repo.packages.find((x) => x.id === f.pkg);
  return p ? p.dir : '';
}

/** Path of a file relative to its package folder. */
function inPkg(inv: RepoInventory, f: ScannedFile): string {
  const d = pkgDirOf(inv, f);
  return d ? f.rel.slice(d.length + 1) : f.rel;
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const E2E_FILE = /\.e2e\.(test|spec)\.[cm]?[jt]sx?$|\.e2e\.[cm]?[jt]sx?$/;
const MODULE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function isConfigFile(rel: string): boolean {
  return /(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(rel) || /(^|\/)\.[^/]*rc\.[cm]?js$/.test(rel);
}

function dominant(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let n = -1;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// test-placement and tests-per-module
// ---------------------------------------------------------------------------

interface TestInfo {
  file: ScannedFile;
  inPkg: string;
  variant: 'mirror' | 'separate' | 'colocated' | 'dunder' | 'e2e';
  root: string;
  suffix: string;
  /** Module path (package-relative, under src/, without extension) the test mirrors. */
  target?: string;
}

function classifyTest(inv: RepoInventory, f: ScannedFile, srcFiles: Set<string>): TestInfo | null {
  const rel = inPkg(inv, f);
  const name = rel.split('/').pop()!;
  const sm = TEST_FILE.exec(name);
  const inDunder = /(^|\/)__tests__\//.test(rel);
  if (!sm && !inDunder) return null;
  const suffix = sm ? sm[1] : 'test';
  const stem = name.replace(TEST_FILE, '').replace(MODULE_EXT, '');
  if (inDunder) return { file: f, inPkg: rel, variant: 'dunder', root: '__tests__', suffix };
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  // End-to-end tests exercise the running service, not one module: their own kind.
  if (E2E_FILE.test(name) || /(^|\/)e2e(\/|$)/.test(dir)) return { file: f, inPkg: rel, variant: 'e2e', root: dir, suffix };
  const tm = /^((?:test|tests|spec|__test__)(?:\/(?:unit|units|integration|e2e))?)(?:\/(.*))?$/.exec(dir);
  if (tm) {
    const rest = tm[2] ? `${tm[2]}/${stem}` : stem;
    const target = `src/${rest}`;
    const exists = [...srcFiles].some((s) => s.replace(MODULE_EXT, '') === target);
    return { file: f, inPkg: rel, variant: exists ? 'mirror' : 'separate', root: tm[1], suffix, target: exists ? target : undefined };
  }
  const sibling = `${dir ? dir + '/' : ''}${stem}`;
  const exists = [...srcFiles].some((s) => s.replace(MODULE_EXT, '') === sibling);
  return { file: f, inPkg: rel, variant: exists || dir.startsWith('src') ? 'colocated' : 'separate', root: dir, suffix, target: exists ? sibling : undefined };
}

function packageSrc(inv: RepoInventory): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const f of inv.files) {
    if (f.kind !== 'code' || f.isTest || /\.d\.ts$/.test(f.rel)) continue;
    const r = inPkg(inv, f);
    if (!r.startsWith('src/')) continue;
    const s = m.get(f.pkg) ?? new Set<string>();
    s.add(r);
    m.set(f.pkg, s);
  }
  return m;
}

function allTests(ctx: BuiltinContext): TestInfo[] {
  const out: TestInfo[] = [];
  for (const inv of ctx.ws.repos) {
    const src = packageSrc(inv);
    for (const f of inv.files) {
      if (f.kind !== 'code' || !f.isTest) continue;
      const t = classifyTest(inv, f, src.get(f.pkg) ?? new Set());
      if (t) out.push(t);
    }
  }
  return out;
}

function testPlacement(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const tests = allTests(ctx);
  const roots = new Map<string, number>();
  const suffixes = new Map<string, number>();
  const e2eRoots = new Map<string, number>();
  const sites: BuiltinSite[] = [];
  for (const t of tests) {
    if (t.variant === 'e2e') {
      bump(e2eRoots, t.root);
      continue;
    }
    if (t.variant === 'mirror' || t.variant === 'separate') bump(roots, t.root);
    bump(suffixes, t.suffix);
    sites.push({ file: t.file, line: 1, key: t.file.abs, variants: [t.variant], snippet: t.inPkg });
  }
  const testRoot = dominant(roots) ?? 'test';
  const suffix = dominant(suffixes) ?? 'test';
  const e2eRoot = dominant(e2eRoots);
  const extra = e2eRoot ? ` End-to-end tests are separate: ${e2eRoot}/<name>.e2e.${suffix}.ts.` : '';
  // Declared: the test runner's include globs cover every test file of the repo.
  const declaredRepos: string[] = [];
  const declaredSources: string[] = [];
  for (const inv of ctx.ws.repos) {
    const d = ctx.declared.get(inv.repo.id);
    const globs = (d?.testRunners ?? []).flatMap((t) => t.include.map((g) => (t.pkgDir ? `${t.pkgDir}/${g}` : g)));
    const mine = tests.filter((t) => t.file.repoId === inv.repo.id);
    if (!globs.length || !mine.length) continue;
    if (mine.every((t) => globs.some((g) => matchGlob(t.file.rel, g.replace(/^\.\//, ''))))) {
      declaredRepos.push(inv.repo.id);
      for (const t of d!.testRunners) declaredSources.push(`${inv.repo.relPath === '.' ? '' : inv.repo.relPath + '/'}${t.source}: include ${t.include.join(', ')}`);
    }
  }
  return [
    {
      sub: '',
      sites,
      params: { TESTROOT: testRoot, SUFFIX: suffix, E2E: extra },
      check: { name: 'test-placement', testRoot, suffix, declaredRepos, declaredSources },
    },
  ];
}

const DEFAULT_EXEMPT = ['index', 'main', 'server', 'app', 'cli', 'types'];

function testsPerModule(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const tests = allTests(ctx);
  const roots = new Map<string, number>();
  const suffixes = new Map<string, number>();
  for (const t of tests) {
    if (t.variant === 'mirror' || t.variant === 'separate') bump(roots, t.root);
    bump(suffixes, t.suffix);
  }
  const testRoot = dominant(roots) ?? 'test';
  const suffix = dominant(suffixes) ?? 'test';
  const testedTargets = new Set(tests.filter((t) => t.target).map((t) => `${t.file.pkg}::${t.target}`));
  interface Mod {
    inv: RepoInventory;
    f: ScannedFile;
    rel: string;
    base: string;
    tested: boolean;
  }
  const mods: Mod[] = [];
  for (const inv of ctx.ws.repos) {
    for (const f of inv.files) {
      if (f.kind !== 'code' || f.isTest || /\.d\.ts$/.test(f.rel) || isConfigFile(f.rel)) continue;
      const rel = inPkg(inv, f);
      if (!rel.startsWith('src/')) continue;
      const noExt = rel.replace(MODULE_EXT, '');
      const base = noExt.split('/').pop()!;
      mods.push({ inv, f, rel, base, tested: testedTargets.has(`${f.pkg}::${noExt}`) });
    }
  }
  // Data-driven exemptions: a module name never tested anywhere, in at least two packages.
  const byBase = new Map<string, { pkgs: Set<string>; tested: number }>();
  for (const m of mods) {
    const e = byBase.get(m.base) ?? { pkgs: new Set<string>(), tested: 0 };
    e.pkgs.add(m.f.pkg);
    if (m.tested) e.tested++;
    byBase.set(m.base, e);
  }
  const exempt = new Set(DEFAULT_EXEMPT);
  for (const [b, e] of byBase) if (e.tested === 0 && e.pkgs.size >= 2) exempt.add(b);
  // Modules the tests mock and never test directly are adapters (a test seam such as src/db).
  const mocked = new Set<string>();
  for (const t of tests) {
    const text = readCached(t.file.abs);
    const re = /\b(?:vi|jest)\.(?:mock|doMock)\(\s*(['"])(\.{1,2}\/[^'"]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) mocked.add(`${t.file.repoId}::${path.posix.normalize(path.posix.join(path.posix.dirname(t.file.rel), m[2])).replace(MODULE_EXT, '')}`);
  }
  const exemptPaths = new Set<string>();
  for (const m of mods) if (!m.tested && mocked.has(`${m.f.repoId}::${m.f.rel.replace(MODULE_EXT, '')}`)) exemptPaths.add(m.rel.replace(MODULE_EXT, ''));
  const isExempt = (m: Mod) => exempt.has(m.base) || exemptPaths.has(m.rel.replace(MODULE_EXT, ''));
  const used = [...new Set([...[...exempt].filter((b) => byBase.has(b)), ...[...exemptPaths].map((x) => x.split('/').pop()!)])].sort();
  const sites: BuiltinSite[] = mods
    .filter((m) => !isExempt(m))
    .map((m) => ({ file: m.f, line: 1, key: m.f.abs, variants: [m.tested ? 'tested' : 'untested'], snippet: m.rel }));
  return [
    {
      sub: '',
      sites,
      params: { TESTROOT: testRoot, SUFFIX: suffix, EXEMPT: used.map((b) => `${b}.ts`).join(', ') || 'none' },
      check: { name: 'tests-per-module', testRoot, suffix, exempt: [...exempt].sort(), exemptPaths: [...exemptPaths].sort() },
    },
  ];
}

// ---------------------------------------------------------------------------
// import-gateway and single-accessor
// ---------------------------------------------------------------------------

function gatewayName(paths: string[]): string {
  const uniq = [...new Set(paths)];
  return uniq.length === 1 ? uniq[0] : uniq.join(' / ');
}

function importGateway(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  // A package of the workspace itself is never a driver to wall off (in an ORM's own repository, the ORM package is the code).
  const own = new Set(ctx.ws.repos.flatMap((inv) => inv.repo.packages.map((pkg) => pkg.name)));
  const drivers = (Array.isArray(p.params?.drivers) ? (p.params!.drivers as string[]) : []).map(String).filter((d) => !own.has(d));
  const outs: BuiltinOutput[] = [];
  for (const driver of drivers) {
    const sites: BuiltinSite[] = [];
    const gatewayPaths: string[] = [];
    const gatewayRepoPaths: string[] = [];
    let anyImporter = false;
    for (const inv of ctx.ws.repos) {
      for (const pkg of inv.repo.packages) {
        const modules = inv.files.filter((f) => f.pkg === pkg.id && f.kind === 'code' && !f.isTest && !isConfigFile(f.rel) && !/\.d\.ts$/.test(f.rel));
        const importers = modules.filter((f) => importsOf(f).some((i) => packageNameOf(i.spec) === driver && !i.typeOnly));
        const declares = pkg.deps.includes(driver) || pkg.devDeps.includes(driver);
        if (!importers.length && !declares) continue;
        if (importers.length) anyImporter = true;
        // The gateway: the importer whose package-relative path is most common across packages, else the first.
        const gw = importers.length ? importers.slice().sort((a, b) => inPkg(inv, a).length - inPkg(inv, b).length)[0] : null;
        if (gw) {
          gatewayPaths.push(inPkg(inv, gw));
          gatewayRepoPaths.push(`${inv.repo.relPath === '.' ? '' : inv.repo.relPath + '/'}${gw.rel}`);
        }
        for (const f of modules) {
          const imp = importsOf(f).find((i) => packageNameOf(i.spec) === driver && !i.typeOnly);
          const bypass = !!imp && f !== gw;
          sites.push({ file: f, line: imp ? imp.line : 1, key: f.abs, variants: [bypass ? 'bypass' : 'gateway'], snippet: imp ? `import from '${driver}'` : undefined });
        }
      }
    }
    if (!anyImporter) continue;
    const slug = driver.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    outs.push({
      sub: slug,
      sites,
      params: { DRIVER: driver, GATEWAY: gatewayName(gatewayPaths) },
      check: { name: 'import-gateway', driver, gateways: [...new Set(gatewayPaths)], gatewayFiles: gatewayRepoPaths },
    });
  }
  return outs;
}

function singleAccessor(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const pattern = new RegExp(String(p.params?.pattern ?? '\\bprocess\\.env\\b'));
  const sites: BuiltinSite[] = [];
  const gateways: string[] = [];
  let anyReader = false;
  for (const inv of ctx.ws.repos) {
    for (const pkg of inv.repo.packages) {
      const modules = inv.files.filter(
        (f) => f.pkg === pkg.id && f.kind === 'code' && !f.isTest && !isConfigFile(f.rel) && /(^|\/)src\//.test(f.rel) && !/\.d\.ts$/.test(f.rel),
      );
      const readers = modules.filter((f) => pattern.test(maskNonCode(readCached(f.abs))));
      if (!readers.length) continue;
      // A single accessor is at least half of the modules that read it (one stray reader at most). With more
      // readers the package has none, however many modules never read it: three unrelated readers among 500
      // modules are 99% "conforming" by module count and still no gateway.
      if (readers.length > 2) continue;
      anyReader = true;
      const gw = readers.slice().sort((a, b) => a.rel.length - b.rel.length)[0];
      gateways.push(inPkg(inv, gw));
      for (const f of modules) {
        const reads = readers.includes(f);
        const text = reads ? maskNonCode(readCached(f.abs)) : '';
        const at = reads ? text.search(pattern) : -1;
        sites.push({ file: f, line: at >= 0 ? text.slice(0, at).split('\n').length : 1, key: f.abs, variants: [reads && f !== gw ? 'bypass' : 'gateway'] });
      }
    }
  }
  if (!anyReader) return [];
  return [{ sub: '', sites, params: { GATEWAY: gatewayName(gateways), WHAT: String(p.params?.what ?? '') }, check: { name: 'single-accessor', pattern: pattern.source, gateways: [...new Set(gateways)] } }];
}

// ---------------------------------------------------------------------------
// SQL migrations
// ---------------------------------------------------------------------------

const DDL = /\b(create\s+(?:or\s+alter\s+)?table|alter\s+table\s+[\w.[\]"]+\s+add\b|create\s+(?:unique\s+)?(?:clustered\s+|nonclustered\s+)?index|create\s+(?:or\s+alter\s+)?(?:view|proc|procedure|function|trigger))\b/gi;
const GUARD = /\b(if\s+object_id\s*\(|if\s+col_length\s*\(|if\s+not\s+exists\b|if\s+exists\b|if\s+type_id\s*\(|if\s+schema_id\s*\(|if\s+index_?property|if\s*\(\s*select)/i;

function stripSqlComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** DDL statements in one migration file and whether each is guarded. */
export function ddlGuards(text: string): Array<{ line: number; statement: string; guarded: boolean }> {
  const clean = stripSqlComments(text);
  const out: Array<{ line: number; statement: string; guarded: boolean }> = [];
  // Batches split on GO lines; a guard must precede the DDL in the same batch.
  let offset = 0;
  for (const batch of clean.split(/^\s*go\s*;?\s*$/gim)) {
    const re = new RegExp(DDL.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(batch))) {
      const before = batch.slice(0, m.index);
      const stmt = m[1].replace(/\s+/g, ' ');
      const inline = /\bif\s+not\s+exists\b/i.test(batch.slice(m.index, m.index + m[0].length + 40)) || /\bor\s+alter\b/i.test(stmt);
      const guarded = inline || GUARD.test(before);
      const abs = clean.indexOf(batch, offset) + m.index;
      out.push({ line: clean.slice(0, abs).split('\n').length, statement: stmt.toUpperCase(), guarded });
    }
    offset += batch.length;
  }
  return out;
}

function sqlDdlGuards(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const sites: BuiltinSite[] = [];
  for (const inv of ctx.ws.repos) {
    for (const f of inv.files) {
      if (f.kind !== 'sql' || !inScope(f.rel, p.files, p.exclude)) continue;
      for (const d of ddlGuards(readCached(f.abs))) {
        sites.push({ file: f, line: d.line, key: `${f.abs}:${d.line}:${d.statement}`, variants: [d.guarded ? 'guarded' : 'unguarded'], snippet: d.statement });
      }
    }
  }
  return [{ sub: '', sites, params: {}, check: { name: 'sql-ddl-guards', files: p.files } }];
}

// ---------------------------------------------------------------------------
// Imports between workspace packages; import shape; barrels
// ---------------------------------------------------------------------------

function workspaceImports(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const sites: BuiltinSite[] = [];
  const names = new Map<string, number>();
  const checkPkgs: Array<{ repo: string; name: string; dir: string }> = [];
  for (const inv of ctx.ws.repos) {
    const pkgs = inv.repo.packages.filter((x) => x.dir);
    if (pkgs.length < 2) continue;
    for (const x of pkgs) checkPkgs.push({ repo: inv.repo.id, name: x.name, dir: x.dir });
    for (const f of inv.files) {
      if (f.kind !== 'code') continue;
      const own = pkgs.find((x) => x.id === f.pkg);
      if (!own) continue;
      for (const i of importsOf(f)) {
        const byName = pkgs.find((x) => x !== own && (packageNameOf(i.spec) === x.name));
        if (byName) {
          bump(names, byName.name);
          sites.push({ file: f, line: i.line, key: `${f.abs}:${i.line}:${i.spec}`, variants: ['by-name'], snippet: `from '${i.spec}'` });
          continue;
        }
        if (!i.spec.startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), i.spec));
        const into = pkgs.find((x) => x !== own && (target === x.dir || target.startsWith(x.dir + '/')));
        if (into) sites.push({ file: f, line: i.line, key: `${f.abs}:${i.line}:${i.spec}`, variants: ['relative'], snippet: `from '${i.spec}'` });
      }
    }
  }
  if (!sites.length) return [];
  return [{ sub: '', sites, params: { EXAMPLE: dominant(names) ?? '@scope/package' }, check: { name: 'workspace-imports', packages: checkPkgs } }];
}

function importShape(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const sites: BuiltinSite[] = [];
  for (const inv of ctx.ws.repos) {
    for (const f of inv.files) {
      if (f.kind !== 'code') continue;
      for (const i of importsOf(f)) {
        let v: string | null = null;
        if (i.spec.startsWith('./')) v = 'same-folder';
        else if (i.spec.startsWith('../')) v = (i.spec.match(/\.\.\//g) ?? []).length >= 3 ? 'deep' : 'shallow';
        else if (/^(@\/|~\/|#)/.test(i.spec)) v = 'alias';
        if (v) sites.push({ file: f, line: i.line, key: `${f.abs}:${i.line}:${i.spec}`, variants: [v], snippet: `from '${i.spec}'` });
      }
    }
  }
  return [{ sub: '', sites, params: {}, check: { name: 'import-shape' } }];
}

function barrelImports(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const sites: BuiltinSite[] = [];
  for (const inv of ctx.ws.repos) {
    for (const f of inv.files) {
      if (f.kind !== 'code') continue;
      for (const i of importsOf(f)) {
        const r = resolveRelative(inv.repo.path, f.rel, i.spec);
        if (!r) continue;
        sites.push({ file: f, line: i.line, key: `${f.abs}:${i.line}:${i.spec}`, variants: [r.barrel ? 'barrel' : 'direct'], snippet: `from '${i.spec}'` });
      }
    }
  }
  return [{ sub: '', sites, params: {}, check: { name: 'barrel-imports' } }];
}

// ---------------------------------------------------------------------------
// CI coverage of the package scripts
// ---------------------------------------------------------------------------

const CHECK_SCRIPTS = /^(build|typecheck|type-check|types|tsc|lint|lint:[\w-]+|format:check|prettier:check|fmt:check|test|test:unit|check|verify)$/;

function ciScripts(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  const sites: BuiltinSite[] = [];
  const perRepo: string[] = [];
  for (const inv of ctx.ws.repos) {
    if (!inv.ci.length) continue;
    const ran = new Set(inv.ci.flatMap((w) => w.scripts));
    const root = inv.repo.packages.find((x) => x.dir === '');
    if (!root) continue;
    const pm = inv.repo.packageManager === 'unknown' ? 'npm' : inv.repo.packageManager;
    const inCi: string[] = [];
    for (const [name] of Object.entries(root.scripts)) {
      if (!CHECK_SCRIPTS.test(name)) continue;
      const pseudo: ScannedFile = { abs: path.join(inv.repo.path, 'package.json'), rel: 'package.json', repoId: inv.repo.id, pkg: root.id, bytes: 0, kind: 'other', isTest: false };
      const yes = ran.has(name);
      if (yes) inCi.push(name === 'test' ? `${pm} test` : `${pm} run ${name}`);
      sites.push({ file: pseudo, line: 1, key: `${inv.repo.id}:${name}`, variants: [yes ? 'in-ci' : 'not-in-ci'], snippet: `"${name}"` });
    }
    if (inCi.length) perRepo.push(inCi.join(', '));
  }
  if (!sites.length) return [];
  const uniq = [...new Set(perRepo)];
  return [{ sub: '', sites, params: { STEPS: uniq.length === 1 ? uniq[0] : uniq.join(' | ') }, check: { name: 'ci-scripts' } }];
}

export function runBuiltin(p: ProbeSpec, ctx: BuiltinContext): BuiltinOutput[] {
  switch (p.builtin) {
    case 'test-placement':
      return testPlacement(p, ctx);
    case 'tests-per-module':
      return testsPerModule(p, ctx);
    case 'import-gateway':
      return importGateway(p, ctx);
    case 'single-accessor':
      return singleAccessor(p, ctx);
    case 'sql-ddl-guards':
      return sqlDdlGuards(p, ctx);
    case 'workspace-imports':
      return workspaceImports(p, ctx);
    case 'import-shape':
      return importShape(p, ctx);
    case 'barrel-imports':
      return barrelImports(p, ctx);
    case 'ci-scripts':
      return ciScripts(p, ctx);
    default:
      return [];
  }
}
