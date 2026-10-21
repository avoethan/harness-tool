/**
 * The rendered harness per agent and setting: the always-on size limits,
 * the exact file set, rails in the permission lists, byte-stable hook
 * commands, read_config_from, no tool-specific rule files, and a snapshot of
 * the rendered output (normalised paths).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, Setting } from '../../../src/types';
import { ALWAYS_ON_MAX_BYTES, ALWAYS_ON_MAX_LINES, extractBlock, upsertBlock, removeBlock, type RenderContext } from '../../../src/render/model';
import { renderAlwaysOnBlock, renderAlwaysOnFile } from '../../../src/render/alwayson';
import { renderHarness } from '../../../src/render/index';
import { hookCommand, hookSpecs, hooksFragment } from '../../../src/render/hooks';
import { codexConfigFile, codexSandboxEdit, portableClaudeRule, permissionOptions, renderPermissions } from '../../../src/render/permissions';
import { buildPermissionsByRail } from '../../../src/guard/permissions';
import { RAILS, type RailId } from '../../../src/guard/rails';
import { allRepoFacts } from '../../../src/render/model';
import { applyConditionals, renderSkill, SKILL_NAMES } from '../../../src/render/skills';
import { parseFrontMatter } from '../../../src/lib/frontmatter';
import { sha256 } from '../../../src/lib/hash';
import { context, hugeContext, tmpRoot } from './helpers';

const SETTINGS: Setting[] = ['team', 'personal'];
const AGENT_SETS: AgentId[][] = [['devin'], ['claude'], ['codex'], ['devin', 'claude', 'codex']];

function rel(ctx: RenderContext, p: string): string {
  const h = path.relative(ctx.userHome, p);
  if (!h.startsWith('..')) return '~/' + h.split(path.sep).join('/');
  return '<repo>/' + path.relative(ctx.repoRoot ?? ctx.workspaceRoot, p).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// always-on size limits
// ---------------------------------------------------------------------------

test('always-on block stays within 60 harness-owned lines and 4 KB even with a huge ledger and many repos', () => {
  for (const setting of SETTINGS) {
    for (const agents of AGENT_SETS) {
      const ctx = hugeContext(setting, agents);
      const b = renderAlwaysOnBlock(ctx, agents);
      assert.ok(b.lines <= ALWAYS_ON_MAX_LINES, `${setting}/${agents}: ${b.lines} lines`);
      assert.ok(b.bytes <= ALWAYS_ON_MAX_BYTES, `${setting}/${agents}: ${b.bytes} bytes`);
      assert.ok(b.dropped.length > 0, 'something had to be left out');
      assert.match(b.body, /more standards/);
      // the essentials always stay
      assert.match(b.body, /`task` skill/);
      assert.match(b.body, /### Never/);
      assert.match(b.body, /Skills: `task`/);
      const file = renderAlwaysOnFile(ctx, agents, null);
      assert.ok(Buffer.byteLength(file.text) <= ALWAYS_ON_MAX_BYTES, `${setting}/${agents}: whole file ${Buffer.byteLength(file.text)} bytes`);
      assert.equal(file.over, undefined);
    }
  }
});

test('always-on file budget counts the user text; the user text is kept verbatim; over the limit only because of user text is reported', () => {
  const ctx = context('team', ['claude']);
  const user = '# My notes\n\n' + Array.from({ length: 20 }, (_, i) => `- My own rule number ${i}, kept as I wrote it.`).join('\n') + '\n';
  const f = renderAlwaysOnFile(ctx, ['claude'], user);
  assert.ok(f.text.startsWith(user.trimEnd()), 'user text first, unchanged');
  assert.ok(f.bytes <= ALWAYS_ON_MAX_BYTES, `${f.bytes} bytes`);
  assert.equal(f.over, undefined);
  const big = '# Long\n\n' + 'x'.repeat(3900) + '\n';
  const g = renderAlwaysOnFile(ctx, ['claude'], big);
  assert.ok(g.text.includes('x'.repeat(3900)), 'user text never cut');
  assert.ok(g.block.lines <= ALWAYS_ON_MAX_LINES);
  assert.match(g.over ?? '', /your own text/);
  // the rails survive in their compact form
  assert.match(g.block.body, /Rails \(hard blocks\)|\| Done = `harness gate`/);
});

test('marker blocks: upsert replaces in place, keeps the user text, and removeBlock undoes an append', () => {
  const user = '# Mine\n\nline one\n';
  const a = upsertBlock(user, 'first', 'md', 'end');
  assert.equal(extractBlock(a, 'md'), 'first');
  const b = upsertBlock(a, 'second', 'md', 'end');
  assert.equal(extractBlock(b, 'md'), 'second');
  assert.ok(b.startsWith(user.trimEnd()));
  assert.equal(removeBlock(b, 'md').trimEnd(), user.trimEnd());
  const top = upsertBlock('existing\n', '@AGENTS.md', 'md', 'start');
  assert.ok(top.indexOf('@AGENTS.md') < top.indexOf('existing'));
  const crlf = upsertBlock('a\r\nb\r\n', 'x', 'hash', 'end');
  assert.ok(!/[^\r]\n/.test(crlf), 'CRLF files stay CRLF');
});

// ---------------------------------------------------------------------------
// exact file paths per agent and setting
// ---------------------------------------------------------------------------

function expected(setting: Setting, agents: AgentId[]): string[] {
  const out: string[] = [];
  const skills = (dir: string) => ['task', 'learn', 'setup'].map((s) => `${dir}/${s}/SKILL.md`);
  if (setting === 'team') {
    for (const a of agents) {
      if (a === 'devin') out.push('~/.config/devin/AGENTS.md', '~/.config/devin/config.json', '~/.devin/rules/alpha.md', '~/.devin/rules/beta.md', '~/.devin/rules/beta-packages-api.md');
      if (a === 'claude') out.push('~/.claude/CLAUDE.md', '~/.claude/settings.json', ...skills('~/.claude/skills'), '~/.claude/rules/alpha.md', '~/.claude/rules/beta.md', '~/.claude/rules/beta-packages-api.md');
      if (a === 'codex') out.push('~/.codex/AGENTS.md', '~/.codex/hooks.json', '~/.codex/rules/harness.rules', '~/.codex/config.toml');
    }
    if (agents.includes('devin') || agents.includes('codex')) out.push(...skills('~/.agents/skills'));
  } else {
    out.push('<repo>/AGENTS.md', '<repo>/.harness/config.json', '<repo>/tasks/README.md', '<repo>/.github/workflows/harness-gate.yml', '<repo>/.gitignore');
    for (const a of agents) {
      if (a === 'devin') out.push('<repo>/.devin/config.json', '<repo>/.devin/rules/standards.md', '<repo>/.devin/rules/standards-packages-api.md');
      if (a === 'claude') out.push('<repo>/CLAUDE.md', '<repo>/.claude/settings.json', ...skills('<repo>/.claude/skills'), '<repo>/.claude/rules/standards.md', '<repo>/.claude/rules/standards-packages-api.md');
      if (a === 'codex') out.push('<repo>/.codex/hooks.json', '<repo>/.codex/rules/harness.rules', '~/.codex/config.toml', '<repo>/packages/api/AGENTS.md');
    }
    if (agents.includes('devin') || agents.includes('codex')) out.push(...skills('<repo>/.agents/skills'));
  }
  return [...new Set(out)].sort();
}

test('rendered file paths per agent and setting are exactly the documented ones (no git repo here, so no git hooks)', () => {
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    for (const setting of SETTINGS) {
      for (const agents of AGENT_SETS) {
        const ctx = context(setting, agents);
        const r = renderHarness(ctx);
        const got = [...new Set(r.files.map((f) => rel(ctx, f.path)))].sort();
        assert.deepEqual(got, expected(setting, agents), `${setting} ${agents.join('+')}`);
        for (const f of r.files) assert.ok(path.isAbsolute(f.path));
        // never a tool-specific rule file
        for (const f of r.files) assert.doesNotMatch(path.basename(f.path), /^(\.windsurfrules|\.cursorrules|\.clinerules|GEMINI\.md|copilot-instructions\.md)$/);
        if (setting === 'personal') assert.ok(r.notes.some((n) => /not a git repository/.test(n)), 'git hooks are skipped with a note outside a git repo');
      }
    }
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
  }
});

test('rendered output snapshot (normalised paths) is stable', () => {
  if (process.platform === 'win32') return;
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const snap: Record<string, Record<string, string>> = {};
    for (const setting of SETTINGS) {
      for (const agents of AGENT_SETS) {
        const ctx = context(setting, agents);
        const r = renderHarness(ctx);
        const norm = (s: string) => s.split(ctx.packageRoot.split(path.sep).join('/')).join('<PKG>').split(path.dirname(ctx.userHome)).join('<ROOT>');
        const m: Record<string, string> = {};
        for (const f of r.files.sort((a, b) => a.path.localeCompare(b.path))) m[rel(ctx, f.path)] = sha256(`${f.kind}\n${norm(f.content)}`).slice(0, 16);
        snap[`${setting}:${agents.join('+')}`] = m;
      }
    }
    const file = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'render', 'snapshot.json');
    if (process.env.UPDATE_SNAPSHOTS === '1' || !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
    }
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(snap, want, 'rendered output changed: if intended, run the tests with UPDATE_SNAPSHOTS=1 and review the diff of test/fixtures/render/snapshot.json');
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
  }
});

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

test('hook commands are byte-stable, absolute, quoted, forward slashes, with explicit timeouts per event', () => {
  const pkg = 'C:\\Users\\someone\\harness';
  for (const agent of ['devin', 'claude', 'codex'] as AgentId[]) {
    const a = JSON.stringify(hooksFragment(agent, pkg));
    const b = JSON.stringify(hooksFragment(agent, pkg));
    assert.equal(a, b);
    for (const spec of hookSpecs(agent)) {
      const cmd = hookCommand(pkg, spec.event, agent);
      assert.equal(cmd, `node "C:/Users/someone/harness/dist/src/hook.js" ${spec.event} --agent ${agent}`);
      assert.doesNotMatch(cmd, /\\/);
      const want = spec.event === 'PreToolUse' ? 20 : spec.event === 'PostToolUse' ? 25 : ['Stop', 'SubagentStop', 'TaskCompleted'].includes(spec.event) ? 5 : agent === 'codex' && spec.event === 'SessionEnd' ? 3 : 20;
      assert.equal(spec.timeout, want, `${agent} ${spec.event}`);
    }
  }
  const events = (agent: AgentId) => [...new Set(hookSpecs(agent).map((s) => s.event))].sort();
  assert.deepEqual(events('claude'), ['PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'TaskCompleted', 'UserPromptSubmit']);
  assert.deepEqual(events('codex'), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.deepEqual(events('devin'), ['PostCompaction', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  // matchers: shell and edit tools for PostToolUse; every tool (MCP) reaches the guard
  const m = (agent: AgentId, ev: string) => hookSpecs(agent).filter((s) => s.event === ev).map((s) => s.matcher);
  assert.deepEqual(m('claude', 'PreToolUse'), ['Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch', '*']);
  assert.deepEqual(m('codex', 'PreToolUse'), ['Bash|Edit|Write|MultiEdit|apply_patch', '.*']);
  assert.deepEqual(m('devin', 'PreToolUse'), ['^(exec|edit|write|read|mcp__.*)$']);
  assert.ok(m('claude', 'PostToolUse')[0]!.includes('Bash'));
  assert.equal(m('devin', 'PostToolUse')[0], '^(exec|edit|write)$');
});

test('rendering twice gives identical bytes for every file', () => {
  for (const setting of SETTINGS) {
    const root = tmpRoot();
    const a = renderHarness(context(setting, ['devin', 'claude', 'codex'], root));
    const b = renderHarness(context(setting, ['devin', 'claude', 'codex'], root));
    assert.deepEqual(a.files.map((f) => [f.path, f.content]), b.files.map((f) => [f.path, f.content]));
  }
});

// ---------------------------------------------------------------------------
// permissions and settings edits
// ---------------------------------------------------------------------------

test('permission lists contain every rail of the setting (Claude deny, Devin deny/ask, Codex rules)', () => {
  for (const setting of SETTINGS) {
    const ctx = context(setting, ['devin', 'claude', 'codex']);
    const facts = allRepoFacts(ctx);
    const p = renderPermissions(ctx, facts);
    const byRail = buildPermissionsByRail(permissionOptions(ctx, facts));
    const claudeDeny = new Set(p.rules.claude.deny);
    const devin = new Set([...p.rules.devin.deny, ...p.rules.devin.ask]);
    for (const rail of RAILS) {
      if (rail.settings !== 'all' && !rail.settings.includes(setting)) continue;
      const r = byRail[rail.id as RailId];
      if (rail.id !== 'staging' && rail.id !== 'phase-tests') {
        for (const x of r.claude) assert.ok(claudeDeny.has(setting === 'personal' ? portableClaudeRule(x, ctx.userHome, ctx.repoRoot) : x), `${setting}: claude deny lacks ${x} (${rail.id})`);
        for (const x of r.codex) assert.ok(p.codexRules.includes(x), `${setting}: codex rules lack ${x} (${rail.id})`);
      }
      for (const x of r.devin) assert.ok(devin.has(x), `${setting}: devin lacks ${x} (${rail.id})`);
      const hasAny = r.claude.length + r.devin.length + r.codex.length > 0;
      if (!['outbound', 'opaque', 'internal'].includes(rail.id)) assert.ok(hasAny || rail.id === 'staging' || rail.id === 'phase-tests', `${setting}: rail ${rail.id} renders nothing`);
    }
    // the protected roots are absolute (team) or home-relative (personal, committed)
    const protect = p.rules.claude.deny.filter((x) => /^(Edit|Write)\((\/\/|~\/)/.test(x) && x.includes('.harness'));
    assert.ok(protect.length, 'harness state is protected');
    for (const x of protect) assert.match(x, setting === 'team' ? /^(Edit|Write)\(\/\// : /^(Edit|Write)\(~\//);
    if (setting === 'personal') {
      assert.ok(p.rules.claude.deny.includes('Edit(.harness/**)'), 'in-repo harness folder protected without a machine path');
      assert.ok(!p.rules.claude.deny.some((x) => /^(Edit|Write|Read)\(\/\//.test(x) && x.includes(ctx.repoRoot!)), 'no absolute repo path in a committed settings file');
    }
    // verification commands are allowed, reads of the runs folder too
    assert.ok(p.rules.claude.allow.includes('Bash(npm test)'));
    assert.ok(p.rules.claude.allow.some((x) => /^Read\(.*runs\/\*\*\)$/.test(x)));
    assert.ok(p.rules.devin.allow.includes('Exec(harness gate)'));
  }
});

test('read_config_from.claude is false only when Devin and Claude are both targeted; attribution off in the team setting', () => {
  for (const setting of SETTINGS) {
    for (const agents of [['devin'], ['devin', 'claude'], ['devin', 'codex'], ['devin', 'claude', 'codex']] as AgentId[][]) {
      const ctx = context(setting, agents);
      const r = renderHarness(ctx);
      const devin = r.files.find((f) => f.agent === 'devin' && f.kind === 'json');
      assert.ok(devin, 'devin config fragment');
      const frag = JSON.parse(devin!.content);
      if (agents.includes('claude')) assert.deepEqual(frag.read_config_from, { claude: false }, `${setting} ${agents}`);
      else assert.equal(frag.read_config_from, undefined, `${setting} ${agents}`);
      assert.equal(frag.attribution, setting === 'team' ? false : undefined);
    }
    const c = renderHarness(context(setting, ['claude'])).files.find((f) => f.agent === 'claude' && f.kind === 'json')!;
    const cf = JSON.parse(c.content);
    assert.deepEqual(cf.attribution, setting === 'team' ? { commit: '', pr: '' } : undefined);
  }
});

test('the user\'s own deny/ask rules are translated into every agent\'s dialect', () => {
  const ctx = context('team', ['devin', 'claude', 'codex']);
  const p = renderPermissions(ctx, allRepoFacts(ctx), [
    { source: '/x/settings.json', kind: 'deny-rule', text: 'Bash(terraform apply *)' },
    { source: '/x/config.json', kind: 'ask-rule', text: 'Exec(kubectl delete)' },
    { source: '/x/a.rules', kind: 'deny-rule', text: 'npm publish (forbidden)' },
    { source: '/x/settings.json', kind: 'deny-rule', text: 'Bash(rm -rf * --no-preserve-root)' },
  ]);
  assert.ok(p.rules.claude.deny.includes('Bash(terraform apply)'));
  assert.ok(p.rules.devin.deny.includes('Exec(terraform apply)'));
  assert.ok(p.codexRules.includes('prefix_rule(pattern=["terraform", "apply"], decision="forbidden"'));
  assert.ok(p.claudeAsk.includes('Bash(kubectl delete *)'));
  assert.ok(p.rules.devin.ask.includes('Exec(kubectl delete)'));
  assert.ok(p.rules.devin.deny.includes('Exec(npm publish)'));
  const wild = p.promoted.find((x) => x.from.text.includes('--no-preserve-root'));
  assert.match(wild?.note ?? '', /not a plain command prefix/);
});

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

test('skills: only name and description in front matter; Claude gets disable-model-invocation for learn and setup; task skill stays under 500 lines', () => {
  for (const setting of SETTINGS) {
    const ctx = context(setting, ['devin', 'claude', 'codex']);
    for (const name of SKILL_NAMES) {
      for (const agent of ['devin', 'claude', 'codex'] as AgentId[]) {
        const text = renderSkill(name, ctx, agent);
        const fm = parseFrontMatter(text);
        const keys = Object.keys(fm.data).sort();
        const wantClaudeExtra = agent === 'claude' && name !== 'task';
        assert.deepEqual(keys, wantClaudeExtra ? ['description', 'disable-model-invocation', 'name'] : ['description', 'name'], `${setting} ${name} ${agent}`);
        assert.equal(fm.data.name, name);
        assert.ok(String(fm.data.description).length > 40 && String(fm.data.description).length <= 1024);
        assert.doesNotMatch(text, /\{\{[#/A-Z]/, 'no template markers left');
        assert.ok(text.split('\n').length <= 500, `${name}: ${text.split('\n').length} lines`);
      }
    }
    const task = renderSkill('task', ctx, 'claude');
    for (const cmd of ['harness phase tests', 'harness gate prove-red', 'harness phase implement', 'harness verify', 'harness gate', 'harness gate --blocked', 'harness writeup']) assert.ok(task.includes(cmd), `task skill names ${cmd}`);
    assert.match(task, /never from prose/);
    assert.match(task, /Stop the line/);
    if (setting === 'team') {
      assert.ok(task.includes('harness intake --from <the ticket file>'));
      assert.doesNotMatch(task, /harness land/);
    } else {
      for (const cmd of ['harness task next', 'harness task claim', 'harness land', 'harness task done', 'harness task fail']) assert.ok(task.includes(cmd), cmd);
    }
    // intake comes before tests, tests before implement, verify before gate, gate before writeup
    const order = ['## 1. Intake', '## 2. Tests phase', '## 3. Implement phase', '## 4. Verify', '## 5. Gate', '## 6. Write-up'].map((h) => task.indexOf(h));
    assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'phases in order');
  }
  assert.equal(applyConditionals('a {{#team}}T{{/team}}{{#personal}}P{{/personal}} b\n{{#team}}\nonly team\n{{/team}}\nend\n', { team: false, personal: true }), 'a P b\nend\n');
});

test('personal: a repository that uses Prettier gets a .prettierignore block for every file the harness writes there; others get none', () => {
  const plain = context('personal', ['claude', 'codex']);
  assert.ok(!renderHarness(plain).files.some((f) => f.path.endsWith('.prettierignore')), 'no Prettier, no .prettierignore');

  const ctx = context('personal', ['claude', 'codex']);
  const repo = ctx.repoRoot!;
  fs.writeFileSync(path.join(repo, '.prettierrc.json'), '{ "singleQuote": true }\n');
  const r = renderHarness(ctx);
  const pi = r.files.find((f) => f.path === path.join(repo, '.prettierignore'));
  assert.ok(pi, 'a .prettierignore block');
  assert.equal(pi.kind, 'block');
  assert.ok(pi.hunks.some((h) => h.checkId === 'render.prettierignore'));
  const lines = pi.content.split('\n');
  for (const want of ['/AGENTS.md', '/CLAUDE.md', '/.harness/', '/tasks/', '/.claude/settings.json', '/.claude/skills/task/SKILL.md', '/.agents/skills/task/SKILL.md', '/.codex/hooks.json', '/.github/workflows/harness-gate.yml']) assert.ok(lines.includes(want), `${want} in ${pi.content}`);
  // every rendered file inside the repository is listed (or sits under a listed folder); nothing of the clone's own hooks, nothing outside the repo
  for (const f of r.files) {
    const rel = path.relative(repo, f.path).split(path.sep).join('/');
    if (rel.startsWith('..') || f.role === 'git-hook' || f === pi || f.role === 'gitignore') continue;
    assert.ok(lines.includes(`/${rel}`) || rel.startsWith('.harness/') || rel.startsWith('tasks/'), `${rel} not ignored`);
  }
  assert.ok(!lines.some((l) => /^\/\.git\//.test(l) || l.includes('..')), pi.content);
  // the same list once CLAUDE.md already imports AGENTS.md (the pointer is no longer rendered)
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
  const again = renderHarness(ctx).files.find((f) => f.path === path.join(repo, '.prettierignore'))!;
  assert.equal(again.content, pi.content);
});

test('Codex config.toml: the harness folder in [sandbox_workspace_write] writable_roots (both settings), merged into the user\'s own table, stable on a second run', () => {
  const hh = '/home/u/.harness';
  // no table yet: a block for the harness's marker section
  assert.deepEqual(codexSandboxEdit(null, hh), { text: null, block: '[sandbox_workspace_write]\nwritable_roots = ["/home/u/.harness"]' });
  assert.deepEqual(codexSandboxEdit('model = "o3"\n', hh), { text: null, block: '[sandbox_workspace_write]\nwritable_roots = ["/home/u/.harness"]' });
  // the user's own table: the key added in place, never a second header
  const t1 = codexSandboxEdit('[sandbox_workspace_write]\nnetwork_access = true\n\n[projects."/r"]\ntrust_level = "trusted"\n', hh);
  assert.equal(t1.text, '[sandbox_workspace_write]\nwritable_roots = ["/home/u/.harness"]\nnetwork_access = true\n\n[projects."/r"]\ntrust_level = "trusted"\n');
  assert.equal((t1.text!.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1);
  // an existing one-line array: appended; already there (with or without a trailing slash): no change
  assert.equal(codexSandboxEdit('[sandbox_workspace_write]\nwritable_roots = ["/data", \'/cache\']\n', hh).text, '[sandbox_workspace_write]\nwritable_roots = ["/data", \'/cache\', "/home/u/.harness"]\n');
  assert.equal(codexSandboxEdit('[sandbox_workspace_write]\nwritable_roots = []\n', hh).text, '[sandbox_workspace_write]\nwritable_roots = ["/home/u/.harness"]\n');
  assert.deepEqual(codexSandboxEdit('[sandbox_workspace_write]\nwritable_roots = ["/home/u/.harness/"]\n', hh), { text: null });
  // forms it does not edit: a note, the file untouched
  assert.match(codexSandboxEdit('[sandbox_workspace_write]\nwritable_roots = [\n  "/data",\n]\n', hh).note ?? '', /several lines/);
  assert.match(codexSandboxEdit('sandbox_workspace_write.network_access = true\n', hh).note ?? '', /dotted key or an inline table/);

  for (const setting of SETTINGS) {
    const ctx = context(setting, ['codex']);
    const r = renderHarness(ctx);
    const f = r.files.find((x) => x.path === path.join(ctx.userHome, '.codex', 'config.toml'));
    assert.ok(f, `${setting}: config.toml rendered`);
    assert.equal(f.kind, 'block');
    assert.ok(f.hunks.some((x) => x.checkId === 'render.codex-sandbox'));
    assert.match(f.content, new RegExp(`\\[sandbox_workspace_write\\]\\nwritable_roots = \\[${JSON.stringify(ctx.harnessHome).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\]`));
    assert.equal(/\[projects\./.test(f.content), setting === 'personal', `${setting}: project trust only in the personal setting`);
    // applied (the block upserted), a second render changes nothing
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, upsertBlock('model = "o3"\n', f.content, 'hash', 'end'));
    assert.equal(codexConfigFile(ctx, '0.0.0-test').file?.content, f.content, `${setting}: the same block again`);
    // the user's own table: changed in place, one header, the harness block keeps only the rest
    fs.writeFileSync(f.path, '[sandbox_workspace_write]\nnetwork_access = true\n');
    const g = codexConfigFile(ctx, '0.0.0-test').file!;
    assert.equal(g.kind, 'text');
    assert.equal((g.content.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1, g.content);
    assert.match(g.content, /^\[sandbox_workspace_write\]\nwritable_roots = \[.*\]\nnetwork_access = true\n/);
  }
});

test('Devin scoped rules carry `globs` as a YAML list (Devin CLI 3000.11.92 rejects a string with "expected a sequence")', () => {
  const ctx = context('team', ['devin']);
  const r = renderHarness(ctx);
  const rules = r.files.filter((f) => f.path.includes(`${path.sep}.devin${path.sep}rules${path.sep}`));
  assert.ok(rules.length >= 1, 'at least one scoped Devin rule');
  for (const f of rules) {
    const fm = f.content.split('\n---\n')[0];
    assert.match(fm, /^---\ntrigger: glob\n/, `${f.path}: trigger line`);
    const m = /^globs: (\[.*\])$/m.exec(fm);
    assert.ok(m, `${f.path}: globs must be an inline list, got:\n${fm}`);
    const list = JSON.parse(m![1]) as unknown;
    assert.ok(Array.isArray(list) && list.length >= 1 && list.every((x) => typeof x === 'string' && x.startsWith('**/')), `${f.path}: globs ${m![1]}`);
    const parsed = parseFrontMatter(f.content).data;
    assert.equal(parsed.trigger, 'glob');
  }
});

