/**
 * Read one Jira issue (read-only) and compose it as the text a pasted ticket would be.
 *
 * `GET <baseUrl>/rest/api/2/issue/<KEY>?fields=summary,description[,<acceptanceField>]`
 * API v2 answers with wiki-markup text, which `parse.ts` already reads.
 *
 * Auth: when the email variable is set, HTTP Basic `email:token` (Jira Cloud); else
 * `Authorization: Bearer <token>` (Data Center personal access tokens). The token comes from
 * `harness jira token set` (kept under the harness home, never in the agents' environment) or,
 * as before, from the environment; it is never printed or logged, and every error message goes
 * through `redactText`. A redirect is never followed; the token is only ever sent to the
 * configured host.
 */
import { CERT_HELP, isCertChainError } from '../lib/tlsca';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpGetOnce } from '../commands/reviews';
import { harnessHome } from '../lib/paths';
import type { JiraConfig } from '../types';
import { redactText } from '../lib/redact';

export const DEFAULT_EMAIL_ENV = 'HARNESS_JIRA_EMAIL';
export const DEFAULT_TOKEN_ENV = 'HARNESS_JIRA_TOKEN';
/**
 * The Jira token kept by `harness jira token set`: `~/secrets/jira.json`
 * under the harness home. The guard treats the folder as secret (agents can
 * neither read nor write it), and the token never enters the environment the
 * agents' commands inherit.
 */
export function jiraCredentialsPath(): string {
  return path.join(harnessHome(), 'secrets', 'jira.json');
}

export function loadJiraCredentials(): { token: string; email?: string } | null {
  try {
    const j = JSON.parse(fs.readFileSync(jiraCredentialsPath(), 'utf8')) as { token?: unknown; email?: unknown };
    if (typeof j.token !== 'string' || !j.token.trim()) return null;
    return { token: j.token.trim(), ...(typeof j.email === 'string' && j.email.trim() ? { email: j.email.trim() } : {}) };
  } catch {
    return null;
  }
}

export function saveJiraCredentials(c: { token: string; email?: string }): string {
  const p = jiraCredentialsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify({ token: c.token, ...(c.email ? { email: c.email } : {}) }) + '\n', { mode: 0o600 });
  return p;
}

export function clearJiraCredentials(): boolean {
  try {
    fs.rmSync(jiraCredentialsPath());
    return true;
  } catch {
    return false;
  }
}

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const TIMEOUT_MS = 20000;

export type JiraResult = { ok: true; text: string; key: string } | { ok: false; exit: 1 | 2; message: string };

export function fail(exit: 1 | 2, message: string): { ok: false; exit: 1 | 2; message: string } {
  return { ok: false, exit, message: redactText(message) };
}

export function composeTicket(summary: string, description: string, acceptance: string | null): string {
  const out = [`h1. ${summary.trim()}`, '', 'h2. Description', description.trim()];
  if (acceptance && acceptance.trim()) out.push('', 'h2. Acceptance Criteria', acceptance.trim());
  return out.join('\n') + '\n';
}

function fieldText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface JiraSetup {
  base: URL;
  prefix: string;
  headers: Record<string, string>;
}

/** The configured host, the auth header and the common headers, or the refusal. The token comes from `harness jira token set` (or, as before, the environment). */
export function jiraSetup(cfg: JiraConfig | undefined, env: NodeJS.ProcessEnv = process.env, agent = 'harness-intake'): { ok: true; setup: JiraSetup } | { ok: false; exit: 1 | 2; message: string } {
  if (!cfg?.baseUrl) return fail(2, 'Jira is not set up. Run: harness config set jira.baseUrl https://yourcompany.atlassian.net');
  let base: URL;
  try {
    base = new URL(cfg.baseUrl);
  } catch {
    return fail(2, 'jira.baseUrl is not a valid address. Run: harness config set jira.baseUrl https://yourcompany.atlassian.net');
  }
  if (base.protocol !== 'https:') return fail(2, 'jira.baseUrl must be https.');
  const tokenEnv = cfg.tokenEnv || DEFAULT_TOKEN_ENV;
  const emailEnv = cfg.emailEnv || DEFAULT_EMAIL_ENV;
  const stored = loadJiraCredentials();
  const token = (env[tokenEnv] || '').trim() || stored?.token || '';
  if (!token) return fail(2, `No Jira token. Run \`harness jira token set\` in your own terminal (it asks for the token without showing it and keeps it where only the harness reads it; the environment variable ${tokenEnv} still works, but every agent command inherits it).`);
  const email = (env[emailEnv] || '').trim() || (env[tokenEnv] ? '' : stored?.email ?? '');
  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  return { ok: true, setup: { base, prefix: base.pathname.replace(/\/+$/, ''), headers: { Accept: 'application/json', Authorization: auth, 'User-Agent': agent } } };
}

