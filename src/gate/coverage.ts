/**
 * Step 6: changed-line coverage not below the base.
 *
 * Runs only when the repository has coverage output configured: a
 * `coverage`, `test:coverage`, `test:cov` or `cov` script at the base commit
 * that writes Istanbul JSON (`coverage/coverage-final.json`, the format c8,
 * nyc, vitest and jest all emit with the json reporter). Otherwise the step
 * is skipped with the reason.
 *
 * The comparison: line coverage of the lines this change adds (in non-test
 * files, lines that carry a statement) must not be below the overall line
 * coverage of the base commit. The base figure is measured once per base
 * commit in a temporary checkout and cached under ~/.harness/cache/<repoId>/.
 *
 * When the coverage script itself fails, the failure is compared with the
 * same script at the base commit (src/gate/baseline.ts); a changed-line
 * figure below the base is already a comparison with the base and is not.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateContext } from './context';
import { EMPTY_TREE, isTestFile } from './context';
import { readJsonOr, writeJson } from '../lib/fsx';
import { harnessHome } from '../lib/paths';
import { withBaseCheckout } from './checkout';
import { failureLines, runScript, scriptCommand } from './scripts';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';
import { rootsFor, scriptIdentity } from './baseline';

export const COVERAGE_SCRIPTS = ['coverage', 'test:coverage', 'test:cov', 'cov'];
export const COVERAGE_FILE = path.join('coverage', 'coverage-final.json');

interface Loc {
  start: { line: number };
  end: { line: number };
}
export interface IstanbulFile {
  path?: string;
  statementMap: Record<string, Loc>;
  s: Record<string, number>;
}
export type IstanbulReport = Record<string, IstanbulFile>;

/** line -> hit count, for lines where a statement starts. */
export function lineHits(f: IstanbulFile): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, loc] of Object.entries(f.statementMap ?? {})) {
    const line = loc?.start?.line;
    if (typeof line !== 'number') continue;
    const n = Number(f.s?.[id] ?? 0);
    out.set(line, Math.max(out.get(line) ?? 0, n));
  }
  return out;
}

export function overallLines(report: IstanbulReport): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const f of Object.values(report)) {
    for (const n of lineHits(f).values()) {
      total++;
      if (n > 0) covered++;
    }
  }
  return { covered, total };
}

/** Coverage of the added lines: report keys are absolute paths under `root`. */
export function changedLines(report: IstanbulReport, root: string, added: Map<string, Array<{ line: number }>>): { covered: number; total: number; uncovered: string[] } {
  const byRel = new Map<string, IstanbulFile>();
  for (const [k, f] of Object.entries(report)) byRel.set(path.relative(root, f.path ?? k).split(path.sep).join('/'), f);
  let covered = 0;
  let total = 0;
  const uncovered: string[] = [];
  for (const [rel, lines] of added) {
    if (isTestFile(rel)) continue;
    const f = byRel.get(rel);
    if (!f) continue;
    const hits = lineHits(f);
    const miss: number[] = [];
    for (const l of lines) {
      if (!hits.has(l.line)) continue;
      total++;
      if ((hits.get(l.line) ?? 0) > 0) covered++;
      else miss.push(l.line);
    }
    if (miss.length) uncovered.push(`${rel}:${miss.slice(0, 12).join(',')}${miss.length > 12 ? ',…' : ''}`);
  }
  return { covered, total, uncovered };
}

function pct(c: { covered: number; total: number }): number {
  return c.total ? (100 * c.covered) / c.total : 100;
}

export function coverageScriptName(ctx: Pick<GateContext, 'basePkg'>): string | null {
  const scripts = ctx.basePkg?.scripts ?? {};
  return COVERAGE_SCRIPTS.find((n) => typeof scripts[n] === 'string') ?? null;
}

function readReport(dir: string): IstanbulReport | null {
  const r = readJsonOr<IstanbulReport | null>(path.join(dir, COVERAGE_FILE), null);
  return r && typeof r === 'object' ? r : null;
}

function baseCachePath(repoId: string, base: string): string {
  return path.join(harnessHome(), 'cache', repoId, `coverage-base-${base.slice(0, 40)}.json`);
}

