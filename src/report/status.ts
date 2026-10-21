/**
 * `harness status`: one screen in plain language for the user. Setting,
 * agents, workspace, ledger age and counts, the test-database allowlist,
 * integrity, open tasks with phase, attempt and last gate verdict, lessons
 * waiting for review, the self-checks, and the one next thing to do.
 *
 * It reads only the harness state (collect.ts) and prints to the user's
 * terminal; task titles appear here (never in the report or the log).
 */
import * as fs from 'node:fs';
import type { AgentId, Setting, Verdict } from '../types';
import { allowlistHash } from '../lib/config';
import { integrityPath, verifyIntegrity } from '../lib/integrity';
import type { HarnessState } from './collect';
import { indexTasks } from './build';
import { SELFCHECK_DOCS, isSelfcheckAgent, loadSelfcheck, stepsFor } from './selfcheck';

export interface StatusTask {
  id: string;
  repo?: string;
  title?: string;
  phase?: string;
  attempt?: number;
  verdict: Verdict | 'none';
  capReached: boolean;
  current: boolean;
  at?: string;
}

export interface StatusInfo {
  installed: boolean;
  setting?: Setting;
  agents: AgentId[];
  workspaceRoot?: string;
  repos: number;
  ledger: { present: boolean; generatedAt?: string; ageDays?: number; records: number; blocking: number };
  db: { test: number; notTest: number; hashOk: boolean | null };
  integrity: { signed: boolean; ok: boolean; reason?: string };
  tasks: StatusTask[];
  open: number;
  done: number;
  lessonsPending: number;
  selfcheck: Array<{ agent: AgentId; recorded: number; steps: number; different: number }>;
  next: string;
  notes: string[];
}

const PENDING_LESSON = new Set(['captured', 'proposed', 'proven']);

function combine(vs: Verdict[]): Verdict | 'none' {
  if (!vs.length) return 'none';
  if (vs.includes('FAIL')) return 'FAIL';
  if (vs.includes('BLOCKED')) return 'BLOCKED';
  return 'PASS';
}

export function buildStatus(st: HarnessState, now: Date = new Date()): StatusInfo {
  const c = st.config;
  const repoName = new Map((c?.repos ?? []).map((r) => [r.id, r.name]));
  const current = new Set(Object.values(st.currentTasks));

  const ledgerAt = st.ledger?.generatedAt;
  const ageDays = ledgerAt && !Number.isNaN(Date.parse(ledgerAt)) ? Math.max(0, Math.floor((now.getTime() - Date.parse(ledgerAt)) / 86_400_000)) : undefined;
  const records = st.ledger?.records ?? [];

  const signed = fs.existsSync(integrityPath());
  const v = verifyIntegrity();

  const idx = indexTasks(st);
  const tasks: StatusTask[] = idx.tasks.map((t) => {
    const verdicts = t.runs.map((r) => r.evidence?.verdict).filter((x): x is Verdict => !!x);
    const attempts = t.runs.map((r) => r.evidence?.attempt ?? 0);
    const dates = [t.brief?.updatedAt, ...t.runs.map((r) => r.evidence?.finishedAt)].filter((d): d is string => !!d).sort();
    const repo = t.runs[0]?.repo ?? t.brief?.repos?.[0];
    return {
      id: t.id,
      repo: repo ? repoName.get(repo) ?? t.brief?.repoMap?.repos?.[repo]?.name ?? repo : undefined,
      title: t.brief?.title ? t.brief.title.replace(/\s+/g, ' ').slice(0, 60) : undefined,
      phase: t.runs.map((r) => r.phase).find((p) => !!p),
      attempt: attempts.length ? Math.max(...attempts) : undefined,
      verdict: combine(verdicts),
      capReached: t.runs.some((r) => r.capFile || r.evidence?.cap_reached === true),
      current: current.has(t.id),
      at: dates[dates.length - 1],
    };
  });
  tasks.sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : (b.at ?? '') < (a.at ?? '') ? -1 : (b.at ?? '') > (a.at ?? '') ? 1 : 0));
  const open = tasks.filter((t) => t.verdict !== 'PASS');

  const lessonsPending = st.lessons.filter((l) => PENDING_LESSON.has(l.status)).length;
  const agents = c?.agents ?? [];
  const selfcheck = agents.filter(isSelfcheckAgent).map((agent) => {
    const f = loadSelfcheck(agent);
    const recs = Object.values(f?.steps ?? {});
    return { agent, recorded: recs.length, steps: stepsFor(agent).length, different: recs.filter((r) => r.outcome === 'different').length };
  });

  const allow = c?.db?.allowlist ?? [];
  const db = {
    test: allow.filter((t) => t.marked === 'test').length,
    notTest: allow.filter((t) => t.marked === 'not-test').length,
    hashOk: c && c.db?.markedHash ? allowlistHash(c) === c.db.markedHash : null,
  };

  const notes: string[] = [];
  if (c && db.test === 0) notes.push('No test database is marked, so every database command is denied (`harness db mark --server <host> --test` marks one).');
  if (st.badEventLines) notes.push(`${st.badEventLines} line(s) of the instrumentation log did not parse.`);

  // The one next thing to do, most urgent first.
  let next: string;
  const failing = open.find((t) => t.verdict === 'FAIL' && !t.capReached);
  const capped = open.find((t) => t.capReached);
  const unrun = open.find((t) => t.verdict === 'none' && t.current);
  const pendingCheck = selfcheck.find((s) => s.recorded < s.steps);
  if (!c) next = 'Install the harness: `harness install --setting team --agents devin` (or `--setting personal`); the `setup` skill can prepare it in the chat.';
  else if (!v.ok) next = `Run \`harness doctor\`: the integrity check fails (${v.reason}), so the hooks refuse to work until it is fixed.`;
  else if (!st.ledger) next = 'Build the standards ledger: `harness discover`.';
  else if (db.hashOk === false) next = 'Run `harness doctor`: the database allowlist was edited outside `harness db mark`, so every database command is denied.';
  else if (failing) next = `Task ${failing.id}: the last gate run failed. The agent fixes the listed steps and runs \`harness gate\` again (or \`harness gate --blocked "<reason>"\` when it cannot pass).`;
  else if (capped) next = `Task ${capped.id} stopped at the gate attempt cap without a PASS. Run \`harness gate --task ${capped.id}\` in its repository to see what still fails, then decide whether to continue, split or drop it.`;
  else if (unrun) next = `Task ${unrun.id}: no gate run yet. When the work is done, \`harness gate\` proves it.`;
  else if (lessonsPending) next = `${lessonsPending} lesson(s) wait for review: \`harness learn review\`.`;
  else if (pendingCheck) next = `Run the ${pendingCheck.agent} self-check (${SELFCHECK_DOCS[pendingCheck.agent as 'devin' | 'codex']} in the harness folder) and record each step with \`harness selfcheck record\`.`;
  else if (ageDays !== undefined && ageDays > 30) next = `The ledger is ${ageDays} days old: refresh it with \`harness discover\`.`;
  else next = 'Nothing is waiting. Start the next task with the `task` skill.';

  return {
    installed: !!c,
    setting: c?.setting,
    agents,
    workspaceRoot: c?.workspaceRoot,
    repos: c?.repos?.length ?? 0,
    ledger: { present: !!st.ledger, generatedAt: ledgerAt, ageDays, records: records.length, blocking: records.filter((r) => r.check?.mode === 'block').length },
    db,
    integrity: { signed, ok: v.ok, reason: v.ok ? undefined : v.reason },
    tasks,
    open: open.length,
    done: tasks.length - open.length,
    lessonsPending,
    selfcheck,
    next,
    notes,
  };
}

