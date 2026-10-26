import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { evaluate } from '../../../src/guard';

const base = {
  agent: 'claude' as const,
  setting: 'team' as const,
  env: {},
  config: { db: { allowlist: [{ server: 'localhost,1433', marked: 'test' as const }] }, mcp: { allowedServers: {} } },
  protectedRoots: ['/tmp/hh'],
};

function run(command: string, setting: 'team' | 'personal' = 'team') {
  return evaluate({ ...base, setting, toolName: 'Bash', toolInput: { command } });
}

const DENY = [
  'harness install --setting team',
  'harness apply --plan p1',
  'harness undo',
  'harness uninstall --yes',
  'harness self-update',
  'harness config set caps.turns 200',
  'harness db mark --server prod-db --test',
  'harness db unmark --server localhost,1433',
  'harness learn review --approve l1',
  'harness learn --scan --approve l1',
  'harness selfcheck probe-files --agent devin',
  'harness selfcheck record --agent devin --step 1 --result ok',
  'harness selfcheck record --agent codex --step 7 --result "pass: blocked" --outcome expected',
  'harness selfcheck probe-mode --agent devin --stop off',
  'harness selfcheck probe-mode --agent devin --stop block',
  'harness selfcheck probe-hook Stop --agent devin',
  'harness selfcheck probe-log --agent devin --clear',
  'node /opt/tools/harness/dist/src/cli.js selfcheck record --agent devin --step 2 --result pass',
  'bash -c "harness selfcheck probe-mode --agent devin --stop slow"',
  'harness pr open',
  'harness pr open --dry-run',
  'harness pr',
  'harness jira comment',
  'harness jira create --yes',
  'harness jira create --dry-run',
  'bash -c "harness jira comment --dry-run"',
  'node /opt/tools/harness/dist/src/cli.js pr open --task T-003',
  'bash -c "harness pr open --dry-run"',
  'harness gate --from-install',
  'harness land --ci local --ci-command "npm run ci"',
  'harness run --once --ci-command=node ci.js',
  'npx harness apply --plan p1',
  'harness.cmd apply --plan p1',
  'node /opt/tools/harness/dist/src/cli.js apply --plan p1',
  'node "C:/Users/me/harness/dist/src/cli.js" db mark --server x --test',
  '/opt/tools/harness/bin/harness install --setting personal --yes',
  'cd /repo && harness apply --plan p1',
  'bash -c "harness apply --plan p1"',
  // Red-team: node options that take a separate-token value shift the script
  // past "the first non-flag argument"; the CLI path is still found.
  'node -C dev /opt/tools/harness/dist/src/cli.js uninstall',
  'node --conditions dev /opt/tools/harness/dist/src/cli.js uninstall',
  'node -r /tmp/pre.js /opt/tools/harness/dist/src/cli.js apply --plan p1',
  'node --import /tmp/pre.mjs /opt/tools/harness/dist/src/cli.js undo',
  'node --loader ts-node/esm /opt/tools/harness/dist/src/cli.js self-update',
  // Red-team: `npx <this package name>` resolves to the harness CLI.
  'npx agent-harness uninstall',
  'npx --no-install agent-harness config set setting personal',
  // The start snapshot: re-recording it after the agent's own edits would hide them from the gate.
  'harness task snapshot',
  'harness task snapshot --task T-003',
  'harness task snapshot --repo . --task T-003',
  'harness task --repo . snapshot',
  'harness db --server prod-db mark --test',
  'harness task --task T-003 snapshot --json',
  'node /opt/tools/harness/dist/src/cli.js task snapshot --task T-003',
  'bash -c "harness task snapshot"',
];

const ALLOW = [
  'harness intake --jira SHOP-102',
  'harness intake --jira-next',
  'harness gate',
  'harness verify launch',
  'harness discover',
  'harness assess --workspace .',
  'harness propose',
  'harness db list',
  'harness db candidates',
  'harness config get',
  'harness learn --scan',
  'harness learn stats',
  'harness intake --from -',
  'harness task next',
  'harness task claim T-003 --by claude',
  'harness task list --status todo',
  'harness writeup',
  'harness phase tests',
  'harness selfcheck',
  'harness selfcheck list --agent devin',
  'harness selfcheck probe-log --agent devin',
  'harness selfcheck probe-log --agent devin --json',
  'harness report --md',
  'harness doctor',
  'node /opt/tools/harness/dist/src/cli.js gate',
  'node dist/src/cli.js status',
];

