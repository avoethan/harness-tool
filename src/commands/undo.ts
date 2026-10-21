/**
 * `harness undo [--plan <id>] [--dry-run] [--json] [--yes]`
 *
 * Restores every file a plan changed when its hash still matches what the
 * harness wrote; keeps and lists files edited since; removes only the
 * settings entries the harness added; reverts the apply commit when one
 * exists (git revert, never reset). Without --plan, the latest apply.
 */
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { askYesNo, isInteractive } from '../lib/prompt';
import { listPlanIds, loadPlanRecord } from '../lifecycle/backup';
import { formatUndo } from '../lifecycle/format';
import { undoPlan } from '../lifecycle/undo';

export const meta: CommandMeta = {
  name: 'undo',
  summary: 'Restore the files a plan changed',
  usage: 'harness undo [--plan <id>] [--dry-run] [--json] [--yes]',
  examples: ['harness undo --dry-run', 'harness undo --plan p-2026-10-19 --yes'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['dry-run', 'json', 'yes', 'y', 'help', 'h']));
  const json = flagBool(p, 'json');
  const dryRun = flagBool(p, 'dry-run');
  const yes = flagBool(p, 'yes') || flagBool(p, 'y');
  let planId = flagStr(p, 'plan') ?? p.positional[0];
  if (!planId) {
    const latest = listPlanIds()[0];
    if (!latest) {
      process.stderr.write('error: nothing to undo: no applied plan has backups\n');
      return 1;
    }
    planId = latest.planId;
  }
  const rec = loadPlanRecord(planId);
  if (!rec) {
    process.stderr.write(`error: no apply record for plan "${planId}" (was it applied? run \`harness undo\` with no --plan to pick the latest)\n`);
    return 1;
  }
  if (!json) {
    process.stdout.write(`Plan ${rec.planId} applied ${rec.appliedAt ?? rec.stamp} (${rec.setting} setting): ${rec.files.length} file(s), ${rec.settingsEdits.length} settings entr${rec.settingsEdits.length === 1 ? 'y' : 'ies'}${rec.commit ? `, commit ${rec.commit.slice(0, 12)}` : ''}\n`);
    for (const f of rec.files) process.stdout.write(`  ${f.path}\n`);
  }
  if (!dryRun && !yes) {
    if (!isInteractive()) {
      process.stderr.write('error: undo changes files; pass --yes to confirm, or --dry-run to see what would happen\n');
      return 2;
    }
    if (!(await askYesNo('Undo this plan?'))) {
      process.stdout.write('Nothing changed.\n');
      return 0;
    }
  }
  const r = await undoPlan(planId, { dryRun });
  if (!r.ok && 'error' in r) {
    process.stderr.write(`error: ${r.error}\n`);
    return 1;
  }
  if ('error' in r) return 1;
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatUndo(r) + '\n');
  return r.ok ? 0 : 1;
}
