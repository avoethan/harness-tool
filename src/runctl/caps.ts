/**
 * Per-unit caps and stop-the-line detection (DESIGN §2.13).
 *
 * Caps (chosen, no evidence): turns, wall minutes per unit and per ticket,
 * budget, gate attempts; from the machine config (`caps`), narrowed (never
 * widened) by runner flags. A cap hit is a reportable outcome: the task is
 * failed with reason `cap:<kind>` and never retried by the runner.
 *
 * Stop the line: fixed triggers, each returning a reason the agent reports
 * (never a question):
 *   rail             the next command would be refused by a rail, or a rail
 *                    already refused a command in this session;
 *   irreversible     the next command cannot be undone by reverting a commit
 *                    (dropping data, a force-push, deleting a branch, ...),
 *                    or the agent declares such a step is needed;
 *   repeated-failure the same gate step failed in 3 consecutive full gate
 *                    runs whose inputs changed in between (after fixes);
 *   not-reproducible a bug task's reproduction check passes at the base
 *                    commit, or the agent declares it cannot reproduce it;
 *   scope            files outside the task's units' paths changed (test
 *                    files and the task ledger are not counted).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessConfig, InstrumentationEvent } from '../types';
import { DEFAULT_CAPS } from '../types';
import { logsDir } from '../lib/paths';
import { pathsOverlap } from '../intake/ledger';
import type { BriefFile } from '../intake/brief';
import { isTestFile } from '../gate/context';
import type { SessionCaps } from './session';

export type CapKind = 'turns' | 'wall' | 'budget' | 'gate-attempts' | 'ticket-wall';

export interface RunCaps {
  turns: number;
  unitMinutes: number;
  ticketMinutes: number;
  gateAttempts: number;
  budgetUsd?: number;
  /** Codex driver loop: re-prompts with the gate output (`codex exec resume --last`). */
  codexAttempts: number;
}

export const DEFAULT_CODEX_ATTEMPTS = 3;

function positive(n: unknown): number | undefined {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Caps from the machine config, narrowed by overrides (a flag can lower a cap, never raise it). */
export function capsFromConfig(config: Pick<HarnessConfig, 'caps'> | null, overrides: Partial<RunCaps> = {}): RunCaps {
  const c = { ...DEFAULT_CAPS, ...(config?.caps ?? {}) };
  const lower = (base: number | undefined, o: number | undefined): number | undefined => {
    if (o === undefined) return base;
    if (base === undefined) return o;
    return Math.min(base, o);
  };
  const budget = lower(positive(c.budgetUsd), positive(overrides.budgetUsd));
  return {
    turns: lower(positive(c.turns) ?? DEFAULT_CAPS.turns, positive(overrides.turns))!,
    unitMinutes: lower(positive(c.unitMinutes) ?? DEFAULT_CAPS.unitMinutes, positive(overrides.unitMinutes))!,
    ticketMinutes: lower(positive(c.ticketMinutes) ?? DEFAULT_CAPS.ticketMinutes, positive(overrides.ticketMinutes))!,
    gateAttempts: lower(positive(c.gateAttempts) ?? DEFAULT_CAPS.gateAttempts, positive(overrides.gateAttempts))!,
    ...(budget !== undefined ? { budgetUsd: budget } : {}),
    codexAttempts: Math.max(1, Math.floor(positive(overrides.codexAttempts) ?? DEFAULT_CODEX_ATTEMPTS)),
  };
}

/** The caps one session gets: the unit's wall time, never more than what is left of the ticket's. */
export function sessionCaps(c: RunCaps, ticketMinutesLeft?: number): SessionCaps {
  const wall = ticketMinutesLeft === undefined ? c.unitMinutes : Math.max(0, Math.min(c.unitMinutes, ticketMinutesLeft));
  return { turns: c.turns, wallMinutes: wall, ...(c.budgetUsd !== undefined ? { budgetUsd: c.budgetUsd } : {}) };
}

/** The ledger reason for a cap hit. */
export function capReason(kind: CapKind): string {
  return `cap:${kind}`;
}

// ---------------------------------------------------------------------------
// Stop the line
// ---------------------------------------------------------------------------

export type StopKind = 'rail' | 'irreversible' | 'repeated-failure' | 'not-reproducible' | 'scope';

export interface StopReason {
  kind: StopKind;
  /** One sentence the agent reports (and records with `harness gate --blocked`). */
  reason: string;
  detail?: string[];
}

export interface StopInput {
  repoRoot: string;
  /** Repo id the gate writes under for this worktree. */
  repoId: string;
  taskId: string;
  /** The diff base for the scope check (the task's base commit). */
  base?: string | null;
  /** The units' paths and the task's paths; empty means the whole repository. */
  allowedPaths: string[];
  /** A command the agent is about to run. */
  command?: string;
  /** Declared by the agent: an irreversible step it needs. */
  irreversible?: string;
  /** Declared by the agent: the problem does not reproduce. */
  notReproduced?: string;
  sessionId?: string;
  brief?: BriefFile | null;
  /** Instrumentation events (default: read ~/.harness/logs/events.jsonl). */
  events?: InstrumentationEvent[];
  /** Changed files (default: git diff against the base plus untracked files). */
  changed?: string[];
  /** Guard decision for a command (default: the real guard). */
  guard?: (command: string, cwd: string) => { decision: 'allow' | 'deny'; rail?: string; reason?: string };
  /** Task title (for the bug-task heuristic). */
  title?: string;
}

const IRREVERSIBLE: Array<{ re: RegExp; what: string }> = [
  { re: /\bdrop\s+(?:table|database|schema|view|index|procedure|function)\b/i, what: 'drops a database object' },
  { re: /\btruncate\s+table\b/i, what: 'truncates a table' },
  { re: /\bdelete\s+from\s+[\w.[\]"`]+\s*(?:;|$|'|")/i, what: 'deletes every row of a table (no WHERE)' },
  { re: /\balter\s+table\b[^;]*\bdrop\s+column\b/i, what: 'drops a column' },
  { re: /\bgit\s+push\b[^;|&]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S+|\s--delete\b|\s-d\b|\s--mirror\b)/i, what: 'rewrites or deletes a remote branch' },
  { re: /\bgit\s+branch\s+(?:-D|--delete\s+--force|-d\s+--force)\b/, what: 'deletes a branch with unmerged work' },
  { re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|filter-branch|filter-repo|rebase)\b/i, what: 'discards or rewrites history or uncommitted work' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME)(?:\s|$)/i, what: 'deletes a home or root folder' },
  { re: /\b(?:dropdb|mongo\w*\s+.*dropDatabase|redis-cli\s+flushall)\b/i, what: 'drops a data store' },
  { re: /\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b/i, what: 'publishes outside this machine' },
];

