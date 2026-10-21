/**
 * `harness apply --plan <id|path> [--dry-run] [--commit] [--json] [--yes]`
 *
 * Applies a plan written by `propose` (DESIGN §2.3): refuses on any drift,
 * backs up every touched file, writes atomically, unions settings, proves
 * git ignores every in-tree team path, writes the manifest, re-signs.
 * Exit 0 ok, 1 failure, 2 usage, 4 refused by a safety rail.
 */
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { askYesNo, isInteractive } from '../lib/prompt';
import { applyPlan } from '../lifecycle/apply';
import { formatApply, formatPlanSummary } from '../lifecycle/format';
import { loadPlanRef } from '../lifecycle/plans';

export const meta: CommandMeta = {
  name: 'apply',
  summary: 'Apply a plan with backup and a manifest',
  usage: 'harness apply [--plan <id|path>] [--dry-run] [--commit] [--repo <path>] [--json] [--yes]',
  examples: ['harness apply --plan p-2026-10-19 --dry-run', 'harness apply --plan p-2026-10-19 --yes', 'harness apply --plan ./plan.json --commit --yes'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['dry-run', 'json', 'yes', 'y', 'commit', 'help', 'h']));
  const json = flagBool(p, 'json');
  const dryRun = flagBool(p, 'dry-run');
  const yes = flagBool(p, 'yes') || flagBool(p, 'y');
  const ref = flagStr(p, 'plan') ?? p.positional[0];
  const loaded = loadPlanRef(ref);
  if (!loaded.ok) {
    process.stderr.write(`error: ${loaded.error}\n`);
    return 2;
  }
  const { plan, file } = loaded;
  if (!json) process.stdout.write(formatPlanSummary(plan, file) + '\n');

  if (!dryRun && !yes) {
    if (!isInteractive()) {
      process.stderr.write('error: apply changes files; pass --yes to confirm, or --dry-run to see what would happen\n');
      return 2;
    }
    if (!(await askYesNo('Apply this plan?'))) {
      process.stdout.write('Nothing applied.\n');
      return 0;
    }
  }

  const r = await applyPlan(plan, { dryRun, commit: flagBool(p, 'commit'), repoRoot: flagStr(p, 'repo') });
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatApply(r) + '\n');
  if (r.ok) return 0;
  return r.refused.length ? 4 : 1;
}
