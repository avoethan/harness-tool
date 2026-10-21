/**
 * Waiting for CI after a landing (DESIGN §2.8). Three providers:
 *
 *   local   `harness gate --hook ci --base <main before the landing>` on the
 *           main checkout, as a child process with `CI=true` (the CI
 *           stand-in: the same gate the generated workflow runs). Its
 *           evidence is copied to runs/<repoId>/<task>/ci-<n>-<kind>.json so
 *           a later run does not overwrite the failure evidence. Rerun: run
 *           it again.
 *   github  polls `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`
 *           read-only on api.github.com with a token from the environment
 *           (GITHUB_TOKEN or GH_TOKEN; never stored, printed or logged),
 *           with a poll interval, a grace period for checks to appear and a
 *           maximum wait. The harness never triggers a rerun on GitHub (that
 *           would be a write), so `canRerun` is false and the landing goes
 *           straight to the fix attempt.
 *   none    skips with a note.
 *
 * `--ci local` with a CI command (`--ci-command`, or `land.ciCommand` in the
 * config) runs that command instead of the gate (commandCi): an argv array,
 * never a shell string, in the landing checkout at the landed commit with
 * CI=true; exit 0 is green. Its output (redacted, the last 200 lines) is the
 * CI evidence and the failure text the fix session reads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, writeJson } from '../lib/fsx';
import { runAsync } from '../lib/exec';
import { redactText } from '../lib/redact';
import { stripHiddenUnicode } from '../lib/unicode';
import { tokenizeScript } from '../gate/scripts';
import { runsDir } from '../lib/paths';
import { defaultHttpGet, nextLink, type HttpGet } from '../commands/reviews';
import type { GateRunner } from './gaterun';

export type CiStatus = 'green' | 'red' | 'none' | 'timeout' | 'error';

export interface CiCheck {
  sha: string;
  /** The main checkout (local CI runs there). */
  mainDir: string;
  repoId: string;
  taskId: string;
  /** main before the landing (the CI diff base). */
  base: string;
  kind: 'initial' | 'rerun' | 'after-fix';
  /** 1-based count of CI runs in this landing. */
  n: number;
}

export interface CiResult {
  status: CiStatus;
  detail: string;
  evidencePath?: string;
  /** Failure text for the fix prompt (gate reasons or failing check names; never secrets: the gate redacts). */
  failureText?: string;
  durationMs: number;
}

export interface CiProvider {
  name: 'local' | 'github' | 'none';
  canRerun: boolean;
  wait(c: CiCheck): Promise<CiResult>;
}

/** The local CI stand-in: the gate in ci mode on the main checkout. */
export function localCi(gate: GateRunner, opts: { timeoutMs?: number } = {}): CiProvider {
  return {
    name: 'local',
    canRerun: true,
    async wait(c) {
      const t0 = Date.now();
      const o = await gate.run({ repo: c.mainDir, hook: 'ci', base: c.base, env: { CI: 'true', HARNESS_CI: 'local' }, timeoutMs: opts.timeoutMs });
      let evidencePath: string | undefined;
      if (o.evidencePath && fs.existsSync(o.evidencePath)) {
        const dst = path.join(runsDir(), c.repoId, c.taskId, `ci-${c.n}-${c.kind}.json`);
        try {
          ensureDir(path.dirname(dst));
          fs.copyFileSync(o.evidencePath, dst);
          evidencePath = dst;
        } catch {
          evidencePath = o.evidencePath;
        }
      }
      const durationMs = Date.now() - t0;
      if (o.error && !o.verdict) return { status: 'error', detail: `the local CI gate could not run: ${o.error.slice(0, 200)}`, durationMs, ...(evidencePath ? { evidencePath } : {}) };
      if (o.verdict === 'PASS') return { status: 'green', detail: `local CI gate PASS on ${c.sha.slice(0, 10)}`, durationMs, ...(evidencePath ? { evidencePath } : {}) };
      const failed = o.steps.filter((s) => s.status === 'fail').map((s) => s.name);
      return {
        status: 'red',
        detail: `local CI gate ${o.verdict ?? 'FAIL'} on ${c.sha.slice(0, 10)}${failed.length ? `: ${failed.join(', ')}` : ''}`,
        failureText: o.reasons.slice(0, 40).join('\n'),
        durationMs,
        ...(evidencePath ? { evidencePath } : {}),
      };
    },
  };
}

