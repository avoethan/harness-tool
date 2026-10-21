/**
 * The always-on file (DESIGN 2.4): at most ~4 KB and 60 harness-owned lines,
 * mostly pointers. One source, rendered per agent:
 *
 *   team      Devin  <devin config>/AGENTS.md (user level)
 *             Claude ~/.claude/CLAUDE.md
 *             Codex  ~/.codex/AGENTS.md
 *   personal  AGENTS.md in the repository (Devin and Codex read it; Claude
 *             reads it through a one-line `@AGENTS.md` import in CLAUDE.md)
 *
 * The harness owns only the marker block; the user's own text in the same
 * file stays (propose may move lines out of it, never rewrite them).
 *
 * Content, in priority order (lower priority goes first when the block must
 * shrink): the work rule and the CLI line; a few negative constraints; the
 * exact commands per repo (grouped when repos share them) with how to run one
 * test and which scripts are slow; the test-database targets; the rule to
 * enforcer table; the repo index (team); pointers to the skills and scoped
 * rules. No overviews, no file maps (R-19).
 */
import * as path from 'node:path';
import type { AgentId, LedgerRecord, Tier } from '../types';
import { ALWAYS_ON_MAX_BYTES, ALWAYS_ON_MAX_LINES, MD_BEGIN, MD_END, allRepoFacts, cell, clip, code, homeRelative, posix, removeBlock, upsertBlock, type RenderContext, type RepoFacts, type RuleRow } from './model';
import { cliNote } from './skills';
import { agentDirs } from './permissions';

const TIER_RANK: Record<Tier, number> = { declared: 0, 'counted-strong': 1, 'counted-majority': 2, 'review-derived': 3, 'single-source': 4 };

/** Path of the always-on file for an agent and setting. */
export function alwaysOnPath(ctx: RenderContext, agent: AgentId): string {
  if (ctx.setting === 'personal') return path.join(ctx.repoRoot ?? ctx.workspaceRoot, 'AGENTS.md');
  const d = agentDirs(ctx);
  switch (agent) {
    case 'devin':
      return path.join(d.devinHome, 'AGENTS.md');
    case 'claude':
      return path.join(d.claudeHome, 'CLAUDE.md');
    case 'codex':
      return path.join(d.codexHome, 'AGENTS.md');
  }
}

/** The agents served by each always-on path (personal: one AGENTS.md serves all). */
export function alwaysOnTargets(ctx: RenderContext): Array<{ path: string; agents: AgentId[] }> {
  const out: Array<{ path: string; agents: AgentId[] }> = [];
  for (const a of ctx.agents) {
    const p = alwaysOnPath(ctx, a);
    const hit = out.find((x) => x.path === p);
    if (hit) hit.agents.push(a);
    else out.push({ path: p, agents: [a] });
  }
  return out;
}

export function enforcerFor(r: Pick<LedgerRecord, 'check'>): string {
  const gate = r.check.mode === 'block' ? 'gate blocks' : r.check.mode === 'warn' ? 'gate warns' : 'gate review';
  switch (r.check.type) {
    case 'eslint':
      return `ESLint · edit note · ${gate}`;
    case 'config':
      return `repo config · ${gate}`;
    case 'ast-grep':
    case 'regex':
    case 'semgrep':
    case 'dependency-cruiser':
    case 'knip':
    case 'sql-lint':
      return `harness check · edit note · ${gate}`;
    case 'commitlint':
      return `commit check · ${gate}`;
    case 'judgment':
      return 'judgment (advisory)';
  }
}

/** The rails as rule rows (the setting decides which apply). */
export function railRows(ctx: RenderContext): RuleRow[] {
  const rows: RuleRow[] = [
    { id: 'rail.gate', short: 'done = gate PASS', rule: 'Done = `harness gate` PASS on the current code', enforcer: 'Stop hook · gate' + (ctx.setting === 'personal' ? ' · git hooks · CI' : '') },
    { id: 'rail.git-history', short: 'no force-push, history rewrite or skipped hooks', rule: 'No force-push, history rewrite or skipped git hooks', enforcer: 'guard · permission deny' + (ctx.setting === 'personal' ? ' · pre-push hook' : '') },
    { id: 'rail.db', short: 'test databases only', rule: 'Database commands reach only targets marked test', enforcer: 'guard (allowlist)' },
    { id: 'rail.secrets', short: 'no secret files', rule: 'No secret files read, staged or logged', enforcer: 'guard · staging check · redaction' },
    { id: 'rail.phase-tests', short: 'tests change only in the tests phase', rule: 'Test files change only in the tests phase', enforcer: 'guard · gate tamper check' },
    { id: 'rail.protect', short: 'no edits to harness or agent settings', rule: 'Harness state and agent settings are not edited by the agent', enforcer: 'permission deny · integrity check' },
  ];
  if (ctx.setting === 'team') rows.splice(2, 0, { id: 'rail.team', short: 'no push, PR or harness file in a team repo', rule: 'No push, no PR, no harness file inside a team repo', enforcer: 'guard · staging check · permission deny' });
  return rows;
}

