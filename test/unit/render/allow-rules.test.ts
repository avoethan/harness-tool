/**
 * The rendered allow rules cover every task-time harness command the skills
 * name, in both spellings the team setting tells the agent to use
 * (`harness ...`, and `node "<cli.js>" ...` when harness is not on PATH), and
 * the one-test command of each repo by its part before the placeholder.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { allRepoFacts, verificationArgv, TASK_TIME_HARNESS, type RepoFacts } from '../../../src/render/model';
import { permissionOptions } from '../../../src/render/permissions';
import { context } from './helpers';
import { buildPermissions } from '../../../src/guard/permissions';
import { HARNESS_ADMIN_FLAGS, HARNESS_ADMIN_SECOND, HARNESS_ADMIN_SUBS } from '../../../src/guard/rails';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLI = '/opt/harness/dist/src/cli.js';

function facts(): RepoFacts[] {
  return [
    {
      id: 'svc-a', name: 'svc-a', path: '/w/svc-a', relPath: 'svc-a', pm: 'npm', slow: [], verify: 'npm test', packages: [],
      commands: { build: 'npm run build', typecheck: 'npm run typecheck', lint: 'npm run lint', format: 'npm run format:check', test: 'npm test', oneTest: 'npx vitest run <file>' },
    } as RepoFacts,
  ];
}

/** Claude Code's prefix semantics for `Bash(<cmd>)` and `Bash(<cmd> *)` rules. */
function claudeAllows(allow: string[], cmd: string): boolean {
  return allow.some((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return false;
    const body = m[1];
    if (body.endsWith(' *')) return cmd.startsWith(body.slice(0, -1));
    return cmd === body;
  });
}

function isAdmin(cmd: string): boolean {
  const words = cmd.split(/\s+/).slice(1);
  const pos = words.filter((w) => !w.startsWith('-'));
  if (HARNESS_ADMIN_SUBS.has(pos[0] ?? '')) return true;
  if (HARNESS_ADMIN_SECOND[pos[0] ?? '']?.has(pos[1] ?? '')) return true;
  return words.some((w) => HARNESS_ADMIN_FLAGS.has(w.split('=')[0]));
}

/** Every `harness ...` command a skill names, in code spans or code blocks, placeholders filled. */
function skillCommands(skill: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, 'templates', 'skills', skill, 'SKILL.md'), 'utf8');
  const out = new Set<string>();
  const add = (raw: string) => {
    const c = raw.replace(/\{\{[^}]*\}\}/g, '').replace(/#.*$/, '').replace(/<[^>]*>/g, 'x').replace(/\s+/g, ' ').trim();
    if (/^harness [a-z]/.test(c)) out.add(c.replace(/ \[.*$/, '').replace(/\s*\.\.\.$/, ''));
  };
  for (const m of text.matchAll(/`(harness [^`]+)`/g)) add(m[1]);
  for (const block of text.matchAll(/```\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) add(line);
  return [...out];
}

test('verificationArgv lists the task-time commands the skills and the runner name', () => {
  const v = verificationArgv(facts()).map((w) => w.join(' '));
  for (const c of ['harness land', 'harness run check-stop', 'harness learn prove', 'harness learn stats', 'harness learn --scan', 'harness status', 'harness judgment submit', 'harness verify', 'harness db candidates']) {
    assert.ok(v.includes(c), `missing ${c}`);
  }
  // a prefix covers every longer command: verify env|map are covered by `harness verify`
  assert.ok(!v.includes('harness verify env') && !v.includes('harness verify map'), 'no redundant longer prefixes');
  // the one-test command is allowed by the part before its placeholder
  assert.ok(v.includes('npx vitest run'));
  assert.ok(!v.some((c) => c.includes('<')), 'no placeholder reaches a rule');
  // no admin command is ever allowed
  for (const c of v.filter((x) => x.startsWith('harness '))) assert.ok(!isAdmin(c), `admin command allowed: ${c}`);
});

test('a one-word prefix or a shell operator never becomes an allow rule', () => {
  const f = facts();
  f[0].commands.oneTest = 'npx <runner> <file>';
  f[0].commands.lint = 'npm run lint && rm -rf /';
  const v = verificationArgv(f).map((w) => w.join(' '));
  assert.ok(!v.includes('npx'), 'one word before a placeholder is too broad');
  assert.ok(!v.some((c) => c.includes('&&') || c.includes('rm -rf')));
});

test('team setting: every harness command is also allowed as node "<cli.js>" (quoted the way the CLI note prints it) and bare (as agents also type it)', () => {
  const p = buildPermissions({ setting: 'team', protectedRoots: ['/home/u/.harness'], verificationAllow: verificationArgv(facts(), CLI) });
  for (const sub of TASK_TIME_HARNESS) {
    assert.ok(p.claude.allow.includes(`Bash(node "${CLI}" ${sub} *)`), `claude ${sub}`);
    assert.ok(p.claude.allow.includes(`Bash(node ${CLI} ${sub} *)`), `claude bare ${sub}`);
    assert.ok(p.devin.allow.includes(`Exec(node "${CLI}" ${sub})`), `devin ${sub}`);
    assert.ok(p.devin.allow.includes(`Exec(node ${CLI} ${sub})`), `devin bare ${sub}`);
    const pat = ['node', CLI, ...sub.split(' ')].map((w) => JSON.stringify(w)).join(', ');
    assert.ok(p.codex.rules.some((r) => r.startsWith(`prefix_rule(pattern=[${pat}], decision="allow"`)), `codex ${sub}`);
  }
  assert.ok(claudeAllows(p.claude.allow, `node "${CLI}" gate --task t-1`));
  // integration run 2026-10-19: the agent typed the path bare and the quoted rule alone did not cover it
  assert.ok(claudeAllows(p.claude.allow, `node ${CLI} phase tests`));
  assert.ok(!claudeAllows(p.claude.allow, `node ${CLI} install --yes`), 'admin commands stay out in either spelling');
  // a path with a space has no bare spelling (the shell would split it)
  const spaced = buildPermissions({ setting: 'team', protectedRoots: ['/home/u/.harness'], verificationAllow: verificationArgv(facts(), '/opt/my tools/harness/dist/src/cli.js') });
  assert.ok(spaced.claude.allow.includes('Bash(node "/opt/my tools/harness/dist/src/cli.js" gate *)'));
  assert.ok(!spaced.claude.allow.some((r) => r.startsWith('Bash(node /opt/my tools')));
  // without a CLI path (personal setting: committed settings carry no machine path) there is no node rule
  const personal = buildPermissions({ setting: 'personal', protectedRoots: ['/home/u/.harness'], verificationAllow: verificationArgv(facts()) });
  assert.ok(!personal.claude.allow.some((r) => r.includes('cli.js')));
});

