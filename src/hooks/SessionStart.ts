/**
 * SessionStart hook (DESIGN §2.4, §2.10, §2.13).
 *
 * Prints as additionalContext: the trail of any open task in the workspace
 * (newest first, at most 40 lines), the repo index (one line per repo: name,
 * path, verify command), the DB allowlist summary and the integrity status.
 * Records the session (agent, working folder) in the session state and
 * writes `state/heartbeat-<agent>.json` ({agent, at, sessionId}); `harness
 * doctor` reads the heartbeat to tell whether Codex has trusted the hooks.
 */
import * as path from 'node:path';
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { resolveConfig } from '../lib/config';
import { writeJson } from '../lib/fsx';
import { instrument } from '../lib/log';
import { stateDir } from '../lib/paths';
import { updateSession } from '../lib/session';
import { openTrailLines } from '../runctl/trail';
import { failOpen, hookCwd, machineConfig, oneLine } from './common';
import { dbSummaryLines, integrityLine, repoIndexLines } from './repoindex';

export function heartbeatPath(agent: string): string {
  return path.join(stateDir(), `heartbeat-${agent.replace(/[^a-z]/gi, '')}.json`);
}

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, () => {
    const started = Date.now();
    const cwd = hookCwd(input);
    const source = oneLine(input.source ?? 'startup', 20);
    updateSession(
      ctx.sessionId,
      (s) => {
        s.agent = ctx.agent;
        s.cwd = cwd;
        if (s.status === 'closed') s.status = 'working';
        delete s.endedAt;
      },
      ctx.agent,
    );
    writeJson(heartbeatPath(ctx.agent), { agent: ctx.agent, at: new Date().toISOString(), sessionId: ctx.sessionId, source });

    const { config } = resolveConfig(cwd);
    const roots = [cwd, config.workspaceRoot, ...(config.repos ?? []).map((r) => r.path)].filter((r): r is string => typeof r === 'string' && !!r);
    const trail = openTrailLines(roots, 40);
    const index = repoIndexLines(config, cwd, 20);
    const machine = machineConfig();

    const L: string[] = ['harness: session context (facts from the harness state; the always-on file has the rules).'];
    if (trail.length) {
      L.push('', 'Open task trail (resume from here; re-run `harness gate` before trusting any verified claim):', ...trail);
    }
    if (index.length) L.push('', 'Repos (name: path | verify):', ...index);
    L.push('', 'Done-gate: run `harness gate` before you stop; the Stop hook checks its evidence.');
    L.push(...dbSummaryLines(machine));
    L.push(integrityLine());

    instrument({
      event: 'session.start',
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      ids: { source },
      counts: { trailLines: trail.length, repos: index.length, ms: Date.now() - started },
    });
    return { exitCode: 0, additionalContext: L.join('\n') };
  });
}