/** A redirect is never followed: say so, and whether it stayed on the configured host. */
export function redirectMessage(res: { status: number; headers: Record<string, string> }, url: string, base: URL, what: string): string {
  let sameHost = false;
  try {
    sameHost = !!res.headers.location && new URL(res.headers.location, url).host === base.host;
  } catch {
    sameHost = false;
  }
  return sameHost ? `Jira answered ${res.status} (a redirect) for ${what}; check jira.baseUrl.` : `Jira answered ${res.status} for ${what} with a redirect to another host; refused. Check jira.baseUrl.`;
}

export function statusHint(status: number): string {
  return status === 401 || status === 403 ? ' (check the token and email variables)' : status === 404 ? ' (no such issue, or no access to it)' : '';
}

export async function fetchJiraTicket(key: string, cfg: JiraConfig | undefined, env: NodeJS.ProcessEnv = process.env): Promise<JiraResult> {
  if (!JIRA_KEY_RE.test(key)) return fail(2, `"${key}" is not a Jira issue key (expected something like SHOP-102).`);
  const st = jiraSetup(cfg, env);
  if (!st.ok) return st;
  const { base, prefix, headers } = st.setup;

  const fields = ['summary', 'description'];
  if (cfg?.acceptanceField) fields.push(cfg.acceptanceField);
  const url = `${base.origin}${prefix}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields.map(encodeURIComponent).join(',')}`;

  let res;
  try {
    res = await httpGetOnce(url, headers, TIMEOUT_MS);
  } catch (e) {
    return fail(1, `Could not reach Jira for ${key}: ${(e as Error).message}${isCertChainError(e) ? `\n${CERT_HELP}` : ''}`);
  }
  if (res.status >= 300 && res.status < 400) return fail(1, redirectMessage(res, url, base, key));
  if (res.status !== 200) return fail(1, `Jira answered ${res.status} for ${key}${statusHint(res.status)}.`);
  let data: { fields?: Record<string, unknown> };
  try {
    data = JSON.parse(res.body);
  } catch {
    return fail(1, `Jira answered ${key} with something that is not JSON; check jira.baseUrl.`);
  }
  const f = data?.fields;
  if (!f || typeof f !== 'object') return fail(1, `Jira answered ${key} without fields.`);
  const summary = fieldText(f.summary);
  if (!summary.trim()) return fail(1, `Jira issue ${key} has no summary.`);
  const acceptance = cfg?.acceptanceField ? fieldText(f[cfg.acceptanceField]) : '';
  return { ok: true, key, text: composeTicket(summary, fieldText(f.description), acceptance) };
}

/** `jira.filter`: a bare number is a saved filter id, anything else is JQL. */
export function jqlFor(filter: string): string {
  const f = filter.trim();
  return /^\d+$/.test(f) ? `filter=${f}` : f;
}

/**
 * `--jira-next`: the first issue key of `jira.filter` (read-only).
 * `GET /rest/api/2/search?jql=<jql>&maxResults=1&fields=key`.
 */
export async function fetchNextJiraKey(cfg: JiraConfig | undefined, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; key: string } | { ok: false; exit: 1 | 2; message: string }> {
  const filter = (cfg?.filter || '').trim();
  if (!filter) return fail(2, 'No Jira filter. Run: harness config set jira.filter "<JQL or a saved filter id>" (for example: project = SHOP AND status = "Ready for dev" ORDER BY priority DESC)');
  const st = jiraSetup(cfg, env);
  if (!st.ok) return st;
  const { base, prefix, headers } = st.setup;
  const url = `${base.origin}${prefix}/rest/api/2/search?jql=${encodeURIComponent(jqlFor(filter))}&maxResults=1&fields=key`;
  let res;
  try {
    res = await httpGetOnce(url, headers, TIMEOUT_MS);
  } catch (e) {
    return fail(1, `Could not reach Jira for the filter: ${(e as Error).message}${isCertChainError(e) ? `\n${CERT_HELP}` : ''}`);
  }
  if (res.status >= 300 && res.status < 400) return fail(1, redirectMessage(res, url, base, 'the filter'));
  if (res.status !== 200) return fail(1, `Jira answered ${res.status} for the filter${res.status === 400 ? ' (Jira did not accept the JQL; check jira.filter)' : statusHint(res.status).replace('no such issue, or no access to it', 'no such filter, or no access to it')}.`);
  let data: { issues?: Array<{ key?: unknown }> };
  try {
    data = JSON.parse(res.body);
  } catch {
    return fail(1, 'Jira answered the filter with something that is not JSON; check jira.baseUrl.');
  }
  const key = Array.isArray(data?.issues) ? data.issues[0]?.key : undefined;
  if (typeof key !== 'string' || !key) return fail(1, 'no ticket in the filter');
  if (!JIRA_KEY_RE.test(key)) return fail(1, 'Jira answered the filter with something that is not an issue key.');
  return { ok: true, key };
}
