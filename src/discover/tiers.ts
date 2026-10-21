/**
 * Proof and tiers: turn counts, declared settings, written rules and review
 * clusters into ledger records and findings (RESEARCH 2.3).
 *
 *   declared          a resolved config, hook or CI job says it (and the code
 *                     follows it at >= 80%; below that it is a finding)
 *   counted-strong    >= 95% conforming, enough sites and packages (scaled
 *                     for small estates, see thresholdsFor), or a written
 *                     rule the code follows at 100% over >= 3 sites
 *   counted-majority  >= 80% conforming with enough sites
 *   review-derived    >= 3 accepted review comments over >= 2 PRs and >= 2
 *                     reviewers, or 1 accepted from a code owner
 *   single-source     one written sentence (CONTRIBUTING, PR template, ADR);
 *                     judgment check, never blocking
 *
 * Conflicts are scoped to the narrowest unit (repository, or package when a
 * repository is itself split) and listed on each side, never averaged.
 */
import type { CheckMode, CheckType, Conflict, Example, LedgerRecord, Provenance, StandardFamily, Tier } from '../types';
import { slug } from '../lib/paths';
import type { DeclaredSetting, DiscoverFinding, ProbeSpec, ProbeVariant, ProseSentence, RepoInfo, Thresholds, VariantTally } from './model';
import type { CountedProbe } from './scan';
import { emptyTally } from './scan';
import { corroborating, familyOfSentence, isNormative } from './prose';
import type { RepoHistory } from './history';
import { scanInjection } from './judgment-scan';

export const TIER_ORDER: Tier[] = ['declared', 'counted-strong', 'counted-majority', 'review-derived', 'single-source'];

/** Thresholds in use, scaled for estates under 10,000 source files. */
export function thresholdsFor(sourceFiles: number, packagesInEstate: number): Thresholds {
  const P = Math.max(1, packagesInEstate);
  if (sourceFiles >= 10000) {
    return {
      scale: 'full',
      sourceFiles,
      strong: { conformance: 0.95, sites: 100, packages: Math.min(3, P) },
      majority: { conformance: 0.8, sites: 30 },
      corroborated: { conformance: 1, sites: 3 },
      declaredFollowed: 0.8,
      discriminating: { min: 3, share: 0.1 },
      rule: `full scale (${sourceFiles} source files >= 10,000): counted-strong >= 95% conforming, >= 100 sites, >= ${Math.min(3, P)} packages; counted-majority >= 80% and >= 30 sites`,
    };
  }
  const S = Math.min(100, Math.max(10, Math.ceil(sourceFiles / 100)));
  const M = Math.min(30, Math.max(5, Math.ceil(sourceFiles / 333)));
  const Ps = Math.min(2, P);
  return {
    scale: 'small',
    sourceFiles,
    strong: { conformance: 0.95, sites: S, packages: Ps },
    majority: { conformance: 0.8, sites: M },
    corroborated: { conformance: 1, sites: 3 },
    declaredFollowed: 0.8,
    discriminating: { min: 3, share: 0.1 },
    rule:
      `small estate (${sourceFiles} source files < 10,000): counted-strong >= 95% conforming, >= ${S} sites (max(10, files/100)), >= ${Ps} package(s) (min(2, packages)); ` +
      `counted-majority >= 80% and >= ${M} sites (max(5, files/333)); the full-scale numbers (100 sites, 3 packages; 30 sites) apply from 10,000 files`,
  };
}

/** Wilson lower bound (95%) of a conformance ratio: the confidence of a counted record. */
export function wilsonLower(conforming: number, sites: number): number {
  if (sites <= 0) return 0;
  const z = 1.96;
  const p = conforming / sites;
  const d = 1 + (z * z) / sites;
  const c = p + (z * z) / (2 * sites);
  const r = z * Math.sqrt((p * (1 - p)) / sites + (z * z) / (4 * sites * sites));
  return Math.max(0, Math.min(1, (c - r) / d));
}

