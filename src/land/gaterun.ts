/**
 * How the landing actor and the runner call the done-gate: an interface, so
 * the state-machine tests can script verdicts, with two implementations:
 *
 *   - in process (`runGate` from src/gate): the task's gate, the re-run after
 *     a merge from main, the fix attempt's gate;
 *   - as a child process (`node <cli> gate ... --json`): the local CI
 *     stand-in, which runs with its own environment (`CI=true`) the way a CI
 *     job would.
 */
import * as path from 'node:path';
import type { GateStep, Verdict } from '../types';
import { runAsync } from '../lib/exec';
import { packageRoot } from '../lib/paths';

export interface GateCall {
  repo: string;
  task?: string;
  base?: string;
  steps?: string[];
  hook?: 'ci' | 'pre-push';
  /** Extra environment (forces a child process). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface GateOutcome {
  exitCode: number;
  /** null for a partial (`--steps`) run, which never writes a verdict. */
  verdict: Verdict | null;
  partial: boolean;
  steps: Array<Pick<GateStep, 'name' | 'status' | 'reasons'>>;
  reasons: string[];
  evidencePath: string | null;
  treeHash: string | null;
  attempt?: number;
  /** The gate's printed report (plain text), for a fix prompt. */
  report: string;
  /** Usage or internal error, when the gate could not run. */
  error?: string;
}

export interface ProveRedOutcome {
  ok: boolean;
  detail: string;
}

export interface GateRunner {
  run(call: GateCall): Promise<GateOutcome>;
  proveRed?(call: { repo: string; task?: string; base?: string }): Promise<ProveRedOutcome>;
}

export function cliPath(): string {
  return path.join(packageRoot(), 'dist', 'src', 'cli.js');
}

function gateArgs(call: GateCall): string[] {
  const a = ['gate', '--repo', call.repo];
  if (call.task) a.push('--task', call.task);
  if (call.base) a.push('--base', call.base);
  if (call.hook) a.push('--hook', call.hook);
  if (call.steps?.length) a.push('--steps', call.steps.join(','));
  return a;
}

/** The gate as a child process (`node <cli> gate ... --json`). */
export function cliGate(cli: string = cliPath()): GateRunner {
  return {
    async run(call: GateCall): Promise<GateOutcome> {
      const env: NodeJS.ProcessEnv = { ...process.env, ...(call.env ?? {}) };
      delete env.NODE_TEST_CONTEXT;
      const r = await runAsync(process.execPath, [cli, ...gateArgs(call), '--json'], { cwd: call.repo, env, timeoutMs: call.timeoutMs ?? 3_600_000 });
      try {
        const j = JSON.parse(r.stdout) as { verdict: Verdict | null; exitCode: number; evidencePath: string | null; partial: string[] | null; evidence: { steps: GateStep[]; reasons: string[]; treeHash: string; attempt: number } };
        return {
          exitCode: r.code ?? j.exitCode,
          verdict: j.verdict,
          partial: !!j.partial,
          steps: (j.evidence?.steps ?? []).map((s) => ({ name: s.name, status: s.status, ...(s.reasons ? { reasons: s.reasons } : {}) })),
          reasons: j.evidence?.reasons ?? [],
          evidencePath: j.evidencePath,
          treeHash: j.evidence?.treeHash ?? null,
          attempt: j.evidence?.attempt,
          report: (j.evidence?.reasons ?? []).join('\n'),
        };
      } catch {
        const msg = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-5).join(' ');
        return { exitCode: r.code ?? 1, verdict: null, partial: false, steps: [], reasons: [msg || 'the gate did not answer'], evidencePath: null, treeHash: null, report: msg, error: r.timedOut ? 'the gate timed out' : msg || 'the gate did not answer' };
      }
    },
  };
}

/** The gate in this process (`runGate`); calls with `env` go to a child process. */
export function inProcessGate(): GateRunner {
  const child = cliGate();
  return {
    async run(call: GateCall): Promise<GateOutcome> {
      if (call.env) return child.run(call);
      const { runGate, GateError } = require('../gate') as typeof import('../gate');
      try {
        const r = await runGate({ repo: call.repo, task: call.task, base: call.base, steps: call.steps, hook: call.hook });
        return {
          exitCode: r.exitCode,
          verdict: r.partial ? null : r.evidence.verdict,
          partial: !!r.partial,
          steps: r.evidence.steps.map((s) => ({ name: s.name, status: s.status, ...(s.reasons ? { reasons: s.reasons } : {}) })),
          reasons: r.evidence.reasons,
          evidencePath: r.evidencePath,
          treeHash: r.evidence.treeHash,
          attempt: r.evidence.attempt,
          report: r.report,
        };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        const code = e instanceof GateError ? e.exitCode : 1;
        return { exitCode: code, verdict: null, partial: false, steps: [], reasons: [msg], evidencePath: null, treeHash: null, report: msg, error: msg };
      }
    },
    async proveRed(call): Promise<ProveRedOutcome> {
      const { buildContext } = require('../gate/context') as typeof import('../gate/context');
      const { proveRed, proofAsExpected } = require('../gate/tests') as typeof import('../gate/tests');
      try {
        const ctx = buildContext({ repo: call.repo, task: call.task, base: call.base });
        const r = proveRed(ctx);
        if (r.error) return { ok: false, detail: r.error };
        const bad = r.results.filter((x) => !proofAsExpected(x));
        return { ok: !bad.length, detail: bad.length ? `not proven red: ${bad.map((x) => x.criterion).join(', ')}` : `${r.results.length} check(s) proven red` };
      } catch (e) {
        return { ok: false, detail: (e as Error)?.message ?? String(e) };
      }
    },
  };
}

/** Failing step names of an outcome. */
export function failedSteps(o: GateOutcome): string[] {
  return o.steps.filter((s) => s.status === 'fail').map((s) => s.name);
}
