/**
 * The self-checks the user runs on the work machine (harness/selfcheck/*.md)
 * and the record of their results.
 *
 *   harness selfcheck record --agent devin --step 4 --result "<text>" [--outcome expected|different|noted]
 *     -> ~/.harness/selfcheck/<agent>.json
 *
 * The step numbers and ids here are the ones the documents use; a test keeps
 * them in step. The result text stays on the machine: the report carries only
 * step ids and whether the result matched what the document expects.
 */
import * as path from 'node:path';
import type { AgentId, SelfcheckSummary } from '../types';
import { harnessHome } from '../lib/paths';
import { readJsonOr, writeJson } from '../lib/fsx';
import { stripHiddenUnicode } from '../lib/unicode';

export interface SelfcheckStep {
  n: number;
  id: string;
  title: string;
}

/** Agents that have a self-check document. */
export type SelfcheckAgent = Extract<AgentId, 'devin' | 'codex'>;
export const SELFCHECK_AGENTS: SelfcheckAgent[] = ['devin', 'codex'];

export const SELFCHECK_DOCS: Record<SelfcheckAgent, string> = {
  devin: 'selfcheck/devin-desktop.md',
  codex: 'selfcheck/codex.md',
};

export const DEVIN_STEPS: SelfcheckStep[] = [
  { n: 1, id: 'version-trust', title: 'Devin Local version and a trusted folder (no Restricted Mode)' },
  { n: 2, id: 'doctor', title: 'harness doctor sees the Devin hooks and a good integrity check' },
  { n: 3, id: 'probe-files', title: 'Write the probe files and probe hooks' },
  { n: 4, id: 'markers', title: 'Markers in a session on the workspace folder (always-on file, SessionStart context)' },
  { n: 5, id: 'size-probe', title: 'Always-on size probe (a marker after byte 17,000)' },
  { n: 6, id: 'project-dir', title: 'DEVIN_PROJECT_DIR and the working folder when the folder is not a git repository' },
  { n: 7, id: 'tool-input-fields', title: 'tool_input field names per tool' },
  { n: 8, id: 'guard-block', title: 'A PreToolUse block from the harness guard (force-push refused)' },
  { n: 9, id: 'stop-gate', title: 'The Stop hook asks for the done-gate after an edit' },
  { n: 10, id: 'stop-consecutive', title: 'Consecutive Stop blocks' },
  { n: 11, id: 'stop-timeout', title: 'A Stop hook that runs past its timeout' },
  { n: 12, id: 'handoff-warning', title: 'UserPromptSubmit context followed (the /handoff warning)' },
  { n: 13, id: 'scoped-rule', title: 'A scoped rule loads in a sub-repository session' },
  { n: 14, id: 'bypass-rails', title: 'The rails in Bypass mode' },
  { n: 15, id: 'session-visibility', title: 'Local sessions in the Devin web app' },
  { n: 16, id: 'cleanup', title: 'Remove the probes; harness doctor is clean' },
];

export const CODEX_STEPS: SelfcheckStep[] = [
  { n: 1, id: 'version', title: 'Codex version and doctor' },
  { n: 2, id: 'instruction-chain', title: 'Instruction chain: the harness file first, the repository file after it' },
  { n: 3, id: 'skills', title: 'The harness skills are listed' },
  { n: 4, id: 'hooks-trusted', title: 'The harness hooks are trusted (SessionStart heartbeat)' },
  { n: 5, id: 'pretooluse-block', title: 'A PreToolUse block from the harness guard (force-push refused)' },
  { n: 6, id: 'stop-reprompt', title: 'The Stop hook re-prompts once for the done-gate' },
  { n: 7, id: 'trust-gating', title: 'A changed hook is skipped until trusted again' },
  { n: 8, id: 'sandbox-commit', title: 'git commit inside the workspace-write sandbox' },
  { n: 9, id: 'disable-list', title: 'Flags that switch the rails off' },
  { n: 10, id: 'cleanup', title: 'Remove the probes; harness doctor is clean' },
];

