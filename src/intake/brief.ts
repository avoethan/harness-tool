/**
 * The brief: intake output and its store.
 *
 *   ~/.harness/briefs/<id>.json        BriefFile (a superset of Brief in types.ts)
 *   ~/.harness/runs/<repoId>/current-task   the task id the gate and the write-up use
 *   ~/.harness/runs/<repoId>/<taskId>/      run folder (phase.json, evidence.json, writeup.md)
 *
 * The ticket text is stored only as parsed fields inside the brief (title,
 * description, criteria); its sha256 is the only trace that goes to logs. The
 * brief id is derived from that hash (`t-<10 hex>`), never from the ticket's
 * own key.
 *
 * `assemble` runs classification, the ambiguity gate, the size gate and the
 * plan lint over the stored criteria; `answerQuestion` records an answer and
 * re-runs `assemble`, so an answer re-classifies its criterion.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Brief, Criterion, CriterionKind, HarnessConfig } from '../types';
import { readJsonOr, readTextOr, writeJson, writeTextAtomic } from '../lib/fsx';
import { harnessHome, runsDir } from '../lib/paths';
import { repoIdFor } from '../lib/config';
import { headSha, isGitRepo } from '../lib/git';
import { stripHiddenUnicode } from '../lib/unicode';
import { parseTicket, type CriterionSource, type TicketFormat, LOW_CONFIDENCE } from './parse';
import {
  applyTicketEndpoint,
  checkFor,
  classifyKind,
  ticketEndpoints,
  earsRewrite,
  extractFacts,
  forksFor,
  mapCriterionRepos,
  mentionsRepo,
  repoInfos,
  type CriterionFacts,
  type RepoInfo,
  type RepoMatch,
  type Unclear,
} from './classify';
import { ambiguityGate, lintBrief, questionKey, questionLine, resolveAnswer, unattendedOption, type Observation, type Question } from './ambiguity';
import { planUnits, UNMAPPED } from './units';

export interface CriterionMeta {
  /** The ticket's own label (AC3, 2, b) when it had one. */
  label?: string;
  source: CriterionSource;
  /** How sure the parser is that this line is a criterion. */
  parseConfidence: number;
  /** How sure the classifier is about the kind. */
  kindConfidence: number;
  reasons: string[];
  repos: string[];
  repoHow: RepoMatch['how'];
  facts: CriterionFacts;
}

export interface Clarification {
  n: number;
  key: string;
  criterionId?: string;
  topic: string;
  q: string;
  a: string;
  at: string;
  /** The recommended option, taken because no one was there to answer; a person's answer replaces it. */
  unattended?: boolean;
  /** With `unattended`: the options and the recommended index, so the question can stay listed after its criterion is classified. */
  options?: string[];
  recommended?: number;
}

export interface BriefFile extends Brief {
  version: 1;
  source: 'ticket' | 'ledger';
  format: TicketFormat;
  /** True when the criteria were read from prose (no criteria list in the ticket). */
  inferred: boolean;
  codeBlocks: number;
  hiddenRemoved: number;
  criteriaMeta: Record<string, CriterionMeta>;
  /** The open batch (at most 5). */
  questionDetails: Question[];
  /** Blocking questions waiting for a later batch. */
  queued: Question[];
  /** Criteria whose work waits for an answer (at most 3). */
  markers: string[];
  observations: Observation[];
  clarifications: Clarification[];
  /** Criteria removed by an answer. */
  dropped: Criterion[];
  repoMap: {
    /** Repos the ticket as a whole mentions. */
    ticket: string[];
    byCriterion: Record<string, string[]>;
    repos: Record<string, { name: string; path: string }>;
  };
  landingOrder: string[];
  unitEstimates: Record<string, number>;
  /** HEAD of each mapped repo at intake (the base commit unless the gate records another). */
  baseShas: Record<string, string>;
  /** Plan-lint problems; empty when the brief is complete. */
  lint: string[];
  updatedAt: string;
}

