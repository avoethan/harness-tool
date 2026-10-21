/**
 * `harness run`: run control in the personal setting (DESIGN §2.13).
 * See src/runctl/README.md.
 *
 *   harness run [--agent claude|codex] [--once] [--max-tasks <n>] [--ci local|github|none] [--ci-command "<cmd>"]
 *               [--model <m>] [--turns <n>] [--unit-minutes <n>] [--ticket-minutes <n>]
 *               [--budget-usd <x>] [--attempts <n>] [--permission-mode <mode>]
 *               [--stale-minutes <n>] [--no-land] [--repo <path>] [--json]
 *   harness run pause  [--task <id>] [--repo <path>] [--json]
 *   harness run resume [--task <id>] [--agent claude|codex] [--ci ...] [caps flags] [--json]
 *   harness run check-stop [--task <id>] [--repo <path>] [--command "<cmd>"]
 *               [--irreversible "<what>"] [--not-reproduced "<what>"] [--session <id>] [--json]
 *
 * Cap flags only lower the configured caps. Exit codes: run/resume 0 when
 * every task landed (or the queue was empty), 1 otherwise; pause 0; check-stop
 * 0 when no stop-the-line condition holds, 1 when one does; 2 usage.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagStr, parseArgv, type Parsed } from '../lib/argv';
import { repoIdFor } from '../lib/config';
import { readJsonOr } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { instrument } from '../lib/log';
import { runsDir } from '../lib/paths';
import { getCurrentTask, loadBrief } from '../intake/brief';
import { readLedger } from '../intake/ledger';
import { inProcessGate } from '../land/gaterun';
import { gitOk, mainBranchName, mainWorktreeRoot } from '../land/gitops';
import type { CiKind } from '../land/land';
import { ciCommandArgv } from '../land/ci';
import { allowedPathsFor, checkStop, type RunCaps } from '../runctl/caps';
import { runQueue, type RunOptions } from '../runctl/run';
import { locateTask, pauseTask, resumeTask } from '../runctl/pause';
import { defaultSessionRunner, type SessionAgent } from '../runctl/session';

export const meta: CommandMeta = {
  name: 'run',
  summary: 'Personal setting: drive the task queue with headless sessions',
  usage:
    'harness run [--agent claude|codex] [--once] [--max-tasks <n>] [--ci local|github|none] [--ci-command "<cmd>"] [--model <m>] [--permission-mode <mode>] [--turns <n>] [--unit-minutes <n>] [--ticket-minutes <n>] [--budget-usd <x>] [--attempts <n>] [--stale-minutes <n>] [--main <branch>] [--repo <path>] [--no-land] [--json]\n       harness run pause [--task <id>] [--note "<text>"] | resume [--task <id>] | check-stop [--task <id>] [--command "<cmd>"] [--irreversible "<what>"] [--not-reproduced "<what>"] [--session <id>] [--json]',
  examples: ['harness run --once --agent claude', 'harness run --agent codex --max-tasks 3 --ci local', 'harness run pause', 'harness run resume --task T-004', 'harness run check-stop --command "git push --force"'],
};

const BOOLS = new Set([...DEFAULT_BOOLEANS, 'once', 'land']);

function usage(msg: string): number {
  process.stderr.write(`run: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

function numFlag(p: Parsed, k: string): number | undefined | null {
  const v = flagStr(p, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function capsFlags(p: Parsed): Partial<RunCaps> | string {
  const out: Partial<RunCaps> = {};
  const map: Array<[string, keyof RunCaps]> = [
    ['turns', 'turns'],
    ['unit-minutes', 'unitMinutes'],
    ['ticket-minutes', 'ticketMinutes'],
    ['budget-usd', 'budgetUsd'],
    ['gate-attempts', 'gateAttempts'],
    ['attempts', 'codexAttempts'],
  ];
  for (const [flag, key] of map) {
    const n = numFlag(p, flag);
    if (n === null) return `--${flag} takes a positive number`;
    if (n !== undefined) (out as Record<string, number>)[key] = n;
  }
  return out;
}

function agentFlag(p: Parsed): SessionAgent | undefined | null {
  const a = flagStr(p, 'agent');
  if (a === undefined) return undefined;
  return a === 'claude' || a === 'codex' ? a : null;
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, BOOLS);
  const sub = p.positional[0];
  const json = p.flags.json === true;
  const say = json ? () => undefined : (l: string) => process.stdout.write(l + '\n');
  const repo = flagStr(p, 'repo') ?? process.cwd();
  if (sub === 'check-stop') return checkStopCmd(p, repo, json);
  if (sub === 'pause') {
    const loc = locateTask(repo, flagStr(p, 'task'), flagStr(p, 'main'));
    if ('error' in loc) return usage(loc.error);
    if (!loc.worktree) {
      process.stderr.write(`run pause: ${loc.branch} is not checked out in any worktree; nothing to pause\n`);
      return 1;
    }
    const st = readJsonOr<{ agent?: SessionAgent } | null>(path.join(runsDir(), loc.repoId, loc.taskId, 'run.json'), null);
    const agent: SessionAgent = agentFlag(p) ?? st?.agent ?? (process.env.HARNESS_AGENT === 'codex' ? 'codex' : 'claude');
    const r = pauseTask({ mainRoot: loc.mainRoot, repoId: loc.repoId, taskId: loc.taskId, worktree: loc.worktree, branch: loc.branch, agent, ...(flagStr(p, 'note') ? { note: flagStr(p, 'note') } : {}) });
    if (json) process.stdout.write(JSON.stringify({ task: loc.taskId, worktree: loc.worktree, ...r }, null, 2) + '\n');
    else say(`Paused ${loc.taskId}: trail ${r.trail}\n${r.wip}\nResume with: harness run resume --task ${loc.taskId}`);
    return 0;
  }
  const agent = agentFlag(p);
  if (agent === null) return usage('--agent takes claude or codex');
  const ci = flagStr(p, 'ci') ?? 'local';
  if (!['local', 'github', 'none'].includes(ci)) return usage('--ci takes local, github or none');
  const ciCmdRaw = flagStr(p, 'ci-command');
  const ciCommand = ciCmdRaw !== undefined ? ciCommandArgv(ciCmdRaw) : undefined;
  if (ciCommand === null) return usage('--ci-command takes one command without shell features (no pipes, redirects, `;`, `&&` or `$(...)`); put several steps in a script');
  if (ciCommand && ci !== 'local') return usage('--ci-command goes with --ci local');
  const caps = capsFlags(p);
  if (typeof caps === 'string') return usage(caps);
  const maxTasks = numFlag(p, 'max-tasks');
  if (maxTasks === null) return usage('--max-tasks takes a positive number');
  const stale = numFlag(p, 'stale-minutes');
  if (stale === null) return usage('--stale-minutes takes a positive number');
  const opts: RunOptions = {
    repo,
    agent: agent ?? (process.env.HARNESS_AGENT === 'codex' ? 'codex' : 'claude'),
    once: p.flags.once === true,
    ...(maxTasks !== undefined ? { maxTasks } : {}),
    ci: ci as CiKind,
    ...(flagStr(p, 'main') ? { main: flagStr(p, 'main') } : {}),
    ...(flagStr(p, 'model') ? { model: flagStr(p, 'model') } : {}),
    ...(flagStr(p, 'permission-mode') ? { permissionMode: flagStr(p, 'permission-mode') } : {}),
    caps,
    ...(stale !== undefined ? { staleMinutes: stale } : {}),
    land: p.flags.land !== false,
    ...(ciCommand ? { ciCommand } : {}),
  };
  const deps = { session: defaultSessionRunner(), gate: inProcessGate(), say };
  if (sub === 'resume') {
    const r = await resumeTask({ ...opts, ...(agent ? { agent } : {}), ...(flagStr(p, 'task') ? { task: flagStr(p, 'task') } : {}) }, deps);
    if (!r.ok) {
      process.stderr.write(`run resume: ${r.error}\n`);
      return r.exitCode;
    }
    if (json) process.stdout.write(JSON.stringify(r.run, null, 2) + '\n');
    return r.run.outcome === 'landed' || r.run.outcome === 'passed' ? 0 : 1;
  }
  if (sub !== undefined) return usage(`unknown subcommand: ${sub}`);
  const report = await runQueue(opts, deps);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (report.exitCode === 2 || (!report.tasks.length && report.exitCode !== 0)) process.stderr.write(`run: ${report.stopped}\n`);
  return report.exitCode;
}

function checkStopCmd(p: Parsed, repo: string, json: boolean): number {
  const root = nearestRepoRoot(path.resolve(repo));
  if (!root) return usage(`${repo} is not inside a git repository`);
  const repoId = repoIdFor(root);
  let taskId = flagStr(p, 'task') ?? null;
  if (!taskId) {
    const br = gitOk(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
    const m = br ? /^task\/(.+)$/.exec(br) : null;
    taskId = m ? m[1] : getCurrentTask(repoId);
  }
  if (!taskId) return usage('no task: pass --task <id>, or run from the task worktree');
  const brief = loadBrief(taskId);
  const mainRoot = mainWorktreeRoot(root) ?? root;
  const ledgerTask = readLedger(mainRoot).tasks.find((t) => t.id === taskId);
  const ev = readJsonOr<{ baseSha?: string } | null>(path.join(runsDir(), repoId, taskId, 'evidence.json'), null);
  const mainBranch = mainBranchName(mainRoot, flagStr(p, 'main'));
  const base = ev?.baseSha ?? brief?.baseShas?.[repoId] ?? gitOk(root, ['merge-base', 'HEAD', mainBranch], 10_000);
  const reasons = checkStop({
    repoRoot: root,
    repoId,
    taskId,
    base,
    allowedPaths: allowedPathsFor(brief, ledgerTask?.paths ?? []),
    ...(flagStr(p, 'command') ? { command: flagStr(p, 'command') } : {}),
    ...(flagStr(p, 'irreversible') ? { irreversible: flagStr(p, 'irreversible') } : {}),
    ...(flagStr(p, 'not-reproduced') ? { notReproduced: flagStr(p, 'not-reproduced') } : {}),
    ...(flagStr(p, 'session') ?? process.env.HARNESS_SESSION_ID ? { sessionId: flagStr(p, 'session') ?? process.env.HARNESS_SESSION_ID } : {}),
    brief,
    title: ledgerTask?.title ?? brief?.title,
  });
  const counts: Record<string, number> = { stops: reasons.length };
  for (const r of reasons) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  instrument({ event: 'run.check-stop', repo: repoId, task: taskId, ids: { stop: reasons.length ? 'yes' : 'no' }, counts });
  if (json) {
    process.stdout.write(JSON.stringify({ task: taskId, stop: reasons.length > 0, reasons }, null, 2) + '\n');
    return reasons.length ? 1 : 0;
  }
  if (!reasons.length) {
    process.stdout.write(`No stop-the-line condition holds for ${taskId}; keep going.\n`);
    return 0;
  }
  process.stdout.write(`Stop the line for ${taskId}:\n`);
  for (const r of reasons) {
    process.stdout.write(`  STOP (${r.kind}): ${r.reason}\n`);
    for (const d of (r.detail ?? []).slice(0, 10)) process.stdout.write(`    - ${d}\n`);
  }
  process.stdout.write(`Report this to the user (not as a question) and record it:\n  harness gate --blocked "${reasons[0].reason.replace(/"/g, "'")}"\n`);
  return 1;
}
