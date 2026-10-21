/**
 * The enforcer ladder (DESIGN 2.9, R-30): for a mistake class, the highest
 * rung that can express the mistake, chosen from what the harness already
 * knows (the ledger and its check specs, the gate's steps, the probe
 * library's test cases). When the enforcer needs code or a judgment (naming a
 * convention, writing a rule, naming a regression test) the proposal says so
 * and the scan writes a judgment bundle (judgment.ts).
 *
 *   (a) types  (b) lint / ast-grep / Semgrep rule whose error names the fix
 *   (c) regression test  (d) hook  (e) CI / gate step  (f) skill text
 *   (g) instruction line, last, a negative constraint with an expiry
 *
 * Decisions (see README): a class the gate already blocks is recorded with
 * the existing enforcer (nothing is written); a warn-mode rule the gate keeps
 * reporting is promoted to a block-mode learned check (tier 0); an ESLint
 * warning, a rule without a file-scoped check, an unexplained correction and
 * a broken landing need the judgment pass.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnforcerRung, Ledger, LedgerRecord } from '../types';
import type { CheckSpec } from '../discover/checks';
import type { ProbeTestCase } from '../discover/model';
import { parseKey, type ClassKind } from './classes';
import type { EnforcerPlan, LearnedCheck } from './store';

export const RUNG_ORDER: EnforcerRung[] = ['types', 'lint', 'test', 'hook', 'ci', 'skill', 'instruction'];

/** Plain words per rung, for reports and the review. */
export const RUNG_WORDS: Record<EnforcerRung, string> = {
  types: 'types (the bad state cannot be written)',
  lint: 'a lint or pattern rule whose error names the fix',
  test: 'a regression test',
  hook: 'a hook rule',
  ci: 'a CI or gate step',
  skill: 'skill text',
  instruction: 'one instruction line (a negative constraint that expires)',
};

export interface LadderInput {
  key: string;
  touchedRail: boolean;
  /** Occurrences that came from gate.fail events (proof by the gate's own report). */
  gateFails: number;
  /** Set by gc: a prose lesson that came back; only code rungs are acceptable now. */
  promote?: boolean;
  lessonId: string;
}

export interface LadderContext {
  /** The discovered ledger (not merged with learned checks). */
  ledger: Ledger | null;
  /** Where discovery wrote the check specs. */
  checksDir: string;
  /** The probe library's test cases by rule id (`<probe>/<variant>`). */
  probeTests?: Map<string, ProbeTestCase>;
}

export interface LadderDecision {
  proposal?: EnforcerPlan;
  /** Set when the enforcer needs code or a judgment the harness cannot make alone. */
  needsJudgment?: { reason: string; rungs: EnforcerRung[]; suggested: EnforcerRung };
}

const BLOCK_TIERS = new Set(['declared', 'counted-strong']);

export function recordBlocks(r: Pick<LedgerRecord, 'tier' | 'check'>): boolean {
  return BLOCK_TIERS.has(r.tier) || r.check?.mode === 'block';
}

export function loadSpecFor(dir: string, r: LedgerRecord): CheckSpec | null {
  const ref = r.check.ref ? path.basename(r.check.ref) : `${r.id}.json`;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ref), 'utf8')) as CheckSpec;
  } catch {
    return null;
  }
}

/** Test cases from the probe library for an ast-grep spec's violating rules. */
export function probeFixtures(spec: CheckSpec, tests: Map<string, ProbeTestCase> | undefined): { valid: string[]; invalid: string[] } | null {
  if (!tests || spec.engine !== 'ast-grep') return null;
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const r of spec.rules ?? []) {
    const id = String(r.id ?? '').replace(/@\w+$/, '');
    const t = tests.get(id);
    if (!t) continue;
    for (const s of t.invalid) if (!invalid.includes(s)) invalid.push(s);
    for (const s of t.valid) if (!valid.includes(s)) valid.push(s);
  }
  return invalid.length ? { valid, invalid } : null;
}

/** The learned check that promotes a discovered warn-mode record to block mode (same rules, same id). */
export function promotedCheck(r: LedgerRecord, spec: CheckSpec): LearnedCheck {
  const body: Record<string, unknown> = {};
  for (const k of ['files', 'exclude', 'rules', 'target', 'conform', 'violate', 'flags', 'builtin', 'data', 'baseline'] as const) {
    if (spec[k] !== undefined) body[k] = spec[k];
  }
  return {
    id: r.id,
    family: r.family,
    statement: r.statement,
    fixText: r.check.fixText ?? spec.fixText ?? '',
    overrides: r.id,
    engine: spec.engine as LearnedCheck['engine'],
    spec: body,
    scope: r.scope,
  };
}

