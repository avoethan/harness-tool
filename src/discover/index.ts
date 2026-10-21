/**
 * `harness discover`: the pipeline (DESIGN 2.1).
 *
 *   1 inventory          repos, packages, files, documented configs, CI, agent files
 *   2 declared settings  static config reading; effective config for sampled files
 *   3 history            commit subjects, reverts, lint-fix commits, CODEOWNERS, saved reviews
 *   4 graph              dependency-cruiser / knip from each repo's node_modules (never installed)
 *   5 probes             the probe library (+ proven-by-count judgment candidates) over every file
 *   6 tiers              declared / counted-strong / counted-majority / review-derived / single-source
 *   7 emit               ledger.json, checks/, findings.json, db-candidates.json, inventory.json, discover.md
 *   8 judgment           optional bundle for the driving agent (--judgment)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ledger, LedgerRecord, ScannerStatus } from '../types';
import { instrument } from '../lib/log';
import { readJsonOr, writeJson } from '../lib/fsx';
import { harnessHome } from '../lib/paths';
import type { DeclaredSetting, DiscoverFinding, EffectiveConfigRun, ProbeSpec, Thresholds } from './model';
import { inventoryWorkspace, type WorkspaceInventory } from './inventory';
import { collectDeclared, type DeclaredResult } from './declared';
import { repoHistory, type RepoHistory } from './history';
import { graphScan, type GraphResult } from './graph';
import { loadProbeLibrary } from './probes';
import { findAstGrep } from './astgrep';
import { countProbes } from './scan';
import { collectProse } from './prose';
import { buildRecords, thresholdsFor, type TierOutput } from './tiers';
import { collectDbCandidates, type DbCandidate } from './dbcandidates';
import { emitAll, ledgerDir, type EmitPaths } from './emit';
import { createJudgmentBundle, importJudgment, type BundleSummary } from './judgment';
import { clearTextCache } from './builtins';

export interface DiscoverOptions {
  root: string;
  maxFiles?: number;
  /** Run the repositories' own eslint/tsc/dependency-cruiser/knip (default true). */
  exec?: boolean;
  judgment?: boolean;
  importJudgment?: string;
  probesDir?: string;
  progress?: (line: string) => void;
  /** Write files (default true); tests may skip. */
  write?: boolean;
}

export interface ImportedSummary {
  id: string;
  accepted: string[];
  rejected: Array<{ id: string; reason: string }>;
  proven: string[];
}

export interface DiscoverResult {
  ledger: Ledger;
  findings: DiscoverFinding[];
  thresholds: Thresholds;
  ws: WorkspaceInventory;
  tiers: TierOutput;
  effective: EffectiveConfigRun[];
  graph: GraphResult[];
  histories: Map<string, RepoHistory>;
  dbCandidates: DbCandidate[];
  notCounted: Array<{ probe: string; reason: string }>;
  probeErrors: string[];
  paths?: EmitPaths;
  judgment?: { bundle?: BundleSummary; imported?: ImportedSummary };
  durationMs: number;
}

