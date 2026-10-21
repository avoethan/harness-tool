import { harnessVersion, type CommandMeta } from '../cli';

export const meta: CommandMeta = { name: 'version', summary: 'Print the harness version', usage: 'harness version' };

export async function main(): Promise<number> {
  process.stdout.write(harnessVersion() + '\n');
  return 0;
}
