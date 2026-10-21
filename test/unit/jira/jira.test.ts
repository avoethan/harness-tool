/**
 * `harness intake --jira-next`, `harness jira comment` and `harness jira create` with the HTTP layer
 * mocked (never the network): the filter search (JQL and saved filter id, empty result), the comment
 * body (table, verdict, pull request link), a comment without a key, the create draft that sends nothing
 * without --yes, the request bodies and the link call, redaction of errors, and host pinning.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as intakeMain } from '../../../src/commands/intake';
import { main as jiraMain } from '../../../src/commands/jira';
import { setConfigValue } from '../../../src/commands/config';
import { setHttpGet, setHttpPost, type HttpGet, type HttpPost } from '../../../src/commands/reviews';
import { buildBrief, loadBrief, saveBrief } from '../../../src/intake/brief';
import { fetchNextJiraKey, jqlFor } from '../../../src/intake/jira';
import { jiraComment, jiraCreate } from '../../../src/jira/run';
import { commentBody, firstSentence, readWriteup } from '../../../src/jira/compose';
import { defaultConfig, repoIdFor, saveConfig } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import type { JiraConfig } from '../../../src/types';
import { capture } from '../commands/capture';
import { cleanupEnv, landingFixture, writeEvidence, type Fixture } from '../land/helpers';

setHttpGet(async () => {
  throw new Error('network disabled in tests');
});
setHttpPost(async () => {
  throw new Error('network disabled in tests');
});

const TOKEN = 'jira-test-token-value-1234';
const ENV = { HARNESS_JIRA_TOKEN: TOKEN } as NodeJS.ProcessEnv;
const CFG: JiraConfig = { baseUrl: 'https://jira.example.test', project: 'SHOP' };

interface Seen {
  url: string;
  auth: string;
  body: string | null;
}

function postMock(seen: Seen[], answer: (url: string, n: number) => { status: number; body?: unknown; headers?: Record<string, string> }): HttpPost {
  return async (url, headers, body) => {
    seen.push({ url, auth: headers.Authorization ?? '', body });
    const a = answer(url, seen.length);
    return { status: a.status, headers: a.headers ?? {}, body: JSON.stringify(a.body ?? {}) };
  };
}

const WRITEUP = [
  '# Make a 42',
  '',
  '## Verification',
  'Gate: PASS at tree abc123def456, attempt 1, 2026-10-21T10:00:00Z.',
  'Steps: tamper pass',
  '',
  '| Criterion | Check | Result | Artifact |',
  '|---|---|---|---|',
  '| AC1 a is 42 | unit test a \\| b | PASS | evidence/a.txt |',
  '| AC2 the page {shows} [it] | manual | not linked | |',
  '',
  '## Assumptions',
  '- None.',
  '',
  '## Feedback wanted',
  '- Open question Q1 (meaning, AC2): what does shows mean? I went with "a table".',
  '- Review the sensitive files closely: src/auth.js.',
  '',
].join('\n');

function fixture(opts: { writeup?: string | null; jiraKey?: string } = {}): Fixture {
  const fx = landingFixture('T-001', { prefix: 'harness-jira-write-' });
  const dir = path.join(runsDir(), repoIdFor(fx.root), fx.taskId);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.writeup !== null) fs.writeFileSync(path.join(dir, 'writeup.md'), opts.writeup ?? WRITEUP);
  const b = buildBrief('h1. Make a 42\n\nh2. Description\nA is 42.\n\nh2. Acceptance Criteria\n# a is 42\n', { config: { repos: [] }, id: fx.taskId, ...(opts.jiraKey ? { jiraKey: opts.jiraKey } : {}) });
  saveBrief(b);
  return fx;
}

function done(fx: Fixture): void {
  fx.home.cleanup();
  cleanupEnv();
}

/** The gate writes evidence in the task worktree's run folder; the run state (absent here) names it, so copy it to the repository's. */
function evidenceInRepoFolder(fx: Fixture, over: Parameters<typeof writeEvidence>[1]): void {
  const from = writeEvidence(fx, over);
  fs.copyFileSync(from, runFile(fx, 'evidence.json'));
}

function runFile(fx: Fixture, name: string): string {
  return path.join(runsDir(), repoIdFor(fx.root), fx.taskId, name);
}

// ---------------------------------------------------------------------------
// the queue: intake --jira-next
// ---------------------------------------------------------------------------

