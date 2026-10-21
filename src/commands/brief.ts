/**
 * `harness brief [id] [--repo <path>] [--json]`: an alias of
 * `harness intake show`. Same flags, same output, same exit codes.
 */
import type { CommandMeta } from '../cli';
import { main as intakeMain } from './intake';

export const meta: CommandMeta = {
  name: 'brief',
  summary: 'Show a brief (alias of intake show)',
  usage: 'harness brief [id] [--repo <path>] [--json]',
  examples: ['harness brief', 'harness brief t-1a2b3c4d5e --json'],
};

export async function main(argv: string[]): Promise<number> {
  return intakeMain(['show', ...argv]);
}
