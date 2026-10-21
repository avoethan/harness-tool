/**
 * `harness writeup` — the end-of-work write-up.
 *
 *   harness writeup [--task <id>] [--repo <path>] [--out <file>] [--json]
 *
 * The task is `--task`, else the current task of the repo (`--repo` or the
 * git root of the working directory). One write-up per touched repo (a repo
 * with changes against the base commit or an evidence file; all mapped repos
 * when none is touched yet), each written to
 * runs/<repoId>/<taskId>/writeup.md and printed. `--out` also writes the
 * combined text to a file; in the team setting that file may not be inside a
 * team repo (exit 4).
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { repoIdFor, resolveConfig } from '../lib/config';
import { writeTextAtomic } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { instrument } from '../lib/log';
import { subPath } from '../lib/paths';
import { getCurrentTask, loadBrief, validId } from '../intake/brief';
import { verificationRows } from '../intake/writeup';
import { pickTouched, writeAll } from '../intake/writeups';

export const meta: CommandMeta = {
  name: 'writeup',
  summary: 'Produce the PR write-up from the brief and evidence',
  usage: 'harness writeup [--task <id>] [--repo <path>] [--out <file>] [--json]',
  examples: ['harness writeup', 'harness writeup --task t-1a2b3c4d5e --out /tmp/pr.md'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv);
  const json = flagBool(p, 'json');
  const repoFlag = flagStr(p, 'repo');
  const root = repoFlag ? path.resolve(repoFlag) : nearestRepoRoot(process.cwd());
  const taskId = flagStr(p, 'task') ?? (root ? getCurrentTask(repoIdFor(root)) : null);
  if (!taskId) {
    process.stderr.write('No current task. Pass --task <id>, or run from the repo after `harness intake` / `harness task claim`.\n');
    return 1;
  }
  if (!validId(taskId)) {
    process.stderr.write('--task takes a task id such as t-1a2b3c4d5e or T-007.\n');
    return 2;
  }
  const brief = loadBrief(taskId);
  if (!brief) {
    process.stderr.write(`No brief for task ${taskId}. List briefs with: harness intake list\n`);
    return 1;
  }
  const resolved = resolveConfig(root ?? process.cwd());
  const setting = resolved.config.setting;

  const { cands, touched } = pickTouched(brief, root);

  const outFile = flagStr(p, 'out');
  if (outFile && setting === 'team') {
    const abs = path.resolve(outFile);
    const repoPaths = [...resolved.config.repos.map((r) => r.path), ...cands.map((c) => c.path).filter((x): x is string => !!x)];
    const inside = repoPaths.find((rp) => subPath(rp, abs));
    if (inside) {
      process.stderr.write(`Refused: ${outFile} is inside a team repository; the harness never writes there. Choose a path outside the repo (or omit --out; the write-up is saved under the harness home).\n`);
      return 4;
    }
  }

  const texts = writeAll(brief, setting, touched);
  const combined = texts.map((t) => t.text).join('\n---\n\n');
  if (outFile) writeTextAtomic(path.resolve(outFile), combined);

  let pass = 0;
  let notRun = 0;
  let rows = 0;
  const jsonOut = texts.map((t) => {
    const ids = brief.units.filter((u) => u.repo === t.work.repoId).flatMap((u) => u.criteria);
    const r = verificationRows(brief, ids.length ? ids : brief.criteria.map((c) => c.id), t.work);
    rows += r.length;
    pass += r.filter((x) => x.result.startsWith('PASS')).length;
    notRun += r.filter((x) => x.result === 'gate not run').length;
    return { repo: t.work.repoId, name: t.work.name, file: t.file, verdict: t.work.evidence?.verdict ?? null, rows: r };
  });
  instrument({ event: 'writeup.render', task: brief.id, ids: { brief: brief.id }, counts: { repos: texts.length, criteria: brief.criteria.length, rows, pass, gateNotRun: notRun, openQuestions: brief.questionDetails.length + brief.queued.length } });

  if (json) process.stdout.write(JSON.stringify({ task: brief.id, setting, writeups: jsonOut, out: outFile ? path.resolve(outFile) : null }, null, 2) + '\n');
  else {
    texts.forEach((t, i) => {
      if (texts.length > 1) process.stdout.write(`===== write-up ${i + 1} of ${texts.length}: ${t.work.name} =====\n`);
      process.stdout.write(t.text);
      if (t.file) process.stdout.write(`\n(saved: ${t.file})\n`);
      if (i < texts.length - 1) process.stdout.write('\n');
    });
    if (outFile) process.stdout.write(`(combined text written to ${path.resolve(outFile)})\n`);
  }
  return 0;
}
