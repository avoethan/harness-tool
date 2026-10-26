/**
 * `harness gate`: the done-gate (DESIGN §2.5). See src/gate/README.md.
 *
 *   harness gate [--task <id>] [--repo <path>] [--base <sha>] [--steps a,b,c] [--json]
 *   harness gate --hook pre-commit|pre-push|ci
 *   harness gate --blocked "<reason>"
 *   harness gate prove-red [--task <id>] [--repo <path>] [--base <sha>] [--json]
 *
 * A full run (PASS, FAIL or BLOCKED) ends by writing the task's writeup.md and
 * printing `Write-up: <path>` as the last line; a `--steps` run does not.
 *
 * Exit codes: 0 PASS (or a partial run with no failure); 1 FAIL; 2 usage;
 * 4 BLOCKED. prove-red: 0 every acceptance check proven red; 1 otherwise;
 * 2 nothing to prove (no brief or no unit checks).
 */
import type { CommandMeta } from '../cli';
import { parseArgv, DEFAULT_BOOLEANS } from '../lib/argv';
import { instrument } from '../lib/log';
import { runGate, GateError } from '../gate';
import { writeupAfterGate } from '../gate/writeup';
import { buildContext, resolveRepoRoot, type HookName } from '../gate/context';
import { proofAsExpected, proveRed } from '../gate/tests';
import { checkPushLines, parsePushLines, readHookInput, refusalMessage } from '../gate/prepush';

export const meta: CommandMeta = {
  name: 'gate',
  summary: 'Run the done-gate and write evidence',
  usage:
    'harness gate [--task <id>] [--repo <path>] [--base <sha>] [--steps a,b,c] [--json] [--no-cache] [--hook pre-commit|pre-push|ci] [--blocked "<reason>"] [--session <id>]\n       harness gate prove-red [--task <id>] [--repo <path>] [--base <sha>] [--json]',
  examples: ['harness gate', 'harness gate --steps tamper,standards', 'harness gate prove-red', 'harness gate --hook pre-commit', 'harness gate --blocked "the ticket needs a schema decision from the team"'],
};

const HOOKS = new Set(['pre-commit', 'pre-push', 'ci']);

function str(v: unknown): string | undefined {
  if (Array.isArray(v)) return str(v[v.length - 1]);
  return typeof v === 'string' ? v : undefined;
}

