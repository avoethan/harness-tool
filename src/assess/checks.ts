/**
 * Checks over the text of agent files (instructions, rules, skills, commands):
 *
 *   R10-R13  raw scans (hidden Unicode, HTML-comment instructions, injection,
 *            autonomy escalation); R10-R12 quarantine their line and flag the file
 *   R04 stale command      R05 stale path        R06 duplicate copy / paragraph
 *   R19 AI policy          R21 oracle rewrite    R22 broken import or link
 *   R25 instruction-as-check (CONVERT)            R26 derivable content (TRIM)
 *   R27 polarity ratio     R29 rule-vs-config    R30 cross-file contradiction
 *   R31 stale agent-feature fact
 *
 * Each check emits findings and line marks; classify.ts turns marks into the
 * class of every line. All quoting goes through escapeForReport.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTextOr } from '../lib/fsx';
import { tryParseJsonc } from '../lib/jsonc';
import { codeSpans, fenceLines, normaliseProse, parseMarkdown, sentences, unitText, type MdDoc, type Unit } from './markdown';
import { autonomyHit, escapeForReport, scanHidden, scanHtmlComments, scanInjection } from './scan';
import { allScripts, nearestScripts } from './project';
import { displayPath } from './inventory';
import { safetyTopic, docFiles } from './safety';
import type { AgentId, AssessFinding, Classification } from '../types';
import type { AssessContext, InvFile, RepoInfo } from './model';
import { PROSE_KINDS } from './model';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const docCache = new WeakMap<InvFile, MdDoc>();
export function docOf(f: InvFile): MdDoc {
  let d = docCache.get(f);
  if (!d) {
    d = parseMarkdown(f.text);
    docCache.set(f, d);
  }
  return d;
}

export function proseFiles(ctx: AssessContext): InvFile[] {
  return ctx.files.filter((f) => PROSE_KINDS.has(f.kind) && !f.binary);
}

function find(ctx: AssessContext, f: InvFile | string, check: string, severity: AssessFinding['severity'], message: string, line?: number, evidence?: string, agent?: AgentId): void {
  ctx.findings.push({ check, severity, file: typeof f === 'string' ? f : f.abs, line, message, evidence, agent });
}

function mark(ctx: AssessContext, f: InvFile, line: number, cls: Classification, check: string, reason: string, partial?: boolean): void {
  ctx.marks.push({ file: f, line, cls, check, reason, partial });
}

function lineOf(doc: MdDoc, n: number): string {
  return doc.lines[n - 1] ?? '';
}

function repoFor(ctx: AssessContext, f: InvFile): RepoInfo | null {
  return f.repoRoot ? (ctx.repos.find((r) => r.root === f.repoRoot) ?? null) : null;
}

/** Units that carry prose (not headings, code, comments, front matter). */
function proseUnits(doc: MdDoc): Unit[] {
  return doc.units.filter((u) => u.kind === 'paragraph' || u.kind === 'list-item' || (u.kind === 'table-row' && !/^\s*\|?\s*:?-{2,}/.test(u.lines[0])));
}

const NEGATED_BEFORE = /\b(never|do\s+not|don'?t|must\s+not|should\s+not|shouldn'?t|avoid|no)\b[^.;!?]{0,40}$/i;

// ---------------------------------------------------------------------------
// R10-R13 raw scans, before any parsing
// ---------------------------------------------------------------------------

/**
 * ~/.claude.json is Claude Code's user state (history, caches) as well as its
 * MCP config: only the MCP server entries are scanned, so text the user once
 * typed does not raise R10 on the whole file.
 */
function mcpOnlyText(f: InvFile): string | null {
  if (f.level !== 'user' || path.basename(f.abs) !== '.claude.json') return null;
  const r = tryParseJsonc<Record<string, unknown>>(f.text);
  if (!r.ok || !r.value || typeof r.value !== 'object') return '';
  const parts: unknown[] = [r.value.mcpServers];
  const projects = r.value.projects;
  if (projects && typeof projects === 'object') for (const p of Object.values(projects as Record<string, unknown>)) parts.push(p && typeof p === 'object' ? (p as Record<string, unknown>).mcpServers : undefined);
  return parts.filter(Boolean).map((p) => JSON.stringify(p, null, 1)).join('\n');
}

export function rawScans(ctx: AssessContext): void {
  for (const f of ctx.files) {
    const qChecks = new Set<string>();
    const qLines = new Set<number>();
    const mcpOnly = mcpOnlyText(f);
    if (mcpOnly !== null) {
      if (scanHidden(mcpOnly).length) {
        find(ctx, f, 'R10', 'high', `Hidden Unicode in an MCP server entry of ${f.display}. An agent reads these characters; a person does not see them.`);
        f.quarantine = { checks: ['R10'], lines: [] };
      }
      continue;
    }
    for (const h of scanHidden(f.text)) {
      find(ctx, f, 'R10', 'high', `Hidden Unicode in ${f.display} line ${h.line}: ${h.label}. An agent reads these characters; a person does not see them.`, h.line, escapeForReport(f.text.split(/\r?\n/)[h.line - 1] ?? ''));
      qChecks.add('R10');
      qLines.add(h.line);
    }
    if (PROSE_KINDS.has(f.kind)) {
      for (const h of scanHtmlComments(f.text)) {
        find(ctx, f, 'R11', 'high', `An HTML comment in ${f.display} reads like an instruction to an agent (${h.label}); comments are invisible when the Markdown is rendered.`, h.line, escapeForReport(f.text.split(/\r?\n/)[h.line - 1] ?? ''));
        qChecks.add('R11');
        for (let n = h.line; n <= h.endLine; n++) qLines.add(n);
      }
      for (const h of scanInjection(f.text, true)) {
        find(ctx, f, 'R12', 'high', `Injection phrasing in ${f.display}: ${h.label}.`, h.line, escapeForReport(f.text.split(/\r?\n/)[h.line - 1] ?? ''));
        qChecks.add('R12');
        qLines.add(h.line);
      }
      f.text.split(/\r?\n/).forEach((l, i) => {
        const a = autonomyHit(l);
        if (!a) return;
        find(ctx, f, 'R13', 'high', `${f.display} grants the agent autonomy the safety rails do not allow (${a}).`, i + 1, escapeForReport(l));
        mark(ctx, f, i + 1, 'QUARANTINE', 'R13', `grants autonomy (${a}); archived with its origin, never carried into the rendered harness`);
      });
    }
    if (qChecks.size) f.quarantine = { checks: [...qChecks].sort(), lines: [...qLines].sort((a, b) => a - b) };
  }
  // R12 in README / CONTRIBUTING / docs (human docs: download one-liners are allowed there)
  for (const p of docFiles(ctx, /^(README|CONTRIBUTING)[^/]*\.(md|markdown)$/i, true)) {
    const text = readTextOr(p, '') ?? '';
    for (const h of scanInjection(text, false)) find(ctx, p, 'R12', 'high', `Injection phrasing in ${displayPath(ctx, p)}: ${h.label}. Agents read this file when they explore the repo.`, h.line, escapeForReport(text.split(/\r?\n/)[h.line - 1] ?? ''));
    for (const h of scanHidden(text)) find(ctx, p, 'R10', 'high', `Hidden Unicode in ${displayPath(ctx, p)} line ${h.line}: ${h.label}.`, h.line, h.label);
  }
}

