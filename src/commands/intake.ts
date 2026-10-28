/**
 * `harness intake` — turn a pasted ticket into a brief.
 *
 *   harness intake --from <file|-> [--repo <path>] [--unattended] [--json]
 *   harness intake --jira <KEY> [--repo <path>] [--unattended] [--json]
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
 * `--jira <KEY>` reads the issue from Jira (read-only, token from the environment), saves it as
 * `<inbox>/<KEY>.txt` and runs the same intake on that file.
 *
 * `--jira-next` takes the first issue of the `jira.filter` search (read-only) and then does the same.
 *
 * Exit codes: 0 ok; 1 plan lint failed (the brief is saved and the problems
 * are listed), nothing found, or Jira refused; 2 usage (including `--jira` with `--from`, a bad
 * key, jira not set up, a missing token).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagBool, flagStr, flagValues, parseArgv } from '../lib/argv';
import { loadConfig, repoIdFor, resolveConfig } from '../lib/config';
import { inboxHome } from '../lib/paths';
import { fetchJiraTicket, fetchNextJiraKey } from '../intake/jira';
import { instrument } from '../lib/log';
import { extractFacts, repoInfos } from '../intake/classify';
import { evidenceLine, scout, scoutTerms } from '../intake/scout';
import { nearestRepoRoot } from '../lib/git';
import { findRepos } from '../assess/project';
import type { HarnessConfig, RepoRef } from '../types';
import { formatQuestionsBlock } from '../intake/ambiguity';
import { UNMAPPED } from '../intake/units';
import { briefSnapshots, recordBriefSnapshots, snapshotLines } from '../intake/localchanges';
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
  usage: 'harness intake (--from <file|-> | --jira <KEY> | --jira-next) [--repo <path>]... [--unattended] [--json] | show [id] | answer <id> (--q <n> --answer "<text>" | --all-recommended) | lint [id] | list | scout [id] [--apply] | add-repo <path> --reason "<why>" [--criteria <AC,...>] [--task <id>]',
  examples: ['harness intake --from ticket.txt', 'pbpaste | harness intake --from -', 'harness intake --jira SHOP-102', 'harness intake --jira-next', 'harness intake --from ticket.txt --unattended', 'harness intake show', 'harness intake answer t-1a2b3c4d5e --q 1 --answer B', 'harness intake answer t-1a2b3c4d5e --all-recommended'],
};

const MAX_TICKET_BYTES = 1024 * 1024;

/** `--q <n>` takes a value here (globally `-q`/`--q` is the quiet switch). */
const BOOLEANS = new Set([...DEFAULT_BOOLEANS, 'unattended', 'all-recommended', 'jira-next', 'apply'].filter((b) => b !== 'q'));

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

function ctxFor(repoFlag: string | undefined, unattended = false, moreRepos: string[] = []) {
  const defaultRepoPath = repoRootFrom(repoFlag);
  const resolved = resolveConfig(defaultRepoPath ?? process.cwd());
  const extra = moreRepos.map((r) => path.resolve(r));
  const config = withLiveRepos(resolved.config, process.cwd());
  const hands = unattended || config.intake?.unattended === true;
  return { config, defaultRepoPath, ...(repoFlag ? { repoPinned: true } : {}), ...(extra.length ? { extraRepoPaths: extra } : {}), ...(hands ? { unattended: true } : {}) };
}

/**
 * The repositories as they are now, not only as the install recorded them: a
 * repository cloned since, or a session opened in a workspace other than the
 * install's, is found by looking at the folder the session is in (the
 * configured workspace when the session is inside it, else the nearest
 * repository or the current folder). Read-only; the config file is not changed.
 */
export function withLiveRepos(config: HarnessConfig, cwd: string): HarnessConfig {
  const known = new Set((config.repos ?? []).map((r) => path.resolve(r.path)));
  const roots = new Set<string>();
  const ws = config.workspaceRoot && path.isAbsolute(config.workspaceRoot) ? path.resolve(config.workspaceRoot) : null;
  if (ws) roots.add(ws);
  const here = path.resolve(cwd);
  if (!ws || !(here === ws || here.startsWith(ws + path.sep))) roots.add(nearestRepoRoot(here) ?? here);
  const found: RepoRef[] = [];
  for (const root of roots) {
    let paths: string[] = [];
    try {
      paths = findRepos(root);
    } catch {
      continue;
    }
    for (const p of paths) {
      const abs = path.resolve(p);
      if (known.has(abs)) continue;
      known.add(abs);
      found.push({ id: repoIdFor(abs), path: abs, name: path.basename(abs), isGit: fs.existsSync(path.join(abs, '.git')) });
    }
  }
  return found.length ? { ...config, repos: [...(config.repos ?? []), ...found] } : config;
}

