/**
 * Skill checks: R18 skill-spec violation and R28 skill shape.
 *
 * R18 (Agent Skills spec): front matter with `name` and `description`; the
 * name matches ^[a-z0-9]+(-[a-z0-9]+)*$, is at most 64 characters and equals
 * the folder name; the description is at most 1,024 characters; keys outside
 * the six spec fields are warned (known vendor keys are info only).
 *
 * R28 (shape): a description that does not say when to use the skill, a body
 * over 500 lines, and a skill the model may invoke on its own whose body runs
 * something with side effects (push, deploy, publish, migrate production,
 * destructive deletes).
 */
import * as path from 'node:path';
import { escapeForReport } from './scan';
import { docOf } from './checks';
import type { AssessContext, InvFile } from './model';

const SPEC_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
const VENDOR_KEYS = new Set([
  // Claude Code
  'disable-model-invocation',
  'user-invocable',
  'argument-hint',
  'model',
  'context',
  'agent',
  'hooks',
  'when_to_use',
  'version',
  // Devin
  'subagent',
  'permissions',
  'triggers',
  // Codex
  'short-description',
]);
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WHEN_CUE = /\b(use (this |it )?(when|for|to|before|after|if|whenever)|when(ever)?\b|before\b|after\b|if the\b|for (tasks|requests|work|changes)|triggers? (on|when)|invoke)/i;
const SIDE_EFFECT = /\b(git\s+push|gh\s+pr\s+(create|merge)|npm\s+publish|deploy\w*|kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|drop\s+table|truncate\s+table|rm\s+-rf|send(s|ing)?\s+(an?\s+)?(email|message))\b|\bmigrat\w*\b[^.\n]*\b(prod|production)\b/i;

function fmLine(f: InvFile, key: string): number | undefined {
  const doc = docOf(f);
  return doc.units.find((u) => u.kind === 'fm-key' && u.key === key)?.start;
}

export function skillChecks(ctx: AssessContext): void {
  for (const f of ctx.files) {
    if (f.kind !== 'skill' || f.binary) continue;
    const doc = docOf(f);
    const add = (check: string, severity: 'warn' | 'info', message: string, line?: number, cls?: 'FIX' | 'TRIM', reason?: string) => {
      ctx.findings.push({ check, severity, file: f.abs, line, message, evidence: line ? escapeForReport(doc.lines[line - 1] ?? '') : undefined });
      if (cls && line) ctx.marks.push({ file: f, line, cls, check, reason: reason ?? message });
    };
    if (!doc.frontMatter) {
      add('R18', 'warn', `${f.display} has no front matter, so no agent can tell what the skill is for (name and description are required).`, 1, 'FIX', 'no front matter (name, description)');
      continue;
    }
    const keys = new Map<string, { line: number; value: string }>();
    for (const u of doc.units) {
      if (u.kind !== 'fm-key' || !u.key) continue;
      const first = u.lines[0].replace(/^[^:]*:\s*/, '');
      const value = /^[|>]-?\s*$/.test(first) || first === '' ? u.lines.slice(1).map((l) => l.trim()).join(' ') : first;
      keys.set(u.key, { line: u.start, value: value.replace(/^['"]|['"]$/g, '').trim() });
    }
    const dirName = path.basename(path.dirname(f.abs));
    const firstKeyLine = doc.frontMatter.start + 1;
    const name = keys.get('name');
    if (!name || !name.value) add('R18', 'warn', `${f.display} has no name in its front matter.`, name?.line ?? firstKeyLine, 'FIX', 'front matter has no name');
    else {
      const problems: string[] = [];
      if (!SKILL_NAME_RE.test(name.value)) problems.push('is not lower-case words joined by hyphens');
      if (name.value.length > 64) problems.push('is longer than 64 characters');
      if (name.value !== dirName) problems.push(`differs from its folder name "${dirName}"`);
      if (problems.length) add('R18', 'warn', `The skill name "${escapeForReport(name.value, 80)}" ${problems.join(', ')}.`, name.line, 'FIX', `bad skill name: ${problems.join(', ')}`);
    }
    const desc = keys.get('description');
    if (!desc || !desc.value) add('R18', 'warn', `${f.display} has no description, so the agent cannot choose it reliably.`, firstKeyLine, 'FIX', 'front matter has no description; the skill cannot be selected');
    else if (desc.value.length > 1024) add('R18', 'warn', `The description is ${desc.value.length} characters; the limit is 1,024.`, desc.line, 'FIX', 'description over 1,024 characters');
    else {
      const words = desc.value.split(/\s+/).filter(Boolean).length;
      if (words < 5 || (desc.value.length < 80 && !WHEN_CUE.test(desc.value))) add('R28', 'warn', `The description "${escapeForReport(desc.value, 80)}" does not say what the skill does and when to use it; the agent cannot select it reliably.`, desc.line, 'FIX', 'weak description: does not say when to use the skill');
    }
    for (const [k, v] of keys) {
      if (SPEC_KEYS.has(k)) continue;
      if (VENDOR_KEYS.has(k)) add('R18', 'info', `Front matter key "${k}" is a vendor extension, not part of the Agent Skills spec; other agents ignore it.`, v.line);
      else add('R18', 'warn', `Front matter key "${k}" is not part of the Agent Skills spec.`, v.line, 'TRIM', `front matter key "${k}" outside the spec fields`);
    }
    const bodyLines = doc.lines.length - doc.frontMatter.end;
    if (bodyLines > 500) add('R28', 'warn', `The body of ${f.display} is ${bodyLines} lines; keep a skill under 500 lines and move detail into files it reads.`, doc.frontMatter.end + 1);
    const modelInvocable = !(keys.get('disable-model-invocation')?.value === 'true') && !(keys.has('triggers') && !/\bmodel\b/.test(keys.get('triggers')!.value));
    if (modelInvocable) {
      const body = doc.lines.slice(doc.frontMatter.end);
      const i = body.findIndex((l) => SIDE_EFFECT.test(l));
      if (i >= 0) {
        const m = SIDE_EFFECT.exec(body[i]);
        add('R28', 'warn', `${f.display} can be invoked by the model on its own and its body runs something with side effects ("${escapeForReport(m ? m[0] : '', 40)}"); make it user-invoked (disable-model-invocation: true for Claude Code, triggers: [user] for Devin).`, doc.frontMatter.end + i + 1);
      }
    }
  }
}
