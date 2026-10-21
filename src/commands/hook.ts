import type { CommandMeta } from '../cli';
import { runHook } from '../hook';

export const meta: CommandMeta = {
  name: 'hook',
  summary: 'Internal: run a hook event with JSON on stdin (used by the agents)',
  usage: 'harness hook <Event> [--agent devin|claude|codex]',
};

export async function main(argv: string[]): Promise<number> {
  return runHook(argv);
}
