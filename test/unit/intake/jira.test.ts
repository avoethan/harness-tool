/**
 * `harness intake --jira <KEY>` with the HTTP layer mocked (never the network): basic vs bearer
 * auth, the composed ticket with and without the acceptance field, 404, missing token, a bad key,
 * a redirect to another host, the two modes excluding each other, and config validation.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as intakeMain } from '../../../src/commands/intake';
import { setConfigValue } from '../../../src/commands/config';
import { setHttpGet, type HttpGet } from '../../../src/commands/reviews';
import { composeTicket } from '../../../src/intake/jira';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import { inboxHome } from '../../../src/lib/paths';
import { capture } from '../commands/capture';
import { tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
const TOKEN = 'jira-test-token-value-1234';
const ENV_KEYS = ['HARNESS_JIRA_EMAIL', 'HARNESS_JIRA_TOKEN', 'MY_JIRA_TOKEN', 'MY_JIRA_EMAIL'];
const saved: Record<string, string | undefined> = {};

setHttpGet(async () => {
  throw new Error('network disabled in tests');
});

const ISSUE = (extra: Record<string, unknown> = {}) => ({
  fields: { summary: 'Low-stock endpoint', description: 'Staff need to see low stock.\n\nh3. Acceptance Criteria\n# GET /products/low-stock returns the products below their threshold', ...extra },
});

function mock(res: { status: number; body?: unknown; headers?: Record<string, string> }, seen: Array<{ url: string; auth: string; accept: string }>): HttpGet {
  return async (url, headers) => {
    seen.push({ url, auth: headers.Authorization ?? '', accept: headers.Accept ?? '' });
    return { status: res.status, headers: res.headers ?? {}, body: JSON.stringify(res.body ?? {}) };
  };
}

function setJira(jira: Record<string, string> | undefined) {
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, ...(jira ? { jira } : {}) }));
}

before(() => {
  h = tempHome('harness-jira-');
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  h.cleanup();
});

test('composeTicket: summary, description, and the acceptance field only when present', () => {
  assert.equal(composeTicket('T', 'D', null), 'h1. T\n\nh2. Description\nD\n');
  assert.equal(composeTicket('T', 'D', '# one'), 'h1. T\n\nh2. Description\nD\n\nh2. Acceptance Criteria\n# one\n');
  assert.equal(composeTicket('T', 'D', '  '), 'h1. T\n\nh2. Description\nD\n');
});

test('bearer auth without the email variable; ticket saved to the inbox and read into a brief; the token is not written anywhere', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  delete process.env.HARNESS_JIRA_EMAIL;
  const seen: Array<{ url: string; auth: string; accept: string }> = [];
  setHttpGet(mock({ status: 200, body: ISSUE() }, seen));
  const r = await capture(() => intakeMain(['--jira', 'SHOP-102']));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://jira.example.test/rest/api/2/issue/SHOP-102?fields=summary,description');
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  const saved = fs.readFileSync(path.join(inboxHome(), 'SHOP-102.txt'), 'utf8');
  assert.match(saved, /^h1\. Low-stock endpoint\n\nh2\. Description\nStaff need/);
  assert.doesNotMatch(saved, /^h2\. Acceptance Criteria/m);
  assert.match(r.stdout, /Brief t-[0-9a-f]{10}: Low-stock endpoint/);
  assert.match(r.stdout, /GET \/products\/low-stock/);
  // nothing under the harness home holds the token
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(h.harnessHome), ...walk(inboxHome())]) assert.ok(!fs.readFileSync(f, 'utf8').includes(TOKEN), f);
});

test('basic auth when the email variable is set; the acceptance field is requested and composed under its own heading', async () => {
  setJira({ baseUrl: 'https://x.atlassian.net/', acceptanceField: 'customfield_10042', emailEnv: 'MY_JIRA_EMAIL', tokenEnv: 'MY_JIRA_TOKEN' });
  process.env.MY_JIRA_TOKEN = TOKEN;
  process.env.MY_JIRA_EMAIL = 'dev@example.test';
  const seen: Array<{ url: string; auth: string; accept: string }> = [];
  setHttpGet(mock({ status: 200, body: ISSUE({ description: 'Why we want it.', customfield_10042: '# GET /products/low-stock returns 200\n# the list is sorted by stock' }) }, seen));
  const r = await capture(() => intakeMain(['--jira', 'SHOP-7', '--json']));
  assert.equal(seen[0].url, 'https://x.atlassian.net/rest/api/2/issue/SHOP-7?fields=summary,description,customfield_10042');
  assert.equal(seen[0].auth, `Basic ${Buffer.from(`dev@example.test:${TOKEN}`).toString('base64')}`);
  assert.equal(r.code, 0, r.stderr);
  const text = fs.readFileSync(path.join(inboxHome(), 'SHOP-7.txt'), 'utf8');
  assert.equal(text, 'h1. Low-stock endpoint\n\nh2. Description\nWhy we want it.\n\nh2. Acceptance Criteria\n# GET /products/low-stock returns 200\n# the list is sorted by stock\n');
  const brief = JSON.parse(r.stdout);
  assert.equal(brief.criteria.length, 2);
  delete process.env.MY_JIRA_TOKEN;
  delete process.env.MY_JIRA_EMAIL;
});

test('404 exits 1 with the status and key, never the body', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  setHttpGet(mock({ status: 404, body: { errorMessages: ['SECRET-BODY-TEXT'] } }, []));
  const r = await capture(() => intakeMain(['--jira', 'SHOP-9']));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Jira answered 404 for SHOP-9/);
  assert.ok(!r.stderr.includes('SECRET-BODY-TEXT'));
});

test('a missing token exits 2 and names the variable; nothing is requested', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  delete process.env.HARNESS_JIRA_TOKEN;
  const seen: Array<{ url: string; auth: string; accept: string }> = [];
  setHttpGet(mock({ status: 200, body: ISSUE() }, seen));
  const r = await capture(() => intakeMain(['--jira', 'SHOP-1']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /HARNESS_JIRA_TOKEN/);
  assert.equal(seen.length, 0);
});

test('jira not configured exits 2 with the command to run', async () => {
  setJira(undefined);
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  const r = await capture(() => intakeMain(['--jira', 'SHOP-1']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /harness config set jira\.baseUrl/);
});

test('a key that does not match the shape exits 2 before any request', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  const seen: Array<{ url: string; auth: string; accept: string }> = [];
  setHttpGet(mock({ status: 200, body: ISSUE() }, seen));
  for (const bad of ['shop-1', 'SHOP', 'SHOP-1/../x', '1-2', 'SHOP-1?x=y']) {
    const r = await capture(() => intakeMain(['--jira', bad]));
    assert.equal(r.code, 2, bad);
  }
  assert.equal(seen.length, 0);
});

test('a redirect to another host is refused and not followed', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  const seen: Array<{ url: string; auth: string; accept: string }> = [];
  setHttpGet(mock({ status: 302, headers: { location: 'https://evil.example/steal' } }, seen));
  const r = await capture(() => intakeMain(['--jira', 'SHOP-3']));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /redirect to another host; refused/);
  assert.equal(seen.length, 1);
  assert.ok(!r.stderr.includes(TOKEN));
});

test('errors are redacted: a network error carrying a secret-shaped string never reaches the output', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  const leak = 'ghp_' + 'A'.repeat(36);
  setHttpGet(async () => {
    throw new Error(`socket closed ${leak}`);
  });
  const r = await capture(() => intakeMain(['--jira', 'SHOP-4']));
  assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes(leak));
});

test('--jira with --from is a usage error', async () => {
  setJira({ baseUrl: 'https://jira.example.test' });
  const f = path.join(h.root, 't.txt');
  fs.writeFileSync(f, 'Title: x\n');
  const r = await capture(() => intakeMain(['--jira', 'SHOP-1', '--from', f]));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not both/);
});

test('config set validates jira.*', () => {
  const c = defaultConfig();
  assert.equal(setConfigValue(c, 'jira.baseUrl', 'https://x.atlassian.net/'), null);
  assert.equal(c.jira?.baseUrl, 'https://x.atlassian.net');
  assert.match(setConfigValue(c, 'jira.baseUrl', 'http://x.atlassian.net') ?? '', /https/);
  assert.match(setConfigValue(c, 'jira.baseUrl', 'https://u:p@x.atlassian.net') ?? '', /https/);
  assert.match(setConfigValue(c, 'jira.baseUrl', 'not a url') ?? '', /https/);
  assert.equal(setConfigValue(c, 'jira.acceptanceField', 'customfield_10042'), null);
  assert.match(setConfigValue(c, 'jira.acceptanceField', 'summary') ?? '', /field id/);
  assert.equal(setConfigValue(c, 'jira.tokenEnv', 'MY_JIRA_TOKEN'), null);
  assert.match(setConfigValue(c, 'jira.tokenEnv', 'abc123secret-value') ?? '', /NAME/);
  assert.match(setConfigValue(c, 'jira.emailEnv', 'me@example.com') ?? '', /NAME/);
});
