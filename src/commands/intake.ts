/**
 * `harness intake` — turn a pasted ticket into a brief.
 *
 *   harness intake --from <file|-> [--repo <path>] [--unattended] [--json]
 *   harness intake show [id] [--repo <path>] [--json]
 *   harness intake answer <id> --q <n> --answer "<text or option letter>" [--json]
 *   harness intake answer <id> --all-recommended [--json]
 *   harness intake lint [id] [--repo <path>]
 *   harness intake list [--json]
 *
 * Writes ~/.harness/briefs/<id>.json and sets ~/.harness/runs/<repoId>/current-task
 * for every mapped repo. The ticket text is never logged; the instrumentation
 * event carries the brief id, the ticket's sha256 and counts.
 *
 * Exit codes: 0 ok; 1 plan lint failed (the brief is saved and the problems
 * are listed) or nothing found; 2 usage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagBool, flagStr, parseArgv } from '../lib/argv';
import { repoIdFor, resolveConfig } from '../lib/config';
import { instrument } from '../lib/log';
import { nearestRepoRoot } from '../lib/git';
import { formatQuestionsBlock } from '../intake/ambiguity';
import { UNMAPPED } from '../intake/units';
import {
  answerQuestion,
  briefPath,
  buildBrief,
  getCurrentTask,
  kindCounts,
  lintCounts,
  listBriefs,
  loadBrief,
  reassemble,
  saveBrief,
  setCurrentTask,
  type BriefFile,
} from '../intake/brief';

export const meta: CommandMeta = {
  name: 'intake',
  summary: 'Turn a pasted ticket into a brief with criteria, checks and units',
  usage: 'harness intake --from <file|-> [--repo <path>] [--unattended] [--json] | show [id] | answer <id> (--q <n> --answer "<text>" | --all-recommended) | lint [id] | list',
  examples: ['harness intake --from ticket.txt', 'pbpaste | harness intake --from -', 'harness intake --from ticket.txt --unattended', 'harness intake show', 'harness intake answer t-1a2b3c4d5e --q 1 --answer B', 'harness intake answer t-1a2b3c4d5e --all-recommended'],
};

const MAX_TICKET_BYTES = 1024 * 1024;

/** `--q <n>` takes a value here (globally `-q`/`--q` is the quiet switch). */
const BOOLEANS = new Set([...DEFAULT_BOOLEANS, 'unattended', 'all-recommended'].filter((b) => b !== 'q'));

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function repoRootFrom(flag: string | undefined): string | undefined {
  if (flag) return path.resolve(flag);
  return nearestRepoRoot(process.cwd()) ?? undefined;
}

function ctxFor(repoFlag: string | undefined, unattended = false) {
  const defaultRepoPath = repoRootFrom(repoFlag);
  const resolved = resolveConfig(defaultRepoPath ?? process.cwd());
  return { config: resolved.config, defaultRepoPath, ...(unattended ? { unattended: true } : {}) };
}

function repoName(b: BriefFile, id: string): string {
  return id === UNMAPPED ? 'unmapped repo' : (b.repoMap.repos[id]?.name ?? id);
}

/** Plain-language rendering of a brief. */
export function renderBrief(b: BriefFile): string {
  const out: string[] = [];
  out.push(`Brief ${b.id}: ${b.title}`);
  out.push(`Saved: ${briefPath(b.id)}`);
  if (b.repos.length) out.push(`Repos: ${b.repos.map((r) => repoName(b, r)).join(', ')} (current task set to ${b.id})`);
  else out.push('Repos: none mapped yet (see "To find out by running")');
  out.push('');
  out.push(`Acceptance criteria (${b.criteria.length}):`);
  for (const c of b.criteria) {
    const m = b.criteriaMeta[c.id];
    const conf = m ? ` ${m.kindConfidence.toFixed(2)}` : '';
    const low = m && m.parseConfidence < 0.7 ? ', read from prose' : '';
    out.push(`  ${c.id}  [${c.kind}${conf}${low}] ${c.text}`);
    if (c.ears) out.push(`        EARS: ${c.ears}`);
    if (c.check) {
      out.push(`        check: ${c.check.kind} - ${c.check.description}${c.check.greenAtBase ? '' : c.check.redFirst ? ' (prove it red first)' : ''}`);
      if (c.check.command) for (const line of c.check.command.split('\n')) out.push(`        run:   ${line}`);
    } else if (c.question) out.push('        check: waits for an answer (see Questions)');
    if (m && m.repos.length) out.push(`        repo:  ${m.repos.map((r) => repoName(b, r)).join(', ')} (${m.repoHow})`);
  }
  if (b.dropped.length) out.push(`  Dropped by your answers: ${b.dropped.map((d) => d.id).join(', ')}`);
  out.push('');
  out.push('Units (in order; each one repo, a short piece of work):');
  for (const u of b.units) {
    const est = b.unitEstimates[u.id];
    out.push(`  ${u.id}  ${u.title}${est ? `, about ${est} files` : ''}${u.dependsOn.length ? `, after ${u.dependsOn.join(', ')}` : ''}`);
  }
  if (b.landingOrder.length > 1) out.push(`  Landing order: ${b.landingOrder.map((r, i) => `${i + 1}. ${repoName(b, r)}`).join('  ')}`);
  if (b.assumptions.length) {
    out.push('');
    out.push('Assumptions (taken without asking; say so if one is wrong):');
    for (const a of b.assumptions) out.push(`  - ${a}`);
  }
  if (b.observations.length) {
    out.push('');
    out.push('To find out by running (nobody needs to answer these):');
    for (const o of b.observations) out.push(`  - ${o.text}${o.command ? `\n      ${o.command}` : ''}`);
  }
  if (b.questionDetails.length) {
    out.push('');
    out.push(formatQuestionsBlock(b.questionDetails, b.id));
  }
  if (b.queued.length) out.push(`(${b.queued.length} more question(s) wait for the next batch: ${b.queued.map((q) => 'Q' + q.n).join(', ')})`);
  if (b.lint.length) {
    out.push('');
    out.push('Plan lint FAILED:');
    for (const p of b.lint) out.push(`  - ${p}`);
  }
  out.push('');
  out.push('Next: harness phase tests (write the failing checks, prove them red), then harness phase implement, then harness verify, harness gate, harness writeup.');
  return out.join('\n') + '\n';
}

