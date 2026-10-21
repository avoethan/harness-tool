/**
 * Raw scans that run before any parsing (DESIGN 2.2): hidden Unicode (R10),
 * HTML comments with instruction-like text (R11), injection phrasing (R12),
 * and autonomy-escalation phrases (R13). The same functions re-scan an
 * imported judgment result.
 *
 * Every function here returns positions and short labels; quoting text for a
 * report goes through `escapeForReport`, which makes hidden code points
 * visible and redacts secrets.
 */
import { scanHiddenUnicode } from '../lib/unicode';
import { redactText } from '../lib/redact';

export interface RawHit {
  line: number;
  label: string;
}

/** Decode bytes as UTF-8; `binary` is true when they are not valid UTF-8. */
export function decode(buf: Buffer): { text: string; binary: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), binary: false };
  } catch {
    return { text: new TextDecoder('utf-8').decode(buf), binary: true };
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const KIND_LABEL: Record<string, string> = { tag: 'Unicode tag character', 'zero-width': 'zero-width character', bidi: 'bidirectional control', bom: 'byte-order mark inside the text' };

/** R10: hidden code points, one hit per line with the code points named. */
export function scanHidden(text: string): RawHit[] {
  const hits = scanHiddenUnicode(text);
  if (!hits.length) return [];
  const starts = lineStarts(text);
  const byLine = new Map<number, Set<string>>();
  for (const h of hits) {
    const line = lineAt(starts, h.offset);
    const label = `U+${h.codePoint.toString(16).toUpperCase().padStart(4, '0')} (${KIND_LABEL[h.kind] ?? h.kind})`;
    if (!byLine.has(line)) byLine.set(line, new Set());
    byLine.get(line)!.add(label);
  }
  return [...byLine.entries()].map(([line, labels]) => ({ line, label: [...labels].join(', ') }));
}

// ---------------------------------------------------------------------------
// R12 injection phrasing
// ---------------------------------------------------------------------------

interface Pattern {
  re: RegExp;
  label: string;
  /** Where the pattern applies: agent files only, or docs (README, CONTRIBUTING, docs/) too. */
  scope: 'agent' | 'all' | 'docs';
}

export const INJECTION_PATTERNS: Pattern[] = [
  { re: /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|all|other)\s+(?:instructions|rules|guidance|directions|prompts?)\b/i, label: 'asks to ignore earlier instructions', scope: 'all' },
  { re: /\bdisregard\s+(?:the|all|any|previous|prior|above|your)\b/i, label: 'asks to disregard instructions', scope: 'all' },
  { re: /\bsystem\s+prompt\b/i, label: 'mentions the system prompt', scope: 'all' },
  { re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform)\b/i, label: 'asks to keep something from people', scope: 'all' },
  { re: /\b(?:do\s+not|don'?t|never)\s+(?:mention|reveal|disclose)\b[^.\n]{0,40}\b(?:user|human|anyone|reviewer|operator|maintainers?)\b/i, label: 'asks to keep something from people', scope: 'all' },
  { re: /\byou\s+are\s+now\b/i, label: 'tries to change the agent\'s role ("you are now")', scope: 'agent' },
  { re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, label: 'downloads and pipes into a shell', scope: 'agent' },
  { re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]{0,200}\|\s*iex\b/i, label: 'downloads and pipes into PowerShell', scope: 'agent' },
  { re: /\b(?:note|message|instructions?|prompt)\s+(?:for|to)\s+(?:any\s+|all\s+)?(?:ai|llm|the)?\s*(?:tools?|agents?|assistants?|models?|llms?)\b/i, label: 'text addressed to AI tools', scope: 'docs' },
  { re: /\byou\s+are\s+now\s+(?:operating|acting)\s+as\b/i, label: 'tries to change the agent\'s role', scope: 'docs' },
];

