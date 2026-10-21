import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handle } from '../../../src/hooks/UserPromptSubmit';
import { classifyCorrection, looksLikeTicket, bypassWarnings, mentionedRepos, WARN_HANDOFF, WARN_HOOKS_OFF, WARN_MODE_BYPASS } from '../../../src/hooks/capture';
import { renderOutput } from '../../../src/hook';
import { loadSession } from '../../../src/lib/session';
import { sha256 } from '../../../src/lib/hash';
import { repoIdFor } from '../../../src/lib/config';
import type { AgentId } from '../../../src/types';
import { ctxFor, events, eventsText, makeRepo, record, sandbox, writeLedger, type Sandbox } from './helpers';

let sb: Sandbox;
let repo: string;
let repoId: string;

before(() => {
  sb = sandbox('harness-prompt-');
  repo = makeRepo(path.join(sb.tmp, 'ws', 'catalog-api'), { 'a.ts': 'export {};\n' });
  repoId = repoIdFor(repo);
  writeLedger([
    record('logging.no-console', repoId, { statement: 'Log through the repo logger, never console.log.', tier: 'counted-strong', confidence: 0.97, check: { type: 'eslint', mode: 'block', ref: 'no-console', fixText: 'Use logger.info.' } }),
    record('errors.http-error', repoId, { statement: 'Throw HttpError for HTTP failures.', tier: 'declared', confidence: 0.9 }),
    record('naming.kebab-files', repoId, { statement: 'File names are kebab-case.', tier: 'counted-majority', confidence: 0.7 }),
    record('other.unrelated', 'some-other-repo-123456', { statement: 'Not for this repo.', tier: 'declared' }),
  ]);
});
after(() => sb.restore());

const submit = (agent: AgentId, sid: string, prompt: string, cwd = path.join(sb.tmp, 'ws')) => handle({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt, cwd }, ctxFor(agent, 'UserPromptSubmit', sid));

test('standards for a repo named in the prompt are injected once per (session, repo): declared and counted-strong only', async () => {
  const r = await submit('claude', 'ups-std', 'Please add pagination to catalog-api products listing.');
  const ctx = String(r.additionalContext);
  assert.match(ctx, /Standards for catalog-api/);
  assert.match(ctx, /\[counted-strong\] logging\.no-console: Log through the repo logger, never console\.log\. Fix: Use logger\.info\./);
  assert.match(ctx, /\[declared\] errors\.http-error/);
  assert.doesNotMatch(ctx, /kebab-case/, 'counted-majority is not a top standard');
  assert.doesNotMatch(ctx, /Not for this repo/);
  assert.ok(ctx.split('\n').length <= 21);
  const out = renderOutput('claude', 'UserPromptSubmit', r) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const again = await submit('claude', 'ups-std', 'Also check catalog-api sorting.');
  assert.doesNotMatch(String(again.additionalContext ?? ''), /Standards for catalog-api/);
  // Another session gets them again; Codex and Devin payloads use the same field.
  const codex = await submit('codex', 'ups-std-codex', 'work in catalog-api please');
  assert.match(String(codex.additionalContext), /Standards for catalog-api/);
  const devin = await submit('devin', 'ups-std-devin', `look at ${repo}/a.ts`);
  assert.match(String(devin.additionalContext), /Standards for catalog-api/);
});

test('correction capture logs class and ticket hash only, never prompt text; the first prompt is not a correction', async () => {
  fs.mkdirSync(path.join(sb.hh, 'runs', repoId), { recursive: true });
  fs.writeFileSync(path.join(sb.hh, 'runs', repoId, 'current-task'), 't-0123456789\n');
  const sid = 'ups-corr';
  await submit('claude', sid, "Don't use console in the pricing module, it's a requirement", repo);
  assert.equal(events().filter((e) => e.event === 'correction').length, 0, 'the opening task prompt is not steering');
  const words = ['zebrafish', 'quartermaster', 'pricing', 'logger'];
  await submit('claude', sid, 'No, that is wrong: use the zebrafish logger instead of console.log in pricing (quartermaster rule).', repo);
  const corr = events().filter((e) => e.event === 'correction');
  assert.equal(corr.length, 1);
  assert.equal(corr[0].class, 'style');
  assert.deepEqual(corr[0].ids, { ticket: sha256('t-0123456789') });
  assert.equal(corr[0].sessionId, sid);
  const text = eventsText();
  for (const w of words) assert.ok(!text.includes(w), `events.jsonl must not contain "${w}"`);
  const stateText = fs.readFileSync(path.join(sb.hh, 'state', `${sid}.json`), 'utf8');
  for (const w of words) assert.ok(!stateText.includes(w), `session state must not contain "${w}"`);
  assert.equal(loadSession(sid).lastPromptHash?.length, 64);
  // Without a current task the ticket id is 'none'.
  fs.rmSync(path.join(sb.hh, 'runs', repoId, 'current-task'));
  await submit('devin', sid, 'You should have run the tests again before saying done.', repo);
  const last = events().filter((e) => e.event === 'correction').pop()!;
  assert.deepEqual(last.ids, { ticket: 'none' });
  assert.equal(last.class, 'verify');
});

