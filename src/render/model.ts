/**
 * Shared model of the rendered harness (DESIGN 2.4): what one rendered file
 * is, the marker blocks the harness owns inside a user's file, the size
 * limits of the always-on file, and the per-repo facts read from the
 * discovery inventory (`~/.harness/ledger/inventory.json`).
 *
 * Everything here is data or a pure function. Nothing is setup-specific:
 * names, paths and commands come from the inventory at run time.
 */
import * as path from 'node:path';
import type { AgentId, HarnessConfig, Hunk, Ledger, RepoRef, Setting } from '../types';
import { verifyCommandFor } from '../hooks/repoindex';

/** Markdown markers around the harness-owned block of an instruction file. */
export const MD_BEGIN = '<!-- harness:begin (generated; change it with `harness propose`, not by hand) -->';
export const MD_END = '<!-- harness:end -->';
/** The same markers for `#`-comment files (.gitignore, TOML). */
export const HASH_BEGIN = '# harness:begin (generated; change it with `harness propose`, not by hand)';
export const HASH_END = '# harness:end';

/** DESIGN 2.4: the always-on file stays at or under ~4 KB and 60 harness-owned lines. */
export const ALWAYS_ON_MAX_BYTES = 4096;
export const ALWAYS_ON_MAX_LINES = 60;

/** A hunk as the plan stores it; `contentHash` keys rejections (check, path, content hash). */
export type PlanHunk = Hunk;

export type RenderRole =
  | 'always-on'
  | 'claude-pointer'
  | 'scoped'
  | 'skill'
  | 'skill-ref'
  | 'settings'
  | 'hooks'
  | 'rules'
  | 'toml'
  | 'git-hook'
  | 'ci'
  | 'repo-config'
  | 'tasks'
  | 'gitignore'
  | 'prettierignore';

/**
 * One file the harness renders.
 *   text   the whole file (create, or replace when generated and pristine)
 *   block  a marker block upserted into the file (user files keep their own text)
 *   json   a fragment unioned into a JSON settings file (merge-json)
 */
export interface RenderedFile {
  path: string;
  kind: 'text' | 'block' | 'json';
  content: string;
  role: RenderRole;
  agent?: AgentId;
  /** For `block`: comment style of the markers and where a new block goes. */
  block?: { style: 'md' | 'hash'; position: 'start' | 'end' };
  /** POSIX file mode (git hooks are 0o755). */
  mode?: number;
  hunks: PlanHunk[];
}

/** One row of the rule-to-enforcer table. */
export interface RuleRow {
  rule: string;
  enforcer: string;
  /** Ledger id or rail id, for provenance. */
  id: string;
  /** A few words for the compact one-line form. */
  short?: string;
}

export interface InventoryPackage {
  id?: string;
  name?: string;
  dir: string;
  scripts?: Record<string, string>;
}

export interface InventoryRepo {
  id: string;
  name: string;
  path: string;
  relPath?: string;
  isGit?: boolean;
  packageManager?: string;
  packages?: InventoryPackage[];
}

/** The part of discovery's inventory.json the renderer reads. */
export interface LedgerInventory {
  version?: number;
  workspaceRoot?: string;
  repos: InventoryRepo[];
}

export interface RenderContext {
  setting: Setting;
  agents: AgentId[];
  /** Team: the folder holding the repos. Personal: the repository. Absolute. */
  workspaceRoot: string;
  /** Personal: the repository root (same as workspaceRoot). */
  repoRoot?: string;
  userHome: string;
  harnessHome: string;
  packageRoot: string;
  platform: NodeJS.Platform;
  ledger: Ledger | null;
  inventory: LedgerInventory | null;
  config: HarnessConfig | null;
  harnessVersion: string;
  /** Rule rows the plan builder adds (CONVERT lines matched to a ledger check). */
  extraRules?: RuleRow[];
  /** Text moved out of user files by SPLIT, rendered as the task skill's reference file. */
  references?: Array<{ origin: string; text: string }>;
  /** Extra pointer lines for the always-on file (e.g. files an agent stops loading). */
  pointers?: string[];
  /**
   * Approved prose lessons (src/learn): instruction lines go into the always-on
   * file's "Never" list as negative constraints with their review date; skill
   * text goes to the task skill's `references/lessons.md`.
   */
  lessons?: Array<{ id: string; rung: 'instruction' | 'skill'; text: string; reviewBy?: string }>;
}