const SUGGESTED: Record<string, EnforcerRung> = { style: 'lint', test: 'test', verify: 'test', scope: 'skill', safety: 'hook', other: 'instruction' };
const STEP_RUNG: Record<string, EnforcerRung> = { typecheck: 'types', lint: 'lint', build: 'ci', tests: 'test', acceptance: 'test' };

/** Choose the enforcer for a class (see the header for the rules). */
export function chooseEnforcer(input: LadderInput, ctx: LadderContext): LadderDecision {
  const { kind, subject } = parseKey(input.key);
  const allRungs: EnforcerRung[] = ['lint', 'test', 'skill', 'instruction'];
  if (input.promote) {
    return { needsJudgment: { reason: 'a prose lesson whose class came back twice after it landed: it needs a code check now (a rule or a regression test)', rungs: ['lint', 'test'], suggested: 'lint' } };
  }
  if (input.touchedRail) {
    return {
      proposal: {
        rung: 'hook',
        ref: 'rail',
        why: 'the mistake touched a safety rail; rails are enforced by the guard hook and the permission rules, which are never changed automatically',
        existing: true,
        source: 'rail',
      },
    };
  }
  const k: ClassKind = kind;
  if (k === 'rule') {
    const rec = ctx.ledger?.records.find((r) => r.id === subject);
    if (!rec) {
      return { needsJudgment: { reason: `the rule ${subject} is not in the current ledger, so the harness has no check to build on; write one`, rungs: ['lint', 'test', 'skill', 'instruction'], suggested: 'lint' } };
    }
    const spec = loadSpecFor(ctx.checksDir, rec);
    const engine = spec?.engine;
    if (spec && (engine === 'ast-grep' || engine === 'regex' || engine === 'builtin' || engine === 'subjects')) {
      const fx = probeFixtures(spec, ctx.probeTests);
      const fixtures = fx ? { ...fx, source: 'probe-library' as const } : undefined;
      if (recordBlocks(rec)) {
        return {
          proposal: {
            rung: 'lint',
            ref: `ledger:${rec.id}`,
            why: `the ledger check ${rec.id} already blocks this at the gate and is injected at edit time; types cannot express a code-shape convention, so this is the highest rung; nothing new is written`,
            existing: true,
            source: 'ledger',
            fixtures,
          },
        };
      }
      return {
        proposal: {
          rung: 'lint',
          ref: `learned/${rec.id}.json`,
          why: `the ledger check ${rec.id} only warns, and the gate kept reporting it; promote the same check to block mode in the private harness folder (types cannot express a code-shape convention)`,
          existing: false,
          source: 'ledger',
          check: promotedCheck(rec, spec),
          fixtures,
        },
      };
    }
    if (spec && engine === 'eslint' && recordBlocks(rec)) {
      return {
        proposal: {
          rung: 'lint',
          ref: `eslint:${spec.eslint?.rule ?? rec.id}`,
          why: `the repository's ESLint rule ${spec.eslint?.rule ?? rec.id} already fails the gate's lint step on this; nothing new is written`,
          existing: true,
          source: 'ledger',
        },
      };
    }
    const why = !spec ? 'no check spec on disk for it' : engine === 'eslint' ? `it is the repository's ESLint rule ${spec.eslint?.rule ?? ''} at warning level, which the harness does not change in the repository` : `its check is ${engine} (${spec.note ?? 'not file-scoped'})`;
    return { needsJudgment: { reason: `the rule ${rec.id} has no blocking file-scoped check (${why}); write an ast-grep or regex rule whose message names the fix`, rungs: allRungs, suggested: 'lint' } };
  }
  if (k === 'step') {
    const rung = STEP_RUNG[subject] ?? 'ci';
    return {
      proposal: {
        rung,
        ref: `gate:${subject}`,
        why: `the gate's ${subject} step already fails on this mistake (the gate.fail events are its fires); a narrower rule needs the failing code, which the log does not keep`,
        existing: true,
        source: 'gate-step',
      },
    };
  }
  if (k === 'land') {
    return { needsJudgment: { reason: 'a landing broke main: name the regression test (committed with the fix) that fails on the commit before the fix and passes on the fix', rungs: ['test'], suggested: 'test' } };
  }
  // correction
  return {
    needsJudgment: {
      reason: `repeated ${subject} corrections with no gate failure explaining them: name the convention and the highest rung that can enforce it`,
      rungs: subject === 'safety' ? ['hook'] : allRungs,
      suggested: SUGGESTED[subject] ?? 'instruction',
    },
  };
}