function repoNames(ctx: RenderContext, ids: string[]): string {
  const facts = allRepoFacts(ctx);
  return ids.map((id) => facts.find((f) => f.id === id)?.name ?? id).join(', ');
}

/** Ledger records worth a row: not safety (those are rails), block mode first, strongest tiers first. */
export function ledgerRows(ctx: RenderContext): RuleRow[] {
  const recs = (ctx.ledger?.records ?? []).filter((r) => r.family !== 'safety' && r.check.type !== 'judgment');
  recs.sort((a, b) => {
    const m = (x: LedgerRecord) => (x.check.mode === 'block' ? 0 : 1);
    const w = (x: LedgerRecord) => (x.scope.repos.includes('*') ? 0 : 1);
    return m(a) - m(b) || TIER_RANK[a.tier] - TIER_RANK[b.tier] || w(a) - w(b) || a.id.localeCompare(b.id);
  });
  return recs.map((r) => {
    const scope = r.scope.repos.includes('*') ? '' : ` (${repoNames(ctx, r.scope.repos)})`;
    return { id: r.id, rule: clip(r.statement, 78 - scope.length) + scope, enforcer: enforcerFor(r) };
  });
}

/** Repos grouped by identical command sets, so a workspace of look-alike services costs one line. */
export function commandLines(facts: RepoFacts[], setting: 'team' | 'personal'): string[] {
  const groups = new Map<string, { names: string[]; f: RepoFacts }>();
  for (const f of facts) {
    const key = JSON.stringify({ c: f.commands, p: f.pm, w: f.packages.length > 0 });
    const g = groups.get(key);
    if (g) g.names.push(f.name);
    else groups.set(key, { names: [f.name], f });
  }
  const out: string[] = [];
  for (const { names, f } of groups.values()) {
    const parts: string[] = [];
    const c = f.commands;
    if (c.build) parts.push(`build ${code(c.build)}`);
    if (c.typecheck) parts.push(`types ${code(c.typecheck)}`);
    if (c.lint) parts.push(`lint ${code(c.lint)}`);
    if (c.format) parts.push(`format ${code(c.format)}`);
    if (c.test) parts.push(`test ${code(c.test)}`);
    if (c.oneTest) parts.push(`one test ${code(c.oneTest)}`);
    if (f.pm === 'npm' && f.packages.length) parts.push(`one package ${code('npm test -w <package dir>')}`);
    if (!parts.length) parts.push('no build or test scripts found; `harness gate` runs what exists');
    const who = setting === 'personal' && facts.length === 1 ? 'This repo' : names.join(', ');
    out.push(`- ${who}: ${parts.join(' · ')}`);
  }
  const slow = facts.filter((f) => f.slow.length);
  if (slow.length) {
    const items = slow.map((f) => `${f.slow.map(code).join(', ')}${setting === 'team' ? ` (${f.name})` : ''}`);
    out.push(`- Slow or service-bound (verify phase only): ${items.join('; ')}`);
  }
  return out;
}

