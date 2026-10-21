import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, type TempHome } from '../lifecycle/helpers';
import { makeReport } from '../../../src/report/index';
import { buildTokenSet, candidatesOf, reportVocabulary, scrubMarkdown, scrubReport, scrubValue, wordsOf, type TokenSet } from '../../../src/report/scrub';
import { renderMarkdown } from '../../../src/report/markdown';
import { buildFixture, PLANTED } from './fixture';
import type { Report } from '../../../src/types';

let h: TempHome;
let real: Report;
let md: string;
let ts: TokenSet;
before(() => {
  h = tempHome('harness-scrub-');
  delete process.env.XDG_CONFIG_HOME;
  buildFixture(h.harnessHome, h.workspace);
  const run = makeReport({ harnessVersion: '0.1.0', now: new Date('2026-10-19T00:00:00.000Z') });
  real = run.report;
  md = run.markdown;
  ts = run.tokens;
});
after(() => h.cleanup());

const clone = (r: Report): Report => JSON.parse(JSON.stringify(r)) as Report;

test('the token set holds the planted repo name, identifier and ticket word, lower case', () => {
  for (const t of [PLANTED.repo, PLANTED.identifier.toLowerCase(), PLANTED.ticketWord, 'beta-service', 'zanzibar-exporter', 'betaserviceversion']) {
    assert.ok(ts.tokens.has(t), `token ${t}`);
  }
  assert.equal(ts.stats.files, 3, `files walked: ${ts.stats.files}`); // two source files and a package.json
  assert.ok(ts.stats.sourceFiles >= 2, `source files sampled: ${ts.stats.sourceFiles}`);
  assert.equal(ts.stats.briefs, 2);
  assert.equal(ts.stats.checked, ts.tokens.size);
});

test('the report on the fixture passes the scrub (JSON and Markdown)', () => {
  const r = scrubReport(real, md, ts);
  assert.deepEqual(r.leaks, []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, ts.tokens.size);
});

test('a doctored report: a planted repo name, identifier and ticket word are each caught, by field path only', () => {
  const d = clone(real);
  d.tasks[0].outcome = `left in ${PLANTED.repo}`;
  d.assessment.findingsByCheck[PLANTED.identifier] = 1;
  d.harnessVersion = PLANTED.ticketWord.toUpperCase(); // case-insensitive
  const r = scrubReport(d, null, ts);
  assert.equal(r.ok, false);
  assert.deepEqual(r.leaks.sort(), ['assessment.findingsByCheck{key}', 'harnessVersion', 'tasks[0].outcome']);
  for (const l of r.leaks) {
    assert.ok(!l.toLowerCase().includes(PLANTED.identifier.toLowerCase()) && !l.includes(PLANTED.ticketWord), `leak path names no token: ${l}`);
  }
  const doctoredMd = renderMarkdown(real) + `\nA note about ${PLANTED.ticketWord}.\n`;
  const m = scrubMarkdown(doctoredMd, ts.tokens);
  assert.equal(m.length, 1);
  assert.match(m[0], /^markdown line \d+$/);
  const selfcheckLeak = clone(real);
  selfcheckLeak.selfcheck = { devin: { steps: 1, recorded: 1, confirmed: [PLANTED.repo], different: [] } };
  assert.deepEqual(scrubValue(selfcheckLeak, ts.tokens), ['selfcheck{key}.confirmed[0]']);
});

test('matching is whole-word: a token inside a longer word is not a hit, a hyphenated name is', () => {
  const t = new Set(['port', 'alpha-service']);
  assert.equal(scrubMarkdown('the report covers it', t).length, 0);
  assert.equal(scrubMarkdown('the alpha-service repo', t).length, 1);
  assert.ok(wordsOf('Alpha-Service.ts').has('alpha-service.ts'));
  assert.ok(wordsOf('Alpha-Service.ts').has('alpha'));
});

test("the report's own words, numbers and very short words are dropped from the token set, and counted", () => {
  const ws = path.join(h.root, 'ws-vocab');
  fs.mkdirSync(path.join(ws, 'tests', 'lint'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'tests', 'lint', 'a1.ts'), 'const x = 1;\n');
  fs.mkdirSync(path.join(ws, '2024'), { recursive: true });
  fs.writeFileSync(path.join(ws, '2024', 'notes.md'), 'n');
  const t = buildTokenSet({ workspaceRoot: ws, repos: [{ name: 'naming' }], briefs: [{ title: 'Fix the gate verdict', criteria: [{ text: 'ok' }] }] });
  for (const w of ['tests', 'lint', 'naming', 'gate', 'verdict', 'the']) assert.ok(!t.tokens.has(w), `vocabulary word ${w} dropped`);
  assert.ok(t.tokens.has('notes'));
  assert.ok(!t.tokens.has('2024'));
  assert.ok(t.stats.vocabulary > 0 && t.stats.numeric > 0 && t.stats.short > 0, JSON.stringify(t.stats));
  const v = reportVocabulary();
  for (const w of ['standards', 'tier', 'counted-strong', 'quarantine', 'merged', 'tickethash', 'stop-timeout']) assert.ok(v.has(w), `vocabulary has ${w}`);
  assert.deepEqual(candidatesOf('Order_Total-Cents.ts'), ['order_total-cents.ts', 'order', 'total', 'cents']);
});

test('the token set honours the file and sample caps', () => {
  const ws = path.join(h.root, 'ws-many');
  for (let i = 0; i < 30; i++) {
    fs.mkdirSync(path.join(ws, `pkg${i}`), { recursive: true });
    fs.writeFileSync(path.join(ws, `pkg${i}`, `file${i}.ts`), `export const identifierNumber${i} = ${i};\n`);
  }
  const t = buildTokenSet({ workspaceRoot: ws, maxFiles: 10, maxSourceFiles: 3 });
  assert.equal(t.stats.files, 10);
  assert.equal(t.stats.sourceFiles, 3);
});
