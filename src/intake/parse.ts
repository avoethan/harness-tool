/**
 * Ticket parser (team intake, first step). Pasted ticket text ->
 * `{ title, description, criteria[] }`.
 *
 * Pure: no I/O, no logging. The ticket text is data, never instructions; the
 * caller stores it only inside the private brief and logs its sha256.
 *
 * Shapes tolerated:
 * - title: an explicit `Title:` / `Summary:` label, else the first heading,
 *   else the first line;
 * - sections: `Description:` / `Background:` / `Context:` …, and an
 *   `Acceptance Criteria` / `AC` / `Definition of Done` … heading in Markdown
 *   (`## AC`), Jira wiki (`h3. AC`), bold (`**AC:**`, `*AC*`) or a bare label line;
 * - criteria: numbered (`1.`, `1)`, `(1)`, `a.`), bulleted (`-`, `*`, `•`),
 *   `AC1:` labels, `[ ]` / `[x]` checkboxes, Given/When/Then scenarios,
 *   Jira lists (`#`, `*`), tables, nested sub-items and continuation lines;
 * - code blocks (``` / ~~~ fences, `{code}`, `{noformat}`) never become
 *   criteria; they stay in the description;
 * - no list at all: every sentence with must/should/shall/need to becomes a
 *   criterion marked low confidence.
 */
import { sha256 } from '../lib/hash';
import { stripHiddenUnicode, scanHiddenUnicode } from '../lib/unicode';

export type CriterionSource =
  | 'list' // an item in an acceptance-criteria section
  | 'ac-label' // `AC1: …` anywhere
  | 'checkbox' // `[ ]` item
  | 'gwt' // a Given/When/Then scenario
  | 'section-line' // a plain line or sentence under an acceptance-criteria heading
  | 'table' // a table row under an acceptance-criteria heading
  | 'expected' // an item under an Expected result heading (bug tickets) when no AC section exists
  | 'list-fallback' // a list item in the description when the ticket has no AC section
  | 'prose'; // a must/should sentence when the ticket has no list at all

export interface ParsedCriterion {
  text: string;
  source: CriterionSource;
  /** 0..1; below LOW_CONFIDENCE the reading is a guess and the brief says so. */
  confidence: number;
  /** The ticket's own label when it numbered the item (`AC3`, `2`, `b`). */
  label?: string;
}

export type TicketFormat = 'jira' | 'markdown' | 'plain';

export interface ParsedTicket {
  title: string;
  description: string;
  criteria: ParsedCriterion[];
  format: TicketFormat;
  /** Code blocks found (kept in the description, never criteria). */
  codeBlocks: number;
  /** Hidden Unicode characters removed before parsing. */
  hiddenRemoved: number;
  /** sha256 of the text exactly as given. */
  hash: string;
  /** True when the criteria were inferred (no AC section, labels, checkboxes or scenarios). */
  inferred: boolean;
}

export const LOW_CONFIDENCE = 0.7;

const CONFIDENCE: Record<CriterionSource, number> = {
  list: 0.95,
  'ac-label': 0.95,
  gwt: 0.95,
  checkbox: 0.85,
  table: 0.85,
  'section-line': 0.8,
  expected: 0.75,
  'list-fallback': 0.55,
  prose: 0.4,
};

// ---------------------------------------------------------------------------
// Section labels
// ---------------------------------------------------------------------------

type SectionKind = 'title' | 'desc' | 'crit' | 'expected' | 'other' | 'meta';

