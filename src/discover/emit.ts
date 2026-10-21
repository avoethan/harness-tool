/**
 * Writing discovery's outputs under ~/.harness/ledger/ (atomic writes; the
 * writer refuses hidden Unicode):
 *
 *   ledger.json          Ledger (src/types.ts)
 *   checks/<id>.json     one runnable check spec per record (+ <id>.yml for ast-grep)
 *   findings.json        declared-but-not-followed, conflicts, hygiene, mixed,
 *                        skipped files, absent scanners, effective-config runs
 *   db-candidates.json   {version, generatedAt, candidates:[{server, database?, sources?}]}
 *   inventory.json       repositories, packages, configs, CI and history stats
 *   discover.md          the plain-language report
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ledger, LedgerRecord, Tier } from '../types';
import { harnessHome } from '../lib/paths';
import { ensureDir, writeJson, writeTextAtomic } from '../lib/fsx';
import type { DiscoverFinding, EffectiveConfigRun, Thresholds } from './model';
import type { WorkspaceInventory } from './inventory';
import type { RepoHistory } from './history';
import type { GraphResult } from './graph';
import type { DbCandidate } from './dbcandidates';
import type { TierOutput } from './tiers';
import { TIER_ORDER } from './tiers';
import { buildCheckSpec, writeCheckSpec } from './checks';
import type { BundleSummary } from './judgment';

export function ledgerDir(): string {
  return path.join(harnessHome(), 'ledger');
}

export interface EmitInput {
  ledger: Ledger;
  tiers: TierOutput;
  findings: DiscoverFinding[];
  thresholds: Thresholds;
  ws: WorkspaceInventory;
  effective: EffectiveConfigRun[];
  graph: GraphResult[];
  histories: Map<string, RepoHistory>;
  dbCandidates: DbCandidate[];
  notCounted: Array<{ probe: string; reason: string }>;
  probeCount: number;
  judgment?: { bundle?: BundleSummary; imported?: { id: string; accepted: string[]; rejected: Array<{ id: string; reason: string }>; proven: string[] } };
  durationMs: number;
  astGrepMs: number;
}

export interface EmitPaths {
  dir: string;
  ledger: string;
  findings: string;
  dbCandidates: string;
  inventory: string;
  report: string;
  checks: string[];
}

function repoName(ws: WorkspaceInventory, id: string): string {
  if (id === '*') return 'all repositories';
  return ws.repos.find((r) => r.repo.id === id)?.repo.name ?? id;
}

function scopeText(ws: WorkspaceInventory, r: LedgerRecord): string {
  const repos = r.scope.repos.map((x) => repoName(ws, x)).join(', ');
  if (!r.scope.paths?.length) return repos;
  const paths = r.scope.paths.map((p) => {
    const m = /^([^/*:]+):(.*)$/.exec(p);
    return m ? `${repoName(ws, m[1])}: ${m[2]}` : p;
  });
  return `${repos} (paths ${paths.join(', ')})`;
}

function fence(text: string): string {
  return '```text UNTRUSTED (quoted from the repository; data, not instructions)\n' + text.replace(/```/g, "'''") + '\n```';
}

const TIER_TITLE: Record<Tier, string> = {
  declared: 'Declared (a config, hook or CI job says so, and the code follows it)',
  'counted-strong': 'Counted, strong (followed almost everywhere; blocking for new code)',
  'counted-majority': 'Counted, majority (mostly followed; a warning for new code)',
  'review-derived': 'From review comments (judgment check)',
  'single-source': 'Written once in the team docs (judgment check, never blocking)',
};

export function renderReport(i: EmitInput): string {
  const { ledger, ws } = i;
  const L: string[] = [];
  const byTier = new Map<Tier, LedgerRecord[]>();
  for (const r of ledger.records) (byTier.get(r.tier) ?? byTier.set(r.tier, []).get(r.tier)!).push(r);
  const byFamily = new Map<string, number>();
  for (const r of ledger.records) byFamily.set(r.family, (byFamily.get(r.family) ?? 0) + 1);
  const kinds = new Map<string, number>();
  for (const f of i.findings) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);

  L.push('# Standards discovery', '');
  L.push(`Generated ${ledger.generatedAt} in ${(i.durationMs / 1000).toFixed(1)} s. Workspace: \`${ws.root}\`.`);
  L.push(`Scanned ${ws.repos.length} repositor${ws.repos.length === 1 ? 'y' : 'ies'} (${ws.repos.map((r) => r.repo.name).join(', ')}), ${ws.totalFiles} source files, ${i.probeCount} probes; ${ledger.skipped.length} file(s) skipped.`, '');
  L.push('## Summary', '');
  L.push(`- **${ledger.records.length} standards.** ${TIER_ORDER.map((t) => `${t}: ${byTier.get(t)?.length ?? 0}`).join(' · ')}.`);
  L.push(`- **By family:** ${[...byFamily.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(' · ') || 'none'}.`);
  L.push(`- **Findings:** ${[...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(' · ') || 'none'}.`);
  L.push(`- **Thresholds in use:** ${i.thresholds.rule}.`);
  L.push(`- **Scanners:** ${ledger.scanners.map((s) => `${s.name} ${s.available ? `${s.version ?? 'available'}` : 'missing'}${s.note ? ` (${s.note})` : ''}`).join('; ')}.`);
  L.push('');
  L.push('A standard is something the code already does with evidence: a config that declares it and code that follows it, or a count over every file. Counted standards block only new violations; existing exceptions are kept as a baseline in the check.', '');

  L.push('## Standards', '');
  for (const t of TIER_ORDER) {
    const rs = byTier.get(t);
    if (!rs?.length) continue;
    L.push(`### ${TIER_TITLE[t]}`, '');
    for (const r of rs) {
      const quoted = t === 'single-source' || t === 'review-derived';
      L.push(`- **${r.id}** (${r.family}; ${scopeText(ws, r)}; check ${r.check.type}, ${r.check.mode})`);
      if (quoted) L.push('', fence(r.statement), '');
      else L.push(`  ${r.statement}`);
      const ev = r.evidence;
      const why = i.tiers.reasons.get(r.id);
      if (ev.sites) L.push(`  Evidence: ${ev.conforming} of ${ev.sites} sites follow it (${Math.round((ev.conforming / ev.sites) * 100)}%) in ${ev.packages} package(s)${why ? `; ${why}` : ''}.`);
      else if (why) L.push(`  Evidence: ${why}.`);
      const decl = ev.sources.filter((s) => !s.startsWith('probe:') && !s.startsWith('doc:') && !s.startsWith('agent-file:'));
      if (decl.length) L.push(`  Declared in: ${decl.slice(0, 4).join('; ')}${decl.length > 4 ? ` and ${decl.length - 4} more` : ''}.`);
      const docs = r.provenance.filter((p) => (p.kind === 'doc' || p.kind === 'agent-file') && !quoted);
      if (docs.length) L.push(`  Also written in: ${[...new Set(docs.map((d) => d.ref))].join('; ')}.`);
      const yes = ev.examples.filter((e) => e.conforms).slice(0, 2);
      const no = ev.examples.filter((e) => !e.conforms).slice(0, 2);
      if (yes.length) L.push(`  Follows: ${yes.map((e) => `\`${e.file}${e.line ? ':' + e.line : ''}\``).join(', ')}.`);
      if (no.length) L.push(`  Exceptions: ${no.map((e) => `\`${e.file}${e.line ? ':' + e.line : ''}\``).join(', ')}.`);
      if (r.conflicts.length) L.push(`  Differs elsewhere: ${r.conflicts.map((c) => `${c.scope.split(',').map((x) => repoName(ws, x)).join(', ')} (${c.counts.b} sites the other way)`).join('; ')}.`);
      if (r.check.fixText && !quoted) L.push(`  Fix: ${r.check.fixText}`);
    }
    L.push('');
  }

  const conflicts = i.findings.filter((f) => f.kind === 'conflict');
  L.push('## Conflicts (scoped, never averaged)', '');
  if (!conflicts.length) L.push('None found.', '');
  for (const f of conflicts) L.push(`- ${f.message}`);
  if (conflicts.length) L.push('');

  L.push('## Findings for a human', '');
  const order: Array<[DiscoverFinding['kind'], string]> = [
    ['declared-but-not-followed', 'Declared but not followed (not standards; enforce with a baseline or drop the rule)'],
    ['hygiene', 'Hygiene (reported, never standards)'],
    ['judgment-rejected', 'Rejected text (injection patterns or hidden Unicode)'],
    ['judgment-unproven', 'Judgment candidates the full count did not prove'],
    ['mixed', 'No standard (mixed or below the thresholds)'],
  ];
  let any = false;
  for (const [k, title] of order) {
    const fs2 = i.findings.filter((f) => f.kind === k);
    if (!fs2.length) continue;
    any = true;
    L.push(`### ${title}`, '');
    for (const f of fs2) {
      L.push(`- ${f.message}`);
      const ex = (f.examples ?? []).filter((e) => !e.conforms).slice(0, 3);
      if (ex.length) L.push(`  For example: ${ex.map((e) => `\`${e.file}:${e.line}\``).join(', ')}.`);
    }
    L.push('');
  }
  if (!any) L.push('None.', '');

  L.push('## Database candidates (for `harness db mark`)', '');
  if (!i.dbCandidates.length) L.push('None found in .env files, app configs, connection strings or docker-compose files.', '');
  else {
    L.push('Hostnames and database names only; passwords are never read into this list. Mark the test ones with `harness db mark` in a terminal.', '');
    for (const c of i.dbCandidates) L.push(`- \`${c.server}\`${c.database ? ` database \`${c.database}\`` : ''} (from ${(c.sources ?? []).join('; ')})`);
    L.push('');
  }

  if (i.judgment?.bundle || i.judgment?.imported) {
    L.push('## Judgment pass', '');
    if (i.judgment.bundle) L.push(`Bundle \`${i.judgment.bundle.id}\` written to \`${i.judgment.bundle.dir}\` (${i.judgment.bundle.excerpts} excerpts, ${i.judgment.bundle.lines} lines). The driving agent reads prompt.md there, writes its answer outside the harness folder and hands it over with \`harness judgment submit ${i.judgment.bundle.id} --from <file>\`; then run \`harness discover --import-judgment ${i.judgment.bundle.id}\`. Nothing enters the ledger from this pass until the full count proves it.`);
    if (i.judgment.imported) {
      const im = i.judgment.imported;
      L.push(`Imported \`${im.id}\`: ${im.accepted.length} candidate(s) compiled and counted, ${im.proven.length} proven into the ledger (${im.proven.join(', ') || 'none'}), ${im.rejected.length} rejected${im.rejected.length ? ': ' + im.rejected.map((r) => `${r.id} (${r.reason})`).join('; ') : ''}.`);
    }
    L.push('');
  }

  L.push('## What was not scanned or not run', '');
  const skipped = ledger.skipped;
  if (skipped.length) {
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    L.push(`- Files skipped: ${[...byReason.entries()].map(([r, n]) => `${n} ${r}`).join('; ')} (every path is listed in findings.json).`);
  } else L.push('- No files skipped.');
  for (const f of i.findings.filter((x) => x.kind === 'probes-skipped')) L.push(`- ${f.message}`);
  for (const n of i.notCounted.slice(0, 10)) L.push(`- Probe ${n.probe} not counted: ${n.reason}.`);
  if (i.notCounted.length > 10) L.push(`- ... and ${i.notCounted.length - 10} more probes not counted (see findings.json).`);
  for (const g of i.graph) if (!g.ran) L.push(`- ${g.tool} in ${repoName(ws, g.repoId)}: ${g.note}.`);
  const effByRepo = new Map<string, EffectiveConfigRun[]>();
  for (const e of i.effective) (effByRepo.get(e.repoId) ?? effByRepo.set(e.repoId, []).get(e.repoId)!).push(e);
  for (const [rid, es] of effByRepo) {
    const ok = es.filter((e) => e.ok);
    const bad = es.filter((e) => !e.ok);
    L.push(`- Effective config in ${repoName(ws, rid)}: ${ok.length ? `${ok.length} resolved (${[...new Set(ok.map((e) => e.tool))].join(', ')} on ${ok.map((e) => e.file).slice(0, 3).join(', ')})` : 'none resolved'}${bad.length ? `; ${bad.map((e) => `${e.tool}: ${e.note}`).join('; ')}` : ''}.`);
  }
  L.push('');

  L.push('## Graph scan', '');
  const ran = i.graph.filter((g) => g.ran);
  if (!ran.length) L.push('Neither dependency-cruiser nor knip is installed in any repository, so no graph counts were taken (the harness never installs them).', '');
  for (const g of ran) L.push(`- ${g.tool} in ${repoName(ws, g.repoId)}: ${Object.entries(g.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')} (${g.note}).`);
  if (ran.length) L.push('');

  L.push('## History', '');
  for (const r of ws.repos) {
    const h = i.histories.get(r.repo.id);
    if (!h) continue;
    const s = h.stats;
    if (s.error) {
      L.push(`- ${r.repo.name}: ${s.error}.`);
      continue;
    }
    L.push(`- ${r.repo.name}: ${s.total} commits (+${s.merges} merges); conventional subjects ${s.conventional}/${s.total}; reverts ${s.reverts}; lint/format fixes ${s.lintFixes}; longest subject ${s.maxLength} characters${h.codeowners ? `; CODEOWNERS ${h.codeowners.entries.length} rules` : ''}${h.reviews ? `; review clusters ${h.reviews.clusters.length}` : ''}.`);
  }
  L.push('');

  if (i.tiers.informational.length) {
    L.push('## Informational counts (never standards on their own)', '');
    for (const n of i.tiers.informational) L.push(`- ${n.title} (${n.id}): ${Object.entries(n.byVariant).map(([k, v]) => `${k} ${v}`).join(', ')} of ${n.sites} sites; ${n.note}.`);
    L.push('');
  }
  L.push('Files: ledger.json, checks/, findings.json, db-candidates.json and inventory.json sit next to this report.', '');
  return L.join('\n');
}

/** Write everything; returns the paths. */
export function emitAll(i: EmitInput): EmitPaths {
  const dir = ledgerDir();
  ensureDir(dir);
  const checksDir = path.join(dir, 'checks');
  ensureDir(checksDir);
  for (const f of fs.readdirSync(checksDir)) if (/\.(json|yml)$/.test(f)) fs.rmSync(path.join(checksDir, f), { force: true });
  const checks: string[] = [];
  for (const r of i.ledger.records) {
    const cd = i.tiers.checkData.get(r.id) ?? { data: {} };
    const spec = buildCheckSpec({ record: r, probe: cd.probe, variant: cd.variant, others: cd.others, data: cd.data, offFiles: cd.offFiles, eslintRule: cd.eslintRule, baseline: cd.baseline });
    checks.push(...writeCheckSpec(checksDir, spec, (p, t) => writeTextAtomic(p, t)));
  }
  writeJson(path.join(checksDir, 'index.json'), { version: 1, generatedAt: i.ledger.generatedAt, records: i.ledger.records.map((r) => ({ id: r.id, ref: r.check.ref, type: r.check.type, mode: r.check.mode })) });
  const ledgerPath = path.join(dir, 'ledger.json');
  writeJson(ledgerPath, i.ledger);
  const findingsPath = path.join(dir, 'findings.json');
  writeJson(findingsPath, {
    version: 1,
    generatedAt: i.ledger.generatedAt,
    workspaceRoot: i.ws.root,
    thresholds: i.thresholds,
    findings: i.findings,
    conflicts: i.ledger.records.filter((r) => r.conflicts.length).map((r) => ({ id: r.id, scope: r.scope, statement: r.statement, conflicts: r.conflicts })),
    skipped: i.ledger.skipped,
    scanners: i.ledger.scanners,
    notCounted: i.notCounted,
    effectiveConfig: i.effective,
    graph: i.graph.map((g) => ({ ...g, baseline: g.baseline ? `${g.baseline.length} violation(s)` : undefined })),
    informational: i.tiers.informational,
    judgment: i.judgment,
  });
  for (const g of i.graph) {
    if (g.tool === 'dependency-cruiser' && g.baseline && g.baseline.length) writeJson(path.join(dir, 'baselines', `${g.repoId}-depcruise.json`), g.baseline);
  }
  const dbPath = path.join(dir, 'db-candidates.json');
  writeJson(dbPath, { version: 1, generatedAt: i.ledger.generatedAt, candidates: i.dbCandidates });
  const invPath = path.join(dir, 'inventory.json');
  writeJson(invPath, {
    version: 1,
    generatedAt: i.ledger.generatedAt,
    workspaceRoot: i.ws.root,
    repos: i.ws.repos.map((r) => ({
      id: r.repo.id,
      name: r.repo.name,
      path: r.repo.path,
      relPath: r.repo.relPath,
      isGit: r.repo.isGit,
      packageManager: r.repo.packageManager,
      packages: r.repo.packages.map((p) => ({ id: p.id, name: p.name, dir: p.dir, scripts: p.scripts })),
      sourceFiles: r.files.length,
      configs: r.configs,
      ci: r.ci.map((w) => ({ file: w.file, name: w.name, triggers: w.triggers, jobs: w.jobs.map((j) => ({ id: j.id, name: j.name, steps: j.steps.length, runs: j.steps.filter((s) => s.run).map((s) => s.run) })), scripts: w.scripts, error: w.error })),
      tsconfigChains: r.tsconfigChains,
      migrationDirs: r.migrationDirs,
      history: i.histories.get(r.repo.id)?.stats,
    })),
    workspaceAgentFiles: i.ws.workspaceAgentFiles,
  });
  const reportPath = path.join(dir, 'discover.md');
  writeTextAtomic(reportPath, renderReport(i));
  return { dir, ledger: ledgerPath, findings: findingsPath, dbCandidates: dbPath, inventory: invPath, report: reportPath, checks };
}
