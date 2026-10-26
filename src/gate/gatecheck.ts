import * as path from 'node:path';
import { readTextOr } from '../lib/fsx';
/**
 * The acceptance step for a `gate` check (CheckSpec.kind === 'gate'): a
 * criterion the gate proves by itself, with no test. It reads three things and
 * runs no repository code of its own:
 *
 *   gateSteps      every named step passed in this run (a step skipped because
 *                  the repository has no such script counts as passed and is
 *                  named in the reason; any other skip does not count);
 *   scopePaths     every path changed against the base commit (the working
 *                  tree included, untracked files too) is inside one of the
 *                  listed paths or folders;
 *   keepsHistory   `git merge-base --is-ancestor <base> HEAD`: the brief's base
 *                  commit is still in the history, nothing was rewritten.
 *
 * The step is named `acceptance:<id>` like the other acceptance steps and runs
 * after every other step, so it can read their results. In a partial run
 * (`--steps`) a named step that was not part of the run cannot be read, so the
 * check is skipped there; the full gate runs them all.
 */
import type { Criterion, GateStep } from '../types';
import type { GateContext } from './context';
import { EMPTY_TREE } from './context';
import { rawGit } from '../lib/git';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';

/** The criteria whose check the gate proves by itself. */
export function gateCriteria(ctx: Pick<GateContext, 'criteria'>): Criterion[] {
  return ctx.criteria.filter((c) => c.check?.kind === 'gate');
}

/** A skip that only says the repository has nothing of that kind to run. */
const NOT_APPLICABLE = /\bno\b[^;]*\b(?:script|linter|config(?:ured|uration)?|tsconfig|ledger|coverage output)\b|\bno package\.json\b|nothing to build|single-package repository|empty tree|not a node project/i;

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Whether a repo-relative path is one of the scope paths or inside a scope folder. */
export function inScope(p: string, scope: string[]): boolean {
  const f = norm(p);
  return scope.some((s) => {
    const x = norm(s);
    return !!x && (f === x || f.startsWith(x + '/'));
  });
}

/** Whether a named step counts for a gate-proved check in this run. */
export function stepProblem(name: string, steps: GateStep[], depth = 0): { ok: boolean; note?: string; problem?: string } {
  const s = steps.find((x) => x.name === name);
  if (!s) return { ok: false, problem: `step ${name} did not run in this gate run` };
  if (s.status === 'pass' || s.status === 'cached') return { ok: true };
  if (s.status === 'fail') return { ok: false, problem: `step ${name} failed${s.reasons?.[0] ? ` (${s.reasons[0].slice(0, 160)})` : ''}` };
  // The same failures are at the base commit and nothing is new: this change did not break the step.
  if (s.status === 'pre-existing') return { ok: true, note: `${name} fails the same way at the base commit (pre-existing, nothing new), counted as not broken by this change` };
  const why = s.reasons?.[0] ?? 'no reason given';
  // typecheck skipped because the build script runs tsc: the build step stands for it.
  if (name === 'typecheck' && /build step checks the types/.test(why) && depth === 0) {
    const b = stepProblem('build', steps, 1);
    return b.ok ? { ok: true, note: `typecheck is covered by the build step (the build script runs tsc)${b.note ? `; ${b.note}` : ''}` } : { ok: false, problem: `typecheck is covered by the build step, and ${b.problem}` };
  }
  if (NOT_APPLICABLE.test(why)) return { ok: true, note: `${name} was skipped (${why.slice(0, 120)}), counted as passed` };
  return { ok: false, problem: `step ${name} was skipped (${why.slice(0, 160)}), so it proves nothing` };
}

