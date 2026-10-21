#!/usr/bin/env node
/**
 * CLI dispatcher. `harness <command> [subcommand] [flags]`.
 * Each command lives in ./commands/<name>.ts and exports:
 *   export const meta = { name, summary, usage, examples? }
 *   export async function main(argv: string[]): Promise<number>   // exit code
 * Commands are registered in COMMANDS below so `harness help` can list
 * what exists and what is not built yet without loading every module.
 */
import { parseArgv } from './lib/argv';
import { readJsonOr } from './lib/fsx';
import * as path from 'node:path';
import { packageRoot } from './lib/paths';

export interface CommandMeta {
  name: string;
  summary: string;
  usage: string;
  examples?: string[];
}

export interface CommandModule {
  meta: CommandMeta;
  main(argv: string[]): Promise<number>;
}

/** name -> module path (relative to ./commands). The order is the help order. */
export const COMMANDS: Array<[string, string, string]> = [
  ['version', 'version', 'Print the harness version'],
  ['help', 'help', 'Show this help, or help for one command'],
  ['doctor', 'doctor', 'Check the install, scanners, hooks, integrity and the test-database allowlist'],
  ['install', 'install', 'Discover, assess, mark databases, propose and apply the harness for a setting'],
  ['discover', 'discover', 'Work out the standards of a workspace with evidence (writes the ledger)'],
  ['assess', 'assess', 'Read the existing agent setup and classify every line'],
  ['propose', 'propose', 'Write a plan of changes with diffs and provenance'],
  ['apply', 'apply', 'Apply a plan with backup and a manifest'],
  ['undo', 'undo', 'Restore the files a plan changed'],
  ['uninstall', 'uninstall', 'Undo everything the manifest owns'],
  ['db', 'db', 'Mark databases as test / not-test (the safety allowlist)'],
  ['config', 'config', 'Read or change harness settings from an interactive terminal'],
  ['gate', 'gate', 'Run the done-gate and write evidence'],
  ['phase', 'phase', 'Enter the implement or tests phase for the current task'],
  ['verify', 'verify', 'End-to-end verification: launch, doctor, drive, evidence, cleanup, maintain'],
  ['intake', 'intake', 'Turn a pasted ticket into a brief with criteria, checks and units'],
  ['brief', 'brief', 'Show a brief (alias of intake show)'],
  ['task', 'task', 'Personal task ledger: next, claim, done, fail, list'],
  ['writeup', 'writeup', 'Produce the PR write-up from the brief and evidence'],
  ['land', 'land', 'Personal setting: merge to main after PASS, watch CI, fix or revert'],
  ['pr', 'pr', 'Personal setting: open the pull request for a pushed task branch (you run it)'],
  ['run', 'run', 'Personal setting: drive the task queue with headless sessions'],
  ['learn', 'learn', 'Learning loop: scan captured corrections, prove enforcers, review'],
  ['judgment', 'judgment', 'Hand a judgment result to the harness (the agent may not write the harness state itself)'],
  ['report', 'report', 'Write the code-free summary report'],
  ['status', 'status', 'Show where the install and the tasks stand, and the next thing to do'],
  ['selfcheck', 'selfcheck', 'Record the work-machine self-check results; write and remove its probe files'],
  ['reviews', 'reviews', 'Fetch past review comments read-only (optional)'],
  ['self-update', 'self-update', 'Replace pristine generated files from a newer harness'],
  ['hook', 'hook', 'Internal: run a hook event with JSON on stdin (used by the agents)'],
];

/** Usage of `help`, which is handled here rather than by a module in ./commands. */
export const HELP_USAGE = 'harness help [<command>]';

export function harnessVersion(): string {
  const pkg = readJsonOr<{ version?: string }>(path.join(packageRoot(), 'package.json'), {});
  return pkg.version ?? '0.0.0';
}

function printHelp(): void {
  process.stdout.write(`harness ${harnessVersion()} — configure a harness so coding agents follow a codebase's standards and prove their work.\n\n`);
  process.stdout.write('Usage: harness <command> [options]\n\nCommands:\n');
  for (const [name, mod, summary] of COMMANDS) {
    let built = name === 'help';
    if (!built) {
      try {
        require.resolve(`./commands/${mod}`);
        built = true;
      } catch {
        built = false;
      }
    }
    process.stdout.write(`  ${name.padEnd(13)} ${summary}${built ? '' : '   (not built yet)'}\n`);
  }
  process.stdout.write('\nRun `harness help <command>` for details.\n');
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(harnessVersion() + '\n');
    return 0;
  }
  if (cmd === 'help') {
    const target = rest[0];
    if (!target) {
      printHelp();
      return 0;
    }
    const entry = COMMANDS.find(([n]) => n === target);
    if (!entry) {
      process.stderr.write(`unknown command: ${target}\n`);
      return 2;
    }
    if (entry[0] === 'help') {
      // help has no module of its own; describe it here instead of calling it "not built yet"
      process.stdout.write(`help — ${entry[2]}\n\nUsage: ${HELP_USAGE}\n  harness help\n  harness help gate\n`);
      return 0;
    }
    try {
      const m = require(`./commands/${entry[1]}`) as CommandModule;
      process.stdout.write(`${m.meta.name} — ${m.meta.summary}\n\nUsage: ${m.meta.usage}\n`);
      for (const ex of m.meta.examples ?? []) process.stdout.write(`  ${ex}\n`);
    } catch {
      process.stdout.write(`${entry[0]} — ${entry[2]} (not built yet)\n`);
    }
    return 0;
  }
  const entry = COMMANDS.find(([n]) => n === cmd);
  if (!entry) {
    process.stderr.write(`unknown command: ${cmd}\nRun \`harness help\`.\n`);
    return 2;
  }
  let mod: CommandModule;
  try {
    mod = require(`./commands/${entry[1]}`) as CommandModule;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`commands/${entry[1]}`)) {
      process.stderr.write(`${cmd}: not built yet\n`);
      return 3;
    }
    throw e;
  }
  const parsed = parseArgv(rest);
  if (parsed.flags.help === true || parsed.flags.h === true) {
    process.stdout.write(`${mod.meta.name} — ${mod.meta.summary}\n\nUsage: ${mod.meta.usage}\n`);
    for (const ex of mod.meta.examples ?? []) process.stdout.write(`  ${ex}\n`);
    return 0;
  }
  return mod.main(rest);
}

if (require.main === module) {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
  });
  main(process.argv.slice(2)).then(
    // exit only after stdout has flushed: a pipe takes large output asynchronously, and exit() would cut it
    (code) => process.stdout.write('', () => process.exit(code)),
    (e) => {
      process.stderr.write(`error: ${(e as Error).stack ?? String(e)}\n`);
      process.exit(1);
    },
  );
}