/** Split a CI command line into argv without a shell; null when it needs one (pipes, redirects, `$(...)`, `;`, `&&`). */
export function ciCommandArgv(v: string[] | string | undefined | null): string[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length && v.every((x) => typeof x === 'string') && v[0].trim() ? v.map(String) : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = tokenizeScript(v.trim());
  if (!t || !t.tokens.length || Object.keys(t.env).length) return null;
  return t.tokens;
}

/** `{checkout}`, `{sha}` and `{base}` in each argument. */
export function fillCiCommand(argv: string[], v: { checkout: string; sha: string; base: string }): string[] {
  return argv.map((a) => a.split('{checkout}').join(v.checkout).split('{sha}').join(v.sha).split('{base}').join(v.base));
}

/**
 * The local CI as a command the user named (DESIGN §2.8: "waits for CI"; the repository's own CI
 * steps, or a CI stand-in). Green when it exits 0; red otherwise; `timeout` when it ran too long.
 */
export function commandCi(argv: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): CiProvider {
  return {
    name: 'local',
    canRerun: true,
    async wait(c) {
      const filled = fillCiCommand(argv, { checkout: c.mainDir, sha: c.sha, base: c.base });
      const env = { ...(opts.env ?? process.env), CI: 'true', HARNESS_CI: 'local', HARNESS_CI_CHECKOUT: c.mainDir, HARNESS_CI_SHA: c.sha, HARNESS_CI_BASE: c.base };
      const r = await runAsync(filled[0], filled.slice(1), { cwd: c.mainDir, env, timeoutMs: opts.timeoutMs ?? 45 * 60_000 });
      const log = redactText(stripHiddenUnicode(`${r.stdout}\n${r.stderr}`)).split('\n');
      const tail = log.slice(-200).join('\n').trim();
      const status: CiResult['status'] = r.timedOut ? 'timeout' : r.code === 0 ? 'green' : r.code === -1 ? 'error' : 'red';
      const display = argv.join(' ').slice(0, 300);
      const dst = path.join(runsDir(), c.repoId, c.taskId, `ci-${c.n}-${c.kind}.json`);
      let evidencePath: string | undefined;
      try {
        ensureDir(path.dirname(dst));
        writeJson(dst, { version: 1, kind: 'command', command: display, sha: c.sha, base: c.base, status, exitCode: r.code, durationMs: r.durationMs, log: tail });
        evidencePath = dst;
      } catch {
        /* the record still carries the status */
      }
      const lastLine = log.map((l) => l.trim()).filter(Boolean).pop() ?? '';
      const detail = status === 'green' ? `CI command passed on ${c.sha.slice(0, 10)}` : status === 'timeout' ? `CI command ran longer than ${Math.round((opts.timeoutMs ?? 45 * 60_000) / 60_000)} minutes on ${c.sha.slice(0, 10)}` : status === 'error' ? `the CI command could not run: ${tail.slice(-200)}` : `CI command exited ${r.code} on ${c.sha.slice(0, 10)}${lastLine ? `: ${lastLine.slice(0, 160)}` : ''}`;
      return { status, detail, durationMs: r.durationMs, ...(evidencePath ? { evidencePath } : {}), ...(status === 'green' ? {} : { failureText: tail.split('\n').slice(-60).join('\n') }) };
    },
  };
}

export function noCi(): CiProvider {
  return { name: 'none', canRerun: false, wait: async () => ({ status: 'none', detail: 'CI skipped (--ci none): nothing checked main after the landing', durationMs: 0 }) };
}