function getMock(seen: string[], res: { status: number; body?: unknown; headers?: Record<string, string> }): HttpGet {
  return async (url) => {
    seen.push(url);
    return { status: res.status, headers: res.headers ?? {}, body: JSON.stringify(res.body ?? {}) };
  };
}

test('jira.filter as JQL: GET /rest/api/2/search?jql=...&maxResults=1&fields=key, the first key is returned', async () => {
  const seen: string[] = [];
  const restore = setHttpGet(getMock(seen, { status: 200, body: { issues: [{ key: 'SHOP-7' }, { key: 'SHOP-8' }] } }));
  try {
    const jql = 'project = SHOP AND status = "Ready" ORDER BY priority DESC';
    const r = await fetchNextJiraKey({ baseUrl: 'https://jira.example.test', filter: jql }, ENV);
    assert.deepEqual(r, { ok: true, key: 'SHOP-7' });
    assert.equal(seen[0], `https://jira.example.test/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`);
  } finally {
    setHttpGet(restore);
  }
});

test('jira.filter as a saved filter id is rewritten to jql=filter=<id>', async () => {
  assert.equal(jqlFor('12345'), 'filter=12345');
  assert.equal(jqlFor('project = A'), 'project = A');
  const seen: string[] = [];
  const restore = setHttpGet(getMock(seen, { status: 200, body: { issues: [{ key: 'SHOP-1' }] } }));
  try {
    const r = await fetchNextJiraKey({ baseUrl: 'https://jira.example.test/jira', filter: '12345' }, ENV);
    assert.equal(r.ok, true);
    assert.equal(seen[0], 'https://jira.example.test/jira/rest/api/2/search?jql=filter%3D12345&maxResults=1&fields=key');
  } finally {
    setHttpGet(restore);
  }
});

test('an empty filter result exits 1 with "no ticket in the filter"; no filter set exits 2', async () => {
  const restore = setHttpGet(getMock([], { status: 200, body: { issues: [] } }));
  try {
    const r = await fetchNextJiraKey({ baseUrl: 'https://jira.example.test', filter: 'project = SHOP' }, ENV);
    assert.deepEqual(r, { ok: false, exit: 1, message: 'no ticket in the filter' });
    const none = await fetchNextJiraKey({ baseUrl: 'https://jira.example.test' }, ENV);
    assert.equal(none.ok, false);
    assert.equal(!none.ok && none.exit, 2);
    assert.match(!none.ok ? none.message : '', /harness config set jira\.filter/);
  } finally {
    setHttpGet(restore);
  }
});

test('the filter search refuses a redirect and does not echo the response body', async () => {
  const restore = setHttpGet(getMock([], { status: 302, headers: { location: 'https://evil.example.test/x' }, body: { issues: [{ key: 'SHOP-1' }] } }));
  try {
    const r = await fetchNextJiraKey({ baseUrl: 'https://jira.example.test', filter: 'project = SHOP' }, ENV);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.message : '', /redirect to another host; refused/);
    const bad = setHttpGet(getMock([], { status: 400, body: { errorMessages: ['SECRET-BODY-TEXT'] } }));
    const b = await fetchNextJiraKey({ baseUrl: 'https://jira.example.test', filter: 'bad jql' }, ENV);
    setHttpGet(bad);
    assert.equal(b.ok, false);
    assert.match(!b.ok ? b.message : '', /did not accept the JQL/);
    assert.doesNotMatch(!b.ok ? b.message : '', /SECRET-BODY-TEXT/);
  } finally {
    setHttpGet(restore);
  }
});

test('intake --jira-next reads the first ticket of the filter, saves the key in the brief, and cannot be combined with --jira or --from', async () => {
  const fx = fixture();
  try {
    saveConfig(defaultConfig({ setting: 'team', workspaceRoot: fx.home.workspace, jira: { baseUrl: 'https://jira.example.test', filter: 'project = SHOP' } }));
    process.env.HARNESS_JIRA_TOKEN = TOKEN;
    const seen: string[] = [];
    const restore = setHttpGet(async (url) => {
      seen.push(url);
      if (url.includes('/search?')) return { status: 200, headers: {}, body: JSON.stringify({ issues: [{ key: 'SHOP-55' }] }) };
      return { status: 200, headers: {}, body: JSON.stringify({ fields: { summary: 'Low stock', description: 'Show low stock.\n\nh3. Acceptance Criteria\n# GET /products/low-stock returns 200' } }) };
    });
    try {
      const r = await capture(() => intakeMain(['--jira-next', '--json']));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.length, 2);
      assert.match(seen[1], /\/rest\/api\/2\/issue\/SHOP-55\?/);
      const brief = JSON.parse(r.stdout);
      assert.equal(brief.jiraKey, 'SHOP-55');
      assert.equal(loadBrief(brief.id)?.jiraKey, 'SHOP-55');
      assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
      const both = await capture(() => intakeMain(['--jira-next', '--jira', 'SHOP-1']));
      assert.equal(both.code, 2);
      const both2 = await capture(() => intakeMain(['--jira-next', '--from', 'x.txt']));
      assert.equal(both2.code, 2);
      assert.equal(seen.length, 2, 'the usage errors sent nothing');
    } finally {
      setHttpGet(restore);
      delete process.env.HARNESS_JIRA_TOKEN;
    }
  } finally {
    done(fx);
  }
});

