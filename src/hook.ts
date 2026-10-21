#!/usr/bin/env node
/**
 * Hook entry point for all three agents.
 *
 *   node "<abs>/dist/src/hook.js" <Event> [--agent devin|claude|codex]
 *
 * Reads the agent's JSON on stdin, dispatches to ./hooks/<event>.ts, and
 * turns the HookResult into the agent-specific exit code and stdout JSON.
 *
 * Rules (DESIGN §2.4, §2.10):
 *  - never runs agent-authored or repo-supplied code;
 *  - verifies its own integrity (sha256 of this file and of config.json
 *    against ~/.harness/integrity.json) and fails closed on mismatch:
 *    PreToolUse -> deny, Stop -> block, others -> exit 0 with a warning;
 *  - idempotent per (session, event, prompt/tool id) so a double
 *    registration (Devin also reading Claude's settings) runs once;
 *  - Stop must finish in ~2 s; it only reads evidence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, HookEvent, HookInput, HookResult } from './types';
import { instrument } from './lib/log';
import { stateDir } from './lib/paths';
import { verifyIntegrity } from './lib/integrity';
import { ensureDir } from './lib/fsx';
import { sha256 } from './lib/hash';
import { loadSession } from './lib/session';

export type HookHandler = (input: HookInput, ctx: HookContext) => Promise<HookResult> | HookResult;

export interface HookContext {
  agent: AgentId;
  event: HookEvent;
  sessionId: string;
}

const EVENTS: HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'TaskCompleted',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompaction',
  'ConfigChange',
];

/** Events where an internal failure must block rather than pass. */
const FAIL_CLOSED: Set<HookEvent> = new Set(['PreToolUse', 'Stop', 'SubagentStop', 'TaskCompleted']);

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

function detectAgent(argv: string[], input: HookInput): AgentId {
  const i = argv.indexOf('--agent');
  if (i >= 0 && argv[i + 1]) return argv[i + 1] as AgentId;
  if (process.env.HARNESS_AGENT) return process.env.HARNESS_AGENT as AgentId;
  if (process.env.DEVIN_PROJECT_DIR !== undefined || process.env.DEVIN_SESSION_ID) return 'devin';
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return 'codex';
  if (process.env.CLAUDE_PROJECT_DIR !== undefined || process.env.CLAUDECODE) return 'claude';
  // Devin tool names are lowercase (exec/edit/write); Claude and Codex use Bash/Edit/Write.
  if (typeof input.tool_name === 'string' && /^[a-z_]+$/.test(input.tool_name)) return 'devin';
  return 'claude';
}

/** Build the stdout JSON for a result in the agent's dialect. */
export function renderOutput(agent: AgentId, event: HookEvent, r: HookResult): Record<string, unknown> | null {
  if (r.stdout) return r.stdout;
  if (event === 'PreToolUse') {
    if (r.exitCode === 2) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: r.stderr ?? 'denied by harness guard',
        },
      };
    }
    if (r.additionalContext) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.additionalContext } };
    }
    return null;
  }
  if (event === 'Stop' || event === 'SubagentStop' || event === 'TaskCompleted' || event === 'UserPromptSubmit' || event === 'PreCompact') {
    if (r.exitCode === 2) return { decision: 'block', reason: r.stderr ?? 'blocked by harness' };
    if (r.additionalContext && event === 'UserPromptSubmit') {
      return { hookSpecificOutput: { hookEventName: event, additionalContext: r.additionalContext } };
    }
    return null;
  }
  if (r.additionalContext) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: r.additionalContext } };
  }
  return null;
}

/**
 * The session state the Stop-like checks depend on (edits logged, shell calls, blocks counted). Part of their
 * dedupe key, so a Stop after a new edit, a gate run or a block is evaluated again instead of being answered
 * from an earlier, identical-looking call (that answer could be a stale exit 0: fail open).
 */
function sessionStamp(sid: string, agent: AgentId): string {
  try {
    const s = loadSession(sid, agent);
    const blocks = Object.values(s.attempts ?? {}).reduce((n, v) => n + (typeof v === 'number' ? v : 0), 0);
    return `${s.edits.length}:${s.shellRuns ?? 0}:${blocks}`;
  } catch {
    return `nostate:${Date.now()}`;
  }
}

