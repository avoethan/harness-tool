/** A full `harness gate` run ends by writing writeup.md and printing its path as the last line. */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion } from '../../../src/types';
import { main as gateMain } from '../../../src/commands/gate';
import { repoIdFor } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import { capture } from '../commands/capture';
import { demoRepo, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-writeup-');
});
after(() => h.cleanup());

const AC1: Criterion = { id: 'AC1', text: 'mul multiplies', kind: 'unit', check: { kind: 'unit', description: 'Unit test named "AC1: ..."', redFirst: true } };

function setup(criteria: Criterion[]): { repo: string; task: string; file: string } {
  const repo = demoRepo(path.join(h.workspace, `w${++n}`));
  const task = `t-wu-${n}`;
  writeBrief(repo, task, criteria);
  return { repo, task, file: path.join(runsDir(), repoIdFor(repo), task, 'writeup.md') };
}

function lastLine(out: string): string {
  return out.trimEnd().split('\n').pop()!;
}

test('PASS: the gate writes writeup.md and prints "Write-up: <path>" as the last line', async () => {
  const { repo, file } = setup([]);
  const out = await capture(() => gateMain(['--repo', repo]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(lastLine(out.stdout), `Write-up: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## Verification/);
  assert.match(text, /Gate: PASS/);
});

test('FAIL: the write-up is written too and shows the failure, not a PASS', async () => {
  const { repo, file } = setup([AC1]);
  const out = await capture(() => gateMain(['--repo', repo]));
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.equal(lastLine(out.stdout), `Write-up: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /Gate: FAIL/);
  assert.doesNotMatch(text, /Gate: PASS/);
});

test('BLOCKED: harness gate --blocked writes the write-up with the reason in Verification', async () => {
  const { repo, file } = setup([AC1]);
  const reason = 'the ticket needs a schema decision from the team';
  const out = await capture(() => gateMain(['--repo', repo, '--blocked', reason]));
  assert.equal(out.code, 4, out.stdout + out.stderr);
  assert.equal(lastLine(out.stdout), `Write-up: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const verification = text.slice(text.indexOf('## Verification'), text.indexOf('## Assumptions'));
  assert.match(verification, /Gate: BLOCKED/);
  assert.ok(verification.includes(`Blocked: ${reason}`), verification);
});

test('a partial --steps run writes no write-up and prints no Write-up line', async () => {
  const { repo, file } = setup([]);
  const out = await capture(() => gateMain(['--repo', repo, '--steps', 'tamper']));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.doesNotMatch(out.stdout, /Write-up:/);
  assert.equal(fs.existsSync(file), false);
});

test('no brief (adhoc task): one line says there is no write-up, and no file is written', async () => {
  const repo = demoRepo(path.join(h.workspace, `w${++n}`));
  const out = await capture(() => gateMain(['--repo', repo]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const last = lastLine(out.stdout);
  assert.match(last, /^Write-up: none \(this task has no brief/);
  assert.equal(fs.existsSync(path.join(runsDir(), repoIdFor(repo), 'adhoc', 'writeup.md')), false);
});

test('the cap marker: the gate never reports PASS and the write-up does not cite PASS', async () => {
  const { repo, task, file } = setup([]);
  const dir = path.join(runsDir(), repoIdFor(repo), task);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cap.json'), JSON.stringify({ cap_reached: true, cap_reached_at: '2026-01-01T00:00:00Z' }));
  const out = await capture(() => gateMain(['--repo', repo]));
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.equal(lastLine(out.stdout), `Write-up: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /Gate: NOT PASSED/);
  assert.doesNotMatch(text, /Gate: PASS/);
});

test('--json keeps stdout valid JSON and reports the write-up path in a field', async () => {
  const { repo, file } = setup([]);
  const out = await capture(() => gateMain(['--repo', repo, '--json']));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const j = JSON.parse(out.stdout) as { writeupPath: string | null };
  assert.equal(j.writeupPath, file);
});
