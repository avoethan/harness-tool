/**
 * `harness jira comment` and `harness jira create`: the two places the harness writes to Jira.
 * See src/jira/README.md. The guard denies `harness jira ...` from every agent (HARNESS_ADMIN_SUBS),
 * so only a person in a terminal reaches this. Only the configured Jira host is ever called; the token
 * comes from the environment and is never printed, stored or logged.
 */
import { CERT_HELP, isCertChainError } from '../lib/tlsca';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile, JiraConfig } from '../types';
import { loadConfig, repoIdFor } from '../lib/config';
import { readJsonOr } from '../lib/fsx';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import { loadBrief, runDir, validId } from '../intake/brief';
import { JIRA_KEY_RE, jiraSetup, redirectMessage, type JiraSetup } from '../intake/jira';
import { mainWorktreeRoot } from '../land/gitops';
import { inferTask } from '../land/land';
import { readRunState } from '../runctl/run';
import { httpPostOnce } from '../commands/reviews';
import { blockedReason, commentBody, draftFor, MAX_FEEDBACK_TICKETS, readWriteup, type Draft } from './compose';

const TIMEOUT_MS = 30000;

export interface JiraOptions {
  repo?: string;
  task?: string;
  key?: string;
  pr?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Tests pass the Jira settings; otherwise the machine config's (never a repository's own). */
  cfg?: JiraConfig;
}

export interface CreateOptions extends JiraOptions {
  from?: string;
  project?: string;
  type?: string;
  one?: boolean;
  yes?: boolean;
}

export interface JiraRequest {
  method: 'POST';
  url: string;
  body: unknown;
}

export interface JiraOutcome {
  exitCode: number;
  message: string;
  /** What would be (dry run) or was sent. */
  requests?: JiraRequest[];
  /** The issues created. */
  created?: Array<{ key: string; url: string; linked: boolean }>;
  commentId?: string;
  drafts?: Draft[];
  sent?: boolean;
}

