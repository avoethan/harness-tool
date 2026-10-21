/**
 * The probe library: loading, validation, compilation to ast-grep rules,
 * and self-tests (ast-grep's own `test` command for ast-grep probes, a small
 * runner for the regex probes).
 *
 * Layout (see probes/README.md):
 *   probes/<family>/<name>.yml        an ast-grep rule file (one document per
 *                                     variant, harness fields under
 *                                     `metadata.harness`) or a regex probe
 *                                     (`engine: filename | path | content |
 *                                     subjects | builtin`)
 *   probes/__tests__/<name>-test.yml  sg-test documents: `id` (a rule id, or
 *                                     `<probe>/<variant>` for regex probes),
 *                                     `valid`, `invalid`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckType, StandardFamily } from '../types';
import { packageRoot } from '../lib/paths';
import type { DeclaredBy, ProbeEngine, ProbeSpec, ProbeTestCase, ProbeVariant } from './model';
import { parseYamlDocuments } from './yaml';
import { runSgTest, type AstGrepBinary } from './astgrep';

export const FAMILIES: StandardFamily[] = [
  'lint',
  'format',
  'types',
  'naming',
  'layout',
  'sql',
  'tests',
  'errors',
  'logging',
  'api',
  'async',
  'imports',
  'validation',
  'commits',
  'ci',
  'safety',
  'other',
];
const ENGINES: ProbeEngine[] = ['ast-grep', 'filename', 'path', 'content', 'subjects', 'builtin'];
const CHECK_TYPES: CheckType[] = ['config', 'eslint', 'ast-grep', 'semgrep', 'dependency-cruiser', 'knip', 'sql-lint', 'regex', 'commitlint', 'judgment'];
export const AST_LANGUAGES = ['TypeScript', 'Tsx', 'JavaScript'];

export function probeLibraryDir(): string {
  return path.join(packageRoot(), 'probes');
}

export interface ProbeLibrary {
  probes: ProbeSpec[];
  tests: Map<string, ProbeTestCase>;
  errors: string[];
  dir: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : undefined);

function readVariantFields(h: Obj, v: ProbeVariant): void {
  if (typeof h.statement === 'string') v.statement = h.statement;
  if (typeof h.fixText === 'string') v.fixText = h.fixText;
  const prose = strList(h.prose);
  if (prose) v.prose = prose;
  if (h.default === true) v.isDefault = true;
}

function probeFields(h: Obj, spec: Partial<ProbeSpec>): void {
  if (typeof h.family === 'string' && !spec.family) spec.family = h.family as StandardFamily;
  if (typeof h.title === 'string' && !spec.title) spec.title = h.title;
  if (typeof h.site === 'string' && !spec.site) spec.site = h.site;
  if (typeof h.conforming === 'string' && !spec.conforming) spec.conforming = h.conforming;
  if (h.files !== undefined && !spec.files) spec.files = strList(h.files);
  if (h.exclude !== undefined && !spec.exclude) spec.exclude = strList(h.exclude);
  if ((h.polarity === 'fixed' || h.polarity === 'either') && !spec.polarity) spec.polarity = h.polarity;
  if (h.overlapping === true) spec.overlapping = true;
  if (h.hygiene === true) spec.hygiene = true;
  if (h.record === false) spec.record = false;
  if (h.formatterOwned === true) spec.formatterOwned = true;
  if (isObj(h.declaredBy) && !spec.declaredBy) spec.declaredBy = h.declaredBy as DeclaredBy;
  if (isObj(h.check) && !spec.check) spec.check = { type: String(h.check.type) as CheckType, ref: h.check.ref === undefined ? undefined : String(h.check.ref) };
  if (typeof h.capture === 'string' && !spec.capture) spec.capture = h.capture;
  if (typeof h.builtin === 'string' && !spec.builtin) spec.builtin = h.builtin;
  if (isObj(h.params) && !spec.params) spec.params = h.params;
}

/** Validate a loaded probe; returns problems (empty when fine). */
export function validateProbe(p: ProbeSpec): string[] {
  const errs: string[] = [];
  if (!/^[a-z]+\.[a-z0-9][a-z0-9-]*$/.test(p.id)) errs.push(`${p.file}: id '${p.id}' must be <family>.<slug>`);
  if (!FAMILIES.includes(p.family)) errs.push(`${p.file}: unknown family '${p.family}'`);
  else if (!p.id.startsWith(p.family + '.')) errs.push(`${p.file}: id '${p.id}' must start with its family '${p.family}.'`);
  if (!ENGINES.includes(p.engine)) errs.push(`${p.file}: unknown engine '${p.engine}'`);
  if (!p.title) errs.push(`${p.file}: title missing`);
  if (!p.site) errs.push(`${p.file}: site (what counts as a site) missing`);
  if (!p.conforming) errs.push(`${p.file}: conforming (what counts as conforming) missing`);
  if (!p.check || !CHECK_TYPES.includes(p.check.type)) errs.push(`${p.file}: check.type missing or unknown`);
  if (p.variants.length < 1) errs.push(`${p.file}: no variants`);
  if (p.engine !== 'builtin' && p.variants.length < 2 && !p.hygiene) errs.push(`${p.file}: a counted probe needs at least two variants`);
  const names = new Set<string>();
  for (const v of p.variants) {
    if (names.has(v.name)) errs.push(`${p.file}: duplicate variant '${v.name}'`);
    names.add(v.name);
    if (p.engine === 'ast-grep' && !v.rule) errs.push(`${p.file}: variant '${v.name}' has no rule`);
    if (['filename', 'path', 'content', 'subjects'].includes(p.engine) && !v.pattern) errs.push(`${p.file}: variant '${v.name}' has no pattern`);
    if (v.pattern) {
      try {
        new RegExp(v.pattern, v.flags ?? '');
      } catch (e) {
        errs.push(`${p.file}: variant '${v.name}' pattern does not compile: ${(e as Error).message}`);
      }
    }
  }
  if (!p.hygiene && p.record !== false && !p.variants.some((v) => v.statement)) errs.push(`${p.file}: no variant carries a statement`);
  for (const v of p.variants) {
    if (v.statement && !v.fixText) errs.push(`${p.file}: variant '${v.name}' has a statement but no fixText`);
  }
  return errs;
}

