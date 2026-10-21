/**
 * `harness pr open [--task <id>] [--repo <path>] [--base <branch>] [--draft] [--dry-run] [--json]`
 *
 * Personal setting, run by the user only (the guard denies `harness pr` from every agent).
 * See src/pr/README.md.
 *
 * Exit codes: 0 opened, already open, or dry run; 1 refused or failed; 2 usage; 4 team setting.
 */
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagStr, parseArgv } from '../lib/argv';
import { instrument } from '../lib/log';
import { openPr } from '../pr/open';

export const meta: CommandMeta = {
  name: 'pr',
  summary: 'Personal setting: open the pull request for a pushed task branch (you run it)',
  usage: 'harness pr open [--task <id>] [--repo <path>] [--base <branch>] [--draft] [--dry-run] [--json]',
  examples: ['harness pr open', 'harness pr open --task T-003 --draft', 'harness pr open --dry-run'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set([...DEFAULT_BOOLEANS, 'draft']));
  if (p.positional[0] !== 'open') {
    process.stderr.write(`pr: ${p.positional[0] ? `unknown subcommand ${p.positional[0]}` : 'a subcommand is required'}\nUsage: ${meta.usage}\n`);
    return 2;
  }
  const json = p.flags.json === true;
  const r = await openPr({
    ...(flagStr(p, 'repo') ? { repo: flagStr(p, 'repo') } : {}),
    ...(flagStr(p, 'task') ? { task: flagStr(p, 'task') } : {}),
    ...(flagStr(p, 'base') ? { base: flagStr(p, 'base') } : {}),
    draft: p.flags.draft === true,
    dryRun: p.flags['dry-run'] === true,
  });
  instrument({ event: 'pr.open', ids: { outcome: r.exitCode === 0 ? (r.request ? 'dry-run' : r.record?.existing ? 'existing' : 'opened') : 'refused' }, counts: { exitCode: r.exitCode } });
  if (json) {
    process.stdout.write(JSON.stringify({ exitCode: r.exitCode, message: r.message, ...(r.request ? { dryRun: true, request: r.request } : {}), ...(r.record ? { pullRequest: r.record } : {}) }, null, 2) + '\n');
  } else if (r.exitCode === 0) {
    process.stdout.write(r.message + '\n');
    if (r.request) {
      const b = r.request.body;
      process.stdout.write(`${r.request.method} ${r.request.url}\n  title: ${b.title}\n  head:  ${b.head}\n  base:  ${b.base}\n  draft: ${b.draft}\n  body:  ${b.body.length} characters (the write-up)\n`);
    }
  } else {
    process.stderr.write(`pr: ${r.message}\n`);
    if (r.exitCode === 2) process.stderr.write(`Usage: ${meta.usage}\n`);
  }
  return r.exitCode;
}