function oneLine(s: unknown, max = 200): string {
  return redactText(stripHiddenUnicode(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fail(message: string, exitCode = 1): JiraOutcome {
  return { exitCode, message: redactText(message) };
}

interface TaskContext {
  mainRoot: string;
  repoId: string;
  taskId: string;
  dirs: string[];
}

function isOutcome(x: TaskContext | JiraOutcome): x is JiraOutcome {
  return 'exitCode' in x;
}

function taskContext(opts: JiraOptions): TaskContext | JiraOutcome {
  const start = path.resolve(opts.repo ?? process.cwd());
  const mainRoot = fs.existsSync(start) ? mainWorktreeRoot(start) : null;
  if (!mainRoot) return fail(`${start} is not inside a git repository`, 2);
  const repoId = repoIdFor(mainRoot);
  const taskId = opts.task ?? inferTask(start, repoId);
  if (!taskId) return fail('no task: pass --task <id>, or run from the task branch task/<id>, or claim a task first', 2);
  if (!validId(taskId)) return fail(`invalid task id ${JSON.stringify(taskId.slice(0, 40))}`, 2);
  const ids = [repoId];
  const wt = readRunState(repoId, taskId)?.worktree;
  if (wt) ids.unshift(repoIdFor(wt));
  return { mainRoot, repoId, taskId, dirs: [...new Set(ids)].map((id) => runDir(id, taskId)) };
}

function firstFile(dirs: string[], name: string): string | null {
  for (const d of dirs) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function prLink(opts: JiraOptions, dirs: string[]): { ok: true; url: string | null } | { ok: false; message: string } {
  if (opts.pr !== undefined) {
    if (!/^https?:\/\/[^\s]+$/.test(opts.pr)) return { ok: false, message: '--pr takes the pull request address, for example https://github.com/acme/app/pull/7' };
    return { ok: true, url: opts.pr };
  }
  const f = firstFile(dirs, 'pr.json');
  const url = f ? readJsonOr<{ url?: unknown } | null>(f, null)?.url : null;
  return { ok: true, url: typeof url === 'string' && /^https?:\/\/[^\s]+$/.test(url) ? url : null };
}

function sourceKey(opts: JiraOptions, taskId: string): string | null {
  if (opts.key) return opts.key;
  const k = loadBrief(taskId)?.jiraKey;
  return k && JIRA_KEY_RE.test(k) ? k : null;
}

function apiError(status: number, body: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
    detail = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ');
  } catch {
    /* not JSON */
  }
  const why =
    status === 401 || status === 403
      ? `Jira refused the request (${status}); check the token and email (harness jira token status; Data Center: personal access token, no email; Cloud: API token and your Atlassian email) and your permission on the project`
      : status === 404
        ? 'Jira says not found (404): no such issue or project, or no access to it'
        : status === 400
          ? 'Jira rejected the request (400)'
          : `Jira answered ${status}`;
  return detail ? `${why}: ${oneLine(detail)}` : why;
}

/** One POST to the configured Jira host only. */
async function jiraPost(setup: JiraSetup, apiPath: string, body: unknown, what: string): Promise<{ ok: true; status: number; body: string } | { ok: false; message: string }> {
  const url = `${setup.base.origin}${setup.prefix}${apiPath}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: 'bad address' };
  }
  if (u.protocol !== 'https:' || u.host !== setup.base.host) return { ok: false, message: `refusing to call ${u.host}: only the configured Jira host is allowed` };
  let res;
  try {
    res = await httpPostOnce(url, setup.headers, JSON.stringify(body), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, message: redactText(`network error for ${what}: ${oneLine((e as Error).message)}${isCertChainError(e) ? `. ${CERT_HELP}` : ''}`) };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, message: redactText(redirectMessage(res, url, setup.base, what)) };
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) return { ok: false, message: redactText(apiError(res.status, res.body)) };
  return { ok: true, status: res.status, body: res.body };
}

function jiraConfig(opts: JiraOptions): JiraConfig | undefined {
  return opts.cfg ?? loadConfig()?.jira;
}

function urlFor(cfg: JiraConfig | undefined, apiPath: string): string {
  try {
    const b = new URL(cfg?.baseUrl ?? '');
    return `${b.origin}${b.pathname.replace(/\/+$/, '')}${apiPath}`;
  } catch {
    return `<jira.baseUrl>${apiPath}`;
  }
}

// ---------------------------------------------------------------------------

export async function jiraComment(opts: JiraOptions): Promise<JiraOutcome> {
  const ctx = taskContext(opts);
  if (isOutcome(ctx)) return ctx;
  const wf = firstFile(ctx.dirs, 'writeup.md');
  if (!wf) return fail(`no write-up for ${ctx.taskId}; run \`harness gate\` first (it writes the write-up when the gate passes), then run this again`);
  if (opts.key !== undefined && !JIRA_KEY_RE.test(opts.key)) return fail(`"${oneLine(opts.key, 40)}" is not a Jira issue key (expected something like SHOP-102)`, 2);
  const key = sourceKey(opts, ctx.taskId);
  if (!key) return fail(`${ctx.taskId} has no Jira ticket key (it was not read with \`harness intake --jira\`); pass --key <KEY>, for example: harness jira comment --key SHOP-102`, 2);
  const pr = prLink(opts, ctx.dirs);
  if (!pr.ok) return fail(pr.message, 2);
  const text = commentBody(readWriteup(fs.readFileSync(wf, 'utf8')), pr.url);
  const cfg = jiraConfig(opts);
  const apiPath = `/rest/api/2/issue/${encodeURIComponent(key)}/comment`;
  const request: JiraRequest = { method: 'POST', url: urlFor(cfg, apiPath), body: { body: text } };
  if (opts.dryRun) return { exitCode: 0, message: `Dry run: would add this comment to ${key}; nothing was sent.\n\n${text}`, requests: [request], sent: false };
  const st = jiraSetup(cfg, opts.env ?? process.env, 'harness-jira');
  if (!st.ok) return fail(st.message, st.exit);
  const r = await jiraPost(st.setup, apiPath, request.body, key);
  if (!r.ok) return fail(r.message);
  let id: string | undefined;
  try {
    const j = JSON.parse(r.body) as { id?: unknown };
    if (typeof j.id === 'string' || typeof j.id === 'number') id = String(j.id);
  } catch {
    /* the comment was accepted either way */
  }
  return { exitCode: 0, message: `Added a comment to ${key}${id ? ` (comment ${id})` : ''}.`, requests: [request], ...(id ? { commentId: id } : {}), sent: true };
}

// ---------------------------------------------------------------------------

function sourceTexts(opts: CreateOptions, ctx: TaskContext): { ok: true; texts: string[] } | JiraOutcome {
  const from = (opts.from ?? '').trim();
  if (!from) return fail('say what the follow-up is about: --from blocked, --from feedback, or --from "<text>"', 2);
  if (from === 'blocked') {
    const ef = firstFile(ctx.dirs, 'evidence.json');
    const ev = ef ? readJsonOr<EvidenceFile | null>(ef, null) : null;
    if (!ev) return fail(`no gate evidence for ${ctx.taskId}; run \`harness gate\` first`);
    const reason = ev.verdict === 'BLOCKED' ? blockedReason(ev.reasons ?? []) : null;
    if (!reason) return fail(`the gate for ${ctx.taskId} is not BLOCKED (last verdict ${ev.verdict}); there is no blocked reason to open a ticket from`);
    return { ok: true, texts: [`Blocked: ${reason}`] };
  }
  if (from === 'feedback') {
    const wf = firstFile(ctx.dirs, 'writeup.md');
    if (!wf) return fail(`no write-up for ${ctx.taskId}; run \`harness gate\` first`);
    const items = readWriteup(fs.readFileSync(wf, 'utf8')).feedback;
    if (!items.length) return fail('the write-up has no "Feedback wanted" items');
    if (opts.one) return { ok: true, texts: [`Feedback wanted on ${ctx.taskId}:\n${items.map((i) => `* ${i}`).join('\n')}`] };
    if (items.length > MAX_FEEDBACK_TICKETS) return fail(`the write-up has ${items.length} feedback items, more than ${MAX_FEEDBACK_TICKETS} separate tickets; add --one to list them all in one ticket`);
    return { ok: true, texts: items };
  }
  return { ok: true, texts: [from] };
}

export async function jiraCreate(opts: CreateOptions): Promise<JiraOutcome> {
  const ctx = taskContext(opts);
  if (isOutcome(ctx)) return ctx;
  if (opts.key !== undefined && !JIRA_KEY_RE.test(opts.key)) return fail(`"${oneLine(opts.key, 40)}" is not a Jira issue key (expected something like SHOP-102)`, 2);
  const src = sourceTexts(opts, ctx);
  if (!('texts' in src)) return src;
  const texts = src.texts;
  const cfg = jiraConfig(opts);
  const project = opts.project ?? cfg?.project;
  if (!project || !/^[A-Z][A-Z0-9_]+$/.test(project)) return fail(project ? `"${oneLine(project, 40)}" is not a project key (for example SHOP)` : 'no project: pass --project <KEY>, or run: harness config set jira.project SHOP', 2);
  const type = (opts.type ?? cfg?.followupType ?? 'Task').trim() || 'Task';
  const key = sourceKey(opts, ctx.taskId);
  const pr = prLink(opts, ctx.dirs);
  if (!pr.ok) return fail(pr.message, 2);
  const drafts = texts.map((t) => draftFor(t, key, pr.url));
  const requests: JiraRequest[] = drafts.map((d) => ({
    method: 'POST',
    url: urlFor(cfg, '/rest/api/2/issue'),
    body: { fields: { project: { key: project }, summary: d.summary, description: d.description, issuetype: { name: type } } },
  }));
  const shown = drafts
    .map((d, i) => `Draft ${i + 1} of ${drafts.length} (${project}, ${type}${key ? `, relates to ${key}` : ''})\n  Summary: ${d.summary}\n  Description:\n${d.description.split('\n').map((l) => `    ${l}`).join('\n')}`)
    .join('\n\n');
  if (opts.dryRun || !opts.yes) {
    const tail = opts.dryRun ? 'Dry run: nothing was sent.' : `Nothing was sent. Add --yes to create the ticket${drafts.length > 1 ? 's' : ''} in Jira.`;
    return { exitCode: 0, message: `${shown}\n\n${tail}`, requests, drafts, sent: false };
  }
  const st = jiraSetup(cfg, opts.env ?? process.env, 'harness-jira');
  if (!st.ok) return fail(st.message, st.exit);
  const created: Array<{ key: string; url: string; linked: boolean }> = [];
  const notes: string[] = [];
  for (const req of requests) {
    const r = await jiraPost(st.setup, '/rest/api/2/issue', req.body, 'the new ticket');
    if (!r.ok) {
      const done = created.length ? ` (already created: ${created.map((c) => c.key).join(', ')})` : '';
      return { ...fail(`${r.message}${done}`), created, drafts, sent: created.length > 0 };
    }
    let newKey = '';
    try {
      const j = JSON.parse(r.body) as { key?: unknown };
      if (typeof j.key === 'string' && JIRA_KEY_RE.test(j.key)) newKey = j.key;
    } catch {
      /* handled below */
    }
    if (!newKey) return { ...fail('Jira accepted the ticket but answered without its key; check the project in Jira before trying again'), created, drafts, sent: true };
    let linked = false;
    if (key) {
      const l = await jiraPost(st.setup, '/rest/api/2/issueLink', { type: { name: 'Relates' }, inwardIssue: { key: newKey }, outwardIssue: { key } }, 'the link');
      if (l.ok) linked = true;
      else notes.push(`${newKey} was created but not linked to ${key}: ${l.message}`);
    }
    created.push({ key: newKey, url: `${st.setup.base.origin}${st.setup.prefix}/browse/${newKey}`, linked });
  }
  const lines = created.map((c) => `Created ${c.key}: ${c.url}${c.linked ? ` (linked to ${key})` : ''}`);
  return { exitCode: 0, message: [...lines, ...notes].join('\n'), created, drafts, requests, sent: true };
}
