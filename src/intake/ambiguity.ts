/**
 * Ambiguity gate and plan lint (team intake, third step).
 *
 * Each unclear point found by classification goes one of three ways:
 * - observable: the answer can be found by running something -> an
 *   observation with the command (the agent runs it; nobody is asked);
 * - reasonable default: assume it and log it -> `assumptions[]`;
 * - a scope / security / privacy / UX fork with materially different
 *   readings, or a fact the ticket does not give -> a question with options
 *   and a recommended default.
 *
 * Caps: at most 3 open markers (criteria whose work waits for an answer) and
 * at most 5 questions in one batch, ordered blocking first, then by impact x
 * uncertainty. These caps are conventions borrowed from a published spec
 * template, not measured effects. Blocking questions over the caps wait in a
 * queue for the next batch; non-blocking forks over the cap fall back to their
 * recommended option and are logged as assumptions.
 *
 * The plan lint rejects a brief in which any criterion has neither a check nor
 * an open question.
 */
import type { Criterion, Unit } from '../types';
import type { Unclear } from './classify';

export const MAX_OPEN_MARKERS = 3;
export const MAX_QUESTIONS = 5;

export interface Question {
  /** Number the user answers with (`--q <n>`); stable for the life of the brief. */
  n: number;
  /** Stable key: `<criterionId|ticket>:<topic>`. */
  key: string;
  criterionId?: string;
  topic: Unclear['topic'];
  text: string;
  options: string[];
  /** Index into options. */
  recommended: number;
  /** Work on the criterion waits for the answer. */
  blocking: boolean;
  /** impact x uncertainty, for ordering. */
  score: number;
  /**
   * Nobody was there to answer (`--unattended`): the recommended option was taken and recorded as an
   * assumption. The question stays listed so a person can overturn it with `harness intake answer`.
   */
  unattended?: boolean;
}

export interface Observation {
  criterionId?: string;
  text: string;
  command?: string;
}

export interface GateResult {
  /** This batch (at most MAX_QUESTIONS, at most MAX_OPEN_MARKERS blocking). */
  questions: Question[];
  /** Blocking questions over the caps, asked in a later batch. */
  queued: Question[];
  /** Criterion ids that carry an open marker (their work waits for an answer). */
  markers: string[];
  assumptions: string[];
  observations: Observation[];
}

export interface GateOptions {
  maxQuestions?: number;
  maxMarkers?: number;
  /** Question keys already answered; they are not asked again. */
  answered?: Set<string>;
  /** First question number to use (numbers already used by answered questions are skipped). */
  firstNumber?: number;
  /** Questions answered by default because no one was there (key -> its number): listed, never blocking, never counted against the caps. */
  unattended?: Map<string, number>;
}

export function questionKey(u: Pick<Unclear, 'criterionId' | 'topic'>): string {
  return `${u.criterionId ?? 'ticket'}:${u.topic}`;
}

/** Decide observable / default / question for every unclear point and apply the caps. */
export function ambiguityGate(unclear: Unclear[], opts: GateOptions = {}): GateResult {
  const maxQ = opts.maxQuestions ?? MAX_QUESTIONS;
  const maxM = opts.maxMarkers ?? MAX_OPEN_MARKERS;
  const answered = opts.answered ?? new Set<string>();
  const unattendedKeys = opts.unattended ?? new Map<string, number>();
  const observations: Observation[] = [];
  const assumptions: string[] = [];
  const candidates: Array<Question & { order: number }> = [];
  const seenKeys = new Set<string>();

  unclear.forEach((u, order) => {
    const key = questionKey(u);
    if (u.command) {
      observations.push({ ...(u.criterionId ? { criterionId: u.criterionId } : {}), text: u.detail, command: u.command });
      return;
    }
    if (u.question && u.options && u.options.length) {
      if (answered.has(key) || seenKeys.has(key)) return;
      seenKeys.add(key);
      const recommended = Math.min(Math.max(u.recommended ?? 0, 0), u.options.length - 1);
      candidates.push({
        n: 0,
        key,
        ...(u.criterionId ? { criterionId: u.criterionId } : {}),
        topic: u.topic,
        text: u.question,
        options: u.options,
        recommended,
        blocking: !!u.blocking,
        score: (u.impact ?? 3) * (u.uncertainty ?? 2),
        order,
      });
      return;
    }
    if (u.assume) assumptions.push(u.assume);
  });

  candidates.sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.score - a.score || a.order - b.order);
  const questions: Question[] = [];
  const queued: Question[] = [];
  const markers: string[] = [];
  for (const c of candidates) {
    const { order: _o, ...q } = c;
    void _o;
    if (unattendedKeys.has(q.key)) {
      // taken on its recommended option already (recorded as an assumption by the caller): listed so it can be overturned
      questions.push({ ...q, blocking: false, unattended: true });
      continue;
    }
    if (q.blocking) {
      const markerFree = !q.criterionId || markers.includes(q.criterionId) || markers.length < maxM;
      if (questions.length < maxQ && markerFree) {
        questions.push(q);
        if (q.criterionId && !markers.includes(q.criterionId)) markers.push(q.criterionId);
      } else queued.push(q);
    } else if (questions.length < maxQ) {
      questions.push(q);
      assumptions.push(`${q.criterionId ? q.criterionId + ': ' : ''}until answered, assumed "${q.options[q.recommended]}" (${q.topic})`);
    } else {
      assumptions.push(`${q.criterionId ? q.criterionId + ': ' : ''}assumed "${q.options[q.recommended]}" (${q.topic}; not asked, question cap of ${maxQ} reached)`);
    }
  }
  let n = opts.firstNumber ?? 1;
  for (const q of [...questions, ...queued]) q.n = unattendedKeys.get(q.key) ?? n++;
  return { questions, queued, markers, assumptions, observations };
}

