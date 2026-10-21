/**
 * `harness selfcheck [list] [--agent devin|codex] [--json]`
 * `harness selfcheck record --agent <agent> --step <n> --result "<text>" [--outcome expected|different|noted]`
 * `harness selfcheck probe-files --agent <agent> [--remove]`
 * `harness selfcheck probe-mode --agent devin --stop off|block|slow`
 * `harness selfcheck probe-log --agent <agent> [--json] [--clear]`
 * `harness selfcheck probe-hook <Event> --agent <agent>`     (internal: the probe hook entries run it)
 *
 * The self-checks the user runs on the work machine after
 * `harness install --setting team` (harness/selfcheck/devin-desktop.md and
 * codex.md). Results go to ~/.harness/selfcheck/<agent>.json; the report
 * says which behaviours the user confirmed (step ids only).
 *
 * Exit 0 ok; 1 failure; 2 usage; 4 refused (a probe target inside a git repository).
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { instrument } from '../lib/log';
import { packageRoot, toPosix } from '../lib/paths';
import { SELFCHECK_AGENTS, SELFCHECK_DOCS, isSelfcheckAgent, loadSelfcheck, parseOutcome, recordStep, stepsFor, type SelfcheckAgent } from '../report/selfcheck';
import { clearProbeLog, formatProbeSummary, probeHook, readProbeLog, removeProbes, setStopMode, summariseProbeLog, writeProbes, type StopMode } from '../report/probes';

export const meta: CommandMeta = {
  name: 'selfcheck',
  summary: 'Record the work-machine self-check results; write and remove its probe files',
  usage:
    'harness selfcheck [list] [--agent devin|codex] [--json] | record --agent <agent> --step <n> --result "<text>" [--outcome expected|different|noted] | probe-files --agent <agent> [--remove] | probe-mode --agent devin --stop off|block|slow | probe-log --agent <agent> [--json] [--clear] | probe-hook <Event> --agent <agent> (internal: run by the probe hook entries)',
  examples: [
    'harness selfcheck probe-files --agent devin',
    'harness selfcheck record --agent devin --step 4 --result "pass: saw MARKER-GLOBAL-PROBE and MARKER-HOOK-START"',
    'harness selfcheck probe-log --agent devin',
    'harness selfcheck probe-files --agent devin --remove',
  ],
};

const BOOLEANS = new Set(['json', 'remove', 'clear', 'help', 'h']);

function usage(msg: string): number {
  process.stderr.write(`selfcheck: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

function agentFlag(a: ReturnType<typeof parseArgv>, required: boolean): SelfcheckAgent | null | 'bad' {
  const v = flagStr(a, 'agent');
  if (v === undefined || v === '') return required ? 'bad' : null;
  return isSelfcheckAgent(v) ? v : 'bad';
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      if (data.length < 1_000_000) data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function docPath(agent: SelfcheckAgent): string {
  return toPosix(path.join(packageRoot(), SELFCHECK_DOCS[agent]));
}

function list(agents: SelfcheckAgent[], json: boolean): number {
  const out = agents.map((agent) => {
    const f = loadSelfcheck(agent);
    return {
      agent,
      doc: docPath(agent),
      steps: stepsFor(agent).map((s) => ({ ...s, outcome: f?.steps[String(s.n)]?.outcome ?? null, at: f?.steps[String(s.n)]?.at ?? null })),
    };
  });
  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }
  for (const a of out) {
    const done = a.steps.filter((s) => s.outcome).length;
    process.stdout.write(`${a.agent} self-check (${a.doc}): ${done} of ${a.steps.length} step(s) recorded\n`);
    for (const s of a.steps) {
      const mark = s.outcome === 'expected' ? 'as expected' : s.outcome === 'different' ? 'DIFFERENT' : s.outcome === 'noted' ? 'noted' : 'not run';
      process.stdout.write(`  ${String(s.n).padStart(2)}. ${mark.padEnd(11)} ${s.title}\n`);
    }
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, BOOLEANS);
  const sub = a.positional[0] ?? 'list';

  if (sub === 'probe-hook') {
    // Run by the probe hook entries; never fails the agent.
    const event = a.positional[1] ?? '';
    const agent = flagStr(a, 'agent') ?? 'unknown';
    try {
      const r = await probeHook(/^[A-Za-z]{1,40}$/.test(event) ? event : 'unknown', /^[a-z]{1,20}$/.test(agent) ? agent : 'unknown', await readStdin());
      if (r.stdout) process.stdout.write(r.stdout + '\n');
      if (r.stderr) process.stderr.write(r.stderr + '\n');
      return r.code;
    } catch {
      return 0;
    }
  }

  if (sub === 'list') {
    const ag = agentFlag(a, false);
    if (ag === 'bad') return usage(`--agent takes ${SELFCHECK_AGENTS.join(' or ')}`);
    return list(ag ? [ag] : SELFCHECK_AGENTS, flagBool(a, 'json'));
  }

  const agent = agentFlag(a, true);
  if (agent === 'bad' || agent === null) return usage(`--agent takes ${SELFCHECK_AGENTS.join(' or ')}`);

  if (sub === 'record') {
    const raw = flagStr(a, 'step');
    const n = Number(raw);
    if (!raw || !Number.isInteger(n)) return usage('record needs --step <n>');
    const result = flagStr(a, 'result');
    if (!result) return usage('record needs --result "<what you saw>"');
    const outFlag = flagStr(a, 'outcome');
    const outcome = parseOutcome(outFlag);
    if (outFlag !== undefined && !outcome) return usage('--outcome takes expected, different or noted');
    let rec;
    try {
      rec = recordStep(agent, n, result, outcome ?? undefined);
    } catch (e) {
      process.stderr.write(`selfcheck: ${(e as Error).message}\n`);
      return 2;
    }
    instrument({ event: 'selfcheck.record', agent, ids: { step: rec.id, outcome: rec.outcome } });
    const step = stepsFor(agent).find((s) => s.n === n)!;
    const how = rec.outcome === 'expected' ? 'as expected' : rec.outcome === 'different' ? 'DIFFERENT from what the document expects' : 'noted (start the result with "pass" or "fail" to mark it)';
    process.stdout.write(`Recorded ${agent} step ${n} (${step.title}): ${how}.\n`);
    return 0;
  }

  if (sub === 'probe-files') {
    const r = flagBool(a, 'remove') ? removeProbes(agent) : writeProbes(agent);
    instrument({ event: flagBool(a, 'remove') ? 'selfcheck.probe-remove' : 'selfcheck.probe-files', agent, counts: { files: r.manifest?.entries.length ?? 0, ok: r.ok ? 1 : 0 } });
    for (const l of r.lines) (r.ok ? process.stdout : process.stderr).write(l + '\n');
    return r.code;
  }

  if (sub === 'probe-mode') {
    const mode = flagStr(a, 'stop');
    if (mode !== 'off' && mode !== 'block' && mode !== 'slow') return usage('probe-mode needs --stop off, block or slow');
    if (agent !== 'devin') return usage('the Stop probe is part of the Devin check only');
    setStopMode(agent, mode as StopMode);
    const what = mode === 'block' ? 'blocks the next 3 stops in a row, then lets the agent stop' : mode === 'slow' ? 'sleeps 10 s on every stop against its 3 s timeout' : 'lets every stop through and records it';
    process.stdout.write(`The ${agent} Stop probe now ${what}.\n`);
    return 0;
  }

  if (sub === 'probe-log') {
    if (flagBool(a, 'clear')) {
      clearProbeLog(agent);
      process.stdout.write(`Cleared the ${agent} probe log.\n`);
      return 0;
    }
    const s = summariseProbeLog(readProbeLog(agent));
    process.stdout.write(flagBool(a, 'json') ? JSON.stringify(s, null, 2) + '\n' : formatProbeSummary(agent, s));
    return 0;
  }

  return usage(`unknown subcommand ${JSON.stringify(sub.slice(0, 40))}`);
}