function logBrief(event: string, b: BriefFile, extra: Record<string, number> = {}): void {
  const kinds = kindCounts(b);
  instrument({
    event,
    task: b.id,
    ids: { brief: b.id, ticketSha256: b.ticketHash },
    counts: {
      criteria: b.criteria.length,
      questions: b.questionDetails.length,
      queued: b.queued.length,
      markers: b.markers.length,
      assumptions: b.assumptions.length,
      observations: b.observations.length,
      units: b.units.length,
      repos: b.repos.length,
      lint: b.lint.length,
      ...Object.fromEntries(Object.entries(kinds).map(([k, v]) => [`kind_${k}`, v])),
      ...extra,
    },
  });
}

/** The plan-lint result as an `intake.lint` event: names, ids and counts only. */
function logLint(b: BriefFile): void {
  instrument({ event: 'intake.lint', task: b.id, ids: { brief: b.id }, counts: lintCounts(b) });
}

function setCurrent(b: BriefFile): void {
  for (const r of b.repos) {
    const p = b.repoMap.repos[r]?.path;
    setCurrentTask(p ? repoIdFor(p) : r, b.id);
  }
}

function pickBrief(id: string | undefined, repoFlag: string | undefined): BriefFile | null {
  if (id) return loadBrief(id);
  const root = repoRootFrom(repoFlag);
  if (root) {
    const cur = getCurrentTask(repoIdFor(root));
    if (cur) {
      const b = loadBrief(cur);
      if (b) return b;
    }
  }
  return listBriefs()[0] ?? null;
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, BOOLEANS);
  const sub = p.positional[0];
  const json = flagBool(p, 'json');
  const repoFlag = flagStr(p, 'repo');

  if (sub === 'list') {
    const all = listBriefs();
    if (json) process.stdout.write(JSON.stringify(all.map((b) => ({ id: b.id, title: b.title, criteria: b.criteria.length, repos: b.repos, updatedAt: b.updatedAt })), null, 2) + '\n');
    else if (!all.length) process.stdout.write('No briefs yet. Run: harness intake --from <file|->\n');
    else for (const b of all) process.stdout.write(`${b.id}  ${b.updatedAt.slice(0, 16)}  ${b.criteria.length} criteria  ${b.title}\n`);
    return 0;
  }

  if (sub === 'show' || sub === 'lint') {
    const b = pickBrief(p.positional[1], repoFlag);
    if (!b) {
      process.stderr.write('No brief found. Run: harness intake --from <file|-> (or pass the brief id).\n');
      return 1;
    }
    if (sub === 'lint') {
      logLint(b);
      if (b.lint.length) {
        process.stdout.write(`Plan lint FAILED for ${b.id}:\n${b.lint.map((x) => `  - ${x}`).join('\n')}\n`);
        return 1;
      }
      process.stdout.write(`Plan lint ok for ${b.id}: every criterion has a red-first or green-at-base check, or an open question.\n`);
      return 0;
    }
    process.stdout.write(json ? JSON.stringify(b, null, 2) + '\n' : renderBrief(b));
    return b.lint.length ? 1 : 0;
  }

  if (sub === 'answer') {
    const id = p.positional[1];
    const nRaw = flagStr(p, 'q');
    const answer = flagStr(p, 'answer');
    if (flagBool(p, 'all-recommended')) {
      if (!id) {
        process.stderr.write('usage: harness intake answer <id> --all-recommended\n');
        return 2;
      }
      const cur = loadBrief(id);
      if (!cur) {
        process.stderr.write(`No brief ${id}. List them with: harness intake list\n`);
        return 1;
      }
      const before = new Set(cur.clarifications.filter((c) => c.unattended).map((c) => c.key));
      const next = reassemble(cur, ctxFor(repoFlag ?? (cur.repos[0] ? cur.repoMap.repos[cur.repos[0]]?.path : undefined), true));
      const taken = next.clarifications.filter((c) => c.unattended && !before.has(c.key));
      saveBrief(next);
      setCurrent(next);
      logBrief('intake.answer', next, { answered: taken.length, recommended: taken.length });
      logLint(next);
      if (json) process.stdout.write(JSON.stringify(next, null, 2) + '\n');
      else {
        process.stdout.write(taken.length ? `Took the recommended option for ${taken.map((c) => 'Q' + c.n).join(', ')} (recorded as assumptions: unattended). Overturn one with: harness intake answer ${id} --q <n> --answer "<text>"\n\n` : `No blocking question is open on ${id}; nothing to take.\n\n`);
        process.stdout.write(renderBrief(next));
      }
      return next.lint.length ? 1 : 0;
    }
    if (!id || !nRaw || answer === undefined) {
      process.stderr.write(`usage: harness intake answer <id> --q <n> --answer "<text>" | harness intake answer <id> --all-recommended\n`);
      return 2;
    }
    const n = Number(String(nRaw).replace(/^q/i, ''));
    const b = loadBrief(id);
    if (!b) {
      process.stderr.write(`No brief ${id}. List them with: harness intake list\n`);
      return 1;
    }
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write('--q takes the question number, e.g. --q 2\n');
      return 2;
    }
    const ctx = ctxFor(repoFlag ?? (b.repos[0] ? b.repoMap.repos[b.repos[0]]?.path : undefined));
    let res;
    try {
      res = answerQuestion(b, n, answer, ctx);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    saveBrief(res.brief);
    setCurrent(res.brief);
    logBrief('intake.answer', res.brief, { answered: 1, dropped: res.dropped ? 1 : 0 });
    logLint(res.brief);
    if (json) process.stdout.write(JSON.stringify(res.brief, null, 2) + '\n');
    else {
      process.stdout.write(`Recorded Q${res.question.n}: ${res.recorded}${res.dropped ? ` (${res.question.criterionId} dropped)` : ''}\n\n`);
      process.stdout.write(renderBrief(res.brief));
    }
    return res.brief.lint.length ? 1 : 0;
  }

  // `--from -`: the flag parser leaves `-` as a positional because it starts with a dash.
  const stdinDash = p.flags.from === true && sub === '-';
  if (sub && sub !== 'from' && !stdinDash) {
    process.stderr.write(`unknown subcommand: ${sub}\nusage: ${meta.usage}\n`);
    return 2;
  }

  const from = stdinDash ? '-' : (flagStr(p, 'from') || undefined) ?? (sub === 'from' ? p.positional[1] : undefined);
  if (!from) {
    process.stderr.write(`usage: ${meta.usage}\n`);
    return 2;
  }
  let text: string;
  if (from === '-') text = readStdin();
  else {
    try {
      const st = fs.statSync(from);
      if (st.size > MAX_TICKET_BYTES) {
        process.stderr.write(`The ticket file is larger than ${MAX_TICKET_BYTES} bytes; paste only the ticket.\n`);
        return 2;
      }
      text = fs.readFileSync(from, 'utf8');
    } catch {
      process.stderr.write(`Cannot read ${from}. Pass a file, or - to read the ticket from stdin.\n`);
      return 2;
    }
  }
  if (Buffer.byteLength(text) > MAX_TICKET_BYTES) {
    process.stderr.write(`The ticket is larger than ${MAX_TICKET_BYTES} bytes; paste only the ticket.\n`);
    return 2;
  }
  if (!text.trim()) {
    process.stderr.write('The ticket is empty. Paste the title, description and acceptance criteria.\n');
    return 2;
  }
  const ctx = ctxFor(repoFlag, flagBool(p, 'unattended') || process.env.HARNESS_UNATTENDED === '1');
  const b = buildBrief(text, ctx);
  saveBrief(b);
  setCurrent(b);
  logBrief('intake.brief', b, { lowConfidence: Object.values(b.criteriaMeta).filter((m) => m.parseConfidence < 0.7).length, hiddenRemoved: b.hiddenRemoved });
  logLint(b);
  process.stdout.write(json ? JSON.stringify(b, null, 2) + '\n' : renderBrief(b));
  return b.lint.length ? 1 : 0;
}
