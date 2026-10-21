/**
 * Stop hook: the evidence check (DESIGN §2.5). It never runs tests; it reads
 * evidence.json per edited repo and the working-tree hash, honours the
 * attempt cap and never blocks twice for an unchanged state. See ./evidence.ts.
 *
 * Agent semantics (RESEARCH §7): Claude Code holds the turn on a block (its
 * own cap is 8 consecutive continuations); Devin Local holds it with no
 * documented cap; Codex only feeds the reason back as a new prompt, so the
 * reason always carries the exact command.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { handleStopLike } from './evidence';

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return handleStopLike(input, ctx);
}
