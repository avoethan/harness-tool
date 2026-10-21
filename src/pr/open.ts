/**
 * `harness pr open`: open the pull request for a task branch (personal setting only, run by the user).
 * See src/pr/README.md.
 *
 * The one place the harness writes to GitHub. The guard denies `harness pr ...` from every agent
 * (HARNESS_ADMIN_SUBS), so only a person in a terminal reaches it.
 */
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { loadConfig, repoIdFor, resolveConfig } from '../lib/config';
import { writeJson } from '../lib/fsx';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import { loadBrief, runDir, validId } from '../intake/brief';
import { readLedger } from '../intake/ledger';
import { githubRepoFromUrl } from '../land/ci';
import { branchExists, git, gitOk, mainBranchName, mainWorktreeRoot, remoteFor, resolveSha } from '../land/gitops';
import { inferTask } from '../land/land';
import { readLanding } from '../land/record';
import { readRunState } from '../runctl/run';
import { resolveToken } from '../commands/reviews';
import type { HttpResponse } from '../commands/reviews';

export const API_HOST = 'api.github.com';
const MAX_BODY = 60_000;

export type HttpSend = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, body: string | null, timeoutMs: number) => Promise<HttpResponse>;

export const defaultHttpSend: HttpSend = (method, url, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const h = body === null ? headers : { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    const req = https.request(url, { method, headers: h, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (text.length < 5 * 1024 * 1024) text += c;
      });
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
        resolve({ status: res.statusCode ?? 0, headers: out, body: text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });

let httpSend: HttpSend = defaultHttpSend;
/** Tests replace the HTTP layer; returns the previous one. */
export function setHttpSend(fn: HttpSend): HttpSend {
  const prev = httpSend;
  httpSend = fn;
  return prev;
}

export interface PrOptions {
  repo?: string;
  task?: string;
  base?: string;
  draft?: boolean;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PrRequest {
  method: 'POST';
  url: string;
  body: { title: string; body: string; head: string; base: string; draft: boolean };
}

export interface PrRecord {
  url: string;
  number: number;
  at: string;
  head: string;
  base: string;
  /** True when the pull request was already open and nothing was created. */
  existing?: boolean;
}

export interface PrResult {
  exitCode: number;
  message: string;
  request?: PrRequest;
  record?: PrRecord;
}

function oneLine(s: unknown, max = 200): string {
  return redactText(stripHiddenUnicode(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fail(message: string, exitCode = 1): PrResult {
  return { exitCode, message };
}

/** The pull request is for a personal-setting repository only; the team setting pastes the write-up. */
export function teamRefusal(root: string): string | null {
  const r = resolveConfig(root);
  let team = r.source !== 'default' && r.config.setting === 'team';
  if (!team) {
    // a repository listed in the machine config under a team setting
    const cfg = loadConfig();
    const id = repoIdFor(root);
    if (cfg?.setting === 'team' && r.config.setting === 'team' && (cfg.repos ?? []).some((x) => (x.id || repoIdFor(x.path)) === id)) team = true;
  }
  return team ? `${path.basename(root)} is in the team setting: the team setting never posts to GitHub; paste the write-up into the pull request yourself` : null;
}

function branchOf(mainRoot: string, repoId: string, taskId: string, start: string): string {
  const fromRun = readRunState(repoId, taskId)?.branch;
  if (fromRun) return fromRun;
  const fromLanding = readLanding(repoId, taskId)?.branch;
  if (fromLanding) return fromLanding;
  if (branchExists(mainRoot, `task/${taskId}`)) return `task/${taskId}`;
  return gitOk(start, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000) ?? `task/${taskId}`;
}

function findWriteup(repoId: string, taskId: string): { file: string; dir: string } | null {
  const ids = [repoId];
  const wt = readRunState(repoId, taskId)?.worktree;
  if (wt) ids.unshift(repoIdFor(wt));
  for (const id of ids) {
    const dir = runDir(id, taskId);
    const file = path.join(dir, 'writeup.md');
    if (fs.existsSync(file)) return { file, dir };
  }
  return null;
}

function titleFor(mainRoot: string, taskId: string): string {
  const b = loadBrief(taskId);
  if (b?.title) return oneLine(b.title, 250);
  try {
    const t = readLedger(mainRoot).tasks.find((x) => x.id === taskId);
    if (t?.title) return oneLine(t.title, 250);
  } catch {
    /* no ledger */
  }
  return taskId;
}

function defaultBase(mainRoot: string, remote: string, flag?: string): string {
  if (flag) return flag;
  const head = gitOk(mainRoot, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], 5000);
  if (head && head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  return mainBranchName(mainRoot);
}

function remoteTip(mainRoot: string, remote: string, branch: string): { ok: true; sha: string | null } | { ok: false; detail: string } {
  const r = git(mainRoot, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], 60_000);
  if (r.code !== 0) return { ok: false, detail: oneLine(r.stderr || r.stdout, 200) };
  const line = r.stdout.split(/\r?\n/).find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return { ok: true, sha: line ? line.split('\t')[0].trim() : null };
}

async function call(method: 'GET' | 'POST', url: string, token: string, body: string | null): Promise<{ ok: true; res: HttpResponse } | { ok: false; message: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: 'bad url' };
  }
  if (u.protocol !== 'https:' || u.hostname !== API_HOST) return { ok: false, message: `refusing to call ${u.hostname}: only ${API_HOST} is allowed` };
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'harness-pr', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    return { ok: true, res: await httpSend(method, url, headers, body, 30_000) };
  } catch (e) {
    return { ok: false, message: `network error: ${oneLine((e as Error).message)}` };
  }
}

function apiError(status: number, body: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string }> };
    detail = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join('; ');
  } catch {
    /* not JSON */
  }
  const why =
    status === 401
      ? 'the token was not accepted (401)'
      : status === 403
        ? 'access denied or rate limited (403)'
        : status === 404
          ? 'repository not found, or the token cannot write pull requests there (404)'
          : status === 422
            ? 'GitHub refused the pull request (422)'
            : `GitHub answered ${status}`;
  return detail ? `${why}: ${oneLine(detail)}` : why;
}

