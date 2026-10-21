import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile } from '../../../src/types';
import { buildBrief, runDir, saveBrief, type BriefFile } from '../../../src/intake/brief';
import { artifactLabel, diffAgainst, gatherRepoWork, renderWriteup, verificationRows } from '../../../src/intake/writeup';
import { addExpectChange, setTaskPhase } from '../../../src/intake/phase';
import { repoIdFor } from '../../../src/lib/config';
import { writeJson } from '../../../src/lib/fsx';
import { main as writeupMain } from '../../../src/commands/writeup';
import { saveConfig, defaultConfig } from '../../../src/lib/config';
import { capture } from '../commands/capture';
import { git, gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const TICKET = [
  'Title: Add order total',
  'Description:',
  `Customers want the total on each order. The old script used ${TOKEN} to call the API.`,
  '',
  'Acceptance Criteria:',
  '1. GET /orders/:id returns total',
  '2. total stored in orders.total column',
  '3. The order page shows the total',
].join('\n');

let h: TempHome;
let repo: string;
let repoId: string;
let brief: BriefFile;

/** A fabricated evidence file (a fixture standing in for a real gate run). */
function evidenceFixture(over: Partial<EvidenceFile> = {}): EvidenceFile {
  return {
    version: 1,
    repo: repoId,
    task: brief.id,
    verdict: 'PASS',
    reasons: [],
    treeHash: 'f'.repeat(40),
    baseSha: brief.baseShas[repoId],
    steps: [
      { name: 'build', status: 'pass', durationMs: 10 },
      { name: 'acceptance:AC1', status: 'pass', durationMs: 20 },
      { name: 'acceptance:AC2', status: 'fail', durationMs: 20, reasons: ['column total missing'] },
    ],
    attempt: 2,
    startedAt: '2026-10-19T10:00:00.000Z',
    finishedAt: '2026-10-19T10:01:00.000Z',
    e2e: [{ id: 'AC1-http', kind: 'http', path: path.join(runDir(repoId, brief.id), 'e2e', 'AC1-http.json'), treeHash: 'f'.repeat(40), createdAt: '2026-10-19T10:00:30.000Z' }],
    ...over,
  };
}

before(() => {
  h = tempHome('harness-writeup-');
  repo = gitRepo(path.join(h.workspace, 'orders-api'), { 'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'jest' } }), 'src/orders.ts': 'export const x = 1;\n' });
  repoId = repoIdFor(repo);
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }] }));
  brief = buildBrief(TICKET, { config: { repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }] } });
  saveBrief(brief);
  fs.writeFileSync(path.join(repo, 'src', 'orders.ts'), 'export const x = 2;\nexport const total = 3;\n');
  fs.writeFileSync(path.join(repo, 'src', 'total.ts'), 'export {};\n');
});
after(() => h.cleanup());

test('the brief maps every criterion to the registered repo and records the base commit', () => {
  assert.deepEqual(brief.repos, [repoId]);
  assert.equal(brief.baseShas[repoId], git(repo, ['rev-parse', 'HEAD']).stdout.trim());
  assert.deepEqual(
    brief.criteria.map((c) => c.kind),
    ['api', 'db', 'ui-artifact'],
  );
});

test('diff against the base: file names and line counts only, untracked files included', () => {
  const ch = diffAgainst(repo, brief.baseShas[repoId]);
  assert.deepEqual(ch, [
    { status: 'M', file: 'src/orders.ts', added: 2, removed: 1 },
    { status: '?', file: 'src/total.ts' },
  ]);
});

