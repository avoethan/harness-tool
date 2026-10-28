/**
 * Pure text work for `harness jira`: read the facts out of a write-up, and compose the Jira comment and
 * the follow-up ticket drafts. No file or network access here (see ./run.ts).
 */
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';

export const POSTED_BY = 'Posted by the harness from the write-up; details in the pull request';
export const SUMMARY_MAX = 120;
export const MAX_FEEDBACK_TICKETS = 10;

export interface WriteupFacts {
  /** Criterion, check, result (the Artifact column is left out). */
  rows: Array<[string, string, string]>;
  /** The first `Gate:` line of the Verification section, else null. */
  gate: string | null;
  /** The bullets of "Feedback wanted", without the leading dash. */
  feedback: string[];
}

function sectionOf(text: string, heading: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

export function readWriteup(text: string): WriteupFacts {
  const ver = sectionOf(text, 'Verification');
  const gate = ver.find((l) => /^Gate:/.test(l.trim()))?.trim() ?? null;
  const rows: Array<[string, string, string]> = [];
  for (const l of ver) {
    if (!l.trim().startsWith('|')) continue;
    const cells = splitRow(l);
    if (cells.length < 3) continue;
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (cells[0].toLowerCase() === 'criterion') continue;
    rows.push([cells[0], cells[1], cells[2]]);
  }
  const feedback = sectionOf(text, 'Feedback wanted')
    .map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((x): x is string => !!x);
  return { rows, gate, feedback };
}

/** Text that is safe to send: secrets redacted, hidden characters removed. */
export function clean(s: string): string {
  return redactText(stripHiddenUnicode(s));
}

function wikiLine(s: string): string {
  return clean(s).replace(/\s+/g, ' ').trim().replace(/([{}[\]])/g, '\\$1');
}

/** A table cell in Jira wiki markup: no pipe, no line break, no macro or link brackets. */
function wikiCell(s: string): string {
  return wikiLine(s).replace(/\|/g, '/') || ' ';
}

export function commentBody(facts: WriteupFacts, prUrl: string | null): string {
  const L: string[] = ['h3. Harness verification', ''];
  L.push(facts.gate ? wikiLine(facts.gate) : 'Gate: not recorded in the write-up.');
  L.push('');
  if (facts.rows.length) {
    L.push('||Criterion||Check||Result||');
    for (const r of facts.rows) L.push(`|${wikiCell(r[0])}|${wikiCell(r[1])}|${wikiCell(r[2])}|`);
  } else L.push('(The write-up has no verification table.)');
  L.push('');
  if (prUrl) L.push(`Pull request: ${prUrl}`, '');
  L.push(POSTED_BY);
  return L.join('\n');
}

/** The first sentence, at most `max` characters (cut with an ellipsis). */
export function firstSentence(text: string, max = SUMMARY_MAX): string {
  const t = clean(text).replace(/\s+/g, ' ').replace(/^[-*]\s+/, '').trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(t);
  const s = (m ? m[1] : t).trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export interface Draft {
  summary: string;
  description: string;
}

export function draftFor(text: string, sourceKey: string | null, prUrl: string | null): Draft {
  const body = clean(text).trim();
  const prefix = sourceKey ? `${sourceKey} follow-up: ` : 'Follow-up: ';
  const see = prUrl ? `; see ${prUrl}` : '';
  const trailer = sourceKey ? `Opened from ${sourceKey} by the harness${see}` : `Opened by the harness${see}`;
  return { summary: prefix + firstSentence(body), description: `${body}\n\n${trailer}` };
}

/** The reason after "BLOCKED: " in the gate's reasons, else null. */
export function blockedReason(reasons: string[]): string | null {
  for (const r of reasons) {
    const m = /^BLOCKED: (.*)$/s.exec(r);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

export const AC_HEADING = 'h2. Acceptance Criteria';

/** The acceptance criteria as a wiki numbered list, one `# ...` line each. */
export function acceptanceList(lines: string[]): string {
  return lines.map((l) => clean(l).trim()).filter(Boolean).map((l) => `# ${l.replace(/^(#|\d+[.)]|[-*])\s+/, '')}`).join('\n');
}

/**
 * The description with its Acceptance Criteria section replaced (or added at
 * the end). The section runs from the heading to the next `h1.`/`h2.` heading.
 */
export function withAcceptanceSection(description: string, acceptance: string): string {
  const lines = description.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^h[1-6]\.\s*acceptance criteria\s*$/i.test(l.trim()));
  const block = `${AC_HEADING}\n${acceptance.trim()}`;
  if (start < 0) return `${description.replace(/\s+$/, '')}${description.trim() ? '\n\n' : ''}${block}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^h[1-6]\.\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n').replace(/^\s+/, '');
  return `${before}${before ? '\n\n' : ''}${block}${after ? '\n\n' + after : '\n'}`;
}

/** A field change for people: the old and new text, side by side as lines. */
export function fieldDiff(name: string, before: string, after: string): string {
  if (before === after) return `${name}: unchanged`;
  const show = (t: string) => (t.trim() ? t.replace(/\r\n/g, '\n').split('\n').map((l) => `    ${l}`).join('\n') : '    (empty)');
  return `${name}:\n  before:\n${show(before)}\n  after:\n${show(after)}`;
}