export function dbLine(ctx: RenderContext): string | null {
  const list = ctx.config?.db?.allowlist ?? [];
  const tests = list.filter((t) => t.marked === 'test').map((t) => (t.database ? `${t.server}/${t.database}` : `${t.server} (every database)`));
  if (!tests.length) return 'Test databases: none marked yet, so every database command is denied. The user marks them in a terminal (`harness db mark`).';
  return `Test databases (the only ones commands may reach): ${tests.slice(0, 4).map(code).join(', ')}${tests.length > 4 ? ` and ${tests.length - 4} more (\`harness db list\`)` : ''}.`;
}

function bypassLine(agents: AgentId[]): string {
  const parts: string[] = [];
  if (agents.includes('devin')) parts.push('Devin `/mode bypass`');
  if (agents.includes('claude')) parts.push('`--dangerously-skip-permissions`');
  if (agents.includes('codex')) parts.push('`--dangerously-bypass-hook-trust` or `--yolo`');
  return `- Never switch the rails off: no ${parts.join(', no ')}, no nested agent with hooks off.`;
}

function scopedPointer(ctx: RenderContext, agents: AgentId[]): string | null {
  const parts: string[] = [];
  if (ctx.setting === 'team') {
    if (agents.includes('devin')) parts.push('Devin `~/.devin/rules/<repo>.md`');
    if (agents.includes('claude')) parts.push('Claude `~/.claude/rules/<repo>.md`');
  } else {
    if (agents.includes('devin')) parts.push('`.devin/rules/`');
    if (agents.includes('claude')) parts.push('`.claude/rules/`');
    if (agents.includes('codex')) parts.push('nested `AGENTS.md` files');
  }
  const where = parts.length ? ` Advisory detail per repo: ${parts.join('; ')}.` : '';
  return `- Standards per repo arrive as hook notes when you open or edit a file there.${where}`;
}

export interface AlwaysOnBlock {
  /** Block body (without the markers). */
  body: string;
  /** Harness-owned lines including the two markers. */
  lines: number;
  /** Bytes of the block including the markers and their newlines. */
  bytes: number;
  /** What was left out to fit, in words. */
  dropped: string[];
}

interface Section {
  name: string;
  /** Lines that always stay. */
  head: string[];
  /** Rows that may be dropped from the end, lowest priority first to go. */
  rows: string[];
  minRows: number;
  /** Rows that stay even when the block cannot fit (the file then goes over, with a note). */
  floor: number;
  /** Lines shown before the rows only while at least one row is kept (a table header). */
  tableHead?: string[];
  /** Line that replaces dropped rows (gets the count). */
  more?: (n: number) => string;
  /** Drop order: lower goes first. */
  dropRank: number;
}

function measure(body: string): { lines: number; bytes: number } {
  const text = `${MD_BEGIN}\n${body}\n${MD_END}\n`;
  return { lines: body.split('\n').length + 2, bytes: Buffer.byteLength(text, 'utf8') };
}

function assemble(sections: Section[], counts: Map<string, number>): string {
  const out: string[] = [];
  for (const s of sections) {
    const keep = counts.get(s.name) ?? s.rows.length;
    const rows = s.rows.slice(0, keep);
    if (!s.head.length && !rows.length) continue;
    if (out.length) out.push('');
    out.push(...s.head, ...(rows.length ? s.tableHead ?? [] : []), ...rows);
    if (keep < s.rows.length && s.more) out.push(s.more(s.rows.length - keep));
  }
  return out.join('\n');
}

/**
 * Render the block for the agents served by one file, within `budgetBytes`
 * (the file's limit minus the user's own text) and 60 lines.
 */
export function renderAlwaysOnBlock(ctx: RenderContext, agents: AgentId[], budgetBytes = ALWAYS_ON_MAX_BYTES, maxLines = ALWAYS_ON_MAX_LINES): AlwaysOnBlock {
  const facts = allRepoFacts(ctx);
  const sections: Section[] = [];
  sections.push({
    name: 'head',
    head: [
      '## How work is done here (harness)',
      '',
      'Use the `task` skill for every task: intake, tests, implement, verify, gate, write-up. Done = `harness gate` PASS on the current code; evidence comes from commands you ran, never from prose.',
      cliNote(ctx),
    ],
    rows: [],
    minRows: 0,
    floor: 0,
    dropRank: 99,
  });
  const never = [
    '### Never',
    bypassLine(agents),
    '- When a rail blocks a command, do not try another spelling; stop and say what you needed.',
    ctx.setting === 'team'
      ? '- Never push or open a pull request; end with the write-up and the branch name. The user pushes.'
      : '- Never push except through `harness land`; never force-push or rewrite history.',
    '- Never weaken, skip or delete a test or check to pass the gate; record BLOCKED with the reason.',
  ];
  for (const r of (ctx.ledger?.records ?? []).filter((x) => x.family === 'safety').slice(0, 2)) never.push(`- ${clip(r.statement, 150)}`);
  // Learned negative constraints (src/learn, approved in `harness learn review`); each expires.
  for (const l of (ctx.lessons ?? []).filter((x) => x.rung === 'instruction')) never.push(`- ${clip(l.text, 200)} (learned ${l.id}${l.reviewBy ? `; review by ${l.reviewBy}` : ''})`);
  sections.push({ name: 'never', head: never, rows: [], minRows: 0, floor: 0, dropRank: 99 });

  const cmds = commandLines(facts, ctx.setting);
  if (cmds.length) {
    sections.push({ name: 'commands', head: ['### Commands (exact; run them inside the repo folder)'], rows: cmds, minRows: Math.min(2, cmds.length), floor: 1, more: (n) => `- ${n} more command line(s): \`harness doctor\` and the SessionStart note list them.`, dropRank: 3 });
  }
  const db = dbLine(ctx);
  if (db) sections.push({ name: 'db', head: [db], rows: [], minRows: 0, floor: 0, dropRank: 99 });

  const rails = railRows(ctx);
  const extra = ctx.extraRules ?? [];
  // Ledger rows: the user's own rules that became checks first, then the strongest standards.
  const all = ledgerRows(ctx);
  const ledger = [...all.filter((r) => extra.some((e) => e.id === r.id)), ...all.filter((r) => !extra.some((e) => e.id === r.id))];
  const head = ['### Rules and what enforces them'];
  if (extra.length) head.push(`Your own rules now enforced by checks (originals in \`${posix(path.join(homeRelative(ctx.harnessHome, ctx.userHome), 'archive'))}/\`): ${extra.map((e) => code(e.id)).join(', ')}.`);
  const tableRows = [...rails, ...ledger].map((r) => `| ${cell(r.rule)} | ${cell(r.enforcer)} |`);
  const compactRails = `Rails (hard blocks): ${rails.map((r) => r.short ?? r.rule).join('; ')}.`;
  sections.push({
    name: 'rules',
    head,
    tableHead: ['| Rule | Enforced by |', '|---|---|'],
    rows: tableRows,
    minRows: rails.length,
    floor: 0,
    more: (n) => {
      const std = Math.min(n, ledger.length);
      const note = std ? `(${std} more standards: the edit notes, the scoped rules and \`harness gate\` carry them.)` : '';
      return n > ledger.length ? `${compactRails}${note ? ' ' + note : ''}` : note;
    },
    dropRank: 2,
  });

  if (ctx.setting === 'team' && facts.length) {
    const rows = facts.map((f) => `- ${f.name}: ${code(f.relPath + '/')} · verify ${code(f.verify)}`);
    sections.push({ name: 'repos', head: ['### Repos'], rows, minRows: Math.min(5, rows.length), floor: 0, more: (n) => `- ${n} more repos: the SessionStart note prints the full index.`, dropRank: 1 });
  }

  const pointers = [
    '### Pointers',
    '- Skills: `task` (every task), `setup` and `learn` (only when the user asks).',
  ];
  const sp = scopedPointer(ctx, agents);
  if (sp) pointers.push(sp);
  for (const p of ctx.pointers ?? []) pointers.push(`- ${p}`);
  sections.push({ name: 'pointers', head: pointers, rows: [], minRows: 0, floor: 0, dropRank: 99 });

  // Shrink to fit: drop rows from the lowest-ranked section first, down to its minimum.
  const counts = new Map<string, number>(sections.map((s) => [s.name, s.rows.length]));
  const dropped: string[] = [];
  const fits = () => {
    const m = measure(assemble(sections, counts));
    return m.lines <= maxLines && m.bytes <= budgetBytes;
  };
  const order = [...sections].filter((s) => s.rows.length).sort((a, b) => a.dropRank - b.dropRank);
  for (const s of order) {
    while (!fits() && (counts.get(s.name) ?? 0) > s.minRows) counts.set(s.name, (counts.get(s.name) ?? 0) - 1);
  }
  // Still too big: drop to each section's floor in the same order (the rails, one command line and the essentials stay).
  for (const s of order) {
    while (!fits() && (counts.get(s.name) ?? 0) > s.floor) counts.set(s.name, (counts.get(s.name) ?? 0) - 1);
  }
  for (const s of order) {
    const left = s.rows.length - (counts.get(s.name) ?? 0);
    if (left) dropped.push(`${left} ${s.name} row(s)`);
  }
  const body = assemble(sections, counts);
  const m = measure(body);
  return { body, lines: m.lines, bytes: m.bytes, dropped };
}