export interface IntakeContext {
  config: Pick<HarnessConfig, 'repos'>;
  /** `--repo` or the git root of the working directory. */
  defaultRepoPath?: string;
  now?: Date;
  /**
   * No one is there to answer (`harness intake --unattended`, `HARNESS_UNATTENDED=1`, the personal runner):
   * a blocking question takes its recommended option, recorded as an assumption, and does not hold its criterion open.
   */
  unattended?: boolean;
  /** Force an id (ledger tasks use their own id). */
  id?: string;
  source?: 'ticket' | 'ledger';
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function validId(id: string): boolean {
  return ID_RE.test(id) && !id.includes('..');
}

export function briefsDir(): string {
  return path.join(harnessHome(), 'briefs');
}

export function briefPath(id: string): string {
  if (!validId(id)) throw new Error(`invalid brief id: ${JSON.stringify(id.slice(0, 40))}`);
  return path.join(briefsDir(), `${id}.json`);
}

export function saveBrief(b: BriefFile): void {
  writeJson(briefPath(b.id), b);
}

export function loadBrief(id: string): BriefFile | null {
  if (!validId(id)) return null;
  const b = readJsonOr<BriefFile | null>(briefPath(id), null);
  return b && b.version === 1 && Array.isArray(b.criteria) ? b : null;
}

export function listBriefs(): BriefFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(briefsDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => loadBrief(n.slice(0, -5)))
    .filter((b): b is BriefFile => !!b)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export function runDir(repoId: string, taskId: string): string {
  if (!validId(repoId) || !validId(taskId)) throw new Error('invalid repo or task id');
  return path.join(runsDir(), repoId, taskId);
}

export function currentTaskPath(repoId: string): string {
  if (!validId(repoId)) throw new Error('invalid repo id');
  return path.join(runsDir(), repoId, 'current-task');
}

export function setCurrentTask(repoId: string, taskId: string): void {
  if (!validId(taskId)) throw new Error('invalid task id');
  writeTextAtomic(currentTaskPath(repoId), taskId + '\n');
}

export function getCurrentTask(repoId: string): string | null {
  const t = (readTextOr(currentTaskPath(repoId), '') ?? '').trim();
  return t && validId(t) ? t : null;
}

export function briefIdFor(hash: string): string {
  return `t-${hash.slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface Seed {
  id: string;
  ticketHash: string;
  title: string;
  description: string;
  createdAt: string;
  source: 'ticket' | 'ledger';
  format: TicketFormat;
  inferred: boolean;
  codeBlocks: number;
  hiddenRemoved: number;
  criteria: Array<{ id: string; text: string; label?: string; source: CriterionSource; parseConfidence: number }>;
  clarifications: Clarification[];
  dropped: Criterion[];
  baseShas: Record<string, string>;
}

/** Parse a pasted ticket and build the brief. */
export function buildBrief(text: string, ctx: IntakeContext): BriefFile {
  const parsed = parseTicket(text);
  const now = (ctx.now ?? new Date()).toISOString();
  const id = ctx.id ?? briefIdFor(parsed.hash);
  const previous = loadBrief(id);
  const seed: Seed = {
    id,
    ticketHash: parsed.hash,
    title: parsed.title,
    description: parsed.description,
    createdAt: previous?.createdAt ?? now,
    source: ctx.source ?? 'ticket',
    format: parsed.format,
    inferred: parsed.inferred,
    codeBlocks: parsed.codeBlocks,
    hiddenRemoved: parsed.hiddenRemoved,
    criteria: parsed.criteria.map((c, i) => ({ id: `AC${i + 1}`, text: c.text, ...(c.label ? { label: c.label } : {}), source: c.source, parseConfidence: c.confidence })),
    // Re-intake of the same text keeps the answers already given.
    clarifications: previous && previous.ticketHash === parsed.hash ? previous.clarifications : [],
    dropped: previous && previous.ticketHash === parsed.hash ? previous.dropped : [],
    baseShas: previous && previous.ticketHash === parsed.hash ? previous.baseShas : {},
  };
  return assemble(seed, ctx, now);
}

function seedOf(b: BriefFile): Seed {
  return {
    id: b.id,
    ticketHash: b.ticketHash,
    title: b.title,
    description: b.description,
    createdAt: b.createdAt,
    source: b.source,
    format: b.format,
    inferred: b.inferred,
    codeBlocks: b.codeBlocks,
    hiddenRemoved: b.hiddenRemoved,
    criteria: b.criteria
      .filter((c) => !b.dropped.some((d) => d.id === c.id))
      .map((c) => {
        const m = b.criteriaMeta[c.id];
        return { id: c.id, text: c.text, ...(m?.label ? { label: m.label } : {}), source: m?.source ?? 'list', parseConfidence: m?.parseConfidence ?? 0.95 };
      }),
    clarifications: b.clarifications,
    dropped: b.dropped,
    baseShas: b.baseShas,
  };
}

const FACT_TOPICS = new Set(['meaning', 'measure']);

/** Classification, ambiguity gate, size gate and lint over the stored criteria. */
function assemble(seed: Seed, ctx: IntakeContext, now: string, round = 0): BriefFile {
  const infos = repoInfos(ctx.config, ctx.defaultRepoPath ? [ctx.defaultRepoPath] : []);
  const defaultRepo = ctx.defaultRepoPath ? repoIdFor(ctx.defaultRepoPath) : undefined;
  const byId = new Map(infos.map((r) => [r.id, r]));
  const allText = [seed.title, seed.description, ...seed.criteria.map((c) => c.text)].join('\n');
  const ticketRepos = infos.filter((r) => mentionsRepo(allText, r) !== null).map((r) => r.id);
  const endpoints = ticketEndpoints(seed.title, seed.description ?? '');
  const ticketText = { title: seed.title, description: seed.description ?? '', criteria: seed.criteria.map((c) => c.text) };
  const answered = new Set(seed.clarifications.filter((c) => !c.unattended).map((c) => c.key));
  const unattendedKeys = new Map(seed.clarifications.filter((c) => c.unattended).map((c) => [c.key, c.n] as const));

  const unclear: Unclear[] = [];
  const criteria: Criterion[] = [];
  const meta: Record<string, CriterionMeta> = {};
  const byCriterion: Record<string, string[]> = {};

  for (const c of seed.criteria) {
    const clar = seed.clarifications.filter((x) => x.criterionId === c.id);
    const factAnswers = clar.filter((x) => FACT_TOPICS.has(x.topic)).map((x) => x.a);
    const classifyText = factAnswers.length ? `${c.text} (${factAnswers.join('; ')})` : c.text;
    const own = extractFacts(classifyText);
    // A criterion about the response of the endpoint the description names is checked against that endpoint.
    const inherited = applyTicketEndpoint(classifyText, own, endpoints);
    const facts = inherited ?? own;
    const kr = classifyKind(classifyText, facts, ticketText);
    if (inherited) kr.reasons = [...kr.reasons, `endpoint ${inherited.routes[0].method} ${inherited.routes[0].path.split('?')[0]} from the ticket`];
    let kind: CriterionKind = kr.kind;
    const match = mapCriterionRepos(c.text, facts, infos, ticketRepos, defaultRepo);
    const repo: RepoInfo | undefined = match.repos.length ? byId.get(match.repos[0]) : undefined;
    const system = repo?.name ?? (ticketRepos.length === 1 ? byId.get(ticketRepos[0])?.name : undefined) ?? 'system';
    const ears = kr.needsRewrite ? earsRewrite(classifyText, system, facts, kind) : undefined;
    const res = checkFor(c.id, classifyText, kind, facts, repo, ears, ticketText);
    let check = res.check;
    // An answered fact question settles the criterion even when the classifier is still unsure.
    if (!check && factAnswers.length) {
      check = { kind: 'manual', description: `Manual: ${factAnswers.join('; ')} (your answer for ${c.id}); the write-up links the artifact`, redFirst: true };
      if (kind === 'untestable' && /screen|page|click|ui|screenshot/i.test(factAnswers.join(' '))) kind = 'ui-artifact';
    }
    const forkAnswers = clar.filter((x) => !FACT_TOPICS.has(x.topic));
    if (check && forkAnswers.length) check = { ...check, description: `${check.description} (clarified: ${forkAnswers.map((x) => x.a).join('; ')})` };
    unclear.push(...res.unclear, ...forksFor(c.id, c.text, kind, facts));
    if (!match.repos.length && infos.length > 1) {
      const tok = facts.routes[0]?.path ?? facts.tables[0] ?? facts.bodyFacts[0] ?? '';
      unclear.push({
        criterionId: c.id,
        topic: 'repo',
        detail: `${c.id} names no repo; find the one that owns ${tok ? `"${tok}"` : 'this behaviour'}`,
        command: `git grep -n -F -e ${JSON.stringify(tok || c.text.split(/\s+/).slice(0, 2).join(' '))} (in each repo: ${infos
          .slice(0, 6)
          .map((r) => r.name)
          .join(', ')})`,
      });
    } else if (!match.repos.length && infos.length === 0) {
      unclear.push({ criterionId: c.id, topic: 'repo', detail: `${c.id}: no repo is configured or given`, command: 'harness intake --from <file> --repo <path to the repo>' });
    }
    criteria.push({ id: c.id, text: c.text, kind, ...(ears ? { ears: ears.ears } : {}), ...(check ? { check } : {}) });
    meta[c.id] = {
      ...(c.label ? { label: c.label } : {}),
      source: c.source,
      parseConfidence: c.parseConfidence,
      kindConfidence: kr.confidence,
      reasons: kr.reasons,
      repos: match.repos,
      repoHow: match.how,
      facts,
    };
    byCriterion[c.id] = match.repos;
  }

  // Ticket-level points.
  if (!seed.criteria.length && !seed.dropped.length) {
    unclear.push({
      topic: 'criteria',
      detail: 'the ticket has no acceptance criteria the parser could find',
      question: 'I found no acceptance criteria in the ticket. What must be true when this is done?',
      options: ['I will list them (one per line)', 'Use the title as the only criterion'],
      recommended: 0,
      blocking: true,
      impact: 5,
      uncertainty: 3,
    });
  } else if (seed.inferred && seed.criteria.length) {
    unclear.push({
      topic: 'criteria',
      detail: 'the ticket has no criteria list; criteria were read from prose',
      question: `The ticket has no acceptance-criteria list; I read ${seed.criteria.length} sentence(s) as criteria (${seed.criteria.map((c) => c.id).join(', ')}). Is that the full list?`,
      options: ['Yes, that is the list', 'Only some of them: I will say which', 'There are others: I will add them'],
      recommended: 0,
      impact: 5,
      uncertainty: 3,
    });
  }

  const gate = ambiguityGate(unclear, { answered, unattended: unattendedKeys, firstNumber: Math.max(0, ...seed.clarifications.map((c) => c.n)) + 1 });
  if (ctx.unattended && round < 10) {
    // No one to answer: every blocking question takes its recommended option and the brief is built again with it.
    const blocking = [...gate.questions, ...gate.queued].filter((x) => x.blocking);
    if (blocking.length) {
      const taken: Clarification[] = blocking.map((x) => ({ n: x.n, key: x.key, ...(x.criterionId ? { criterionId: x.criterionId } : {}), topic: x.topic, q: x.text, a: unattendedOption(x), at: now, unattended: true, options: x.options, recommended: x.recommended }));
      return assemble({ ...seed, clarifications: [...seed.clarifications, ...taken] }, ctx, now, round + 1);
    }
  }
  // A question answered by default stays listed, so a person can overturn the assumption with `harness intake answer`.
  const listedKeys = new Set([...gate.questions, ...gate.queued].map((x) => x.key));
  for (const cl of seed.clarifications) {
    if (!cl.unattended || !cl.options?.length || listedKeys.has(cl.key)) continue;
    gate.questions.push({ n: cl.n, key: cl.key, ...(cl.criterionId ? { criterionId: cl.criterionId } : {}), topic: cl.topic as Question['topic'], text: cl.q, options: cl.options, recommended: cl.recommended ?? 0, blocking: false, score: 0, unattended: true });
  }
  gate.questions.sort((a, b) => a.n - b.n);
  const assumptions = [...gate.assumptions];
  if (seed.hiddenRemoved) assumptions.push(`removed ${seed.hiddenRemoved} hidden Unicode character(s) from the ticket text before reading it`);
  for (const c of seed.criteria) if (c.parseConfidence < LOW_CONFIDENCE) assumptions.push(`${c.id}: read from the ticket's prose (low confidence)`);
  for (const cl of seed.clarifications) assumptions.push(`${cl.criterionId ? cl.criterionId + ': ' : ''}answered Q${cl.n} (${cl.topic}): ${cl.a}${cl.unattended ? ' (unattended: no one to answer)' : ''}`);

  const open = [...gate.questions, ...gate.queued];
  for (const cr of criteria) {
    const q = open.find((x) => x.criterionId === cr.id && !x.unattended);
    if (q) cr.question = q.text;
    // A non-blocking fork proceeds on its recommended option; the check says so until it is answered.
    const forks = gate.questions.filter((x) => x.criterionId === cr.id && !x.blocking && !x.unattended);
    if (cr.check && forks.length) cr.check = { ...cr.check, description: `${cr.check.description} (until answered: ${forks.map((x) => x.options[x.recommended]).join('; ')})` };
    const as = assumptions.filter((a) => a.startsWith(`${cr.id}: `)).map((a) => a.slice(cr.id.length + 2));
    if (as.length) cr.assumption = as.join('; ');
  }

  const repoNames: Record<string, string> = {};
  for (const r of infos) repoNames[r.id] = r.name;
  const plan = planUnits(
    criteria.map((c) => ({ id: c.id, kind: c.kind, repos: byCriterion[c.id] ?? [], facts: meta[c.id].facts })),
    repoNames,
  );
  const repos = [...new Set(plan.units.map((u) => u.repo).filter((r) => r !== UNMAPPED))];
  const baseShas = { ...seed.baseShas };
  for (const r of repos) {
    const info = byId.get(r);
    if (info && !baseShas[r] && isGitRepo(info.path)) {
      const sha = headSha(info.path);
      if (sha) baseShas[r] = sha;
    }
  }
  const lint = lintBrief({ criteria, units: plan.units, open, markers: gate.markers, batchSize: gate.questions.filter((x) => !x.unattended).length });
  const reposInfo: BriefFile['repoMap']['repos'] = {};
  for (const r of infos) if (repos.includes(r.id) || ticketRepos.includes(r.id)) reposInfo[r.id] = { name: r.name, path: r.path };

  return {
    version: 1,
    id: seed.id,
    ticketHash: seed.ticketHash,
    title: seed.title,
    description: seed.description,
    criteria,
    units: plan.units,
    repos,
    questions: gate.questions.map(questionLine),
    assumptions,
    createdAt: seed.createdAt,
    updatedAt: now,
    source: seed.source,
    format: seed.format,
    inferred: seed.inferred,
    codeBlocks: seed.codeBlocks,
    hiddenRemoved: seed.hiddenRemoved,
    criteriaMeta: meta,
    questionDetails: gate.questions,
    queued: gate.queued,
    markers: gate.markers,
    observations: gate.observations,
    clarifications: seed.clarifications,
    dropped: seed.dropped,
    repoMap: { ticket: ticketRepos, byCriterion, repos: reposInfo },
    landingOrder: plan.landingOrder,
    unitEstimates: plan.estimates,
    baseShas,
    lint,
  };
}

/** Counts for the `intake.lint` event: how many criteria have a check, how many wait on a question, how many plan-lint problems there are. */
export function lintCounts(b: Pick<BriefFile, 'criteria' | 'lint' | 'questionDetails' | 'queued'>): { criteria: number; covered: number; open: number; rejected: number } {
  const asked = new Set([...b.questionDetails, ...b.queued].filter((q) => !q.unattended).map((q) => q.criterionId ?? 'ticket'));
  return {
    criteria: b.criteria.length,
    covered: b.criteria.filter((c) => c.check).length,
    open: b.criteria.filter((c) => !c.check && asked.has(c.id)).length,
    rejected: b.lint.length,
  };
}

/** Re-run classification and the gates over a stored brief (after an answer, or with a new config). */
export function reassemble(b: BriefFile, ctx: IntakeContext): BriefFile {
  return assemble(seedOf(b), ctx, (ctx.now ?? new Date()).toISOString());
}

export interface AnswerResult {
  brief: BriefFile;
  question: Question;
  recorded: string;
  dropped: boolean;
}

/** Record the answer to question `n` and re-classify its criterion. Throws when `n` is not an open question. */
export function answerQuestion(b: BriefFile, n: number, answer: string, ctx: IntakeContext): AnswerResult {
  const open = [...b.questionDetails, ...b.queued];
  const q = open.find((x) => x.n === n);
  if (!q) {
    const nums = open.map((x) => x.n);
    throw new Error(nums.length ? `Q${n} is not an open question; open: ${nums.map((x) => 'Q' + x).join(', ')}` : 'this brief has no open questions');
  }
  const recorded = stripHiddenUnicode(resolveAnswer(q, answer)).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!recorded) throw new Error('the answer is empty');
  const at = (ctx.now ?? new Date()).toISOString();
  // a person's answer replaces the recommended option that was taken for them
  const next: BriefFile = { ...b, clarifications: [...b.clarifications.filter((c) => !(c.key === q.key && c.unattended)), { n: q.n, key: q.key, ...(q.criterionId ? { criterionId: q.criterionId } : {}), topic: q.topic, q: q.text, a: recorded, at }] };
  let dropped = false;
  if (q.criterionId && /^drop it\b|\bout of scope\b|^drop\b/i.test(recorded)) {
    const c = b.criteria.find((x) => x.id === q.criterionId);
    if (c) {
      next.dropped = [...b.dropped, c];
      dropped = true;
    }
  }
  return { brief: reassemble(next, ctx), question: q, recorded, dropped };
}

/** Synthesize ticket text for a ledger task so personal tasks go through the same pipeline. */
export function ticketTextForTask(t: { title: string; body?: string; acceptance: string[] }): string {
  const lines = [`Title: ${t.title}`];
  const body = (t.body ?? '').trim();
  if (body) lines.push('Description:', body);
  if (t.acceptance.length) lines.push('Acceptance Criteria:', ...t.acceptance.map((a, i) => `${i + 1}. ${a}`));
  return lines.join('\n') + '\n';
}

export function kindCounts(b: Pick<Brief, 'criteria'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of b.criteria) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}

export { questionKey };
