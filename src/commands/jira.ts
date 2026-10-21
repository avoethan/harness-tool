/**
 * `harness jira comment [--task <id>] [--repo <path>] [--key <KEY>] [--pr <url>] [--dry-run] [--json]`
 * `harness jira create  [--task <id>] [--repo <path>] [--key <KEY>] [--from blocked|feedback|"<text>"] [--one]
 *                       [--project <KEY>] [--type <name>] [--pr <url>] [--yes] [--dry-run] [--json]`
 *
 * The two places the harness writes to Jira. Run by the user only (the guard denies `harness jira`
 * from every agent). See src/jira/README.md.
 *
 * Exit codes: 0 done, drafted or dry run; 1 refused or failed; 2 usage (no key, no project, Jira or its token not set up).
 */
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagStr, parseArgv } from '../lib/argv';
import { instrument } from '../lib/log';
import { jiraComment, jiraCreate, type JiraOutcome } from '../jira/run';

export const meta: CommandMeta = {
  name: 'jira',
  summary: 'Write to Jira: comment the result on the ticket, or draft a follow-up ticket (you run it)',
  usage:
    'harness jira comment [--task <id>] [--repo <path>] [--key <KEY>] [--pr <url>] [--dry-run] [--json] | harness jira create [--task <id>] [--repo <path>] [--key <KEY>] [--from blocked|feedback|"<text>"] [--one] [--project <KEY>] [--type <name>] [--pr <url>] [--yes] [--dry-run] [--json]',
  examples: ['harness jira comment --dry-run', 'harness jira comment --pr https://github.com/acme/app/pull/7', 'harness jira create --from blocked', 'harness jira create --from feedback --yes'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set([...DEFAULT_BOOLEANS, 'one']));
  const sub = p.positional[0];
  if (sub !== 'comment' && sub !== 'create') {
    process.stderr.write(`jira: ${sub ? `unknown subcommand ${sub}` : 'a subcommand is required'}\nUsage: ${meta.usage}\n`);
    return 2;
  }
  const json = p.flags.json === true;
  const base = {
    ...(flagStr(p, 'repo') ? { repo: flagStr(p, 'repo') } : {}),
    ...(flagStr(p, 'task') ? { task: flagStr(p, 'task') } : {}),
    ...(flagStr(p, 'key') ? { key: flagStr(p, 'key') } : {}),
    ...(flagStr(p, 'pr') ? { pr: flagStr(p, 'pr') } : {}),
    dryRun: p.flags['dry-run'] === true,
  };
  let r: JiraOutcome;
  if (sub === 'comment') r = await jiraComment(base);
  else {
    r = await jiraCreate({
      ...base,
      ...(flagStr(p, 'from') !== undefined ? { from: flagStr(p, 'from') } : {}),
      ...(flagStr(p, 'project') ? { project: flagStr(p, 'project') } : {}),
      ...(flagStr(p, 'type') ? { type: flagStr(p, 'type') } : {}),
      one: p.flags.one === true,
      yes: p.flags.yes === true || p.flags.y === true,
    });
  }
  instrument({ event: `jira.${sub}`, ids: { outcome: r.exitCode !== 0 ? 'refused' : r.sent ? 'sent' : 'not-sent' }, counts: { exitCode: r.exitCode } });
  if (json) {
    process.stdout.write(
      JSON.stringify({ exitCode: r.exitCode, message: r.message, sent: !!r.sent, ...(r.requests ? { requests: r.requests } : {}), ...(r.drafts ? { drafts: r.drafts } : {}), ...(r.created ? { created: r.created } : {}), ...(r.commentId ? { commentId: r.commentId } : {}) }, null, 2) + '\n',
    );
  } else if (r.exitCode === 0) {
    process.stdout.write(r.message + '\n');
  } else {
    process.stderr.write(`jira: ${r.message}\n`);
    if (r.exitCode === 2) process.stderr.write(`Usage: ${meta.usage}\n`);
  }
  return r.exitCode;
}