// ---------------------------------------------------------------------------
// R04 stale command
// ---------------------------------------------------------------------------

const PM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'dlx', 'exec', 'x', 'why', 'init', 'create', 'up', 'upgrade', 'update', 'dedupe', 'audit', 'outdated', 'publish', 'pack', 'link', 'unlink', 'config', 'set', 'cache', 'info', 'list', 'ls', 'global', 'workspace', 'workspaces', 'help', 'version', 'patch', 'rebuild', 'import', 'prune', 'store', 'env', 'bin', 'root', 'node', 'run', 'ci', 'login', 'logout', 'whoami', 'test', 'start', 'licenses', 'plugin', 'self-update', 'setup', 'fetch', 'deploy', 'approve-builds', 'recursive', 'r', 'install-test', 'it', 'explain', 'doctor']);

interface CmdRef {
  tool: 'script' | 'make' | 'just';
  name: string;
  spelled: string;
}

export function commandRefs(line: string, inFence: boolean): CmdRef[] {
  const out: CmdRef[] = [];
  const clean = (s: string) => s.replace(/[.,:;)]+$/, '');
  const ok = (s: string) => s && !/[<>{}$*]/.test(s) && s !== '--' && !s.startsWith('-');
  let m: RegExpExecArray | null;
  const runRe = /\b(npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([A-Za-z0-9:_.\-]+)/g;
  while ((m = runRe.exec(line))) {
    const name = clean(m[2]);
    if (ok(name) && name !== 'env') out.push({ tool: 'script', name, spelled: `${m[1]} run ${name}` });
  }
  const testRe = /\bnpm\s+test\b/g;
  while ((m = testRe.exec(line))) out.push({ tool: 'script', name: 'test', spelled: 'npm test' });
  const code = inFence ? [line] : codeSpans(line).map((s) => s.text);
  for (const c of code) {
    const bare = /(?:^|[\s;&|(])(pnpm|yarn)\s+([A-Za-z0-9:_.\-]+)/g;
    while ((m = bare.exec(c))) {
      const name = clean(m[2]);
      if (!ok(name) || PM_BUILTINS.has(name)) continue;
      out.push({ tool: 'script', name, spelled: `${m[1]} ${name}` });
    }
    const mk = /(?:^|[\s;&|(])(make|just)\s+([A-Za-z0-9_.\-/]+)/g;
    while ((m = mk.exec(c))) {
      const name = clean(m[2]);
      if (!ok(name)) continue;
      out.push({ tool: m[1] as 'make' | 'just', name, spelled: `${m[1]} ${name}` });
    }
  }
  return out;
}

function staleCommands(ctx: AssessContext, f: InvFile): void {
  const doc = docOf(f);
  const fence = fenceLines(doc);
  const repo = repoFor(ctx, f);
  let scripts: Set<string> | null = null;
  if (repo) {
    scripts = new Set<string>();
    for (const s of repo.scripts.values()) for (const x of s) scripts.add(x);
    const near = nearestScripts(repo, f.abs);
    if (near) for (const x of near) scripts.add(x);
    if (!repo.scripts.size) scripts = null;
  } else if (ctx.repos.some((r) => r.scripts.size)) scripts = allScripts(ctx.repos);
  const where = repo ? displayPath(ctx, repo.root) : 'any repo in the workspace';
  const targets = (tool: 'make' | 'just'): { set: Set<string> | null; any: boolean } => {
    const pick = (r: RepoInfo) => (tool === 'make' ? r.makeTargets : r.justRecipes);
    if (repo) return { set: pick(repo), any: true };
    const all = ctx.repos.map(pick).filter((x): x is Set<string> => !!x);
    const set = new Set<string>();
    for (const s of all) for (const x of s) set.add(x);
    return { set: all.length ? set : null, any: f.level === 'workspace' };
  };
  const seen = new Set<string>();
  doc.lines.forEach((line, i) => {
    const n = i + 1;
    if (doc.frontMatter && n <= doc.frontMatter.end) return;
    for (const c of commandRefs(line, fence.has(n))) {
      const key = `${n}:${c.spelled}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (c.tool === 'script') {
        if (!scripts || scripts.has(c.name)) continue;
        find(ctx, f, 'R04', 'warn', `\`${c.spelled}\` names a script that no package.json defines (${where}).`, n, escapeForReport(line));
        mark(ctx, f, n, 'FIX', 'R04', `stale command: no package.json in ${where} defines "${c.name}"`);
      } else {
        const t = targets(c.tool);
        if (!t.set) {
          if (!t.any) continue;
          find(ctx, f, 'R04', 'warn', `\`${c.spelled}\` needs a ${c.tool === 'make' ? 'Makefile' : 'justfile'}, and there is none (${where}).`, n, escapeForReport(line));
          mark(ctx, f, n, 'FIX', 'R04', `stale command: no ${c.tool === 'make' ? 'Makefile' : 'justfile'} in ${where}`);
        } else if (!t.set.has(c.name)) {
          find(ctx, f, 'R04', 'warn', `\`${c.spelled}\` names a target that the ${c.tool === 'make' ? 'Makefile' : 'justfile'} does not define (${where}).`, n, escapeForReport(line));
          mark(ctx, f, n, 'FIX', 'R04', `stale command: "${c.name}" is not a ${c.tool} target in ${where}`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// R05 stale path
// ---------------------------------------------------------------------------

/** A backticked token that names a repo-relative path, or null. `maybe` paths need their first folder to exist. */
export function pathCandidate(raw: string): { path: string; maybe: boolean } | null {
  let t = raw.trim().replace(/[.,;:)]+$/, '');
  t = t.replace(/:\d+(:\d+)?$/, '').replace(/#.*$/, '');
  if (!t.includes('/') || /\s/.test(t)) return null;
  if (/[<>*$?{}[\]|'"=@!^%&\\]/.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  if (/^[/~-]/.test(t)) return null;
  const segs = t.replace(/\/$/, '').split('/').filter((s) => s && s !== '.');
  if (!segs.length || segs.every((s) => /^\d+$/.test(s))) return null;
  const last = segs[segs.length - 1];
  if (/^\.env|\.local\./.test(last)) return null;
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(last);
  const maybe = !hasExt && !t.endsWith('/') && segs.length < 3;
  return { path: t, maybe };
}

function stalePaths(ctx: AssessContext, f: InvFile): void {
  const doc = docOf(f);
  const fence = fenceLines(doc);
  const bases = [...new Set([f.level === 'user' ? null : path.dirname(f.abs), f.repoRoot, ctx.workspace, ...ctx.repos.map((r) => r.root)].filter((x): x is string => !!x))];
  doc.lines.forEach((line, i) => {
    const n = i + 1;
    if (fence.has(n)) return;
    for (const span of codeSpans(line)) {
      const c = pathCandidate(span.text);
      if (!c) continue;
      const exists = bases.some((b) => fs.existsSync(path.resolve(b, c.path)));
      if (exists) continue;
      if (c.maybe) {
        const first = c.path.split('/').filter((s) => s && s !== '.')[0];
        if (!bases.some((b) => fs.existsSync(path.resolve(b, first)))) continue;
      }
      find(ctx, f, 'R05', 'warn', `\`${c.path}\` does not exist${f.repoRoot ? ` in ${displayPath(ctx, f.repoRoot)}` : ' in the workspace'}.`, n, escapeForReport(line));
      mark(ctx, f, n, 'FIX', 'R05', `stale path: ${c.path} does not exist`);
    }
  });
}

// ---------------------------------------------------------------------------
// R06 duplicates (whole files and paragraphs)
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<string, number> = { repo: 5, workspace: 4, ancestor: 3, user: 2, include: 1 };

/** Higher keeps the copy: lazily loaded (skill/rule) over always-on, then the more specific level. */
function keepScore(f: InvFile): number {
  const lazy = f.kind === 'skill' || f.kind === 'rule' || f.kind === 'command' ? 10 : 0;
  return lazy + (LEVEL_RANK[f.level] ?? 0);
}

function loadedCount(f: InvFile): number {
  return (['devin', 'claude', 'codex'] as AgentId[]).filter((a) => f.loads[a].when !== 'never').length;
}

function duplicates(ctx: AssessContext, files: InvFile[]): void {
  // whole files
  const regular = files.filter((f) => !f.symlinkTo && f.kind !== 'skill' && f.text.trim());
  const bySha = new Map<string, InvFile[]>();
  for (const f of regular) bySha.set(f.sha256, [...(bySha.get(f.sha256) ?? []), f]);
  const wholeDup = new Set<InvFile>();
  for (const group of bySha.values()) {
    if (group.length < 2) continue;
    const keeper = [...group].sort((a, b) => loadedCount(b) - loadedCount(a) || (path.basename(a.abs) === 'AGENTS.md' ? -1 : 1) || a.display.localeCompare(b.display))[0];
    for (const f of group) {
      wholeDup.add(f);
      if (f === keeper) {
        find(ctx, f, 'R06', 'warn', `${f.display} has the same content as ${group.filter((g) => g !== f).map((g) => g.display).join(', ')}; copies drift. Keep this one and point to it (a symlink or an import).`);
        continue;
      }
      find(ctx, f, 'R06', 'warn', `${f.display} is a copy of ${keeper.display}; copies drift. Replace it with a pointer (a symlink or an @import).`);
      for (let n = 1; n <= f.lines; n++) mark(ctx, f, n, 'TRIM', 'R06', `identical copy of ${keeper.display}`);
    }
  }
  // paragraphs
  const occ = new Map<string, Array<{ f: InvFile; u: Unit }>>();
  for (const f of files) {
    if (wholeDup.has(f) || f.symlinkTo) continue;
    for (const u of docOf(f).units) {
      if (!['paragraph', 'list-item', 'fence'].includes(u.kind)) continue;
      const norm = normaliseProse(u.lines.join('\n'));
      if (norm.length < 60 || norm.split(' ').length < 8) continue;
      occ.set(norm, [...(occ.get(norm) ?? []), { f, u }]);
    }
  }
  for (const list of occ.values()) {
    const filesIn = new Set(list.map((x) => x.f));
    if (filesIn.size < 2) continue;
    const keeper = [...list].sort((a, b) => keepScore(b.f) - keepScore(a.f) || a.f.display.localeCompare(b.f.display))[0];
    for (const x of list) {
      if (x.f === keeper.f) continue;
      find(ctx, x.f, 'R06', 'warn', `This paragraph also appears word for word in ${keeper.f.display}:${keeper.u.start}; keep one copy.`, x.u.start, escapeForReport(x.u.lines[0]));
      for (let n = x.u.start; n <= x.u.end; n++) mark(ctx, x.f, n, 'TRIM', 'R06', `duplicated paragraph; the copy in ${keeper.f.display}:${keeper.u.start} stays`);
    }
  }
}

// ---------------------------------------------------------------------------
// R21 oracle rewrite, R22 broken import or link
// ---------------------------------------------------------------------------

const ORACLE = /(--update-snapshots?\b|--snapshot-update\b|\bUPDATE_SNAPSHOTS?=|\btest:update\b|\bsnapshot:update\b|\b(jest|vitest)\b[^\n]*\s-u\b|\s-u\b[^\n]*\b(jest|vitest)\b|\bupdate (the )?(snapshots?|golden files?|expectations?)\b)/i;

function oracleRewrite(ctx: AssessContext, f: InvFile): void {
  const doc = docOf(f);
  doc.lines.forEach((line, i) => {
    const m = ORACLE.exec(line);
    if (!m) return;
    if (NEGATED_BEFORE.test(line.slice(0, m.index))) return;
    find(ctx, f, 'R21', 'warn', `${f.display} tells the agent to rewrite test expectations as a routine step; a failing test then "passes" by changing what it expects.`, i + 1, escapeForReport(line));
    mark(ctx, f, i + 1, 'FIX', 'R21', 'tells the agent to rewrite test expectations (snapshots) as routine');
  });
}

function brokenLinks(ctx: AssessContext, f: InvFile): void {
  for (const imp of ctx.imports) {
    if (imp.from !== f || imp.exists) continue;
    find(ctx, f, 'R22', 'warn', `\`@${imp.target}\` imports a file that does not exist.`, imp.line, escapeForReport(lineOf(docOf(f), imp.line)));
    mark(ctx, f, imp.line, 'FIX', 'R22', `broken import: @${imp.target} does not exist`);
  }
  const doc = docOf(f);
  const fence = fenceLines(doc);
  doc.lines.forEach((line, i) => {
    if (fence.has(i + 1)) return;
    const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      let t = m[1];
      if (/^([a-z][a-z0-9+.-]*:|#|\/|~)/i.test(t)) continue;
      t = t.replace(/[#?].*$/, '');
      try {
        t = decodeURI(t);
      } catch {
        /* keep */
      }
      if (!t || fs.existsSync(path.resolve(path.dirname(f.abs), t))) continue;
      find(ctx, f, 'R22', 'warn', `The link to \`${t}\` points at a file that does not exist.`, i + 1, escapeForReport(line));
      mark(ctx, f, i + 1, 'FIX', 'R22', `broken link: ${t} does not exist`);
    }
  });
}

// ---------------------------------------------------------------------------
// R25 instruction-as-check
// ---------------------------------------------------------------------------

const CHECKABLE: Array<{ re: RegExp; enforcer: string }> = [
  { re: /\bindent(ation|ing|ed)?\b[^.]*\b(tabs?|spaces?)\b|\b(tabs?|spaces?)\b[^.]*\bindent/i, enforcer: 'the formatter config (Prettier / EditorConfig)' },
  { re: /\bsemicolons?\b/i, enforcer: 'the formatter config' },
  { re: /\b(single|double)[- ]quot(e|es|ed|ing)\b/i, enforcer: 'the formatter config' },
  { re: /\btrailing commas?\b/i, enforcer: 'the formatter config' },
  { re: /\b(line length|max(imum)? line|lines? (shorter|longer) than|\d{2,3}\s*(characters|chars|columns))\b/i, enforcer: 'the formatter (printWidth) or ESLint max-len' },
  { re: /\b(run|use)\s+(prettier|black|gofmt|rustfmt|ruff format|dotnet format)\b|\bformat(ted)?\s+with\s+(prettier|black|gofmt|rustfmt)\b/i, enforcer: 'a PostToolUse format hook or a pre-commit hook' },
  { re: /===|!==|\bstrict equality\b|\bloose equality\b/i, enforcer: 'ESLint eqeqeq' },
  { re: /\b(never use|no|avoid|don'?t use|do not use)\s+`?var`?\b|\bprefer\s+`?const`?\b/i, enforcer: 'ESLint no-var / prefer-const' },
  { re: /\bconsole\.(log|error|warn|debug)\b/i, enforcer: 'ESLint no-console' },
  { re: /\b(never use|no|avoid|don'?t use|do not use)\s+`any`|\bexplicit `?any`?\b|\b`any`\s+type\b/i, enforcer: 'typescript-eslint no-explicit-any' },
  { re: /\bdefault exports?\b|\bnamed exports? only\b/i, enforcer: 'ESLint import/no-default-export' },
  { re: /\bimports?\b[^.]*\b(sorted|ordered|alphabeti[sz]ed|grouped)\b|\b(sort|order)\s+(the\s+)?imports\b|\b(relative|absolute|deep) imports?\b/i, enforcer: 'ESLint import rules or dependency-cruiser' },
  { re: /\bunused (variables?|imports?|exports?|code|dependencies)\b/i, enforcer: 'ESLint no-unused-vars or knip' },
  { re: /\b(always\s+)?wrap\b[^.]*\b(in|with)\s+`?[a-z]+[A-Z]\w*`?/, enforcer: 'an ast-grep probe' },
  { re: /\b(kebab|camel|pascal|snake|screaming[_ ]snake)[- ]?case\b|\bPascalCase\b|\bcamelCase\b|\bsnake_case\b|\bkebab-case\b/i, enforcer: 'a naming lint rule or an ast-grep probe' },
  { re: /\b(every|each|all|any|new)\b[^.]*\b(modules?|files?|functions?|features?|endpoints?|components?|classes|routes?|handlers?|bug ?fix(es)?)\b[^.]*\b(has|have|gets?|needs?|must have|requires?|should have|with)\b[^.]*\btests?\b/i, enforcer: 'a gate step that checks a test exists per changed module' },
  { re: /\b(add|write|include)\b[^.]*\btests?\b[^.]*\b(for|with)\b[^.]*\b(every|each|all|new|any)\b/i, enforcer: 'a gate step that checks a test exists per change' },
  { re: /\b(run|make sure|ensure)\b[^.]*\b(tests?|test suite|lint|linter|typecheck|type-check|tsc|build|format:check)\b[^.]*\b(before|prior to)\b[^.]*\b(commit|push|pr|pull request|merg|finish|done|hand|stop)/i, enforcer: 'a done-gate step or a pre-commit hook' },
  { re: /\b(tests?|lint|linter|eslint|typecheck|type-check|tsc|build)\b[^.]*\b(must|should|has to|needs? to)\b[^.]*\b(pass|be clean|succeed|be green)\b/i, enforcer: 'a done-gate step' },
  { re: /\bcoverage\b[^.]*\b\d+\s*%/i, enforcer: 'a coverage threshold in the test runner config' },
  { re: /\b(conventional commits?|commit (messages?|subjects?)|subject lines?)\b/i, enforcer: 'a commit-msg hook (commitlint)' },
  { re: /\bsigned[- ]off[- ]by\b/i, enforcer: 'a commit-msg hook' },
  { re: /\bstrict (mode|typescript|null checks?)\b|\bstrictNullChecks\b|\bnoImplicitAny\b|@ts-ignore|@ts-expect-error|\bts-nocheck\b/i, enforcer: 'a tsconfig option or a lint rule' },
  { re: /\b(parameteri[sz]ed|named parameters?|bind (variables|parameters)|prepared statements?)\b|\bstring (interpolation|concatenation)\b[^.]*\b(sql|quer)|\b(sql|quer\w*)\b[^.]*\bstring (interpolation|concatenation|templates?)\b/i, enforcer: 'a lint rule or an ast-grep probe for SQL parameters' },
  { re: /\bselect \*/i, enforcer: 'a SQL lint rule' },
  { re: /\b(do not|don'?t|never)\s+(edit|modify|change|touch|write to)\b[^.]*\b(generated|vendor|lock ?files?|package-lock|dist\/|migrations?\/|\.lock\b)/i, enforcer: 'a PreToolUse hook that protects those paths' },
  { re: /\b(do not|don'?t|never)\s+(add|install|introduce)\b[^.]*\b(dependenc(y|ies)|packages?|libraries)\b/i, enforcer: 'a gate step that checks the dependency diff' },
  { re: /\b(functions?|files?|methods?|modules?)\b[^.]*\b(under|at most|no more than|fewer than|less than|max(imum)?( of)?)\s+\d+\s+lines?\b/i, enforcer: 'ESLint max-lines / max-lines-per-function' },
];

const DIRECTIVE_START = /^(always|never|do not|don'?t|must|should|avoid|prefer|use|keep|wrap|run|add|write|name|make sure|ensure|only|put|place|follow|stick to|limit|format|sort|mark|commit|validate|parameteri[sz]e|declare|define|handle|return|throw|log|every|each|all|new|no)\b/i;
const MODAL = /\b(must|should|shall|never|always|do not|don'?t|needs? to|has to|have to|required)\b/i;
/** Declarative rule forms: "File names are kebab-case", "each module gets a test", "messages follow Conventional Commits". */
const DECLARATIVE = /\b(are|is)\s+(in\s+)?(kebab|camel|pascal|snake|screaming)|\bgets?\s+(a|an|its own)\s+(unit\s+|integration\s+)?tests?\b|\bfollows?\b[^.]*\bconventional commits?\b|\b(stay|stays|kept)\s+(under|below)\s+\d+/i;

/** The enforcer for a sentence that a lint rule, test, hook or gate step could check; null otherwise. */
export function checkableRule(sentence: string): string | null {
  const s = sentence.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim();
  if (s.split(/\s+/).length < 3) return null;
  if (!DIRECTIVE_START.test(s.replace(/^[`*_"']+/, '')) && !MODAL.test(s) && !DECLARATIVE.test(s)) return null;
  if (/\?\s*$/.test(s)) return null;
  for (const c of CHECKABLE) if (c.re.test(s)) return c.enforcer;
  return null;
}

function instructionsAsChecks(ctx: AssessContext, f: InvFile, configEnforced: (s: string) => string | null): void {
  const doc = docOf(f);
  for (const u of proseUnits(doc)) {
    const ss = sentences(unitText(u));
    const substantive = ss.filter((s) => s.split(/\s+/).length >= 4);
    const hits = ss.map((s) => ({ s, enforcer: checkableRule(s) })).filter((x) => x.enforcer && !safetyTopic(x.s));
    if (!hits.length) continue;
    const enforced = hits.map((h) => configEnforced(h.s)).find(Boolean);
    const enforcer = enforced ? `already enforced by ${enforced}` : `could be enforced by ${hits[0].enforcer}`;
    const partial = substantive.length > hits.length;
    find(ctx, f, 'R25', 'info', `This instruction ${enforcer}; a check holds every time, prose only sometimes.`, u.start, escapeForReport(u.lines[0]));
    mark(ctx, f, u.start, 'CONVERT', 'R25', partial ? `part of this paragraph ${enforcer}; split the checkable sentence from the guidance` : `deterministic check: ${enforcer}`, partial);
  }
}

// ---------------------------------------------------------------------------
// R26 derivable content
// ---------------------------------------------------------------------------

const DERIVABLE_HEADING = /\b(layout|structure|director(y|ies)|folders?|file (map|tree|layout|structure)|project (overview|structure|layout|map)|repo(sitory)? (map|overview|structure|layout)|tree|codebase (overview|map|structure)|tables|schema|scripts|available (commands|scripts)|package scripts|tech stack|dependencies)\b/i;

function stripTree(l: string): string {
  return l.replace(/[│├└┬┼─|`+\\]--|[│├└┬┼─]+/g, ' ').replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim();
}

export function pathLikeLine(l: string): boolean {
  const s = stripTree(l);
  if (!s) return false;
  if (/[│├└]/.test(l)) return true;
  const toks = s.split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const pathy = toks.filter((t) => /^[\w.@{},\-/*]+\/?$/.test(t) && (t.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(t) || /[{,}]/.test(t)));
  return pathy.length >= 1 && pathy.length >= toks.length * 0.6;
}

function schemaLike(s: string): boolean {
  return /\b\w+\s*\(\s*\w+(\s*,\s*\w+){2,}\s*\)/.test(s);
}

function scriptList(s: string, names: Set<string>): boolean {
  const m = /^(?:[-*+]\s+)?(?:\*\*)?[A-Za-z ]*\b(scripts?|commands?)\b[^:]*:\s*(.+)$/i.exec(s);
  if (!m) return false;
  const items = m[2].split(/[,;]\s*|\s+and\s+/).map((x) => x.replace(/[`.*\s]/g, '')).filter(Boolean);
  return items.filter((x) => names.has(x)).length >= 3;
}

function withFlags(u: Unit): boolean {
  return codeSpans(u.lines.join(' ')).some((c) => /\s--?[A-Za-z]/.test(c.text));
}

function derivable(ctx: AssessContext, f: InvFile): void {
  if (f.kind === 'skill' || f.kind === 'command' || f.kind === 'subagent') return;
  const doc = docOf(f);
  const names = allScripts(ctx.repos);
  const marked = new Set<number>();
  const block = (start: number, end: number, what: string) => {
    const size = end - start + 1;
    find(ctx, f, 'R26', size >= 8 ? 'warn' : 'info', `${what} (${size} lines) restates what an agent can read from the repo itself; it costs context every session and goes stale.`, start, escapeForReport(lineOf(doc, start)));
    for (let n = start; n <= end; n++) {
      marked.add(n);
      mark(ctx, f, n, 'TRIM', 'R26', `derivable: ${what.toLowerCase()}; the agent can read it from the repo`);
    }
  };
  // (a) sections with a derivable heading whose content is mostly derivable
  for (const sec of doc.sections) {
    if (!DERIVABLE_HEADING.test(sec.title)) continue;
    const units = doc.units.filter((u) => u.start > sec.start && u.end <= sec.end && u.kind !== 'blank');
    if (!units.length) continue;
    if (units.some((u) => u.kind === 'heading')) continue; // a parent section: judge the sub-sections instead
    const keep = units.filter(withFlags);
    const derivableUnits = units.filter((u) => {
      if (u.kind === 'fence') return u.lines.slice(1, -1).filter((l) => l.trim()).filter(pathLikeLine).length >= Math.max(1, u.lines.slice(1, -1).filter((l) => l.trim()).length * 0.6);
      const text = u.lines.join(' ');
      return pathLikeLine(text) || schemaLike(text) || scriptList(unitText(u), names) || u.lines.every((l) => pathLikeLine(l));
    });
    if (derivableUnits.length < Math.max(1, (units.length - keep.length) * 0.6)) continue;
    let end = sec.end;
    while (end > sec.start && !doc.lines[end - 1].trim()) end--;
    if (keep.length) {
      for (const u of derivableUnits) if (!keep.includes(u)) block(u.start, u.end, `A derivable block under "${sec.title}"`);
    } else block(sec.start, end, `The section "${sec.title}"`);
  }
  // (b) tree-shaped fences and (c) script listings anywhere else
  for (const u of doc.units) {
    if (marked.has(u.start)) continue;
    if (u.kind === 'fence') {
      const body = u.lines.slice(1, -1).filter((l) => l.trim());
      if (body.length >= 4 && (body.some((l) => /[│├└]/.test(l)) || body.filter(pathLikeLine).length >= body.length * 0.7)) block(u.start, u.end, 'A file map');
    } else if ((u.kind === 'paragraph' || u.kind === 'list-item') && scriptList(unitText(u), names)) {
      block(u.start, u.end, 'A list of package.json scripts');
    }
  }
}

// ---------------------------------------------------------------------------
// R27 polarity ratio
// ---------------------------------------------------------------------------

function polarity(ctx: AssessContext, f: InvFile): void {
  if (f.kind !== 'instructions' && f.kind !== 'rule') return;
  let pos = 0;
  let neg = 0;
  for (const u of proseUnits(docOf(f))) {
    for (const s of sentences(unitText(u))) {
      if (/^\W*(never|do not|don'?t|must not|avoid|no)\b|\b(never|must not|do not|don'?t)\b/i.test(s)) neg++;
      else if (DIRECTIVE_START.test(s.replace(/^[`*_"']+/, '')) || /\b(must|should|always)\b/i.test(s)) pos++;
    }
  }
  if (pos + neg < 4) return;
  const pct = Math.round((neg / (pos + neg)) * 100);
  find(ctx, f, 'R27', 'info', `${f.display}: ${pos} positive directives and ${neg} negative constraints (${pct}% negative).`, undefined, `${pos}/${neg}`);
}

// ---------------------------------------------------------------------------
// R29 rule-vs-config and R30 cross-file contradictions
// ---------------------------------------------------------------------------

export interface Claim {
  topic: string;
  value: string;
  /** Plain words for messages. */
  says: string;
}

const NEG_WORDS = /\b(never|not|no|don'?t|do not|avoid|instead of|rather than|without|omit|skip|drop|remove|strip|forbid(den)?|ban(ned)?)\b(\s+\S+){0,2}\s*$/i;

function mentions(s: string, re: RegExp): Array<'+' | '-'> {
  const out: Array<'+' | '-'> = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(s))) {
    out.push(NEG_WORDS.test(s.slice(Math.max(0, m.index - 30), m.index)) ? '-' : '+');
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

function decide(pos: Array<'+' | '-'>, alt: Array<'+' | '-'>): '+' | '-' | null {
  // value of the first option: + when it is affirmed (or the alternative is denied), - when denied (or the alternative affirmed)
  const a = pos.includes('+') ? 1 : 0;
  const b = alt.includes('+') ? 1 : 0;
  const an = pos.includes('-') ? 1 : 0;
  const bn = alt.includes('-') ? 1 : 0;
  if ((a || bn) && !(b || an)) return '+';
  if ((b || an) && !(a || bn)) return '-';
  return null;
}

/** Style claims of a sentence (indentation, semicolons, quotes, trailing commas, line width, equality, console, var, any, package manager). */
export function styleClaims(sentence: string): Claim[] {
  const s = sentence.replace(/[`*_]/g, '').toLowerCase();
  const out: Claim[] = [];
  if (/\bindent/.test(s) || (/\btabs?\b/.test(s) && /\bspaces?\b/.test(s))) {
    const v = decide(mentions(s, /\btabs?\b/), mentions(s, /\bspaces?\b/));
    if (v) out.push({ topic: 'indent-style', value: v === '+' ? 'tab' : 'space', says: v === '+' ? 'indent with tabs' : 'indent with spaces' });
    const size = /\b([248])[- ]?spaces?\b/.exec(s);
    if (size) out.push({ topic: 'indent-size', value: size[1], says: `indent by ${size[1]}` });
  }
  if (/\bsemicolons?\b/.test(s)) {
    const p = mentions(s, /\bsemicolons?\b/);
    if (p.length && p.every((x) => x === p[0])) out.push({ topic: 'semi', value: p[0] === '+' ? 'true' : 'false', says: p[0] === '+' ? 'use semicolons' : 'no semicolons' });
  }
  if (/\b(single|double)[- ]quot/.test(s)) {
    const v = decide(mentions(s, /\bsingle[- ]quot\w*/), mentions(s, /\bdouble[- ]quot\w*/));
    if (v) out.push({ topic: 'quotes', value: v === '+' ? 'single' : 'double', says: v === '+' ? 'single quotes' : 'double quotes' });
  }
  if (/\btrailing commas?\b/.test(s)) {
    const p = mentions(s, /\btrailing commas?\b/);
    if (p.length && p.every((x) => x === p[0])) out.push({ topic: 'trailing-comma', value: p[0] === '+' ? 'all' : 'none', says: p[0] === '+' ? 'use trailing commas' : 'no trailing commas' });
  }
  const width = /\b(\d{2,3})\s*-?\s*(characters?|chars?|columns?|cols?)\b/.exec(s);
  if (width && /\blines?\b/.test(s)) out.push({ topic: 'print-width', value: width[1], says: `lines up to ${width[1]} characters` });
  if (/===|==|equality/.test(s)) {
    const v = decide(mentions(s, /===|!==|strict equality/), mentions(s, /(?<![=!])[=!]=(?!=)|loose equality/));
    if (v) out.push({ topic: 'eqeqeq', value: v === '+' ? 'strict' : 'loose', says: v === '+' ? 'use === (strict equality)' : 'use == (loose equality)' });
  }
  if (/\bconsole\.(log|error|warn|debug)\b/.test(s)) {
    const p = mentions(s, /\bconsole\.(log|error|warn|debug)\b/);
    const allow = /\b(is|are)\s+(fine|ok|okay|allowed|acceptable)\b|\buse console\./.test(s);
    if (p.includes('-') && !allow) out.push({ topic: 'console', value: 'forbid', says: 'no console.log' });
    else if (allow && !p.includes('-')) out.push({ topic: 'console', value: 'allow', says: 'console.log is allowed' });
  }
  if (/\bvar\b/.test(sentence.replace(/[*_]/g, '')) && /`var`|\bvar\s+(declarations?|keyword)\b|\buse\s+var\b|\bno\s+var\b/.test(s)) {
    const p = mentions(s, /\bvar\b/);
    if (p.length && p.every((x) => x === p[0])) out.push({ topic: 'var', value: p[0] === '+' ? 'allow' : 'forbid', says: p[0] === '+' ? 'var is allowed' : 'no var' });
  }
  if (/`any`/.test(sentence) || /\b(explicit any|type any|any type)\b/.test(s)) {
    const p = mentions(s, /\bany\b(?=\s*(type|\b))/);
    const allow = /\b(is|are)\s+(fine|ok|okay|allowed|acceptable)\b/.test(s);
    if (allow) out.push({ topic: 'any', value: 'allow', says: '`any` is allowed' });
    else if (p.includes('-')) out.push({ topic: 'any', value: 'forbid', says: 'no `any`' });
  }
  const pm = /\b(?:use|prefer|only use|always use)\s+(npm|pnpm|yarn|bun)\b(?!\s+(run|test|install|ci|exec|start|x)\b)/.exec(s);
  if (pm) out.push({ topic: 'package-manager', value: pm[1], says: `use ${pm[1]}` });
  return out;
}

const ACTION = /^(?:(?:please|also|only|and|then)\s+)?(?:(never|do not|don'?t|must not|should not|shouldn'?t|avoid)\s+)?(?:always\s+)?(run|execute|use|commit|push|merge|install|edit|modify|deploy|rebase|squash|apply|update)\s+(.+)$/i;
const OBJ_CUT = /\b(with|before|after|when|whenever|while|in|on|for|to|into|from|against|locally|unless|if|because|since|so|until|by|as|at|once|then|and|or|but|instead)\b|[,;:.()!?]/i;
const ARTICLES = /\b(the|a|an|your|our|any|all|this|that|these|those|its|their|every|each)\b/g;

/** An action claim ("run the full test suite" / "do not run ..."), or null. */
export function actionClaim(clause: string): Claim | null {
  const c = clause.replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(/[`*_"']/g, '').trim();
  const m = ACTION.exec(c);
  if (!m) return null;
  const neg = !!m[1];
  const verb = m[2].toLowerCase() === 'execute' ? 'run' : m[2].toLowerCase();
  const rest = m[3];
  const cut = OBJ_CUT.exec(rest);
  let obj = (cut ? rest.slice(0, cut.index) : rest).toLowerCase().replace(ARTICLES, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(full|whole|entire|complete)\s+(test\s+)?suite\b|^test suite$|^suite$|^npm test$|^tests$/.test(obj)) obj = 'full test suite';
  if (!obj || obj.split(' ').length > 5) return null;
  let qual = '';
  if (cut) {
    const after = rest.slice(cut.index).toLowerCase();
    const q = /^(locally)\b|^(?:in|on|against|to|into|from)\s+(?:the\s+|a\s+|an\s+)?([\w-]+(?:\s+[\w-]+)?)/.exec(after);
    if (q) qual = q[1] ? 'local' : q[2].replace(ARTICLES, '').trim();
  }
  return { topic: `do:${verb}:${obj}${qual ? '@' + qual : ''}`, value: neg ? '-' : '+', says: `${neg ? 'do not ' : ''}${verb} ${obj}${qual ? ` (${qual})` : ''}` };
}

interface Located {
  f: InvFile;
  line: number;
  claim: Claim;
}

function claimsOf(f: InvFile): Located[] {
  const out: Located[] = [];
  for (const u of proseUnits(docOf(f))) {
    for (const s of sentences(unitText(u))) {
      const probe = s.replace(/[`*_]/g, '').slice(0, 16);
      let line = u.start;
      for (let i = 0; i < u.lines.length; i++) if (u.lines[i].replace(/[`*_]/g, '').includes(probe)) line = u.start + i;
      for (const c of styleClaims(s)) out.push({ f, line, claim: c });
      for (const clause of s.split(/;\s*/)) {
        const a = actionClaim(clause);
        if (a) out.push({ f, line, claim: a });
      }
    }
  }
  return out;
}

function configValues(r: RepoInfo): Record<string, { value: string; file: string; explicit: boolean }> {
  const out: Record<string, { value: string; file: string; explicit: boolean }> = {};
  const p = r.prettier;
  if (p) {
    out['indent-style'] = { value: p.useTabs ? 'tab' : 'space', file: p.file, explicit: p.explicit.has('useTabs') };
    if (!p.useTabs) out['indent-size'] = { value: String(p.tabWidth), file: p.file, explicit: p.explicit.has('tabWidth') };
    out.semi = { value: String(p.semi), file: p.file, explicit: p.explicit.has('semi') };
    out.quotes = { value: p.singleQuote ? 'single' : 'double', file: p.file, explicit: p.explicit.has('singleQuote') };
    out['trailing-comma'] = { value: p.trailingComma === 'none' ? 'none' : 'all', file: p.file, explicit: p.explicit.has('trailingComma') };
  }
  const e = r.editorconfig;
  if (e?.indentStyle && !out['indent-style']) out['indent-style'] = { value: e.indentStyle, file: e.file, explicit: true };
  if (e?.indentSize && !out['indent-size']) out['indent-size'] = { value: String(e.indentSize), file: e.file, explicit: true };
  const l = r.eslint;
  if (l) {
    const on = (k: string) => l.rules.get(k);
    const eq = on('eqeqeq');
    if (eq) out.eqeqeq = { value: eq === 'off' ? 'loose' : 'strict', file: l.file, explicit: true };
    const nc = on('no-console');
    if (nc) out.console = { value: nc === 'off' ? 'allow' : 'forbid', file: l.file, explicit: true };
    const nv = on('no-var');
    if (nv) out.var = { value: nv === 'off' ? 'allow' : 'forbid', file: l.file, explicit: true };
    const na = on('@typescript-eslint/no-explicit-any');
    if (na) out.any = { value: na === 'off' ? 'allow' : 'forbid', file: l.file, explicit: true };
  }
  return out;
}

const CONFIG_WORDS: Record<string, (v: string) => string> = {
  'indent-style': (v) => (v === 'tab' ? 'useTabs: true (tabs)' : 'useTabs: false (spaces)'),
  'indent-size': (v) => `an indent of ${v}`,
  semi: (v) => (v === 'true' ? 'semi: true' : 'semi: false'),
  quotes: (v) => (v === 'single' ? 'singleQuote: true' : 'singleQuote: false (double quotes)'),
  'trailing-comma': (v) => (v === 'none' ? 'trailingComma: none' : 'trailing commas on'),
  eqeqeq: (v) => (v === 'strict' ? 'eqeqeq on' : 'eqeqeq off'),
  console: (v) => (v === 'forbid' ? 'no-console on' : 'no-console off'),
  var: (v) => (v === 'forbid' ? 'no-var on' : 'no-var off'),
  any: (v) => (v === 'forbid' ? 'no-explicit-any on' : 'no-explicit-any off'),
};

function contradictions(ctx: AssessContext, files: InvFile[]): (sentence: string, f?: InvFile) => string | null {
  const all: Located[] = [];
  for (const f of files) all.push(...claimsOf(f));
  const reposFor = (f: InvFile) => (f.repoRoot ? ctx.repos.filter((r) => r.root === f.repoRoot) : ctx.repos);
  // R29: a claim against the resolved config of the repos the file applies to
  const doneR29 = new Set<string>();
  for (const c of all) {
    if (c.claim.topic.startsWith('do:') || c.claim.topic === 'package-manager' || c.claim.topic === 'print-width') continue;
    const repos = reposFor(c.f);
    const against = repos.map((r) => ({ r, cfg: configValues(r)[c.claim.topic] })).filter((x) => x.cfg && x.cfg.value !== c.claim.value);
    const withCfg = repos.filter((r) => configValues(r)[c.claim.topic]);
    if (!against.length) continue;
    const key = `${c.f.abs}:${c.line}:${c.claim.topic}`;
    if (doneR29.has(key)) continue;
    doneR29.add(key);
    const cfg = against[0].cfg;
    const tool = /eslint/i.test(cfg.file) ? 'ESLint would reject it' : 'the formatter would undo it';
    find(ctx, c.f, 'R29', 'warn', `Says "${c.claim.says}", but ${cfg.file} sets ${CONFIG_WORDS[c.claim.topic](cfg.value)}${cfg.explicit ? '' : ' (by default)'}${withCfg.length > 1 ? ` (${against.length} of ${withCfg.length} repos)` : ''}; ${tool}.`, c.line, escapeForReport(lineOf(docOf(c.f), c.line)));
    mark(ctx, c.f, c.line, 'FIX', 'R29', `contradicts ${cfg.file} (${CONFIG_WORDS[c.claim.topic](cfg.value)}); the config wins, so the rule must change or the config must`);
  }
  // R30: two files disagree
  const byTopicBase = new Map<string, Located[]>();
  for (const c of all) {
    const base = c.claim.topic.split('@')[0];
    byTopicBase.set(base, [...(byTopicBase.get(base) ?? []), c]);
  }
  const doneR30 = new Set<string>();
  for (const list of byTopicBase.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.f === b.f || a.claim.value === b.claim.value) continue;
        const qa = a.claim.topic.split('@')[1] ?? '';
        const qb = b.claim.topic.split('@')[1] ?? '';
        if (qa && qb && qa !== qb) continue;
        for (const [x, y] of [
          [a, b],
          [b, a],
        ]) {
          const key = `${x.f.abs}:${x.line}:${y.f.abs}`;
          if (doneR30.has(key)) continue;
          doneR30.add(key);
          find(ctx, x.f, 'R30', 'warn', `Says "${x.claim.says}", but ${y.f.display}:${y.line} says "${y.claim.says}"; the two files contradict each other and the user has to pick one.`, x.line, escapeForReport(lineOf(docOf(x.f), x.line)));
          mark(ctx, x.f, x.line, 'FIX', 'R30', `contradicts ${y.f.display}:${y.line} ("${y.claim.says}")`);
        }
      }
    }
  }
  // for R25: a config that already enforces a sentence
  return (sentence: string, f?: InvFile) => {
    for (const c of styleClaims(sentence)) {
      for (const r of f ? reposFor(f) : ctx.repos) {
        const cfg = configValues(r)[c.topic];
        if (cfg && cfg.value === c.value && cfg.explicit) return `${cfg.file} (${CONFIG_WORDS[c.topic](cfg.value)})`;
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// R31 stale agent-feature facts (small, dated table)
// ---------------------------------------------------------------------------

/** Checked against the agents' documentation on 2026-10-18. Keep this table small. */
export const STALE_FACTS: Array<{ re: RegExp; unless?: RegExp; fact: string; severity: 'warn' | 'info' }> = [
  { re: /(?<!(DELETE|UPDATE|delete|update)\s)\bCascade\b/, unless: /\b(legacy|removed|former(ly)?|old|deprecated|was)\b/i, fact: 'Cascade was removed from Devin Desktop in v3.9.19 (2026-09-08); Devin Local is the agent now.', severity: 'warn' },
  { re: /\b(12,?000|6,?000)\s*(char|chars|characters)\b/i, fact: 'The 12,000 / 6,000-character limits applied to legacy Cascade rule files; Devin Local documents no limit.', severity: 'warn' },
  { re: /\b(windsurf|devin|cascade)\b[^.]*\bmemor(y|ies)\b|\bmemor(y|ies)\b[^.]*\b(windsurf|devin|cascade)\b/i, fact: 'Memories apply only to the legacy Cascade agent; Devin Local does not support them.', severity: 'warn' },
  { re: /\.(windsurf|devin)\/workflows\b|\bwindsurf workflows?\b/i, fact: 'Workflows are deprecated in favour of skills; Devin Local does not use them.', severity: 'warn' },
  { re: /\bturbo mode\b/i, fact: 'Turbo mode was a Cascade setting; Devin Local has permission modes (Normal, Accept Edits, Smart, Bypass, Autonomous).', severity: 'warn' },
  { re: /\b(claude code|claude|codex|devin)\b[^.]*\b(does not|doesn'?t|cannot|can'?t|has no|lacks|do not|don'?t)\b[^.]*\b(support\s+)?(hooks?|skills?|stop hooks?)\b/i, fact: 'Claude Code, Codex and Devin Local all support hooks (Stop included) and Agent Skills.', severity: 'warn' },
  { re: /--full-auto\b/, fact: 'codex exec --full-auto was removed; unattended runs use --sandbox workspace-write with an approval policy.', severity: 'warn' },
  { re: /\bdevin\b[^.]*\bknowledge\b/i, fact: 'Devin Knowledge is deprecated and being migrated to skills in plugins.', severity: 'warn' },
  { re: /\bWindsurf\b/, unless: /\b(renamed|formerly|legacy|old|Devin Desktop)\b|\.windsurf/i, fact: 'Windsurf was renamed Devin Desktop on 2026-06-02.', severity: 'info' },
];

function staleFacts(ctx: AssessContext, f: InvFile): void {
  const doc = docOf(f);
  const fence = fenceLines(doc);
  doc.lines.forEach((line, i) => {
    if (fence.has(i + 1)) return;
    for (const s of STALE_FACTS) {
      if (!s.re.test(line) || (s.unless && s.unless.test(line))) continue;
      find(ctx, f, 'R31', s.severity, `Stale fact about an agent feature: ${s.fact} (checked against agent documentation on 2026-10-18)`, i + 1, escapeForReport(line));
      if (s.severity === 'warn') mark(ctx, f, i + 1, 'FIX', 'R31', `stale fact: ${s.fact}`);
      break;
    }
  });
}

// ---------------------------------------------------------------------------
// R19 AI policy
// ---------------------------------------------------------------------------

const AI_POLICY = /\b(automated (prs|pull requests|contributions)|ai-generated|ai generated|generated by ai|llm-generated|autonomous agents? (are|is) not allowed|no ai(-| )(generated|assisted))\b/i;

function aiPolicy(ctx: AssessContext): void {
  for (const f of ctx.files) {
    if (path.basename(f.abs) === 'AI_POLICY.md') {
      find(ctx, f, 'R19', 'info', `${f.display} is an AI contribution policy; the harness respects it as a boundary.`);
      continue;
    }
    if (!PROSE_KINDS.has(f.kind)) continue;
    const i = f.text.split(/\r?\n/).findIndex((l) => AI_POLICY.test(l));
    if (i >= 0) find(ctx, f, 'R19', 'info', `${f.display} states an AI contribution policy; the harness respects it as a boundary.`, i + 1, escapeForReport(f.text.split(/\r?\n/)[i]));
  }
  for (const p of docFiles(ctx, /^CONTRIBUTING[^/]*\.(md|markdown|txt)$/i)) {
    const lines = (readTextOr(p, '') ?? '').split(/\r?\n/);
    const i = lines.findIndex((l) => AI_POLICY.test(l));
    if (i >= 0) find(ctx, p, 'R19', 'info', `${displayPath(ctx, p)} states an AI contribution policy; the harness respects it as a boundary.`, i + 1, escapeForReport(lines[i]));
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function proseChecks(ctx: AssessContext): void {
  const files = proseFiles(ctx);
  for (const f of files) {
    staleCommands(ctx, f);
    stalePaths(ctx, f);
    oracleRewrite(ctx, f);
    brokenLinks(ctx, f);
    derivable(ctx, f);
    polarity(ctx, f);
    staleFacts(ctx, f);
  }
  duplicates(ctx, files);
  const enforcedBy = contradictions(ctx, files);
  for (const f of files) instructionsAsChecks(ctx, f, (s) => enforcedBy(s, f));
  aiPolicy(ctx);
}
