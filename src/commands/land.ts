/**
 * `harness land`: the personal setting's only landing path (DESIGN §2.8).
 * See src/land/README.md.
 *
 *   harness land [--task <id>] [--repo <path>] [--branch <name>] [--main <branch>]
 *                [--ci local|github|none] [--ci-command "<cmd>"] [--squash] [--dry-run] [--no-wait]
 *                [--wait-minutes <n>] [--fixer claude|codex|none] [--model <m>]
 *                [--ci-timeout-minutes <n>] [--json]
 *
 * Exit codes: 0 landed (CI green, skipped, green on the rerun, or fixed);
 * 1 refused, reverted, CI result unknown, or the push failed; 2 usage.
 */
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagStr, parseArgv } from '../lib/argv';
import { land, type CiKind } from '../land/land';
import { ciCommandArgv } from '../land/ci';
import { inProcessGate } from '../land/gaterun';
import { defaultSessionRunner, type SessionAgent } from '../runctl/session';

export const meta: CommandMeta = {
  name: 'land',
  summary: 'Personal setting: merge to main after PASS, watch CI, fix or revert',
  usage:
    'harness land [--task <id>] [--repo <path>] [--branch <name>] [--main <branch>] [--ci local|github|none] [--ci-command "<cmd>"] [--squash] [--dry-run] [--no-wait] [--wait-minutes <n>] [--fixer claude|codex|none] [--model <m>] [--ci-timeout-minutes <n>] [--json]',
  examples: ['harness land', 'harness land --task T-003 --ci local', 'harness land --dry-run', 'harness land --ci github --no-wait'],
};

const CI_KINDS = new Set(['local', 'github', 'none']);
const FIXERS = new Set(['claude', 'codex', 'none']);

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function usage(msg: string): number {
  process.stderr.write(`land: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set([...DEFAULT_BOOLEANS, 'squash', 'wait']));
  const json = p.flags.json === true;
  const ci = flagStr(p, 'ci') ?? 'local';
  if (!CI_KINDS.has(ci)) return usage('--ci takes local, github or none');
  const ciCmdRaw = flagStr(p, 'ci-command');
  const ciCommand = ciCmdRaw !== undefined ? ciCommandArgv(ciCmdRaw) : undefined;
  if (ciCommand === null) return usage('--ci-command takes one command without shell features (no pipes, redirects, `;`, `&&` or `$(...)`); put several steps in a script');
  if (ciCommand && ci !== 'local') return usage('--ci-command goes with --ci local');
  const fixer = flagStr(p, 'fixer');
  if (fixer !== undefined && !FIXERS.has(fixer)) return usage('--fixer takes claude, codex or none');
  const waitMin = num(flagStr(p, 'wait-minutes'));
  const ciMin = num(flagStr(p, 'ci-timeout-minutes'));
  if (Number.isNaN(waitMin) || Number.isNaN(ciMin)) return usage('--wait-minutes and --ci-timeout-minutes take a number of minutes');
  const say = json ? () => undefined : (l: string) => process.stdout.write(l + '\n');
  const r = await land(
    {
      ...(flagStr(p, 'repo') ? { repo: flagStr(p, 'repo') } : {}),
      ...(flagStr(p, 'task') ? { task: flagStr(p, 'task') } : {}),
      ...(flagStr(p, 'branch') ? { branch: flagStr(p, 'branch') } : {}),
      ...(flagStr(p, 'main') ? { main: flagStr(p, 'main') } : {}),
      ci: ci as CiKind,
      squash: p.flags.squash === true,
      dryRun: p.flags['dry-run'] === true,
      wait: p.flags.wait !== false,
      ...(waitMin !== undefined ? { waitMs: waitMin * 60_000 } : {}),
      ...(fixer ? { fixer: fixer as SessionAgent | 'none' } : {}),
      ...(flagStr(p, 'model') ? { model: flagStr(p, 'model') } : {}),
      ...(ciMin !== undefined ? { ciTimeoutMs: ciMin * 60_000 } : {}),
      ...(ciCommand ? { ciCommand } : {}),
    },
    { gate: inProcessGate(), session: defaultSessionRunner(), say },
  );
  if (json) process.stdout.write(JSON.stringify({ exitCode: r.exitCode, message: r.message, landing: r.record }, null, 2) + '\n');
  else if (r.exitCode === 2) process.stderr.write(`land: ${r.message}\nUsage: ${meta.usage}\n`);
  return r.exitCode;
}