test('config set validates jira.filter (not empty, one line), jira.project and jira.followupType', () => {
  const c = defaultConfig({ setting: 'team', workspaceRoot: '/w' });
  assert.match(setConfigValue(c, 'jira.filter', '') ?? '', /jira\.filter/);
  assert.match(setConfigValue(c, 'jira.filter', '   ') ?? '', /jira\.filter/);
  assert.match(setConfigValue(c, 'jira.filter', 'a\nb') ?? '', /jira\.filter/);
  assert.equal(setConfigValue(c, 'jira.filter', 'project = SHOP'), null);
  assert.equal(c.jira?.filter, 'project = SHOP');
  assert.equal(setConfigValue(c, 'jira.filter', 12345), null);
  assert.equal(c.jira?.filter, '12345');
  assert.match(setConfigValue(c, 'jira.project', 'shop') ?? '', /jira\.project/);
  assert.equal(setConfigValue(c, 'jira.project', 'SHOP'), null);
  assert.match(setConfigValue(c, 'jira.followupType', '') ?? '', /jira\.followupType/);
  assert.equal(setConfigValue(c, 'jira.followupType', 'Story'), null);
  assert.equal(c.jira?.followupType, 'Story');
});

// ---------------------------------------------------------------------------
// the comment
// ---------------------------------------------------------------------------

test('readWriteup and commentBody: the table without the Artifact column, the verdict line, the pull request link and the last line', () => {
  const facts = readWriteup(WRITEUP);
  assert.equal(facts.rows.length, 2);
  assert.equal(facts.gate, 'Gate: PASS at tree abc123def456, attempt 1, 2026-10-21T10:00:00Z.');
  assert.equal(facts.feedback.length, 2);
  const body = commentBody(facts, 'https://github.com/acme/app/pull/7');
  const lines = body.split('\n');
  assert.ok(lines.includes('||Criterion||Check||Result||'));
  assert.ok(lines.includes('|AC1 a is 42|unit test a / b|PASS|'), body);
  assert.ok(lines.includes('|AC2 the page \\{shows\\} \\[it\\]|manual|not linked|'), body);
  assert.ok(lines.includes('Gate: PASS at tree abc123def456, attempt 1, 2026-10-21T10:00:00Z.'));
  assert.ok(lines.includes('Pull request: https://github.com/acme/app/pull/7'));
  assert.equal(lines[lines.length - 1], 'Posted by the harness from the write-up; details in the pull request');
  assert.ok(!body.includes('evidence/a.txt'));
});

test('jira comment: POST /rest/api/2/issue/<KEY>/comment with the body; the key from the brief; the link from pr.json; the token never appears', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  fs.writeFileSync(runFile(fx, 'pr.json'), JSON.stringify({ url: 'https://github.com/acme/app/pull/9', number: 9 }));
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, () => ({ status: 201, body: { id: '10001' } })));
  try {
    const r = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(r.commentId, '10001');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://jira.example.test/rest/api/2/issue/SHOP-102/comment');
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    const sent = JSON.parse(seen[0].body ?? '');
    assert.deepEqual(Object.keys(sent), ['body']);
    assert.match(sent.body, /^h3\. Harness verification/);
    assert.match(sent.body, /\|\|Criterion\|\|Check\|\|Result\|\|/);
    assert.match(sent.body, /Pull request: https:\/\/github\.com\/acme\/app\/pull\/9/);
    assert.ok(!r.message.includes(TOKEN));
  } finally {
    setHttpPost(restore);
    done(fx);
  }
});

