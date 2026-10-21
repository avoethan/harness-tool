/**
 * Scans for text that tries to steer an agent: hidden Unicode and common
 * injection phrasings. Used on everything that may end up in a statement or
 * fix text an agent will read (judgment results, review clusters, written
 * rules). A hit means the text is not used; the finding names the pattern.
 */
import { scanHiddenUnicode } from '../lib/unicode';

const PATTERNS: Array<[string, RegExp]> = [
  ['ignore-instructions', /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|messages?)\b/i],
  ['role-override', /\b(you are now|act as|pretend to be|from now on you)\b/i],
  ['system-prompt', /\b(system prompt|developer message|<\/?system>|\[\/?INST\])/i],
  ['tool-escalation', /\b(run|execute|invoke)\b[^.\n]{0,30}\b(curl|wget|bash -c|sh -c|powershell|Invoke-WebRequest|iwr)\b/i],
  ['remote-fetch', /\b(curl|wget)\s+(-\w+\s+)*https?:\/\//i],
  ['destructive', /\brm\s+-rf\s+[~/]|\bgit\s+push\s+--force\b|\bdrop\s+database\b/i],
  ['secret-exfiltration', /\b(send|post|upload|exfiltrat\w*)\b[^.\n]{0,40}\b(token|secret|password|credential|api[_ -]?key|\.env)\b/i],
  ['disable-safety', /\b(disable|turn off|bypass|skip)\b[^.\n]{0,30}\b(hooks?|guard|safety|verification|--no-verify)\b/i],
  ['html-script', /<script\b|javascript:/i],
];

/** Names of the patterns the text matches (empty when clean). */
export function scanInjection(text: string): string[] {
  const hits: string[] = [];
  if (scanHiddenUnicode(text).length) hits.push('hidden-unicode');
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}
