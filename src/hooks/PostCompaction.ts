/**
 * PostCompaction hook (Devin Local; DESIGN §2.13): the context was just
 * compacted, so write the trail (and the personal-setting pause commit) as
 * PreCompact does, and hand the trail back as additionalContext so the
 * agent resumes from it. See ./pause.ts.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { instrument } from '../lib/log';
import { openTrailLines } from '../runctl/trail';
import { failOpen, hookCwd, repoOf } from './common';
import { pauseSafely } from './pause';

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, () => {
    const started = Date.now();
    const r = pauseSafely(input, ctx, 'PostCompaction');
    const cwd = hookCwd(input);
    const own = repoOf(cwd);
    const lines = openTrailLines([own?.root ?? cwd], 40);
    instrument({
      event: 'pause.trail',
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      ids: { hook: ctx.event },
      counts: { trails: r.trails.length, wip: r.wips.filter((w) => w.made).length, trailLines: lines.length, ms: Date.now() - started },
    });
    if (!lines.length) return { exitCode: 0 };
    return { exitCode: 0, additionalContext: ['harness: context was compacted; resume from this trail (re-run `harness gate` before trusting any verified claim):', ...lines].join('\n') };
  });
}
