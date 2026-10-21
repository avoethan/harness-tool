/**
 * Approval tiers (DESIGN 2.9) and the always-on line budget (DESIGN 2.4).
 *
 *   tier 0  automatic, logged: a check in the private harness folder that only
 *           adds a check, or an enforcer that already exists (the lesson only
 *           records and proves it)
 *   tier 1  the batched review (`harness learn review`): CI, skill text, any
 *           always-loaded line; an approval becomes a plan for `harness apply`
 *   tier 2  never automatic: architecture, hooks and permissions, safety
 *           rails, anything in a team repository (refused outright; routed
 *           to the team's own process)
 *
 * Line budget: the harness owns at most 60 lines of an always-on file
 * (markers included). A tier-1 instruction line is refused when the rendered
 * block would go over, or when learned lines would exceed LEARNED_LINE_CAP;
 * the refusal names the lines to trim (the oldest learned lines first).
 */
import type { Setting } from '../types';
import type { EnforcerPlan, LessonRecord } from './store';

export type TierNumber = 0 | 1 | 2;

export interface TierDecision {
  tier: TierNumber;
  reason: string;
  /** Set when the change is refused outright (a team repository). */
  refused?: string;
}

export const TEAM_REFUSAL = "the change would go into a team repository, which the harness never writes to; carry it through the team's own process (`harness propose --for-team <repo>` writes a proposal there)";

export function tierFor(p: EnforcerPlan, ctx: { setting: Setting }): TierDecision {
  if (p.source === 'rail') return { tier: 2, reason: 'it touches a safety rail; rails are never changed automatically' };
  if (p.rung === 'hook') return { tier: 2, reason: 'hooks and permissions are never changed automatically' };
  if (p.rung === 'types' && !p.existing) return { tier: 2, reason: 'a type change is an architecture change in the code' };
  if (p.existing) return { tier: 0, reason: 'the enforcer is already in place; the lesson records and proves it and writes nothing' };
  if (p.check) return { tier: 0, reason: 'a check in the private harness folder that only adds a check' };
  if (p.rung === 'test' || p.rung === 'ci') {
    if (ctx.setting === 'team') return { tier: 2, reason: 'a test or CI change in a team repository', refused: TEAM_REFUSAL };
    return { tier: 1, reason: p.rung === 'ci' ? 'a CI change in the repository' : 'a test added to the repository' };
  }
  if (p.rung === 'skill') return { tier: 1, reason: 'skill text the agent reads' };
  if (p.rung === 'instruction') return { tier: 1, reason: 'a line in an always-loaded file' };
  return { tier: 1, reason: 'a change the user reviews' };
}

export const ALWAYS_ON_LINE_LIMIT = 60;
/** At most this many learned instruction lines at once (chosen; no evidence; R-22 found 0-50 rules stable). */
export const LEARNED_LINE_CAP = 10;

/** Days until a prose lesson must be reviewed: always-loaded lines 60, skill text 90 (DESIGN 2.9: 60-90). */
export const REVIEW_DAYS = { instruction: 60, skill: 90 } as const;

export function reviewByFor(rung: 'instruction' | 'skill', from = new Date()): string {
  return new Date(from.getTime() + REVIEW_DAYS[rung] * 86_400_000).toISOString().slice(0, 10);
}

export interface BudgetCheck {
  ok: boolean;
  /** Largest rendered block (harness-owned lines, markers included). */
  lines: number;
  maxLines: number;
  learnedLines: number;
  cap: number;
  reason?: string;
  /** Learned lines to expire first to make room (oldest first). */
  trim: string[];
}

/**
 * Decide whether a set of learned instruction lines fits. `blockLines` are the
 * rendered always-on blocks (one per always-on file) with the lines included.
 */
export function checkLineBudget(
  blockLines: number[],
  learned: Array<Pick<LessonRecord, 'id' | 'landedAt' | 'capturedAt'>>,
  opts: { maxLines?: number; cap?: number; candidate?: string } = {},
): BudgetCheck {
  const maxLines = opts.maxLines ?? ALWAYS_ON_LINE_LIMIT;
  const cap = opts.cap ?? LEARNED_LINE_CAP;
  const lines = blockLines.length ? Math.max(...blockLines) : 0;
  const trim = learned
    .filter((l) => l.id !== opts.candidate)
    .sort((a, b) => (a.landedAt ?? a.capturedAt).localeCompare(b.landedAt ?? b.capturedAt))
    .map((l) => l.id);
  const out: BudgetCheck = { ok: true, lines, maxLines, learnedLines: learned.length, cap, trim: [] };
  if (learned.length > cap) {
    out.ok = false;
    out.reason = `${learned.length} learned instruction lines would exceed the cap of ${cap}`;
    out.trim = trim.slice(0, learned.length - cap);
  } else if (lines > maxLines) {
    out.ok = false;
    out.reason = `the always-on block would be ${lines} harness-owned lines (limit ${maxLines})`;
    out.trim = trim.slice(0, Math.max(1, lines - maxLines));
  }
  return out;
}