test('jira comment: --key overrides, --pr overrides pr.json, --dry-run prints the body and sends nothing (no token needed)', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  fs.writeFileSync(runFile(fx, 'pr.json'), JSON.stringify({ url: 'https://github.com/acme/app/pull/9', number: 9 }));
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, () => ({ status: 201, body: {} })));
  try {
    const r = await jiraComment({ repo: fx.root, task: fx.taskId, env: {}, cfg: CFG, dryRun: true, key: 'SHOP-9', pr: 'https://github.com/acme/app/pull/12' });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(r.sent, false);
    assert.equal(seen.length, 0);
    assert.match(r.message, /would add this comment to SHOP-9; nothing was sent/);
    assert.match(r.message, /pull\/12/);
    assert.doesNotMatch(r.message, /pull\/9\b/);
    assert.equal(r.requests?.[0].url, 'https://jira.example.test/rest/api/2/issue/SHOP-9/comment');
    const bad = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, key: 'not a key' });
    assert.equal(bad.exitCode, 2);
    const badPr = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, pr: 'javascript:alert(1)' });
    assert.equal(badPr.exitCode, 2);
    assert.equal(seen.length, 0);
  } finally {
    setHttpPost(restore);
    done(fx);
  }
});

test('jira comment: no write-up exits 1; no ticket key exits 2 and says to pass --key; no token exits 2', async () => {
  const noWriteup = fixture({ writeup: null, jiraKey: 'SHOP-1' });
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, () => ({ status: 201 })));
  try {
    const r1 = await jiraComment({ repo: noWriteup.root, task: noWriteup.taskId, env: ENV, cfg: CFG });
    assert.equal(r1.exitCode, 1);
    assert.match(r1.message, /no write-up/);
  } finally {
    done(noWriteup);
  }
  const noKey = fixture();
  try {
    const r2 = await jiraComment({ repo: noKey.root, task: noKey.taskId, env: ENV, cfg: CFG });
    assert.equal(r2.exitCode, 2);
    assert.match(r2.message, /--key <KEY>/);
    const viaMain = await capture(() => jiraMain(['comment', '--repo', noKey.root, '--task', noKey.taskId]));
    assert.equal(viaMain.code, 2);
    assert.match(viaMain.stderr, /Usage: harness jira comment/);
    const withKey = await jiraComment({ repo: noKey.root, task: noKey.taskId, env: {}, cfg: CFG, key: 'SHOP-3' });
    assert.equal(withKey.exitCode, 2);
    assert.match(withKey.message, /HARNESS_JIRA_TOKEN/);
    assert.equal(seen.length, 0);
  } finally {
    setHttpPost(restore);
    done(noKey);
  }
});

test('jira comment: errors are redacted and carry no token; a redirect to another host is refused; a Jira error body is summarised', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  try {
    let restore = setHttpPost(postMock([], () => ({ status: 400, body: { errorMessages: [`bad field near ${secret} and Bearer abcdefghijklmnopqrstuvwxyz0123`] } })));
    const r = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG });
    setHttpPost(restore);
    assert.equal(r.exitCode, 1);
    assert.match(r.message, /Jira rejected the request \(400\)/);
    assert.ok(!r.message.includes(secret) && !r.message.includes('abcdefghijklmnopqrstuvwxyz0123') && !r.message.includes(TOKEN), r.message);

    restore = setHttpPost(async () => {
      throw new Error(`connect failed with Bearer ${TOKEN}${TOKEN}`);
    });
    const net = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG });
    setHttpPost(restore);
    assert.equal(net.exitCode, 1);
    assert.doesNotMatch(net.message, new RegExp(TOKEN));

    restore = setHttpPost(postMock([], () => ({ status: 307, headers: { location: 'https://evil.example.test/steal' } })));
    const red = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG });
    setHttpPost(restore);
    assert.equal(red.exitCode, 1);
    assert.match(red.message, /redirect to another host; refused/);
  } finally {
    done(fx);
  }
});