test('correction taxonomy', () => {
  const cases: Array<[string, string | null]> = [
    ['No, use the logger instead of console.log', 'style'],
    ["that's not how we name files here", 'style'],
    ['wrong: the tests should not mock the database layer', 'safety'],
    ['you should have added a test for the empty case', 'test'],
    ['again, run it end to end before you say it works', 'verify'],
    ["don't touch the billing module, only the ticket's files", 'scope'],
    ['stop, never push to main', 'safety'],
    ['no.', 'other'],
    ['Add pagination to the products endpoint', null],
    ['What does this function do?', null],
    ['', null],
  ];
  for (const [p, want] of cases) assert.equal(classifyCorrection(p), want, p);
});

test('a pasted ticket gets the intake reminder (never run); ordinary prompts do not', async () => {
  const ticket = ['CAT-142 Products list supports pagination', '', 'As a shopper I want pages of products.', '', 'Acceptance criteria:', '- GET /products?page=2 returns the second page', '- page size defaults to 20', '- invalid page returns 400'].join('\n');
  assert.equal(looksLikeTicket(ticket), true);
  assert.equal(looksLikeTicket('Given a cart\nWhen I check out with an empty cart and an expired card and more text here to pass the length\nThen I see an error'), true);
  assert.equal(looksLikeTicket('Can you fix the failing test in src/a.test.ts? It fails since yesterday and I am not sure why, thanks.'), false);
  const r = await submit('codex', 'ups-ticket', ticket);
  assert.match(String(r.additionalContext), /harness intake --from <that file>/);
  assert.match(String(r.additionalContext), /never runs it for you/);
});

test('bypass, handoff and disable-hooks prompts get the harness warning text', async () => {
  assert.deepEqual(bypassWarnings('/mode bypass'), [WARN_MODE_BYPASS]);
  assert.deepEqual(bypassWarnings('ok /handoff this to the cloud'), [WARN_HANDOFF]);
  assert.deepEqual(bypassWarnings('please disable the hooks for a minute'), [WARN_HOOKS_OFF]);
  assert.deepEqual(bypassWarnings('run claude --dangerously-skip-permissions'), [WARN_HOOKS_OFF]);
  assert.deepEqual(bypassWarnings('add a webhook handler'), []);
  const r = await submit('devin', 'ups-bypass', '/mode bypass then turn off the harness hooks');
  const ctx = String(r.additionalContext);
  assert.match(ctx, /forbids `\/mode bypass`/);
  assert.match(ctx, /must not disable or bypass them/);
  assert.equal(r.exitCode, 0, 'warn, never block');
});

test('mentionedRepos matches whole names and paths only', () => {
  const c = [
    { id: 'api-1', name: 'api', path: '/w/api' },
    { id: 'orders-2', name: 'orders', path: '/w/orders' },
  ];
  assert.deepEqual(mentionedRepos('fix the api', c).map((x) => x.id), ['api-1']);
  assert.deepEqual(mentionedRepos('the rapid parser', c), []);
  assert.deepEqual(mentionedRepos('see /w/orders/src/x.ts', c).map((x) => x.id), ['orders-2']);
  assert.deepEqual(mentionedRepos('nothing here', c), []);
});

test('an empty or odd payload never blocks', async () => {
  const r = await handle({ session_id: 'ups-empty' }, ctxFor('claude', 'UserPromptSubmit', 'ups-empty'));
  assert.equal(r.exitCode, 0);
});
