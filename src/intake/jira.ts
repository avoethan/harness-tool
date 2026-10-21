/**
 * Read one Jira issue (read-only) and compose it as the text a pasted ticket would be.
 *
 * `GET <baseUrl>/rest/api/2/issue/<KEY>?fields=summary,description[,<acceptanceField>]`
 * API v2 answers with wiki-markup text, which `parse.ts` already reads.
 *
 * Auth: when the email variable is set, HTTP Basic `email:token` (Jira Cloud); else
 * `Authorization: Bearer <token>` (Data Center personal access tokens). The token is read
 * from the environment only, never stored, printed or logged, and every error message goes
 * through `redactText`. A redirect is never followed; the token is only ever sent to the
 * configured host.
 */
import { httpGetOnce } from '../commands/reviews';
import type { JiraConfig } from '../types';
import { redactText } from '../lib/redact';

export const DEFAULT_EMAIL_ENV = 'HARNESS_JIRA_EMAIL';
export const DEFAULT_TOKEN_ENV = 'HARNESS_JIRA_TOKEN';
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const TIMEOUT_MS = 20000;

export type JiraResult = { ok: true; text: string; key: string } | { ok: false; exit: 1 | 2; message: string };

function fail(exit: 1 | 2, message: string): JiraResult {
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

export async function fetchJiraTicket(key: string, cfg: JiraConfig | undefined, env: NodeJS.ProcessEnv = process.env): Promise<JiraResult> {
  if (!JIRA_KEY_RE.test(key)) return fail(2, `"${key}" is not a Jira issue key (expected something like SHOP-102).`);
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
  const token = (env[tokenEnv] || '').trim();
  if (!token) return fail(2, `No Jira token. Set the environment variable ${tokenEnv} to your Jira API token (it is read from the environment only and never stored).`);
  const email = (env[emailEnv] || '').trim();
  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;

  const fields = ['summary', 'description'];
  if (cfg.acceptanceField) fields.push(cfg.acceptanceField);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = `${base.origin}${prefix}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields.map(encodeURIComponent).join(',')}`;
  const headers = { Accept: 'application/json', Authorization: auth, 'User-Agent': 'harness-intake' };

  let res;
  try {
    res = await httpGetOnce(url, headers, TIMEOUT_MS);
  } catch (e) {
    return fail(1, `Could not reach Jira for ${key}: ${(e as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400) {
    let sameHost = false;
    try {
      sameHost = !!res.headers.location && new URL(res.headers.location, url).host === base.host;
    } catch {
      sameHost = false;
    }
    return fail(1, sameHost ? `Jira answered ${res.status} (a redirect) for ${key}; check jira.baseUrl.` : `Jira answered ${res.status} for ${key} with a redirect to another host; refused. Check jira.baseUrl.`);
  }
  if (res.status !== 200) {
    const hint = res.status === 401 || res.status === 403 ? ' (check the token and email variables)' : res.status === 404 ? ' (no such issue, or no access to it)' : '';
    return fail(1, `Jira answered ${res.status} for ${key}${hint}.`);
  }
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
  const acceptance = cfg.acceptanceField ? fieldText(f[cfg.acceptanceField]) : '';
  return { ok: true, key, text: composeTicket(summary, fieldText(f.description), acceptance) };
}