function usage(msg: string): number {
  process.stderr.write(`gate: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, new Set([...DEFAULT_BOOLEANS, 'cache']));
  if (a.flags.help || a.flags.h) {
    process.stdout.write(`${meta.summary}\n\nUsage: ${meta.usage}\n`);
    return 0;
  }
  const sub = a.positional[0];
  if (sub && sub !== 'prove-red' && sub !== 'run') return usage(`unknown subcommand: ${sub}`);
  const repo = str(a.flags.repo);
  const task = str(a.flags.task);
  const base = str(a.flags.base);
  const json = a.flags.json === true;
  const hookRaw = a.flags.hook;
  if (hookRaw !== undefined && (typeof hookRaw !== 'string' || !HOOKS.has(hookRaw))) return usage('--hook takes pre-commit, pre-push or ci');
  const hook = hookRaw as HookName | undefined;
  const sessionId = str(a.flags.session) ?? process.env.HARNESS_SESSION_ID ?? undefined;
  try {
    if (sub === 'prove-red') {
      if (hook) return usage('prove-red does not take --hook');
      const ctx = buildContext({ repo, task, base, sessionId });
      const r = proveRed(ctx);
      instrument({ event: 'gate.prove-red', repo: ctx.repoId, task: ctx.taskId, ids: { outcome: r.error ? 'error' : 'ran' }, counts: { checks: r.results.length, gate: r.gate.length, red: r.results.filter((x) => x.proof.result === 'red').length, greenAtBase: r.results.filter((x) => x.greenAtBase).length } });
      if (json) process.stdout.write(JSON.stringify({ task: ctx.taskId, base: ctx.base, error: r.error ?? null, results: r.results, gate: r.gate }, null, 2) + '\n');
      if (r.error) {
        if (!json) process.stderr.write(`gate prove-red: ${r.error}\n`);
        return 2;
      }
      if (!json) for (const g of r.gate) process.stdout.write(`  GATE  ${g.criterion}  ${g.detail}\n`);
      if (r.note) {
        if (!json) process.stdout.write(`gate prove-red: ${r.note}\nNow implement (\`harness phase implement\`).\n`);
        return 0;
      }
      if (!json) {
        process.stdout.write(`Proving the acceptance checks of task ${ctx.taskId} red at the base commit ${ctx.base.slice(0, 10)} (${ctx.baseSource}):\n`);
        for (const x of r.results) process.stdout.write(`  ${x.greenAtBase && proofAsExpected(x) ? 'BASE' : x.proof.result === 'red' ? 'RED ' : 'NOT '}  ${x.criterion}  ${x.detail}${x.proof.files.length ? ` [${x.proof.files.join(', ')}]` : ''}\n`);
        const bad = r.results.filter((x) => !proofAsExpected(x));
        const base = r.results.filter((x) => x.greenAtBase).length;
        process.stdout.write(
          bad.length
            ? `\n${bad.length} check(s) not proven red. A check that passes without the change proves nothing: make it fail at the base commit, then run this again.\n`
            : `\nEvery acceptance check is as expected${base ? ` (${r.results.length - base} proven red, ${base} green-at-base: they must keep passing)` : ' (proven red)'}; the results are recorded in the brief. Now implement (\`harness phase implement\`).\n`,
        );
      }
      return r.results.every(proofAsExpected) ? 0 : 1;
    }
    const blockedRaw = a.flags.blocked;
    let blocked: string | undefined;
    if (blockedRaw !== undefined) {
      blocked = str(blockedRaw);
      if (!blocked || !blocked.trim()) return usage('--blocked needs the reason, in quotes: harness gate --blocked "<reason>"');
    }
    const stepsRaw = a.flags.steps;
    const steps = stepsRaw === undefined ? undefined : (Array.isArray(stepsRaw) ? stepsRaw : [String(stepsRaw)]).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
    if (stepsRaw !== undefined && !steps?.length) return usage('--steps needs a comma-separated list (for example --steps tamper,standards)');
    if (hook === 'pre-push') {
      // git hands the pushed refs on standard input: refuse deletions and non-fast-forward updates before any step runs.
      const lines = parsePushLines(readHookInput());
      const root = resolveRepoRoot(repo ?? process.cwd()) ?? (repo ?? process.cwd());
      const refused = checkPushLines(root, lines);
      instrument({ event: 'gate.prepush', ids: { outcome: refused.length ? 'refused' : 'ok' }, counts: { refs: lines.length, refused: refused.length } });
      if (refused.length) {
        process.stderr.write(refusalMessage(refused));
        return 1;
      }
    }
    const r = await runGate({ repo, task, base, hook, steps, blocked, sessionId, noCache: a.flags.cache === false });
    const wu = writeupAfterGate(r);
    if (json) process.stdout.write(JSON.stringify({ verdict: r.partial ? null : r.evidence.verdict, exitCode: r.exitCode, evidencePath: r.evidencePath, writeupPath: wu?.path ?? null, partial: r.partial, durationMs: r.durationMs, localChanges: { leftOut: r.ctx.local.leftOut, changedSince: r.ctx.local.changedSince, withheld: r.ctx.local.snapshot?.withheld ?? 0 }, evidence: r.evidence }, null, 2) + '\n');
    else {
      process.stdout.write(r.report.endsWith('\n') ? r.report : r.report + '\n');
      if (wu) process.stdout.write(wu.line + '\n');
    }
    return r.exitCode;
  } catch (e) {
    if (e instanceof GateError) {
      process.stderr.write(`gate: ${e.message}\n`);
      return e.exitCode;
    }
    process.stderr.write(`gate: internal error: ${(e as Error)?.message ?? String(e)}\n`);
    return 1;
  }
}
