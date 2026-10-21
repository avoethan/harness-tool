/**
 * `harness report [--since <date>] [--json|--md] [--out <file>] [--worklog <file>] [--workspace <dir>]`
 * `harness report --check-scrub [--since <date>] [--workspace <dir>]`
 * `harness report row --task <id|ticket hash> [--header] [--append] [--worklog <file>]`
 *
 * The code-free summary report: counts only, from the files under
 * ~/.harness (DESIGN 2.11, EVAL-PLAN 9). Before anything is printed or
 * written, the report is scrubbed against a token set built from the
 * workspace (repo names, path segments, identifiers, brief words); a report
 * that fails is refused and the leaking field is named (field name only).
 *
 * `row` prints one row of the user's work log with what the harness
 * measured; `--append` adds it to ~/.harness/worklog.csv (the header is
 * written when the file is new) for the user to complete.
 *
 * Exit 0 ok; 1 the scrub failed or the task was not found; 2 usage;
 * 4 refused: --out inside a team repository.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { harnessVersion } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { readTextOr, writeTextAtomic } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { instrument } from '../lib/log';
import { userHome } from '../lib/paths';
import { collectState } from '../report/collect';
import { parseSince } from '../report/build';
import { formatTokenStats } from '../report/scrub';
import { findTask, makeReport, worklogRowFor } from '../report/index';
import { worklogPath, readWorklog } from '../report/worklog';

export const meta: CommandMeta = {
  name: 'report',
  summary: 'Write the code-free summary report (counts only), check it against the workspace, or print a work-log row',
  usage:
    'harness report [--since <date>] [--json|--md] [--out <file>] [--worklog <file>] [--workspace <dir>] | --check-scrub [--workspace <dir>] | row --task <id|ticket hash> [--header] [--append]',
  examples: ['harness report --md', 'harness report --since 2026-10-01 --json --out ~/harness-report.json', 'harness report --check-scrub', 'harness report row --task t-1a2b3c4d5e --append'],
};

const BOOLEANS = new Set(['json', 'md', 'check-scrub', 'header', 'append', 'help', 'h']);

function usage(msg: string): number {
  process.stderr.write(`report: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(userHome(), p.slice(2));
  return p;
}

function rowCommand(a: ReturnType<typeof parseArgv>): number {
  const ref = flagStr(a, 'task');
  if (!ref) return usage('row needs --task <id|ticket hash>');
  const worklog = flagStr(a, 'worklog');
  const st = collectState({ worklog: worklog ? expandHome(worklog) : undefined });
  const id = findTask(st, ref);
  if (!id) {
    process.stderr.write(`report: no task ${JSON.stringify(ref.slice(0, 80))} in the harness state (use a task id from \`harness intake list\` or a ticket hash prefix of 8+ characters)\n`);
    return 1;
  }
  const r = worklogRowFor(st, id, harnessVersion());
  if (!r) return 1;
  if (flagBool(a, 'append')) {
    const file = worklog ? expandHome(worklog) : worklogPath();
    const existing = readTextOr(file, null);
    const log = readWorklog(file);
    if (log?.rows.some((x) => r.ticketHash.startsWith(x.ticketHash))) {
      process.stderr.write(`report: the work log already has a row for this ticket; edit it there (${file})\n`);
      return 1;
    }
    const base = existing === null || !existing.trim() ? r.header + '\n' : existing.endsWith('\n') ? existing : existing + '\n';
    writeTextAtomic(file, base + r.row + '\n');
    instrument({ event: 'report.row', counts: { appended: 1 } });
    process.stdout.write(`Added a row to ${file}. Fill in acus, time_to_pr_min, pr_rework_rounds, review_findings_by_family, size_estimate and outcome (merged, abandoned or reverted).\n`);
    return 0;
  }
  if (flagBool(a, 'header')) process.stdout.write(r.header + '\n');
  process.stdout.write(r.row + '\n');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, BOOLEANS);
  const sub = a.positional[0];
  if (sub === 'row') return rowCommand(a);
  if (sub) return usage(`unknown subcommand ${JSON.stringify(sub.slice(0, 40))}`);
  if (flagBool(a, 'json') && flagBool(a, 'md')) return usage('choose one of --json and --md');
  const since = parseSince(flagStr(a, 'since'));
  if (since === null) return usage('--since takes a date such as 2026-10-01');
  const worklog = flagStr(a, 'worklog');
  const workspace = flagStr(a, 'workspace');
  const run = makeReport({
    since,
    worklog: worklog ? expandHome(worklog) : undefined,
    workspace: workspace ? path.resolve(expandHome(workspace)) : undefined,
    harnessVersion: harnessVersion(),
  });
  const stats = formatTokenStats(run.tokens.stats);
  instrument({ event: 'report.scrub', counts: { tokens: run.tokens.stats.checked, leaks: run.scrub.leaks.length, tasks: run.report.tasks.length } });

  if (flagBool(a, 'check-scrub')) {
    if (run.scrub.ok) {
      process.stdout.write(`scrub: ok. ${stats}; the report (JSON and Markdown) contains none of them.\n`);
      return 0;
    }
    process.stdout.write(`scrub: FAILED. ${stats}; workspace text found in: ${run.scrub.leaks.join(', ')}\n`);
    return 1;
  }
  if (!run.scrub.ok) {
    process.stderr.write(`report: refused. The report would carry workspace text in: ${run.scrub.leaks.join(', ')}. Nothing was written. (${stats})\n`);
    return 1;
  }
  const text = flagBool(a, 'json') ? JSON.stringify(run.report, null, 2) + '\n' : run.markdown;
  const out = flagStr(a, 'out');
  if (out) {
    const file = path.resolve(expandHome(out));
    const repo = nearestRepoRoot(path.dirname(file));
    const teamRepo = run.state.config?.setting === 'team' && repo !== null;
    if (teamRepo) {
      process.stderr.write(`report: refused: ${file} is inside a git repository, and in the team setting nothing of the harness is written inside a repository. Choose a path outside it (for example ~/harness-report.md).\n`);
      return 4;
    }
    writeTextAtomic(file, text);
    process.stdout.write(`Wrote ${file} (${run.report.tasks.length} task row(s); scrub ok, ${run.tokens.stats.checked} token(s) checked).\n`);
    return 0;
  }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  return 0;
}
