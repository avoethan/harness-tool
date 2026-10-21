/**
 * docs/COMMANDS.md and the CLI agree:
 *   - every command in the table is registered in the CLI, and every registered command is in the table;
 *   - each row's subcommands are the subcommands the command's usage names, both ways;
 *   - each row's flags are the flags the command's usage names, both ways.
 * The usage strings are the commands' own `meta.usage` (what `harness help <command>` prints).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMMANDS, HELP_USAGE, type CommandModule } from '../../../src/cli';
import { packageRoot } from '../../../src/lib/paths';

interface Row {
  command: string;
  subcommands: string[];
  flags: string[];
}

function docRows(): Row[] {
  const text = fs.readFileSync(path.join(packageRoot(), 'docs', 'COMMANDS.md'), 'utf8');
  const start = text.indexOf('\n## Commands\n');
  assert.ok(start >= 0, 'COMMANDS.md has a "## Commands" section');
  const section = text.slice(start).split('\n## ')[1];
  const rows: Row[] = [];
  for (const line of section.split('\n')) {
    const m = /^\| `harness ([a-z][a-z-]*)` \|([^|]*)\|([^|]*)\|/.exec(line);
    if (!m) continue;
    rows.push({ command: m[1], subcommands: words(codeSpans(m[2])), flags: flagsIn(m[3]) });
  }
  return rows;
}

function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]*)`/g)].map((x) => x[1]);
}

/** Subcommand words from code spans: `map build`/`drift` -> map, build, drift. */
function words(spans: string[]): string[] {
  const out = new Set<string>();
  for (const s of spans) for (const w of s.replace(/<[^>]*>/g, ' ').split(/[\s|/]+/)) if (/^[a-z][a-z-]*$/.test(w)) out.add(w);
  return [...out].sort();
}

function flagsIn(s: string): string[] {
  return [...new Set([...s.matchAll(/--([a-z0-9][a-z0-9-]*)/g)].map((x) => x[1]))].sort();
}

function usageOf(name: string, mod: string): string {
  if (name === 'help') return HELP_USAGE;
  const m = require(`../../../src/commands/${mod}`) as CommandModule;
  return m.meta.usage;
}

/**
 * The subcommands a usage string names: words in the required part of the usage
 * (optional groups, placeholders, quoted text and notes removed) that are not the
 * value of the flag before them.
 */
function usageSubcommands(name: string, usage: string): string[] {
  let s = usage.replace(/"[^"]*"/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/<[^>]*>/g, ' ');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\[[^[\]]*\]/g, ' ');
  }
  const toks = s.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--') || t === '|' || t === '...') continue;
    if (i > 0 && toks[i - 1].startsWith('--')) continue; // a flag's value, like team|personal
    for (const w of t.split('|')) if (/^[a-z][a-z-]*$/.test(w) && w !== 'harness' && w !== name) out.add(w);
  }
  return [...out].sort();
}

test('every command in COMMANDS.md is registered in the CLI, and every CLI command is in COMMANDS.md', () => {
  const documented = docRows().map((r) => r.command);
  const registered = COMMANDS.map(([n]) => n);
  assert.equal(new Set(documented).size, documented.length, 'no command is listed twice');
  const missingFromCli = documented.filter((c) => !registered.includes(c));
  const missingFromDoc = registered.filter((c) => !documented.includes(c));
  assert.deepEqual(missingFromCli, [], `documented but not in the CLI registry: ${missingFromCli.join(', ')}`);
  assert.deepEqual(missingFromDoc, [], `in the CLI registry but not in docs/COMMANDS.md: ${missingFromDoc.join(', ')}`);
});

test('each command row names the subcommands its usage names, both ways', () => {
  const rows = new Map(docRows().map((r) => [r.command, r]));
  const problems: string[] = [];
  for (const [name, mod] of COMMANDS) {
    const row = rows.get(name);
    if (!row) continue; // reported by the registry test
    const usage = usageOf(name, mod);
    const fromUsage = usageSubcommands(name, usage);
    for (const s of fromUsage) if (!row.subcommands.includes(s)) problems.push(`harness ${name}: usage names subcommand '${s}', COMMANDS.md does not`);
    for (const s of row.subcommands) if (!new RegExp(`(^|[\\s|\\[])${s}([\\s|\\]]|$)`).test(usage)) problems.push(`harness ${name}: COMMANDS.md names subcommand '${s}', the usage does not`);
  }
  assert.deepEqual(problems, []);
});

test('each command row names exactly the flags its usage names', () => {
  const rows = new Map(docRows().map((r) => [r.command, r]));
  const problems: string[] = [];
  for (const [name, mod] of COMMANDS) {
    const row = rows.get(name);
    if (!row) continue;
    const usage = flagsIn(usageOf(name, mod));
    for (const f of usage) if (!row.flags.includes(f)) problems.push(`harness ${name}: usage names --${f}, COMMANDS.md does not`);
    for (const f of row.flags) if (!usage.includes(f)) problems.push(`harness ${name}: COMMANDS.md names --${f}, the usage does not`);
  }
  assert.deepEqual(problems, []);
});

test('the subcommand extraction reads usage strings the way they are written', () => {
  assert.deepEqual(usageSubcommands('db', 'harness db list | mark --server <host[,port]> [--database <name>] --test|--not-test | unmark --server <host> | candidates  [--json]'), ['candidates', 'list', 'mark', 'unmark']);
  assert.deepEqual(usageSubcommands('install', 'harness install --setting team|personal [--agents a,b] | --uninstall [--yes]'), []);
  assert.deepEqual(usageSubcommands('selfcheck', 'harness selfcheck [list] | probe-mode --agent devin --stop off|block|slow | probe-hook <Event> --agent <agent> (internal: run by the hooks)'), ['probe-hook', 'probe-mode']);
  assert.deepEqual(usageSubcommands('verify', 'harness verify map build|drift|show [--json]\nharness verify env [--powershell|--cmd]'), ['build', 'drift', 'env', 'map', 'show']);
  assert.deepEqual(words(['map build', 'drift', '<command>']), ['build', 'drift', 'map']);
});