function dedupeKey(event: HookEvent, input: HookInput, agent: AgentId): string | null {
  const sid = input.session_id;
  if (!sid) return null;
  const ti = input.tool_input;
  const parts = [event, sid];
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    parts.push(input.tool_name ?? '', sha256(JSON.stringify(ti ?? '')).slice(0, 16));
    if (typeof (input as any).tool_use_id === 'string') parts.push((input as any).tool_use_id);
  } else if (event === 'UserPromptSubmit') {
    parts.push(sha256(String(input.prompt ?? '')).slice(0, 16));
  } else if (event === 'Stop' || event === 'SubagentStop' || event === 'TaskCompleted') {
    parts.push(String(input.stop_hook_active ?? ''), sha256(String((input as any).last_assistant_message ?? '')).slice(0, 16), sessionStamp(String(sid), agent));
  } else {
    parts.push(String(input.source ?? ''));
  }
  return sha256(parts.join('|'));
}

/**
 * Returns the previous result when this exact invocation already ran in the
 * last few seconds (double registration), else records this one.
 */
function dedupe(key: string | null, result?: HookResult): HookResult | null {
  if (!key) return null;
  const dir = path.join(stateDir(), 'dedupe');
  const file = path.join(dir, key + '.json');
  if (!result) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < 10_000) return JSON.parse(fs.readFileSync(file, 'utf8')) as HookResult;
    } catch {
      /* none */
    }
    return null;
  }
  try {
    ensureDir(dir);
    fs.writeFileSync(file, JSON.stringify(result));
  } catch {
    /* ignore */
  }
  return null;
}

export async function runHook(argv: string[]): Promise<number> {
  const event = argv.find((a) => EVENTS.includes(a as HookEvent)) as HookEvent | undefined;
  if (!event) {
    process.stderr.write(`harness hook: unknown or missing event (${argv.join(' ')})\n`);
    return 0;
  }
  const raw = await readStdin(event === 'Stop' ? 1500 : 5000);
  let input: HookInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    input = {};
  }
  const agent = detectAgent(argv, input);
  const ctx: HookContext = { agent, event, sessionId: String(input.session_id ?? 'nosession') };

  const integrity = verifyIntegrity();
  if (!integrity.ok) {
    const msg = `harness integrity check failed: ${integrity.reason}. Run \`harness doctor\`.`;
    instrument({ event: 'hook.integrity_fail', sessionId: ctx.sessionId, agent, ids: { hook: event } });
    if (FAIL_CLOSED.has(event)) return emit(agent, event, { exitCode: 2, stderr: msg });
    process.stderr.write(msg + '\n');
    return 0;
  }

  const key = dedupeKey(event, input, agent);
  // A cached PreToolUse allow is never reused (the state it was decided on may have changed); a denial is.
  const cached = dedupe(key);
  const prior = cached && !(event === 'PreToolUse' && cached.exitCode === 0) ? cached : null;
  if (prior) {
    instrument({ event: 'hook.dedupe', sessionId: ctx.sessionId, agent, ids: { hook: event } });
    return emit(agent, event, prior);
  }

  let result: HookResult;
  try {
    const mod = require(`./hooks/${event}`) as { handle: HookHandler };
    result = await Promise.race([
      Promise.resolve(mod.handle(input, ctx)),
      new Promise<HookResult>((resolve) =>
        setTimeout(
          () => resolve({ exitCode: FAIL_CLOSED.has(event) ? 2 : 0, stderr: `harness hook ${event} timed out` }),
          event === 'Stop' ? 1800 : 20_000,
        ),
      ),
    ]);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`hooks/${event}`)) {
      result = { exitCode: 0 };
    } else {
      instrument({ event: 'hook.error', sessionId: ctx.sessionId, agent, ids: { hook: event } });
      result = FAIL_CLOSED.has(event)
        ? { exitCode: 2, stderr: `harness hook ${event} failed closed: ${err.message}` }
        : { exitCode: 0, stderr: `harness hook ${event} error: ${err.message}` };
    }
  }
  dedupe(key, result);
  instrument({ event: `hook.${event}`, sessionId: ctx.sessionId, agent, counts: { exit: result.exitCode } });
  return emit(agent, event, result);
}

function emit(agent: AgentId, event: HookEvent, r: HookResult): number {
  const out = renderOutput(agent, event, r);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
  if (r.stderr && r.exitCode === 2) process.stderr.write(r.stderr + '\n');
  else if (r.stderr) process.stderr.write(r.stderr + '\n');
  // Codex: plain text is invalid for Stop, so JSON is always written on exit 2 above.
  return r.exitCode;
}

if (require.main === module) {
  runHook(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`harness hook crashed: ${(e as Error).message}\n`);
      process.exit(2);
    },
  );
}