export function runCoverage(ctx: GateContext): StepOutcome {
  const name = coverageScriptName(ctx);
  if (!name) return skip(`no coverage output configured (no ${COVERAGE_SCRIPTS.join(' / ')} script at the base commit)`);
  if (ctx.base === EMPTY_TREE) return skip('the base is the empty tree; there is no base coverage to compare with');
  const s = scriptCommand(ctx, name);
  if (!s.ok) return s.missing ? skip(s.reason) : fail([s.reason]);
  const pkgRel = path.relative(ctx.root, s.cmd.cwd);
  const reportFile = path.join(s.cmd.cwd, COVERAGE_FILE);
  try {
    fs.rmSync(reportFile, { force: true });
  } catch {
    /* none */
  }
  const r = runScript(s.cmd, [], ctx.timeout('coverage'));
  if (r.code !== 0) {
    const header = `\`${s.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`;
    const identity = scriptIdentity(r, `coverage:${s.cmd.display}`, header, rootsFor(ctx));
    return { status: 'fail', reasons: [header, ...failureLines(r, 8)], ...(identity ? { identity } : {}) };
  }
  const now = readReport(s.cmd.cwd);
  if (!now) return skip(`\`${s.cmd.display}\` wrote no ${COVERAGE_FILE.split(path.sep).join('/')} (turn on the json reporter so the gate can compare changed lines)`);
  const cp = baseCachePath(ctx.repoId, ctx.base);
  let base = readJsonOr<{ covered: number; total: number } | null>(cp, null);
  if (!base) {
    const co = withBaseCheckout(ctx.root, ctx.base, new Map(), (wt) => {
      const rb = runScript(s.cmd, [], ctx.timeout('coverage'), { cwd: path.join(wt, pkgRel) });
      const rep = readReport(path.join(wt, pkgRel));
      return rb.code === 0 && rep ? overallLines(rep) : null;
    });
    if (!co.ok) return skip(`base coverage could not be measured: ${co.error}`);
    if (!co.value) return skip('base coverage could not be measured (the coverage script failed or wrote no report at the base commit)');
    base = co.value;
    try {
      writeJson(cp, base);
    } catch {
      /* cache only */
    }
  }
  const changed = changedLines(now, s.cmd.cwd, new Map([...ctx.addedLines()].map(([rel, lines]) => [pkgRel && rel.startsWith(pkgRel + '/') ? rel.slice(pkgRel.length + 1) : rel, lines])));
  const basePct = pct(base);
  if (!changed.total) return pass(`no coverable changed lines (base line coverage ${basePct.toFixed(1)}%)`);
  const nowPct = pct(changed);
  const summary = `changed-line coverage ${nowPct.toFixed(1)}% (${changed.covered} of ${changed.total} lines) vs base ${basePct.toFixed(1)}% (${base.covered} of ${base.total})`;
  if (nowPct + 1e-9 < basePct) return fail(capReasons([`${summary}: below the base`, ...changed.uncovered.map((u) => `uncovered: ${u}`)], 15));
  return pass(summary);
}

/** The coverage script alone, in a checkout of the base commit: whether it fails there the same way. */
export function coverageScriptAtBase(ctx: GateContext, wt: string): StepOutcome {
  const name = coverageScriptName(ctx);
  if (!name) return skip('no coverage script at the base commit');
  const s = scriptCommand(ctx, name);
  if (!s.ok) return s.missing ? skip(s.reason) : fail([s.reason]);
  const pkgRel = path.relative(ctx.root, s.cmd.cwd);
  const r = runScript(s.cmd, [], ctx.timeout('coverage'), { cwd: path.join(wt, pkgRel) });
  if (r.code === 0) return pass(`ran \`${s.cmd.display}\` at the base commit`);
  const header = `\`${s.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`;
  const identity = scriptIdentity(r, `coverage:${s.cmd.display}`, header, rootsFor(ctx, wt));
  return { status: 'fail', reasons: [header, ...failureLines(r, 8)], ...(identity ? { identity } : {}) };
}

export const coverageStep: StepDef = { name: 'coverage', design: 6, group: 'coverage', cacheFail: false, after: ['build'], inputs: (ctx) => [ctx.tree], run: runCoverage, baseline: coverageScriptAtBase };