test('jira: only the configured Jira host is called (a path prefix is kept), and the unit refuses a non-https base', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, () => ({ status: 201, body: { id: '1' } })));
  try {
    const ok = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: { baseUrl: 'https://corp.example.test/jira/' } });
    assert.equal(ok.exitCode, 0, ok.message);
    assert.equal(seen[0].url, 'https://corp.example.test/jira/rest/api/2/issue/SHOP-102/comment');
    assert.equal(new URL(seen[0].url).host, 'corp.example.test');
    const http = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: { baseUrl: 'http://corp.example.test' } });
    assert.equal(http.exitCode, 2);
    assert.equal(seen.length, 1);
    // a key cannot steer the request to another path or host
    const evil = await jiraComment({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, key: 'SHOP-1/../../x' });
    assert.equal(evil.exitCode, 2);
    assert.equal(seen.length, 1);
  } finally {
    setHttpPost(restore);
    done(fx);
  }
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('firstSentence: the first sentence, cut at 120 characters', () => {
  assert.equal(firstSentence('Add the missing index. Then measure it.'), 'Add the missing index.');
  assert.equal(firstSentence('- A bullet item without an end'), 'A bullet item without an end');
  const long = firstSentence('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('jira create --from "<text>" without --yes prints the draft and sends nothing (exit 0); --dry-run with --yes also sends nothing', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  fs.writeFileSync(runFile(fx, 'pr.json'), JSON.stringify({ url: 'https://github.com/acme/app/pull/9', number: 9 }));
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, () => ({ status: 201, body: { key: 'SHOP-200' } })));
  try {
    const r = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'Cache the stock list. It is slow.' });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(r.sent, false);
    assert.equal(seen.length, 0);
    assert.match(r.message, /Summary: SHOP-102 follow-up: Cache the stock list\./);
    assert.match(r.message, /Opened from SHOP-102 by the harness; see https:\/\/github\.com\/acme\/app\/pull\/9/);
    assert.match(r.message, /Nothing was sent\. Add --yes/);
    saveConfig(defaultConfig({ setting: 'team', workspaceRoot: fx.home.workspace, jira: CFG }));
    const viaMain = await capture(() => jiraMain(['create', '--repo', fx.root, '--task', fx.taskId, '--from', 'Cache the stock list.', '--dry-run', '--yes']));
    assert.equal(viaMain.code, 0, viaMain.stderr);
    assert.match(viaMain.stdout, /Dry run: nothing was sent/);
    assert.equal(seen.length, 0);
  } finally {
    setHttpPost(restore);
    done(fx);
  }
});

test('jira create --yes: POST /rest/api/2/issue with project, summary, description and type, then POST /rest/api/2/issueLink "Relates"', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, (url) => (url.endsWith('/issue') ? { status: 201, body: { key: 'SHOP-200', id: '1' } } : { status: 201 })));
  try {
    const r = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: { ...CFG, followupType: 'Story' }, from: 'Cache the stock list. It is slow.', yes: true });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, 'https://jira.example.test/rest/api/2/issue');
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(seen[0].body ?? ''), {
      fields: {
        project: { key: 'SHOP' },
        summary: 'SHOP-102 follow-up: Cache the stock list.',
        description: 'Cache the stock list. It is slow.\n\nOpened from SHOP-102 by the harness',
        issuetype: { name: 'Story' },
      },
    });
    assert.equal(seen[1].url, 'https://jira.example.test/rest/api/2/issueLink');
    assert.deepEqual(JSON.parse(seen[1].body ?? ''), { type: { name: 'Relates' }, inwardIssue: { key: 'SHOP-200' }, outwardIssue: { key: 'SHOP-102' } });
    assert.deepEqual(r.created, [{ key: 'SHOP-200', url: 'https://jira.example.test/browse/SHOP-200', linked: true }]);
    assert.match(r.message, /Created SHOP-200/);
    // the defaults: type Task, --project and --type override the config
    seen.length = 0;
    const r2 = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: { baseUrl: 'https://jira.example.test' }, from: 'Another one.', project: 'OPS', type: 'Bug', yes: true });
    assert.equal(r2.exitCode, 0, r2.message);
    assert.equal(JSON.parse(seen[0].body ?? '').fields.project.key, 'OPS');
    assert.equal(JSON.parse(seen[0].body ?? '').fields.issuetype.name, 'Bug');
    const dflt = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'Third.' });
    assert.equal(dflt.requests && (dflt.requests[0].body as { fields: { issuetype: { name: string } } }).fields.issuetype.name, 'Task');
  } finally {
    setHttpPost(restore);
    done(fx);
  }
});

