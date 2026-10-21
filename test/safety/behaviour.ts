/**
 * Behaviour variants of the safety tests: the same scenario through a real
 * `claude -p` session (cheap model, few turns, tight timeout) with the
 * harness hooks registered in an isolated HOME. Claude's own permission
 * layer is opened for the tools under test (`--allowedTools`), so a denial
 * can only come from the harness hook; the proof is read from three places:
 *
 *   - the hook's own instrumentation (`guard.deny` with the rail id) under HARNESS_HOME,
 *   - `permission_denials` in claude's JSON result,
 *   - the session transcript (the tool_use the model attempted and the reason it got back).
 *
 * When the model never attempts a command the scenario is inconclusive and
 * the caller skips with that reason (a model's refusal is not a rail).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeAvailable, harnessHookEntry, runClaude, type ClaudeRunResult } from '../behaviour/claude-runner';
import type { Sandbox } from './helpers';
import { events } from './helpers';

export const BEHAVIOUR_MODEL = process.env.HARNESS_SAFETY_MODEL || 'claude-haiku-5-5';

export function behaviourSkipReason(): string | null {
  if (process.env.HARNESS_SAFETY_BEHAVIOUR === '0') return 'HARNESS_SAFETY_BEHAVIOUR=0';
  const a = claudeAvailable();
  return a.ok ? null : a.reason;
}

export interface TranscriptView {
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  toolResults: string[];
}

export function readTranscript(home: string): TranscriptView {
  const view: TranscriptView = { toolUses: [], toolResults: [] };
  const projects = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projects)) return view;
  for (const d of fs.readdirSync(projects)) {
    const dir = path.join(projects, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j: any;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        const content = j?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (c?.type === 'tool_use') view.toolUses.push({ name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> });
          if (c?.type === 'tool_result') view.toolResults.push(typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''));
        }
      }
    }
  }
  return view;
}

export interface BehaviourRun {
  run: ClaudeRunResult;
  transcript: TranscriptView;
  /** rail ids of `guard.deny` events this run added. */
  guardDenies: string[];
  denials: Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>;
  summary: string;
}

export interface BehaviourOptions {
  prompt: string;
  cwd: string;
  allowedTools: string[];
  /** Hook events to register (default PreToolUse only). */
  hooks?: Array<{ event: string; matcher?: string; timeout?: number }>;
  hookJs: string;
  maxTurns?: number;
  permissionMode?: string;
  env?: Record<string, string>;
  /** Extra settings merged into the isolated user settings (e.g. rendered permissions). */
  settings?: Record<string, unknown>;
  /** Runs again when the model made no tool call at all (it declined); default 1 retry. */
  retries?: number;
}

/** One scenario; when the model declines outright (no tool call) it is run again, up to `retries` times. */
export function runBehaviour(sb: Sandbox, o: BehaviourOptions): BehaviourRun {
  const tries = 1 + Math.max(0, o.retries ?? 1);
  let b = runBehaviourOnce(sb, o);
  let n = 1;
  let cost = Number(b.run.costUsd ?? 0);
  while (n < tries && b.transcript.toolUses.length === 0 && b.denials.length === 0 && b.run.ok) {
    b = runBehaviourOnce(sb, o);
    cost += Number(b.run.costUsd ?? 0);
    n++;
  }
  return { ...b, summary: `${b.summary} attempts=${n} total_cost_usd=${cost.toFixed(5)}` };
}

function runBehaviourOnce(sb: Sandbox, o: BehaviourOptions): BehaviourRun {
  const before = events(sb).length;
  const hooks: Record<string, unknown[]> = {};
  for (const h of o.hooks ?? [{ event: 'PreToolUse', matcher: '*' }]) {
    (hooks[h.event] ??= []).push(harnessHookEntry(o.hookJs, h.event, h.matcher, h.timeout ?? 20));
  }
  const r = runClaude({
    prompt: o.prompt,
    cwd: o.cwd,
    maxTurns: o.maxTurns ?? 6,
    model: BEHAVIOUR_MODEL,
    allowedTools: o.allowedTools,
    permissionMode: o.permissionMode,
    userSettings: { ...(o.settings ?? {}), hooks },
    env: { HARNESS_HOME: sb.home, HARNESS_USER_HOME: sb.userHome, HARNESS_AGENT: 'claude', ...(o.env ?? {}) },
    timeoutMs: 240_000,
  });
  const transcript = readTranscript(r.home);
  try {
    fs.rmSync(r.home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  const guardDenies = events(sb)
    .slice(before)
    .filter((e) => e.event === 'guard.deny')
    .map((e) => e.ids?.rail ?? '');
  const denials = (r.permissionDenials ?? []) as BehaviourRun['denials'];
  const summary = `model=${BEHAVIOUR_MODEL} exit=${r.exitCode} turns=${r.numTurns} cost_usd=${r.costUsd} tool_uses=${transcript.toolUses.length} permission_denials=${denials.length} guard_denies=[${guardDenies.join(',')}]`;
  return { run: r, transcript, guardDenies, denials, summary };
}

/** The tool calls and their results, shortened (for failure messages; the sandbox paths are not secrets). */
export function describe(b: BehaviourRun): string {
  const uses = b.transcript.toolUses.map((u) => `${u.name}(${JSON.stringify(u.input).slice(0, 120)})`);
  const results = b.transcript.toolResults.map((r) => r.slice(0, 160));
  return `tool uses: ${uses.join(' | ')}\nresults: ${results.join(' | ')}`;
}

/** Did the model attempt a shell command matching `re` (transcript tool_use or a permission denial)? */
export function attempted(b: BehaviourRun, re: RegExp): boolean {
  const cmd = (x: Record<string, unknown> | undefined) => String(x?.command ?? x?.file_path ?? x?.path ?? '');
  return b.transcript.toolUses.some((u) => re.test(cmd(u.input))) || b.denials.some((d) => re.test(cmd(d.tool_input)));
}

/** Did the model receive a tool result whose text matches `re` (the hook's reason)? */
export function sawReason(b: BehaviourRun, re: RegExp): boolean {
  return b.transcript.toolResults.some((t) => re.test(t));
}
