/**
 * `harness discover`: work out a workspace's standards with evidence and
 * write the ledger, the checks, the findings and the report under
 * ~/.harness/ledger/. Read-only for the workspace.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { loadConfig } from '../lib/config';
import { runDiscover } from '../discover/index';
import { loadProbeLibrary, selfTest } from '../discover/probes';
import { findAstGrep } from '../discover/astgrep';

export const meta: CommandMeta = {
  name: 'discover',
  summary: 'Work out the standards of a workspace with evidence (writes the ledger)',
  usage:
    'harness discover [--root <workspace>] [--max-files <n>] [--no-exec] [--judgment | --import-judgment <id>] [--json] [--quiet]\n       harness discover --self-test [--json]',
  examples: ['harness discover', 'harness discover --root ~/work/services --judgment', 'harness discover --import-judgment j20261019-ab12cd', 'harness discover --self-test'],
};

const BOOLEANS = new Set(['json', 'quiet', 'q', 'help', 'h', 'judgment', 'self-test', 'exec']);

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, BOOLEANS);
  const json = flagBool(a, 'json');
  if (flagBool(a, 'self-test')) {
    const lib = loadProbeLibrary();
    const r = selfTest(lib, findAstGrep());
    const ok = !lib.errors.length && r.astGrep.failed === 0 && r.regex.failed === 0 && !r.missingTests.length && (r.astGrep.ran || r.astGrep.rules === 0);
    if (json) process.stdout.write(JSON.stringify({ ok, probes: lib.probes.length, errors: lib.errors, ...r }, null, 2) + '\n');
    else {
      process.stdout.write(`probe library: ${lib.probes.length} probes, ${lib.errors.length} load error(s)\n`);
      for (const e of lib.errors) process.stdout.write(`  error: ${e}\n`);
      process.stdout.write(`ast-grep test: ${r.astGrep.ran ? `${r.astGrep.passed} passed, ${r.astGrep.failed} failed (${r.astGrep.rules} rules)` : `not run (${r.astGrep.reason ?? 'unknown'})`}\n`);
      for (const f of r.astGrep.failures.slice(0, 20)) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`regex probes: ${r.regex.passed}/${r.regex.cases} cases pass\n`);
      for (const f of r.regex.failures.slice(0, 20)) process.stdout.write(`  ${f}\n`);
      if (r.missingTests.length) process.stdout.write(`missing tests: ${r.missingTests.join(', ')}\n`);
      process.stdout.write(ok ? 'self-test: ok\n' : 'self-test: FAILED\n');
    }
    return ok ? 0 : 1;
  }
  const rootFlag = flagStr(a, 'root') ?? a.positional[0];
  const cfg = loadConfig();
  const root = path.resolve(rootFlag ?? cfg?.workspaceRoot ?? process.cwd());
  const maxRaw = flagStr(a, 'max-files');
  const maxFiles = maxRaw !== undefined ? Number(maxRaw) : undefined;
  if (maxRaw !== undefined && (!Number.isInteger(maxFiles) || (maxFiles as number) < 1)) {
    process.stderr.write('discover: --max-files needs a positive whole number\n');
    return 2;
  }
  if (flagBool(a, 'judgment') && flagStr(a, 'import-judgment')) {
    process.stderr.write('discover: use either --judgment or --import-judgment <id>, not both\n');
    return 2;
  }
  const quiet = flagBool(a, 'quiet') || flagBool(a, 'q') || json;
  let result;
  try {
    result = await runDiscover({
      root,
      maxFiles,
      exec: a.flags.exec !== false,
      judgment: flagBool(a, 'judgment'),
      importJudgment: flagStr(a, 'import-judgment') || undefined,
      progress: quiet ? undefined : (l) => process.stdout.write(l + '\n'),
    });
  } catch (e) {
    process.stderr.write(`discover: ${(e as Error).message}\n`);
    return 1;
  }
  const l = result.ledger;
  const byTier: Record<string, number> = {};
  for (const r of l.records) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          root: result.ws.root,
          repos: result.ws.repos.map((r) => ({ id: r.repo.id, name: r.repo.name })),
          files: result.ws.totalFiles,
          records: l.records.length,
          byTier,
          findings: result.findings.map((f) => ({ kind: f.kind, id: f.id })),
          thresholds: result.thresholds,
          scanners: l.scanners,
          dbCandidates: result.dbCandidates.length,
          judgment: result.judgment,
          paths: result.paths,
          durationMs: result.durationMs,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const out = (s: string) => process.stdout.write(s + '\n');
    out(`discover: thresholds: ${result.thresholds.rule}`);
    out(`discover: ${l.records.length} standards (${Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}) from ${result.ws.totalFiles} files in ${result.ws.repos.length} repositories, ${(result.durationMs / 1000).toFixed(1)} s`);
    const kinds: Record<string, number> = {};
    for (const f of result.findings) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    out(`discover: findings: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    for (const s of l.scanners) if (!s.available) out(`discover: scanner missing: ${s.name} (${s.note ?? ''})`);
    if (l.skipped.length) out(`discover: ${l.skipped.length} file(s) skipped (listed in findings.json)`);
    out(`discover: database candidates: ${result.dbCandidates.length}${result.dbCandidates.length ? ' (mark the test ones with `harness db mark` in a terminal)' : ''}`);
    if (result.judgment?.bundle) out(`discover: judgment bundle ${result.judgment.bundle.id}: the agent reads ${path.join(result.judgment.bundle.dir, 'prompt.md')} writes its answer outside the harness folder and runs \`harness judgment submit ${result.judgment.bundle.id} --from <file>\`; then run \`harness discover --import-judgment ${result.judgment.bundle.id}\``);
    if (result.judgment?.imported) out(`discover: judgment ${result.judgment.imported.id}: ${result.judgment.imported.proven.length} proven, ${result.judgment.imported.accepted.length - result.judgment.imported.proven.length} unproven, ${result.judgment.imported.rejected.length} rejected`);
    if (result.paths) out(`discover: report ${result.paths.report}`);
  }
  return 0;
}
