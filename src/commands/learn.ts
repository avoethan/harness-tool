/**
 * `harness learn`: the learning loop (DESIGN 2.9; src/learn/README.md).
 *
 *   harness learn --scan [--since <date>] [--token-cap <n>] [--json]
 *       Group the instrumentation log's mistake events into classes and write
 *       or update the lesson records (~/.harness/lessons/); propose an enforcer
 *       by the ladder; write a judgment bundle for what needs code or a judgment.
 *   harness learn --import-judgment <id> [--json]
 *       Validate the driving agent's result.json and attach the enforcers.
 *   harness learn prove <lesson> [--fixture <file>] [--repo <path>] [--json]
 *       The enforcer must fail on the original mistake. A proven tier-0 lesson
 *       is approved at once (its check goes into the private ledger).
 *   harness learn review [--approve <id>]... [--reject <id>]... [--expire <id>]... [--renew <id>]... [--json]
 *       The user's batched review (the guard blocks it from agents). Without
 *       flags it asks about each pending lesson in a terminal, or lists them.
 *       An approved tier-1 lesson becomes a plan for `harness apply --plan <id>`.
 *   harness learn gc [--json]        rot control (lists; never deletes)
 *   harness learn stats [--json]     repeat corrections per class, before and after the enforcer landed
 *   harness learn list [--json] | show <lesson>
 *
 * Exit codes: 0 ok; 1 failure (not proven, a refusal, a rejected import); 2 usage; 4 refused by a rail (team repository).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { ALL_AGENTS, type AgentId, type Setting } from '../types';
import { flagBool, flagStr, flagValues, parseArgv } from '../lib/argv';
import { loadConfig } from '../lib/config';
import { instrument } from '../lib/log';
import { isInteractive, askChoice } from '../lib/prompt';
import { RUNG_WORDS } from '../learn/ladder';
import { captureAll, decide, proveAndRecord, scan, type Decision, type ReviewContext } from '../learn/index';
import { importLearnJudgment } from '../learn/judgment';
import { findAstGrep } from '../discover/astgrep';
import { isPending, listLessons, loadLesson, saveLesson, type LessonRecord } from '../learn/store';
import { computeStats, formatStats } from '../learn/stats';
import { formatGc, gcReport } from '../learn/gc';
import { reviewByFor } from '../learn/tiers';
import { prepareContext, proposeAndSave } from '../render/propose';
import { alwaysOnTargets, renderAlwaysOnBlock } from '../render/alwayson';

export const meta: CommandMeta = {
  name: 'learn',
  summary: 'Learning loop: scan captured corrections, prove enforcers, review',
  usage:
    'harness learn --scan [--since <date>] [--token-cap <n>] [--json] | --import-judgment <id> | prove <lesson> [--fixture <file>] [--repo <path>] | review [--approve <id>]... [--reject <id>]... [--expire <id>]... [--renew <id>]... | gc | stats | list | show <lesson>',
  examples: ['harness learn --scan', 'harness learn prove l-rule-logging-no-console-3fa2c1', 'harness learn review', 'harness learn stats'],
};

const BOOLEANS = new Set(['json', 'scan', 'help', 'h', 'yes']);

function usage(msg: string): number {
  process.stderr.write(`learn: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

function out(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + '\n' : text);
}

function settingOf(): { setting: Setting; agents: AgentId[]; workspaceRoot: string | null } {
  const cfg = loadConfig();
  return { setting: cfg?.setting ?? 'team', agents: (cfg?.agents?.length ? cfg.agents : ALL_AGENTS) as AgentId[], workspaceRoot: cfg?.workspaceRoot ?? null };
}

function lessonLine(l: LessonRecord): string {
  const enf = l.proposal ? `${l.proposal.rung} (${l.proposal.ref})${l.proposal.existing ? ', already in place' : ''}` : l.needsJudgment ? `needs judgment${l.needsJudgment.bundle ? ` (bundle ${l.needsJudgment.bundle})` : ''}` : 'none';
  const proof = l.proof ? `; proof ${l.proof.result} (${l.proof.method})` : '';
  return `- ${l.id} [${l.status}, tier ${l.tier}] ${l.description}: ${l.occurrences} occurrence(s); enforcer ${enf}${proof}`;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, BOOLEANS);
  const json = flagBool(a, 'json');
  const sub = a.positional[0];
  if (flagBool(a, 'help') || flagBool(a, 'h')) {
    process.stdout.write(`${meta.usage}\n`);
    return 0;
  }
  const importId = flagStr(a, 'import-judgment') ?? (sub === 'import-judgment' ? a.positional[1] : undefined);
  if (importId !== undefined) return importMode(importId, json);
  if (flagBool(a, 'scan') || sub === 'scan') return scanMode(a, json);
  switch (sub) {
    case 'prove':
      return proveMode(a.positional[1], flagStr(a, 'fixture'), flagStr(a, 'repo'), json);
    case 'review':
      return reviewMode(a, json);
    case 'gc':
      return gcMode(json);
    case 'stats':
      return statsMode(json);
    case 'list':
      return listMode(json);
    case 'show':
      return showMode(a.positional[1]);
    case undefined:
      process.stdout.write(`${meta.usage}\n\n`);
      return listMode(false);
    default:
      return usage(`unknown subcommand '${sub}'`);
  }
}

function scanMode(a: ReturnType<typeof parseArgv>, json: boolean): number {
  const sinceRaw = flagStr(a, 'since');
  let since: Date | undefined;
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (!sinceRaw || Number.isNaN(since.getTime())) return usage('--since needs a date, e.g. 2026-10-01');
  }
  const capRaw = flagStr(a, 'token-cap');
  let tokenCap: number | undefined;
  if (capRaw !== undefined) {
    tokenCap = Number(capRaw);
    if (!Number.isInteger(tokenCap) || tokenCap < 200 || tokenCap > 200_000) return usage('--token-cap must be a whole number of tokens between 200 and 200000');
  }
  const r = scan({ since, tokenCap, setting: settingOf().setting });
  const L: string[] = [];
  L.push(`Scanned ${r.events} mistake event(s)${r.malformed ? ` (${r.malformed} unreadable line(s) skipped)` : ''}: ${r.occurrences} occurrence(s) in ${r.classes} class(es); ${r.active} with 2+ occurrences or a safety rail.`);
  L.push(`Lessons: ${r.created.length} new, ${r.updated.length} updated, ${r.lessons.length} in all (~/.harness/lessons/).`);
  for (const l of r.lessons.filter((x) => x.status !== 'rejected' && x.status !== 'expired')) L.push(lessonLine(l));
  if (r.bundle) {
    L.push('', `Judgment needed for ${r.bundle.items} lesson(s): bundle ${r.bundle.id}. Read ${path.join(r.bundle.dir, 'prompt.md')}, write the answer to a file outside the harness folder, then run:`, `  harness judgment submit ${r.bundle.id} --from <file>`, `  harness learn --import-judgment ${r.bundle.id}`);
  }
  const toProve = r.lessons.filter((l) => l.status === 'proposed' && l.proposal && l.proposal.source !== 'rail');
  if (toProve.length) L.push('', 'Next, prove each proposed enforcer:', ...toProve.map((l) => `  harness learn prove ${l.id}`));
  out(json, { events: r.events, malformed: r.malformed, occurrences: r.occurrences, classes: r.classes, active: r.active, created: r.created, updated: r.updated, lessons: r.lessons.map((l) => ({ id: l.id, key: l.key, status: l.status, tier: l.tier, occurrences: l.occurrences, rung: l.proposal?.rung ?? null, needsJudgment: !!l.needsJudgment })), bundle: r.bundle ?? null }, L.join('\n') + '\n');
  return 0;
}

function importMode(id: string, json: boolean): number {
  if (!id) return usage('--import-judgment needs the bundle id');
  const r = importLearnJudgment(id, { ast: findAstGrep(), setting: settingOf().setting });
  instrument({ event: 'learn.import-judgment', ids: { bundle: id.slice(0, 40) }, counts: { accepted: r.accepted.length, rejected: r.rejected.length } });
  if (r.error) {
    process.stderr.write(`learn: ${r.error}\n`);
    return 1;
  }
  const L = [`Judgment ${id}: ${r.accepted.length} accepted, ${r.rejected.length} rejected.`];
  for (const x of r.accepted) L.push(`- ${x.lesson}: ${x.rung === 'none' ? 'not a lesson (review can reject it)' : `${x.rung} enforcer proposed (tier ${x.tier}); next: harness learn prove ${x.lesson}`}`);
  for (const x of r.rejected) L.push(`- item ${x.item}${x.lesson ? ` (${x.lesson})` : ''} rejected: ${x.reason}`);
  out(json, r, L.join('\n') + '\n');
  return r.rejected.length && !r.accepted.length ? 1 : 0;
}

function proveMode(id: string | undefined, fixture: string | undefined, repo: string | undefined, json: boolean): number {
  if (!id) return usage('prove needs a lesson id (harness learn list)');
  if (fixture !== undefined && (!fixture || !fs.existsSync(fixture) || !fs.statSync(fixture).isFile())) return usage(`--fixture ${fixture} is not a file`);
  if (repo !== undefined && (!repo || !fs.existsSync(repo))) return usage(`--repo ${repo} does not exist`);
  const r = proveAndRecord(id, { fixture: fixture ? path.resolve(fixture) : undefined, repo: repo ? path.resolve(repo) : undefined });
  if ('error' in r) {
    process.stderr.write(`learn: ${r.error}\n`);
    return 1;
  }
  const L = [`${r.lesson.id}: ${r.proof.result} (${r.proof.method}). ${r.proof.detail}`];
  if (r.approved) L.push(r.installed.length ? `Tier 0: approved; the check is in the private ledger (${r.installed.map((f) => path.basename(f)).join(', ')}); the gate's standards step runs it in block mode from now on.` : 'Tier 0: approved; the enforcer was already in place, the lesson records it.');
  else if (r.proof.result === 'proven') L.push(`Proven. Tier ${r.lesson.tier}: ${r.lesson.tierReason ?? ''}; it waits for \`harness learn review\` (the user's).`);
  else L.push(`The lesson stays ${r.lesson.status}.`);
  out(json, { lesson: r.lesson.id, status: r.lesson.status, tier: r.lesson.tier, proof: r.proof, approved: r.approved, installed: r.installed }, L.join('\n') + '\n');
  return r.proof.result === 'proven' ? 0 : 1;
}

function reviewContext(): ReviewContext {
  const s = settingOf();
  const workspaceRoot = s.workspaceRoot ?? process.cwd();
  return {
    setting: s.setting,
    agents: s.agents,
    workspaceRoot,
    measure: (lessons) => {
      try {
        const prep = prepareContext({ setting: s.setting, agents: s.agents, workspaceRoot });
        const other = (prep.ctx.lessons ?? []).filter((l) => l.rung !== 'instruction');
        prep.ctx.lessons = [...other, ...lessons.map((l) => ({ id: l.id, rung: 'instruction' as const, text: l.proposal?.text ?? '', reviewBy: l.reviewBy ?? reviewByFor('instruction') }))];
        return alwaysOnTargets(prep.ctx).map((t) => renderAlwaysOnBlock(prep.ctx, t.agents).lines);
      } catch {
        return [];
      }
    },
    plan: () => {
      if (!s.workspaceRoot) return { error: 'no harness config yet (run harness install first); the approved lesson is rendered by the next propose' };
      try {
        const r = proposeAndSave({ setting: s.setting, agents: s.agents, workspaceRoot });
        return { id: r.plan.id, targets: r.plan.targets.length };
      } catch (e) {
        return { error: `propose failed: ${(e as Error).message}` };
      }
    },
  };
}

function describePending(l: LessonRecord): string[] {
  const p = l.proposal;
  const L = [`${l.id}: ${l.description}. ${l.occurrences} occurrence(s) (${Object.entries(l.counts).map(([k, v]) => `${v} ${k}`).join(', ')}).`];
  if (p) L.push(`  Enforcer: ${RUNG_WORDS[p.rung]} — ${p.ref}${p.text ? `: "${p.text}"` : ''}. ${p.why}`);
  else L.push(`  Enforcer: none yet (${l.needsJudgment?.reason ?? 'run harness learn --scan'})`);
  L.push(`  Proof: ${l.proof ? `${l.proof.result} (${l.proof.method}): ${l.proof.detail}` : 'not run (harness learn prove ' + l.id + ')'}`);
  L.push(`  Tier ${l.tier}: ${l.tierReason ?? ''}`);
  return L;
}

async function reviewMode(a: ReturnType<typeof parseArgv>, json: boolean): Promise<number> {
  const requests: Array<{ action: Decision['action']; id: string }> = [];
  for (const action of ['approve', 'reject', 'expire', 'renew'] as const) for (const id of flagValues(a, action)) requests.push({ action, id });
  const pending = listLessons().filter(isPending);
  if (!requests.length) {
    if (!pending.length) {
      out(json, { pending: [] }, 'No lessons wait for a decision.\n');
      return 0;
    }
    if (!isInteractive() || json) {
      const L = [`${pending.length} lesson(s) wait for a decision:`, ''];
      for (const l of pending) L.push(...describePending(l), '');
      L.push('Decide in your own terminal: harness learn review --approve <id> --reject <id> (or run `harness learn review` there to be asked about each).');
      out(json, { pending: pending.map((l) => ({ id: l.id, key: l.key, status: l.status, tier: l.tier, tierReason: l.tierReason, rung: l.proposal?.rung ?? null, proof: l.proof ?? null })) }, L.join('\n') + '\n');
      return 0;
    }
    for (const l of pending) {
      process.stdout.write('\n' + describePending(l).join('\n') + '\n');
      const c = await askChoice('Decision?', ['approve', 'reject', 'skip'], 'skip');
      if (c !== 'skip') requests.push({ action: c as Decision['action'], id: l.id });
    }
    if (!requests.length) return 0;
  }
  const r = decide(requests, reviewContext());
  const L: string[] = [];
  for (const d of r.decisions) L.push(`- ${d.action} ${d.lesson}: ${d.ok ? '' : 'not done: '}${d.message}`);
  if (r.plan) {
    if ('id' in r.plan) L.push('', `Plan ${r.plan.id} (${r.plan.targets} file(s)). Nothing is written yet; to apply it, run in your terminal:`, `  harness apply --plan ${r.plan.id}`);
    else L.push('', `No plan: ${r.plan.error}`);
  }
  out(json, r, L.join('\n') + '\n');
  if (r.decisions.some((d) => d.code === 4)) return 4;
  return r.decisions.some((d) => !d.ok) ? 1 : 0;
}

function gcMode(json: boolean): number {
  const lessons = listLessons();
  const c = captureAll({ lessons });
  const r = gcReport(lessons, c);
  const at = r.generatedAt;
  for (const p of r.promote) {
    const l = loadLesson(p.lesson);
    if (!l || l.promote) continue;
    l.promote = { at, repeats: p.repeatsAfter };
    l.history.push({ at, status: l.status, note: `gc: came back ${p.repeatsAfter} time(s) after landing; marked for a code check` });
    l.updatedAt = at;
    saveLesson(l);
  }
  for (const [id, fires] of Object.entries(r.fires)) {
    const l = loadLesson(id);
    if (l?.enforcer && l.enforcer.fires !== fires) {
      l.enforcer.fires = fires;
      saveLesson(l);
    }
  }
  instrument({ event: 'learn.gc', counts: { records: r.records, expiring: r.expiring.length, promote: r.promote.length, unfired: r.unfired.length, learnedLines: r.budget.learnedLines } });
  out(json, r, formatGc(r));
  return 0;
}

function statsMode(json: boolean): number {
  const lessons = listLessons();
  const r = computeStats(lessons, captureAll({ lessons }));
  instrument({ event: 'learn.stats', counts: { lessons: r.totals.lessons, repeats: r.totals.repeats, before: r.totals.repeatsBefore, after: r.totals.repeatsAfter } });
  out(json, r, formatStats(r));
  return 0;
}

function listMode(json: boolean): number {
  const lessons = listLessons();
  if (json) {
    out(true, lessons.map((l) => ({ id: l.id, key: l.key, status: l.status, tier: l.tier, occurrences: l.occurrences, rung: l.proposal?.rung ?? null, proof: l.proof?.result ?? null })), '');
    return 0;
  }
  if (!lessons.length) process.stdout.write('No lessons yet: run `harness learn --scan`.\n');
  else process.stdout.write(lessons.map(lessonLine).join('\n') + '\n');
  return 0;
}

function showMode(id: string | undefined): number {
  if (!id) return usage('show needs a lesson id');
  const l = loadLesson(id);
  if (!l) {
    process.stderr.write(`learn: no lesson ${id}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(l, null, 2) + '\n');
  return 0;
}