export function stepsFor(agent: SelfcheckAgent): SelfcheckStep[] {
  return agent === 'devin' ? DEVIN_STEPS : CODEX_STEPS;
}

export function isSelfcheckAgent(a: string): a is SelfcheckAgent {
  return (SELFCHECK_AGENTS as string[]).includes(a);
}

export type StepOutcome = 'expected' | 'different' | 'noted';

export interface StepRecord {
  id: string;
  outcome: StepOutcome;
  /** The user's own words; kept on this machine, never in the report. */
  result: string;
  at: string;
}

export interface SelfcheckFile {
  version: 1;
  agent: SelfcheckAgent;
  steps: Record<string, StepRecord>;
  updatedAt: string;
}

export function selfcheckDir(): string {
  return path.join(harnessHome(), 'selfcheck');
}

export function selfcheckPath(agent: SelfcheckAgent): string {
  return path.join(selfcheckDir(), `${agent}.json`);
}

export function loadSelfcheck(agent: SelfcheckAgent): SelfcheckFile | null {
  const f = readJsonOr<SelfcheckFile | null>(selfcheckPath(agent), null);
  return f && f.version === 1 && f.steps && typeof f.steps === 'object' ? f : null;
}

/** The outcome a result text states with its first word: "pass ...", "ok", "yes" / "fail ...", "different", "no". */
export function outcomeOf(result: string): StepOutcome {
  const t = result.trim().toLowerCase();
  if (/^(pass(ed)?|ok|okay|yes|expected|as expected|confirmed|same|matches|worked)\b/.test(t)) return 'expected';
  if (/^(fail(ed)?|no|different|differs|unexpected|not as expected|did not|didn't|broken|wrong)\b/.test(t)) return 'different';
  return 'noted';
}

export function parseOutcome(raw: string | undefined): StepOutcome | null {
  if (raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  if (t === 'expected' || t === 'pass' || t === 'ok') return 'expected';
  if (t === 'different' || t === 'fail') return 'different';
  if (t === 'noted') return 'noted';
  return null;
}

export function recordStep(agent: SelfcheckAgent, n: number, result: string, outcome?: StepOutcome, now: Date = new Date()): StepRecord {
  const step = stepsFor(agent).find((s) => s.n === n);
  if (!step) throw new Error(`no step ${n} in the ${agent} self-check (steps 1 to ${stepsFor(agent).length})`);
  const text = stripHiddenUnicode(result).replace(/\s+/g, ' ').trim().slice(0, 500);
  const rec: StepRecord = { id: step.id, outcome: outcome ?? outcomeOf(text), result: text, at: now.toISOString() };
  const file = loadSelfcheck(agent) ?? { version: 1 as const, agent, steps: {}, updatedAt: rec.at };
  file.steps[String(n)] = rec;
  file.updatedAt = rec.at;
  writeJson(selfcheckPath(agent), file);
  return rec;
}

/** Step ids and outcomes only (what the report may carry). */
export function summarise(agent: SelfcheckAgent): SelfcheckSummary | null {
  const f = loadSelfcheck(agent);
  if (!f) return null;
  const steps = stepsFor(agent);
  const known = new Map(steps.map((s) => [String(s.n), s.id]));
  const confirmed: string[] = [];
  const different: string[] = [];
  let recorded = 0;
  for (const [n, rec] of Object.entries(f.steps)) {
    const id = known.get(n);
    if (!id) continue;
    recorded++;
    if (rec.outcome === 'expected') confirmed.push(id);
    else if (rec.outcome === 'different') different.push(id);
  }
  const order = (a: string, b: string) => steps.findIndex((s) => s.id === a) - steps.findIndex((s) => s.id === b);
  return { steps: steps.length, recorded, confirmed: confirmed.sort(order), different: different.sort(order) };
}

export function summariseAll(): Partial<Record<AgentId, SelfcheckSummary>> {
  const out: Partial<Record<AgentId, SelfcheckSummary>> = {};
  for (const a of SELFCHECK_AGENTS) {
    const s = summarise(a);
    if (s) out[a] = s;
  }
  return out;
}
