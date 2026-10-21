/**
 * `harness uninstall [--setting team|personal] [--repo <path>] [--dry-run] [--json] [--yes]`
 *
 * Undo of everything the manifest owns (every recorded plan, newest first,
 * then anything left from the original backups), removal of the empty
 * folders the harness created, and of the manifest. Backups are kept and
 * their location printed. The personal setting is picked when --repo is
 * given or the current folder lies in a repository with its own manifest.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import type { Setting } from '../types';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { isFile } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { askYesNo, isInteractive } from '../lib/prompt';
import { formatUninstall } from '../lifecycle/format';
import { loadManifest, manifestPathFor } from '../lifecycle/manifest';
import { uninstall } from '../lifecycle/undo';

export const meta: CommandMeta = {
  name: 'uninstall',
  summary: 'Undo everything the manifest owns',
  usage: 'harness uninstall [--setting team|personal] [--repo <path>] [--dry-run] [--json] [--yes]',
  examples: ['harness uninstall --dry-run', 'harness uninstall --yes', 'harness uninstall --repo . --yes'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['dry-run', 'json', 'yes', 'y', 'help', 'h']));
  const json = flagBool(p, 'json');
  const dryRun = flagBool(p, 'dry-run');
  const yes = flagBool(p, 'yes') || flagBool(p, 'y');
  const settingFlag = flagStr(p, 'setting');
  if (settingFlag && settingFlag !== 'team' && settingFlag !== 'personal') {
    process.stderr.write('error: --setting must be team or personal\n');
    return 2;
  }
  let repoRoot: string | null = flagStr(p, 'repo') ? path.resolve(flagStr(p, 'repo')!) : null;
  let setting: Setting;
  if (settingFlag) setting = settingFlag as Setting;
  else if (repoRoot) setting = 'personal';
  else {
    const near = nearestRepoRoot(process.cwd());
    setting = near && isFile(manifestPathFor('personal', near)) ? 'personal' : 'team';
    if (setting === 'personal') repoRoot = near;
  }
  if (setting === 'personal' && !repoRoot) repoRoot = nearestRepoRoot(process.cwd());
  if (setting === 'personal' && !repoRoot) {
    process.stderr.write('error: personal setting: run inside the repository or pass --repo <path>\n');
    return 2;
  }
  const manifestP = manifestPathFor(setting, repoRoot);
  const m = loadManifest(manifestP);
  if (!m) {
    process.stdout.write(`Nothing installed: no manifest at ${manifestP}.\n`);
    return 0;
  }
  if (!json) {
    process.stdout.write(`Manifest ${manifestP} owns ${m.files.length} file(s) and ${m.settingsEdits.length} settings entr${m.settingsEdits.length === 1 ? 'y' : 'ies'}.\n`);
    for (const f of m.files) process.stdout.write(`  ${f.path}\n`);
  }
  if (!dryRun && !yes) {
    if (!isInteractive()) {
      process.stderr.write('error: uninstall changes files; pass --yes to confirm, or --dry-run to see what would happen\n');
      return 2;
    }
    if (!(await askYesNo('Remove the harness from these files?'))) {
      process.stdout.write('Nothing changed.\n');
      return 0;
    }
  }
  const r = await uninstall({ setting, repoRoot, dryRun });
  if ('error' in r) {
    process.stderr.write(`error: ${r.error}\n`);
    return 1;
  }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(formatUninstall(r) + '\n');
  return r.ok ? 0 : 1;
}