export function round(n: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface Unit {
  repoId: string;
  /** Package directory when a repository is split into packages. */
  pkgDir?: string;
  tally: VariantTally;
}

interface DeclInfo {
  variant: string;
  sources: string[];
  severity?: 'error' | 'warn';
  offFiles: string[];
  tool: string;
}

export interface TierInput {
  counted: CountedProbe[];
  declared: Map<string, DeclaredSetting[]>;
  repos: RepoInfo[];
  prose: ProseSentence[];
  histories: Map<string, RepoHistory>;
  thresholds: Thresholds;
  now: string;
  previous: Map<string, LedgerRecord>;
  /** Probes that could not be counted (scanner missing): a declared rule they stand for keeps the probe's id and statement. */
  uncounted?: ProbeSpec[];
}

export interface TierOutput {
  records: LedgerRecord[];
  findings: DiscoverFinding[];
  /** Per record id: the data its runnable check needs. */
  checkData: Map<string, { probe?: ProbeSpec; variant?: string; others?: string[]; data: Record<string, unknown>; offFiles?: string[]; eslintRule?: string; baseline?: string[] }>;
  /** Informational tallies (probes that never become records, defaults followed). */
  informational: Array<{ id: string; title: string; byVariant: Record<string, number>; sites: number; note: string }>;
  usedSentences: Set<string>;
  /** Per record id: why it got its tier, in plain words. */
  reasons: Map<string, string>;
}

function sentenceKey(s: ProseSentence): string {
  return `${s.file}#${s.line}#${s.text}`;
}

function fillTemplate(t: string, params: Record<string, string>): string {
  return t.replace(/\{([A-Z0-9_]+)\}/g, (all, k: string) => (params[k] !== undefined ? params[k] : all));
}

function variantByName(p: ProbeSpec, name: string): ProbeVariant | undefined {
  return p.variants.find((v) => v.name === name);
}

function dominantVariant(t: VariantTally, p: ProbeSpec): string | null {
  let best: string | null = null;
  let bestN = -1;
  let bestD = -1;
  for (const v of p.variants) {
    const n = t.byVariant[v.name] ?? 0;
    const d = t.discriminating[v.name] ?? 0;
    if (n > bestN || (n === bestN && d > bestD)) {
      best = v.name;
      bestN = n;
      bestD = d;
    }
  }
  return bestN > 0 ? best : null;
}

function addTallies(a: VariantTally, b: VariantTally): VariantTally {
  const out = emptyTally();
  for (const t of [a, b]) {
    out.sites += t.sites;
    for (const [k, v] of Object.entries(t.byVariant)) out.byVariant[k] = (out.byVariant[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.discriminating)) out.discriminating[k] = (out.discriminating[k] ?? 0) + v;
    for (const p of t.packages) out.packages.add(p);
    for (const [k, ex] of Object.entries(t.examples)) {
      const l = (out.examples[k] ??= []);
      for (const e of ex) if (l.length < 3) l.push(e);
    }
    for (const [k, c] of Object.entries(t.captures)) {
      const o = (out.captures[k] ??= {});
      for (const [val, n] of Object.entries(c)) o[val] = (o[val] ?? 0) + n;
    }
  }
  return out;
}

function topCapture(t: VariantTally, variant: string): string | undefined {
  const c = t.captures[variant];
  if (!c) return undefined;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** What a repository's configs declare for a probe, if anything. */
function declaredFor(p: ProbeSpec, repo: RepoInfo, settings: DeclaredSetting[], c: CountedProbe, unitDominant: string | null): DeclInfo | null {
  const d = p.declaredBy;
  if (!d && p.family !== 'ci') return null;
  const mine = settings.filter((s) => s.repoId === repo.id);
  if (d?.eslint?.length) {
    const stdV = p.variants.find((v) => v.statement);
    // A preset that switches on a community default is not a team decision: defaults need an explicit entry.
    const on = mine.filter((s) => s.tool === 'eslint' && d.eslint!.includes(s.key) && s.severity !== 'off' && (stdV?.isDefault ? s.via === 'static' : s.via === 'resolved' || s.explicit));
    if (on.length) {
      const stdVariant = p.variants.find((v) => v.statement)?.name ?? p.variants[0].name;
      const off = mine.filter((s) => s.tool === 'eslint' && d.eslint!.includes(s.key) && s.severity === 'off' && s.files?.length);
      const sources = [...new Set(on.filter((s) => s.via === 'static').map((s) => `eslint:${repoPrefix(repo)}${s.source}`))];
      if (!sources.length) sources.push(...new Set(on.map((s) => `eslint (resolved by eslint --print-config on ${repoPrefix(repo)}${s.files?.[0] ?? '?'})`)));
      return { variant: stdVariant, sources, severity: on.some((s) => s.severity === 'error') ? 'error' : 'warn', offFiles: off.flatMap((s) => s.files ?? []), tool: 'eslint' };
    }
  }
  for (const tool of ['prettier', 'biome', 'editorconfig'] as const) {
    const map = d?.[tool];
    if (!map) continue;
    const toolSettings = mine.filter((s) => s.tool === tool);
    if (!toolSettings.length) continue;
    for (const [key, values] of Object.entries(map)) {
      const s = toolSettings.find((x) => x.key === key);
      const v = s ? values[String(s.value)] : values.default;
      if (v) return { variant: v, sources: [`${tool}:${repoPrefix(repo)}${s ? s.source : toolSettings[0].source}${s ? ` ${key}: ${JSON.stringify(s.value)}` : ` (${tool} default for ${key})`}`], offFiles: [], tool };
    }
  }
  if (d?.commitlint) {
    const s = mine.find((x) => x.tool === 'commitlint');
    const v = s ? d.commitlint[String(s.value)] : undefined;
    if (s && v) return { variant: v, sources: [`commitlint:${repoPrefix(repo)}${s.source}`], offFiles: [], tool: 'commitlint' };
  }
  if (d?.testRunner) {
    const repos = (c.checkData.declaredRepos as string[] | undefined) ?? [];
    if (repos.includes(repo.id) && unitDominant) {
      const srcs = ((c.checkData.declaredSources as string[] | undefined) ?? []).filter((x) => repo.relPath === '.' || x.startsWith(`${repo.relPath}/`));
      return { variant: unitDominant, sources: srcs.map((x) => `test-runner:${x}`), offFiles: [], tool: 'test-runner' };
    }
  }
  if (p.family === 'ci' && p.engine === 'builtin') {
    const wf = mine.filter((s) => s.tool === 'ci');
    if (wf.length) return { variant: 'in-ci', sources: [...new Set(wf.map((s) => `ci:${repoPrefix(repo)}${s.source}`))], offFiles: [], tool: 'ci' };
  }
  return null;
}

/** An explicit `off` for the probe's ESLint rule that covers every file of the unit (root config or the unit's own package). */
function turnedOff(p: ProbeSpec, u: Unit, settings: DeclaredSetting[]): DeclaredSetting | undefined {
  const rules = p.declaredBy?.eslint ?? [];
  if (!rules.length) return undefined;
  return settings.find(
    (s) =>
      s.repoId === u.repoId &&
      s.tool === 'eslint' &&
      s.via === 'static' &&
      s.severity === 'off' &&
      rules.includes(s.key) &&
      (!s.pkgDir || s.pkgDir === u.pkgDir) &&
      (!s.files || s.files.every((f) => /^\*\*\/\*\.(\{?[\w,]+\}?)$/.test(f))),
  );
}

/** The extensions an extension-wide glob (a star-star, slash, star, dot and an extension, or `*.{ts,tsx}`) covers; null for any other glob. */
function globExtensions(glob: string): string[] | null {
  const m = /^(?:\*\*\/)?\*\.(\{[\w,]+\}|\w+)$/.exec(glob);
  if (!m) return null;
  return m[1].replace(/[{}]/g, '').split(',');
}

/** The extensions of the files a unit's sites sit in (from the probe's counted sites, which are capped). */
function unitExtensions(c: CountedProbe, u: Unit, repo: RepoInfo): Set<string> {
  const prefix = repoPrefix(repo) + (u.pkgDir ? u.pkgDir + '/' : '');
  const exts = new Set<string>();
  for (const sites of c.sitesByVariant.values()) {
    for (const s of sites) {
      if (s.repoId !== u.repoId || !s.file.startsWith(prefix)) continue;
      const m = /\.(\w+)$/.exec(s.file);
      if (m) exts.add(m[1]);
    }
  }
  return exts;
}

/**
 * The severity the repository's lint config declares for the probe's rule in a unit, resolved the way ESLint does:
 * entries in source order, the last one that matches a file wins, and an extension-wide override applies only to
 * files it matches. `error` when any file of the unit ends at error, else `warn` when any ends at warn, else
 * undefined (nothing applies, or turned off), null when no static entry exists (the caller falls back to the resolved
 * severity). Overrides on other globs and resolved samples are not considered.
 */
function declaredSeverity(p: ProbeSpec, u: Unit, settings: DeclaredSetting[], exts: Set<string>): 'error' | 'warn' | undefined | null {
  const rules = p.declaredBy?.eslint ?? [];
  if (!rules.length) return null;
  const mine = settings.filter((s) => s.repoId === u.repoId && s.tool === 'eslint' && s.via === 'static' && s.severity && rules.includes(s.key) && (!s.pkgDir || s.pkgDir === u.pkgDir));
  if (!mine.length) return null;
  // One probe per known extension; with no extension known, a file no extension-wide override matches.
  const probes: Array<string | null> = exts.size ? [...exts] : [null];
  let warn = false;
  for (const ext of probes) {
    let eff: DeclaredSetting['severity'];
    for (const s of mine) {
      if (!s.files) {
        eff = s.severity;
        continue;
      }
      const globs = s.files.map(globExtensions);
      if (globs.some((g) => !g)) continue;
      if (ext !== null && globs.some((g) => g!.includes(ext))) eff = s.severity;
    }
    if (eff === 'error') return 'error';
    if (eff === 'warn') warn = true;
  }
  return warn ? 'warn' : undefined;
}

function unitLabel(u: Unit, repoById: Map<string, RepoInfo>): string {
  const r = repoById.get(u.repoId);
  return `${r?.relPath && r.relPath !== '.' ? r.relPath : r?.name ?? u.repoId}${u.pkgDir ? '/' + u.pkgDir : ''}`;
}

function repoPrefix(r: RepoInfo): string {
  return r.relPath === '.' ? '' : r.relPath + '/';
}

/** Units for a probe: repositories, split into packages when a repository is mixed but its packages are not. */
function unitsFor(c: CountedProbe, repos: RepoInfo[], th: Thresholds): Unit[] {
  const units: Unit[] = [];
  for (const r of repos) {
    const t = c.perRepo.get(r.id);
    if (!t || !t.sites) continue;
    const dom = dominantVariant(t, c.probe);
    const conf = dom ? (t.byVariant[dom] ?? 0) / t.sites : 0;
    const pkgs = r.packages.filter((p) => c.perPackage.get(p.id)?.sites);
    if (conf < th.majority.conformance && pkgs.length >= 2) {
      const split = pkgs.map((p) => ({ p, t: c.perPackage.get(p.id)! }));
      const consistent = split.every(({ t: pt }) => {
        const d = dominantVariant(pt, c.probe);
        return d !== null && (pt.byVariant[d] ?? 0) / pt.sites >= th.strong.conformance;
      });
      const doms = new Set(split.map(({ t: pt }) => dominantVariant(pt, c.probe)));
      if (consistent && doms.size > 1) {
        for (const { p, t: pt } of split) units.push({ repoId: r.id, pkgDir: p.dir, tally: pt });
        continue;
      }
    }
    units.push({ repoId: r.id, tally: t });
  }
  return units;
}

function examplesBothWays(t: VariantTally, variant: string, others: string[], c?: CountedProbe, repoIds?: string[]): Example[] {
  const out: Example[] = [];
  for (const e of (t.examples[variant] ?? []).slice(0, 3)) out.push({ ...e, conforms: true });
  if (c) {
    // True exceptions: sites of other variants that do not also follow the chosen one.
    const chosen = new Set((c.sitesByVariant.get(variant) ?? []).map((s) => `${s.file}:${s.line}`));
    for (const o of others) {
      for (const s of c.sitesByVariant.get(o) ?? []) {
        if (out.filter((x) => !x.conforms).length >= 3) break;
        if (chosen.has(`${s.file}:${s.line}`) || (repoIds && !repoIds.includes(s.repoId))) continue;
        out.push({ file: s.file, line: s.line, snippet: s.snippet, conforms: false });
      }
    }
    return out;
  }
  for (const o of others) for (const e of t.examples[o] ?? []) if (out.filter((x) => !x.conforms).length < 3) out.push({ ...e, conforms: false });
  return out;
}

function engineCheckType(p: ProbeSpec): CheckType {
  if (p.formatterOwned || p.check.type === 'config') return 'config';
  return p.engine === 'ast-grep' ? 'ast-grep' : 'regex';
}

/** Existing violations inside a record's scope: a check reports only new ones. */
export function baselineKey(file: string, snippet?: string): string {
  return `${file}::${(snippet ?? '').replace(/\s+/g, ' ').trim()}`;
}

function baselineOf(c: CountedProbe, variant: string, others: string[], repoIds: string[]): string[] {
  const chosen = new Set((c.sitesByVariant.get(variant) ?? []).map((s) => `${s.file}:${s.line}`));
  const out = new Set<string>();
  for (const o of others) {
    for (const s of c.sitesByVariant.get(o) ?? []) {
      if (!repoIds.includes(s.repoId) || chosen.has(`${s.file}:${s.line}`)) continue;
      out.add(baselineKey(s.file, s.snippet));
    }
  }
  return [...out].sort();
}

interface Group {
  variant: string;
  units: Unit[];
  decl: DeclInfo[];
  /** The declared severity of each unit, when a lint config declares one. */
  sevs: Array<{ unit: Unit; sev: 'error' | 'warn' | undefined }>;
  tally: VariantTally;
}

/** Build the ledger records and findings. */
export function buildRecords(input: TierInput): TierOutput {
  const { thresholds: th } = input;
  const records: LedgerRecord[] = [];
  const findings: DiscoverFinding[] = [];
  const checkData: TierOutput['checkData'] = new Map();
  const informational: TierOutput['informational'] = [];
  const usedSentences = new Set<string>();
  const reasons = new Map<string, string>();
  const allSettings = [...input.declared.values()].flat();
  const repoById = new Map(input.repos.map((r) => [r.id, r]));
  const reposWithFiles = input.repos.map((r) => r.id);
  const formatterFolded: Array<{ probe: ProbeSpec; variant: string; repoIds: string[]; tally: VariantTally }> = [];

  // Narrowest scope: whole workspace, a list of repositories, or packages. Package globs are plain when the
  // record covers packages of one repository only, and repository-qualified (`<repoId>:<glob>`) when it mixes
  // whole repositories with packages of another (see checks.ts inRecordScope).
  const scopeOf = (units: Unit[], allUnitsCount: number): { repos: string[]; paths?: string[] } => {
    const repoIds = [...new Set(units.map((u) => u.repoId))];
    const split = units.filter((u) => u.pkgDir !== undefined);
    if (!split.length) return units.length === allUnitsCount && repoIds.length === reposWithFiles.length ? { repos: ['*'] } : { repos: repoIds };
    const glob = (u: Unit) => (u.pkgDir ? `${u.pkgDir}/**` : '**');
    if (repoIds.length === 1) return { repos: repoIds, paths: split.map(glob) };
    return { repos: repoIds, paths: split.map((u) => `${u.repoId}:${glob(u)}`) };
  };

  // Scope of a record that config files declare: the repositories, narrowed to package folders when every config
  // declaring it in a repository sits in one (a package's own eslint.config.mjs or tsconfig.json covers that
  // package, not its siblings).
  const declaredScope = (ss: DeclaredSetting[]): { repos: string[]; paths?: string[] } => {
    const repoIds = [...new Set(ss.map((s) => s.repoId))];
    const dirsOf = (id: string): string[] => {
      const dirs = [...new Set(ss.filter((s) => s.repoId === id).map((s) => s.pkgDir ?? ''))];
      return dirs.includes('') ? [] : dirs.sort();
    };
    if (!repoIds.some((id) => dirsOf(id).length)) return repoIds.length === reposWithFiles.length ? { repos: ['*'] } : { repos: repoIds };
    if (repoIds.length === 1) return { repos: repoIds, paths: dirsOf(repoIds[0]).map((d) => `${d}/**`) };
    return { repos: repoIds, paths: repoIds.flatMap((id) => dirsOf(id).map((d) => `${id}:${d}/**`)) };
  };

  for (const c of input.counted) {
    const p = c.probe;
    if (!c.total.sites) continue;
    if (p.hygiene) {
      const bad = p.variants.filter((v) => !v.isDefault).map((v) => v.name);
      const nBad = bad.reduce((n, v) => n + (c.total.byVariant[v] ?? 0), 0);
      if (nBad > 0) {
        const ex: Example[] = bad.flatMap((v) => (c.total.examples[v] ?? []).map((e) => ({ ...e, conforms: false }))).slice(0, 5);
        findings.push({
          kind: 'hygiene',
          id: c.id,
          message: `${p.title}: ${nBad} occurrence(s) (${bad.filter((v) => c.total.byVariant[v]).map((v) => `${v} ${c.total.byVariant[v]}`).join(', ')}) across ${c.total.sites} site(s). Reported for a human; never a standard.`,
          scope: [...c.perRepo.keys()],
          counts: { sites: c.total.sites, conforming: c.total.sites - nBad, ratio: round((c.total.sites - nBad) / c.total.sites) },
          examples: ex,
        });
      }
      continue;
    }
    if (p.record === false) {
      informational.push({ id: c.id, title: p.title, byVariant: { ...c.total.byVariant }, sites: c.total.sites, note: 'informational probe (never a standard on its own)' });
      continue;
    }
    const units = unitsFor(c, input.repos, th);
    // Key variant per unit: the declared one when a config declares it, else the dominant one.
    const groups = new Map<string, Group>();
    const leftovers: Unit[] = [];
    for (const u of units) {
      const repo = repoById.get(u.repoId)!;
      const dom = dominantVariant(u.tally, p);
      const decl = declaredFor(p, repo, allSettings, c, dom);
      const key = decl?.variant ?? dom;
      const v = key ? variantByName(p, key) : undefined;
      if (!key || !v || !v.statement) {
        leftovers.push(u);
        continue;
      }
      // The repository's own ESLint config switches the rule off for all its files: a decision against it, so the
      // count makes no standard there (however high the share: every type annotation is a site of no-explicit-any).
      const off = decl ? undefined : turnedOff(p, u, allSettings);
      if (off && key === p.variants.find((x) => x.statement)?.name) {
        findings.push({
          kind: 'mixed',
          id: `${c.id}@${u.repoId}${u.pkgDir !== undefined ? ':' + (u.pkgDir || '.') : ''}:off`,
          message: `${p.title}: not a standard in ${repo.name}${u.pkgDir ? '/' + u.pkgDir : ''}: its ESLint config turns \`${off.key}\` off (${repoPrefix(repo)}${off.source}), although ${u.tally.byVariant[key] ?? 0} of ${u.tally.sites} sites follow it.`,
          scope: [u.repoId],
          counts: { sites: u.tally.sites, conforming: u.tally.byVariant[key] ?? 0, ratio: round((u.tally.byVariant[key] ?? 0) / u.tally.sites) },
        });
        continue;
      }
      const g = groups.get(key) ?? { variant: key, units: [], decl: [], sevs: [], tally: emptyTally() };
      g.units.push(u);
      if (decl) g.decl.push(decl);
      const staticSev = declaredSeverity(p, u, allSettings, unitExtensions(c, u, repo));
      g.sevs.push({ unit: u, sev: staticSev === null ? (decl?.severity === 'error' || decl?.severity === 'warn' ? decl.severity : undefined) : staticSev });
      g.tally = addTallies(g.tally, u.tally);
      groups.set(key, g);
    }
    for (const u of leftovers) {
      const dom = dominantVariant(u.tally, p);
      if (u.tally.sites >= th.majority.sites && dom) {
        findings.push({
          kind: 'mixed',
          id: `${c.id}@${u.repoId}${u.pkgDir !== undefined ? ':' + (u.pkgDir || '.') : ''}`,
          message: `${p.title}: no standard in ${repoById.get(u.repoId)?.name}${u.pkgDir ? '/' + u.pkgDir : ''}; most common is "${dom}" at ${Math.round(((u.tally.byVariant[dom] ?? 0) / u.tally.sites) * 100)}% of ${u.tally.sites} sites.`,
          scope: [u.repoId],
          counts: { sites: u.tally.sites, conforming: u.tally.byVariant[dom] ?? 0, ratio: round((u.tally.byVariant[dom] ?? 0) / u.tally.sites) },
        });
      }
    }
    const made: Array<{ rec: LedgerRecord; g: Group }> = [];
    for (const g of groups.values()) {
      const v = variantByName(p, g.variant)!;
      const sites = g.tally.sites;
      const conforming = g.tally.byVariant[g.variant] ?? 0;
      const ratio = sites ? conforming / sites : 0;
      const repoIds = [...new Set(g.units.map((u) => u.repoId))];
      const allDeclared = g.decl.length === g.units.length && g.decl.length > 0;
      const others = p.variants.filter((x) => x.name !== g.variant).map((x) => x.name);
      const prose = corroborating(input.prose, v.prose, repoIds);
      const params: Record<string, string> = { ...c.params };
      if (p.capture) {
        const top = topCapture(g.tally, g.variant);
        if (top) params[p.capture] = top;
      }
      const statement = fillTemplate(v.statement!, params);
      const fixText = v.fixText ? fillTemplate(v.fixText, params) : undefined;
      if (/\{[A-Z_]+\}/.test(statement)) {
        findings.push({ kind: 'mixed', id: c.id, message: `${p.title}: statement placeholders could not be filled from the counts; not recorded.`, scope: repoIds });
        continue;
      }
      let tier: Tier | null = null;
      let reason = '';
      if (allDeclared) {
        if (sites > 0 && ratio < th.declaredFollowed) {
          findings.push({
            kind: 'declared-but-not-followed',
            id: `declared-not-followed.${slug(c.id)}`,
            message: `Declared but not followed: ${p.title} (${g.decl.map((d) => d.sources[0]).join('; ')}${g.decl[0].severity ? `, level ${g.decl[0].severity}` : ''}) holds at ${Math.round(ratio * 100)}% of ${sites} sites (${sites - conforming} without). Not a standard; decide whether to enforce it with a baseline or drop it.`,
            scope: repoIds.length === reposWithFiles.length ? ['*'] : repoIds,
            counts: { sites, conforming, ratio: round(ratio) },
            sources: g.decl.flatMap((d) => d.sources),
            examples: examplesBothWays(g.tally, g.variant, others, c, repoIds),
            proposal: g.decl[0].tool === 'eslint' ? 'eslint-baseline' : 'config-fix',
          });
          continue;
        }
        tier = 'declared';
        reason = `declared in ${g.decl.length} unit(s) and followed at ${Math.round(ratio * 100)}%`;
      } else {
        const overlapOk = !p.overlapping || (g.tally.discriminating[g.variant] ?? 0) >= Math.max(th.discriminating.min, Math.ceil(th.discriminating.share * sites));
        if (!overlapOk) {
          informational.push({ id: c.id, title: p.title, byVariant: { ...c.total.byVariant }, sites: c.total.sites, note: `ambiguous: too few sites distinguish "${g.variant}" from the other variants` });
          continue;
        }
        if (v.isDefault) {
          informational.push({ id: c.id, title: p.title, byVariant: { ...g.tally.byVariant }, sites, note: `the community default "${g.variant}" is followed at ${Math.round(ratio * 100)}%; defaults are not recorded unless a config declares them` });
          continue;
        }
        const pk = g.tally.packages.size;
        if (ratio >= th.strong.conformance && sites >= th.strong.sites && pk >= th.strong.packages) {
          tier = 'counted-strong';
          reason = `${Math.round(ratio * 100)}% of ${sites} sites in ${pk} package(s)`;
        } else if (ratio >= th.corroborated.conformance && sites >= th.corroborated.sites && prose.length) {
          tier = 'counted-strong';
          reason = `followed at 100% of ${sites} sites and written down (${prose[0].file}:${prose[0].line})`;
        } else if (ratio >= th.majority.conformance && sites >= th.majority.sites) {
          tier = 'counted-majority';
          reason = `${Math.round(ratio * 100)}% of ${sites} sites`;
        } else {
          findings.push({
            kind: 'mixed',
            id: c.id,
            message: `${p.title}: "${g.variant}" at ${Math.round(ratio * 100)}% of ${sites} sites in ${pk} package(s); below the thresholds in use, not a standard.`,
            scope: repoIds,
            counts: { sites, conforming, ratio: round(ratio) },
          });
          continue;
        }
      }
      if (p.formatterOwned && repoIds.every((r) => allSettings.some((s) => s.repoId === r && (s.tool === 'prettier' || s.tool === 'biome')))) {
        formatterFolded.push({ probe: p, variant: g.variant, repoIds, tally: g.tally });
        continue;
      }
      const id = p.polarity === 'either' ? `${c.id}-${slug(g.variant)}` : c.id;
      const prev = input.previous.get(id);
      const provenance: Provenance[] = [];
      for (const d of g.decl) for (const s of d.sources) provenance.push({ kind: d.tool === 'ci' ? 'ci' : d.tool === 'commitlint' ? 'hook' : 'config', ref: s });
      provenance.push({ kind: p.engine === 'subjects' ? 'history' : 'count', ref: `probe ${p.id}${p.origin && p.origin !== 'library' ? ` (${p.origin})` : ''}: ${conforming}/${sites} sites follow "${g.variant}"` });
      for (const s of prose) usedSentences.add(sentenceKey(s));
      for (const s of prose.slice(0, 3)) {
        provenance.push({ kind: s.kind === 'agent-file' ? 'agent-file' : 'doc', ref: `${s.file}:${s.line}`, quote: s.text });
      }
      const decl0 = g.decl[0];
      // The declared severity wins per unit: warn only when every unit that declares the rule declares warn.
      const declaring = g.sevs.filter((x) => x.sev);
      const allWarn = declaring.length > 0 && declaring.every((x) => x.sev === 'warn');
      const mode: CheckMode = tier === 'declared' || tier === 'counted-strong' ? (allWarn ? 'warn' : 'block') : 'warn';
      const warnUnits = declaring.filter((x) => x.sev === 'warn').map((x) => unitLabel(x.unit, repoById));
      const mixedSeverity = mode === 'block' && warnUnits.length > 0;
      const finalStatement = mixedSeverity ? `${statement} (The lint config declares it as a warning, not an error, in ${warnUnits.join(', ')}.)` : statement;
      if (declaring.length && allWarn && tier === 'counted-strong') {
        const w = allSettings.find((x) => x.tool === 'eslint' && x.severity === 'warn' && (p.declaredBy?.eslint ?? []).includes(x.key) && g.units.some((u) => u.repoId === x.repoId));
        if (w) provenance.push({ kind: 'config', ref: `eslint:${w.source} ${w.key}: warn (declared severity kept; a count never raises it)` });
      }
      if (mixedSeverity) provenance.push({ kind: 'config', ref: `lint config declares warn in ${warnUnits.join(', ')} and error elsewhere: block kept for the error units` });
      const ctype: CheckType = tier === 'declared' && decl0?.tool === 'eslint' ? 'eslint' : decl0?.tool === 'ci' ? 'config' : engineCheckType(p);
      const rec: LedgerRecord = {
        id,
        statement: finalStatement,
        family: p.family,
        scope: scopeOf(g.units, units.length),
        tier,
        confidence: round(tier === 'declared' ? Math.max(0.9, wilsonLower(conforming, sites)) : wilsonLower(conforming, sites)),
        evidence: {
          sites,
          conforming,
          packages: g.tally.packages.size,
          examples: examplesBothWays(g.tally, g.variant, others, c, repoIds),
          sources: [...new Set([...g.decl.flatMap((d) => d.sources), `probe:${p.file}`, ...prose.slice(0, 3).map((s) => `${s.kind}:${s.file}#L${s.line}`)])],
        },
        check: { type: ctype, mode, ref: `checks/${id}.json`, fixText },
        conflicts: [],
        provenance,
        history: { firstSeen: prev?.history.firstSeen ?? input.now, lastCounted: input.now, disputes: prev?.history.disputes ?? 0 },
      };
      reasons.set(id, reason);
      checkData.set(id, {
        probe: p,
        variant: g.variant,
        others,
        data: { ...c.checkData, params },
        offFiles: [...new Set(g.decl.flatMap((d) => d.offFiles))],
        eslintRule: decl0?.tool === 'eslint' ? p.declaredBy?.eslint?.[0] : undefined,
        baseline: baselineOf(c, g.variant, others, repoIds),
      });
      made.push({ rec, g });
    }
    // Conflicts: every side lists the others, with both counts.
    if (made.length > 1) {
      for (const a of made) {
        for (const b of made) {
          if (a === b) continue;
          const bScope = b.rec.scope.paths?.length ? `${b.rec.scope.repos.join(',')}:${b.rec.scope.paths.join(',')}` : b.rec.scope.repos.join(',');
          const conf: Conflict = { scope: bScope, statement: b.rec.statement, counts: { a: a.rec.evidence.conforming, b: b.rec.evidence.conforming } };
          a.rec.conflicts.push(conf);
        }
      }
      findings.push({
        kind: 'conflict',
        id: `conflict.${slug(c.id)}`,
        message: `${p.title} differs between repositories; each side is a scoped record, never an average: ${made.map((m) => `${m.rec.scope.repos.map((r) => repoById.get(r)?.name ?? r).join(', ')}: ${m.g.variant} (${m.rec.evidence.conforming}/${m.rec.evidence.sites})`).join(' vs ')}.`,
        scope: made.flatMap((m) => m.rec.scope.repos),
        sources: made.map((m) => m.rec.id),
      });
    }
    for (const m of made) records.push(m.rec);
  }

  // Formatter record: options a formatter config owns, folded into one record per formatter.
  if (formatterFolded.length) {
    const byRepo = new Map<string, Set<string>>();
    for (const f of formatterFolded) for (const r of f.repoIds) (byRepo.get(r) ?? byRepo.set(r, new Set()).get(r)!).add(`${f.probe.id}=${f.variant}`);
    const repoIds = [...byRepo.keys()];
    const common = formatterFolded.filter((f) => repoIds.every((r) => byRepo.get(r)!.has(`${f.probe.id}=${f.variant}`)));
    const tools = new Set(allSettings.filter((s) => repoIds.includes(s.repoId) && (s.tool === 'prettier' || s.tool === 'biome')).map((s) => s.tool));
    const sources = [...new Set(allSettings.filter((s) => repoIds.includes(s.repoId) && (s.tool === 'prettier' || s.tool === 'biome')).map((s) => `${s.tool}:${repoPrefix(repoById.get(s.repoId)!)}${s.source}`))];
    const scripts = new Set<string>();
    for (const r of input.repos.filter((x) => repoIds.includes(x.id))) {
      const root = r.packages.find((p) => p.dir === '');
      for (const n of ['format', 'format:check', 'prettier', 'fmt']) if (root?.scripts[n]) scripts.add(`${r.packageManager === 'unknown' ? 'npm' : r.packageManager} run ${n}`);
    }
    const seen = new Set<string>();
    const facts = common
      .filter((f) => !seen.has(f.probe.id) && seen.add(f.probe.id))
      .map((f) => fillTemplate(variantByName(f.probe, f.variant)?.statement ?? '', {}).replace(/\.$/, '').toLowerCase());
    const sites = common.reduce((n, f) => n + f.tally.sites, 0);
    const conforming = common.reduce((n, f) => n + (f.tally.byVariant[f.variant] ?? 0), 0);
    const id = 'format.formatter';
    // Options read from a Vite+ config (`fmt` in vite.config / vitest.config) are Prettier-compatible but not Prettier.
    const fmtSources = allSettings.filter((s) => repoIds.includes(s.repoId) && s.tool === 'prettier').map((s) => s.source);
    const viteFmt = fmtSources.length > 0 && fmtSources.every((x) => /(^|\/)vite(st)?\.config\.[cm]?[jt]s$/.test(x));
    const toolName = viteFmt && tools.size === 1 ? `the formatter configured in ${fmtSources[0]}` : [...tools].map((t) => (t === 'prettier' ? 'Prettier' : 'Biome')).join(' and ') || 'the formatter';
    records.push({
      id,
      statement: `Formatting is owned by ${toolName} with the repository's config${facts.length ? ` (${facts.join('; ')})` : ''}; format with ${[...scripts].filter((s) => !s.endsWith(':check'))[0] ?? 'the formatter'} rather than by hand.`,
      family: 'format',
      scope: repoIds.length === reposWithFiles.length ? { repos: ['*'] } : { repos: repoIds },
      tier: 'declared',
      confidence: round(Math.max(0.9, wilsonLower(conforming, sites))),
      evidence: { sites, conforming, packages: new Set(common.flatMap((f) => [...f.tally.packages])).size, examples: [], sources },
      check: { type: 'config', mode: 'block', ref: `checks/${id}.json`, fixText: `Run ${[...scripts].join(' / ') || 'the formatter'} and keep its output.` },
      conflicts: [],
      provenance: [...sources.map((s) => ({ kind: 'config' as const, ref: s })), ...common.map((f) => ({ kind: 'count' as const, ref: `probe ${f.probe.id}: ${f.tally.byVariant[f.variant] ?? 0}/${f.tally.sites} follow "${f.variant}"` }))],
      history: { firstSeen: input.previous.get(id)?.history.firstSeen ?? input.now, lastCounted: input.now, disputes: input.previous.get(id)?.history.disputes ?? 0 },
    });
    checkData.set(id, { data: { scripts: [...scripts] } });
  }

  // Declared ESLint rules that no probe counts (explicit, error level, the same in every repo that declares them).
  const probeRules = new Set(input.counted.flatMap((c) => c.probe.declaredBy?.eslint ?? []));
  const explicitErr = allSettings.filter((s) => s.tool === 'eslint' && s.via === 'static' && s.severity === 'error' && !probeRules.has(s.key) && (!s.files || s.files.every((f) => /^\*\*\/\*\.(\{?[\w,]+\}?)$/.test(f))));
  const byRule = new Map<string, DeclaredSetting[]>();
  for (const s of explicitErr) (byRule.get(s.key) ?? byRule.set(s.key, []).get(s.key)!).push(s);
  for (const [rule, ss] of byRule) {
    const repoIds = [...new Set(ss.map((s) => s.repoId))];
    const opts = ss.find((s) => typeof s.value === 'string' && s.value)?.value as string | undefined;
    // When the probe for this rule exists but could not count (ast-grep missing), keep its id and statement.
    const up = (input.uncounted ?? []).find((p) => (p.declaredBy?.eslint ?? []).includes(rule));
    const upV0 = up?.variants.find((v) => v.statement);
    // A template that needs counted data ({LOGGER}) cannot be filled without the count: use the rule's own wording.
    const upV = upV0 && !/\{[A-Z0-9_]+\}/.test(upV0.statement ?? '') ? upV0 : undefined;
    const id = up && upV0 ? (up.polarity === 'either' ? `${up.id}-${slug(upV0.name)}` : up.id) : `lint.${slug(rule.replace(/^@/, ''))}`;
    if (up && upV0) reasons.set(id, `declared; not counted (${up.engine} scanner missing)`);
    records.push({
      id,
      statement: upV?.statement ?? `ESLint rule \`${rule}\` is on at error level${opts ? ` (options ${opts.replace(/,\s*$/, '')})` : ''}; code must pass it without disable comments.`,
      family: up?.family ?? 'lint',
      scope: declaredScope(ss),
      tier: 'declared',
      confidence: 0.9,
      evidence: { sites: 0, conforming: 0, packages: 0, examples: [], sources: ss.map((s) => `eslint:${repoPrefix(repoById.get(s.repoId)!)}${s.source}`) },
      check: { type: 'eslint', mode: 'block', ref: `checks/${id}.json`, fixText: upV?.fixText ?? `Fix what \`${rule}\` reports (run the repo's lint script); do not add eslint-disable comments.` },
      conflicts: [],
      provenance: ss.map((s) => ({ kind: 'config' as const, ref: `eslint:${repoPrefix(repoById.get(s.repoId)!)}${s.source}` })),
      history: { firstSeen: input.previous.get(id)?.history.firstSeen ?? input.now, lastCounted: input.now, disputes: input.previous.get(id)?.history.disputes ?? 0 },
    });
    checkData.set(id, { data: { eslintRule: rule }, eslintRule: rule });
  }

  // TypeScript strictness.
  const strict = allSettings.filter((s) => s.tool === 'tsconfig' && s.key === 'strict' && s.value === true);
  if (strict.length) {
    const repoIds = [...new Set(strict.map((s) => s.repoId))];
    const id = 'types.strict';
    records.push({
      id,
      statement: 'TypeScript compiles in strict mode (tsconfig `strict: true`); fix type errors instead of loosening the config or adding `@ts-ignore`.',
      family: 'types',
      scope: declaredScope(strict),
      tier: 'declared',
      confidence: 0.95,
      evidence: { sites: 0, conforming: 0, packages: 0, examples: [], sources: [...new Set(strict.map((s) => `tsconfig:${repoPrefix(repoById.get(s.repoId)!)}${s.source.split(' -> ').pop()}`))] },
      check: { type: 'config', mode: 'block', ref: `checks/${id}.json`, fixText: "Run the repo's typecheck script and fix the errors it reports; do not edit tsconfig to silence them." },
      conflicts: [],
      provenance: [...new Set(strict.map((s) => `${repoPrefix(repoById.get(s.repoId)!)}${s.source}`))].map((ref) => ({ kind: 'config' as const, ref })),
      history: { firstSeen: input.previous.get(id)?.history.firstSeen ?? input.now, lastCounted: input.now, disputes: input.previous.get(id)?.history.disputes ?? 0 },
    });
    checkData.set(id, { data: {} });
  }

  // Review-derived records.
  for (const [repoId, h] of input.histories) {
    for (const cl of h.reviews?.clusters ?? []) {
      const ok = (cl.accepted >= 3 && cl.prs >= 2 && cl.reviewers >= 2) || (cl.codeOwner && cl.accepted >= 1);
      if (!ok || !cl.summary) continue;
      const inj = scanInjection(cl.summary);
      if (inj.length) {
        findings.push({ kind: 'judgment-rejected', id: `review.${slug(cl.id)}`, message: `Review cluster "${cl.id}" rejected: its text matches ${inj.join(', ')}.`, scope: [repoId] });
        continue;
      }
      const existing = cl.probe ? records.find((r) => r.id === cl.probe || r.id.startsWith(`${cl.probe}-`)) : undefined;
      if (existing) {
        existing.provenance.push({ kind: 'review', ref: `${h.reviews!.file}#${cl.id}: ${cl.accepted} accepted of ${cl.comments} over ${cl.prs} PRs, ${cl.reviewers} reviewers` });
        continue;
      }
      const fam = (cl.family as StandardFamily) || familyOfSentence(cl.summary);
      const id = `${fam}.review-${slug(cl.id).slice(0, 40)}`;
      records.push({
        id,
        statement: cl.summary,
        family: fam,
        scope: { repos: [repoId] },
        tier: 'review-derived',
        confidence: 0.6,
        evidence: { sites: cl.comments, conforming: cl.accepted, packages: 0, examples: [], sources: [`review:${h.reviews!.file}#${cl.id}`] },
        check: { type: 'judgment', mode: 'judgment', ref: `checks/${id}.json`, fixText: cl.summary },
        conflicts: [],
        provenance: [{ kind: 'review', ref: `${cl.accepted} accepted of ${cl.comments} comments over ${cl.prs} PRs, ${cl.reviewers} reviewers${cl.codeOwner ? ', code owner' : ''}`, quote: cl.examples[0] }],
        history: { firstSeen: input.previous.get(id)?.history.firstSeen ?? input.now, lastCounted: input.now, disputes: input.previous.get(id)?.history.disputes ?? 0 },
      });
      checkData.set(id, { data: { judgment: true } });
    }
  }

  // Single-source records: normative sentences in team docs that no count proves.
  const docSentences = input.prose.filter((s) => s.kind === 'doc' && !/README\.md$/i.test(s.file) && isNormative(s.text) && !usedSentences.has(sentenceKey(s)));
  const byText = new Map<string, ProseSentence[]>();
  for (const s of docSentences) {
    const k = s.text.toLowerCase().replace(/`[^`]*`/g, (m) => m.toLowerCase()).replace(/\s+/g, ' ').trim();
    (byText.get(k) ?? byText.set(k, []).get(k)!).push(s);
  }
  for (const [, ss] of byText) {
    const s0 = ss[0];
    const inj = scanInjection(s0.text);
    if (inj.length) {
      findings.push({ kind: 'judgment-rejected', id: `prose.${slug(s0.text).slice(0, 40)}`, message: `Written rule in ${s0.file}:${s0.line} not used: it matches ${inj.join(', ')}.`, scope: [s0.repoId ?? '*'] });
      continue;
    }
    const repoIds = [...new Set(ss.map((s) => s.repoId).filter((x): x is string => !!x))];
    const fam = familyOfSentence(s0.text);
    const id = `${fam}.${slug(s0.text.replace(/`/g, '')).split('-').slice(0, 7).join('-')}`;
    if (records.some((r) => r.id === id)) continue;
    records.push({
      id,
      statement: s0.text,
      family: fam,
      scope: repoIds.length === reposWithFiles.length || !repoIds.length ? { repos: ['*'] } : { repos: repoIds },
      tier: 'single-source',
      confidence: 0.4,
      evidence: { sites: 0, conforming: 0, packages: 0, examples: [], sources: ss.map((s) => `doc:${s.file}#L${s.line}`) },
      check: { type: 'judgment', mode: 'judgment', ref: `checks/${id}.json`, fixText: s0.text },
      conflicts: [],
      provenance: ss.map((s) => ({ kind: 'doc' as const, ref: `${s.file}:${s.line}`, quote: s.text })),
      history: { firstSeen: input.previous.get(id)?.history.firstSeen ?? input.now, lastCounted: input.now, disputes: input.previous.get(id)?.history.disputes ?? 0 },
    });
    checkData.set(id, { data: { judgment: true } });
  }

  records.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  return { records, findings, checkData, informational, usedSentences, reasons };
}
