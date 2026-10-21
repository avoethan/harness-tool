/**
 * The step model shared by every gate step, and the step names.
 *
 * Steps run cheapest first. Each has its DESIGN §2.5 number (`design`), which
 * hook modes use: pre-commit runs design steps 1-4, pre-push and ci run all.
 * Acceptance and E2E steps are one step per criterion, named with the
 * criterion id as a word (`acceptance:AC1`, `e2e:AC2`) so the write-up can
 * link criteria to steps.
 */
import type { GateContext } from './context';

export interface StepOutcome {
  status: 'pass' | 'fail' | 'skip';
  /** Failures (fail), the skip reason (skip), or notes and warnings (pass). */
  reasons: string[];
}

export interface StepDef {
  name: string;
  /** DESIGN §2.5 step number (1 tamper ... 9 affected scope). */
  design: number;
  /** Selector group for `--steps` (`tests` covers `tests:base` and every `acceptance:*`). */
  group: string;
  /** Cache inputs (digests); null means the step is never cached. */
  inputs(ctx: GateContext): string[] | null;
  /** Reuse a cached failure (deterministic file checks only). */
  cacheFail: boolean;
  /** Runs after every other step (it reads their results in `ctx.stepResults`). */
  late?: boolean;
  /** Steps whose failure makes this one pointless; it is skipped with a reason. */
  after?: string[];
  run(ctx: GateContext): StepOutcome | Promise<StepOutcome>;
}

/** The order steps run in (cheapest first), by name prefix. */
export const STEP_ORDER = ['tamper', 'secrets', 'map-drift', 'e2e', 'standards', 'lint', 'typecheck', 'build', 'tests', 'acceptance', 'coverage', 'affected'];

export const STEP_HELP: Record<string, string> = {
  tamper: 'Restore deleted, skipped or weakened tests and protected files. If the ticket really needs a test changed, run `harness phase tests` first; a protected file may change only when the brief allows its path.',
  secrets: 'Take the secret out of the change (read it from the environment instead) and rotate it if it was real. The gate names the pattern and file, never the value.',
  'map-drift': 'Add an entry for each listed route or migration id to the feature-map overlay (`harness verify maintain`), or say why it needs none.',
  e2e: "Run the brief's `harness verify drive` / `harness verify db` line for each listed check on the current tree; an artefact from an older tree does not count.",
  standards: 'Change the code to follow each listed rule; the fix text says how. These are the codebase\'s own standards with evidence.',
  lint: "Fix the lint and format problems in the files you changed (the repository's own ESLint and Prettier).",
  typecheck: 'Fix the type errors listed; do not loosen tsconfig or add `any`.',
  build: "Fix the build error listed; the build runs the repository's own build script from the base commit.",
  tests: 'These tests existed before your change: make them pass without editing them.',
  acceptance: 'Each acceptance check must be proven red at the base commit (`harness gate prove-red`) and pass now; a green-at-base check only has to exist and pass now; a check proved by the gate needs its named steps to pass, the change to stay inside its paths and the history to stay (undo with `git revert --no-commit`, never rebase or amend).',
  coverage: 'Add tests that execute the uncovered changed lines.',
  affected: 'Fix the failing scripts of the affected packages (the packages you changed and the ones that depend on them).',
};

export function prefixOf(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(0, i);
}

export function orderIndex(name: string): number {
  const i = STEP_ORDER.indexOf(prefixOf(name));
  return i < 0 ? STEP_ORDER.length : i;
}

/** Sort steps cheapest first, keeping the given order within one kind (criteria in brief order). */
export function sortSteps<T extends { name: string; late?: boolean }>(steps: T[]): T[] {
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(!!a.s.late) - Number(!!b.s.late) || orderIndex(a.s.name) - orderIndex(b.s.name) || a.i - b.i)
    .map((x) => x.s);
}

/** Whether a `--steps` selector picks a step: exact name, kind prefix, group, or design number. */
export function selects(selector: string, step: Pick<StepDef, 'name' | 'group' | 'design'>): boolean {
  const s = selector.trim();
  if (!s) return false;
  if (s === step.name || s === prefixOf(step.name) || s === step.group) return true;
  if (/^\d$/.test(s)) return Number(s) === step.design;
  return false;
}

export function pass(...reasons: string[]): StepOutcome {
  return { status: 'pass', reasons };
}
export function fail(reasons: string[]): StepOutcome {
  return { status: 'fail', reasons };
}
export function skip(reason: string): StepOutcome {
  return { status: 'skip', reasons: [reason] };
}

/** Cap a list of reasons, saying how many were left out. */
export function capReasons(reasons: string[], max = 25): string[] {
  if (reasons.length <= max) return reasons;
  return [...reasons.slice(0, max), `(+${reasons.length - max} more)`];
}