/** R12 over a text. `agentFile` selects the agent-file patterns; otherwise the docs set. */
export function scanInjection(text: string, agentFile: boolean): RawHit[] {
  const out: RawHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((l, idx) => {
    for (const p of INJECTION_PATTERNS) {
      if (agentFile ? p.scope === 'docs' : p.scope === 'agent') continue;
      if (p.re.test(l)) {
        out.push({ line: idx + 1, label: p.label });
        break;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// R11 HTML comments with instruction-like text
// ---------------------------------------------------------------------------

const INSTR_WORDS = /\b(must|always|never|run|execute|ignore|delete|remove|push|install|ensure|make sure|should|do not|don'?t)\b/gi;
const CONCEAL = /\b(do not|don'?t|never)\s+(tell|mention|inform|reveal|show)\b|\bwithout telling\b|\bsecretly\b|\bhide this\b/i;
const DOWNLOAD = /\b(curl|wget|iwr|invoke-webrequest)\b|https?:\/\//i;
const AGENT_NAME = /\b(agents?|ai|assistants?|claude|codex|devin|copilot|cursor|llms?|models?|bots?)\b/i;
const BANNER = /\b(auto-?generated|generated (by|from|with)|do not edit|don'?t edit|prettier-ignore|markdownlint|eslint-disable|toc|vale )/i;

export interface CommentHit extends RawHit {
  endLine: number;
}

/** R11: HTML comments whose text reads like an instruction to an agent. */
export function scanHtmlComments(text: string): CommentHit[] {
  const out: CommentHit[] = [];
  const starts = lineStarts(text);
  const re = /<!--([\s\S]*?)(?:-->|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const words = new Set((body.match(INSTR_WORDS) ?? []).map((w) => w.toLowerCase()));
    const conceal = CONCEAL.test(body);
    const download = DOWNLOAD.test(body);
    const agent = AGENT_NAME.test(body) && words.size >= 1;
    const banner = BANNER.test(body);
    let why: string | null = null;
    if (conceal) why = 'asks to hide something';
    else if (download) why = 'mentions a download';
    else if (banner) why = null;
    else if (agent) why = 'addresses agents with an instruction';
    else if (words.size >= 2) why = `instruction words (${[...words].slice(0, 4).join(', ')})`;
    if (why) out.push({ line: lineAt(starts, m.index), endLine: lineAt(starts, m.index + m[0].length - 1), label: why });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// R13 autonomy escalation
// ---------------------------------------------------------------------------

const AUTONOMY: Array<{ re: RegExp; label: string }> = [
  { re: /\bwithout\s+(?:first\s+)?asking\b/i, label: '"without asking"' },
  { re: /\bwithout\s+(?:my\s+|any\s+|user\s+|human\s+)?(?:approval|confirmation|permission|review)\b/i, label: '"without approval"' },
  { re: /\bwithout\s+waiting\s+for\s+(?:approval|confirmation|the\s+user|me|review)\b/i, label: '"without waiting for approval"' },
  { re: /\b(?:never|do\s+not|don'?t|no\s+need\s+to)\s+ask\s+(?:me\s+|the\s+user\s+|anyone\s+|any\s+)?(?:for\s+)?(?:permission|confirmation|approval|before|first|questions|clarifying\s+questions)\b/i, label: '"never ask"' },
  { re: /\b(?:do\s+not|don'?t|never)\s+wait\s+for\s+(?:user\s+|my\s+|human\s+)?(?:approval|confirmation|review)\b/i, label: '"don\'t wait for approval"' },
  { re: /\bauto-?merge\b/i, label: '"auto-merge"' },
  { re: /\bmerge\s+(?:it|the\s+pr|the\s+pull\s+request|your\s+(?:own\s+)?(?:pr|changes))\s+yourself\b/i, label: '"merge it yourself"' },
  { re: /\bpush\s+(?:directly|straight)\s+to\s+(?:main|master|the\s+default\s+branch)\b/i, label: '"push directly to main"' },
  { re: /--dangerously-skip-permissions\b/i, label: '--dangerously-skip-permissions' },
  { re: /(?:^|\s)--yolo\b/i, label: '--yolo' },
  { re: /\bdanger-full-access\b/i, label: 'danger-full-access' },
  { re: /\bbypassPermissions\b/, label: 'bypassPermissions' },
  { re: /\b(?:do\s+not|don'?t|never)\s+use\s+AskUserQuestion\b/i, label: '"don\'t use AskUserQuestion"' },
];

const NEGATION_BEFORE = /\b(never|do\s+not|don'?t|must\s+not|mustn'?t|should\s+not|shouldn'?t|cannot|can'?t|no|not)\b[^.;!?]*$/i;

/**
 * R13 on one line: an autonomy grant that is not itself negated
 * ("Never push directly to main" is a safety rule, not a grant).
 */
export function autonomyHit(line: string): string | null {
  for (const p of AUTONOMY) {
    const m = p.re.exec(line);
    if (!m) continue;
    const before = line.slice(0, m.index);
    const clause = before.split(/[.;!?]/).pop() ?? '';
    // "never ask" / "don't wait" carry their own negation; for the others a negation earlier in the clause flips them
    const selfNegating = /^(never|do\s+not|don'?t|no\s+need)/i.test(m[0]);
    if (!selfNegating && NEGATION_BEFORE.test(clause)) continue;
    return p.label;
  }
  return null;
}

export function scanAutonomy(text: string): RawHit[] {
  const out: RawHit[] = [];
  text.split(/\r?\n/).forEach((l, idx) => {
    const label = autonomyHit(l);
    if (label) out.push({ line: idx + 1, label });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

function showHidden(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const hidden =
      (cp >= 0xe0000 && cp <= 0xe007f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      cp === 0x2060 ||
      cp === 0xfeff ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      (cp < 0x20 && cp !== 0x09) ||
      cp === 0x7f;
    out += hidden ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
  }
  return out;
}

/**
 * One line of untrusted text made safe to print: hidden and control code
 * points shown as <U+XXXX>, secrets redacted, whitespace collapsed, cut to
 * `max` characters.
 */
export function escapeForReport(s: string, max = 160): string {
  const out = redactText(showHidden(s.replace(/[\r\n\t ]+/g, ' ')).trim());
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

/** A line kept as it is (indentation included) except hidden code points made visible and secrets redacted. */
export function visibleLine(s: string, max = 2000): string {
  const out = redactText(showHidden(s));
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

/** Make every string in a JSON value free of hidden code points (file names can carry them too). */
export function sanitizeDeep<T>(v: T, depth = 0): T {
  if (depth > 30) return v;
  if (typeof v === 'string') return showHidden(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => sanitizeDeep(x, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[showHidden(k)] = sanitizeDeep(x, depth + 1);
    return out as T;
  }
  return v;
}