const LABELS: Array<[SectionKind, string[]]> = [
  ['title', ['title', 'summary', 'ticket title', 'issue title', 'subject', 'name']],
  [
    'desc',
    ['description', 'background', 'context', 'problem', 'problem statement', 'overview', 'details', 'user story', 'story', 'motivation', 'why', 'goal', 'goals', 'business value', 'purpose'],
  ],
  [
    'crit',
    [
      'acceptance criteria',
      'acceptance criterion',
      'acceptance criterias',
      'acceptance',
      'acceptance tests',
      'acceptance test',
      'ac',
      'acs',
      'a/c',
      'definition of done',
      'dod',
      'success criteria',
      'conditions of satisfaction',
      'scenarios',
      'requirements',
    ],
  ],
  ['expected', ['expected result', 'expected results', 'expected behaviour', 'expected behavior', 'expected outcome']],
  [
    'other',
    [
      'notes',
      'note',
      'technical notes',
      'tech notes',
      'implementation notes',
      'implementation',
      'out of scope',
      'non-goals',
      'non goals',
      'links',
      'attachments',
      'steps to reproduce',
      'repro steps',
      'reproduction steps',
      'actual result',
      'actual results',
      'actual behaviour',
      'actual behavior',
      'environment',
      'comments',
      'dependencies',
      'open questions',
      'questions',
      'references',
      'resources',
      'design',
      'designs',
      'mockups',
      'test plan',
      'testing notes',
      'tasks',
      'subtasks',
      'sub-tasks',
      'risks',
      'rollout',
    ],
  ],
  [
    'meta',
    ['priority', 'assignee', 'reporter', 'sprint', 'story points', 'labels', 'components', 'component', 'status', 'type', 'issue type', 'epic', 'epic link', 'fix version', 'fix versions', 'affects version', 'affects versions', 'due date', 'created', 'updated', 'resolution'],
  ],
];

const LABEL_KIND = new Map<string, SectionKind>();
for (const [kind, names] of LABELS) for (const n of names) LABEL_KIND.set(n, kind);