export async function openPr(opts: PrOptions): Promise<PrResult> {
  const env = opts.env ?? process.env;
  const start = path.resolve(opts.repo ?? process.cwd());
  const mainRoot = fs.existsSync(start) ? mainWorktreeRoot(start) : null;
  if (!mainRoot) return fail(`${start} is not inside a git repository`, 2);
  const refusal = teamRefusal(mainRoot);
  if (refusal) return fail(refusal, 4);
  const repoId = repoIdFor(mainRoot);
  const taskId = opts.task ?? inferTask(start, repoId);
  if (!taskId) return fail('no task: pass --task <id>, or run from the task branch task/<id>, or claim a task first', 2);
  if (!validId(taskId)) return fail(`invalid task id ${JSON.stringify(taskId.slice(0, 40))}`, 2);
  const branch = branchOf(mainRoot, repoId, taskId, start);
  const local = branchExists(mainRoot, branch) ? resolveSha(mainRoot, branch) : null;
  if (!local) return fail(`no branch ${branch} in ${path.basename(mainRoot)}; the task's work must be committed on it, then push the branch yourself: git push -u origin ${branch}`);
  const remote = remoteFor(mainRoot, branch);
  if (!remote) return fail(`${path.basename(mainRoot)} has no remote; add one and push the branch yourself first: git push -u origin ${branch}`);
  const gh = githubRepoFromUrl(gitOk(mainRoot, ['config', '--get', `remote.${remote}.url`], 5000));
  if (!gh) return fail(`remote ${remote} is not a github.com repository; \`harness pr open\` only opens GitHub pull requests`);
  const tip = remoteTip(mainRoot, remote, branch);
  if (!tip.ok) return fail(`cannot read ${remote}: ${tip.detail}; check the remote, then push the branch yourself: git push -u ${remote} ${branch}`);
  if (tip.sha !== local) {
    return fail(
      tip.sha === null
        ? `branch ${branch} is not on ${remote}; push the branch yourself first: git push -u ${remote} ${branch}`
        : `branch ${branch} on ${remote} (${tip.sha.slice(0, 10)}) is not at your local tip (${local.slice(0, 10)}); push the branch yourself first: git push -u ${remote} ${branch}`,
    );
  }
  const wu = findWriteup(repoId, taskId);
  if (!wu) return fail(`no write-up for ${taskId}; run \`harness gate\` first (it writes the write-up when the gate passes), then run this again`);
  let text = fs.readFileSync(wu.file, 'utf8');
  if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY) + '\n\n(The write-up was cut here; the full text is in the task run folder.)\n';
  const base = defaultBase(mainRoot, remote, opts.base);
  const request: PrRequest = {
    method: 'POST',
    url: `https://${API_HOST}/repos/${gh.owner}/${gh.repo}/pulls`,
    body: { title: titleFor(mainRoot, taskId), body: text, head: branch, base, draft: !!opts.draft },
  };
  if (opts.dryRun) return { exitCode: 0, message: `Dry run: would open a pull request ${branch} -> ${base} in ${gh.owner}/${gh.repo}; nothing was sent.`, request };

  const tok = resolveToken(env);
  if (!tok) return fail('no GitHub token: set GITHUB_TOKEN or GH_TOKEN, or sign in with `gh auth login`, then run this again');
  const save = (rec: PrRecord): void => {
    try {
      writeJson(path.join(wu.dir, 'pr.json'), rec);
    } catch {
      /* the URL is printed anyway */
    }
  };

  const listUrl = `https://${API_HOST}/repos/${gh.owner}/${gh.repo}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${gh.owner}:${branch}`)}`;
  const found = await call('GET', listUrl, tok.token, null);
  if (!found.ok) return fail(found.message);
  if (found.res.status !== 200) return fail(apiError(found.res.status, found.res.body));
  try {
    const list = JSON.parse(found.res.body) as Array<{ html_url?: string; number?: number; base?: { ref?: string } }>;
    const hit = Array.isArray(list) ? list.find((p) => typeof p.html_url === 'string' && typeof p.number === 'number') : undefined;
    if (hit) {
      const rec: PrRecord = { url: hit.html_url as string, number: hit.number as number, at: new Date().toISOString(), head: branch, base: hit.base?.ref ?? base, existing: true };
      save(rec);
      return { exitCode: 0, message: `A pull request for ${branch} is already open: ${rec.url} (nothing created)`, record: rec };
    }
  } catch {
    return fail('GitHub answered with something that is not JSON');
  }

  const made = await call('POST', request.url, tok.token, JSON.stringify(request.body));
  if (!made.ok) return fail(made.message);
  if (made.res.status !== 201 && made.res.status !== 200) return fail(apiError(made.res.status, made.res.body));
  try {
    const j = JSON.parse(made.res.body) as { html_url?: string; number?: number };
    if (typeof j.html_url !== 'string' || typeof j.number !== 'number') throw new Error('shape');
    const rec: PrRecord = { url: j.html_url, number: j.number, at: new Date().toISOString(), head: branch, base };
    save(rec);
    return { exitCode: 0, message: `Opened pull request #${rec.number}: ${rec.url}`, record: rec };
  } catch {
    return fail('GitHub answered with something unexpected; check the repository for the pull request');
  }
}
