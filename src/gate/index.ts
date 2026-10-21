/**
 * The done-gate (DESIGN §2.5): runs the steps cheapest first with a per-step
 * cache, decides PASS | FAIL(reasons) | BLOCKED(reason), writes
 * evidence.json for the Stop hook and the write-up, and instruments step
 * names, durations and the verdict (never text).
 *
 * Verdict rules:
 *   - PASS when every step that ran passed (skips are listed with reasons);
 *   - FAIL with every failing step's reasons, or when the working tree
 *     changed while the gate ran, or when the Stop hook marked the task as
 *     released by the attempt cap (`cap_reached`): the gate still runs every
 *     step so the agent sees why, but never reports PASS for a capped task;
 *   - BLOCKED with the stated reason (`--blocked "<reason>"`); the tamper
 *     and secret steps still run and their findings are recorded.
 * A partial run (`--steps`) prints results and updates the cache but writes
 * no verdict, so it can never stand in for a full PASS.
 */
import * as fs from 'node:fs';
import type { EvidenceFile, GateStep, Verdict } from '../types';
import { instrument } from '../lib/log';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import { buildContext, diffTrees, workingTree, GateError, type GateContext, type GateOptions } from './context';
import { loadCache, lookup, saveCache, stepKey, store } from './cache';
import { capReasons, prefixOf, selects, sortSteps, type StepDef, type StepOutcome } from './steps';
import { tamperStep } from './tamper';
import { secretsStep } from './secrets';
import { buildStep, lintStep, typecheckStep } from './build';
import { standardsStep } from './standards';
import { acceptanceSteps, baseTestsStep } from './tests';
import { gateCheckSteps } from './gatecheck';
import { coverageStep } from './coverage';
import { mapDriftStep } from './mapdrift';
import { artefactRefs, e2eSteps } from './e2e';
import { affectedStep } from './affected';
import { buildEvidence, capMarker, readPrevious, writeEvidence } from './evidence';
import { renderReport } from './report';
import { attemptCap } from '../hooks/common';

export { GateError } from './context';

export interface GateRunOptions extends GateOptions {
  /** `--steps`: run only these (names, kinds, groups or DESIGN numbers). */
  steps?: string[];
  /** `--blocked "<reason>"`: record BLOCKED. */
  blocked?: string;
  /** Ignore and do not update the cache. */
  noCache?: boolean;
  /** Replace the built-in steps (tests). */
  stepDefs?: (ctx: GateContext) => StepDef[];
}

export interface GateRun {
  ctx: GateContext;
  evidence: EvidenceFile;
  exitCode: 0 | 1 | 4;
  evidencePath: string | null;
  partial: string[] | null;
  report: string;
  durationMs: number;
}

/** Every step for a context, cheapest first. */
export function allSteps(ctx: GateContext): StepDef[] {
  return sortSteps([tamperStep, secretsStep, mapDriftStep, ...e2eSteps(ctx), standardsStep, lintStep, typecheckStep, buildStep, baseTestsStep, ...acceptanceSteps(ctx), ...gateCheckSteps(ctx), coverageStep, affectedStep]);
}

/** The steps a mode runs: pre-commit runs DESIGN steps 1-4 (fast); every other mode runs all. */
export function stepsForMode(mode: GateContext['mode'], defs: StepDef[]): StepDef[] {
  return mode === 'pre-commit' ? defs.filter((d) => d.design <= 4) : defs;
}

