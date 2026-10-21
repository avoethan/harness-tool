/**
 * The skills are the agent's manual: every `harness ...` command they name must
 * exist, with the subcommand and the flags the skill uses (each named in the
 * command's usage line or examples). A mismatch is fixed on the smaller side:
 * the skill text or the command.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SRC = fs.existsSync(path.join(ROOT, 'src')) ? ROOT : path.resolve(__dirname, '..', '..', '..');

function skillText(skill: string): string {
  return fs.readFileSync(path.join(SRC, 'templates', 'skills', skill, 'SKILL.md'), 'utf8');
}

/** Every `harness ...` command line a skill names (code spans and code blocks), template markers removed, comments cut. */
function namedCommands(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const c = raw.replace(/\{\{[^}]*\}\}/g, '').replace(/\s#\s.*$/, '').replace(/\s+/g, ' ').trim();
    if (/^harness [a-z]/.test(c)) out.add(c);
  };
  for (const m of text.matchAll(/`(harness [^`]+)`/g)) add(m[1]);
  for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) add(line);
  return [...out];
}

function usageOf(cmd: string): string | null {
  const mod = path.join(__dirname, '..', '..', '..', 'src', 'commands', `${cmd}.js`);
  if (!/^[a-z][a-z-]*$/.test(cmd) || !fs.existsSync(mod)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require(mod) as { meta?: { usage?: string; examples?: string[] } };
  return [m.meta?.usage ?? '', ...(m.meta?.examples ?? [])].join('\n');
}

/** The problems of one named command line; empty when the command, subcommand and flags exist. */
function audit(label: string, line: string): string[] {
  const words = line.split(' ');
  const cmd = words[1];
  const usage = usageOf(cmd);
  if (usage === null) return [`${label}: \`${line}\`: no command "${cmd}"`];
  const problems: string[] = [];
  const sub = words[2];
  if (sub && /^[a-z][a-z-]*$/.test(sub) && !new RegExp(`\\b${sub}\\b`).test(usage)) problems.push(`${label}: \`${line}\`: "${cmd}" has no subcommand "${sub}" in its usage`);
  for (const w of words.slice(2)) {
    const flag = /^(--[a-z][a-z-]*)/.exec(w)?.[1];
    if (flag && !usage.includes(flag)) problems.push(`${label}: \`${line}\`: flag ${flag} is not in the usage of "harness ${cmd}"`);
  }
  return problems;
}

test('every harness command, subcommand and flag the task, learn and setup skills name exists in that command\'s usage', (t) => {
  // the audit itself catches each kind of mismatch
  assert.equal(audit('x', 'harness nosuch thing').length, 1);
  assert.equal(audit('x', 'harness gate --no-such-flag').length, 1);
  assert.equal(audit('x', 'harness verify nosuchsub').length, 1);
  assert.deepEqual(audit('x', 'harness verify drive --method GET --criterion AC1'), []);
  const problems: string[] = [];
  let checked = 0;
  for (const skill of ['task', 'learn', 'setup']) {
    for (const line of namedCommands(skillText(skill))) {
      checked++;
      problems.push(...audit(skill, line));
    }
  }
  t.diagnostic(`${checked} command lines named by the three skills`);
  assert.ok(checked >= 30, `only ${checked} command lines found`);
  assert.deepEqual(problems, []);
});
