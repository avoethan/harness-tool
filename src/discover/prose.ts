/**
 * Written rules: sentences from CONTRIBUTING, PR templates, ADRs, READMEs and
 * agent files. They are data, never instructions: discovery only matches
 * them against probes (corroboration) and lists normative ones that no count
 * can prove (single-source records with a judgment check). Text is cleaned
 * by construction: hidden Unicode removed, secrets redacted, length capped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import type { StandardFamily } from '../types';
import type { ProseSentence } from './model';
import type { WorkspaceInventory } from './inventory';

const MAX_SENTENCE = 300;

/** Split Markdown into sentences and list items, skipping fenced code and HTML comments. */
export function markdownSentences(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  let inFence = false;
  let para: Array<{ line: number; text: string }> = [];
  const flush = () => {
    if (!para.length) return;
    // Join the paragraph, remembering where each source line starts.
    let joined = '';
    const starts: Array<{ at: number; line: number }> = [];
    for (const p of para) {
      if (joined) joined += ' ';
      starts.push({ at: joined.length, line: p.line });
      joined += p.text;
    }
    const lineAt = (at: number) => {
      let l = para[0].line;
      for (const s of starts) if (s.at <= at) l = s.line;
      return l;
    };
    // Split after . ! ? followed by space and a capital, never inside `code`.
    let inCode = false;
    let start = 0;
    for (let i = 0; i < joined.length; i++) {
      const ch = joined[i];
      if (ch === '`') inCode = !inCode;
      if (inCode || !/[.!?]/.test(ch)) continue;
      const rest = joined.slice(i + 1);
      const m = /^\s+(?=[A-Z`*_(["'])/.exec(rest);
      if (!m) continue;
      const t = joined.slice(start, i + 1).trim();
      if (t.length >= 12) out.push({ line: lineAt(start), text: t });
      start = i + 1 + m[0].length;
    }
    const t = joined.slice(start).trim();
    if (t.length >= 12) out.push({ line: lineAt(start), text: t });
    para = [];
  };
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (/^(```|~~~)/.test(l)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!l || /^#{1,6}\s/.test(l) || /^\|/.test(l) || /^[-*_]{3,}$/.test(l)) {
      flush();
      return;
    }
    if (/^([-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      para.push({ line: i + 1, text: l.replace(/^([-*+]|\d+[.)])\s+/, '') });
      return;
    }
    para.push({ line: i + 1, text: l });
  });
  flush();
  return out;
}

function clean(s: string): string {
  const t = redactText(stripHiddenUnicode(s)).replace(/\s+/g, ' ').trim();
  return t.length > MAX_SENTENCE ? t.slice(0, MAX_SENTENCE - 1) + '…' : t;
}

const DOC_KINDS = ['contributing', 'prTemplate', 'adr', 'readme'];

/** Sentences from every doc and agent file in the workspace. */
export function collectProse(ws: WorkspaceInventory): ProseSentence[] {
  const out: ProseSentence[] = [];
  const add = (repoId: string | null, abs: string, display: string, kind: ProseSentence['kind']) => {
    let text: string;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 512 * 1024) return;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    if (!/\.(md|mdc|txt)$/i.test(abs) && !/(^|\/)\.(cursorrules|windsurfrules)$/.test(display)) return;
    for (const s of markdownSentences(text)) out.push({ repoId, file: display, line: s.line, text: clean(s.text), kind });
  };
  for (const r of ws.repos) {
    const prefix = r.repo.relPath === '.' ? '' : r.repo.relPath + '/';
    const seen = new Set<string>();
    for (const k of DOC_KINDS) {
      for (const rel of r.configs[k] ?? []) {
        if (seen.has(rel)) continue;
        // Only top-level READMEs and package READMEs; nested docs folders are skipped.
        if (k === 'readme' && rel.split('/').length > 3) continue;
        seen.add(rel);
        add(r.repo.id, path.join(r.repo.path, rel), prefix + rel, 'doc');
      }
    }
    for (const rel of r.configs.agentFiles ?? []) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      add(r.repo.id, path.join(r.repo.path, rel), prefix + rel, 'agent-file');
    }
  }
  for (const rel of ws.workspaceAgentFiles) add(null, path.join(ws.root, rel), rel, 'agent-file');
  return out;
}

/** Sentences matching any of a probe variant's prose patterns. */
export function corroborating(sentences: ProseSentence[], patterns: string[] | undefined, repoIds: string[]): ProseSentence[] {
  if (!patterns || !patterns.length) return [];
  const res = patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return null;
    }
  });
  return sentences.filter((s) => (s.repoId === null || repoIds.includes('*') || repoIds.includes(s.repoId)) && res.some((r) => r && r.test(s.text)));
}