const LETTERS = 'ABCDEFGHIJ';

/** One question as the user reads it. */
export function formatQuestion(q: Question): string {
  const head = `Q${q.n} [${q.topic}${q.criterionId ? `, ${q.criterionId}` : ''}${q.blocking ? ', blocks ' + (q.criterionId ?? 'the ticket') : ''}${q.unattended ? ', assumed: unattended' : ''}] ${q.text}`;
  const opts = q.options.map((o, i) => `   ${LETTERS[i]}) ${o}${i === q.recommended ? '  (recommended)' : ''}`);
  return [head, ...opts].join('\n');
}

/** One-line form stored in Brief.questions. */
export function questionLine(q: Question): string {
  return `Q${q.n} [${q.topic}${q.criterionId ? `, ${q.criterionId}` : ''}] ${q.text} Options: ${q.options.map((o, i) => `${LETTERS[i]}) ${o}${i === q.recommended ? ' (recommended)' : ''}`).join(' ')}`;
}

/** The questions block, formatted so the user can answer everything in one message. */
export function formatQuestionsBlock(questions: Question[], briefId: string): string {
  if (!questions.length) return '';
  const lines = [
    `Questions (${questions.length}; answer them all in one message, e.g. "Q${questions[0].n}: B". A question you skip keeps its recommended option, except those marked "blocks", whose criterion waits for you):`,
    ...questions.map(formatQuestion),
    ...(questions.some((q) => q.unattended) ? ['Questions marked "assumed: unattended" took their recommended option because no one was there to answer; they are in the assumptions too. Overturn one with the command below.'] : []),
    `Record an answer: harness intake answer ${briefId} --q <n> --answer "<letter or text>"`,
  ];
  return lines.join('\n');
}

/** Answers that hand the choice back to a person ("Tell me ...", "Something else: say what"); no one is there to give one. */
const NON_ANSWER = /^(?:tell me\b|another\b|something else\b|i will\b|a list i will\b|use the wording i will\b)/i;

/** The option taken when no one can answer: the recommended one, unless it only asks the person to answer. */
export function unattendedOption(q: Pick<Question, 'options' | 'recommended'>): string {
  const rec = q.options[q.recommended];
  if (!NON_ANSWER.test(rec)) return rec;
  return q.options.find((o) => !NON_ANSWER.test(o) && !/^drop\b/i.test(o)) ?? rec;
}

/** Map an answer such as "B", "b)", "option B" or free text to the text that is recorded. */
export function resolveAnswer(q: Question, answer: string): string {
  const a = answer.trim();
  const m = /^(?:option\s+)?([A-Ja-j])\)?\.?$/.exec(a);
  if (m) {
    const i = LETTERS.indexOf(m[1].toUpperCase());
    if (i >= 0 && i < q.options.length) return q.options[i];
  }
  return a;
}

export interface LintInput {
  criteria: Criterion[];
  units?: Unit[];
  /** Open questions (batch + queued). */
  open: Array<Pick<Question, 'criterionId' | 'blocking'>>;
  markers?: string[];
  batchSize?: number;
}

/**
 * Plan lint: every criterion needs a red-first (or green-at-base) check or an open question; the
 * brief needs at least one criterion or a question asking for them; every
 * criterion sits in a unit; the caps hold.
 */
export function lintBrief(b: LintInput): string[] {
  const problems: string[] = [];
  const openFor = new Set(b.open.map((q) => q.criterionId ?? 'ticket'));
  if (!b.criteria.length && !openFor.has('ticket')) problems.push('The brief has no acceptance criteria and no question asking for them.');
  for (const c of b.criteria) {
    if (!c.check && !openFor.has(c.id)) problems.push(`${c.id}: no check and no open question ("${c.text.slice(0, 60)}")`);
    if (c.check && c.check.redFirst !== true && !c.check.greenAtBase && c.check.kind !== 'gate') problems.push(`${c.id}: the check is not marked red-first`);
  }
  if (b.units) {
    const inUnit = new Set(b.units.flatMap((u) => u.criteria));
    for (const c of b.criteria) if (!inUnit.has(c.id)) problems.push(`${c.id}: not in any unit`);
  }
  if ((b.markers?.length ?? 0) > MAX_OPEN_MARKERS) problems.push(`${b.markers!.length} open markers (cap ${MAX_OPEN_MARKERS})`);
  if ((b.batchSize ?? 0) > MAX_QUESTIONS) problems.push(`${b.batchSize} questions in one batch (cap ${MAX_QUESTIONS})`);
  return problems;
}
