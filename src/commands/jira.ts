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
import { ask, askHidden, isInteractive } from '../lib/prompt';
import { clearJiraCredentials, DEFAULT_EMAIL_ENV, DEFAULT_TOKEN_ENV, jiraCredentialsPath, loadJiraCredentials, saveJiraCredentials } from '../intake/jira';

export const meta: CommandMeta = {
  name: 'jira',
  summary: 'Write to Jira: comment the result on the ticket, or draft a follow-up ticket (you run it)',
  usage:
    'harness jira comment [--task <id>] [--repo <path>] [--key <KEY>] [--pr <url>] [--dry-run] [--json] | harness jira create [--task <id>] [--repo <path>] [--key <KEY>] [--from blocked|feedback|"<text>"] [--one] [--project <KEY>] [--type <name>] [--pr <url>] [--yes] [--dry-run] [--json] | harness jira token set [--email <address>] [--from-env] | harness jira token status | harness jira token clear',
  examples: ['harness jira token set --email you@company.com', 'harness jira token status', 'harness jira comment --dry-run', 'harness jira comment --pr https://github.com/acme/app/pull/7', 'harness jira create --from blocked', 'harness jira create --from feedback --yes'],
};

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set([...DEFAULT_BOOLEANS, 'one', 'from-env']));
  const sub = p.positional[0];
  if (sub === 'token') return tokenMain(p.positional[1], flagStr(p, 'email'), p.flags['from-env'] === true);
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

/**
 * `harness jira token set|status|clear`: keep the Jira token where only the
 * harness reads it (`~/secrets/jira.json`), so it is not in the environment
 * every agent command inherits. `set` asks for the token without echoing it;
 * `--from-env` moves it from HARNESS_JIRA_TOKEN (and the email from
 * HARNESS_JIRA_EMAIL) instead. The value is never printed.
 */
async function tokenMain(action: string | undefined, emailFlag: string | undefined, fromEnv: boolean): Promise<number> {
  if (action === 'status') {
    const c = loadJiraCredentials();
    const env = !!(process.env[DEFAULT_TOKEN_ENV] || '').trim();
    process.stdout.write(c ? `Jira token: kept by the harness (${jiraCredentialsPath()})${c.email ? `, email ${c.email} (Jira Cloud)` : ', no email (Data Center bearer token)'}.\n` : 'Jira token: not kept by the harness.\n');
    if (env) process.stdout.write(`Note: ${DEFAULT_TOKEN_ENV} is also set in the environment and takes precedence; every agent command inherits it. Remove it once the harness keeps the token.\n`);
    return 0;
  }
  if (action === 'clear') {
    process.stdout.write(clearJiraCredentials() ? 'Removed the Jira token the harness kept.\n' : 'The harness kept no Jira token.\n');
    return 0;
  }
  if (action !== 'set') {
    process.stderr.write(`jira token: ${action ? `unknown action ${action}` : 'an action is required'} (set, status or clear)\n`);
    return 2;
  }
  let token: string;
  let email = emailFlag?.trim() || '';
  if (fromEnv) {
    token = (process.env[DEFAULT_TOKEN_ENV] || '').trim();
    if (!email) email = (process.env[DEFAULT_EMAIL_ENV] || '').trim();
    if (!token) {
      process.stderr.write(`jira token set --from-env: ${DEFAULT_TOKEN_ENV} is not set in this terminal.\n`);
      return 2;
    }
  } else {
    if (!isInteractive()) {
      process.stderr.write('jira token set: run it in your own terminal (it asks for the token without showing it), or use --from-env.\n');
      return 2;
    }
    if (!email) email = await ask('Atlassian account email (Jira Cloud; leave empty for a Data Center personal access token): ');
    token = await askHidden('Jira API token (not shown as you type or paste): ');
    if (!token) {
      process.stderr.write('No token given; nothing changed.\n');
      return 2;
    }
  }
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    process.stderr.write('That email does not look like an address; nothing changed.\n');
    return 2;
  }
  const file = saveJiraCredentials({ token, ...(email ? { email } : {}) });
  process.stdout.write(`Kept the Jira token in ${file} (agents can neither read nor change it). Try: harness intake --jira <KEY> in a scratch folder, or ask Devin to.\n`);
  if ((process.env[DEFAULT_TOKEN_ENV] || '').trim()) process.stdout.write(`Now remove ${DEFAULT_TOKEN_ENV} (and ${DEFAULT_EMAIL_ENV}) from your user environment variables, so agent commands no longer inherit it.\n`);
  return 0;
}