export function gateOutcome(ctx: GateContext, c: Criterion): StepOutcome {
  const chk = c.check;
  if (!chk || chk.kind !== 'gate') return skip(`${c.id} is not a gate check`);
  const problems: string[] = [];
  const ok: string[] = [];
  const notes: string[] = [];

  const names = chk.gateSteps ?? [];
  if (names.length) {
    const results = ctx.stepResults ?? [];
    const missing = names.filter((n) => !results.some((s) => s.name === n));
    if (missing.length) return skip(`${missing.join(', ')} not part of this run; run \`harness gate\` (all steps) for the verdict`);
    const bad: string[] = [];
    for (const n of names) {
      const r = stepProblem(n, results);
      if (r.problem) bad.push(r.problem);
      if (r.note) notes.push(r.note);
    }
    if (bad.length) problems.push(...bad.map((b) => `${c.id}: ${b}`));
    else ok.push(`${names.join(', ')} passed in this run`);
  }

  if (chk.scopePaths?.length) {
    const scope = chk.scopePaths;
    const changed = new Set<string>();
    for (const d of ctx.diff) {
      changed.add(d.path);
      if (d.oldPath) changed.add(d.oldPath);
    }
    const offenders = [...changed].filter((p) => !inScope(p, scope)).sort();
    if (offenders.length) problems.push(`${c.id}: changed outside ${scope.join(', ')}: ${offenders.slice(0, 20).join(', ')}${offenders.length > 20 ? `, (+${offenders.length - 20} more)` : ''}`);
    else ok.push(changed.size ? `only ${scope.join(', ')} changed (${changed.size} path(s))` : `nothing changed outside ${scope.join(', ')}`);
  }

  if (chk.keepsHistory) {
    if (ctx.base === EMPTY_TREE) ok.push('no base commit yet, so there is no history to rewrite');
    else if (!ctx.head) problems.push(`${c.id}: the repository has no HEAD commit, so the history cannot be checked`);
    else {
      const r = rawGit(ctx.root, ['merge-base', '--is-ancestor', ctx.base, 'HEAD'], 20_000);
      if (r.code === 0) ok.push(`the base commit ${ctx.base.slice(0, 10)} is still in the history`);
      else problems.push(`${c.id}: the base commit ${ctx.base.slice(0, 10)} is no longer an ancestor of HEAD (the history was rewritten; undo the rebase, amend or reset and add a new commit instead)`);
    }
  }

  if (chk.fileContains) {
    const { path: rel, text } = chk.fileContains;
    const abs = path.resolve(ctx.root, rel);
    if (!abs.startsWith(path.resolve(ctx.root) + path.sep)) problems.push(`${c.id}: ${rel} is outside the repository`);
    else {
      const now = readTextOr(abs, null);
      if (now === null) problems.push(`${c.id}: ${rel} does not exist`);
      else if (!now.replace(/\r\n/g, '\n').includes(text)) problems.push(`${c.id}: ${rel} does not contain "${text.slice(0, 80)}"`);
      else {
        const before = ctx.base === EMPTY_TREE ? null : rawGit(ctx.root, ['show', `${ctx.base}:${rel.replace(/\\/g, '/')}`], 20_000);
        const had = before && before.code === 0 && before.stdout.replace(/\r\n/g, '\n').includes(text);
        ok.push(`${rel} contains "${text.slice(0, 80)}"`);
        if (had) notes.push(`${c.id}: ${rel} already contained that text at the base commit ${ctx.base.slice(0, 10)}`);
      }
    }
  }

  if (!names.length && !chk.scopePaths?.length && !chk.keepsHistory && !chk.fileContains) problems.push(`${c.id}: the gate check names no step, no path and no history rule, so it proves nothing`);
  if (problems.length) return fail(capReasons(problems, 20));
  return pass(`proved by the gate: ${ok.join('; ')}`, ...notes);
}

/** One late step per gate check (it reads the other steps' results). */
export function gateCheckSteps(ctx: GateContext): StepDef[] {
  return gateCriteria(ctx).map((c) => ({
    name: `acceptance:${c.id}`,
    design: 9,
    group: 'tests',
    cacheFail: false,
    late: true,
    inputs: () => null,
    run: (x: GateContext) => gateOutcome(x, c),
  }));
}
