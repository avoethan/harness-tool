/**
 * Mistake classes for the learning loop (DESIGN 2.9).
 *
 * A class key names one kind of mistake from instrumentation fields only
 * (never text):
 *
 *   rule:<ledger record id>        a standards rule the gate reported (gate.fail ids.rules)
 *   step:<gate step kind>          a gate step that failed without a rule id (tamper, typecheck, tests, ...)
 *   correction:<class>             a user correction the hook classified (style|test|scope|verify|safety|other)
 *                                  that no earlier gate failure in the same session explains
 *   land:post-landing-red          a landed change turned main red
 *   land:reverted                  a landed change was reverted (without a recorded red run before it)
 *
 * The lesson id is derived from the key, so a re-scan updates the same record.
 */
import { sha256 } from '../lib/hash';
import { slug } from '../lib/paths';

export type ClassKind = 'rule' | 'step' | 'correction' | 'land';

export const CLASS_KINDS: ClassKind[] = ['rule', 'step', 'correction', 'land'];

/** Gate steps that are safety rails (a failure there "touched a rail"). */
export const RAIL_STEPS = new Set(['tamper', 'secrets']);
/** Ledger families whose rules are rails. */
export const RAIL_FAMILIES = new Set(['safety']);
/** Correction classes that touched a rail. */
export const RAIL_CORRECTIONS = new Set(['safety']);

/** The steps the gate runs (src/gate/README.md), by kind. */
export const GATE_STEP_KINDS = ['tamper', 'secrets', 'map-drift', 'e2e', 'standards', 'lint', 'typecheck', 'build', 'tests', 'acceptance', 'coverage', 'affected'];

const KEY_RE = /^(rule|step|correction|land):[a-z0-9][\w.:/-]{0,160}$/i;
const LESSON_ID_RE = /^l-[a-z0-9][a-z0-9-]{1,80}$/;

export function classKey(kind: ClassKind, subject: string): string {
  return `${kind}:${subject}`;
}

export function isClassKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function parseKey(key: string): { kind: ClassKind; subject: string } {
  const i = key.indexOf(':');
  const kind = key.slice(0, i) as ClassKind;
  return { kind: CLASS_KINDS.includes(kind) ? kind : 'correction', subject: key.slice(i + 1) };
}

/** Stable lesson id for a class key: `l-<slug>-<6 hex>`. */
export function lessonIdFor(key: string): string {
  return `l-${slug(key).slice(0, 48)}-${sha256(key).slice(0, 6)}`;
}

export function isLessonId(id: string): boolean {
  return LESSON_ID_RE.test(id);
}

/** The family prefix of a rule id (`logging.no-console` -> `logging`). */
export function ruleFamily(ruleId: string): string {
  const i = ruleId.indexOf('.');
  return i < 0 ? ruleId : ruleId.slice(0, i);
}

/** The step kind of a gate step name (`acceptance:AC1` -> `acceptance`; `tests:base` -> `tests`). */
export function stepKind(step: string): string {
  const i = step.indexOf(':');
  return i < 0 ? step : step.slice(0, i);
}

/** Whether a class key on its own touches a safety rail. */
export function keyTouchesRail(key: string): boolean {
  const { kind, subject } = parseKey(key);
  if (kind === 'rule') return RAIL_FAMILIES.has(ruleFamily(subject));
  if (kind === 'step') return RAIL_STEPS.has(subject);
  if (kind === 'correction') return RAIL_CORRECTIONS.has(subject);
  return false;
}

/** Plain words for a class, built from the key only (there is never any text of the original conversation). */
export function describeKey(key: string): string {
  const { kind, subject } = parseKey(key);
  switch (kind) {
    case 'rule':
      return `the standards rule ${subject} was broken (the gate reported it)`;
    case 'step':
      return `the gate's ${subject} step failed`;
    case 'correction':
      return `the user corrected the agent (${subject} correction) with no gate failure explaining it`;
    case 'land':
      return subject === 'reverted' ? 'a landed change had to be reverted' : 'a landed change turned main red after landing';
    default:
      return key;
  }
}
