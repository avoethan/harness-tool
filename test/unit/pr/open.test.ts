/**
 * `harness pr open` with the HTTP layer mocked (never the network): the request body, the existing
 * pull request, --dry-run, the team-setting refusal, the unpushed branch, the missing write-up, the
 * pr.json record, and that the token is never echoed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openPr, setHttpSend, type HttpSend } from '../../../src/pr/open';
import { main as prMain } from '../../../src/commands/pr';
import { defaultConfig, repoIdFor, saveConfig } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import { capture } from '../commands/capture';
import { cleanupEnv, git, landingFixture, put, type Fixture } from '../land/helpers';

setHttpSend(async () => {
  throw new Error('network disabled in tests');
});

const TOKEN = 'test-token-value-not-real';
const ENV = { GITHUB_TOKEN: TOKEN } as NodeJS.ProcessEnv;

interface Seen {
  method: string;
  url: string;
  auth: string;
  body: string | null;
}

function mock(seen: Seen[], existing: unknown[] = [], post: { status: number; body: unknown } = { status: 201, body: { html_url: 'https://github.com/acme/app/pull/7', number: 7 } }): HttpSend {
  return async (method, url, headers, body) => {
    seen.push({ method, url, auth: headers.Authorization, body });
    if (method === 'GET') return { status: 200, headers: {}, body: JSON.stringify(existing) };
    return { status: post.status, headers: {}, body: JSON.stringify(post.body) };
  };
}

/** The landing fixture with a bare repository standing in for github.com/acme/app, the branch pushed, and a write-up. */
function prFixture(opts: { push?: boolean; writeup?: boolean } = {}): Fixture {
  const fx = landingFixture('T-001', { prefix: 'harness-pr-' });
  const bare = path.join(fx.home.root, 'origin.git');
  git(fx.root, ['init', '-q', '--bare', bare]);
  git(fx.root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  git(fx.root, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
  git(fx.root, ['push', '-q', 'origin', 'main']);
  if (opts.push !== false) git(fx.root, ['push', '-q', 'origin', `task/${fx.taskId}`]);
  if (opts.writeup !== false) {
    const dir = path.join(runsDir(), repoIdFor(fx.root), fx.taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'writeup.md'), '## Summary\n\nMakes a 42.\n');
  }
  return fx;
}

function done(fx: Fixture): void {
  fx.home.cleanup();
  cleanupEnv();
}

function prFile(fx: Fixture): string {
  return path.join(runsDir(), repoIdFor(fx.root), fx.taskId, 'pr.json');
}

test('pr open: looks for an open pull request on the head, then creates one with the write-up as the body', async () => {
  const fx = prFixture();
  const seen: Seen[] = [];
  const restore = setHttpSend(mock(seen));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r.exitCode, 0, r.message);
    assert.match(r.message, /pull\/7/);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, 'https://api.github.com/repos/acme/app/pulls?state=open&per_page=5&head=acme%3Atask%2FT-001');
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].url, 'https://api.github.com/repos/acme/app/pulls');
    assert.equal(seen[1].auth, `Bearer ${TOKEN}`);
    const body = JSON.parse(seen[1].body ?? '');
    assert.deepEqual(Object.keys(body).sort(), ['base', 'body', 'draft', 'head', 'title']);
    assert.equal(body.head, 'task/T-001');
    assert.equal(body.base, 'main');
    assert.equal(body.draft, false);
    assert.equal(body.body, '## Summary\n\nMakes a 42.\n');
    assert.equal(body.title, 'Make a 42');
    const rec = JSON.parse(fs.readFileSync(prFile(fx), 'utf8'));
    assert.equal(rec.url, 'https://github.com/acme/app/pull/7');
    assert.equal(rec.number, 7);
    assert.equal(rec.head, 'task/T-001');
    assert.equal(rec.base, 'main');
    assert.ok(!Number.isNaN(Date.parse(rec.at)));
    assert.ok(!JSON.stringify(rec).includes(TOKEN));
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open: --base and --draft go into the request', async () => {
  const fx = prFixture();
  const seen: Seen[] = [];
  const restore = setHttpSend(mock(seen));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV, base: 'develop', draft: true });
    assert.equal(r.exitCode, 0, r.message);
    const body = JSON.parse(seen[1].body ?? '');
    assert.equal(body.base, 'develop');
    assert.equal(body.draft, true);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open: an existing open pull request is reported, not duplicated', async () => {
  const fx = prFixture();
  const seen: Seen[] = [];
  const restore = setHttpSend(mock(seen, [{ html_url: 'https://github.com/acme/app/pull/3', number: 3, base: { ref: 'main' } }]));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r.exitCode, 0);
    assert.match(r.message, /already open: https:\/\/github\.com\/acme\/app\/pull\/3/);
    assert.deepEqual(seen.map((s) => s.method), ['GET'], 'no POST');
    assert.equal(JSON.parse(fs.readFileSync(prFile(fx), 'utf8')).number, 3);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open: --dry-run prints the request, sends nothing, needs no token and writes no pr.json', async () => {
  const fx = prFixture();
  const seen: Seen[] = [];
  const restore = setHttpSend(mock(seen));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: {}, dryRun: true });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(seen.length, 0);
    assert.equal(r.request?.url, 'https://api.github.com/repos/acme/app/pulls');
    assert.equal(r.request?.body.head, 'task/T-001');
    assert.equal(fs.existsSync(prFile(fx)), false);
    const out = await capture(() => prMain(['open', '--repo', fx.root, '--task', fx.taskId, '--dry-run', '--json']));
    assert.equal(out.code, 0);
    const j = JSON.parse(out.stdout);
    assert.equal(j.dryRun, true);
    assert.equal(j.request.body.title, 'Make a 42');
    assert.equal(seen.length, 0);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open refuses in the team setting (exit 4) and sends nothing', async () => {
  const fx = prFixture();
  const seen: Seen[] = [];
  const restore = setHttpSend(mock(seen));
  try {
    saveConfig(defaultConfig({ setting: 'team', workspaceRoot: fx.home.workspace }));
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r.exitCode, 4);
    assert.match(r.message, /team setting never posts to GitHub; paste the write-up/);
    const out = await capture(() => prMain(['open', '--repo', fx.root, '--task', fx.taskId, '--dry-run']));
    assert.equal(out.code, 4, 'even --dry-run');
    assert.equal(seen.length, 0);
    // the repository's own personal overlay wins over a team machine config
    put(fx.root, '.harness/config.json', JSON.stringify({ setting: 'personal' }));
    const ok = await openPr({ repo: fx.root, task: fx.taskId, env: ENV, dryRun: true });
    assert.equal(ok.exitCode, 0, ok.message);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open refuses a branch that is not on the remote, or not at the same tip, and says how to push', async () => {
  const fx = prFixture({ push: false });
  const seen: Seen[] = [];
  const restore = setHttpSend(mock(seen));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /push the branch yourself first: git push -u origin task\/T-001/);
    git(fx.root, ['push', '-q', 'origin', 'task/T-001']);
    put(fx.wt, 'src/a.js', 'exports.a = 43;\n');
    git(fx.wt, ['commit', '-q', '-am', 'more']);
    const r2 = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r2.exitCode, 1);
    assert.match(r2.message, /is not at your local tip.*push the branch yourself first/);
    const dry = await openPr({ repo: fx.root, task: fx.taskId, env: ENV, dryRun: true });
    assert.equal(dry.exitCode, 1, 'a dry run checks the same refusals');
    assert.equal(seen.length, 0);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open refuses without a write-up and names harness gate', async () => {
  const fx = prFixture({ writeup: false });
  const restore = setHttpSend(mock([]));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /no write-up for T-001; run `harness gate` first/);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr open: a GitHub refusal is reported with its reason, writes no pr.json and does not echo the token', async () => {
  const fx = prFixture();
  const restore = setHttpSend(mock([], [], { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'No commits between main and task/T-001' }] } }));
  try {
    const r = await openPr({ repo: fx.root, task: fx.taskId, env: ENV });
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /422.*No commits between/);
    assert.ok(!r.message.includes(TOKEN));
    assert.equal(fs.existsSync(prFile(fx)), false);
  } finally {
    setHttpSend(restore);
    done(fx);
  }
});

test('pr: usage', async () => {
  const none = await capture(() => prMain([]));
  assert.equal(none.code, 2);
  const bad = await capture(() => prMain(['merge']));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown subcommand merge/);
});
