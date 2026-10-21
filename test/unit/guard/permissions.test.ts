import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildPermissions, buildPermissionsByRail, codexRulesFile } from '../../../src/guard/permissions';
import { RAILS, GIT_DENY } from '../../../src/guard/rails';

const ROOTS = ['/home/u/.harness', '/home/u/.claude', '/home/u/.codex', '/home/u/.config/devin', '/opt/harness-pkg', '/home/u/.claude.json', 'C:\\Users\\u\\AppData\\Roaming\\devin'];

const CLAUDE_RULE_RE = /^(Bash|Edit|Write|Read|MultiEdit|NotebookEdit)\([^()]+\)$|^mcp__\*$/;
const DEVIN_RULE_RE = /^(Exec|Write|Read)\([^()]+\)$|^mcp__\*$/;
const CODEX_RULE_RE = /^prefix_rule\(pattern=\[("[^"]+"(, )?)+\], decision="(forbidden|allow)"(, justification="[^"]*")?\)$/;

test('every rail has at least one rule per agent (team setting)', () => {
  const by = buildPermissionsByRail({ setting: 'team', protectedRoots: ROOTS });
  for (const rail of RAILS) {
    const r = by[rail.id];
    assert.ok(r, rail.id);
    assert.ok(r.claude.length >= 1, `${rail.id} has no Claude rule`);
    assert.ok(r.devin.length >= 1, `${rail.id} has no Devin rule`);
    assert.ok(r.codex.length >= 1, `${rail.id} has no Codex rule`);
  }
});

test('personal setting: every setting-independent rail has rules; team-only rails are empty', () => {
  const by = buildPermissionsByRail({ setting: 'personal', protectedRoots: ROOTS });
  for (const rail of RAILS) {
    const r = by[rail.id];
    if (rail.settings === 'all') {
      assert.ok(r.claude.length >= 1 && r.devin.length >= 1 && r.codex.length >= 1, rail.id);
    } else {
      assert.equal(r.claude.length + r.devin.length + r.codex.length, 0, `${rail.id} should be empty in personal`);
    }
  }
});

test('Claude rules use the documented syntax', () => {
  const p = buildPermissions({ setting: 'team', protectedRoots: ROOTS, verificationAllow: [['npm', 'test'], ['harness', 'gate']], runsDir: '/home/u/.harness/runs' });
  for (const r of [...p.claude.deny, ...p.claude.allow]) assert.match(r, CLAUDE_RULE_RE, r);
  assert.ok(p.claude.deny.includes('Bash(git push --force *)'));
  assert.ok(p.claude.deny.includes('Bash(git push --force)'));
  assert.ok(p.claude.deny.includes('Bash(git push -f *)'));
  assert.ok(p.claude.deny.includes('Bash(git push *)'));
  assert.ok(p.claude.deny.includes('Bash(git rebase *)'));
  assert.ok(p.claude.deny.includes('Bash(git reset --hard *)'));
  assert.ok(p.claude.deny.includes('Bash(gh pr create *)'));
  assert.ok(p.claude.deny.includes('Edit(//home/u/.claude/**)'));
  assert.ok(p.claude.deny.includes('Write(//home/u/.harness/**)'));
  assert.ok(p.claude.deny.includes('Write(//home/u/.claude.json)'));
  assert.ok(p.claude.deny.includes('Edit(//C:/Users/u/AppData/Roaming/devin/**)'));
  assert.ok(p.claude.deny.includes('Read(**/.env)'));
  assert.ok(p.claude.deny.includes('Read(**/*.pem)'));
  assert.ok(p.claude.deny.includes('Write(.env)'));
  assert.ok(p.claude.deny.includes('Bash(claude --dangerously-skip-permissions *)'));
  assert.ok(p.claude.deny.includes('mcp__*'));
  assert.ok(p.claude.deny.includes('Edit(AGENTS.md)'));
  assert.ok(p.claude.allow.includes('Bash(npm test *)'));
  assert.ok(p.claude.allow.includes('Bash(harness gate)'));
  assert.ok(p.claude.allow.includes('Read(//home/u/.harness/runs/**)'));
  for (const r of p.claude.deny) {
    if (/^(Edit|Write|Read|MultiEdit|NotebookEdit)\(\/\//.test(r)) assert.doesNotMatch(r, /\\/, 'absolute paths use forward slashes: ' + r);
    assert.doesNotMatch(r, /\(\/[^/]/, 'absolute paths start with //: ' + r);
  }
  assert.equal(new Set(p.claude.deny).size, p.claude.deny.length, 'no duplicates');
});

test('Devin rules use Exec/Write/Read with absolute paths', () => {
  const p = buildPermissions({ setting: 'team', protectedRoots: ROOTS, verificationAllow: [['sqlcmd']], runsDir: '/home/u/.harness/runs' });
  for (const r of [...p.devin.deny, ...p.devin.ask, ...p.devin.allow]) assert.match(r, DEVIN_RULE_RE, r);
  assert.ok(p.devin.deny.includes('Exec(git push --force)'));
  assert.ok(p.devin.deny.includes('Exec(git push)'));
  assert.ok(p.devin.deny.includes('Exec(gh pr create)'));
  assert.ok(p.devin.deny.includes('Write(/home/u/.harness/**)'));
  assert.ok(p.devin.deny.includes('Write(/home/u/.claude.json)'));
  assert.ok(p.devin.deny.includes('Write(C:/Users/u/AppData/Roaming/devin/**)'));
  assert.ok(p.devin.deny.includes('Read(**/*.pem)'));
  assert.ok(p.devin.ask.includes('Exec(sqlcmd)'));
  assert.ok(p.devin.allow.includes('Exec(sqlcmd)'));
  assert.ok(p.devin.allow.includes('Read(/home/u/.harness/runs/**)'));
  for (const r of p.devin.deny) if (r.startsWith('Write(/')) assert.doesNotMatch(r, /\\/);
});

test('Codex rules are prefix_rule lines with decision forbidden', () => {
  const p = buildPermissions({ setting: 'team', protectedRoots: ROOTS, verificationAllow: [['npm', 'test']] });
  for (const r of p.codex.rules) assert.match(r, CODEX_RULE_RE, r);
  assert.ok(p.codex.rules.some((r) => r.startsWith('prefix_rule(pattern=["git", "push", "--force"], decision="forbidden"')));
  assert.ok(p.codex.rules.some((r) => r.startsWith('prefix_rule(pattern=["git", "push"], decision="forbidden"')));
  assert.ok(p.codex.rules.some((r) => r.startsWith('prefix_rule(pattern=["git", "rebase"], decision="forbidden"')));
  assert.ok(p.codex.rules.some((r) => r.startsWith('prefix_rule(pattern=["npm", "test"], decision="allow"')));
  const file = codexRulesFile({ setting: 'personal', protectedRoots: ROOTS });
  assert.ok(file.startsWith('#'));
  assert.ok(file.includes('"git", "push", "--force"'));
  assert.ok(!file.includes('"git", "push"], decision="forbidden"'), 'personal setting allows plain push');
});

test('every GIT_DENY spec reaches all three dialects', () => {
  const by = buildPermissionsByRail({ setting: 'team', protectedRoots: ROOTS });
  for (const spec of GIT_DENY) {
    const bucket = by[spec.rail];
    for (const prefix of spec.prefixes) {
      const p = prefix.join(' ');
      assert.ok(bucket.claude.includes(`Bash(${p} *)`), `${spec.id} claude ${p}`);
      assert.ok(bucket.devin.includes(`Exec(${p})`), `${spec.id} devin ${p}`);
      assert.ok(bucket.codex.some((r) => r.includes(prefix.map((w) => JSON.stringify(w)).join(', '))), `${spec.id} codex ${p}`);
    }
  }
});

test('rules never contain setup-specific tokens and are deterministic', () => {
  const a = JSON.stringify(buildPermissions({ setting: 'team', protectedRoots: ROOTS }));
  const b = JSON.stringify(buildPermissions({ setting: 'team', protectedRoots: ROOTS }));
  assert.equal(a, b);
  assert.doesNotMatch(a, /undefined|null/);
});
