/**
 * Counting: run every probe over the full estate and tally sites per
 * variant, per repository and per package, with examples both ways.
 *
 * ast-grep probes run as one `ast-grep scan --json=stream` per repository
 * with every compiled rule; regex probes (file names, folders, content,
 * commit subjects) and built-in probes run in process. When ast-grep is
 * absent, its probes are not counted and the scanner is reported missing.
 */
import * as path from 'node:path';
import type { Example, ScannerStatus } from '../types';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import type { ProbeSpec, ScannedFile, VariantTally } from './model';
import type { WorkspaceInventory } from './inventory';
import type { DeclaredResult } from './declared';
import type { RepoHistory } from './history';
import { compileAstRules, splitRuleId } from './probes';
import { scanRules, type AstGrepBinary } from './astgrep';
import { inScope } from './glob';
import { readCached, runBuiltin } from './builtins';
import { sqlGate, type DomainGate } from './domains';

export const EXAMPLES_PER_VARIANT = 3;

export interface CountedProbe {
  /** Record id stem: the probe id, or `<probe id>-<sub>` for built-ins that split (one per driver). */
  id: string;
  probe: ProbeSpec;
  total: VariantTally;
  perRepo: Map<string, VariantTally>;
  perPackage: Map<string, VariantTally>;
  params: Record<string, string>;
  checkData: Record<string, unknown>;
  /** Every site per variant (workspace-relative file, line, cleaned snippet), capped; baselines come from here. */
  sitesByVariant: Map<string, Array<{ file: string; line: number; snippet?: string; repoId: string }>>;
}

export const MAX_BASELINE = 1000;

export interface CountResult {
  counted: CountedProbe[];
  scanners: ScannerStatus[];
  errors: string[];
  notCounted: Array<{ probe: string; reason: string }>;
  astGrepMs: number;
  /** Domain gates that skipped probes: a domain probe counts only where the domain exists. */
  gates: Array<DomainGate & { skipped: string[] }>;
}

export function emptyTally(): VariantTally {
  return { sites: 0, byVariant: {}, discriminating: {}, packages: new Set<string>(), examples: {}, captures: {} };
}

