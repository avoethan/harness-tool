/**
 * Hook registration fragments per agent (DESIGN 2.4, RESEARCH 7.4).
 *
 * Every entry runs the same dispatcher with a byte-stable command:
 *
 *   node "<packageRoot>/dist/src/hook.js" <Event> --agent <agent>
 *
 * absolute, forward slashes, the path double-quoted, no shell features, so
 * Codex's trust hash and Windows shells see the same bytes on every install
 * and update. `--agent` spares the dispatcher a guess (Claude Code and Codex
 * use the same tool names). Every entry has an explicit timeout in seconds:
 * PreToolUse 20, PostToolUse 25, Stop-like 5, everything else 10 (Codex caps
 * SessionEnd at 3). The dispatcher dedupes per (session, event, payload), so
 * two entries that match the same call, or a second registration, run once.
 *
 * Files (the fragment is unioned in by apply; nothing existing is removed):
 *   Claude  ~/.claude/settings.json (team) or <repo>/.claude/settings.json (personal)
 *   Codex   ~/.codex/hooks.json (team) or <repo>/.codex/hooks.json (personal); never config.toml [hooks]
 *   Devin   ~/.config/devin/config.json or %APPDATA%\devin\config.json (team), <repo>/.devin/config.json (personal)
 */
import * as path from 'node:path';
import type { AgentId, HookEvent } from '../types';
import { posix } from './model';

export interface HookSpec {
  event: HookEvent;
  /** Tool-name matcher; absent for events that are not about a tool. */
  matcher?: string;
  timeout: number;
}

/** Claude Code and Codex name their tools alike; the shell tool and every edit tool. */
export const CLAUDE_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch';
export const CODEX_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|apply_patch';
/** Claude Code: `*` is every tool, so MCP calls (and reads of key material) reach the guard. */
export const CLAUDE_ALL_MATCHER = '*';
/** Codex treats matchers as regular expressions; `.*` is every tool there (a bare `*` is not a valid pattern). */
export const CODEX_ALL_MATCHER = '.*';
/** Devin Local tool names are lower case; MCP tools are `mcp__<server>__<tool>`. */
export const DEVIN_PRE_MATCHER = '^(exec|edit|write|read|mcp__.*)$';
export const DEVIN_POST_MATCHER = '^(exec|edit|write)$';

export const TIMEOUTS = { PreToolUse: 20, PostToolUse: 25, stop: 5, other: 20, codexSessionEnd: 3 } as const;

function stopLike(e: HookEvent): boolean {
  return e === 'Stop' || e === 'SubagentStop' || e === 'TaskCompleted';
}

export function timeoutFor(event: HookEvent, agent: AgentId): number {
  if (event === 'PreToolUse') return TIMEOUTS.PreToolUse;
  if (event === 'PostToolUse') return TIMEOUTS.PostToolUse;
  if (stopLike(event)) return TIMEOUTS.stop;
  if (agent === 'codex' && event === 'SessionEnd') return TIMEOUTS.codexSessionEnd;
  return TIMEOUTS.other;
}

/** The events and matchers registered per agent. */
export function hookSpecs(agent: AgentId): HookSpec[] {
  const s = (event: HookEvent, matcher?: string): HookSpec => ({ event, matcher, timeout: timeoutFor(event, agent) });
  switch (agent) {
    case 'claude':
      return [
        s('PreToolUse', CLAUDE_TOOL_MATCHER),
        s('PreToolUse', CLAUDE_ALL_MATCHER),
        s('PostToolUse', CLAUDE_TOOL_MATCHER),
        s('Stop'),
        s('SubagentStop'),
        s('TaskCompleted'),
        s('SessionStart'),
        s('UserPromptSubmit'),
        s('PreCompact'),
        s('SessionEnd'),
      ];
    case 'codex':
      return [
        s('PreToolUse', CODEX_TOOL_MATCHER),
        s('PreToolUse', CODEX_ALL_MATCHER),
        s('PostToolUse', CODEX_TOOL_MATCHER),
        s('Stop'),
        s('SessionStart'),
        s('UserPromptSubmit'),
        s('SessionEnd'),
      ];
    case 'devin':
      return [
        s('PreToolUse', DEVIN_PRE_MATCHER),
        s('PostToolUse', DEVIN_POST_MATCHER),
        s('Stop', ''),
        s('SessionStart', ''),
        s('UserPromptSubmit', ''),
        s('PostCompaction', ''),
        s('SessionEnd', ''),
      ];
  }
}

/** The hook entry point as an absolute forward-slash path. */
export function hookEntry(packageRoot: string): string {
  return posix(path.join(packageRoot, 'dist', 'src', 'hook.js'));
}

/** The registered command: byte-stable for a given package root, event and agent. */
export function hookCommand(packageRoot: string, event: HookEvent, agent: AgentId): string {
  return `node "${hookEntry(packageRoot)}" ${event} --agent ${agent}`;
}

export interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout: number }>;
}

/** `{ hooks: { <Event>: [entry, ...] } }` for one agent, ready to union into its settings file. */
export function hooksFragment(agent: AgentId, packageRoot: string): { hooks: Record<string, HookEntry[]> } {
  const hooks: Record<string, HookEntry[]> = {};
  for (const spec of hookSpecs(agent)) {
    const entry: HookEntry = { hooks: [{ type: 'command', command: hookCommand(packageRoot, spec.event, agent), timeout: spec.timeout }] };
    if (spec.matcher !== undefined) entry.matcher = spec.matcher;
    (hooks[spec.event] ??= []).push(entry);
  }
  return { hooks };
}

/** The settings files that carry hooks, per agent and setting. */
export function hookFilePath(agent: AgentId, setting: 'team' | 'personal', dirs: { claudeHome: string; codexHome: string; devinHome: string; repoRoot?: string }): string {
  if (setting === 'personal' && dirs.repoRoot) {
    switch (agent) {
      case 'claude':
        return path.join(dirs.repoRoot, '.claude', 'settings.json');
      case 'codex':
        return path.join(dirs.repoRoot, '.codex', 'hooks.json');
      case 'devin':
        return path.join(dirs.repoRoot, '.devin', 'config.json');
    }
  }
  switch (agent) {
    case 'claude':
      return path.join(dirs.claudeHome, 'settings.json');
    case 'codex':
      return path.join(dirs.codexHome, 'hooks.json');
    case 'devin':
      return path.join(dirs.devinHome, 'config.json');
  }
}