test('write-up with fabricated evidence (fixture): table rows link steps and artifacts by criterion id, token in the body is redacted', () => {
  const work = { ...gatherRepoWork(brief, repoId, 'orders-api', repo), evidence: evidenceFixture(), evidenceStale: false };
  const text = renderWriteup({ brief, setting: 'team', repos: [work] }, work);
  for (const s of ['## Why', '## What changed', '## Scope', '## Tradeoffs', '## Blast radius', '## Verification', '## Assumptions', '## Feedback wanted', '## Branch and next steps']) assert.ok(text.includes(s), `missing ${s}`);
  assert.ok(!text.includes(TOKEN), 'token must be redacted');
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\| AC1 GET \/orders\/:id returns total \| e2e-http: GET \/orders\/:id -> 200; body has "total" in orders-api \| PASS \| e2e\/AC1-http\.json \|/);
  assert.match(text, /\| AC2 total stored in orders\.total column \| e2e-db: .* \| FAIL \| - \|/);
  assert.match(text, /\| AC3 The order page shows the total \| manual: .* \| manual: no artifact linked \| - \|/);
  assert.match(text, /Gate: PASS at tree ffffffffffff, attempt 2/);
  assert.match(text, /- `src\/orders\.ts` modified \(\+2 -1\)/);
  assert.match(text, /- `src\/total\.ts` new, untracked/);
  assert.match(text, /Routes named in the ticket: GET \/orders\/:id/);
  assert.match(text, /Tables named in the ticket: orders/);
  assert.match(text, /Gate step acceptance:AC2 failed: column total missing/);
  assert.match(text, /AC3 is checked by hand/);
  // the work is on main here: the steps move it to a branch first and never suggest pushing main
  assert.doesNotMatch(text, /git push -u origin main/);
  assert.match(text, /1\. Move the change to its own branch and commit it there: `git switch -c [a-z0-9-]+`/);
  assert.match(text, /2\. Push that branch: `git push -u origin [a-z0-9-]+`/);
  const onBranch = renderWriteup({ brief, setting: 'team', repos: [{ ...work, branch: 'feature/order-total' }] }, { ...work, branch: 'feature/order-total' });
  assert.match(onBranch, /1\. Push the branch: `git push -u origin feature\/order-total`/);
  assert.match(onBranch, /3\. Request review\./);
  assert.ok(!text.includes(h.root), 'no local absolute paths in the write-up');
});

test('no evidence file: every row says "gate not run"; personal setting ends with landing, not manual steps', () => {
  const work = gatherRepoWork(brief, repoId, 'orders-api', repo);
  assert.equal(work.evidence, null);
  const rows = verificationRows(brief, ['AC1', 'AC2', 'AC3'], work);
  assert.deepEqual(
    rows.map((r) => r.result),
    ['gate not run', 'gate not run', 'gate not run'],
  );
  const text = renderWriteup({ brief, setting: 'personal', repos: [work] }, work);
  assert.match(text, /Gate: not run \(no evidence file for this task\)/);
  assert.match(text, /## Landing/);
  assert.doesNotMatch(text, /Push the branch/);
});

test('stale evidence and blocked verdicts are stated in the result column', () => {
  const work = { ...gatherRepoWork(brief, repoId, 'orders-api', repo), evidence: evidenceFixture({ verdict: 'BLOCKED', reasons: ['test server down'] }), evidenceStale: true };
  const rows = verificationRows(brief, ['AC1'], work);
  assert.equal(rows[0].result, 'PASS (gate BLOCKED) (evidence is for an older tree)');
});

test('cap reached: the write-up never cites PASS (evidence marker, or cap.json when the gate never ran)', () => {
  const work = { ...gatherRepoWork(brief, repoId, 'orders-api', repo), evidence: evidenceFixture({ cap_reached: true, cap_reached_at: '2026-10-19T10:05:00.000Z' }), evidenceStale: false };
  const rows = verificationRows(brief, ['AC1', 'AC2'], work);
  assert.equal(rows[0].result, 'not cited: gate attempt cap reached (needs review)');
  assert.equal(rows[1].result, 'FAIL');
  const text = renderWriteup({ brief, setting: 'team', repos: [work] }, work);
  assert.match(text, /Gate: NOT PASSED\. The gate-attempt cap was reached/);
  assert.doesNotMatch(text, /Gate: PASS/);
  assert.doesNotMatch(text, /\| PASS \|/);
  assert.match(text, /nothing here is verified by a PASS/);
  // cap.json without evidence (the gate never ran): gatherRepoWork picks it up.
  const dir = runDir(repoId, brief.id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'cap.json'), { version: 1, cap_reached: true, cap_reached_at: '2026-10-19T10:06:00.000Z', attempts: 8, sessionId: 's1' });
  try {
    const w2 = gatherRepoWork(brief, repoId, 'orders-api', repo);
    assert.equal(w2.capReached, true);
    const t2 = renderWriteup({ brief, setting: 'team', repos: [w2] }, w2);
    assert.match(t2, /Gate: NOT PASSED\..*the gate never ran/);
    assert.doesNotMatch(t2, /Gate: not run/);
  } finally {
    fs.rmSync(path.join(dir, 'cap.json'), { force: true });
  }
});

test('artifact labels never expose absolute paths outside the run folder', () => {
  assert.equal(artifactLabel(path.join(runDir(repoId, brief.id), 'e2e', 'x.json'), repoId, brief.id), 'e2e/x.json');
  assert.equal(artifactLabel('/somewhere/else/shot.png', repoId, brief.id), 'shot.png');
});