test('the pasted-ticket inbox is pre-approved for the file tools and named by the task skill', () => {
  for (const setting of SETTINGS) {
    const ctx = context(setting, ['devin', 'claude', 'codex']);
    const r = renderHarness(ctx);
    const inbox = path.join(path.dirname(path.resolve(ctx.harnessHome)), path.basename(path.resolve(ctx.harnessHome)) + '-inbox');
    const claude = r.files.find((f) => f.agent === 'claude' && f.kind === 'json' && /settings\.json$/.test(f.path));
    assert.ok(claude, `${setting}: Claude settings file`);
    const allow: string[] = JSON.parse(claude!.content).permissions.allow;
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(allow.some((x) => x.startsWith(`${tool}(`) && x.includes('.harness-inbox/**')), `${setting}: Claude ${tool} inbox rule in ${allow.filter((x) => /inbox/.test(x)).join(', ')}`);
    const devin = r.files.find((f) => f.agent === 'devin' && f.kind === 'json' && /config\.json$/.test(f.path));
    assert.ok(devin, `${setting}: Devin config file`);
    const dallow: string[] = JSON.parse(devin!.content).permissions.allow;
    for (const tool of ['Read', 'Write']) assert.ok(dallow.some((x) => x === `${tool}(${inbox.split(path.sep).join('/')}/**)`), `${setting}: Devin ${tool} inbox rule`);
    if (setting === 'team') {
      const skill = r.files.find((f) => /skills[\\/]task[\\/]SKILL\.md$/.test(f.path));
      assert.ok(skill, 'task skill');
      assert.ok(skill!.content.includes(inbox.split(path.sep).join('/') + '/'), 'the task skill names the inbox folder');
      assert.doesNotMatch(skill!.content, /\{\{INBOX\}\}/);
    }
  }
});

