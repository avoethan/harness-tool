/**
 * `harness changes [--diff] [--path <text>] [--json]`
 * `harness changes record`
 *
 * Two lists, both read-only:
 *   - the files installs and self-updates added, changed or removed, and how
 *     each stands now (from the plan records kept with the backups);
 *   - the agent files (instructions, skills, rules, workflows, agent
 *     settings) added, changed or removed since the last record, by anyone.
 * `record` records the agent files as they are now; it is the user's (the
 * guard denies it to agents).
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { loadConfig } from '../lib/config';
import { changeDiff, collectChanges, formatChanges } from '../lifecycle/changes';
import { agentFileChanges, agentFileDiff, formatAgentFileChanges, loadAgentFilesRecord, recordAgentFiles, type InventoryOptions } from '../lifecycle/agentfiles';

export const meta: CommandMeta = {
  name: 'changes',
  summary: 'List the files the harness added, changed or removed, and agent files changed since your record',
  usage: 'harness changes [--diff] [--path <text>] [--workspace <folder>] [--json] | harness changes record [--workspace <folder>]',
  examples: ['harness changes', 'harness changes --diff --path AGENTS.md', 'harness changes --path .devin --json', 'harness changes record'],
};

function inventoryOptions(workspaceFlag: string | undefined): InventoryOptions | null {
  const cfg = loadConfig();
  const workspace = workspaceFlag ? path.resolve(workspaceFlag) : cfg?.workspaceRoot;
  if (!workspace) return null;
  return { workspace, setting: cfg?.setting ?? 'team', agents: cfg?.agents?.length ? cfg.agents : ['claude', 'codex', 'devin'], includes: cfg?.include ?? [] };
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, new Set(['diff', 'json', 'help', 'h']));
  const json = flagBool(a, 'json');
  const diff = flagBool(a, 'diff');
  const inv = inventoryOptions(flagStr(a, 'workspace'));

  if (a.positional[0] === 'record') {
    if (!inv) {
      process.stderr.write('error: no workspace: run `harness install` first, or pass --workspace <folder>\n');
      return 2;
    }
    const rec = recordAgentFiles({ ...inv, by: 'user' });
    if (json) process.stdout.write(JSON.stringify({ recordedAt: rec.recordedAt, files: rec.files.length }, null, 2) + '\n');
    else process.stdout.write(`Recorded ${rec.files.length} agent file${rec.files.length === 1 ? '' : 's'} as they are now (${rec.recordedAt}). \`harness changes\` lists what is added, changed or removed from here on.\n`);
    return 0;
  }
  if (a.positional.length) {
    process.stderr.write(`error: unknown argument "${a.positional[0]}"; usage: ${meta.usage}\n`);
    return 2;
  }

  const filter = flagStr(a, 'path')?.replace(/\\/g, '/').toLowerCase();
  const keep = (p: string) => !filter || p.replace(/\\/g, '/').toLowerCase().includes(filter);
  const r = collectChanges();
  r.files = r.files.filter((x) => keep(x.path));
  const rec = loadAgentFilesRecord();
  const agentChanges = rec && inv ? agentFileChanges(rec, { ...inv, workspace: rec.workspace }).filter((c) => keep(c.path)) : [];

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          harness: { plans: r.plans, files: r.files.map((x) => (diff ? { ...x, diff: changeDiff(x) } : x)) },
          agentFiles: rec ? { recordedAt: rec.recordedAt, by: rec.by, changes: agentChanges.map((c) => (diff ? { ...c, diff: agentFileDiff(c) } : c)) } : null,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  process.stdout.write('What the harness changed\n');
  process.stdout.write(formatChanges(r, { diff, filtered: !!filter }));
  process.stdout.write('\n');
  const harnessAsLeft = new Set(collectChanges().files.filter((f) => f.now === 'as-left').map((f) => path.resolve(f.path)));
  process.stdout.write(formatAgentFileChanges(rec, agentChanges, { diff, harnessAsLeft }));
  return 0;
}