/** Parse one probe file. Throws on YAML errors. */
export function parseProbeFile(text: string, rel: string): ProbeSpec {
  const docs = parseYamlDocuments(text).filter(isObj);
  if (!docs.length) throw new Error(`${rel}: empty probe file`);
  const first = docs[0];
  if (typeof first.engine === 'string' && first.engine !== 'ast-grep') {
    const spec: Partial<ProbeSpec> = { id: String(first.id ?? ''), engine: first.engine as ProbeEngine, file: rel, variants: [] };
    probeFields(first, spec);
    const vs = Array.isArray(first.variants) ? first.variants : [];
    for (const raw of vs) {
      if (!isObj(raw)) continue;
      const v: ProbeVariant = { name: String(raw.name ?? '') };
      if (typeof raw.pattern === 'string') v.pattern = raw.pattern;
      if (typeof raw.flags === 'string') v.flags = raw.flags;
      readVariantFields(raw, v);
      spec.variants!.push(v);
    }
    return finish(spec);
  }
  // ast-grep rule documents, one per variant.
  const spec: Partial<ProbeSpec> = { engine: 'ast-grep', file: rel, variants: [] };
  for (const d of docs) {
    const meta = isObj(d.metadata) && isObj((d.metadata as Obj).harness) ? ((d.metadata as Obj).harness as Obj) : {};
    const ruleId = String(d.id ?? '');
    const probeId = typeof meta.probe === 'string' ? meta.probe : ruleId.split('/')[0];
    if (!spec.id) spec.id = probeId;
    else if (spec.id !== probeId) throw new Error(`${rel}: document '${ruleId}' belongs to probe '${probeId}', expected '${spec.id}'`);
    probeFields(meta, spec);
    const vname = typeof meta.variant === 'string' ? meta.variant : ruleId.split('/')[1] ?? 'default';
    const v: ProbeVariant = { name: vname, ruleId, rule: d };
    readVariantFields(meta, v);
    spec.variants!.push(v);
    const langs = strList(meta.languages);
    if (langs && !spec.params) spec.params = { languages: langs };
  }
  return finish(spec);
}

function finish(spec: Partial<ProbeSpec>): ProbeSpec {
  return {
    id: spec.id ?? '',
    family: (spec.family ?? 'other') as StandardFamily,
    engine: spec.engine ?? 'ast-grep',
    file: spec.file ?? '',
    title: spec.title ?? '',
    site: spec.site ?? '',
    conforming: spec.conforming ?? '',
    files: spec.files,
    exclude: spec.exclude,
    polarity: spec.polarity ?? 'fixed',
    overlapping: spec.overlapping,
    hygiene: spec.hygiene,
    record: spec.record,
    formatterOwned: spec.formatterOwned,
    declaredBy: spec.declaredBy,
    check: spec.check ?? { type: spec.engine === 'ast-grep' ? 'ast-grep' : 'regex' },
    capture: spec.capture,
    builtin: spec.builtin,
    params: spec.params,
    variants: spec.variants ?? [],
    origin: 'library',
  };
}