// ---------------------------------------------------------------------------
// marker blocks
// ---------------------------------------------------------------------------

function markers(style: 'md' | 'hash'): [string, string] {
  return style === 'md' ? [MD_BEGIN, MD_END] : [HASH_BEGIN, HASH_END];
}

function isBegin(line: string, style: 'md' | 'hash'): boolean {
  return style === 'md' ? /^<!-- harness:begin\b/.test(line.trim()) : /^# harness:begin\b/.test(line.trim());
}

function isEnd(line: string, style: 'md' | 'hash'): boolean {
  return style === 'md' ? line.trim() === MD_END : line.trim() === HASH_END;
}

/** The text between the markers (without them), or null when the file has no block. */
export function extractBlock(text: string, style: 'md' | 'hash'): string | null {
  const lines = text.split('\n');
  const b = lines.findIndex((l) => isBegin(l, style));
  if (b < 0) return null;
  const e = lines.findIndex((l, i) => i > b && isEnd(l, style));
  if (e < 0) return null;
  return lines.slice(b + 1, e).join('\n');
}

/** The file without the harness block (and the blank line the block added). */
export function removeBlock(text: string, style: 'md' | 'hash'): string {
  const lines = text.split('\n');
  const b = lines.findIndex((l) => isBegin(l, style));
  if (b < 0) return text;
  const e = lines.findIndex((l, i) => i > b && isEnd(l, style));
  if (e < 0) return text;
  let start = b;
  let end = e + 1;
  if (start > 0 && lines[start - 1] === '' && (end >= lines.length || lines[end] === '' || start === lines.length)) start--;
  else if (end < lines.length && lines[end] === '' && start === 0) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/**
 * Insert or replace the harness block. The user's own text is never touched:
 * an existing block is replaced in place; a new one goes at the start or the
 * end, separated by one blank line.
 */
export function upsertBlock(existing: string | null, body: string, style: 'md' | 'hash', position: 'start' | 'end'): string {
  const [begin, end] = markers(style);
  const blockText = `${begin}\n${body.replace(/\n+$/, '')}\n${end}`;
  const cur = existing ?? '';
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  const norm = cur.replace(/\r\n/g, '\n');
  const lines = norm.split('\n');
  const b = lines.findIndex((l) => isBegin(l, style));
  const e = b >= 0 ? lines.findIndex((l, i) => i > b && isEnd(l, style)) : -1;
  let out: string;
  if (b >= 0 && e >= 0) {
    out = [...lines.slice(0, b), blockText, ...lines.slice(e + 1)].join('\n');
  } else if (!norm.trim()) {
    out = blockText + '\n';
  } else if (position === 'start') {
    out = blockText + '\n\n' + norm.replace(/^\n+/, '');
  } else {
    out = norm.replace(/\n*$/, '') + '\n\n' + blockText + '\n';
  }
  if (!out.endsWith('\n')) out += '\n';
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

// ---------------------------------------------------------------------------
// paths and small helpers
// ---------------------------------------------------------------------------

export function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `~/x` for a path under the user's home, else the absolute forward-slash path. */
export function homeRelative(p: string, userHome: string): string {
  const rel = path.relative(userHome, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '~/' + posix(rel);
  return posix(p);
}

/** One line, at most `max` characters, cut at a word boundary. */
export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

/** Hidden or steering code points shown as `<U+XXXX>` (for diffs and reports people read; never for content). */
export function showHidden(s: string): string {
  let out = '';
  let offset = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const hidden = (cp >= 0xe0000 && cp <= 0xe007f) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || (cp === 0xfeff && offset !== 0) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    out += hidden ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
    offset += ch.length;
  }
  return out;
}

/** Escape a cell for a Markdown table. */
export function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** A code span that survives backticks inside the text. */
export function code(s: string): string {
  const ticks = (s.match(/`+/g) ?? []).reduce((m, t) => Math.max(m, t.length), 0);
  const fence = '`'.repeat(ticks + 1);
  return ticks ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

// ---------------------------------------------------------------------------
// repo facts (from the inventory; read, never run)
// ---------------------------------------------------------------------------

export interface RepoCommands {
  build?: string;
  typecheck?: string;
  lint?: string;
  format?: string;
  /** The repository's own write-formatter (`prettier --write`, `eslint --fix`), when a script runs one. */
  formatFix?: string;
  test?: string;
  oneTest?: string;
}

export interface RepoFacts {
  id: string;
  name: string;
  path: string;
  relPath: string;
  pm: string;
  commands: RepoCommands;
  /** Scripts that are slow or need running services (by name); never timed here. */
  slow: string[];
  /** The repo index's one-line verify command (src/hooks/repoindex.ts). */
  verify: string;
  /** Workspace packages with their own folder (monorepos). */
  packages: string[];
}

const TYPECHECK_NAMES = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'];
const FORMAT_NAMES = ['format:check', 'prettier:check', 'fmt:check', 'check-format', 'format-check'];
// the write-formatter: allowed because the rendered standards tell the agent to run it, and a headless or
// print-mode session ends at the approval prompt otherwise (Devin CLI check 2026-10-20; Claude run A 2026-10-19)
const FORMAT_FIX_NAMES = ['format', 'format:write', 'format:fix', 'fmt', 'prettier', 'lint:fix'];
const FORMAT_FIX_RE = /(^|\s)(--write|--fix)(\s|$)/;
const SLOW_RE = /(^|[:_-])(e2e|integration|int|acceptance|system|perf|bench|load|smoke|all|slow|full)($|[:_-])/i;

function pmName(pm?: string): string {
  return pm && pm !== 'unknown' ? pm : 'npm';
}

export function runScript(pm: string, name: string): string {
  if (name === 'test') return pm === 'bun' ? 'bun run test' : `${pm} test`;
  if (pm === 'yarn') return `yarn ${name}`;
  return `${pm} run ${name}`;
}

function execBin(pm: string, bin: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm exec ${bin}`;
    case 'yarn':
      return `yarn ${bin}`;
    case 'bun':
      return `bunx ${bin}`;
    default:
      return `npx ${bin}`;
  }
}

/** How to run one test file, read from the test script's runner. */
export function oneTestCommand(pm: string, testScript: string | undefined): string | undefined {
  if (!testScript) return undefined;
  const s = testScript;
  if (/\bvitest\b/.test(s)) return `${execBin(pm, 'vitest run')} <file>`;
  if (/\bjest\b/.test(s)) return `${execBin(pm, 'jest')} <file>`;
  if (/\bmocha\b/.test(s)) return `${execBin(pm, 'mocha')} <file>`;
  if (/\bava\b/.test(s)) return `${execBin(pm, 'ava')} <file>`;
  if (/\bnode\s+--test\b/.test(s)) return 'node --test <file>';
  if (/\bplaywright\s+test\b/.test(s)) return `${execBin(pm, 'playwright test')} <file>`;
  if (/\bcypress\b/.test(s)) return `${execBin(pm, 'cypress run --spec')} <file>`;
  return `${runScript(pm, 'test')} -- <file>`;
}

export function repoFacts(r: InventoryRepo, workspaceRoot: string): RepoFacts {
  const pm = pmName(r.packageManager);
  const root = (r.packages ?? []).find((p) => !p.dir) ?? (r.packages ?? [])[0];
  const scripts = root?.scripts ?? {};
  const has = (n: string) => typeof scripts[n] === 'string';
  const commands: RepoCommands = {};
  if (has('build')) commands.build = runScript(pm, 'build');
  const tc = TYPECHECK_NAMES.find(has);
  if (tc) commands.typecheck = runScript(pm, tc);
  if (has('lint')) commands.lint = runScript(pm, 'lint');
  const fmt = FORMAT_NAMES.find(has);
  if (fmt) commands.format = runScript(pm, fmt);
  const fix = FORMAT_FIX_NAMES.find((n) => has(n) && FORMAT_FIX_RE.test(scripts[n]));
  if (fix) commands.formatFix = runScript(pm, fix);
  if (has('test')) {
    commands.test = runScript(pm, 'test');
    commands.oneTest = oneTestCommand(pm, scripts.test);
  }
  const slow = Object.keys(scripts)
    .filter((n) => n !== 'test' && /test|e2e|spec/i.test(n) && SLOW_RE.test(n) && !/watch/i.test(n))
    .map((n) => runScript(pm, n));
  const rel = r.relPath ?? posix(path.relative(workspaceRoot, r.path));
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    relPath: rel || '.',
    pm,
    commands,
    slow,
    verify: verifyCommandFor(r.path, (['npm', 'pnpm', 'yarn', 'bun'].includes(pm) ? pm : undefined) as RepoRef['packageManager']),
    packages: (r.packages ?? []).filter((p) => p.dir).map((p) => posix(p.dir)),
  };
}

/** The repos of the inventory as facts, in a stable order (by relative path). */
export function allRepoFacts(ctx: RenderContext): RepoFacts[] {
  const repos = ctx.inventory?.repos ?? [];
  return repos.map((r) => repoFacts(r, ctx.workspaceRoot)).sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Task-time harness commands the agent runs unattended, as argv prefixes
 * after `harness` (admin commands stay denied by the guard). A prefix covers
 * every longer command (`verify` covers `verify env` and `verify map`), so
 * only the shortest one is listed; `land` and `run check-stop` are named by
 * the task skill (personal) and the runner prompt, `learn prove|stats` by the
 * learn skill, `judgment submit` by the setup and learn skills.
 */
export const TASK_TIME_HARNESS: readonly string[] = [
  'gate', 'verify', 'intake', 'phase', 'task', 'writeup', 'doctor', 'report', 'status', 'land',
  'run check-stop', 'db list', 'db candidates', 'learn --scan', 'learn --import-judgment', 'learn prove', 'learn stats', 'judgment submit',
];

/**
 * Exact verification commands as argv prefixes (for allow rules). A repo
 * command with a placeholder (`npx vitest run <file>`) is allowed by the part
 * before the placeholder when that part has at least two words. With
 * `cliPath` (the team setting, where the CLI note tells the agent to run
 * `node "<cliPath>" ...` when `harness` is not on PATH) every harness command
 * is also allowed in that form; the renderer quotes the path the way the note
 * prints it, because Claude Code matches the quoted spelling only.
 */
export function verificationArgv(facts: RepoFacts[], cliPath?: string): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  const add = (cmd: string | undefined) => {
    if (!cmd) return;
    let words = cmd.split(' ').filter(Boolean);
    const ph = words.findIndex((w) => w.includes('<'));
    if (ph >= 0) words = words.slice(0, ph);
    if (words.length < 2 || words.some((w) => /[;&|`$>]/.test(w))) return;
    const key = words.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(words);
  };
  for (const f of facts) {
    add(f.commands.build);
    add(f.commands.typecheck);
    add(f.commands.lint);
    add(f.commands.format);
    add(f.commands.formatFix);
    add(f.commands.test);
    add(f.commands.oneTest);
  }
  for (const sub of TASK_TIME_HARNESS) add(`harness ${sub}`);
  if (cliPath) for (const sub of TASK_TIME_HARNESS) out.push(['node', cliPath, ...sub.split(' ')]);
  return out;
}
