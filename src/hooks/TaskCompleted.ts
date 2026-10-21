/**
 * TaskCompleted hook: the same evidence check as Stop (./evidence.ts); a
 * block keeps the task open until `harness gate` has evidence for the tree.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { handleStopLike } from './evidence';

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return handleStopLike(input, ctx);
}
