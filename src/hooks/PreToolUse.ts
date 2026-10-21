/**
 * PreToolUse hook: builds a GuardInput from the agent's tool call and
 * denies (exit 2 with the reason) when a safety rail says so.
 *
 * Inputs read here, all local: the effective config (DB and MCP
 * allowlists), the session phase, the manifest of harness-owned files,
 * and git state of the repo under the working directory (only when the
 * command is a git add/commit, to stay well under 2 s).
 *
 * Instrumentation carries the rail name and counts only, never command text.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookInput, HookResult, Manifest } from '../types';
import type { HookContext } from '../hook';
import { resolveConfig } from '../lib/config';
import { readJsonOr } from '../lib/fsx';
import { isTracked, nearestRepoRoot, rawGit, stagedFiles } from '../lib/git';
import { instrument } from '../lib/log';
import { agentHome, harnessHome, manifestPath, packageRoot, sharedSkillsHome, subPath, userHome } from '../lib/paths';
import { getPhase } from '../lib/session';
import { phaseForRepo } from '../intake/phase';
import { evaluate, type GuardDecision, type GuardInput } from '../guard';

/** Absolute roots the agent must never write. The package root is dropped when the task repo is the harness checkout itself. */
export function protectedRootsFor(repoRoot: string | null): string[] {
  const home = userHome();
  const roots = new Set<string>([
    harnessHome(),
    agentHome('claude'),
    agentHome('codex'),
    agentHome('devin'),
    path.join(home, '.devin'),
    path.join(home, '.claude.json'),
    sharedSkillsHome(),
  ]);
  if (process.env.APPDATA) roots.add(path.join(process.env.APPDATA, 'devin'));
  if (process.env.CLAUDE_CONFIG_DIR) roots.add(process.env.CLAUDE_CONFIG_DIR);
  if (process.env.CODEX_HOME) roots.add(process.env.CODEX_HOME);
  const pkg = packageRoot();
  if (!(repoRoot && (subPath(repoRoot, pkg) || subPath(pkg, repoRoot)))) roots.add(pkg);
  return [...roots];
}

function worktreeStatusOf(repoRoot: string): { modified: string[]; untracked: string[] } {
  const r = rawGit(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--no-renames'], 8000);
  const modified: string[] = [];
  const untracked: string[] = [];
  if (r.code !== 0) return { modified, untracked };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim().replace(/^"|"$/g, '');
    if (x === '?' && y === '?') untracked.push(file);
    else if (y !== ' ') modified.push(file);
  }
  return { modified, untracked };
}

function realpathOf(p: string): string {
  // Resolve the longest existing prefix so symlinked parents are seen through.
  let cur = p;
  let rest = '';
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest ? path.join(real, rest) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest = rest ? path.join(path.basename(cur), rest) : path.basename(cur);
      cur = parent;
    }
  }
  return p;
}

export function buildGuardInput(input: HookInput, ctx: HookContext): GuardInput {
  const ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : typeof ti.cwd === 'string' ? ti.cwd : process.cwd();
  const resolved = resolveConfig(cwd);
  const repoRoot = resolved.repoRoot ?? nearestRepoRoot(cwd);
  const manifest = readJsonOr<Manifest | null>(manifestPath(), null);
  const owned = manifest?.files?.map((f) => f.path).filter((p) => typeof p === 'string') ?? [];
  const command = typeof ti.command === 'string' ? ti.command : '';
  const needsGit = !!repoRoot && /\bgit\b/.test(command) && /\b(commit|add)\b/.test(command);
  return {
    agent: ctx.agent,
    setting: resolved.config.setting,
    toolName: String(input.tool_name ?? ''),
    toolInput: input.tool_input,
    env: process.env,
    config: { db: resolved.config.db, mcp: resolved.config.mcp },
    protectedRoots: protectedRootsFor(repoRoot),
    repoRoot,
    cwd,
    phase: getPhase(ctx.sessionId) ?? (repoRoot ? phaseForRepo(repoRoot).phase : undefined),
    harnessOwnedPaths: owned,
    excludedPaths: [],
    trackedPathCheck: repoRoot ? (p) => isTracked(repoRoot, p) : undefined,
    stagedFiles: needsGit ? () => stagedFiles(repoRoot!) : undefined,
    worktreeStatus: needsGit ? () => worktreeStatusOf(repoRoot!) : undefined,
    realpath: realpathOf,
    platform: process.platform,
    userHome: userHome(),
  };
}

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  const started = Date.now();
  let decision: GuardDecision;
  try {
    decision = evaluate(buildGuardInput(input, ctx));
  } catch (e) {
    decision = { decision: 'deny', rail: 'internal', reason: `The harness guard failed closed (${(e as Error).message.slice(0, 100)}); run \`harness doctor\`.` };
  }
  instrument({
    event: decision.decision === 'deny' ? 'guard.deny' : 'guard.allow',
    sessionId: ctx.sessionId,
    agent: ctx.agent,
    ids: { rail: decision.rail, tool: String(input.tool_name ?? '') },
    counts: { ms: Date.now() - started },
  });
  if (decision.decision === 'deny') return { exitCode: 2, stderr: decision.reason };
  return { exitCode: 0 };
}