export interface AlwaysOnFile {
  text: string;
  block: AlwaysOnBlock;
  /** Bytes of the whole file. */
  bytes: number;
  /** Set when the user's own text alone keeps the file over the limit. */
  over?: string;
}

/**
 * The whole always-on file: the user's text (after propose's moves) plus the
 * harness block, sized so the file stays within ~4 KB when it can.
 */
export function renderAlwaysOnFile(ctx: RenderContext, agents: AgentId[], userText: string | null): AlwaysOnFile {
  const own = userText ? removeBlock(userText.replace(/\r\n/g, '\n'), 'md') : '';
  const ownBytes = Buffer.byteLength(own.trim() ? own.replace(/\n*$/, '') + '\n\n' : '', 'utf8');
  const budget = Math.max(ALWAYS_ON_MAX_BYTES - ownBytes, 0);
  const block = renderAlwaysOnBlock(ctx, agents, budget);
  const text = upsertBlock(userText, block.body, 'md', 'end');
  const bytes = Buffer.byteLength(text, 'utf8');
  const out: AlwaysOnFile = { text, block, bytes };
  if (bytes > ALWAYS_ON_MAX_BYTES) out.over = `the file is ${bytes} bytes (limit ${ALWAYS_ON_MAX_BYTES}); ${ownBytes} of them are your own text, which the harness never rewrites; trim it or accept the plan's TRIM moves`;
  return out;
}
