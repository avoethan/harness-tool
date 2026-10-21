/**
 * ConfigChange hook (Claude Code): a settings or skills file changed during
 * the session. The event is instrumented (source and counts only). When the
 * changed file is harness-owned (in the machine or repo manifest, a settings
 * file the harness edited, anything under the harness state or the harness
 * package), the agent is told that the harness re-signs integrity only
 * through `harness config`, run by the user: until then the hooks see a hash
 * mismatch and fail closed.
 */
import * as path from 'node:path';
import type { HookInput, HookResult, Manifest } from '../types';
import type { HookContext } from '../hook';
import { readJsonOr } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { instrument } from '../lib/log';
import { harnessHome, manifestPath, packageRoot, subPath } from '../lib/paths';
import { failOpen, hookCwd, oneLine } from './common';

function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** True when `file` is a file the harness owns or signs. */
export function isHarnessOwned(file: string, cwd: string): boolean {
  if (subPath(harnessHome(), file) || subPath(packageRoot(), file)) return true;
  const manifests: string[] = [manifestPath()];
  const root = nearestRepoRoot(cwd);
  if (root) manifests.push(path.join(root, '.harness', 'manifest.json'));
  for (const m of manifests) {
    const man = readJsonOr<Manifest | null>(m, null);
    if (!man) continue;
    if ((man.files ?? []).some((f) => typeof f?.path === 'string' && samePath(f.path, file))) return true;
    if ((man.settingsEdits ?? []).some((e) => typeof e?.path === 'string' && samePath(e.path, file))) return true;
  }
  return false;
}

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, () => {
    const raw = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).path;
    const file = typeof raw === 'string' && raw ? path.resolve(hookCwd(input), raw) : null;
    const owned = file ? isHarnessOwned(file, hookCwd(input)) : false;
    instrument({
      event: 'config.change',
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      ids: { source: oneLine(input.source ?? 'unknown', 40) },
      counts: { owned: owned ? 1 : 0, file: file ? 1 : 0 },
    });
    if (!owned || !file) return { exitCode: 0 };
    const msg = `harness warning: ${path.basename(file)} is a harness-owned file and it changed outside \`harness config\`. The harness re-signs integrity only through \`harness config\`, run by the user in a terminal; until then the hooks see a hash mismatch and the guard and Stop hook fail closed. Do not edit harness or agent settings; tell the user what changed.`;
    return { exitCode: 0, additionalContext: msg, stderr: msg };
  });
}