/** owner/repo of a github.com remote URL (https, ssh or scp form); null for anything else. */
export function githubRepoFromUrl(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const u = url.trim();
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export interface GithubCiOptions {
  owner: string;
  repo: string;
  token: string;
  http?: HttpGet;
  pollMs?: number;
  /** How long to wait for the first check run to appear (default 3 minutes). */
  appearMs?: number;
  /** Maximum total wait (default 45 minutes). */
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/** Classify a set of check runs: still running, green or red (with the failing names). */
export function classifyRuns(runs: CheckRun[]): { state: 'pending' | 'green' | 'red'; failing: string[]; pending: number } {
  const pending = runs.filter((r) => r.status !== 'completed').length;
  const failing = runs.filter((r) => r.status === 'completed' && RED.has(String(r.conclusion ?? ''))).map((r) => String(r.name ?? 'check'));
  if (pending) return { state: 'pending', failing, pending };
  return { state: failing.length ? 'red' : 'green', failing, pending: 0 };
}

export function githubCi(o: GithubCiOptions): CiProvider {
  const http = o.http ?? defaultHttpGet;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 15_000;
  const appearMs = o.appearMs ?? 180_000;
  const maxWaitMs = o.maxWaitMs ?? 45 * 60_000;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${o.token}`, 'User-Agent': 'harness-land', 'X-GitHub-Api-Version': '2022-11-28' };

  async function fetchRuns(sha: string): Promise<{ ok: true; runs: CheckRun[] } | { ok: false; status: number; message: string }> {
    let url: string | null = `https://api.github.com/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
    const runs: CheckRun[] = [];
    for (let page = 0; url && page < 10; page++) {
      let res;
      try {
        res = await http(url, headers, o.requestTimeoutMs ?? 30_000);
      } catch (e) {
        return { ok: false, status: 0, message: `request failed: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
      }
      if (res.status !== 200) return { ok: false, status: res.status, message: res.status === 401 ? 'the token was not accepted (401)' : res.status === 403 ? 'access denied or rate limited (403)' : res.status === 404 ? 'repository or commit not found, or the token cannot see it (404)' : `HTTP ${res.status}` };
      try {
        const j = JSON.parse(res.body) as { check_runs?: CheckRun[] };
        runs.push(...(Array.isArray(j.check_runs) ? j.check_runs : []));
      } catch {
        return { ok: false, status: res.status, message: 'the response was not JSON' };
      }
      url = nextLink(res.headers['link']);
    }
    return { ok: true, runs };
  }

  return {
    name: 'github',
    canRerun: false,
    async wait(c) {
      const t0 = now();
      let polls = 0;
      for (;;) {
        polls++;
        const r = await fetchRuns(c.sha);
        const elapsed = now() - t0;
        if (!r.ok) {
          // Transient failures are retried until the maximum wait; auth failures stop at once.
          if (r.status === 401 || r.status === 403 || r.status === 404) return { status: 'error', detail: `GitHub check runs for ${c.sha.slice(0, 10)}: ${r.message}`, durationMs: elapsed };
        } else {
          const k = classifyRuns(r.runs);
          if (!r.runs.length && elapsed >= appearMs) return { status: 'none', detail: `no check runs reported for ${c.sha.slice(0, 10)} within ${Math.round(appearMs / 1000)} s (is CI configured for pushes to main?)`, durationMs: elapsed };
          if (r.runs.length && k.state === 'green') return { status: 'green', detail: `${r.runs.length} GitHub check run(s) passed on ${c.sha.slice(0, 10)} (${polls} poll(s))`, durationMs: elapsed };
          if (k.state === 'red') return { status: 'red', detail: `GitHub checks failed on ${c.sha.slice(0, 10)}: ${k.failing.slice(0, 10).join(', ')}`, failureText: `Failing GitHub checks on ${c.sha}: ${k.failing.join(', ')}`, durationMs: elapsed };
        }
        if (elapsed >= maxWaitMs) return { status: 'timeout', detail: `CI did not finish within ${Math.round(maxWaitMs / 60000)} minute(s) for ${c.sha.slice(0, 10)}`, durationMs: elapsed };
        await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - elapsed)));
      }
    },
  };
}