export async function runDiscover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const t0 = Date.now();
  clearTextCache();
  const progress = opts.progress ?? (() => undefined);
  const exec = opts.exec !== false;
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`workspace root not found: ${root}`);

  const ws = inventoryWorkspace(root, { maxFiles: opts.maxFiles, progress });
  const declared = new Map<string, DeclaredResult>();
  const effective: EffectiveConfigRun[] = [];
  const histories = new Map<string, RepoHistory>();
  const graph: GraphResult[] = [];
  for (const r of ws.repos) {
    const d = collectDeclared(r, { exec });
    declared.set(r.repo.id, d);
    effective.push(...d.effective);
    const h = repoHistory(r);
    histories.set(r.repo.id, h);
    const g = graphScan(r, { exec });
    graph.push(...g);
    progress(`discover: ${r.repo.relPath}: ${d.settings.length} declared settings, ${h.stats.total} commits, graph ${g.map((x) => `${x.tool} ${x.ran ? 'ran' : x.available ? 'not run' : 'absent'}`).join(', ')}`);
  }

  const lib = loadProbeLibrary(opts.probesDir);
  const probes: ProbeSpec[] = [...lib.probes];
  const ast = findAstGrep();
  let imported: ImportedSummary | undefined;
  if (opts.importJudgment) {
    const im = importJudgment(opts.importJudgment, ast);
    if (im.error) throw new Error(`import-judgment: ${im.error}`);
    for (const p of im.probes) if (!probes.some((x) => x.id === p.id)) probes.push(p);
    imported = { id: opts.importJudgment, accepted: im.probes.map((p) => p.id), rejected: im.rejected, proven: [] };
  }
  // Judgment results imported earlier stay part of the probe set: re-validated and re-counted on every run.
  const importedFile = path.join(harnessHome(), 'judgment', 'imported.json');
  const priorIds = readJsonOr<{ ids?: string[] }>(importedFile, {}).ids ?? [];
  for (const id of priorIds.filter((x) => x !== opts.importJudgment)) {
    const im = importJudgment(id, ast);
    for (const p of im.probes) if (!probes.some((x) => x.id === p.id)) probes.push(p);
  }
  if (opts.importJudgment && opts.write !== false && !priorIds.includes(opts.importJudgment)) writeJson(importedFile, { version: 1, ids: [...priorIds, opts.importJudgment] });

  const counted = await countProbes(ws, probes, ast, histories, declared, progress);
  const pkgCount = ws.repos.reduce((n, r) => n + r.repo.packages.length, 0);
  const thresholds = thresholdsFor(ws.totalFiles, pkgCount);
  const previous = new Map<string, LedgerRecord>();
  const prevLedger = readJsonOr<Ledger | null>(path.join(ledgerDir(), 'ledger.json'), null);
  if (prevLedger && Array.isArray(prevLedger.records) && prevLedger.workspaceRoot === root) for (const r of prevLedger.records) previous.set(r.id, r);
  const now = new Date().toISOString();
  const settingsByRepo = new Map<string, DeclaredSetting[]>([...declared].map(([k, v]) => [k, v.settings]));
  const uncounted = probes.filter((p) => counted.notCounted.some((n) => n.probe === p.id));
  const tiers = buildRecords({ counted: counted.counted, declared: settingsByRepo, repos: ws.repos.map((r) => r.repo), prose: collectProse(ws), histories, thresholds, now, previous, uncounted });

  const findings: DiscoverFinding[] = [...tiers.findings];
  for (const p of probes.filter((x) => x.origin?.startsWith('judgment:'))) {
    const jid = p.origin!.slice('judgment:'.length);
    const recs = tiers.records.filter((r) => r.id === p.id || r.id.startsWith(`${p.id}-`));
    if (recs.length) {
      if (imported && jid === imported.id) imported.proven.push(...recs.map((r) => r.id));
      for (const r of recs) r.provenance.push({ kind: 'judgment', ref: `judgment/${jid}/result.json` });
    } else {
      const c = counted.counted.find((x) => x.id === p.id);
      const n = c?.total.sites ?? 0;
      const conf = c?.total.byVariant.conforming ?? 0;
      findings.push({ kind: 'judgment-unproven', id: p.id, message: `Judgment candidate ${p.id} (${jid}) did not reach a counted tier: ${conf} of ${n} sites conform. Not in the ledger.`, scope: ['*'], counts: { sites: n, conforming: conf, ratio: n ? Math.round((conf / n) * 1000) / 1000 : 0 } });
    }
  }
  if (imported) {
    for (const r of imported.rejected) findings.push({ kind: 'judgment-rejected', id: r.id, message: `Judgment candidate ${r.id} rejected: ${r.reason}.`, scope: ['*'] });
  }
  for (const g of counted.gates) findings.push({ kind: 'probes-skipped', id: `${g.domain}-probes`, message: `${g.domain} probes skipped: no ${g.domain.toUpperCase()} in the repository (${g.skipped.length} probe${g.skipped.length === 1 ? '' : 's'}: ${g.skipped.join(', ')}). Checked: ${g.evidence}.`, scope: ['*'] });
  for (const e of counted.errors) findings.push({ kind: 'scanner-absent', id: 'probe-error', message: e, scope: ['*'] });
  for (const e of lib.errors) findings.push({ kind: 'scanner-absent', id: 'probe-library', message: `probe library: ${e}`, scope: ['*'] });

  const scanners: ScannerStatus[] = [...counted.scanners];
  for (const tool of ['dependency-cruiser', 'knip'] as const) {
    const gs = graph.filter((g) => g.tool === tool);
    const avail = gs.filter((g) => g.available);
    scanners.push({ name: tool, available: avail.length > 0, note: avail.length ? `installed in ${avail.length} of ${gs.length} repositories` : `not installed in any repository (${gs.length} checked); never installed by the harness` });
    for (const g of gs.filter((x) => !x.available)) findings.push({ kind: 'scanner-absent', id: `${tool}@${g.repoId}`, message: `${tool} absent in ${ws.repos.find((r) => r.repo.id === g.repoId)?.repo.name}: ${g.note}.`, scope: [g.repoId] });
  }
  const eslintOk = effective.filter((e) => e.tool === 'eslint' && e.ok).length;
  scanners.push({ name: 'eslint --print-config', available: eslintOk > 0, note: eslintOk ? `${eslintOk} sampled file(s) resolved` : 'not resolved (repositories without node_modules or --no-exec); configs read statically' });
  for (const e of effective.filter((x) => !x.ok)) findings.push({ kind: 'effective-config', id: `${e.tool}@${e.repoId}`, message: `${e.tool} effective config in ${ws.repos.find((r) => r.repo.id === e.repoId)?.repo.name}${e.file !== '-' ? ` (${e.file})` : ''}: ${e.note}.`, scope: [e.repoId] });

  const ledger: Ledger = { version: 1, generatedAt: now, workspaceRoot: root, records: tiers.records, skipped: ws.skipped, scanners };
  const dbCandidates = collectDbCandidates(ws);
  const result: DiscoverResult = {
    ledger,
    findings,
    thresholds,
    ws,
    tiers,
    effective,
    graph,
    histories,
    dbCandidates,
    notCounted: counted.notCounted,
    probeErrors: [...counted.errors, ...lib.errors],
    durationMs: 0,
    judgment: imported ? { imported } : undefined,
  };
  if (opts.judgment) {
    const bundle = createJudgmentBundle(ws, counted.counted, tiers.records);
    result.judgment = { ...(result.judgment ?? {}), bundle };
    progress(`discover: judgment bundle ${bundle.id}: ${bundle.excerpts} excerpts at ${bundle.dir}`);
  }
  result.durationMs = Date.now() - t0;
  if (opts.write !== false) {
    result.paths = emitAll({ ledger, tiers, findings, thresholds, ws, effective, graph, histories, dbCandidates, notCounted: counted.notCounted, probeCount: probes.length, judgment: result.judgment, durationMs: result.durationMs, astGrepMs: counted.astGrepMs });
  }
  const byTier: Record<string, number> = {};
  for (const r of ledger.records) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
  instrument({ event: 'discover.run', counts: { repos: ws.repos.length, files: ws.totalFiles, probes: probes.length, records: ledger.records.length, findings: findings.length, skipped: ws.skipped.length, ...Object.fromEntries(Object.entries(byTier).map(([k, v]) => [`tier_${k}`, v])) } });
  return result;
}
