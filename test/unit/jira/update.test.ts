/**
 * `harness jira update` and `harness jira create --title ...`: fields written as given, with the HTTP
 * layer mocked (never the network). The issue is read first; only changed fields are sent; acceptance
 * criteria go to the configured field or into the description's section; a brief's clarified
 * criteria can be written back; nothing is sent without --yes.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as jiraMain } from '../../../src/commands/jira';
import { setHttpGet, setHttpPost, setHttpPut, type HttpGet, type HttpPost } from '../../../src/commands/reviews';
import { buildBrief, saveBrief } from '../../../src/intake/brief';
import { briefAcceptanceLines, jiraCreate, jiraUpdate } from '../../../src/jira/run';
import { acceptanceList, withAcceptanceSection } from '../../../src/jira/compose';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import type { JiraConfig } from '../../../src/types';
import { capture } from '../commands/capture';
import { tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
const TOKEN = 'jira-update-token-0001';
const ENV = { HARNESS_JIRA_TOKEN: TOKEN } as NodeJS.ProcessEnv;
const CFG: JiraConfig = { baseUrl: 'https://jira.example.test', project: 'SHOP' };
const CFG_FIELD: JiraConfig = { ...CFG, acceptanceField: 'customfield_10042' };

interface Sent {
  method: string;
  url: string;
  body: string;
  auth: string;
}
const sent: Sent[] = [];
let issue: Record<string, unknown> = {};
const getMock: HttpGet = async (url, headers) => {
  sent.push({ method: 'GET', url, body: '', auth: headers.Authorization ?? '' });
  return { status: 200, headers: {}, body: JSON.stringify({ fields: issue }) };
};
const sender = (method: string): HttpPost => async (url, headers, body) => {
  sent.push({ method, url, body, auth: headers.Authorization ?? '' });
  return { status: method === 'PUT' ? 204 : 201, headers: {}, body: method === 'PUT' ? '' : JSON.stringify({ key: 'SHOP-300' }) };
};
let restore: Array<() => void> = [];

before(() => {
  h = tempHome('harness-jira-update-');
  const g = setHttpGet(getMock);
  const po = setHttpPost(sender('POST'));
  const pu = setHttpPut(sender('PUT'));
  restore = [() => setHttpGet(g), () => setHttpPost(po), () => setHttpPut(pu)];
  delete process.env.HARNESS_JIRA_TOKEN;
  delete process.env.HARNESS_JIRA_EMAIL;
});
after(() => {
  for (const r of restore) r();
  h.cleanup();
});

test('compose: the acceptance list and the description section (replaced in place, or added at the end)', () => {
  assert.equal(acceptanceList(['1. first', '- second', '# third', '  ', 'fourth']), '# first\n# second\n# third\n# fourth');
  const d = 'Staff need to see low stock.\n\nh2. Acceptance Criteria\n# old one\n# old two\n\nh2. Notes\nkeep this\n';
  assert.equal(withAcceptanceSection(d, '# new one'), 'Staff need to see low stock.\n\nh2. Acceptance Criteria\n# new one\n\nh2. Notes\nkeep this\n');
  assert.equal(withAcceptanceSection('Just a description.', '# a'), 'Just a description.\n\nh2. Acceptance Criteria\n# a\n');
  assert.equal(withAcceptanceSection('', '# a'), 'h2. Acceptance Criteria\n# a\n');
});

test('update: reads the issue, shows before/after, sends nothing without --yes; with --yes PUTs only the changed fields (title and the description with the new section)', async () => {
  sent.length = 0;
  issue = { summary: 'Low stock', description: 'Staff need to see low stock.\n\nh2. Acceptance Criteria\n# it works\n' };
  const dry = await jiraUpdate({ key: 'SHOP-102', title: 'Low-stock endpoint', acceptance: ['GET /products/low-stock returns the products below their threshold', 'The dashboard lists them'], env: ENV, cfg: CFG });
  assert.equal(dry.exitCode, 0, dry.message);
  assert.equal(dry.sent, false);
  assert.deepEqual(sent.map((s) => s.method), ['GET']);
  assert.match(dry.message, /SHOP-102: 2 fields to change/);
  assert.match(dry.message, /Title:\n {2}before:\n {4}Low stock\n {2}after:\n {4}Low-stock endpoint/);
  assert.match(dry.message, /before:\n(?:.*\n)*? {4}# it works/);
  assert.match(dry.message, /# GET \/products\/low-stock returns the products below their threshold\n {4}# The dashboard lists them/);
  assert.match(dry.message, /Nothing was sent\. Add --yes/);
  assert.ok(!dry.message.includes(TOKEN));

  sent.length = 0;
  const r = await jiraUpdate({ key: 'SHOP-102', title: 'Low-stock endpoint', acceptance: ['GET /products/low-stock returns the products below their threshold'], yes: true, env: ENV, cfg: CFG });
  assert.equal(r.exitCode, 0, r.message);
  assert.equal(r.sent, true);
  assert.deepEqual(sent.map((s) => s.method), ['GET', 'PUT']);
  assert.equal(sent[1].url, 'https://jira.example.test/rest/api/2/issue/SHOP-102');
  const body = JSON.parse(sent[1].body) as { fields: Record<string, string> };
  assert.deepEqual(Object.keys(body.fields).sort(), ['description', 'summary']);
  assert.equal(body.fields.summary, 'Low-stock endpoint');
  assert.equal(body.fields.description, 'Staff need to see low stock.\n\nh2. Acceptance Criteria\n# GET /products/low-stock returns the products below their threshold\n');
  assert.equal(sent[1].auth, `Bearer ${TOKEN}`);
  assert.match(r.message, /^Updated SHOP-102: title, description\./);
});

test('update: with jira.acceptanceField the criteria go to that field and the description is untouched; a title equal to Jira\'s is not sent; nothing to change sends nothing', async () => {
  sent.length = 0;
  issue = { summary: 'Low stock', description: 'Desc.', customfield_10042: '# old' };
  const r = await jiraUpdate({ key: 'SHOP-102', title: 'Low stock', acceptance: ['new one', 'new two'], yes: true, env: ENV, cfg: CFG_FIELD });
  assert.equal(r.exitCode, 0, r.message);
  const body = JSON.parse(sent[1].body) as { fields: Record<string, string> };
  assert.deepEqual(body.fields, { customfield_10042: '# new one\n# new two' });
  sent.length = 0;
  const same = await jiraUpdate({ key: 'SHOP-102', acceptance: ['old'], yes: true, env: ENV, cfg: CFG_FIELD });
  assert.equal(same.exitCode, 0);
  assert.equal(same.sent, false);
  assert.match(same.message, /nothing differs from what Jira holds/);
  assert.deepEqual(sent.map((s) => s.method), ['GET']);
});

test('update --from-brief: the brief\'s clarified criteria (the testable rewrite and the answers) replace the ticket\'s; flags win over the brief; the brief is found by the ticket key', async () => {
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, jira: CFG }));
  const b = buildBrief('Title: Faster search\nDescription: Search is slow.\nAcceptance Criteria:\n1. Search is fast enough.\n2. Results are the same as before.\n', { config: { repos: [] }, jiraKey: 'SHOP-77', noScout: true, unattended: true } as never);
  saveBrief(b);
  const lines = briefAcceptanceLines(b);
  assert.equal(lines.length, 2);
  assert.ok(/p95|fast/.test(lines[0]), lines[0]);
  sent.length = 0;
  issue = { summary: 'Faster search', description: 'Search is slow.' };
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  let out;
  try {
    out = await capture(() => jiraMain(['update', 'SHOP-77', '--from-brief', '--title', 'Faster search (p95)', '--yes', '--json']));
  } finally {
    delete process.env.HARNESS_JIRA_TOKEN;
  }
  assert.equal(out.code, 0, out.stderr);
  const j = JSON.parse(out.stdout) as { sent: boolean; requests: Array<{ method: string; body: { fields: Record<string, string> } }> };
  assert.equal(j.sent, true);
  assert.equal(j.requests[0].method, 'PUT');
  assert.equal(j.requests[0].body.fields.summary, 'Faster search (p95)');
  assert.match(j.requests[0].body.fields.description, /^Search is slow\.\n\nh2\. Acceptance Criteria\n# .*\n# Results are the same as before\.\n$/);
  // no brief for the key: exit 2 with the way out
  const none = await capture(() => jiraMain(['update', 'SHOP-78', '--from-brief']));
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no brief was read from SHOP-78; pass --from-brief <id>/);
});

test('update: usage errors (bad key, nothing to change, empty title) exit 2 before any request; files feed --description-file and --acceptance-file', async () => {
  sent.length = 0;
  assert.equal((await jiraUpdate({ key: 'nope', title: 'x', env: ENV, cfg: CFG })).exitCode, 2);
  assert.equal((await jiraUpdate({ key: 'SHOP-1', env: ENV, cfg: CFG })).exitCode, 2);
  assert.equal((await jiraUpdate({ key: 'SHOP-1', title: '  ', env: ENV, cfg: CFG })).exitCode, 2);
  assert.equal(sent.length, 0);
  const df = path.join(h.root, 'd.txt');
  const af = path.join(h.root, 'a.txt');
  fs.writeFileSync(df, 'From a file.\n');
  fs.writeFileSync(af, 'first\n\nsecond\n');
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, jira: CFG }));
  issue = { summary: 'S', description: 'D' };
  process.env.HARNESS_JIRA_TOKEN = TOKEN;
  try {
    const out = await capture(() => jiraMain(['update', 'SHOP-5', '--description-file', df, '--acceptance-file', af, '--dry-run', '--json']));
    assert.equal(out.code, 0, out.stderr);
    const j = JSON.parse(out.stdout) as { requests: Array<{ body: { fields: Record<string, string> } }> };
    assert.equal(j.requests[0].body.fields.description, 'From a file.\n\nh2. Acceptance Criteria\n# first\n# second\n');
    const both = await capture(() => jiraMain(['update', 'SHOP-5', '--description', 'x', '--description-file', df]));
    assert.equal(both.code, 2);
  } finally {
    delete process.env.HARNESS_JIRA_TOKEN;
  }
});

test('create from fields: title, description with the criteria section, type Story by default, no task needed; nothing without --yes; --from with fields is refused', async () => {
  sent.length = 0;
  const dry = await jiraCreate({ title: 'Cache the stock list', description: 'It is slow.', acceptance: ['p95 under 200 ms'], env: ENV, cfg: CFG });
  assert.equal(dry.exitCode, 0, dry.message);
  assert.equal(dry.sent, false);
  assert.equal(sent.length, 0);
  assert.match(dry.message, /Summary: Cache the stock list/);
  assert.match(dry.message, /h2\. Acceptance Criteria\n {4}# p95 under 200 ms/);
  assert.match(dry.message, /\(SHOP, Story\)/);
  const r = await jiraCreate({ title: 'Cache the stock list', description: 'It is slow.', acceptance: ['p95 under 200 ms'], yes: true, env: ENV, cfg: CFG });
  assert.equal(r.exitCode, 0, r.message);
  assert.deepEqual(r.created?.map((c) => c.key), ['SHOP-300']);
  const body = JSON.parse(sent[0].body) as { fields: Record<string, unknown> };
  assert.equal(body.fields.summary, 'Cache the stock list');
  assert.equal(body.fields.description, 'It is slow.\n\nh2. Acceptance Criteria\n# p95 under 200 ms\n');
  assert.deepEqual(body.fields.issuetype, { name: 'Story' });
  assert.equal((await jiraCreate({ title: 'x', from: 'blocked', env: ENV, cfg: CFG })).exitCode, 2);
  assert.equal((await jiraCreate({ description: 'no title', env: ENV, cfg: CFG })).exitCode, 2);
});
