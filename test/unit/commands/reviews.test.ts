/**
 * `harness reviews` with the HTTP layer mocked (never the network): pagination
 * through the Link header (api.github.com only), redaction of secret-shaped
 * tokens, hashed logins, clusters discovery can read, the fallback on
 * 401/403/404 or no token, the token never written anywhere, and the
 * pasted-comments import.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, gitRepo } from '../lifecycle/helpers';
import { capture } from './capture';
import { clusterKey, hashLogin, main as reviews, nextLink, resolveToken, setHttpGet, splitPasted, type HttpGet } from '../../../src/commands/reviews';
import { readReviews } from '../../../src/discover/history';
import { repoIdFor } from '../../../src/lib/config';

// Any HTTP call not mocked by a test fails here instead of reaching the network.
setHttpGet(async () => {
  throw new Error('network disabled in tests');
});

const TOKEN = 'test-token-value-not-real';
const LEAK = 'ghp_' + 'A'.repeat(36);

function comment(i: number, body: string, login: string, outdated = false) {
  return { body, user: { login }, pull_request_url: `https://api.github.com/repos/acme/app/pulls/${10 + (i % 3)}`, path: 'src/a.ts', created_at: '2026-10-01T00:00:00Z', position: outdated ? null : 5, original_position: 5 };
}

function mock(pages: Record<string, { status: number; body: unknown; link?: string }>, seen: Array<{ url: string; auth: string }>): HttpGet {
  return async (url, headers) => {
    seen.push({ url, auth: headers.Authorization ?? '' });
    const p = pages[url];
    if (!p) return { status: 404, headers: {}, body: '{"message":"Not Found"}' };
    const hdrs: Record<string, string> = p.link ? { link: p.link } : {};
    return { status: p.status, headers: hdrs, body: JSON.stringify(p.body) };
  };
}

test('nextLink follows only https api.github.com', () => {
  assert.equal(nextLink('<https://api.github.com/repos/a/b/pulls/comments?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'), 'https://api.github.com/repos/a/b/pulls/comments?page=2');
  assert.equal(nextLink('<https://evil.example/repos?page=2>; rel="next"'), null);
  assert.equal(nextLink('<http://api.github.com/x>; rel="next"'), null);
  assert.equal(nextLink(undefined), null);
});

test('resolveToken: environment first, then gh; nothing otherwise', () => {
  assert.deepEqual(resolveToken({ GITHUB_TOKEN: 'a' }, () => ({ code: 0, stdout: 'b' })), { token: 'a', source: 'env' });
  assert.deepEqual(resolveToken({ GH_TOKEN: 'c' }, () => ({ code: 0, stdout: 'b' })), { token: 'c', source: 'env' });
  assert.deepEqual(resolveToken({}, () => ({ code: 0, stdout: 'b\n' })), { token: 'b', source: 'gh' });
  assert.equal(resolveToken({}, () => ({ code: 1, stdout: '' })), null);
  assert.equal(resolveToken({}, () => {
    throw new Error('gh not installed');
  }), null);
});

test('fetch pages through the API, redacts bodies, hashes logins, clusters; discovery reads the file; the token is never written', async () => {
  const h = tempHome('harness-reviews-');
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = TOKEN;
  const seen: Array<{ url: string; auth: string }> = [];
  const first = 'https://api.github.com/repos/acme/app/pulls/comments?per_page=100&sort=created&direction=desc';
  const second = 'https://api.github.com/repos/acme/app/pulls/comments?per_page=100&sort=created&direction=desc&page=2';
  const restore = setHttpGet(
    mock(
      {
        [first]: { status: 200, link: `<${second}>; rel="next"`, body: [comment(1, 'Please use the logger instead of console.log here.', 'alice', true), comment(2, `Use the logger instead of console.log. Also you pasted ${LEAK} in the test.`, 'bob', true)] },
        [second]: { status: 200, body: [comment(3, 'Wrap this handler in asyncHandler.', 'alice')] },
      },
      seen,
    ),
  );
  try {
    const repo = gitRepo(path.join(h.root, 'app'));
    const r = await capture(() => reviews(['fetch', '--repo', 'acme/app', '--path', repo]));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.length, 2, 'two pages');
    assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`));
    assert.match(r.stdout, /Fetched 3 review comment\(s\) from 2 page\(s\)/);
    const id = repoIdFor(repo);
    const file = path.join(h.harnessHome, 'reviews', `${id}.json`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(TOKEN) && !r.stdout.includes(TOKEN), 'token never stored or printed');
    assert.ok(!text.includes(LEAK), 'secret-shaped text redacted');
    assert.ok(text.includes('[REDACTED]'));
    assert.ok(!text.includes('alice') && !text.includes('bob'), 'logins hashed');
    const j = JSON.parse(text);
    assert.equal(j.comments.length, 3);
    assert.equal(j.comments[0].author, hashLogin('alice'));
    assert.equal(j.comments.filter((c: { accepted: boolean }) => c.accepted).length, 2, 'outdated comments count as accepted (proxy)');
    const logger = j.clusters.find((c: { summary: string }) => /logger/.test(c.summary));
    assert.ok(logger, JSON.stringify(j.clusters));
    // discovery reads the same file
    const fromDiscover = readReviews(id);
    assert.ok(fromDiscover && fromDiscover.clusters.length >= 2);
    // a second fetch does not duplicate comments
    await capture(() => reviews(['fetch', '--repo', 'acme/app', '--path', repo]));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).comments.length, 3);
  } finally {
    setHttpGet(restore);
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
    h.cleanup();
  }
});

test('401, 403, 404 and a missing token print the pasted-comments fallback, exit 0 and store nothing', async () => {
  const h = tempHome('harness-reviews-');
  const prev = process.env.GITHUB_TOKEN;
  try {
    for (const status of [401, 403, 404]) {
      process.env.GITHUB_TOKEN = TOKEN;
      const restore = setHttpGet(async () => ({ status, headers: {}, body: '{}' }));
      const r = await capture(() => reviews(['fetch', '--repo', 'acme/app', '--path', h.workspace]));
      setHttpGet(restore);
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(`\\(${status}\\)`));
      assert.match(r.stdout, /harness reviews import --from comments\.txt/);
      assert.ok(!r.stdout.includes(TOKEN));
    }
    assert.ok(!fs.existsSync(path.join(h.harnessHome, 'reviews')));
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
    h.cleanup();
  }
});

test('import: pasted comments, one per paragraph, into the same file', async () => {
  const h = tempHome('harness-reviews-');
  try {
    const repo = gitRepo(path.join(h.root, 'svc'));
    const pasted = path.join(h.root, 'comments.txt');
    fs.writeFileSync(pasted, 'Use the logger, not console.log.\n\nUse the logger here too, not console.log.\n---\nName files in kebab-case.\n');
    assert.equal(splitPasted(fs.readFileSync(pasted, 'utf8')).length, 3);
    const r = await capture(() => reviews(['import', '--from', pasted, '--path', repo]));
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(fs.readFileSync(path.join(h.harnessHome, 'reviews', `${repoIdFor(repo)}.json`), 'utf8'));
    assert.equal(j.source, 'pasted');
    assert.equal(j.comments.length, 3);
    assert.equal(clusterKey('Use the logger, not console.log.'), clusterKey('Use the logger here too, not console.log.'));
  } finally {
    h.cleanup();
  }
});