function listYaml(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Load every probe and every sg-test case under the library folder. */
export function loadProbeLibrary(dir: string = probeLibraryDir()): ProbeLibrary {
  const probes: ProbeSpec[] = [];
  const tests = new Map<string, ProbeTestCase>();
  const errors: string[] = [];
  const testsDir = path.join(dir, '__tests__');
  for (const file of listYaml(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
      continue;
    }
    if (file.startsWith(testsDir + path.sep)) {
      try {
        for (const d of parseYamlDocuments(text)) {
          if (!isObj(d) || typeof d.id !== 'string') continue;
          tests.set(d.id, { id: d.id, valid: (strList(d.valid) ?? []).map(String), invalid: (strList(d.invalid) ?? []).map(String) });
        }
      } catch (e) {
        errors.push(`${rel}: ${(e as Error).message}`);
      }
      continue;
    }
    try {
      const p = parseProbeFile(text, rel);
      const errs = validateProbe(p);
      if (errs.length) errors.push(...errs);
      else probes.push(p);
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
  }
  const ids = new Set<string>();
  for (const p of probes) {
    if (ids.has(p.id)) errors.push(`${p.file}: duplicate probe id '${p.id}'`);
    ids.add(p.id);
  }
  return { probes, tests, errors, dir };
}

/** Languages an ast-grep probe runs on (TypeScript and Tsx by default). */
export function probeLanguages(p: ProbeSpec): string[] {
  const l = p.params && Array.isArray(p.params.languages) ? (p.params.languages as string[]) : ['TypeScript', 'Tsx'];
  return l.filter((x) => AST_LANGUAGES.includes(x));
}

const LANG_SUFFIX: Record<string, string> = { TypeScript: '', Tsx: '@tsx', JavaScript: '@js' };

/** Compile an ast-grep probe's variant documents into scan rules, one per language. */
export function compileAstRules(p: ProbeSpec): Array<Record<string, unknown>> {
  if (p.engine !== 'ast-grep') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const v of p.variants) {
    if (!v.rule) continue;
    for (const lang of probeLanguages(p)) {
      const r: Record<string, unknown> = { ...v.rule };
      r.id = `${v.ruleId}${LANG_SUFFIX[lang]}`;
      r.language = lang;
      r.severity = 'info';
      delete r.metadata;
      delete r.note;
      out.push(r);
    }
  }
  return out;
}

/** Map a scanned rule id (`probe/variant@lang`) back to probe and variant. */
export function splitRuleId(ruleId: string): { probe: string; variant: string } {
  const base = ruleId.replace(/@\w+$/, '');
  const i = base.indexOf('/');
  return i < 0 ? { probe: base, variant: 'default' } : { probe: base.slice(0, i), variant: base.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Self-tests
// ---------------------------------------------------------------------------

export interface SelfTestReport {
  astGrep: { ran: boolean; rules: number; passed: number; failed: number; failures: string[]; reason?: string };
  regex: { cases: number; passed: number; failed: number; failures: string[] };
  missingTests: string[];
}

/** Test target text for a regex probe: what the pattern is matched against. */
export function regexTarget(p: ProbeSpec, sample: string): string {
  if (p.engine === 'filename') return sample.split('/').pop() ?? sample;
  return sample;
}

/** Variants a sample follows under a regex probe. */
export function regexVariantsOf(p: ProbeSpec, target: string): string[] {
  const out: string[] = [];
  for (const v of p.variants) {
    if (!v.pattern) continue;
    if (new RegExp(v.pattern, v.flags ?? '').test(target)) out.push(v.name);
  }
  return out;
}

/**
 * Run every probe's valid/invalid cases. ast-grep probes go through
 * `ast-grep test` (TypeScript documents); regex probes through the runner
 * below: an `invalid` case must match the variant's pattern, a `valid` case
 * must not.
 */
export function selfTest(lib: ProbeLibrary, bin: AstGrepBinary | null): SelfTestReport {
  const missing: string[] = [];
  const astRules: Array<Record<string, unknown>> = [];
  const astTests: ProbeTestCase[] = [];
  const regexFailures: string[] = [];
  let regexCases = 0;
  let regexPassed = 0;
  for (const p of lib.probes) {
    for (const v of p.variants) {
      const id = v.ruleId ?? `${p.id}/${v.name}`;
      const t = lib.tests.get(id);
      if (p.engine === 'builtin') continue;
      if (!t || (!t.valid.length && !t.invalid.length)) {
        missing.push(id);
        continue;
      }
      if (p.engine === 'ast-grep') {
        const r: Record<string, unknown> = { ...v.rule, language: 'TypeScript', severity: 'info' };
        delete r.metadata;
        astRules.push(r);
        astTests.push(t);
      } else {
        for (const s of t.invalid) {
          regexCases++;
          if (regexVariantsOf(p, regexTarget(p, s)).includes(v.name)) regexPassed++;
          else regexFailures.push(`${id}: invalid case not matched: ${JSON.stringify(s).slice(0, 80)}`);
        }
        for (const s of t.valid) {
          regexCases++;
          if (!regexVariantsOf(p, regexTarget(p, s)).includes(v.name)) regexPassed++;
          else regexFailures.push(`${id}: valid case matched: ${JSON.stringify(s).slice(0, 80)}`);
        }
      }
    }
  }
  let ast: SelfTestReport['astGrep'];
  if (!bin) ast = { ran: false, rules: astRules.length, passed: 0, failed: 0, failures: [], reason: 'ast-grep not found' };
  else {
    const r = runSgTest(bin, astRules, astTests);
    ast = { ran: r.ran, rules: astRules.length, passed: r.passed, failed: r.failed, failures: r.failures, reason: r.ran ? undefined : r.output.slice(0, 500) };
  }
  return { astGrep: ast, regex: { cases: regexCases, passed: regexPassed, failed: regexCases - regexPassed, failures: regexFailures }, missingTests: missing };
}