test('writeup command: saves writeup.md in the run folder, counts tests-phase entries, refuses --out inside a team repo', async () => {
  writeJson(path.join(runDir(repoId, brief.id), 'evidence.json'), evidenceFixture());
  setTaskPhase(repoId, brief.id, 'tests');
  setTaskPhase(repoId, brief.id, 'implement');
  setTaskPhase(repoId, brief.id, 'tests');
  const r = await capture(() => writeupMain(['--task', brief.id, '--repo', repo]));
  assert.equal(r.code, 0, r.stderr);
  const saved = fs.readFileSync(path.join(runDir(repoId, brief.id), 'writeup.md'), 'utf8');
  assert.ok(r.stdout.includes(saved.trim().split('\n')[0]));
  assert.match(saved, /entered 2 time\(s\)/);
  assert.match(saved, /evidence is for an older tree/, 'fixture tree hash differs from the real tree');
  const refused = await capture(() => writeupMain(['--task', brief.id, '--repo', repo, '--out', path.join(repo, 'PR.md')]));
  assert.equal(refused.code, 4);
  assert.match(refused.stderr, /inside a team repository/);
  assert.ok(!fs.existsSync(path.join(repo, 'PR.md')));
  const outside = path.join(h.root, 'pr.md');
  const ok = await capture(() => writeupMain(['--task', brief.id, '--repo', repo, '--out', outside, '--json']));
  assert.equal(ok.code, 0);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.writeups.length, 1);
  assert.equal(j.writeups[0].rows.length, 3);
  assert.ok(fs.readFileSync(outside, 'utf8').includes('## Verification'));
  const none = await capture(() => writeupMain(['--task', 'nope', '--repo', repo]));
  assert.equal(none.code, 1);
});

test('writeup lists declared expectation changes in existing tests', async () => {
  addExpectChange(repoId, brief.id, { file: 'test/orders.test.ts', reason: 'totals now include tax' });
  const r = await capture(() => writeupMain(['--task', brief.id, '--repo', repo]));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Expectations changed in existing tests \(declared\): test\/orders\.test\.ts: totals now include tax/);
});

test('cross-repo write-ups: one per touched repo with a cross-reference section and the landing order', () => {
  const web = gitRepo(path.join(h.workspace, 'shop-web'));
  const cfg = { repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }, { id: 'shop-web', path: web, name: 'shop-web', isGit: true }] };
  const b = buildBrief('Title: Totals everywhere\nAC:\n1. orders-api: GET /orders/:id returns total\n2. shop-web: the order page shows the total\n', { config: cfg });
  assert.equal(b.repos.length, 2);
  const works = b.landingOrder.map((id) => gatherRepoWork(b, id, id === repoIdFor(repo) ? 'orders-api' : 'shop-web', id === repoIdFor(repo) ? repo : web));
  const first = renderWriteup({ brief: b, setting: 'team', repos: works }, works[0]);
  const second = renderWriteup({ brief: b, setting: 'team', repos: works }, works[1]);
  assert.match(first, /## Cross-repo\nThis ticket lands as 2 changes\. Landing order: 1\. orders-api {2}2\. shop-web/);
  assert.match(first, /- shop-web: AC2/);
  assert.match(second, /- orders-api: AC1/);
  assert.match(second, /depends on U1 in orders-api: land that first/);
});

test('pre-existing test files the change edited are named first in "What changed"; new tests and source edits are not', () => {
  const base = gatherRepoWork(brief, repoId, 'orders-api', repo);
  const work = { ...base, changes: [{ status: 'M', file: 'src/orders.ts', added: 2, removed: 1 }, { status: 'M', file: 'test/orders.test.ts', added: 1, removed: 1 }, { status: '?', file: 'test/total.test.ts' }], evidence: null, evidenceStale: false };
  const text = renderWriteup({ brief, setting: 'team', repos: [work] }, work);
  assert.match(text, /Existing tests changed \(read these first; an expectation may have been moved to match the new behaviour\): `test\/orders\.test\.ts`\./);
  const none = { ...base, changes: [{ status: 'M', file: 'src/orders.ts', added: 2, removed: 1 }, { status: '?', file: 'test/total.test.ts' }], evidence: null, evidenceStale: false };
  assert.doesNotMatch(renderWriteup({ brief, setting: 'team', repos: [none] }, none), /Existing tests changed/);
});