test('harness admin commands are denied from agent tool calls', () => {
  for (const c of DENY) {
    const d = run(c);
    assert.equal(d.decision, 'deny', `expected deny: ${c} -> ${d.rail}: ${d.reason}`);
    assert.equal(d.rail, 'harness-admin', `wrong rail for ${c}: ${d.rail}`);
    assert.match(d.reason, /ask the user to run: harness /);
  }
  for (const c of DENY) {
    const d = run(c, 'personal');
    assert.equal(d.decision, 'deny', `expected deny in personal: ${c}`);
  }
});

test('ordinary harness commands stay allowed', () => {
  for (const c of ALLOW) {
    const d = run(c);
    assert.equal(d.decision, 'allow', `expected allow: ${c} -> ${d.rail}: ${d.reason}`);
  }
});

test('harness with its arguments from stdin is denied (the subcommand is unreadable)', () => {
  // Red-team: `... | xargs harness` would run e.g. `harness uninstall` with the
  // subcommand supplied from stdin, which the guard cannot read, so it must
  // fail closed rather than let a hidden admin command through.
  for (const c of ['echo uninstall | xargs harness', 'echo apply | xargs -I{} harness {} --plan p1', 'printf uninstall | xargs harness --json']) {
    const d = run(c);
    assert.equal(d.decision, 'deny', `expected deny: ${c} -> ${d.rail}: ${d.reason}`);
    assert.equal(d.rail, 'harness-admin', `wrong rail for ${c}: ${d.rail}`);
    assert.match(d.reason, /from stdin/);
  }
  // A read-only command written out literally still runs.
  assert.equal(run('harness status').decision, 'allow');
});

test('self-check evidence commands are the user\'s: record, probe-mode, probe-hook, probe-log --clear', () => {
  for (const c of ['harness selfcheck record --agent devin --step 3 --result pass', 'harness selfcheck probe-mode --agent devin --stop block', 'harness selfcheck probe-log --agent codex --clear']) {
    for (const agent of ['claude', 'codex', 'devin'] as const) {
      const d = evaluate({ ...base, agent, toolName: agent === 'devin' ? 'exec' : 'Bash', toolInput: { command: c } });
      assert.equal(d.decision, 'deny', `${agent}: ${c}`);
      assert.equal(d.rail, 'harness-admin');
    }
  }
});

test('harness task snapshot is the user\'s for Claude, Codex and Devin; the other task subcommands stay the agent\'s', () => {
  for (const c of ['harness task snapshot', 'harness task snapshot --task T-1', 'harness task --repo . snapshot']) {
    for (const agent of ['claude', 'codex', 'devin'] as const) {
      const d = evaluate({ ...base, agent, toolName: agent === 'devin' ? 'exec' : 'Bash', toolInput: { command: c } });
      assert.equal(d.decision, 'deny', `${agent}: ${c}`);
      assert.equal(d.rail, 'harness-admin');
    }
  }
  const { buildPermissions } = require('../../../src/guard/permissions') as typeof import('../../../src/guard/permissions');
  const p = buildPermissions({ setting: 'personal', protectedRoots: ['/tmp/hh'] });
  assert.ok(p.claude.deny.includes('Bash(harness task snapshot *)'));
  assert.ok(p.devin.deny.includes('Exec(harness task snapshot)'));
  assert.equal(run('harness task add --title "fix the snapshot export"').decision, 'allow');
});

test('permission rules carry the self-check admin prefixes for every agent', () => {
  const { buildPermissions } = require('../../../src/guard/permissions') as typeof import('../../../src/guard/permissions');
  for (const setting of ['team', 'personal'] as const) {
    const p = buildPermissions({ setting, protectedRoots: ['/tmp/hh'] });
    for (const w of ['record', 'probe-mode', 'probe-hook']) {
      assert.ok(p.claude.deny.includes(`Bash(harness selfcheck ${w} *)`), `claude ${setting} ${w}`);
      assert.ok(p.devin.deny.includes(`Exec(harness selfcheck ${w})`), `devin ${setting} ${w}`);
      assert.ok(p.codex.rules.some((r) => r.includes(`"harness", "selfcheck", "${w}"`) && r.includes('forbidden')), `codex ${setting} ${w}`);
    }
    assert.ok(p.claude.deny.includes('Bash(harness selfcheck probe-log --clear *)'));
  }
});