function repoName(b: BriefFile, id: string): string {
  return id === UNMAPPED ? 'unmapped repo' : (b.repoMap.repos[id]?.name ?? id);
}

/** Plain-language rendering of a brief. */
export function renderBrief(b: BriefFile, local: string[] = snapshotLines(briefSnapshots(b))): string {
  const out: string[] = [];
  out.push(`Brief ${b.id}: ${b.title}`);
  out.push(`Saved: ${briefPath(b.id)}`);
  if (b.repos.length) out.push(`Repos: ${b.repos.map((r) => repoName(b, r)).join(', ')} (current task set to ${b.id})`);
  else out.push('Repos: none mapped yet (see "To find out by running")');
  out.push(...local);
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
    if (m && m.repoHow === 'code') for (const r of m.repos) if (b.scout?.evidence[c.id]?.[r]) out.push(`        found: ${evidenceLine(repoName(b, r), b.scout.evidence[c.id][r])}`);
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

  if (sub === 'scout') return scoutCmd(p.positional[1], repoFlag, flagBool(p, 'apply'), json);
  if (sub === 'add-repo') return addRepo(p.positional[1], flagStr(p, 'task'), flagStr(p, 'reason'), flagStr(p, 'criteria'), json);

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

  let jiraKey = flagStr(p, 'jira');
  const jiraNext = p.flags['jira-next'] === true;
  if (jiraNext && (p.flags.jira !== undefined || p.flags.from !== undefined || stdinDash || sub === 'from')) {
    process.stderr.write('Use --jira-next, --jira <KEY> or --from <file|->, only one of them.\n');
    return 2;
  }
  if (jiraNext) {
    // Read-only: the first issue of jira.filter, then the same path as --jira <KEY>.
    const next = await fetchNextJiraKey(loadConfig()?.jira);
    if (!next.ok) {
      process.stderr.write(`${next.message}\n`);
      return next.exit;
    }
    jiraKey = next.key;
    process.stderr.write(`The first ticket in the Jira filter is ${next.key}.\n`);
  }
  if (p.flags.jira !== undefined && !jiraKey) {
    process.stderr.write('--jira takes an issue key, for example: harness intake --jira SHOP-102\n');
    return 2;
  }
  if (jiraKey && (p.flags.from !== undefined || stdinDash || sub === 'from')) {
    process.stderr.write('Use --jira <KEY> or --from <file|->, not both.\n');
    return 2;
  }

  const from = jiraKey ? undefined : stdinDash ? '-' : (flagStr(p, 'from') || undefined) ?? (sub === 'from' ? p.positional[1] : undefined);
  if (!from && !jiraKey) {
    process.stderr.write(`usage: ${meta.usage}\n`);
    return 2;
  }
  let text: string;
  if (jiraKey) {
    // Machine config only: a repository's own config must not be able to point the token at another host.
    const got = await fetchJiraTicket(jiraKey, loadConfig()?.jira);
    if (!got.ok) {
      process.stderr.write(`${got.message}\n`);
      return got.exit;
    }
    text = got.text;
    const dest = path.join(inboxHome(), `${got.key}.txt`);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    } catch {
      process.stderr.write(`Could not save the ticket to ${dest}.\n`);
      return 1;
    }
    process.stderr.write(`Read ${got.key} from Jira; saved to ${dest}\n`);
  } else if (from === '-') text = readStdin();
  else {
    try {
      const st = fs.statSync(from as string);
      if (st.size > MAX_TICKET_BYTES) {
        process.stderr.write(`The ticket file is larger than ${MAX_TICKET_BYTES} bytes; paste only the ticket.\n`);
        return 2;
      }
      text = fs.readFileSync(from as string, 'utf8');
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
  const repoFlags = flagValues(p, 'repo');
  const ctx = ctxFor(repoFlags[0] ?? repoFlag, flagBool(p, 'unattended') || process.env.HARNESS_UNATTENDED === '1', repoFlags.slice(1));
  const b = buildBrief(text, { ...ctx, ...(jiraKey ? { jiraKey } : {}) });
  saveBrief(b);
  setCurrent(b);
  // Local changes already in the repositories (the user's notes) are not the ticket's (src/intake/localchanges.ts).
  recordBriefSnapshots(b, 'intake');
  logBrief('intake.brief', b, { lowConfidence: Object.values(b.criteriaMeta).filter((m) => m.parseConfidence < 0.7).length, hiddenRemoved: b.hiddenRemoved });
  logLint(b);
  process.stdout.write(json ? JSON.stringify(b, null, 2) + '\n' : renderBrief(b));
  return b.lint.length ? 1 : 0;
}

/**
 * `harness intake add-repo <path> --reason "<why>" [--criteria AC2,AC3] [--task <id>]`:
 * the work turned out to need another repository. It joins the same ticket:
 * its HEAD becomes its base commit, its local changes are recorded as not the
 * ticket's, it becomes the current task there, and the write-up says it was
 * added and why. With `--criteria` those criteria also need a change there;
 * without, it is a supporting change the gate checks with its base steps only.
 */
function addRepo(target: string | undefined, taskFlag: string | undefined, reason: string | undefined, criteriaFlag: string | undefined, json: boolean): number {
  if (!target) {
    process.stderr.write('Usage: harness intake add-repo <repository folder> --reason "<why the ticket needs it>" [--criteria AC2,AC3] [--task <id>]\n');
    return 2;
  }
  if (!reason || !reason.trim()) {
    process.stderr.write('add-repo needs --reason "<why the ticket needs this repository>"; the write-up shows it to the reviewer.\n');
    return 2;
  }
  const root = nearestRepoRoot(path.resolve(target));
  if (!root) {
    process.stderr.write(`${target} is not inside a git repository.\n`);
    return 2;
  }
  const b = taskFlag ? loadBrief(taskFlag) : pickBrief(undefined, undefined);
  if (!b) {
    process.stderr.write('No brief to add the repository to. Pass --task <id> (harness intake list shows them).\n');
    return 1;
  }
  const criteria = (criteriaFlag ?? '').split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase());
  const unknown = criteria.filter((c) => !b.criteria.some((x) => x.id === c));
  if (unknown.length) {
    process.stderr.write(`Not criteria of ${b.id}: ${unknown.join(', ')} (it has ${b.criteria.map((c) => c.id).join(', ')}).\n`);
    return 2;
  }
  const id = repoIdFor(root);
  const prev = b.addedRepos ?? [];
  const existing = prev.find((a) => repoIdFor(a.path) === id);
  const entry = { path: root, criteria: [...new Set([...(existing?.criteria ?? []), ...criteria])], reason: reason.trim(), at: new Date().toISOString() };
  const withAdded: BriefFile = { ...b, addedRepos: [...prev.filter((a) => a !== existing), entry] };
  const next = reassemble(withAdded, ctxFor(undefined));
  saveBrief(next);
  setCurrent(next);
  recordBriefSnapshots(next, 'intake');
  instrument({ event: 'intake.add-repo', task: next.id, ids: { brief: next.id, repo: id }, counts: { criteria: entry.criteria.length, repos: next.repos.length } });
  if (json) {
    process.stdout.write(JSON.stringify({ id: next.id, repos: next.repos, addedRepos: next.addedRepos, units: next.units }, null, 2) + '\n');
    return 0;
  }
  const name = next.repoMap.repos[id]?.name ?? path.basename(root);
  process.stdout.write(`Added ${name} to ${next.id}${entry.criteria.length ? ` for ${entry.criteria.join(', ')}` : ' as a supporting change (its gate runs the base steps; no criterion of its own)'}. Its base is its HEAD now; your local changes there are recorded as not the ticket's.\n`);
  process.stdout.write(renderBrief(next));
  return 0;
}

