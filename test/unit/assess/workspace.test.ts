/**
 * The team-style workspace fixture (two sub-repos, user-level files for all
 * three agents in a fake HOME): every planted defect kind must be detected,
 * load timing per agent must follow the documented load paths, and the
 * safety inventory must list the existing rules.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { assess, classOf, findingsOf, gitAvailable, sandbox, type Sandbox } from './helpers';
import type { AssessReport } from '../../../src/types';

let sb: Sandbox;
let r: AssessReport;
let hasGit = false;

before(() => {
  hasGit = gitAvailable();
  sb = sandbox({ fixture: 'workspace', home: 'home', gitInit: hasGit ? ['billing-api', 'inventory-api'] : [] });
  r = assess(sb).report;
});
after(() => sb.cleanup());

const file = (display: string) => r.files.find((f) => f.display === display);

test('inventory covers user, workspace and repo level for all three agents', () => {
  const displays = r.files.map((f) => f.display);
  for (const d of [
    '~/.claude/CLAUDE.md',
    '~/.claude/settings.json',
    '~/.agents/skills/db-helper/SKILL.md',
    '~/.config/devin/AGENTS.md',
    '~/.config/devin/config.json',
    '~/.codex/AGENTS.md',
    '~/.codex/config.toml',
    '~/.codex/rules/default.rules',
    'AGENTS.md',
    '.devin/rules/sql.md',
    'billing-api/AGENTS.md',
    'billing-api/CLAUDE.md',
    'billing-api/.claude/settings.json',
    'billing-api/.claude/settings.local.json',
    'inventory-api/AGENTS.md',
    'inventory-api/.agents/skills/release_notes/SKILL.md',
  ])
    assert.ok(displays.includes(d), `missing ${d}`);
  for (const f of r.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 0 && f.lines > 0, f.path);
  }
});

test('load timing follows each agent\'s documented load paths', () => {
  const w = (d: string, a: 'devin' | 'claude' | 'codex') => file(d)?.loads?.[a]?.when;
  assert.equal(w('AGENTS.md', 'devin'), 'launch');
  assert.equal(w('billing-api/AGENTS.md', 'devin'), 'lazy');
  assert.equal(w('billing-api/CLAUDE.md', 'devin'), 'lazy', 'Devin loads CLAUDE.md as a rule');
  assert.equal(w('~/.claude/CLAUDE.md', 'devin'), 'launch', 'Devin reads ~/.claude/CLAUDE.md as a global rule');
  assert.equal(w('.devin/rules/sql.md', 'devin'), 'lazy', 'trigger: glob is lazy');
  assert.equal(w('~/.claude/CLAUDE.md', 'claude'), 'launch');
  assert.equal(w('billing-api/AGENTS.md', 'claude'), 'never', 'shadowed by CLAUDE.md');
  assert.equal(w('inventory-api/AGENTS.md', 'claude'), 'launch', 'read natively in a session started in that repo');
  assert.equal(w('~/.codex/AGENTS.md', 'codex'), 'launch');
  assert.equal(w('~/.codex/AGENTS.md', 'claude'), 'never');
  assert.equal(w('~/.agents/skills/db-helper/SKILL.md', 'codex'), 'lazy');
  assert.equal(w('~/.agents/skills/db-helper/SKILL.md', 'claude'), 'never', 'Claude Code does not read .agents/skills');
  assert.deepEqual(file('~/.config/devin/AGENTS.md')?.loadedBy, ['devin']);
  assert.ok(r.loaded.devin && r.loaded.claude && r.loaded.codex);
  assert.ok(r.loadDetail?.devin?.effective && r.loadDetail.devin.effective.files.length > r.loaded.devin.files.length, 'Devin effective set includes sub-repo files');
  assert.ok(r.loadDetail?.devin?.effective?.files.includes('billing-api/AGENTS.md'));
  assert.equal(r.loaded.codex.limit, 32 * 1024);
  assert.match(r.loadDetail?.devin?.limitNote ?? '', /16,384 bytes/);
});

test('every planted defect kind is detected', () => {
  const expect = (check: string, display: string, why: string) => assert.ok(findingsOf(r, check, display).length > 0, `${why}: ${check} on ${display} not found`);
  expect('R04', 'AGENTS.md', 'stale command');
  expect('R05', 'AGENTS.md', 'stale path');
  expect('R06', '~/.claude/CLAUDE.md', 'duplicated paragraph in two files');
  expect('R30', '~/.claude/CLAUDE.md', 'contradiction between two files');
  expect('R30', 'AGENTS.md', 'contradiction between two files (other side)');
  expect('R29', '~/.claude/CLAUDE.md', 'rule against the Prettier config');
  expect('R29', 'billing-api/CLAUDE.md', 'rule against the ESLint config');
  expect('R26', 'AGENTS.md', 'oversized derivable section (a file map)');
  assert.ok(findingsOf(r, 'R26', 'AGENTS.md').some((f) => f.severity === 'warn'), 'the file map is oversized (warn)');
  assert.ok(findingsOf(r, 'R25').length >= 3, 'imperatives that should be checks');
  expect('R13', '~/.claude/CLAUDE.md', 'autonomy escalation');
  expect('R11', 'inventory-api/AGENTS.md', 'HTML comment with instruction-like text');
  expect('R10', '~/.codex/AGENTS.md', 'hidden Unicode');
  expect('R31', '~/.claude/CLAUDE.md', 'stale agent-feature fact (hooks)');
  expect('R31', 'AGENTS.md', 'stale agent-feature fact (Cascade)');
  expect('R18', 'inventory-api/.agents/skills/release_notes/SKILL.md', 'skill with a bad name');
  expect('R28', 'inventory-api/.agents/skills/release_notes/SKILL.md', 'skill description that does not say when to use it');
  expect('R27', '~/.claude/CLAUDE.md', 'polarity ratio reported');
  expect('R14', 'billing-api/.claude/settings.json', 'broad permission');
  expect('R15', 'billing-api/.claude/settings.json', 'hook that curls');
  assert.equal(findingsOf(r, 'R15', 'billing-api/.claude/settings.json')[0].severity, 'high');
  expect('R07', 'billing-api/AGENTS.md', 'AGENTS.md shadowed by CLAUDE.md');
  expect('R16', '~/.codex/config.toml', 'MCP server declared');
  const prod = r.safetyRules.find((s) => s.kind === 'never-sentence' && /migrations against production/.test(s.text));
  assert.ok(prod, '"never run migrations against production" is in the safety inventory');
});

test('a committed settings.local.json is reported when git tracks it', (t) => {
  if (!hasGit) {
    t.skip('git is not available on PATH');
    return;
  }
  const f = findingsOf(r, 'R17', 'billing-api/.claude/settings.local.json');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn');
});

test('hidden Unicode and injection quarantine their own line; the file keeps its finding and its other lines keep their classes', () => {
  const q = file('~/.codex/AGENTS.md')?.quarantine;
  assert.deepEqual(q?.checks, ['R10']);
  const inv = file('inventory-api/AGENTS.md')?.quarantine;
  assert.ok(inv && inv.checks.includes('R11'));
  const codexLines = r.classifications.filter((c) => c.file === file('~/.codex/AGENTS.md')?.path);
  assert.equal(codexLines.length, 4);
  const quarantined = codexLines.filter((c) => c.cls === 'QUARANTINE');
  assert.equal(quarantined.length, 1, 'only the line with the hidden character is quarantined');
  assert.equal(quarantined[0].line, 3);
  assert.equal(quarantined[0].underlying, 'KEEP');
  assert.ok(codexLines.filter((c) => c.cls !== 'QUARANTINE').every((c) => c.cls === 'KEEP'));
  assert.match(codexLines[2].text, /<U\+200B>/, 'stored text shows the hidden character');
  assert.equal(classOf(r, '~/.claude/CLAUDE.md', 24)?.cls, 'QUARANTINE', 'R13 quarantines only its line');
  assert.equal(classOf(r, '~/.claude/CLAUDE.md', 7)?.cls, 'KEEP');
});

test('classification: KEEP / CONVERT / TRIM / FIX / QUARANTINE by unit, with reasons and checks', () => {
  const c = (d: string, n: number) => classOf(r, d, n);
  assert.equal(c('~/.claude/CLAUDE.md', 9)?.cls, 'FIX'); // tabs vs Prettier
  assert.equal(c('~/.claude/CLAUDE.md', 9)?.check, 'R29');
  assert.equal(c('~/.claude/CLAUDE.md', 15)?.cls, 'CONVERT'); // kebab-case
  assert.equal(c('~/.claude/CLAUDE.md', 16)?.cls, 'CONVERT'); // test per module
  for (const n of [20, 21, 22]) assert.equal(c('~/.claude/CLAUDE.md', n)?.cls, 'TRIM', `duplicate paragraph line ${n}`);
  assert.equal(c('~/.claude/CLAUDE.md', 25)?.cls, 'KEEP'); // safety sentence
  assert.equal(c('~/.claude/CLAUDE.md', 25)?.check, 'safety');
  assert.equal(c('AGENTS.md', 8)?.cls, 'FIX'); // stale command
  assert.equal(c('AGENTS.md', 10)?.cls, 'CONVERT'); // conventional commits
  assert.equal(c('AGENTS.md', 11)?.cls, 'KEEP'); // never run migrations against production
  assert.equal(c('AGENTS.md', 12)?.cls, 'FIX'); // list item continues on line 13 with the stale path
  assert.equal(c('AGENTS.md', 13)?.unitStart, 12);
  for (let n = 16; n <= 29; n++) assert.equal(c('AGENTS.md', n)?.cls, 'TRIM', `layout line ${n}`);
  assert.equal(c('~/.agents/skills/db-helper/SKILL.md', 8)?.cls, 'KEEP', 'the skill keeps its copy of the duplicated paragraph');
  assert.equal(c('inventory-api/.agents/skills/release_notes/SKILL.md', 2)?.cls, 'FIX');
  assert.equal(c('inventory-api/.agents/skills/release_notes/SKILL.md', 4)?.cls, 'TRIM');
  for (const cl of r.classifications) assert.ok(cl.reason.length > 0);
});

test('safety inventory: deny/ask rules in all three dialects, hooks, CI jobs, never-sentences', () => {
  const kinds = (k: string) => r.safetyRules.filter((s) => s.kind === k);
  assert.ok(kinds('deny-rule').some((s) => s.source.endsWith('.claude/settings.json') && /force/.test(s.text)), 'Claude deny');
  assert.ok(kinds('deny-rule').some((s) => s.source.endsWith('config.json') && /Exec\(git push --force\)/.test(s.text)), 'Devin deny');
  assert.ok(kinds('deny-rule').some((s) => s.source.endsWith('default.rules') && /forbidden/.test(s.text)), 'Codex forbidden prefix rule');
  assert.ok(kinds('ask-rule').length >= 3);
  assert.ok(kinds('git-hook').some((s) => /pre-commit/.test(s.text)));
  assert.ok(kinds('ci-required').length >= 2);
  assert.ok(kinds('never-sentence').some((s) => /secrets/.test(s.text)));
  assert.ok((r.notes ?? []).some((n) => /Branch protection/.test(n)));
});

test('report strings carry no hidden code points', () => {
  const json = JSON.stringify(r);
  assert.equal(/[​-‏⁠﻿‪-‮⁦-⁩]/.test(json), false);
});