/** Whether a command cannot be undone by reverting a commit; returns what it does. */
export function irreversibleWhat(command: string): string | null {
  for (const r of IRREVERSIBLE) if (r.re.test(command)) return r.what;
  return null;
}

/** Instrumentation events from the log (the newest 8 MB at most). */
export function readEvents(file = path.join(logsDir(), 'events.jsonl')): InstrumentationEvent[] {
  let text: string;
  try {
    const st = fs.statSync(file);
    const max = 8 * 1024 * 1024;
    if (st.size > max) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(max);
        fs.readSync(fd, buf, 0, max, st.size - max);
        text = buf.toString('utf8');
        text = text.slice(text.indexOf('\n') + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: InstrumentationEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as InstrumentationEvent);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

export interface GateRunLog {
  partial: boolean;
  attempt: number;
  steps: Array<{ name: string; status: string; cache: string }>;
}

/** Gate runs of one task in log order: `gate.step` events up to their `gate.verdict` / `gate.partial`. */
export function gateRuns(events: InstrumentationEvent[], repoId: string, taskId: string): GateRunLog[] {
  const runs: GateRunLog[] = [];
  let cur: GateRunLog['steps'] = [];
  for (const e of events) {
    if (e.repo !== repoId || e.task !== taskId) continue;
    if (e.event === 'gate.step') cur.push({ name: e.ids?.step ?? '?', status: e.ids?.status ?? '?', cache: e.ids?.cache ?? 'off' });
    else if (e.event === 'gate.verdict' || e.event === 'gate.partial') {
      runs.push({ partial: e.event === 'gate.partial', attempt: e.counts?.attempt ?? 0, steps: cur });
      cur = [];
    }
  }
  return runs;
}

/** Steps that failed in `n` consecutive full runs, each recomputed (inputs changed: a fix was tried). */
export function repeatedFailures(runs: GateRunLog[], n = 3): Array<{ step: string; times: number }> {
  const full = runs.filter((r) => !r.partial);
  const names = new Set(full.flatMap((r) => r.steps.map((s) => s.name)));
  const out: Array<{ step: string; times: number }> = [];
  for (const name of names) {
    let times = 0;
    for (let i = full.length - 1; i >= 0; i--) {
      const s = full[i].steps.find((x) => x.name === name);
      if (!s || s.status !== 'fail') break;
      if (s.cache === 'hit') continue; // unchanged inputs: no fix was tried in between, so not counted
      times++;
    }
    if (times >= n) out.push({ step: name, times });
  }
  return out;
}

function defaultGuard(command: string, cwd: string): { decision: 'allow' | 'deny'; rail?: string; reason?: string } {
  const { evaluate } = require('../guard') as typeof import('../guard');
  const { buildGuardInput } = require('../hooks/PreToolUse') as typeof import('../hooks/PreToolUse');
  const agent = (process.env.HARNESS_AGENT === 'codex' || process.env.HARNESS_AGENT === 'devin' ? process.env.HARNESS_AGENT : 'claude') as 'claude' | 'codex' | 'devin';
  const gi = buildGuardInput({ tool_name: agent === 'devin' ? 'exec' : 'Bash', tool_input: { command }, cwd }, { agent, event: 'PreToolUse', sessionId: 'check-stop' });
  const d = evaluate(gi);
  return d.decision === 'deny' ? { decision: 'deny', rail: d.rail, reason: d.reason } : { decision: 'allow' };
}

function changedSince(root: string, base: string | null | undefined): string[] {
  const { git, dirtyPaths } = require('../land/gitops') as typeof import('../land/gitops');
  const out = new Set<string>();
  if (base) {
    const r = git(root, ['diff', '--name-only', '--no-renames', base], 30_000);
    if (r.code === 0) for (const l of r.stdout.split(/\r?\n/)) if (l.trim()) out.add(l.trim());
  }
  for (const p of dirtyPaths(root)) out.add(p);
  return [...out];
}

const BUGGY = /\b(?:bug|fix(?:es|ed)?|broken|crash(?:es)?|regression|error|fails?|wrong)\b/i;

/** Every stop-the-line condition that holds now. Empty means keep going. */
export function checkStop(input: StopInput): StopReason[] {
  const out: StopReason[] = [];
  // 1. Rails.
  if (input.command) {
    const d = (input.guard ?? defaultGuard)(input.command, input.repoRoot);
    if (d.decision === 'deny') out.push({ kind: 'rail', reason: `the next command is refused by the ${d.rail ?? 'safety'} rail; it needs a person, not another spelling`, detail: d.reason ? [d.reason] : undefined });
  }
  const events = input.events ?? readEvents();
  if (input.sessionId) {
    const denials = events.filter((e) => e.event === 'guard.deny' && e.sessionId === input.sessionId);
    if (denials.length) {
      const rails = [...new Set(denials.map((e) => e.ids?.rail ?? 'safety'))];
      out.push({ kind: 'rail', reason: `${denials.length} command(s) in this session were refused by a rail (${rails.join(', ')}); the work needs a step only a person may take`, detail: rails });
    }
  }
  // 2. Irreversible actions.
  if (input.command) {
    const what = irreversibleWhat(input.command);
    if (what) out.push({ kind: 'irreversible', reason: `the next command ${what}, which reverting a commit cannot undo` });
  }
  if (input.irreversible?.trim()) out.push({ kind: 'irreversible', reason: `an irreversible step is needed: ${input.irreversible.trim().slice(0, 200)}` });
  // 3. The same gate step failing after fixes.
  const rep = repeatedFailures(gateRuns(events, input.repoId, input.taskId));
  for (const r of rep) out.push({ kind: 'repeated-failure', reason: `gate step ${r.step} failed ${r.times} times in a row after fixes` });
  // 4. Not reproducible.
  if (input.notReproduced?.trim()) out.push({ kind: 'not-reproducible', reason: `the problem cannot be reproduced: ${input.notReproduced.trim().slice(0, 200)}` });
  const brief = input.brief;
  if (brief) {
    const bugTask = BUGGY.test(input.title ?? brief.title ?? '');
    for (const c of brief.criteria) {
      const proof = c.check?.redProof;
      if (!proof || proof.result !== 'green' || c.check?.greenAtBase) continue;
      const fromExpected = brief.criteriaMeta?.[c.id]?.source === 'expected';
      if (bugTask || fromExpected) out.push({ kind: 'not-reproducible', reason: `${c.id}'s reproduction check passes at the base commit ${proof.baseSha.slice(0, 10)}: the reported problem does not happen there` });
    }
  }
  // 5. Scope.
  if (input.allowedPaths.length) {
    const changed = input.changed ?? changedSince(input.repoRoot, input.base);
    const outside = changed.filter((f) => !isTestFile(f) && !f.startsWith('tasks/') && !pathsOverlap([f], input.allowedPaths));
    if (outside.length) out.push({ kind: 'scope', reason: `${outside.length} changed file(s) lie outside the task's paths (${input.allowedPaths.join(', ')}): the work grew beyond the brief`, detail: outside.slice(0, 20) });
  }
  return out;
}

/** The units' paths of a brief plus the ledger task's paths (deduplicated). */
export function allowedPathsFor(brief: BriefFile | null, taskPaths: string[] = []): string[] {
  const set = new Set<string>(taskPaths);
  for (const u of brief?.units ?? []) for (const p of u.paths ?? []) set.add(p);
  return [...set].filter(Boolean);
}
