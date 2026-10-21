/**
 * `harness digest [--task <id>] [--repo <path>] [--json]`
 *
 * One page per ticket, from the task's run folder(s) and the instrumentation
 * log: criteria and checks by kind, gate attempts and the final verdict, the
 * BLOCKED reason, prove-red results, live artefacts fresh or stale, tool
 * calls the hooks denied (by rail), tests-phase entries and declared
 * expectation changes, sessions and turns, cost when the runner recorded it,
 * the landing and pull request records, and the time from the first to the
 * last event. Names and counts only: the ticket's title is the one piece of
 * ticket text, and the whole page goes through secret redaction. The page is
 * printed and saved as `digest.md` beside the write-up
 * (`runs/<repoId>/<taskId>/digest.md`).
 *
 * The task is `--task`, else the current task of the repo (`--repo` or the
 * git root of the working directory).
 *
 * Exit 0 ok; 1 no such task; 2 usage.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { repoIdFor } from '../lib/config';
import { writeTextAtomic } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { instrument } from '../lib/log';
import { runsDir } from '../lib/paths';
import { redactText } from '../lib/redact';
import { getCurrentTask, validId } from '../intake/brief';
import { collectState } from '../report/collect';
import { indexTasks } from '../report/build';
import { buildDigest, renderDigest } from '../report/digest';

export const meta: CommandMeta = {
  name: 'digest',
  summary: 'One page per ticket: gate, rails, tests phase, sessions, cost, landing and pull request (names and counts only)',
  usage: 'harness digest [--task <id>] [--repo <path>] [--json]',
  examples: ['harness digest', 'harness digest --task t-1a2b3c4d5e --json'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['json', 'help', 'h']));
  if (p.positional.length) {
    process.stderr.write(`digest: unexpected argument ${JSON.stringify(p.positional[0].slice(0, 40))}\nUsage: ${meta.usage}\n`);
    return 2;
  }
  const repoFlag = flagStr(p, 'repo');
  const root = repoFlag ? path.resolve(repoFlag) : nearestRepoRoot(process.cwd());
  const repoId = root ? repoIdFor(root) : null;
  const taskId = flagStr(p, 'task') ?? (repoId ? getCurrentTask(repoId) : null);
  if (!taskId) {
    process.stderr.write('No current task. Pass --task <id>, or run from the repo after `harness intake` / `harness task claim`.\n');
    return 1;
  }
  if (!validId(taskId)) {
    process.stderr.write('--task takes a task id such as t-1a2b3c4d5e or T-007.\n');
    return 2;
  }
  const st = collectState();
  const idx = indexTasks(st);
  const acc = idx.tasks.find((t) => t.id === taskId);
  if (!acc) {
    process.stderr.write(`No task ${taskId} in the harness state. List briefs with: harness intake list\n`);
    return 1;
  }
  const digest = buildDigest(acc, idx.events);
  const text = renderDigest(digest);

  // Beside the write-up: the run folder of the repo we are in if it has one, else the first with a write-up, else the first.
  const folders = acc.runs;
  const own = folders.find((r) => r.repo === repoId);
  const target = own ?? folders.find((r) => r.writeup) ?? folders[0];
  let saved: string | null = null;
  if (target) {
    saved = path.join(runsDir(), target.repo, target.task, 'digest.md');
    try {
      writeTextAtomic(saved, text);
    } catch {
      saved = null;
    }
  }
  instrument({ event: 'digest', task: taskId, counts: { repos: digest.repos.length, saved: saved ? 1 : 0 } });

  if (flagBool(p, 'json')) process.stdout.write(redactText(JSON.stringify(digest, null, 2)) + '\n');
  else {
    process.stdout.write(text);
    process.stdout.write(saved ? `\nSaved ${saved}\n` : '\nNo run folder yet, so the digest was not saved. Run `harness gate`, then run this again.\n');
  }
  return 0;
}
