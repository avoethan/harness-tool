/**
 * The report as plain-language Markdown: one table per section, counts only.
 * Every word here is fixed text or a key from the report's own vocabulary
 * (build.ts), so the scrubber can tell the report's words from the
 * workspace's.
 */
import type { Report, TaskReportRow } from '../types';

const SECTION_TEXT = {
  tiers: 'How strongly each standard is backed: declared in config or CI, counted in most of the code, or seen once.',
  families: 'What the standards are about.',
  checks: 'Runnable checks discovery generated for the standards, by what a failure does: block stops the work, warn reports it, judgment asks a person.',
  checkTypes: 'The tool each generated check runs.',
  findings: 'Findings from reading the existing agent setup, by check.',
  classes: 'What the assessment decided for each line of the existing agent files.',
  proposals: 'Changes written for the team to review through its own pull-request process; the harness never applies them.',
  tasks: 'One row per task, keyed by the first 12 characters of the ticket hash (never the title).',
  learning: 'Mistakes the learning loop captured and what became of them.',
  caps: 'Times a cap stopped work.',
  perTicket: 'One row per task folder with the headline numbers of its digest (`harness digest` prints the whole page); the ticket is the first 12 characters of the ticket hash.',
  rails: 'Tool calls the guard denied, by the rail that denied them.',
  selfcheck: 'Self-check steps the user ran on the work machine and recorded.',
} as const;

const OUTCOME_WORDS: Record<string, string> = {
  merged: 'merged',
  abandoned: 'abandoned',
  reverted: 'reverted',
  'gate-pass': 'gate passed',
  blocked: 'blocked',
  capped: 'stopped at the attempt cap',
  open: 'open',
  other: 'other',
};

function table(head: string[], rows: Array<Array<string | number>>): string[] {
  // Numbers align right; a column holding any text aligns left. The first column is always a label.
  const numeric = head.map((_, i) => i > 0 && rows.every((r) => typeof r[i] === 'number'));
  const out = [`| ${head.join(' | ')} |`, `|${numeric.map((n) => (n ? ' ---: ' : ' --- ')).join('|')}|`];
  for (const r of rows) out.push(`| ${r.map(String).join(' | ')} |`);
  return out;
}

function countTable(label: string, unit: string, m: Record<string, number>): string[] {
  const rows: Array<Array<string | number>> = Object.entries(m).map(([k, v]) => [k, v]);
  const total = rows.reduce((n, r) => n + Number(r[1]), 0);
  if (!rows.length) rows.push(['none', 0]);
  else rows.push(['total', total]);
  return table([label, unit], rows);
}

