/**
 * SessionEnd hook (DESIGN §2.13): write the pause-safely trail (and the
 * personal-setting `wip: pause` commit, never on main, never pushed), then
 * close the session state (status 'closed', endedAt). See ./pause.ts.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { instrument } from '../lib/log';
import { updateSession } from '../lib/session';
import { failOpen } from './common';
import { pauseSafely } from './pause';

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, () => {
    const started = Date.now();
    let trails = 0;
    let wip = 0;
    try {
      const r = pauseSafely(input, ctx, 'SessionEnd');
      trails = r.trails.length;
      wip = r.wips.filter((w) => w.made).length;
    } finally {
      updateSession(
        ctx.sessionId,
        (s) => {
          s.status = 'closed';
          s.endedAt = new Date().toISOString();
        },
        ctx.agent,
      );
    }
    instrument({ event: 'session.end', sessionId: ctx.sessionId, agent: ctx.agent, counts: { trails, wip, ms: Date.now() - started } });
    return { exitCode: 0 };
  });
}