/**
 * `harness intake scout [id] [--apply] [--json]`: search the workspace's code
 * again for the ticket's routes, tables, paths and identifiers, show per
 * criterion where they were found, and name the repositories with evidence
 * the brief does not list. `--apply` adds those (as `add-repo` would, the
 * evidence as the reason) and re-places the criteria on the new search.
 */
function scoutCmd(id: string | undefined, repoFlag: string | undefined, apply: boolean, json: boolean): number {
  const b = pickBrief(id, repoFlag);
  if (!b) {
    process.stderr.write('No brief found. Run: harness intake --from <file|-> (or pass the brief id).\n');
    return 1;
  }
  const ctx = ctxFor(undefined);
  const infos = repoInfos(ctx.config, [...Object.values(b.repoMap.repos).map((r) => r.path), ...(b.addedRepos ?? []).map((a) => a.path)]);
  const terms: Record<string, ReturnType<typeof scoutTerms>> = {};
  for (const c of b.criteria) terms[c.id] = scoutTerms(b.criteriaMeta[c.id]?.facts ?? extractFacts(c.text), c.text);
  const sc = scout(terms, infos, { budgetMs: 15000 });
  const nameOf = (rid: string) => infos.find((r) => r.id === rid)?.name ?? rid;
  const missing = new Map<string, Set<string>>();
  for (const c of b.criteria) for (const rid of sc.byCriterion[c.id] ?? []) if (!b.repos.includes(rid)) (missing.get(rid) ?? missing.set(rid, new Set()).get(rid)!).add(c.id);
  if (json) {
    process.stdout.write(JSON.stringify({ id: b.id, scout: sc, missing: [...missing].map(([rid, cs]) => ({ repoId: rid, name: nameOf(rid), path: infos.find((r) => r.id === rid)?.path, criteria: [...cs] })) }, null, 2) + '\n');
    if (!apply) return 0;
  } else {
    process.stdout.write(`Scout for ${b.id} over ${infos.length} repositor${infos.length === 1 ? 'y' : 'ies'}${sc.budgetHit ? ' (some walks stopped at the budget; what was found holds)' : ''}:\n`);
    for (const c of b.criteria) {
      const ev = sc.evidence[c.id] ?? {};
      const rids = sc.byCriterion[c.id] ?? [];
      process.stdout.write(`  ${c.id}: ${rids.length ? rids.map(nameOf).join(', ') : sc.noTerms.includes(c.id) ? 'nothing concrete to search for (no route, table, path or identifier in the text)' : 'no file holds its details'}\n`);
      for (const rid of rids) process.stdout.write(`       ${evidenceLine(nameOf(rid), ev[rid] ?? [])}\n`);
    }
    if (!missing.size) process.stdout.write('Every repository with evidence is in the brief.\n');
    else {
      process.stdout.write('Repositories with evidence the brief does not list:\n');
      for (const [rid, cs] of missing) process.stdout.write(`  ${nameOf(rid)} for ${[...cs].join(', ')}${apply ? '' : `  -> harness intake add-repo "${infos.find((r) => r.id === rid)?.path}" --task ${b.id} --criteria ${[...cs].join(',')} --reason "<why>"`}\n`);
      if (!apply) process.stdout.write('Add them all with: harness intake scout --apply\n');
    }
  }
  if (!apply) return 0;
  let next: BriefFile = { ...b, scout: sc };
  const at = new Date().toISOString();
  for (const [rid, cs] of missing) {
    const info = infos.find((r) => r.id === rid)!;
    const reason = `found in the code: ${[...cs].map((cid) => evidenceLine(info.name, sc.evidence[cid]?.[rid] ?? [])).join(' | ')}`.slice(0, 400);
    next = { ...next, addedRepos: [...(next.addedRepos ?? []).filter((a) => repoIdFor(a.path) !== rid), { path: info.path, criteria: [...cs], reason, at }] };
  }
  next = reassemble(next, ctx);
  saveBrief(next);
  setCurrent(next);
  recordBriefSnapshots(next, 'intake');
  instrument({ event: 'intake.scout', task: next.id, ids: { brief: next.id }, counts: { repos: next.repos.length, added: missing.size, withEvidence: Object.values(sc.byCriterion).filter((r) => r.length).length } });
  if (!json) {
    process.stdout.write(missing.size ? `Added ${[...missing.keys()].map(nameOf).join(', ')}; criteria re-placed on the new search.\n` : 'Criteria re-placed on the new search.\n');
    process.stdout.write(renderBrief(next));
  }
  return 0;
}
