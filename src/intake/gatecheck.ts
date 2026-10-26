/**
 * Criteria the gate proves by itself: "CI checks still pass", "nothing else
 * changes in the tree", "the history is kept". A test cannot sensibly carry
 * them (a config-only ticket has no code to test), and the gate already knows
 * the answer from its own steps, the changed paths and git. They become a
 * `gate` check (see CheckSpec in src/types.ts); the acceptance step for such a
 * check lives in src/gate/gatecheck.ts and runs no repository code.
 */
import type { CheckSpec } from '../types';
import type { CriterionFacts } from './classify';

/** What "CI" or "checks" stands for, in the order the gate lists them. */
const CI_STEPS = ['lint', 'typecheck', 'tests:base', 'build'];
const ALL_STEPS = [...CI_STEPS, 'coverage'];

/** The ticket text a scope can be read from. */
export interface TicketText {
  title: string;
  description: string;
  criteria: string[];
}

const STEP_WORDS: Array<[RegExp, string[]]> = [
  [/\b(?:ci|continuous\s+integration)\b|\bchecks\b/i, CI_STEPS],
  [/\blint(?:ing|er)?\b|\beslint\b|\bprettier\b|\bformat(?::check|\s+check|ting)?\b/i, ['lint']],
  [/\btype[- ]?check(?:s|ing)?\b|\btsc\b/i, ['typecheck']],
  [/\bbuilds?\b/i, ['build']],
  [/\btests?\b|\bsuite\b/i, ['tests:base']],
  [/\bcoverage\b/i, ['coverage']],
];

const PASS_CLAIM = /\b(?:pass(?:es|ing)?|green|succeed(?:s)?)\b/i;

/** Words a pure "the checks pass" sentence is made of; any other word means the sentence says more than that. */
const FILLER = new Set(
  (
    'all existing current the unit integration full whole repo repository ci equivalent continuous integration checks check lint linting linter eslint prettier typecheck typechecking type types tsc test tests suite build builds format formatting ' +
    'still keep keeps keeping stay stays remain remains continue continues to pass passes passing green and or also must should will with no errors error failures failing after before this change changes of my our their project code codebase is are be as it they that'
  ).split(' '),
);

function onlyCheckWords(text: string): boolean {
  const bare = text.replace(/\([^)]*\)/g, ' ').toLowerCase();
  const words = bare.match(/[a-z]+/g) ?? [];
  return words.length > 0 && words.every((w) => FILLER.has(w));
}

const NOTHING_ELSE =
  /\bnothing\s+else\s+(?:changes?|is\s+changed|gets?\s+changed|is\s+touched|is\s+modified)\b|\bno\s+other\s+(?:files?|paths?|code)\s+(?:change[sd]?|(?:is|are)\s+(?:changed|touched|modified))\b|\bonly\s+(?:`[^`]+`|[\w./-]+)\s+(?:changes?|is\s+changed|is\s+touched|is\s+modified)\b|\bno\s+(?:unrelated|other)\s+changes?\b/i;

const KEEPS_HISTORY =
  /\b(?:still\s+in|kept\s+in|stays?\s+in|remains?\s+in|preserved\s+in)\s+(?:the\s+)?(?:git\s+)?history\b|\bhistory\s+(?:is|stays?|remains?)\s+(?:kept|preserved|intact|unchanged|as\s+it\s+is)\b|\b(?:keep|keeps|preserve|preserves)\s+(?:the\s+)?(?:git\s+)?history\b|\bno\s+(?:rebase|force[- ]push|history\s+rewrite|squash|amend)\b|\b(?:not|never)\s+(?:be\s+)?(?:rebased|force[- ]pushed|squashed|rewritten|amended)\b|\bthe\s+(?:pin\s+|original\s+|offending\s+)?commit\s+(?:stays|remains|is\s+kept|is\s+still)\b/i;

const CHANGE_SENTENCE =
  /\b(?:pinn?ed|reverts?|reverted|undo(?:es)?|remov(?:e|es|ed)|delet(?:e|es|ed)|renam(?:e|es|ed)|chang(?:e|es|ed)|updat(?:e|es|ed)|add(?:s|ed)?|fix(?:es|ed)?|edit(?:s|ed)?|bump(?:s|ed)?|replac(?:e|es|ed)|touch(?:es|ed)?|no\s+longer\s+exists?)\b/i;

/** A repository path or file name: a path with a slash, a name with an extension, or a dotfile such as `.nvmrc`. */
function looksLikePath(t: string): boolean {
  if (!t || /\s/.test(t) || /^[a-z]+:\/\//i.test(t) || t.length > 120) return false;
  if (/^--?[a-z]/i.test(t) || /[=<>|&;$]/.test(t)) return false;
  if (/^\.[A-Za-z][\w.-]*$/.test(t)) return true;
  if (/^(?:\.\/)?[\w@.-]+(?:\/[\w@.*-]+)+\/?$/.test(t)) return !/^(?:text|application|image|audio|video)\//.test(t);
  return /^[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t);
}

/** The repository paths the ticket says change: file-like `code` spans in sentences that talk about changing something. */
export function ticketScopePaths(ticket: TicketText | undefined, own: string): string[] {
  const out = new Set<string>();
  const texts = [own, ...(ticket ? [ticket.title, ticket.description, ...ticket.criteria] : [])];
  for (const text of texts) {
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!CHANGE_SENTENCE.test(sentence) && !NOTHING_ELSE.test(sentence)) continue;
      for (const m of sentence.matchAll(/`([^`\n]+)`/g)) if (looksLikePath(m[1])) out.add(m[1].replace(/^\.\//, ''));
    }
  }
  return [...out];
}

