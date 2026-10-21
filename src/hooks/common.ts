/**
 * Shared helpers for the hook runtime (every event except PreToolUse).
 *
 * Kept in src/hooks/ so the integrity manifest (which hashes every
 * dist/src/hooks/*.js) covers the helpers along with the handlers.
 * Kept lean on purpose: the Stop hook imports this module and must start
 * and finish well under 1.5 s, so nothing here pulls in the guard parser.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile, HarnessConfig, HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { DEFAULT_CAPS } from '../types';
import { defaultConfig, loadConfig, repoIdFor } from '../lib/config';
import { readJsonOr, readTextOr } from '../lib/fsx';
import { nearestRepoRoot } from '../lib/git';
import { instrument } from '../lib/log';
import { harnessHome, runsDir, subPath } from '../lib/paths';
import { stripHiddenUnicode } from '../lib/unicode';

/** Evidence as the Stop hook reads it: the gate's file plus the cap marker this hook may add. */
/** Evidence as the Stop hook reads it (the gate file, including the cap marker this hook may add). */
export type EvidenceRecord = EvidenceFile;

export interface RepoHit {
  root: string;
  id: string;
  name: string;
}

/** Working directory of the hook call: the agent's `cwd`, the tool's `cwd`, or the process cwd. */
export function hookCwd(input: HookInput): string {
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd;
  const ti = input.tool_input;
  if (ti && typeof ti === 'object' && typeof (ti as Record<string, unknown>).cwd === 'string') return String((ti as Record<string, unknown>).cwd);
  return process.cwd();
}

/** The git repository holding `p` (walks up to `.git`), with its stable id; null outside any repo. */
export function repoOf(p: string): RepoHit | null {
  const root = nearestRepoRoot(p);
  if (!root) return null;
  return { root, id: repoIdFor(root), name: path.basename(root) };
}

/** Ids used in state paths: letters, digits, dot, dash, underscore; no traversal. */
export function validId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s) && !s.includes('..');
}

/** The task id the gate uses for this repo when --task is absent (`runs/<repoId>/current-task`). */
export function currentTask(repoId: string): string | null {
  if (!validId(repoId)) return null;
  const t = (readTextOr(path.join(runsDir(), repoId, 'current-task'), '') ?? '').trim();
  return t && validId(t) ? t : null;
}

export function evidencePathFor(repoId: string, taskId: string): string {
  return path.join(runsDir(), repoId, taskId, 'evidence.json');
}

export interface TaskRef {
  taskId: string;
  /** Where the id came from: the current-task file, or the newest evidence under the repo's runs folder. */
  source: 'current-task' | 'newest-evidence';
  evidencePath: string;
}

/**
 * The task the Stop hook checks for a repo: the current task when set,
 * otherwise the task with the newest evidence file, otherwise null.
 */
export function taskFor(repoId: string): TaskRef | null {
  const cur = currentTask(repoId);
  if (cur) return { taskId: cur, source: 'current-task', evidencePath: evidencePathFor(repoId, cur) };
  let best: { id: string; mtime: number } | null = null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(runsDir(), repoId));
  } catch {
    return null;
  }
  for (const n of names) {
    if (!validId(n)) continue;
    try {
      const st = fs.statSync(evidencePathFor(repoId, n));
      if (!best || st.mtimeMs > best.mtime) best = { id: n, mtime: st.mtimeMs };
    } catch {
      /* no evidence in this folder */
    }
  }
  return best ? { taskId: best.id, source: 'newest-evidence', evidencePath: evidencePathFor(repoId, best.id) } : null;
}

/** Read an evidence file; null when absent or not shaped like one. */
export function readEvidence(p: string): EvidenceRecord | null {
  const e = readJsonOr<Partial<EvidenceRecord> | null>(p, null);
  if (!e || typeof e !== 'object') return null;
  if (e.verdict !== 'PASS' && e.verdict !== 'FAIL' && e.verdict !== 'BLOCKED') return null;
  return {
    version: 1,
    repo: String(e.repo ?? ''),
    task: String(e.task ?? ''),
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
    verdict: e.verdict,
    reasons: Array.isArray(e.reasons) ? e.reasons.map(String) : [],
    treeHash: typeof e.treeHash === 'string' ? e.treeHash : '',
    baseSha: String(e.baseSha ?? ''),
    steps: Array.isArray(e.steps) ? e.steps : [],
    attempt: typeof e.attempt === 'number' ? e.attempt : 0,
    startedAt: String(e.startedAt ?? ''),
    finishedAt: String(e.finishedAt ?? ''),
    e2e: Array.isArray(e.e2e) ? e.e2e : [],
    phase: e.phase,
    cap_reached: e.cap_reached === true ? true : undefined,
    cap_reached_at: typeof e.cap_reached_at === 'string' ? e.cap_reached_at : undefined,
  };
}

/** The machine config (DB allowlist, caps and the repo inventory live there), or the default. */
export function machineConfig(): HarnessConfig {
  return loadConfig() ?? defaultConfig();
}

/** Gate attempt cap from the machine config; default 8 (DESIGN §2.5, §2.13). */
export function attemptCap(cfg: HarnessConfig = machineConfig()): number {
  const n = cfg.caps?.gateAttempts;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CAPS.gateAttempts;
}

/**
 * One line of text that is safe to inject: hidden Unicode stripped, line
 * breaks and runs of whitespace collapsed, length capped.
 */
export function oneLine(s: unknown, max = 200): string {
  const t = stripHiddenUnicode(String(s ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Cap a list of lines; the last kept line says how many were dropped. */
export function capLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, Math.max(0, max - 1));
  kept.push(`(${lines.length - kept.length} more lines not shown)`);
  return kept;
}

/** True when `p` lies inside the harness state folder (edits there are never task work). */
export function inHarnessHome(p: string): boolean {
  return subPath(harnessHome(), p);
}

/** Repo-relative path with forward slashes (for notes and trails). */
export function relTo(root: string, p: string): string {
  const r = path.relative(root, p);
  return (r && !r.startsWith('..') ? r : p).replace(/\\/g, '/');
}

/**
 * Run a non-blocking handler body: any error becomes exit 0 with a one-line
 * stderr note and a `hook.error` event (names only).
 */
export async function failOpen(ctx: HookContext, body: () => Promise<HookResult> | HookResult): Promise<HookResult> {
  try {
    return await body();
  } catch (e) {
    instrument({ event: 'hook.error', sessionId: ctx.sessionId, agent: ctx.agent, ids: { hook: ctx.event } });
    return { exitCode: 0, stderr: `harness ${ctx.event} hook: ${oneLine((e as Error)?.message ?? e, 160)} (ignored; run \`harness doctor\` if it repeats)` };
  }
}
