/**
 * Every `harness <command> ...` written in code in the user-facing docs (inline
 * code spans and fenced code blocks of README.md, ARCHITECTURE.md, SAFETY.md,
 * docs/, selfcheck/, the skills, and the component READMEs) names a command
 * the CLI has, with flags that command's usage names. Quoted arguments and
 * `#` comments are ignored; text after a pipe or `;` belongs to another command.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMMANDS, HELP_USAGE, type CommandModule } from '../../../src/cli';
import { packageRoot } from '../../../src/lib/paths';

export interface Mention {
  file: string;
  line: number;
  command: string;
  flags: string[];
  text: string;
}

function docFiles(): string[] {
  const root = packageRoot();
  const out: string[] = [];
  const add = (p: string) => {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
  };
  for (const f of ['README.md', 'ARCHITECTURE.md', 'SAFETY.md', 'CHANGELOG.md']) add(path.join(root, f));
  for (const dir of ['docs', 'selfcheck']) {
    const d = path.join(root, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) add(path.join(d, f));
  }
  const skills = path.join(root, 'templates', 'skills');
  if (fs.existsSync(skills)) for (const s of fs.readdirSync(skills)) add(path.join(skills, s, 'SKILL.md'));
  const src = path.join(root, 'src');
  for (const s of fs.readdirSync(src)) add(path.join(src, s, 'README.md'));
  return out.sort();
}

/** The code on each line: fenced block lines whole, elsewhere the inline code spans. */
export function codeOf(text: string): Array<{ line: number; code: string }> {
  const out: Array<{ line: number; code: string }> = [];
  let fenced = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) {
      fenced = !fenced;
      return;
    }
    if (fenced) out.push({ line: i + 1, code: l });
    else for (const m of l.matchAll(/`([^`]+)`/g)) out.push({ line: i + 1, code: m[1] });
  });
  return out;
}

/**
 * `harness <command> ...` in one piece of code. `invoked` is true when it stands
 * where a command starts (the start of the code, after a pipe, `;`, `&&`, `(` or a
 * prompt) and does not read like a quoted message ("harness integrity check
 * failed: ..."); prose in a code block ("the harness owns ...") is not one either.
 */
export function mentionsIn(code: string): Array<{ command: string; flags: string[]; invoked: boolean }> {
  const out: Array<{ command: string; flags: string[]; invoked: boolean }> = [];
  const re = /(^|[\s(&|;$>])((?:\.\/bin\/|bin[\\/])?harness(?:\.cmd)?)\s+([a-z][a-z-]*)([^\n]*)/g;
  for (const m of code.matchAll(re)) {
    const before = code.slice(0, (m.index ?? 0) + m[1].length).trimEnd();
    const invoked = (before === '' || /[|;&($>]$/.test(before)) && !/:\s/.test(m[4]);
    let rest = m[4].replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
    rest = rest.split(/\s#|\s\|\s|;|&&|\|\|/)[0];
    const flags = [...rest.matchAll(/(?:^|\s|\[)--([a-z0-9][a-z0-9-]*)/g)].map((x) => x[1]);
    out.push({ command: m[3], flags, invoked });
  }
  return out;
}

function usageFlags(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, mod] of COMMANDS) {
    const usage = name === 'help' ? HELP_USAGE : (require(`../../../src/commands/${mod}`) as CommandModule).meta.usage;
    out.set(name, new Set([...usage.matchAll(/--([a-z0-9][a-z0-9-]*)/g)].map((x) => x[1])));
  }
  return out;
}

test('every harness command written in the docs exists, with flags its usage names', (t) => {
  const flagsOf = usageFlags();
  const problems: string[] = [];
  let count = 0;
  for (const file of docFiles()) {
    const rel = path.relative(packageRoot(), file).split(path.sep).join('/');
    for (const { line, code } of codeOf(fs.readFileSync(file, 'utf8'))) {
      for (const m of mentionsIn(code)) {
        count++;
        const known = flagsOf.get(m.command);
        if (!known) {
          if (!m.invoked) continue; // prose such as "the harness owns ..."
          problems.push(`${rel}:${line}: harness ${m.command} is not a command (${code.trim().slice(0, 80)})`);
          continue;
        }
        for (const f of m.flags) {
          if (f === 'help' || known.has(f) || known.has(`no-${f}`)) continue;
          problems.push(`${rel}:${line}: harness ${m.command} has no --${f} (${code.trim().slice(0, 80)})`);
        }
      }
    }
  }
  t.diagnostic(`${count} mentions checked in ${docFiles().length} files`);
  assert.ok(count > 50, `the docs mention harness commands (${count} found)`);
  assert.deepEqual(problems, []);
});

test('the mention reader: code spans, fenced blocks, quotes, comments and pipes', () => {
  assert.deepEqual(codeOf('run `harness gate --json` now\n```sh\nharness status\n```\n'), [{ line: 1, code: 'harness gate --json' }, { line: 3, code: 'harness status' }]);
  assert.deepEqual(mentionsIn('harness run check-stop --command "git push --force"'), [{ command: 'run', flags: ['command'], invoked: true }]);
  assert.deepEqual(mentionsIn('harness report --md   # --json also works'), [{ command: 'report', flags: ['md'], invoked: true }]);
  assert.deepEqual(mentionsIn('pbpaste | harness intake --from -'), [{ command: 'intake', flags: ['from'], invoked: true }]);
  assert.deepEqual(mentionsIn('harness db list | grep test --count'), [{ command: 'db', flags: [], invoked: true }]);
  assert.deepEqual(mentionsIn('cd ~/.harness && ls'), []);
  assert.deepEqual(mentionsIn('& "$HOME\\harness-tool\\bin\\harness.cmd" version'), []);
  assert.deepEqual(mentionsIn('bin\\harness.cmd doctor --json'), [{ command: 'doctor', flags: ['json'], invoked: true }]);
  assert.deepEqual(mentionsIn('files the harness owns (team)'), [{ command: 'owns', flags: [], invoked: false }]);
  assert.deepEqual(mentionsIn('$ harness status --json'), [{ command: 'status', flags: ['json'], invoked: true }]);
  assert.deepEqual(mentionsIn('harness integrity check failed: changed ...'), [{ command: 'integrity', flags: [], invoked: false }]);
});
