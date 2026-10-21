/**
 * Per-session state: HARNESS_HOME/state/<sessionId>.json, written
 * atomically, with a default when absent. Hooks share it: the PostToolUse
 * hook records edits, the phase command sets the phase, the Stop hook
 * counts attempts, the UserPromptSubmit hook marks injected rules.
 */
import * as path from 'node:path';
import type { AgentId } from '../types';
import { readJsonOr, writeJson } from './fsx';
import { stateDir } from './paths';
import { sha256 } from './hash';

export type Phase = 'implement' | 'tests';
export type SessionStatus = 'working' | 'asking' | 'blocked' | 'closed';

export interface SessionEdit {
  path: string;
  /** Repo id when known. */
  repo: string;
  ts: string;
}

export interface SessionState {
  version: 1;
  sessionId: string;
  agent: AgentId;
  startedAt: string;
  updatedAt: string;
  edits: SessionEdit[];
  /** repoId -> rule ids already injected this session */
  injected: Record<string, string[]>;
  phase?: Phase;
  attempts: Record<string, number>;
  status: SessionStatus;
  lastPromptHash?: string;
  /** Working directory the session started in (SessionStart hook). */
  cwd?: string;
  /** Shell tool calls seen by the PostToolUse hook; part of the Stop hook's tree-cache key. */
  shellRuns?: number;
  /** Last Stop block per `<repoId>/<taskId>`: tree hash and evidence stamp, so an unchanged state is never blocked twice. */
  stopBlocks?: Record<string, StopBlockMark>;
  /** Recent lint and standard notes (rule ids and repo-relative paths only, never tool output), for the pause trail. */
  notes?: SessionNote[];
  /** Set by the SessionEnd hook. */
  endedAt?: string;
}

export interface StopBlockMark {
  tree: string | null;
  evidence: string;
  at: string;
}

export interface SessionNote {
  repo: string;
  rule: string;
  file: string;
  ts: string;
}

const MAX_EDITS = 2000;

/** File-name-safe id: unsafe characters replaced, long ids shortened with a hash suffix. */
export function safeSessionId(id: string): string {
  const s = String(id || 'nosession');
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (cleaned === s && cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 60) + '-' + sha256(s).slice(0, 12);
}

export function sessionStatePath(sessionId: string): string {
  return path.join(stateDir(), safeSessionId(sessionId) + '.json');
}

export function defaultSession(sessionId: string, agent: AgentId = 'claude'): SessionState {
  const now = new Date().toISOString();
  return { version: 1, sessionId, agent, startedAt: now, updatedAt: now, edits: [], injected: {}, attempts: {}, status: 'working' };
}

/** Read the session state, or the default when the file is absent or unreadable. */
export function loadSession(sessionId: string, agent: AgentId = 'claude'): SessionState {
  const s = readJsonOr<Partial<SessionState> | null>(sessionStatePath(sessionId), null);
  if (!s || s.version !== 1) return defaultSession(sessionId, agent);
  const d = defaultSession(sessionId, agent);
  return {
    ...d,
    ...s,
    sessionId,
    agent: (s.agent as AgentId) ?? agent,
    edits: Array.isArray(s.edits) ? s.edits : [],
    injected: s.injected && typeof s.injected === 'object' ? s.injected : {},
    attempts: s.attempts && typeof s.attempts === 'object' ? s.attempts : {},
    status: s.status ?? 'working',
  };
}

export function saveSession(state: SessionState): void {
  state.updatedAt = new Date().toISOString();
  if (state.edits.length > MAX_EDITS) state.edits = state.edits.slice(-MAX_EDITS);
  writeJson(sessionStatePath(state.sessionId), state);
}

/** Load, mutate, save. Returns the saved state. */
export function updateSession(sessionId: string, fn: (s: SessionState) => void, agent: AgentId = 'claude'): SessionState {
  const s = loadSession(sessionId, agent);
  fn(s);
  saveSession(s);
  return s;
}

export function recordEdit(sessionId: string, edit: { path: string; repo?: string }, agent: AgentId = 'claude'): SessionState {
  return updateSession(
    sessionId,
    (s) => {
      s.edits.push({ path: edit.path, repo: edit.repo ?? '', ts: new Date().toISOString() });
    },
    agent,
  );
}

export function setPhase(sessionId: string, phase: Phase, agent: AgentId = 'claude'): SessionState {
  return updateSession(sessionId, (s) => void (s.phase = phase), agent);
}

/** Phase for the session, or undefined when no task set one (then the test-file rule is off). */
export function getPhase(sessionId: string): Phase | undefined {
  const s = readJsonOr<Partial<SessionState> | null>(sessionStatePath(sessionId), null);
  const p = s?.phase;
  return p === 'implement' || p === 'tests' ? p : undefined;
}

export function bumpAttempt(sessionId: string, key: string, agent: AgentId = 'claude'): number {
  let n = 0;
  updateSession(
    sessionId,
    (s) => {
      n = (s.attempts[key] ?? 0) + 1;
      s.attempts[key] = n;
    },
    agent,
  );
  return n;
}

export function getAttempt(sessionId: string, key: string): number {
  return loadSession(sessionId).attempts[key] ?? 0;
}

/** Mark rules as injected for a repo; returns the ids that were new. */
export function markInjected(sessionId: string, repoId: string, ruleIds: string[], agent: AgentId = 'claude'): string[] {
  let fresh: string[] = [];
  updateSession(
    sessionId,
    (s) => {
      const have = new Set(s.injected[repoId] ?? []);
      fresh = ruleIds.filter((r) => !have.has(r));
      s.injected[repoId] = [...have, ...fresh];
    },
    agent,
  );
  return fresh;
}

export function setStatus(sessionId: string, status: SessionStatus, agent: AgentId = 'claude'): SessionState {
  return updateSession(sessionId, (s) => void (s.status = status), agent);
}

export function setLastPromptHash(sessionId: string, promptText: string, agent: AgentId = 'claude'): string {
  const h = sha256(promptText);
  updateSession(sessionId, (s) => void (s.lastPromptHash = h), agent);
  return h;
}
