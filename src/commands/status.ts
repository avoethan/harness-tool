/**
 * `harness status [--json]`
 *
 * One screen for the user: setting, agents, workspace, ledger age and
 * counts, the test-database allowlist, integrity, open tasks with their
 * phase, attempt and last gate verdict, lessons waiting for review, the
 * self-checks, and the next thing to do. Reads the harness state only.
 * Exit 0 always (status is information; `harness doctor` is the check).
 */
import type { CommandMeta } from '../cli';
import { flagBool, parseArgv } from '../lib/argv';
import { collectState } from '../report/collect';
import { buildStatus, renderStatus } from '../report/status';

export const meta: CommandMeta = {
  name: 'status',
  summary: 'Show where the install and the tasks stand, and the next thing to do',
  usage: 'harness status [--json]',
  examples: ['harness status', 'harness status --json'],
};

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv);
  const s = buildStatus(collectState());
  if (flagBool(a, 'json')) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  else process.stdout.write(renderStatus(s));
  return 0;
}