function taskCells(t: TaskReportRow): Array<string | number> {
  return [
    t.ticketHash.slice(0, 12),
    t.criteria,
    t.checksRun,
    t.checksFailedThenFixed,
    t.checksPreExisting ?? 0,
    t.gateVerdict === 'none' ? 'no run' : t.gateVerdict,
    t.gateRuns ?? 0,
    t.verificationEvidence,
    t.standardsFlagged,
    t.clarificationsAsked,
    t.repeatCorrections,
    t.steeringMessages,
    t.reworkRounds === undefined ? 'not logged' : t.reworkRounds,
    OUTCOME_WORDS[t.outcome] ?? 'other',
  ];
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  L.push('# Harness report', '');
  const p = r.period ?? {};
  const covers = p.from && p.to ? `Covers ${p.from} to ${p.to}` : 'No dated records yet';
  L.push(`Harness version ${r.harnessVersion}. ${covers}${p.since ? ` (counting from ${p.since})` : ''}. Generated ${r.generatedAt.slice(0, 10)}.`);
  L.push('Counts only: no code, no names, no paths and no ticket text.', '');

  L.push('## Standards by tier', '', SECTION_TEXT.tiers, '', ...countTable('Tier', 'Standards', r.standards.byTier), '');
  L.push('## Standards by family', '', SECTION_TEXT.families, '', ...countTable('Family', 'Standards', r.standards.byFamily), '');
  L.push('## Checks generated', '', SECTION_TEXT.checks, '', ...countTable('Mode', 'Checks', r.checks.byMode), '');
  if (r.checks.byType) L.push('## Checks by tool', '', SECTION_TEXT.checkTypes, '', ...countTable('Tool', 'Checks', r.checks.byType), '');
  L.push('## Assessment findings', '', SECTION_TEXT.findings, '', ...countTable('Check', 'Findings', r.assessment.findingsByCheck), '');
  L.push('## Assessment line classes', '', SECTION_TEXT.classes, '', ...countTable('Class', 'Lines', r.assessment.classifications), '');
  L.push('## Team proposals', '', SECTION_TEXT.proposals, '', ...table(['Item', 'Count'], [['proposals written', r.teamProposals]]), '');

  L.push('## Tasks', '', SECTION_TEXT.tasks);
  L.push(
    'Checks run counts gate steps that ran; failed then fixed counts steps that failed in some gate run and pass now; already failing at base counts steps whose latest result failed the same way at the base commit (pre-existing, not caused by the task); steering messages are user prompts after the first in each session tied to the task; rework rounds come from the work log.',
    '',
  );
  const head = ['Ticket', 'Criteria', 'Checks run', 'Failed then fixed', 'Already failing at base', 'Gate verdict', 'Gate runs', 'Verification evidence', 'Standards flagged', 'Clarifications asked', 'Repeat corrections', 'Steering messages', 'Rework rounds', 'Outcome'];
  const rows = r.tasks.map(taskCells);
  if (!rows.length) rows.push(['none', 0, 0, 0, 0, 'no run', 0, 0, 0, 0, 0, 0, 'not logged', 'none']);
  L.push(...table(head, rows), '');

  const pt = r.perTicket ?? [];
  L.push('## Per ticket', '', SECTION_TEXT.perTicket, '');
  const ptRows: Array<Array<string | number>> = pt.map((t) => [
    t.ticketHash.slice(0, 12),
    t.criteria,
    t.gateAttempts,
    t.gateVerdict === 'none' ? 'no run' : t.gateVerdict,
    t.denials,
    t.testsEntries,
    t.expectChanges,
    t.sessions,
    t.costUsd === undefined ? 'not recorded' : t.costUsd,
    t.landing,
    t.pullRequest ? 'yes' : 'no',
    t.minutes === undefined ? 'not known' : t.minutes,
  ]);
  if (!ptRows.length) ptRows.push(['none', 0, 0, 'no run', 0, 0, 0, 0, 'not recorded', 'none', 'no', 'not known']);
  L.push(...table(['Ticket', 'Criteria', 'Gate attempts', 'Gate verdict', 'Rail denials', 'Tests-phase entries', 'Expectation changes', 'Sessions', 'Cost (USD)', 'Landing', 'Pull request', 'Minutes'], ptRows), '');
  L.push('## Rails', '', SECTION_TEXT.rails, '', ...countTable('Rail', 'Denials', r.rails ?? {}), '');

  const l = r.learning;
  L.push('## Learning loop', '', SECTION_TEXT.learning, '', ...table(['Event', 'Lessons'], [['captured', l.captured], ['proven', l.proven], ['approved', l.approved], ['expired', l.expired]]), '');
  const c = r.caps ?? { tasksAtGateCap: 0, stopReleasesAtCap: 0 };
  L.push('## Caps', '', SECTION_TEXT.caps, '', ...table(['Cap', 'Hits'], [['tasks released at the gate attempt cap', c.tasksAtGateCap], ['Stop hook releases at the cap', c.stopReleasesAtCap]]), '');

  L.push('## Self-checks', '', SECTION_TEXT.selfcheck, '');
  const sc = r.selfcheck ?? {};
  const scRows: Array<Array<string | number>> = Object.entries(sc).map(([agent, s]) => [agent, s!.steps, s!.recorded, s!.confirmed.length, s!.different.length, s!.different.join(' ') || 'none']);
  if (!scRows.length) scRows.push(['none', 0, 0, 0, 0, 'none']);
  L.push(...table(['Agent', 'Steps', 'Recorded', 'As expected', 'Different', 'Steps that differed'], scRows), '');
  if (r.worklogRows !== undefined) L.push(`Work log: ${r.worklogRows} row(s) read.`, '');
  return L.join('\n');
}
