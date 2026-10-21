/**
 * `harness phase` — enter the implement or tests phase for the current task.
 *
 *   harness phase implement [--task <id>] [--repo <path>] [--session <id>] [--json]
 *   harness phase tests     [--task <id>] [--repo <path>] [--session <id>] [--json]
 *   harness phase status    [--task <id>] [--repo <path>] [--json]
 *
 * The task is `--task`, else the repo's current task (set by intake or
 * `task claim`). The phase is written to the task's run folder
 * (runs/<repoId>/<taskId>/phase.json, with timestamps and a count of
 * tests-phase entries) and, when a session id is known (`--session` or the
 * HARNESS_SESSION_ID environment variable), to that session's state, which
 * is where the guard looks first.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, flagValues, parseArgv } from '../lib/argv';
import { repoIdFor } from '../lib/config';
import { nearestRepoRoot, rawGit } from '../lib/git';
import { instrument } from '../lib/log';
import { setPhase } from '../lib/session';
import { getCurrentTask, loadBrief, runDir, validId } from '../intake/brief';
import { addExpectChange, readPhaseRecord, setTaskPhase, type TaskPhase } from '../intake/phase';
import { chooseBase, EMPTY_TREE, isTestFile } from '../gate/context';
import { readJsonOr } from '../lib/fsx';

export const meta: CommandMeta = {
  name: 'phase',
  summary: 'Enter the implement or tests phase for the current task',
  usage: 'harness phase implement|tests|status [--task <id>] [--repo <path>] [--session <id>] [--expect-change "<file> <reason>"] [--json]',
  examples: ['harness phase tests', 'harness phase tests --expect-change "test/orders.test.ts totals now include tax"', 'harness phase implement', 'harness phase status --json'],
};

const EXPLAIN: Record<TaskPhase, string> = {
  tests: 'You may add or change test files now. Each entry is counted and shown in the write-up; the gate still checks for deleted or weakened tests.',
  implement: 'Change product code now. Test and golden files are read-only in this phase; run `harness phase tests` to change them.',
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv);
  const sub = p.positional[0];
  const json = flagBool(p, 'json');
  if (sub !== 'implement' && sub !== 'tests' && sub !== 'status') {
    process.stderr.write(`usage: ${meta.usage}\n`);
    return 2;
  }
  const repoFlag = flagStr(p, 'repo');
  const root = repoFlag ? path.resolve(repoFlag) : nearestRepoRoot(process.cwd());
  if (!root) {
    process.stderr.write('Not inside a git repository. Run from the repo, or pass --repo <path>.\n');
    return 2;
  }
  const repoId = repoIdFor(root);
  const task = flagStr(p, 'task') ?? getCurrentTask(repoId);
  if (!task) {
    process.stderr.write('No current task for this repo. Run `harness intake --from <file|->` (team) or `harness task claim <id>` (personal), or pass --task <id>.\n');
    return 1;
  }
  if (!validId(task)) {
    process.stderr.write('--task takes a task id such as t-1a2b3c4d5e or T-007.\n');
    return 2;
  }

  if (sub === 'status') {
    const rec = readPhaseRecord(repoId, task);
    if (json) process.stdout.write(JSON.stringify(rec ?? { task, repo: repoId, phase: null }, null, 2) + '\n');
    else if (!rec) process.stdout.write(`Task ${task}: no phase recorded yet. Start with \`harness phase tests\` to write the failing checks.\n`);
    else process.stdout.write(`Task ${task}: ${rec.phase} since ${rec.since}; tests phase entered ${rec.testsEntries} time(s).\n`);
    return 0;
  }

  const declared: Array<{ file: string; reason: string }> = [];
  for (const raw of flagValues(p, 'expect-change')) {
    if (sub !== 'tests') {
      process.stderr.write('--expect-change goes with `harness phase tests`: you declare an expectation change while you are changing tests.\n');
      return 2;
    }
    const v = validateExpectChange(root, repoId, task, raw);
    if (typeof v === 'string') {
      process.stderr.write(v + '\n');
      return 2;
    }
    declared.push(v);
  }

  const sessionId = flagStr(p, 'session') ?? process.env.HARNESS_SESSION_ID ?? undefined;
  let rec = setTaskPhase(repoId, task, sub, { ...(sessionId ? { sessionId } : {}) });
  for (const d of declared) rec = addExpectChange(repoId, task, d);
  if (sessionId) setPhase(sessionId, sub);
  instrument({ event: 'phase.set', task, repo: repoId, ...(sessionId ? { sessionId } : {}), ids: { phase: sub }, counts: { testsEntries: rec.testsEntries } });
  if (json) process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  else {
    process.stdout.write(`Task ${task}: phase ${sub}${sub === 'tests' ? ` (entry ${rec.testsEntries})` : ''}.${sessionId ? '' : ' (No session id given: recorded for the task only.)'}\n`);
    process.stdout.write(EXPLAIN[sub] + '\n');
    for (const d of declared) process.stdout.write(`Declared: the expectations in ${d.file} change (${d.reason}). The write-up will list it.\n`);
  }
  return 0;
}

/**
 * `--expect-change "<file> <reason>"`: the file is a test file that exists at the task's base commit and the
 * reason says why its expectation changes. Returns the entry or a message.
 */
function validateExpectChange(root: string, repoId: string, task: string, raw: string): { file: string; reason: string } | string {
  const m = /^(\S+)\s+(\S[\s\S]*)$/.exec(raw.trim());
  if (!m) return '--expect-change takes "<file> <reason>": the test file, then why its expectation changes (for example "test/orders.test.ts totals now include tax").';
  let file = m[1].replace(/\\/g, '/');
  if (path.isAbsolute(file)) file = path.relative(root, file).split(path.sep).join('/');
  file = path.posix.normalize(file).replace(/^\.\//, '');
  if (!file || file.startsWith('../') || file === '..') return `--expect-change: ${m[1]} is not inside this repository; give the path relative to the repo root.`;
  if (!isTestFile(file)) return `--expect-change: ${file} is not a test file, so there is no expectation to change in it.`;
  const brief = loadBrief(task);
  const prev = readJsonOr<{ baseSha?: string } | null>(path.join(runDir(repoId, task), 'evidence.json'), null);
  const { base } = chooseBase(root, 'task', { brief, repoId, previousBase: prev?.baseSha });
  if (base === EMPTY_TREE || rawGit(root, ['cat-file', '-e', `${base}:${file}`], 10_000).code !== 0) {
    return `--expect-change: ${file} does not exist at the base commit (${base === EMPTY_TREE ? 'none yet' : base.slice(0, 10)}). It is a new test file, which needs no declaration.`;
  }
  return { file, reason: m[2].trim().slice(0, 300) };
}