function normLabel(s: string): string {
  return s
    .replace(/[*_`]/g, '')
    .replace(/\s*\((?:ac|acs|a\/c|dod)\)\s*$/i, '')
    .replace(/[:\-–\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

interface LabelHit {
  kind: SectionKind | 'heading';
  /** Text after the label on the same line. */
  inline: string;
  /** Heading level (1-6), or 7 for bold / bare label lines. */
  level: number;
  /** The heading text for unknown headings. */
  text: string;
}

function labelOf(line: string, format: TicketFormat): LabelHit | null {
  const t = line.trim();
  if (!t) return null;
  // Markdown heading (in Jira text a leading `#` is a numbered list item)
  let m = format !== 'jira' ? /^(#{1,6})\s+(.*)$/.exec(t) : null;
  if (m) return headingHit(m[2], m[1].length);
  m = /^h([1-6])\.\s+(.*)$/i.exec(t);
  if (m) return headingHit(m[2], Number(m[1]));
  // Whole-line bold label: **Acceptance Criteria:** rest  |  *Acceptance Criteria* rest  |  __AC__
  m = /^(\*\*|__|\*)([^*_][^*]*?)\1\s*:?\s*(.*)$/.exec(t);
  if (m) {
    const kind = LABEL_KIND.get(normLabel(m[2]));
    if (kind) return { kind, inline: m[3].trim(), level: 7, text: m[2] };
  }
  // `Label: inline` or a bare label line
  m = /^([A-Za-z][A-Za-z /&()-]{0,40}?)\s*:\s*(.*)$/.exec(t);
  if (m) {
    const kind = LABEL_KIND.get(normLabel(m[1]));
    if (kind) return { kind, inline: m[2].trim(), level: 7, text: m[1] };
  }
  const bare = LABEL_KIND.get(normLabel(t));
  if (bare && t.length <= 45) return { kind: bare, inline: '', level: 7, text: t };
  return null;
}

function headingHit(text: string, level: number): LabelHit {
  const clean = text.replace(/\s*#+\s*$/, '').trim();
  const lm = /^(.*?)\s*:\s*(.*)$/.exec(clean);
  const kind = LABEL_KIND.get(normLabel(clean)) ?? (lm ? LABEL_KIND.get(normLabel(lm[1])) : undefined);
  if (kind) {
    const inline = LABEL_KIND.get(normLabel(clean)) ? '' : (lm?.[2] ?? '').trim();
    return { kind, inline, level, text: clean };
  }
  return { kind: 'heading', inline: '', level, text: clean };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface ListItem {
  indent: number;
  kind: 'num' | 'bullet' | 'check' | 'ac' | 'table';
  text: string;
  label?: string;
}

const CODE_MARK = /^@@CODE(\d+)@@$/;

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

function listItem(line: string, format: TicketFormat): ListItem | null {
  const indent = indentOf(line);
  const t = line.trim();
  if (!t) return null;
  if (/^([-*_=])\1{2,}$/.test(t)) return null; // horizontal rule
  // AC1: text   (optionally bulleted or bold)
  let m = /^(?:[-*•+]\s+)?(?:\*\*|\*|__)?(?:AC|A\.C\.|Acceptance criteri(?:on|a))[\s#.-]*(\d{1,3}[a-z]?)(?:\*\*|\*|__)?\s*[:.)\-–]\s*(?:\*\*|\*|__)?\s*(.+)$/i.exec(t);
  if (m) return { indent, kind: 'ac', text: m[2], label: `AC${m[1]}` };
  // checkboxes
  m = /^(?:[-*+•]\s+)?(?:\[([ xX])\]|([☐☑✔✅]))\s+(.+)$/.exec(t);
  if (m) return { indent, kind: 'check', text: m[3] };
  // Jira lists: # numbered, * bullets (depth by repetition)
  if (format === 'jira') {
    m = /^(#+)\s+(.+)$/.exec(t);
    if (m) return { indent: indent + (m[1].length - 1) * 2, kind: 'num', text: m[2] };
    m = /^(\*+|-+)\s+(.+)$/.exec(t);
    if (m) return { indent: indent + (m[1].length - 1) * 2, kind: 'bullet', text: m[2] };
  }
  // numbered: 1. 1) (1) a. a)
  m = /^(?:(\d{1,3})[.)]|\((\d{1,3})\)|([a-z])[.)])\s+(.+)$/.exec(t);
  if (m) return { indent, kind: 'num', text: m[4], label: m[1] ?? m[2] ?? m[3] };
  // bullets
  m = /^[-*•+‣◦▪]\s+(.+)$/.exec(t);
  if (m) return { indent, kind: 'bullet', text: m[1] };
  // table rows (Markdown and Jira); header and separator rows are skipped
  if (/^\|/.test(t)) {
    if (/^\|\|/.test(t) || /^\|[\s:|-]+\|?$/.test(t)) return { indent, kind: 'table', text: '' };
    const cells = t
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (!cells.length) return { indent, kind: 'table', text: '' };
    const first = cells[0];
    const rest = cells.length > 1 && /^(?:AC\s*-?\s*)?\d{1,3}[a-z]?\.?$/i.test(first) ? cells.slice(1) : cells;
    const label = rest !== cells ? first.replace(/\.$/, '') : undefined;
    return { indent, kind: 'table', text: rest.join(' — '), label };
  }
  return null;
}

const GWT_RE = /^(?:[-*•+]\s+)?(?:\*\*|\*|__)?(Given|When|Then|And|But)(?:\*\*|\*|__)?\b[:,]?\s*(.*)$/i;
const SCENARIO_RE = /^(?:[-*•+]\s+)?(?:\*\*|\*|__)?Scenario(?:\s+Outline)?(?:\s*\d+)?(?:\*\*|\*|__)?\s*[:.\-–]\s*(?:\*\*|\*|__)?\s*(.*?)(?:\*\*|\*|__)?$/i;

/** Inline markup cleanup for titles and criteria. */
export function cleanInline(s: string): string {
  return s
    .replace(/\{\{([^}]+)\}\}/g, '`$1`')
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,:;!?])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREV = /\b(e\.g|i\.e|etc|vs|approx|incl|no|mr|mrs|dr|cf)\.$/i;

/** Split prose into sentences without breaking abbreviations, decimals or paths. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`(\[])/);
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur} ${p}` : p;
    if (ABBREV.test(cur)) continue;
    out.push(cur.trim());
    cur = '';
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

const MODAL = /\b(must|should|shall|needs? to|has to|have to|(?:is|are) required to|is expected to|are expected to)\b/i;

// ---------------------------------------------------------------------------
// Format detection and code blocks
// ---------------------------------------------------------------------------

export function detectFormat(text: string): TicketFormat {
  if (/^h[1-6]\.\s/im.test(text) || /\{(code|noformat|panel|color|quote)(:[^}]*)?\}/i.test(text) || /^\|\|/m.test(text) || /^#\s.*\n#\s/m.test(text)) return 'jira';
  if (/^#{1,6}\s/m.test(text) || /^\s*(```|~~~)/m.test(text) || /\*\*[^*]+\*\*/.test(text) || /^\s*[-*]\s\[[ xX]\]/m.test(text)) return 'markdown';
  return 'plain';
}

function extractCode(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const put = (block: string) => {
    blocks.push(block);
    return `\n@@CODE${blocks.length - 1}@@\n`;
  };
  let out = text.replace(/\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\1\}/gi, (b) => put(b));
  // Markdown fences: up to the matching fence, or the end of the text.
  const lines = out.split('\n');
  const res: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fm = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (!fm) {
      res.push(lines[i]);
      continue;
    }
    const fence = fm[1];
    const buf = [lines[i]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      buf.push(lines[j]);
      if (lines[j].trim().startsWith(fence[0].repeat(fence.length)) && lines[j].trim().replace(/[`~]/g, '') === '') break;
    }
    res.push(put(buf.join('\n')).trim());
    i = j;
  }
  out = res.join('\n');
  return { text: out, blocks };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Section {
  kind: SectionKind | 'preamble';
  level: number;
  lines: string[];
  /** Original heading line, kept for the description. */
  heading?: string;
}

export function parseTicket(input: string): ParsedTicket {
  const hash = sha256(input);
  const hiddenRemoved = scanHiddenUnicode(input.replace(/^﻿/, '')).length;
  const normalised = stripHiddenUnicode(input.replace(/^﻿/, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ');
  const format = detectFormat(normalised);
  const { text, blocks } = extractCode(normalised);
  const lines = text.split('\n');

  // Pass 1: title and sections.
  let title = '';
  let titleFromLabel = false;
  let expectTitle = false;
  const sections: Section[] = [{ kind: 'preamble', level: 0, lines: [] }];
  let cur = sections[0];
  let critLevel = 0;
  let firstContentSeen = false;
  let keyPrefix = '';

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      cur.lines.push('');
      continue;
    }
    if (expectTitle) {
      if (!CODE_MARK.test(trimmed)) {
        title = cleanInline(stripHeading(trimmed, format));
        titleFromLabel = true;
        expectTitle = false;
        firstContentSeen = true;
        continue;
      }
    }
    const hit = CODE_MARK.test(trimmed) ? null : labelOf(line, format);
    if (hit) {
      firstContentSeen = true;
      if (hit.kind === 'title') {
        if (hit.inline) {
          title = cleanInline(hit.inline);
          titleFromLabel = true;
        } else expectTitle = true;
        continue;
      }
      if (hit.kind === 'heading') {
        if (!title && cur.kind === 'preamble' && !cur.lines.some((l) => l.trim())) {
          title = cleanInline(hit.text);
          continue;
        }
        // A deeper heading inside the criteria section (e.g. a scenario name) stays in it.
        if (cur.kind === 'crit' && hit.level > critLevel) {
          cur.lines.push(/^scenario\b/i.test(hit.text) ? hit.text : `@@GROUP@@${hit.text}`);
          continue;
        }
        cur = { kind: 'other', level: hit.level, lines: [], heading: hit.text };
        sections.push(cur);
        continue;
      }
      cur = { kind: hit.kind, level: hit.level, lines: [], heading: hit.text };
      if (hit.kind === 'crit') critLevel = hit.level;
      sections.push(cur);
      if (hit.inline) cur.lines.push(hit.inline);
      continue;
    }
    if (!firstContentSeen && !title && cur.kind === 'preamble' && !CODE_MARK.test(trimmed) && !listItem(line, format) && !GWT_RE.test(trimmed)) {
      // A first line that is only a ticket key ("ABC-123") is joined with the title that follows.
      if (!keyPrefix && /^\[?[A-Z][A-Z0-9]{1,9}-\d{1,7}\]?:?$/.test(trimmed)) {
        keyPrefix = trimmed.replace(/[[\]:]/g, '');
        continue;
      }
      firstContentSeen = true;
      title = cleanInline(stripHeading(trimmed, format));
      continue;
    }
    firstContentSeen = true;
    cur.lines.push(line);
  }

  // Pass 2: criteria.
  const primary: ParsedCriterion[] = [];
  const explicitElsewhere: ParsedCriterion[] = [];
  const checkboxesElsewhere: ParsedCriterion[] = [];
  const gwtElsewhere: ParsedCriterion[] = [];
  const expected: ParsedCriterion[] = [];
  const fallbackLists: ParsedCriterion[] = [];
  const proseText: string[] = [];
  const codeInCriteria: number[] = [];
  let hasCritSection = false;

  for (const s of sections) {
    if (s.kind === 'crit') {
      hasCritSection = true;
      primary.push(...extractCriteria(s.lines, format, 'crit', codeInCriteria));
    } else if (s.kind === 'expected') {
      expected.push(...extractCriteria(s.lines, format, 'expected', codeInCriteria));
    } else if (s.kind !== 'meta') {
      const found = extractCriteria(s.lines, format, 'scan', []);
      for (const c of found) {
        if (c.source === 'ac-label') explicitElsewhere.push(c);
        else if (c.source === 'checkbox') checkboxesElsewhere.push(c);
        else if (c.source === 'gwt') gwtElsewhere.push(c);
        else if (c.source === 'list-fallback' && (s.kind === 'preamble' || s.kind === 'desc')) fallbackLists.push(c);
        else if (c.source === 'prose' && (s.kind === 'preamble' || s.kind === 'desc')) proseText.push(c.text);
      }
    }
  }

  let criteria: ParsedCriterion[] = [];
  let inferred = false;
  /** Lines outside the criteria sections that became criteria leave the description. */
  const usedElsewhere = { ac: explicitElsewhere.length > 0, check: false, gwt: false };
  if (primary.length || explicitElsewhere.length) {
    criteria = [...primary, ...explicitElsewhere];
  } else if (checkboxesElsewhere.length || gwtElsewhere.length || expected.length) {
    criteria = [...expected, ...checkboxesElsewhere, ...gwtElsewhere];
    usedElsewhere.check = checkboxesElsewhere.length > 0;
    usedElsewhere.gwt = gwtElsewhere.length > 0;
  } else {
    inferred = true;
    const prose = proseText.flatMap((p) => splitSentences(p)).filter((s) => MODAL.test(s));
    criteria = [...fallbackLists, ...prose.map((t) => ({ text: t, source: 'prose' as const, confidence: CONFIDENCE.prose }))];
  }
  if (!hasCritSection && !criteria.length) inferred = true;
  criteria = dedupe(criteria.filter((c) => c.text.length > 2));

  // Description: preamble, description and other sections; code restored.
  const desc: string[] = [];
  for (const s of sections) {
    if (s.kind === 'crit' || s.kind === 'expected' || s.kind === 'meta') continue;
    const body = s.lines.filter((l) => {
      if (l.startsWith('@@GROUP@@')) return false;
      const it = listItem(l, format);
      if (usedElsewhere.ac && it?.kind === 'ac') return false;
      if (usedElsewhere.check && it?.kind === 'check') return false;
      if (usedElsewhere.gwt && (GWT_RE.test(l.trim()) || SCENARIO_RE.test(l.trim()))) return false;
      return true;
    });
    if (!body.some((l) => l.trim())) continue;
    if (s.kind === 'other' && s.heading) desc.push('', `${cleanInline(s.heading)}:`);
    desc.push(...body);
  }
  if (codeInCriteria.length) {
    desc.push('', 'Code from the acceptance criteria:');
    for (const n of codeInCriteria) desc.push(`@@CODE${n}@@`);
  }
  if (expected.length && criteria.every((c) => c.source !== 'expected')) {
    // Expected-result lines that did not become criteria stay visible.
    desc.push('', 'Expected result:', ...expected.map((c) => `- ${c.text}`));
  }
  let description = desc
    .join('\n')
    .replace(/@@CODE(\d+)@@/g, (_m, n) => blocks[Number(n)] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!title) {
    const first = (criteria[0]?.text ?? description.split('\n').find((l) => l.trim()) ?? '').trim();
    title = first.length > 80 ? first.slice(0, 77) + '...' : first || 'Untitled ticket';
  }
  void titleFromLabel;
  if (keyPrefix && !title.includes(keyPrefix)) title = `${keyPrefix} ${title}`;
  description = description.replace(/^h([1-6])\.\s+/gim, (_m, n) => '#'.repeat(Number(n)) + ' ');

  return { title, description, criteria, format, codeBlocks: blocks.length, hiddenRemoved, hash, inferred };
}

function stripHeading(t: string, format: TicketFormat): string {
  let s = t.replace(/^h[1-6]\.\s+/i, '');
  if (format !== 'jira') s = s.replace(/^#{1,6}\s+/, '');
  return s.replace(/^(\*\*|__|\*)(.+)\1$/, '$2');
}

function dedupe(list: ParsedCriterion[]): ParsedCriterion[] {
  const seen = new Set<string>();
  const out: ParsedCriterion[] = [];
  for (const c of list) {
    const k = c.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * Criteria from the lines of one section.
 * mode 'crit': everything counts (items, scenarios, plain lines);
 * mode 'expected': same, with the lower 'expected' confidence;
 * mode 'scan': items are reported with their source so the caller can decide
 * (AC labels, checkboxes and scenarios count anywhere; plain lists and prose
 * only as a fallback).
 */
function extractCriteria(lines: string[], format: TicketFormat, mode: 'crit' | 'expected' | 'scan', codeRefs: number[]): ParsedCriterion[] {
  const out: ParsedCriterion[] = [];
  let baseIndent = -1;
  let listActive = false;
  let last: ParsedCriterion | null = null;
  let lastWasItem = false;
  let prefix = '';
  let scenario: { name: string; parts: string[]; hasThen: boolean } | null = null;
  let prose: string[] = [];

  const src = (s: CriterionSource): CriterionSource => (mode === 'expected' && (s === 'list' || s === 'section-line' || s === 'table') ? 'expected' : s);
  const push = (text: string, source: CriterionSource, label?: string) => {
    const t = cleanInline(text);
    if (!t || CODE_MARK.test(t)) return null;
    const c: ParsedCriterion = { text: t, source, confidence: CONFIDENCE[source], ...(label ? { label } : {}) };
    out.push(c);
    return c;
  };
  const flushScenario = () => {
    if (scenario && scenario.parts.length) {
      const body = scenario.parts.join(', ');
      push(scenario.name ? `${scenario.name}: ${body}` : body, 'gwt');
    }
    scenario = null;
  };
  const flushProse = () => {
    if (!prose.length) return;
    const text = prose.join(' ');
    prose = [];
    if (mode === 'scan') {
      out.push({ text: cleanInline(text), source: 'prose', confidence: CONFIDENCE.prose });
      return;
    }
    for (const s of splitSentences(cleanInline(text))) push(s, src('section-line'));
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flushProse();
      if (scenario && (scenario as { hasThen: boolean }).hasThen) flushScenario();
      lastWasItem = false;
      prefix = '';
      continue;
    }
    const code = CODE_MARK.exec(t);
    if (code) {
      flushProse();
      if (mode !== 'scan') codeRefs.push(Number(code[1]));
      lastWasItem = false;
      continue;
    }
    if (t.startsWith('@@GROUP@@')) {
      flushProse();
      flushScenario();
      lastWasItem = false;
      listActive = false;
      continue;
    }
    const sc = SCENARIO_RE.exec(t);
    if (sc) {
      flushProse();
      flushScenario();
      scenario = { name: cleanInline(sc[1]), parts: [], hasThen: false };
      lastWasItem = false;
      listActive = false;
      continue;
    }
    const item = listItem(line, format);
    const gwt = GWT_RE.exec(item && item.kind !== 'table' ? item.text : t);
    if (gwt) {
      const kw = gwt[1].toLowerCase();
      const rest = gwt[2];
      const nextT = (lines.slice(i + 1).find((l) => l.trim()) ?? '').trim();
      const startsScenario = kw === 'given' || (kw === 'when' && /^(?:[-*•+]\s+)?(?:\*\*|\*)?(then|and)\b/i.test(nextT));
      const sc2 = scenario as { name: string; parts: string[]; hasThen: boolean } | null;
      if (startsScenario && sc2 && sc2.parts.length && (kw === 'given' ? true : sc2.hasThen)) flushScenario();
      const open = scenario as { name: string; parts: string[]; hasThen: boolean } | null;
      if (open || startsScenario) {
        flushProse();
        if (!open) scenario = { name: '', parts: [], hasThen: false };
        const s = scenario as unknown as { name: string; parts: string[]; hasThen: boolean };
        const word = s.parts.length ? kw : gwt[1][0].toUpperCase() + gwt[1].slice(1).toLowerCase();
        s.parts.push(`${word} ${cleanInline(rest)}`.replace(/[.;]$/, ''));
        if (kw === 'then') s.hasThen = true;
        lastWasItem = false;
        continue;
      }
    }
    if (scenario) flushScenario();

    if (item) {
      flushProse();
      if (item.kind === 'table') {
        const next = (lines[i + 1] ?? '').trim();
        if (/^\|[\s:|-]+\|?$/.test(next) && /-/.test(next)) {
          lastWasItem = false;
          continue; // Markdown header row
        }
        if (item.text) last = push(item.text, mode === 'scan' ? 'list-fallback' : src('table'), item.label);
        lastWasItem = false;
        continue;
      }
      if (!listActive) baseIndent = item.indent;
      listActive = true;
      const isChild = last !== null && item.indent > baseIndent + 1 && item.kind !== 'ac';
      if (isChild && last) {
        const joiner = /:$/.test(last.text) ? ' ' : '; ';
        last.text = `${last.text}${joiner}${cleanInline(item.text)}`;
        lastWasItem = true;
        continue;
      }
      if (item.indent < baseIndent) baseIndent = item.indent;
      let source: CriterionSource;
      if (item.kind === 'ac') source = 'ac-label';
      else if (item.kind === 'check') source = 'checkbox';
      else source = mode === 'scan' ? 'list-fallback' : src('list');
      const text = prefix && item.kind !== 'ac' ? `${prefix} ${item.text}` : item.text;
      last = push(text, source, item.kind === 'ac' ? item.label : item.label);
      lastWasItem = true;
      continue;
    }
    // A plain line right after an item continues it.
    if (lastWasItem && last) {
      last.text = cleanInline(`${last.text} ${t}`);
      continue;
    }
    // An intro line ending with ':' followed by items prefixes them.
    const nextLine = lines.slice(i + 1).find((l) => l.trim()) ?? '';
    if (/:$/.test(t) && listItem(nextLine, format)) {
      flushProse();
      prefix = cleanInline(t);
      if (mode === 'scan') prose.push(t);
      continue;
    }
    prose.push(t);
    listActive = false;
  }
  flushProse();
  flushScenario();
  return out;
}
