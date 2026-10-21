/**
 * The code-free report, `harness status` and the self-check records.
 * See README.md in this folder.
 */
import type { Report } from '../types';
import { harnessHome } from '../lib/paths';
import { collectState, type HarnessState } from './collect';
import { buildReport, indexTasks, taskRow, waitingEpisodes, type BuildOptions } from './build';
import { renderMarkdown } from './markdown';
import { buildTokenSet, defaultExtras, scrubReport, type ScrubResult, type TokenSet, type TokenSources } from './scrub';
import { summariseAll } from './selfcheck';
import { csvLine, WORKLOG_COLUMNS } from './worklog';
import { kindCounts } from '../intake/brief';

export { collectState, buildReport, renderMarkdown, buildTokenSet, scrubReport };

export interface ReportRun {
  state: HarnessState;
  report: Report;
  markdown: string;
  tokens: TokenSet;
  scrub: ScrubResult;
}

export interface ReportOptions {
  since?: string;
  worklog?: string;
  /** Workspace to build the scrub token set from; default: the config's, else the ledger's or assessment's. */
  workspace?: string;
  harnessVersion: string;
  now?: Date;
  /** Override the token sources (tests). */
  tokenSources?: Partial<TokenSources>;
}

/** Where the token set comes from: the config, the ledger, the assessment, the briefs and the run folders. */
export function tokenSourcesFor(st: HarnessState, workspace?: string): TokenSources {
  const root = workspace ?? st.config?.workspaceRoot ?? st.ledger?.workspaceRoot ?? st.assess?.workspaceRoot;
  const repos: TokenSources['repos'] = [];
  for (const r of st.config?.repos ?? []) repos.push({ name: r.name, path: r.path, id: r.id });
  const ids = new Set<string>();
  for (const rec of st.ledger?.records ?? []) for (const id of rec.scope?.repos ?? []) if (id !== '*') ids.add(id);
  for (const run of st.runs) ids.add(run.repo);
  for (const id of ids) if (!repos.some((r) => r.id === id)) repos.push({ id });
  return {
    workspaceRoot: root,
    repos,
    briefs: st.briefs,
    extra: [...defaultExtras(), ...harnessHome().split(/[\\/]+/)],
  };
}

export function makeReport(opts: ReportOptions): ReportRun {
  const state = collectState({ worklog: opts.worklog });
  const build: BuildOptions = { harnessVersion: opts.harnessVersion, since: opts.since, now: opts.now, selfcheck: summariseAll() };
  const report = buildReport(state, build);
  const markdown = renderMarkdown(report);
  const tokens = buildTokenSet({ ...tokenSourcesFor(state, opts.workspace), ...(opts.tokenSources ?? {}) });
  const scrub = scrubReport(report, markdown, tokens);
  return { state, report, markdown, tokens, scrub };
}

/** Find a task by id, or by a ticket-hash prefix of 8+ hex characters. */
export function findTask(st: HarnessState, ref: string): string | null {
  const idx = indexTasks(st);
  const exact = idx.tasks.find((t) => t.id === ref);
  if (exact) return exact.id;
  const h = ref.toLowerCase();
  if (/^[0-9a-f]{8,64}$/.test(h)) {
    const hits = idx.tasks.filter((t) => (t.brief?.ticketHash ?? '').startsWith(h));
    if (hits.length === 1) return hits[0].id;
  }
  return null;
}

/**
 * One work-log row (the columns of `WORKLOG_COLUMNS`), filled with what the
 * harness measured; the user fills the rest (ACUs, time to PR, rework rounds,
 * review findings, outcome, size).
 */
export function worklogRowFor(st: HarnessState, taskId: string, harnessVersion: string): { header: string; row: string; ticketHash: string } | null {
  const idx = indexTasks(st);
  const acc = idx.tasks.find((t) => t.id === taskId);
  if (!acc) return null;
  const r = taskRow(acc, st, idx.sessionTask, idx.prompts, idx.events);
  const kinds = acc.brief ? Object.entries(kindCounts(acc.brief)).sort((a, b) => b[1] - a[1]) : [];
  const date = (acc.brief?.createdAt ?? acc.runs.map((x) => x.evidence?.startedAt ?? '').filter(Boolean).sort()[0] ?? '').slice(0, 10);
  const wroteUp = acc.runs.some((x) => x.writeup);
  const values: Record<(typeof WORKLOG_COLUMNS)[number], string | number | undefined> = {
    ticket_hash: r.ticketHash,
    date,
    task_kind: kinds[0]?.[0],
    size_estimate: undefined,
    user_messages: r.steeringMessages,
    waiting_for_user_episodes: waitingEpisodes(idx.events, acc.sessions),
    acus: undefined,
    time_to_pr_min: undefined,
    pr_rework_rounds: undefined,
    review_findings_by_family: undefined,
    e2e_proof_in_writeup: wroteUp ? (r.verificationEvidence > 0 ? 'yes' : 'no') : undefined,
    clarifications_asked: r.clarificationsAsked,
    repeat_corrections: r.repeatCorrections,
    outcome: undefined,
    harness_version: harnessVersion,
  };
  return { header: csvLine([...WORKLOG_COLUMNS]), row: csvLine(WORKLOG_COLUMNS.map((c) => values[c])), ticketHash: r.ticketHash };
}