function age(days: number | undefined): string {
  if (days === undefined) return 'at an unknown date';
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

const MAX_TASKS = 8;

export function renderStatus(s: StatusInfo): string {
  const L: string[] = [];
  if (!s.installed) {
    L.push('harness status: not installed on this machine (no config.json in the harness state folder).');
  } else {
    L.push(`harness status: ${s.setting} setting; agents ${s.agents.join(', ') || 'none'}`);
    L.push(`  Workspace    ${s.workspaceRoot ?? 'not set'} (${s.repos} repo${s.repos === 1 ? '' : 's'})`);
  }
  L.push(`  Ledger       ${s.ledger.present ? `${s.ledger.records} standard(s), ${s.ledger.blocking} blocking; discovered ${age(s.ledger.ageDays)}` : 'none yet'}`);
  if (s.installed) L.push(`  Databases    ${s.db.test} marked test, ${s.db.notTest} marked not test${s.db.hashOk === false ? '; allowlist edited outside `harness db mark`' : s.db.hashOk ? '; allowlist intact' : ''}`);
  L.push(`  Integrity    ${s.integrity.ok ? (s.integrity.signed ? 'ok' : 'not signed yet (install signs it)') : `FAILS: ${s.integrity.reason}`}`);
  L.push(`  Tasks        ${s.open} open, ${s.done} passed the gate`);
  for (const t of s.tasks.filter((x) => x.verdict !== 'PASS').slice(0, MAX_TASKS)) {
    const verdict = t.capReached ? 'capped' : t.verdict === 'none' ? 'no gate run' : t.verdict;
    const parts = [`${t.current ? '*' : ' '} ${t.id}`, t.repo ?? '-', t.phase ?? '-', t.attempt ? `attempt ${t.attempt}` : 'attempt -', verdict];
    L.push(`    ${parts.join('  ')}${t.title ? `  ${t.title}` : ''}`);
  }
  if (s.open > MAX_TASKS) L.push(`    ... and ${s.open - MAX_TASKS} more open task(s)`);
  if (s.tasks.some((t) => t.current)) L.push('    (* the current task of its repository)');
  L.push(`  Lessons      ${s.lessonsPending ? `${s.lessonsPending} waiting for review` : 'none waiting'}`);
  if (s.selfcheck.length) {
    L.push(`  Self-checks  ${s.selfcheck.map((x) => `${x.agent} ${x.recorded}/${x.steps} step(s) recorded${x.different ? `, ${x.different} different from expected` : ''}`).join('; ')}`);
  }
  for (const n of s.notes) L.push(`  Note: ${n}`);
  L.push('', `Next: ${s.next}`);
  return L.join('\n') + '\n';
}
