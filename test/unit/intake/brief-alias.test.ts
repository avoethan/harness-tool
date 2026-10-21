/** `harness brief [id]` is an alias of `harness intake show [id]`. */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main as cliMain } from '../../../src/cli';
import { main as intakeMain } from '../../../src/commands/intake';
import { main as briefMain } from '../../../src/commands/brief';
import { defaultConfig, saveConfig } from '../../../src/lib/config';
import { capture } from '../commands/capture';
import { gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
let repo: string;
let id: string;

before(async () => {
  h = tempHome('harness-brief-alias-');
  repo = gitRepo(path.join(h.workspace, 'orders-api'), { 'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run' } }) });
  saveConfig(defaultConfig({ setting: 'team', workspaceRoot: h.workspace, repos: [{ id: 'orders-api', path: repo, name: 'orders-api', isGit: true }] }));
  const p = path.join(h.root, 't.txt');
  fs.writeFileSync(p, 'Title: Add order total\nAcceptance Criteria:\n1. GET /orders/:id returns total\n');
  const r = await capture(() => intakeMain(['--from', p, '--repo', repo]));
  id = /Brief (t-[0-9a-f]{10})/.exec(r.stdout)![1];
});
after(() => h.cleanup());

test('harness brief prints what harness intake show prints, with the same exit code', async () => {
  const a = await capture(() => briefMain(['--repo', repo]));
  const b = await capture(() => intakeMain(['show', '--repo', repo]));
  assert.equal(a.code, b.code);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, new RegExp(`Brief ${id}`));
});

test('harness brief <id> --json matches intake show <id> --json; an unknown id exits like intake show', async () => {
  const a = await capture(() => briefMain([id, '--json']));
  const b = await capture(() => intakeMain(['show', id, '--json']));
  assert.equal(a.stdout, b.stdout);
  assert.equal(JSON.parse(a.stdout).id, id);
  const x = await capture(() => briefMain(['t-0000000000']));
  const y = await capture(() => intakeMain(['show', 't-0000000000']));
  assert.equal(x.code, y.code);
  assert.equal(x.stderr, y.stderr);
});

test('the CLI help lists brief with its summary, through the dispatcher too', async () => {
  const help = await capture(() => cliMain(['--help']));
  assert.match(help.stdout, /\n {2}brief {9}Show a brief \(alias of intake show\)\n/);
  const viaCli = await capture(() => cliMain(['brief', '--repo', repo]));
  assert.match(viaCli.stdout, new RegExp(`Brief ${id}`));
});