test('every non-admin harness command in the task and learn skills, and judgment submit, is allowed unattended', () => {
  const p = buildPermissions({ setting: 'team', protectedRoots: ['/home/u/.harness'], verificationAllow: verificationArgv(facts(), CLI) });
  const cmds = [...skillCommands('task'), ...skillCommands('learn'), ...skillCommands('setup').filter((c) => c.startsWith('harness judgment '))];
  assert.ok(cmds.length >= 20, `found ${cmds.length} commands`);
  assert.ok(cmds.includes('harness verify env'), 'the task skill names verify env');
  assert.ok(cmds.some((c) => c.startsWith('harness judgment submit')), 'the setup skill names judgment submit');
  // `harness run` is named only as the user's driver that may have started the session, never run by the agent
  const missing = cmds.filter((c) => c !== 'harness run' && !isAdmin(c) && !claudeAllows(p.claude.allow, c));
  assert.deepEqual(missing, []);
  // and the admin ones are not allowed by any rule
  const admin = cmds.filter((c) => isAdmin(c));
  assert.ok(admin.length >= 2, 'the skills name the admin commands they hand over');
  for (const c of admin) assert.ok(!claudeAllows(p.claude.allow, c), `admin command allowed: ${c}`);
});

test('personal setting: committing on the task branch is allowed unattended (the runner asks for it); the team setting asks', () => {
  const rules = (setting: 'team' | 'personal') => {
    const ctx = context(setting, ['claude']);
    return buildPermissions(permissionOptions(ctx, allRepoFacts(ctx))).claude;
  };
  const personal = rules('personal');
  assert.ok(claudeAllows(personal.allow, 'git add src/cli/format.ts test/unit/cli/format.test.ts'));
  assert.ok(claudeAllows(personal.allow, 'git commit -m "feat(cli): expiry wording"'));
  assert.ok(claudeAllows(personal.allow, 'git mv test/unit/migrations.test.ts test/unit/db.test.ts'), 'personal: a tracked rename is allowed');
  assert.ok(claudeAllows(personal.allow, 'git revert --no-edit dddc0c0'), 'personal: a revert commit is allowed');
  const team = rules('team');
  assert.ok(!claudeAllows(team.allow, 'git commit -m x'), 'team: unchanged');
  assert.ok(!claudeAllows(team.allow, 'git mv a b'), 'team: no git mv rule');
  assert.ok(!claudeAllows(team.allow, 'git revert HEAD'), 'team: no git revert rule');
  // the rails stay: deny rules beat allow rules in Claude Code
  assert.ok(personal.deny.some((r) => /^Bash\(git push --force/.test(r)), 'force-push still denied');
});

test('a read-only database adds no allow rule: no rendered rule pre-approves a database command, the hook decides', () => {
  const dbCommands = [
    'sqlcmd -S sqlro -d reports -Q "SELECT 1"',
    'sqlcmd -S sqlro -d reports -Q "DELETE FROM t"',
    'osql -S sqlro -d reports -Q "SELECT 1"',
    'bcp dbo.t in t.dat -S sqlro -d reports',
    'Invoke-Sqlcmd -ServerInstance sqlro -Database reports -Query "SELECT 1"',
    'mssql-cli -S sqlro -d reports -Q "SELECT 1"',
  ];
  const clients = /\b(sqlcmd|osql|bcp|invoke-sqlcmd|mssql-cli|sqlpackage|psql|mysql)\b/i;
  for (const setting of ['team', 'personal'] as const) {
    const ctx = context(setting, ['claude', 'devin', 'codex']);
    ctx.config = { ...ctx.config!, db: { allowlist: [{ server: 'sqlro', database: 'reports', marked: 'read-only' }, { server: 'sql-test', marked: 'test' }] } };
    const p = buildPermissions(permissionOptions(ctx, allRepoFacts(ctx)));
    for (const c of dbCommands) assert.ok(!claudeAllows(p.claude.allow, c), `${setting}: a Claude allow rule pre-approves ${c}`);
    assert.deepEqual(p.claude.allow.filter((r) => clients.test(r)), [], `${setting}: Claude`);
    assert.deepEqual(p.devin.allow.filter((r) => clients.test(r)), [], `${setting}: Devin`);
    assert.deepEqual(p.codex.rules.filter((r) => clients.test(r) && /decision="allow"/.test(r)), [], `${setting}: Codex`);
    // Devin keeps asking for every client; the hook still decides.
    assert.ok(p.devin.ask.some((r) => /sqlcmd/.test(r)));
  }
});
