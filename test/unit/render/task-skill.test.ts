/** What the task skill tells the agent (the always-on file stays short; the skill carries the detail). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Setting } from '../../../src/types';
import { renderSkill } from '../../../src/render/skills';
import { renderAlwaysOnFile } from '../../../src/render/alwayson';
import { context } from './helpers';

const SETTINGS: Setting[] = ['team', 'personal'];
const flat = (s: string) => s.replace(/\s+/g, ' ');

for (const setting of SETTINGS) {
  test(`${setting}: the skill makes the workflow proportional to the brief`, () => {
    const t = flat(renderSkill('task', context(setting, ['claude']), 'claude'));
    assert.match(t, /When no criterion is `api` or `db`, skip phase 4 entirely/);
    assert.match(t, /tests -> implement -> gate -> write-up/);
    assert.match(t, /launch once, drive every `run:` line, and clean up once/);
  });

  test(`${setting}: the skill names the only commands that read a brief and says no other exists`, () => {
    const t = flat(renderSkill('task', context(setting, ['claude']), 'claude'));
    for (const c of ['`harness intake show [id]`', '`harness brief [id]`', '`harness intake list`']) assert.ok(t.includes(c), c);
    assert.match(t, /No other brief command exists/);
  });

  test(`${setting}: the skill says up front that compound shell commands are refused`, () => {
    const text = renderSkill('task', context(setting, ['claude']), 'claude');
    const t = flat(text);
    assert.match(t, /opaque-command rail refuses compound commands: `a && b`, `a; b`, a pipe into a second command, and subshells/);
    assert.ok(text.indexOf('opaque-command rail') < text.indexOf('## The phases at a glance'), 'said before the phases');
  });

  test(`${setting}: the skill has a line each for green-at-base, --db-unreachable, --expect-header, --unattended and --all-recommended`, () => {
    const t = flat(renderSkill('task', context(setting, ['claude']), 'claude'));
    assert.match(t, /green-at-base/);
    assert.match(t, /`harness verify launch --db-unreachable`/);
    assert.match(t, /`harness verify drive --expect-header "Name=value"`/);
    if (setting === 'team') {
      assert.match(t, /`harness intake --from <file> --unattended`/);
      assert.match(t, /`harness intake answer <id> --all-recommended`/);
    }
  });

  test(`${setting}: the skill says the gate writes the write-up and the agent only reads and reports it`, () => {
    const t = flat(renderSkill('task', context(setting, ['claude']), 'claude'));
    assert.match(t, /The gate writes the write-up itself at the end of every full run/);
    assert.match(t, /Your last step is to read that file and report it to the user; do not write it yourself/);
  });
}

const TEAM_BUDGET = 2858; // measured with the paths normalised
const PERSONAL_BUDGET = 2516;
test('the always-on file stays within its byte budget and does not carry the skill detail', () => {
  for (const setting of SETTINGS) {
    const ctx = context(setting, ['claude']);
    const f = renderAlwaysOnFile(ctx, ['claude'], null);
    // Machine paths (the package root, the workspace, the home) are replaced by fixed placeholders so the
    // measure does not depend on where the tool is installed; measured before this change (claude).
    const norm = [ctx.packageRoot, ctx.workspaceRoot, ctx.userHome, ctx.harnessHome].filter(Boolean).reduce((t, p) => t.split(p as string).join('<path>'), f.text);
    const limit = setting === 'team' ? TEAM_BUDGET : PERSONAL_BUDGET;
    assert.ok(Buffer.byteLength(norm) <= limit, `${setting}: ${Buffer.byteLength(norm)} bytes (limit ${limit})`);
    assert.doesNotMatch(f.text, /--db-unreachable|--expect-header|--all-recommended/);
  }
});
