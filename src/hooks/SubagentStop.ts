/**
 * SubagentStop hook: the same evidence check as Stop (./evidence.ts), keyed
 * on the parent session's edit log, so a subagent cannot end the work
 * unverified either.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { handleStopLike } from './evidence';

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return handleStopLike(input, ctx);
}
