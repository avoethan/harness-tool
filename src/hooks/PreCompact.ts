/**
 * PreCompact hook (DESIGN §2.13): before the agent's context is compacted,
 * write the pause-safely trail for every task the session touched and, in
 * the personal setting, the `wip: pause` commit (never on main, never
 * pushed). See ./pause.ts. Never blocks compaction.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { instrument } from '../lib/log';
import { failOpen } from './common';
import { pauseSafely } from './pause';

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, () => {
    const started = Date.now();
    const r = pauseSafely(input, ctx, 'PreCompact');
    instrument({
      event: 'pause.trail',
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      ids: { hook: ctx.event },
      counts: { trails: r.trails.length, wip: r.wips.filter((w) => w.made).length, ms: Date.now() - started },
    });
    return { exitCode: 0 };
  });
}