export function cleanSnippet(s: string | undefined, max = 160): string | undefined {
  if (s === undefined) return undefined;
  const t = redactText(stripHiddenUnicode(s)).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

interface Site {
  file: ScannedFile;
  line: number;
  variants: Set<string>;
  snippet?: string;
  captures: Record<string, string>;
}

function addToTally(t: VariantTally, s: Site, display: string, capture?: string): void {
  t.sites++;
  t.packages.add(s.file.pkg);
  const vs = [...s.variants];
  for (const v of vs) {
    t.byVariant[v] = (t.byVariant[v] ?? 0) + 1;
    const ex = (t.examples[v] ??= []);
    if (ex.length < EXAMPLES_PER_VARIANT) ex.push({ file: display, line: s.line, snippet: cleanSnippet(s.snippet), conforms: false });
    if (capture && s.captures[capture] !== undefined) {
      const c = (t.captures[v] ??= {});
      const val = s.captures[capture];
      c[val] = (c[val] ?? 0) + 1;
    }
  }
  if (vs.length === 1) t.discriminating[vs[0]] = (t.discriminating[vs[0]] ?? 0) + 1;
}

export class Counter {
  readonly perProbe = new Map<string, Map<string, Site>>();
  constructor(private ws: WorkspaceInventory) {}

  displayPath(f: ScannedFile): string {
    const repo = this.ws.repos.find((r) => r.repo.id === f.repoId);
    const prefix = repo && repo.repo.relPath !== '.' ? repo.repo.relPath + '/' : '';
    return prefix + f.rel;
  }

  add(id: string, key: string, file: ScannedFile, line: number, variant: string, snippet?: string, captures: Record<string, string> = {}): void {
    let m = this.perProbe.get(id);
    if (!m) this.perProbe.set(id, (m = new Map()));
    const s = m.get(key);
    if (s) {
      s.variants.add(variant);
      Object.assign(s.captures, captures);
      return;
    }
    m.set(key, { file, line, variants: new Set([variant]), snippet, captures: { ...captures } });
  }

  tally(id: string, probe: ProbeSpec, params: Record<string, string> = {}, checkData: Record<string, unknown> = {}): CountedProbe {
    const c: CountedProbe = { id, probe, total: emptyTally(), perRepo: new Map(), perPackage: new Map(), params, checkData, sitesByVariant: new Map() };
    const sites = [...(this.perProbe.get(id)?.values() ?? [])].sort((a, b) => (a.file.abs === b.file.abs ? a.line - b.line : a.file.abs < b.file.abs ? -1 : 1));
    for (const s of sites) {
      const display = this.displayPath(s.file);
      for (const v of s.variants) {
        const l = c.sitesByVariant.get(v) ?? [];
        if (l.length < MAX_BASELINE) l.push({ file: display, line: s.line, snippet: cleanSnippet(s.snippet), repoId: s.file.repoId });
        c.sitesByVariant.set(v, l);
      }
      addToTally(c.total, s, display, probe.capture);
      let r = c.perRepo.get(s.file.repoId);
      if (!r) c.perRepo.set(s.file.repoId, (r = emptyTally()));
      addToTally(r, s, display, probe.capture);
      let p = c.perPackage.get(s.file.pkg);
      if (!p) c.perPackage.set(s.file.pkg, (p = emptyTally()));
      addToTally(p, s, display, probe.capture);
    }
    return c;
  }
}

function regexOf(pattern: string, flags = '', global = false): RegExp {
  const f = new Set((flags + (global ? 'g' : '')).split(''));
  return new RegExp(pattern, [...f].join(''));
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function countRegexProbe(p: ProbeSpec, ws: WorkspaceInventory, counter: Counter, histories: Map<string, RepoHistory>): Record<string, string> {
  const params: Record<string, string> = {};
  if (p.engine === 'subjects') {
    const types: Record<string, number> = {};
    let maxLen = 0;
    for (const inv of ws.repos) {
      const h = histories.get(inv.repo.id);
      if (!h) continue;
      const root = inv.repo.packages.find((x) => x.dir === '') ?? inv.repo.packages[0];
      const pseudo: ScannedFile = { abs: inv.repo.path, rel: '(git log)', repoId: inv.repo.id, pkg: root.id, bytes: 0, kind: 'other', isTest: false };
      for (const c of h.commits) {
        if (c.merge || /^Merge (branch|pull request|remote-tracking)/.test(c.subject)) continue;
        for (const v of p.variants) {
          if (v.pattern && regexOf(v.pattern, v.flags).test(c.subject)) counter.add(p.id, `${inv.repo.id}:${c.sha}`, { ...pseudo, rel: `(commit ${c.sha.slice(0, 7)})` }, 0, v.name, c.subject);
        }
      }
      for (const [t, n] of Object.entries(h.stats.types)) types[t] = (types[t] ?? 0) + n;
      maxLen = Math.max(maxLen, h.stats.maxLength);
    }
    params.TYPES = Object.entries(types)
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .join(', ');
    params.MAXLEN = String(maxLen <= 72 ? 72 : Math.ceil(maxLen / 10) * 10);
    params.OBSERVED_MAXLEN = String(maxLen);
    return params;
  }
  for (const inv of ws.repos) {
    if (p.engine === 'path') {
      const target = String(p.params?.target ?? 'dirname');
      const seen = new Set<string>();
      for (const f of inv.files) {
        if (!inScope(f.rel, p.files, p.exclude)) continue;
        if (target === 'src-folder') {
          const m = /(^|\/)src\/(.*)$/.exec(f.rel);
          if (!m) continue;
          const parts = m[2].split('/');
          const t = parts.length > 1 ? parts[0] : '';
          for (const v of p.variants) if (v.pattern && regexOf(v.pattern, v.flags).test(t)) counter.add(p.id, f.abs, f, 1, v.name, `src/${t}`);
          continue;
        }
        const parts = f.rel.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (seen.has(dir)) continue;
          seen.add(dir);
          const name = parts[i - 1];
          if (name.startsWith('.') || /^__\w+__$/.test(name)) continue;
          for (const v of p.variants) if (v.pattern && regexOf(v.pattern, v.flags).test(name)) counter.add(p.id, `${inv.repo.id}:${dir}`, f, 0, v.name, dir + '/');
        }
      }
      continue;
    }
    for (const f of inv.files) {
      if (!inScope(f.rel, p.files, p.exclude)) continue;
      if (p.engine === 'filename') {
        const name = f.rel.split('/').pop()!;
        for (const v of p.variants) if (v.pattern && regexOf(v.pattern, v.flags).test(name)) counter.add(p.id, f.abs, f, 0, v.name, name);
        continue;
      }
      if (p.engine === 'content') {
        const text = readCached(f.abs);
        if (!text) continue;
        const unit = String(p.params?.unit ?? 'file');
        if (unit === 'match') {
          for (const v of p.variants) {
            if (!v.pattern) continue;
            const re = regexOf(v.pattern, v.flags, true);
            let m: RegExpExecArray | null;
            while ((m = re.exec(text))) {
              const line = lineOf(text, m.index);
              const lineText = text.split('\n')[line - 1] ?? m[0];
              counter.add(p.id, `${f.abs}:${m.index}`, f, line, v.name, lineText);
              if (m[0].length === 0) re.lastIndex++;
            }
          }
        } else {
          for (const v of p.variants) {
            if (!v.pattern) continue;
            const m = regexOf(v.pattern, v.flags).exec(text);
            if (m) counter.add(p.id, f.abs, f, lineOf(text, m.index), v.name, (text.split('\n')[lineOf(text, m.index) - 1] ?? '').slice(0, 120));
          }
        }
      }
    }
  }
  return params;
}

/** Count every probe over the workspace. */
export async function countProbes(
  ws: WorkspaceInventory,
  probes: ProbeSpec[],
  ast: AstGrepBinary | null,
  histories: Map<string, RepoHistory>,
  declared: Map<string, DeclaredResult>,
  progress?: (line: string) => void,
): Promise<CountResult> {
  const counter = new Counter(ws);
  const counted: CountedProbe[] = [];
  const errors: string[] = [];
  const notCounted: CountResult['notCounted'] = [];
  const scanners: ScannerStatus[] = [];
  let astGrepMs = 0;

  // Domain gate: SQL probes count only in a repository that has SQL.
  const gates: CountResult['gates'] = [];
  const sql = sqlGate(ws);
  const sqlIds = probes.filter((p) => p.family === 'sql').map((p) => p.id);
  if (!sql.present && sqlIds.length) {
    gates.push({ ...sql, skipped: sqlIds });
    probes = probes.filter((p) => !sqlIds.includes(p.id));
  }

  // ast-grep probes.
  const astProbes = probes.filter((p) => p.engine === 'ast-grep');
  if (astProbes.length) {
    if (!ast) {
      scanners.push({ name: 'ast-grep', available: false, note: `${astProbes.length} syntax probes not counted; install the optional @ast-grep/cli dependency (npm ci in the harness folder)` });
      for (const p of astProbes) notCounted.push({ probe: p.id, reason: 'ast-grep not found' });
    } else {
      scanners.push({ name: 'ast-grep', available: true, version: ast.version, note: `via ${ast.via}` });
      const rules = astProbes.flatMap(compileAstRules);
      const byId = new Map(astProbes.map((p) => [p.id, p]));
      for (const inv of ws.repos) {
        const fileMap = new Map(inv.files.map((f) => [path.resolve(f.abs), f]));
        const res = await scanRules(ast, rules, [inv.repo.path], { cwd: inv.repo.path });
        astGrepMs += res.durationMs;
        if (!res.ok) {
          errors.push(`ast-grep on ${inv.repo.relPath}: ${res.error}`);
          continue;
        }
        let n = 0;
        for (const m of res.matches) {
          const f = fileMap.get(path.resolve(inv.repo.path, m.file));
          if (!f) continue;
          const { probe, variant } = splitRuleId(m.ruleId);
          const p = byId.get(probe);
          if (!p || !inScope(f.rel, p.files, p.exclude)) continue;
          n++;
          counter.add(p.id, `${f.abs}:${m.startByte}:${m.endByte}`, f, m.line + 1, variant, m.lines.split('\n')[0], m.captures);
        }
        progress?.(`discover: probes ${inv.repo.relPath}: ast-grep ${res.matches.length} matches (${n} in scope) in ${res.durationMs} ms`);
      }
      for (const p of astProbes) counted.push(counter.tally(p.id, p));
    }
  }

  // Regex probes.
  for (const p of probes.filter((x) => ['filename', 'path', 'content', 'subjects'].includes(x.engine))) {
    try {
      const params = countRegexProbe(p, ws, counter, histories);
      counted.push(counter.tally(p.id, p, params));
    } catch (e) {
      errors.push(`probe ${p.id}: ${(e as Error).message}`);
    }
  }

  // Built-in probes.
  for (const p of probes.filter((x) => x.engine === 'builtin')) {
    try {
      for (const out of runBuiltin(p, { ws, declared })) {
        const id = out.sub ? `${p.id}-${out.sub}` : p.id;
        for (const s of out.sites) for (const v of s.variants) counter.add(id, s.key, s.file, s.line, v, s.snippet);
        counted.push(counter.tally(id, p, out.params, out.check));
      }
    } catch (e) {
      errors.push(`probe ${p.id}: ${(e as Error).message}`);
    }
  }
  return { counted, scanners, errors, notCounted, astGrepMs, gates };
}