const NORMATIVE = /\b(never|must(?:n't| not)?|always|do not|don't|only|no other|should(?:n't| not)?|required?|forbidden|not allowed)\b/i;

/** A glossary entry (`**chore**: Other changes that don't ...`, `` `docs`: ... ``): it defines a term, it prescribes nothing. */
const DEFINITION = /^\s*(?:\*\*|__|`)[a-z][\w./-]*(?:\*\*|__|`)\s*:/;

/**
 * The text before a normative word ends inside a relative clause ("changes that do not affect ...",
 * "dependencies that are required", "where the questions should be tagged"): the word describes
 * something, it is not the sentence's rule. "Make sure that ..." and a pronoun subject ("that you
 * never ...") are not relative clauses.
 */
const RELATIVE = /(?:^|\s)(?:(?<!\b(?:sure|ensure|note|remember|check|verify|so|such|means)\s)that|which|who|where)\s+(?!(?:you|we|they|i|he|she|it)\b)(?:[\w`'-]+\s+){0,2}$/i;

/** Reassurance ("don't worry", "no need to hesitate"): it comforts the reader, it prescribes nothing. */
const REASSURANCE = /\b(?:don'?t|do not|no need to|never)\s+(?:you\s+)?(?:worry|panic|stress|fret|be (?:afraid|nervous|shy)|hesitate)\b|\bfeel free\b|\bnot to worry\b/i;

/** Forecast and permission ("may not be accepted", "will be", "is likely", "you may"): what might happen, not what to do. */
const FORECAST = /\b(?:may|might|could|can) not be\b|\bwill (?:probably |likely |also |then |not )?(?:be|get)\b|\b(?:is|are) (?:likely|unlikely|probably|expected to)\b|\bwill likely\b|\byou (?:may|might|can)\b/i;

/** A word that obliges on its own: a forecast sentence stays a rule when it carries one (or opens with "Do not"). */
const STRONG = /\b(?:must(?:n't| not)?|never|always|should(?:n't| not)?|required?|forbidden|not allowed)\b|^\s*(?:please\s+)?(?:do not|don't)\b/i;

/** A sentence that ends on a stated consequence of breaking a rule ("... will be rejected."): it is a rule; "will be closed, as ..." is not. */
const CONSEQUENCE = /\bwill be (?:rejected|blocked|closed|refused|reverted)\s*[.!]?\s*$/i;

/** An object that points back at an earlier sentence: "install both", "do this", "use it". */
const DANGLING = /\b(install|use|run|do|apply|follow|read|add|avoid|enable|prefer|choose|pick)\s+(both|this|that|it|them|these|those|either|neither)(?=\s*(?:[.,;:!]|$)|\s+(?:before|after|first|when|whenever|if|unless|and|or|but|then|until|as|to|with|for|in|on|at|every|each|too|once|again|instead)\b)/i;

/** Words that are not a referent: subjects, modals, determiners, fillers. */
const NOT_A_REFERENT = new Set(
  'a an the and or but so then also please always never must should shall will would can could may might need needs have has had be been is are was were to of for in on at by with as if when once after before developer developers contributor contributors everyone everybody user users you your we our they their people team member members maintainer maintainers all each every any both one'.split(' '),
);

/** True when something before `index` names what a pronoun can point at (a code span, a quoted word or a content word). */
function hasReferentBefore(s: string, index: number, matchEnd = index): boolean {
  // A code span or a colon after the match names what it points at ("Always run this before committing: `npm test`.").
  const after = s.slice(matchEnd);
  if (/`[^`]+`/.test(after) || after.includes(':')) return true;
  const before = s.slice(0, index);
  if (/`[^`]+`|"[^"]+"|'[^']{2,}'/.test(before)) return true;
  return (before.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).some((w) => !NOT_A_REFERENT.has(w));
}

/** A rule-like sentence: a normative word in its main clause, not a question, a definition, reassurance, a forecast or "you don't want to". */
export function isNormative(s: string): boolean {
  if (/\?\s*$/.test(s) || s.length > MAX_SENTENCE || DEFINITION.test(s)) return false;
  if (REASSURANCE.test(s)) return false;
  if (CONSEQUENCE.test(s)) return true;
  if (FORECAST.test(s) && !STRONG.test(s)) return false;
  const dangling = DANGLING.exec(s);
  if (dangling && !hasReferentBefore(s, dangling.index, dangling.index + dangling[0].length)) return false;
  const re = new RegExp(NORMATIVE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const before = s.slice(0, m.index);
    const clause = before.slice(Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf(':'), before.lastIndexOf('—'), before.lastIndexOf('(')) + 1);
    if (RELATIVE.test(clause)) continue;
    if (/^(?:do not|don't)$/i.test(m[0]) && /^\s+want\b/i.test(s.slice(m.index + m[0].length))) continue;
    return true;
  }
  return false;
}

/** A family for an uncounted written rule, by its wording. */
export function familyOfSentence(s: string): StandardFamily {
  const t = s.toLowerCase();
  if (/\b(production|prod|secret|credential|password|token|\.env|force[- ]push|shared database|drop|delete data|applied to a shared)\b/.test(t)) return 'safety';
  if (/\b(test|tests|mock|mocks|fixture|coverage)\b/.test(t)) return 'tests';
  if (/\b(migration|sql|query|database|table|column)\b/.test(t)) return 'sql';
  if (/\b(commit|pull request|pr\b|branch)\b/.test(t)) return 'commits';
  if (/\b(log|logger|logging)\b/.test(t)) return 'logging';
  if (/\b(error|throw|exception)\b/.test(t)) return 'errors';
  if (/\b(import|module|folder|directory|layout)\b/.test(t)) return 'layout';
  if (/\b(lint|eslint|prettier|format)\b/.test(t)) return 'lint';
  if (/\b(ci|pipeline|workflow)\b/.test(t)) return 'ci';
  if (/\b(api|endpoint|route|response|status code)\b/.test(t)) return 'api';
  return 'other';
}