/** Whether the criterion names something a gate proof cannot cover: a route, a status, a table, a command line. */
function namesBehaviour(facts: CriterionFacts): boolean {
  return facts.routes.length > 0 || facts.statuses.length > 0 || facts.tables.length > 0 || facts.columns.length > 0 || facts.commands.length > 0;
}

/** The gate steps a sentence names ("CI" and "checks" mean lint, typecheck, tests:base and build). */
export function gateStepsIn(text: string): string[] {
  const steps = new Set<string>();
  for (const [re, names] of STEP_WORDS) if (re.test(text)) for (const n of names) steps.add(n);
  return ALL_STEPS.filter((s) => steps.has(s));
}

const QUOTED = /"([^"\n]{1,200})"|`([^`\n]{1,200})`|'([^'\n]{1,200})'|\u201c([^\u201d\n]{1,200})\u201d/;

/**
 * "<file> contains (the line|the text|...) <quoted text>" or "<quoted text> (is|appears) in <file>":
 * the gate reads the file itself, so a docs or config criterion needs no test runner.
 */
export function fileContainsIn(text: string): { path: string; text: string } | undefined {
  const t = text.trim().replace(/\.$/, '');
  const pathTok = '(`[^`]+`|[\\w./-]+)';
  const a = new RegExp(`^(?:the\\s+(?:file\\s+)?)?${pathTok}\\s+(?:now\\s+)?(?:contains|includes|has)\\s+(?:the\\s+)?(?:line|text|words?|sentence|heading|entry|string)?\\s*(.+)$`, 'i').exec(t);
  const b = new RegExp(`^(.+?)\\s+(?:is|appears|is\\s+present|is\\s+listed)\\s+in\\s+(?:the\\s+(?:file\\s+)?)?${pathTok}$`, 'i').exec(t);
  const pick = (p: string, rest: string) => {
    const file = p.replace(/^`|`$/g, '');
    if (!looksLikePath(file)) return undefined;
    const q = QUOTED.exec(rest);
    const want = q ? (q[1] ?? q[2] ?? q[3] ?? q[4]) : undefined;
    return want ? { path: file.replace(/^\.\//, ''), text: want } : undefined;
  };
  return (a && pick(a[1], a[2])) || (b && pick(b[2], b[1])) || undefined;
}

/** The gate check for a criterion the gate proves by itself, or undefined when the criterion needs a test. */
export function gateSpec(text: string, facts: CriterionFacts, ticket?: TicketText): CheckSpec | undefined {
  const contains = fileContainsIn(text);
  // the quoted text of a file-contains criterion is read as a command by the command-line rule; it is not one
  const factsHere = contains ? { ...facts, commands: facts.commands.filter((c) => c !== contains.text) } : facts;
  if (namesBehaviour(factsHere)) return undefined;
  const steps = PASS_CLAIM.test(text) && onlyCheckWords(text) ? gateStepsIn(text) : [];
  const history = KEEPS_HISTORY.test(text);
  let scopePaths: string[] | undefined;
  if (NOTHING_ELSE.test(text)) {
    const named = ticketScopePaths(ticket, text);
    scopePaths = named.length ? named : facts.paths.length ? [...facts.paths] : undefined;
  }
  // only a criterion with something the gate can check is a gate check
  if (!steps.length && !scopePaths?.length && !history && !contains) return undefined;
  const what: string[] = [];
  if (steps.length) what.push(`${steps.join(', ')} ${steps.length === 1 ? 'passes' : 'pass'} in this run`);
  if (scopePaths?.length) what.push(`the change touches only ${scopePaths.join(', ')}`);
  if (history) what.push('the base commit stays in the history (no rewrite)');
  if (contains) what.push(`${contains.path} contains "${contains.text}"`);
  return {
    kind: 'gate',
    description: `proved by the gate: ${what.join('; ')}`,
    redFirst: false,
    ...(steps.length ? { gateSteps: steps } : {}),
    ...(scopePaths?.length ? { scopePaths } : {}),
    ...(history ? { keepsHistory: true } : {}),
    ...(contains ? { fileContains: contains } : {}),
  };
}

/** The part of a gate check's description after "proved by the gate: ". */
export function gateWhat(c: Pick<CheckSpec, 'description'>): string {
  return c.description.replace(/^proved by the gate:\s*/i, '');
}