function oneLine(s: unknown, max = 300): string {
  return stripHiddenUnicode(String(s ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

export function decideVerdict(steps: GateStep[], opts: { blocked?: string; capped?: boolean; capAt?: string; cap?: number; treeChanged?: string[]; mode?: GateContext['mode'] }): { verdict: Verdict; reasons: string[] } {
  const failed = steps.filter((s) => s.status === 'fail');
  const findings = failed.flatMap((s) => (s.reasons?.length ? s.reasons : ['failed']).map((r) => `${s.name}: ${r}`));
  if (opts.blocked !== undefined) return { verdict: 'BLOCKED', reasons: [`BLOCKED: ${redactText(oneLine(opts.blocked, 500))}`, ...capReasons(findings, 40)] };
  const reasons = [...findings];
  if (opts.treeChanged?.length) reasons.push(`the working tree changed while the gate ran (${opts.treeChanged.slice(0, 8).join(', ')}${opts.treeChanged.length > 8 ? ', …' : ''}); the results may not match the files now, so run \`harness gate\` again (if a step writes these files, they belong in .gitignore)`);
  if (!reasons.length && opts.capped && (opts.mode ?? 'task') === 'task') {
    reasons.push(`attempt cap reached${opts.cap ? ` (${opts.cap})` : ''}${opts.capAt ? ` at ${opts.capAt}` : ''}: the Stop hook released the agent for this task, so the gate does not report PASS; a person reviews the work`);
  }
  return reasons.length ? { verdict: 'FAIL', reasons: capReasons(reasons, 60) } : { verdict: 'PASS', reasons: [] };
}

function ruleIds(reasons: string[]): string {
  return [...new Set(reasons.map((r) => /^(?:warn: )?([a-z][\w.-]*\.[\w.-]+) at /.exec(r)?.[1]).filter((x): x is string => !!x))].join(',').slice(0, 200);
}

export async function runGate(opts: GateRunOptions = {}): Promise<GateRun> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const ctx = buildContext(opts);
  fs.mkdirSync(ctx.runDir, { recursive: true });
  const prev = readPrevious(ctx.runDir);
  const cap = capMarker(ctx.runDir, prev);
  const capN = attemptCap(ctx.config);
  let defs = stepsForMode(ctx.mode, (opts.stepDefs ?? allSteps)(ctx));
  let partial: string[] | null = null;
  if (opts.blocked !== undefined) defs = defs.filter((d) => d.design <= 2);
  else if (opts.steps?.length) {
    const sel = opts.steps.map((s) => s.trim()).filter(Boolean);
    const picked = defs.filter((d) => sel.some((s) => selects(s, d)));
    if (!picked.length) throw new GateError(`--steps ${sel.join(',')} matched no step. Steps: ${defs.map((d) => d.name).join(', ')}`, 2);
    if (picked.length < defs.length) partial = sel;
    defs = picked;
  }
  const cache = loadCache(ctx.runDir);
  const steps: GateStep[] = [];
  ctx.stepResults = steps;
  const failedNames = new Set<string>();
  for (const d of defs) {
    const st = Date.now();
    const blockers = (d.after ?? []).filter((a) => failedNames.has(a));
    if (blockers.length) {
      steps.push({ name: d.name, status: 'skip', durationMs: 0, reasons: [`not run: ${blockers.join(', ')} failed; fix that first`], cache: 'off' });
      continue;
    }
    let inputs: string[] | null = null;
    try {
      inputs = d.inputs(ctx);
    } catch {
      inputs = null;
    }
    const key = inputs ? stepKey(d.name, ctx.base, ctx.configHash, inputs) : undefined;
    if (key && !opts.noCache) {
      const hit = lookup(cache, d.name, key, d.cacheFail);
      if (hit) {
        steps.push({ name: d.name, status: hit.status === 'pass' ? 'cached' : 'fail', durationMs: Date.now() - st, reasons: hit.reasons.length ? hit.reasons : undefined, cacheKey: key, cache: 'hit' });
        if (hit.status === 'fail') failedNames.add(d.name);
        continue;
      }
    }
    let out: StepOutcome;
    try {
      out = await d.run(ctx);
    } catch (e) {
      out = { status: 'fail', reasons: [`internal error in this step: ${oneLine((e as Error)?.message ?? e, 200)}`] };
    }
    const dur = Date.now() - st;
    const reasons = out.reasons.map((r) => redactText(oneLine(r, 400)));
    steps.push({ name: d.name, status: out.status, durationMs: dur, ...(reasons.length ? { reasons } : {}), ...(key ? { cacheKey: key } : {}), cache: key && !opts.noCache ? 'miss' : 'off' });
    if (out.status === 'fail') failedNames.add(d.name);
    if (key && !opts.noCache && (out.status === 'pass' || (out.status === 'fail' && d.cacheFail))) store(cache, d.name, { key, status: out.status, reasons, durationMs: dur, at: new Date().toISOString() });
  }
  if (!opts.noCache) {
    try {
      saveCache(ctx.runDir, cache);
    } catch {
      /* the cache is an optimisation */
    }
  }
  let treeChanged: string[] = [];
  if (!opts.tree && ctx.mode !== 'pre-commit') {
    const after = workingTree(ctx.root);
    if (after && after !== ctx.tree) treeChanged = diffTrees(ctx.root, ctx.tree, after).map((d) => d.path);
  }
  const { verdict, reasons } = decideVerdict(steps, { blocked: opts.blocked, capped: cap.capped, capAt: cap.at, cap: capN, treeChanged, mode: ctx.mode });
  const finishedAt = new Date().toISOString();
  const evidence = buildEvidence({
    repo: ctx.repoId,
    task: ctx.taskId,
    sessionId: ctx.sessionId,
    verdict,
    reasons,
    treeHash: ctx.tree,
    baseSha: ctx.base,
    steps,
    attempt: partial ? prev?.attempt ?? 0 : (prev?.attempt ?? 0) + 1,
    startedAt,
    finishedAt,
    e2e: artefactRefs(ctx.runDir),
    phase: ctx.phase?.phase,
    cap,
  });
  const evidencePath = partial ? null : writeEvidence(ctx.runDir, evidence);
  const durationMs = Date.now() - t0;

  // Instrumentation: names, ids, counts.
  for (const s of steps) {
    instrument({ event: 'gate.step', repo: ctx.repoId, task: ctx.taskId, sessionId: ctx.sessionId, ids: { step: s.name, kind: prefixOf(s.name), status: s.status, cache: s.cache ?? 'off' }, counts: { ms: s.durationMs, reasons: s.reasons?.length ?? 0 } });
    if (s.status === 'fail') {
      const rules = prefixOf(s.name) === 'standards' ? ruleIds(s.reasons ?? []) : '';
      instrument({ event: 'gate.fail', repo: ctx.repoId, task: ctx.taskId, sessionId: ctx.sessionId, ids: { step: s.name, kind: prefixOf(s.name), mode: ctx.mode, ...(rules ? { rules } : {}) }, counts: { reasons: s.reasons?.length ?? 0, attempt: evidence.attempt } });
    }
  }
  instrument({
    event: partial ? 'gate.partial' : 'gate.verdict',
    repo: ctx.repoId,
    task: ctx.taskId,
    sessionId: ctx.sessionId,
    ids: { verdict, mode: ctx.mode, ...(cap.capped ? { cap: 'reached' } : {}) },
    counts: {
      steps: steps.length,
      failed: steps.filter((s) => s.status === 'fail').length,
      skipped: steps.filter((s) => s.status === 'skip').length,
      cached: steps.filter((s) => s.cache === 'hit').length,
      attempt: evidence.attempt,
      ms: durationMs,
    },
  });
  if (verdict === 'BLOCKED') instrument({ event: 'blocked_reported', repo: ctx.repoId, task: ctx.taskId, sessionId: ctx.sessionId, counts: { attempt: evidence.attempt } });
  if (steps.some((s) => s.name === 'tamper' && s.status === 'fail')) instrument({ event: 'tampered', repo: ctx.repoId, task: ctx.taskId, sessionId: ctx.sessionId, counts: { findings: steps.find((s) => s.name === 'tamper')?.reasons?.length ?? 0 } });

  const report = renderReport({ evidence, repoName: ctx.repoName, mode: ctx.mode, baseSource: ctx.baseSource, cap: capN, evidencePath, partial, warnings: ctx.warnings });
  const exitCode: GateRun['exitCode'] = partial ? (steps.some((s) => s.status === 'fail') ? 1 : 0) : verdict === 'PASS' ? 0 : verdict === 'BLOCKED' ? 4 : 1;
  return { ctx, evidence, exitCode, evidencePath, partial, report, durationMs };
}
