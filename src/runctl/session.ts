/**
 * Fresh headless agent sessions for the runner and the landing actor's
 * auto-fix attempt (DESIGN §2.13). One interface, so tests inject a scripted
 * session and never start an agent.
 *
 * Command shapes (argv arrays, no shell):
 *   claude -p <prompt> --output-format json --max-turns <n>
 *          [--max-budget-usd <usd>] [--model <m>] [--permission-mode <mode>]
 *   codex exec --full-auto [--model <m>] <prompt>          (first attempt)
 *   codex exec resume --last <prompt>                      (re-prompt with the gate output)
 * Claude sessions also get `--allowedTools` with the allow rules of the
 * working folder's committed `.claude/settings.json` (read from HEAD before
 * the session starts): Claude Code applies a project's allow rules only after
 * its trust dialog was accepted, which a headless session in a fresh task
 * worktree never has, so without them every verification command the harness
 * allows (`harness gate`, the test runner) would be refused as "requires
 * approval". Deny rules and the guard hook apply as always.
 * Wall time is the process timeout. Codex has no turn or budget flag; its
 * caps are wall time and the attempt count. A cap hit is reported as a cap
 * (`turns`, `wall`, `budget`), never retried.
 */
import type { CapKind } from './caps';
import { runAsync, which } from '../lib/exec';
import { rawGit } from '../lib/git';
import { tryParseJsonc } from '../lib/jsonc';

export type SessionAgent = 'claude' | 'codex';

export interface SessionCaps {
  turns: number;
  wallMinutes: number;
  budgetUsd?: number;
}

export interface SessionRequest {
  agent: SessionAgent;
  cwd: string;
  prompt: string;
  caps: SessionCaps;
  model?: string;
  /** Claude permission mode (default acceptEdits: edits allowed; commands follow the installed allow and deny rules and the guard). */
  permissionMode?: string;
  /** Codex: continue the last session with this prompt (`codex exec resume --last`). */
  resume?: boolean;
  /** Claude: allow rules for `--allowedTools` (default: the committed project allow rules of `cwd`). */
  allowedTools?: string[];
  env?: Record<string, string>;
  purpose: 'task' | 'fix' | 'resume';
}

export interface SessionResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  capHit: CapKind | null;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  subtype?: string;
  durationMs: number;
  /** One line for the report (never the transcript). */
  detail: string;
}

export interface SessionRunner {
  available(agent: SessionAgent): { ok: true } | { ok: false; reason: string };
  run(req: SessionRequest): Promise<SessionResult>;
}

/** The exact argv for a request. */
export function sessionCommand(req: SessionRequest): { cmd: string; args: string[] } {
  if (req.agent === 'claude') {
    const args = ['-p', req.prompt, '--output-format', 'json', '--max-turns', String(Math.max(1, Math.floor(req.caps.turns)))];
    if (req.caps.budgetUsd !== undefined && req.caps.budgetUsd > 0) args.push('--max-budget-usd', String(req.caps.budgetUsd));
    if (req.model) args.push('--model', req.model);
    args.push('--permission-mode', req.permissionMode ?? 'acceptEdits');
    // Last: the flag takes every following argument as a rule.
    if (req.allowedTools?.length) args.push('--allowedTools', ...req.allowedTools);
    return { cmd: 'claude', args };
  }
  if (req.resume) return { cmd: 'codex', args: ['exec', 'resume', '--last', req.prompt] };
  const args = ['exec', '--full-auto'];
  if (req.model) args.push('--model', req.model);
  args.push(req.prompt);
  return { cmd: 'codex', args };
}

export interface ClaudeJson {
  subtype?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
}

/** The last JSON object line of `claude -p --output-format json`. */
export function parseClaudeResult(stdout: string): ClaudeJson | null {
  const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]) as ClaudeJson;
      if (j && typeof j === 'object') return j;
    } catch {
      /* try the previous line */
    }
  }
  return null;
}

/** Which cap a finished session hit, from its exit and result. */
export function capFromResult(r: { timedOut: boolean; subtype?: string; costUsd?: number; turns?: number }, caps: SessionCaps): CapKind | null {
  if (r.timedOut) return 'wall';
  const st = (r.subtype ?? '').toLowerCase();
  if (st.includes('max_turns')) return 'turns';
  if (st.includes('budget')) return 'budget';
  if (caps.budgetUsd !== undefined && r.costUsd !== undefined && r.costUsd >= caps.budgetUsd) return 'budget';
  return null;
}

/**
 * The allow rules of a folder's committed `.claude/settings.json` (at HEAD, so nothing written in the
 * working tree changes them), as `--allowedTools` takes them. Empty when there is no such file.
 */
export function committedClaudeAllowRules(dir: string): string[] {
  const r = rawGit(dir, ['show', 'HEAD:.claude/settings.json'], 10_000);
  if (r.code !== 0) return [];
  const parsed = tryParseJsonc<{ permissions?: { allow?: unknown } }>(r.stdout);
  if (!parsed.ok || !parsed.value) return [];
  const allow = parsed.value.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((x): x is string => typeof x === 'string' && /^[A-Za-z]\w*(\(.*\))?$/.test(x.trim())).map((x) => x.trim()) : [];
}

function oneLine(s: string, max = 200): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Starts real `claude` / `codex` processes. */
export function defaultSessionRunner(): SessionRunner {
  return {
    available(agent) {
      if (process.env.HARNESS_SKIP_AGENTS === '1') return { ok: false, reason: 'HARNESS_SKIP_AGENTS=1' };
      return which(agent) ? { ok: true } : { ok: false, reason: `${agent} is not on PATH` };
    },
    async run(req) {
      const { cmd, args } = sessionCommand(req.agent === 'claude' && req.allowedTools === undefined ? { ...req, allowedTools: committedClaudeAllowRules(req.cwd) } : req);
      const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_AGENT: req.agent, HARNESS_RUN: req.purpose, ...(req.env ?? {}) };
      delete env.NODE_TEST_CONTEXT;
      const r = await runAsync(cmd, args, { cwd: req.cwd, env, timeoutMs: Math.max(1, req.caps.wallMinutes) * 60_000 });
      if (req.agent === 'claude') {
        const j = parseClaudeResult(r.stdout);
        const res = { timedOut: r.timedOut, subtype: j?.subtype, costUsd: j?.total_cost_usd, turns: j?.num_turns };
        const cap = capFromResult(res, req.caps);
        const ok = r.code === 0 && !!j && !j.is_error && !cap;
        return {
          ok,
          exitCode: r.code,
          timedOut: r.timedOut,
          capHit: cap,
          ...(j?.total_cost_usd !== undefined ? { costUsd: j.total_cost_usd } : {}),
          ...(j?.num_turns !== undefined ? { turns: j.num_turns } : {}),
          ...(j?.session_id ? { sessionId: j.session_id } : {}),
          ...(j?.subtype ? { subtype: j.subtype } : {}),
          durationMs: r.durationMs,
          detail: cap ? `cap reached: ${cap}` : j ? `claude ${j.subtype ?? 'finished'} after ${j.num_turns ?? '?'} turn(s)` : `claude exited ${r.code}${r.stderr ? `: ${oneLine(r.stderr)}` : ''}`,
        };
      }
      const cap = r.timedOut ? ('wall' as const) : null;
      return { ok: r.code === 0 && !cap, exitCode: r.code, timedOut: r.timedOut, capHit: cap, durationMs: r.durationMs, detail: cap ? 'cap reached: wall' : `codex exited ${r.code}` };
    },
  };
}