test('jira create: a failed link is reported, not fatal; no source key means no link call; no project exits 2; a Jira error is redacted', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  try {
    let seen: Seen[] = [];
    let restore = setHttpPost(postMock(seen, (url) => (url.endsWith('/issue') ? { status: 201, body: { key: 'SHOP-201' } } : { status: 404, body: { errorMessages: ['no link type'] } })));
    const r = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'One.', yes: true });
    setHttpPost(restore);
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(r.created?.[0].linked, false);
    assert.match(r.message, /SHOP-201 was created but not linked to SHOP-102/);

    // a ticket not read from Jira: no link
    const plain = landingFixture('T-002', { prefix: 'harness-jira-plain-' });
    try {
      fs.mkdirSync(path.join(runsDir(), repoIdFor(plain.root), 'T-002'), { recursive: true });
      seen = [];
      restore = setHttpPost(postMock(seen, () => ({ status: 201, body: { key: 'SHOP-202' } })));
      const p = await jiraCreate({ repo: plain.root, task: 'T-002', env: ENV, cfg: CFG, from: 'Standalone work.', yes: true });
      setHttpPost(restore);
      assert.equal(p.exitCode, 0, p.message);
      assert.equal(seen.length, 1);
      assert.equal(JSON.parse(seen[0].body ?? '').fields.summary, 'Follow-up: Standalone work.');
    } finally {
      plain.home.cleanup();
    }

    const noProject = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: { baseUrl: 'https://jira.example.test' }, from: 'x.' });
    assert.equal(noProject.exitCode, 2);
    assert.match(noProject.message, /jira\.project/);

    restore = setHttpPost(postMock([], () => ({ status: 400, body: { errors: { project: `unknown ${'AKIA' + 'ABCDEFGHIJKLMNOP'}` } } })));
    const bad = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'x.', yes: true });
    setHttpPost(restore);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.message, /Jira rejected the request \(400\)/);
    assert.doesNotMatch(bad.message, /AKIA/);
  } finally {
    done(fx);
  }
});

test('jira create --from blocked takes the gate BLOCKED reason from evidence.json; a gate that is not BLOCKED is refused', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  try {
    evidenceInRepoFolder(fx, { verdict: 'FAIL', reasons: ['step unit failed'] });
    const no = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'blocked' });
    assert.equal(no.exitCode, 1);
    assert.match(no.message, /not BLOCKED/);
    evidenceInRepoFolder(fx, { verdict: 'BLOCKED', reasons: ['BLOCKED: the staging database is down and the check cannot run. Ask ops.'] });
    const r = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'blocked' });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(r.drafts?.length, 1);
    assert.equal(r.drafts?.[0].summary, 'SHOP-102 follow-up: Blocked: the staging database is down and the check cannot run.');
    assert.match(r.drafts?.[0].description ?? '', /^Blocked: the staging database is down and the check cannot run\. Ask ops\./);
    const none = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG });
    assert.equal(none.exitCode, 2);
  } finally {
    done(fx);
  }
});

test('jira create --from feedback: one draft per Feedback wanted item, or one ticket listing them with --one', async () => {
  const fx = fixture({ jiraKey: 'SHOP-102' });
  const seen: Seen[] = [];
  const restore = setHttpPost(postMock(seen, (url, n) => (url.endsWith('/issue') ? { status: 201, body: { key: `SHOP-30${n}` } } : { status: 201 })));
  try {
    const many = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'feedback' });
    assert.equal(many.exitCode, 0, many.message);
    assert.equal(many.drafts?.length, 2);
    assert.equal(many.drafts?.[1].summary, 'SHOP-102 follow-up: Review the sensitive files closely: src/auth.js.');
    assert.equal(seen.length, 0);
    const one = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'feedback', one: true });
    assert.equal(one.drafts?.length, 1);
    assert.match(one.drafts?.[0].description ?? '', /\* Open question Q1[\s\S]*\* Review the sensitive files/);
    const sent = await jiraCreate({ repo: fx.root, task: fx.taskId, env: ENV, cfg: CFG, from: 'feedback', yes: true });
    assert.equal(sent.exitCode, 0, sent.message);
    assert.equal(sent.created?.length, 2);
    assert.equal(seen.filter((s) => s.url.endsWith('/issue')).length, 2);
    assert.equal(seen.filter((s) => s.url.endsWith('/issueLink')).length, 2);
  } finally {
    setHttpPost(restore);
    done(fx);
  }
});

test('harness jira: a missing or unknown subcommand is a usage error', async () => {
  const a = await capture(() => jiraMain([]));
  assert.equal(a.code, 2);
  const b = await capture(() => jiraMain(['delete']));
  assert.equal(b.code, 2);
  assert.match(b.stderr, /unknown subcommand delete/);
});
