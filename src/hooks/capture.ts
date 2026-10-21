/**
 * Prompt-side helpers for the UserPromptSubmit hook: correction capture
 * (DESIGN §2.9: classification plus a hash, never text), the pasted-ticket
 * shape, the rail warnings for bypass and handoff requests (DESIGN §2.10,
 * §6), and repo mentions for standards injection (§2.4).
 *
 * Everything here is a pure function of the prompt text; nothing here logs
 * or stores the text.
 */
import * as path from 'node:path';

export type CorrectionClass = 'style' | 'test' | 'scope' | 'verify' | 'safety' | 'other';
export const CORRECTION_CLASSES: CorrectionClass[] = ['style', 'test', 'scope', 'verify', 'safety', 'other'];

/** Steering shapes: a message that redirects work already under way. */
const STEERING: RegExp[] = [
  /^\s*(no|nope|nah)\s*([,.!:;-]|$)/i,
  /^\s*(no|nope),?\s+(that|this|it|you|not|don'?t|use|we)\b/i,
  /\b(don'?t|do not|never)\s+\w+/i,
  /\byou should(n'?t| not)? have\b/i,
  /\b(wrong|incorrect|not right|not correct|broke|broken)\b/i,
  /\bthat'?s not (how|what|the way)\b/i,
  /\bthis is not (how|what|the way)\b/i,
  /\buse\s+[^\n.]{1,40}?\s+instead\b/i,
  /\binstead of\b/i,
  /\bagain\b/i,
  /\b(stop|revert|undo|roll ?back|put (it|that) back)\b/i,
  /\bnot what i (asked|wanted|meant|said)\b/i,
  /\bwhy (did|would) you\b/i,
  /\bi (said|told you|already said|asked you)\b/i,
];

const CLASS_RULES: Array<{ cls: CorrectionClass; re: RegExp }> = [
  { cls: 'safety', re: /\b(prod(uction)?|database|db|sql ?server|secrets?|passwords?|credentials?|tokens?|\.env|force[- ]?push|push(ed|ing)?|delete[ds]?|drop(ped)?|truncate|main branch|history|rm -rf|migrations?)\b/i },
  { cls: 'verify', re: /\b(verif(y|ied)|check(ed)?|run (it|that|the|them)|gate|e2e|end[- ]to[- ]end|evidence|prove|actually (run|test|try)|try it|did(n'?t| not) (run|test|check|try))\b/i },
  { cls: 'test', re: /\b(tests?|specs?|asserts?|assertions?|coverage|mocks?|fixtures?|jest|vitest|mocha|pytest|snapshot)\b/i },
  { cls: 'scope', re: /\b(scope|only|just|ticket|unrelated|out of scope|too much|extra|leave (it|that|them|\w+) alone|don'?t touch|do not touch|refactor(ed|ing)?|other files?|rewrite)\b/i },
  { cls: 'style', re: /\b(style|naming|named?|format(ted|ting)?|lint|conventions?|indent(ation)?|camel ?case|snake ?case|imports?|patterns?|idiom|how we|our way|consistent|logger|console)\b/i },
];

/** The correction class of a prompt, or null when it does not look like steering. */
export function classifyCorrection(prompt: string): CorrectionClass | null {
  const text = String(prompt ?? '');
  if (!text.trim()) return null;
  // Only the first lines decide: a pasted log or ticket below them is not steering.
  const head = text.split(/\r?\n/).slice(0, 6).join('\n').slice(0, 600);
  if (!STEERING.some((re) => re.test(head))) return null;
  for (const { cls, re } of CLASS_RULES) if (re.test(head)) return cls;
  return 'other';
}

/** A pasted ticket: a title line, then acceptance criteria (a heading, Given/When/Then, or a criteria list). */
export function looksLikeTicket(prompt: string): boolean {
  const text = String(prompt ?? '');
  if (text.length < 80) return false;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  const acHeading = /^(#+\s*|\*\*)?(acceptance criteria|acceptance|definition of done|ac)\b\s*[:*]?/im.test(text) || /\bacceptance criteria\b/i.test(text);
  const gherkin = /^\s*(given)\b/im.test(text) && /^\s*(then)\b/im.test(text);
  const bullets = lines.filter((l) => /^([-*•]|\d+[.)]|\[[ xX]\])\s+\S/.test(l)).length;
  const ticketKey = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/.test(lines[0]);
  const titled = ticketKey || /^(#+\s*)?(title|story|bug|feature|task|ticket)\s*[:#-]/i.test(lines[0]) || (lines[0].length <= 120 && !/[.?!]$/.test(lines[0]));
  if (!titled) return false;
  return (acHeading && (bullets >= 1 || gherkin)) || gherkin || (ticketKey && bullets >= 2);
}

export const TICKET_REMINDER = 'harness: this looks like a pasted ticket. Before coding, save the ticket text to a file outside the repository (with your file tool, not through the shell) and run `harness intake --from <that file>` to turn it into a brief with checks (the harness never runs it for you).';

export const WARN_MODE_BYPASS =
  'harness warning: Bypass mode may switch off the harness rails (whether Devin applies user-level deny rules and hooks in Bypass mode is unknown), so this setup forbids `/mode bypass`. Stay in the current mode. If the user wants Bypass anyway, it is their switch to make, knowing the test-database, no-secrets, no-force-push and team-repo rails may not hold.';
export const WARN_HANDOFF =
  'harness warning: `/handoff` moves this local session to the cloud, where people in the organisation may see its content. Before handing off, check that no harness files sit untracked inside a team repo and that nothing private is in the conversation; the user decides.';
export const WARN_HOOKS_OFF =
  'harness warning: the hooks carry the safety rails (test databases only, no secrets in commits or logs, no force-push or history rewrite, nothing of the harness in team repos) and the done-gate. The agent must not disable or bypass them, or change hook, permission or harness settings. If the user wants them off, they do it themselves in a terminal (`harness uninstall`, or `harness config`).';

/** Warnings for prompts that ask to switch modes, hand off, or disable hooks. */
export function bypassWarnings(prompt: string): string[] {
  const text = String(prompt ?? '');
  const out: string[] = [];
  if (/(^|\s)\/mode\s+bypass\b/i.test(text) || /\bbypass mode\b/i.test(text)) out.push(WARN_MODE_BYPASS);
  if (/(^|\s)\/handoff\b/i.test(text)) out.push(WARN_HANDOFF);
  if (
    /\b(disable|turn off|switch off|remove|skip|bypass|ignore|deactivate|kill)\b[^.\n]{0,40}\b(hooks?|guard|rails?|harness|done[- ]gate)\b/i.test(text) ||
    /\bdisableAllHooks\b|--dangerously-skip-permissions|--dangerously-bypass|--ignore-user-config|--ignore-rules|--no-hooks\b|--bare\b/i.test(text)
  ) {
    out.push(WARN_HOOKS_OFF);
  }
  return out;
}

export interface RepoCandidate {
  id: string;
  name: string;
  /** Absolute path, when known. */
  path?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Repos named in a prompt, by name (whole word, 3+ characters) or by path. */
export function mentionedRepos(prompt: string, candidates: RepoCandidate[], workspaceRoot?: string): RepoCandidate[] {
  const text = String(prompt ?? '');
  const norm = text.replace(/\\/g, '/');
  const out: RepoCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    let hit = false;
    if (c.name && c.name.length >= 3) {
      const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(c.name)}($|[^A-Za-z0-9_-])`, 'i');
      hit = re.test(text);
    }
    if (!hit && c.path) {
      const abs = c.path.replace(/\\/g, '/');
      if (norm.toLowerCase().includes(abs.toLowerCase())) hit = true;
      else if (workspaceRoot) {
        const rel = path.relative(workspaceRoot, c.path).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..') && rel.includes('/') && norm.includes(rel)) hit = true;
      }
    }
    if (hit) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