test('the repository write-formatter script is an allowed verification command; a check-only script is not', () => {
  const { repoFacts, verificationArgv } = require('../../../src/render/model') as typeof import('../../../src/render/model');
  const base = { id: 'r-000000', name: 'r', path: '/w/r', relPath: 'r', isGit: true, packageManager: 'npm' as const };
  const withFix = repoFacts({ ...base, packages: [{ dir: '', scripts: { format: 'prettier --write .', 'format:check': 'prettier --check .', test: 'vitest run' } }] } as any, '/w');
  assert.equal(withFix.commands.format, 'npm run format:check');
  assert.equal(withFix.commands.formatFix, 'npm run format');
  assert.ok(verificationArgv([withFix]).some((v) => v.join(' ') === 'npm run format'), 'npm run format allowed');
  const checkOnly = repoFacts({ ...base, packages: [{ dir: '', scripts: { format: 'prettier --check .', test: 'vitest run' } }] } as any, '/w');
  assert.equal(checkOnly.commands.formatFix, undefined, 'a format script that only checks is not a write-formatter');
  assert.ok(!verificationArgv([checkOnly]).some((v) => v.join(' ') === 'npm run format'));
  const lintFix = repoFacts({ ...base, packages: [{ dir: '', scripts: { 'lint:fix': 'eslint . --fix' } }] } as any, '/w');
  assert.equal(lintFix.commands.formatFix, 'npm run lint:fix');
});
