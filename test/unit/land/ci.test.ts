import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyRuns, githubCi, githubRepoFromUrl, noCi, type CiCheck } from '../../../src/land/ci';
import type { HttpGet, HttpResponse } from '../../../src/commands/reviews';

const check: CiCheck = { sha: 'abc123def4567890', mainDir: '/m', repoId: 'r', taskId: 'T-1', base: 'b', kind: 'initial', n: 1 };

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function http(pages: Array<HttpResponse | ((url: string) => HttpResponse)>): HttpGet & { urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let i = 0;
  const fn = (async (url: string, h: Record<string, string>) => {
    urls.push(url);
    headers.push(h);
    const p = pages[Math.min(i++, pages.length - 1)];
    return typeof p === 'function' ? p(url) : p;
  }) as unknown as HttpGet & { urls: string[]; headers: Array<Record<string, string>> };
  fn.urls = urls;
  fn.headers = headers;
  return fn;
}

const ok = (runs: unknown[], link?: string): HttpResponse => ({ status: 200, headers: link ? { link } : {}, body: JSON.stringify({ total_count: runs.length, check_runs: runs }) });

test('github CI: polls until every check run completed; green; read-only GET on api.github.com with the token in the header only', async () => {
  const c = clock();
  const h = http([ok([]), ok([{ name: 'build', status: 'in_progress', conclusion: null }]), ok([{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }])]);
  const ci = githubCi({ owner: 'o', repo: 'r', token: 'tok-secret', http: h, pollMs: 10_000, ...c });
  const r = await ci.wait(check);
  assert.equal(r.status, 'green');
  assert.match(r.detail, /2 GitHub check run\(s\) passed on abc123def4 \(3 poll\(s\)\)/);
  assert.equal(h.urls.length, 3);
  for (const u of h.urls) assert.equal(u, 'https://api.github.com/repos/o/r/commits/abc123def4567890/check-runs?per_page=100');
  assert.equal(h.headers[0].Authorization, 'Bearer tok-secret');
  assert.ok(!r.detail.includes('tok-secret'));
  assert.equal(ci.canRerun, false, 'the harness never triggers a rerun on GitHub');
});

test('github CI: red names the failing checks; pagination follows api.github.com links only', async () => {
  const c = clock();
  const h = http([
    ok([{ name: 'build', status: 'completed', conclusion: 'success' }], '<https://api.github.com/repos/o/r/commits/x/check-runs?page=2>; rel="next"'),
    ok([{ name: 'tests', status: 'completed', conclusion: 'failure' }], '<https://evil.example/next>; rel="next"'),
  ]);
  const r = await githubCi({ owner: 'o', repo: 'r', token: 't', http: h, ...c }).wait(check);
  assert.equal(r.status, 'red');
  assert.match(r.detail, /GitHub checks failed on abc123def4: tests/);
  assert.equal(h.urls.length, 2, 'the off-host link was not followed');
});

test('github CI: no check runs within the grace period is none; still running at the max wait is timeout; auth failures stop at once', async () => {
  let c = clock();
  let r = await githubCi({ owner: 'o', repo: 'r', token: 't', http: http([ok([])]), pollMs: 30_000, appearMs: 90_000, ...c }).wait(check);
  assert.equal(r.status, 'none');
  assert.match(r.detail, /no check runs reported .* within 90 s/);
  c = clock();
  r = await githubCi({ owner: 'o', repo: 'r', token: 't', http: http([ok([{ name: 'slow', status: 'queued' }])]), pollMs: 60_000, maxWaitMs: 300_000, ...c }).wait(check);
  assert.equal(r.status, 'timeout');
  assert.match(r.detail, /did not finish within 5 minute/);
  c = clock();
  const h = http([{ status: 401, headers: {}, body: '{}' }]);
  r = await githubCi({ owner: 'o', repo: 'r', token: 't', http: h, ...c }).wait(check);
  assert.equal(r.status, 'error');
  assert.match(r.detail, /401/);
  assert.equal(h.urls.length, 1);
  // A transient error is retried.
  c = clock();
  r = await githubCi({ owner: 'o', repo: 'r', token: 't', http: http([{ status: 502, headers: {}, body: '' }, ok([{ name: 'b', status: 'completed', conclusion: 'success' }])]), ...c }).wait(check);
  assert.equal(r.status, 'green');
});

test('github CI: remote URLs and run classification', async () => {
  assert.deepEqual(githubRepoFromUrl('https://github.com/acme/widget.git'), { owner: 'acme', repo: 'widget' });
  assert.deepEqual(githubRepoFromUrl('git@github.com:acme/widget.git'), { owner: 'acme', repo: 'widget' });
  assert.deepEqual(githubRepoFromUrl('ssh://git@github.com/acme/widget'), { owner: 'acme', repo: 'widget' });
  assert.equal(githubRepoFromUrl('https://gitlab.com/acme/widget.git'), null);
  assert.equal(githubRepoFromUrl('/srv/git/widget.git'), null);
  assert.deepEqual(classifyRuns([{ status: 'completed', conclusion: 'neutral' }]), { state: 'green', failing: [], pending: 0 });
  assert.equal(classifyRuns([{ name: 'x', status: 'completed', conclusion: 'cancelled' }]).state, 'red');
  assert.equal(classifyRuns([{ status: 'in_progress' }, { name: 'x', status: 'completed', conclusion: 'failure' }]).state, 'pending');
  const n = await noCi().wait(check);
  assert.equal(n.status, 'none');
});
