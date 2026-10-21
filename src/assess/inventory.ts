/**
 * Inventory (DESIGN 2.2): every instruction file, rule, skill, hook config,
 * permission file and MCP config for Devin Local, Claude Code and Codex, at
 * user, workspace (parent folder) and repo level, plus folders named with
 * `--include`. For each file: kind, size, sha256, and per agent when it is
 * loaded (launch / lazy / never) and why.
 *
 * Load paths follow the agents' documentation as of 2026-10-18:
 * - Devin Local: AGENTS.md, AGENTS.local.md, AGENT.md, .windsurfrules and
 *   CLAUDE.md are always-on rules (workspace root at session start, sub-folders
 *   lazily); .devin/rules/*.md by `trigger`; .devin/global_rules.md; global
 *   ~/.config/devin/AGENTS.md, ~/.devin/rules, ~/.devin/global_rules.md and
 *   ~/.claude/CLAUDE.md; skills in .agents/.devin/.windsurf skills and the
 *   user folders; imports .claude/ material and .cursor rules unless
 *   `read_config_from` turns them off.
 * - Claude Code: CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md from the cwd
 *   and every ancestor at launch, sub-folders lazily; AGENTS.md only when no
 *   CLAUDE.md is in the cwd or above; .claude/rules (paths: -> lazy); skills
 *   up to the git root; settings only at the project root.
 * - Codex: ~/.codex/AGENTS(.override).md, then one AGENTS(.override).md per
 *   folder from the git root down to the cwd under a 32 KiB budget; project
 *   .codex/* only for a trusted project; skills in .agents/skills.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../lib/hash';
import { tryParseJsonc } from '../lib/jsonc';
import { parseFrontMatter } from '../lib/frontmatter';
import { toPosix } from '../lib/paths';
import { decode } from './scan';
import { tryParseToml } from './toml';
import type { AgentId } from '../types';
import { ALL_AGENTS } from '../types';
import type { AgentLoad, AssessContext, FileKind, InvFile, Session } from './model';

export const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_WALK_ENTRIES = 60000;
const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'tmp', '.idea', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv', '.harness', '.gradle', '.terraform']);

export const INSTRUCTION_NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'AGENTS.local.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md']);
const DEVIN_RULE_NAMES = new Set(['AGENTS.md', 'AGENTS.local.md', 'AGENT.md', '.windsurfrules', 'CLAUDE.md']);
const CLAUDE_FAMILY = new Set(['CLAUDE.md', 'CLAUDE.local.md']);

export interface PathKind {
  kind: FileKind;
  label?: string;
}

/** Classify a path (relative to the folder being walked, posix) as an agent file, or null. */
export function kindOfPath(rel: string): PathKind | null {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  const parent = parts[parts.length - 2] ?? '';
  const has = (seq: string) => ('/' + rel).includes('/' + seq + '/');
  if (base === 'SKILL.md' && parts.length >= 3 && parts[parts.length - 3] === 'skills') {
    const owner = parts[parts.length - 4] ?? '';
    if (['.agents', '.devin', '.windsurf', '.claude', '.codex'].includes(owner)) return { kind: 'skill' };
    if (owner === '.github' || owner === '.cursor' || owner === '.cognition') return { kind: 'skill', label: `${owner} skill (not read by the three agents locally)` };
  }
  if (INSTRUCTION_NAMES.has(base)) return { kind: 'instructions' };
  if (base === '.windsurfrules') return { kind: 'instructions', label: 'legacy name; Devin Local still loads it' };
  if (base === '.cursorrules') return { kind: 'legacy', label: 'legacy (Cursor)' };
  if (base === 'GEMINI.md') return { kind: 'legacy', label: 'legacy (Gemini CLI)' };
  if (base === 'copilot-instructions.md' && parent === '.github') return { kind: 'legacy', label: 'legacy (GitHub Copilot)' };
  if (/\.instructions\.md$/.test(base) && parent === 'instructions' && has('.github')) return { kind: 'legacy', label: 'legacy (GitHub Copilot)' };
  if (base === 'global_rules.md' && parent === '.devin') return { kind: 'instructions' };
  if (/\.md$/.test(base) && has('.devin/rules')) return { kind: 'rule' };
  if (/\.md$/.test(base) && has('.claude/rules')) return { kind: 'rule' };
  if (/\.mdc?$/.test(base) && has('.cursor/rules')) return { kind: 'rule', label: 'Cursor rule (Devin imports it)' };
  if (/\.md$/.test(base) && has('.windsurf/rules')) return { kind: 'legacy', label: 'legacy (Cascade rule)' };
  if (/\.md$/.test(base) && has('.claude/commands')) return { kind: 'command' };
  if (/\.md$/.test(base) && parent === 'agents' && has('.claude')) return { kind: 'subagent' };
  if (/\.md$/.test(base) && (has('.devin/workflows') || has('.windsurf/workflows'))) return { kind: 'legacy', label: 'legacy (Cascade workflow)' };
  if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) return { kind: 'settings' };
  if (parent === '.devin' && (base === 'config.json' || base === 'config.local.json')) return { kind: 'settings' };
  if (parent === '.devin' && base === 'hooks.v1.json') return { kind: 'hook-config' };
  if ((parent === '.devin' || parent === '.windsurf') && base === 'hooks.json') return { kind: 'hook-config', label: 'legacy (Cascade hooks)' };
  if (parent === '.codex' && base === 'config.toml') return { kind: 'settings' };
  if (parent === '.codex' && base === 'hooks.json') return { kind: 'hook-config' };
  if (/\.rules$/.test(base) && has('.codex/rules')) return { kind: 'codex-rules' };
  if (parent === '.cursor' && base === 'hooks.json') return { kind: 'hook-config', label: 'Cursor hooks (not read by the three agents)' };
  if (parent === '.gemini' && base === 'settings.json') return { kind: 'settings', label: 'Gemini CLI settings (not read by the three agents)' };
  if (base === '.mcp.json') return { kind: 'mcp' };
  if (parent === '.devin' && (base === 'mcp_config.json' || base === 'mcp_config.local.json')) return { kind: 'mcp' };
  if ((parent === '.cursor' || parent === '.vscode') && base === 'mcp.json') return { kind: 'mcp', label: `${parent} MCP config (not read by the three agents)` };
  if (base === 'AI_POLICY.md') return { kind: 'other', label: 'AI contribution policy' };
  return null;
}

/** Files under an --include folder: any markdown, settings-like JSON, TOML or Codex rules. */
function kindOfIncluded(rel: string): PathKind | null {
  const k = kindOfPath(rel);
  if (k) return k;
  const base = rel.split('/').pop() ?? '';
  if (base === 'SKILL.md') return { kind: 'skill' };
  if (/\.mdc?$/i.test(base) && !/^(README|CHANGELOG|LICENSE)/i.test(base)) return { kind: 'rule' };
  if (/^(settings(\.local)?|hooks(\.v1)?|config|mcp(_config)?)\.json$/.test(base)) return { kind: 'settings' };
  if (/\.toml$/.test(base)) return { kind: 'settings' };
  if (/\.rules$/.test(base)) return { kind: 'codex-rules' };
  return null;
}

/** Walk a folder for agent files. Symlinked files are kept (R23); symlinked folders are not followed. */
export function walkAgentFiles(root: string, match: (rel: string) => PathKind | null, notes: string[]): Array<{ abs: string; pk: PathKind }> {
  const out: Array<{ abs: string; pk: PathKind }> = [];
  const stack: string[] = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) {
        notes.push(`stopped walking ${toPosix(root)} after ${MAX_WALK_ENTRIES} entries; deeper agent files may be missing`);
        return out;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_IGNORE.has(e.name)) stack.push(abs);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (e.isSymbolicLink()) {
        try {
          if (!fs.statSync(abs).isFile()) continue;
        } catch {
          continue;
        }
      }
      const pk = match(toPosix(path.relative(root, abs)));
      if (pk) out.push({ abs, pk });
    }
  }
  return out;
}

function listGlob(dir: string, test: (name: string) => boolean, recursive = false): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...listGlob(abs, test, true));
    else if ((e.isFile() || e.isSymbolicLink()) && test(e.name)) out.push(abs);
  }
  return out.sort();
}

function skillsIn(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name, 'SKILL.md');
    if ((e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(p)) out.push(p);
  }
  return out.sort();
}

/** User-level agent files (the fake HOME in tests). */
function userLevelCandidates(ctx: AssessContext, devinHome: string): Array<{ abs: string; pk: PathKind }> {
  const h = ctx.userHome;
  const out: Array<{ abs: string; pk: PathKind }> = [];
  const add = (abs: string, kind: FileKind, label?: string) => {
    if (fs.existsSync(abs)) out.push({ abs, pk: { kind, label } });
  };
  // Claude Code
  add(path.join(h, '.claude', 'CLAUDE.md'), 'instructions');
  for (const p of listGlob(path.join(h, '.claude', 'rules'), (n) => n.endsWith('.md'), true)) add(p, 'rule');
  for (const p of skillsIn(path.join(h, '.claude', 'skills'))) add(p, 'skill');
  for (const p of listGlob(path.join(h, '.claude', 'commands'), (n) => n.endsWith('.md'), true)) add(p, 'command');
  for (const p of listGlob(path.join(h, '.claude', 'agents'), (n) => n.endsWith('.md'))) add(p, 'subagent');
  add(path.join(h, '.claude', 'settings.json'), 'settings');
  add(path.join(h, '.claude', 'settings.local.json'), 'settings');
  add(path.join(h, '.claude.json'), 'mcp', 'Claude Code user state (only mcpServers is read)');
  // Devin Local
  add(path.join(devinHome, 'AGENTS.md'), 'instructions');
  add(path.join(devinHome, 'config.json'), 'settings');
  add(path.join(devinHome, 'mcp_config.json'), 'mcp');
  for (const p of skillsIn(path.join(devinHome, 'skills'))) add(p, 'skill');
  add(path.join(h, '.devin', 'global_rules.md'), 'instructions');
  for (const p of listGlob(path.join(h, '.devin', 'rules'), (n) => n.endsWith('.md'), true)) add(p, 'rule');
  add(path.join(h, '.codeium', 'windsurf', 'memories', 'global_rules.md'), 'legacy', 'legacy (Cascade global rules)');
  try {
    for (const ch of fs.readdirSync(path.join(h, '.codeium'))) for (const p of skillsIn(path.join(h, '.codeium', ch, 'skills'))) add(p, 'skill');
  } catch {
    /* none */
  }
  // Codex
  add(path.join(h, '.codex', 'AGENTS.override.md'), 'instructions');
  add(path.join(h, '.codex', 'AGENTS.md'), 'instructions');
  add(path.join(h, '.codex', 'config.toml'), 'settings');
  add(path.join(h, '.codex', 'hooks.json'), 'hook-config');
  for (const p of listGlob(path.join(h, '.codex', 'rules'), (n) => n.endsWith('.rules'))) add(p, 'codex-rules');
  // Shared Agent Skills folder (Devin and Codex)
  for (const p of skillsIn(path.join(h, '.agents', 'skills'))) add(p, 'skill');
  return out;
}

/** CLAUDE.md-family and AGENTS.md files in the folders above the workspace (Claude Code loads ancestors). */
function ancestorCandidates(ctx: AssessContext): Array<{ abs: string; pk: PathKind }> {
  const out: Array<{ abs: string; pk: PathKind }> = [];
  let dir = path.dirname(ctx.workspace);
  const home = path.resolve(ctx.userHome);
  for (let depth = 0; depth < 40; depth++) {
    if (dir === home || path.dirname(dir) === dir) break;
    for (const n of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md')]) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) out.push({ abs: p, pk: { kind: 'instructions' } });
    }
    dir = path.dirname(dir);
  }
  return out;
}

export function displayPath(ctx: { workspace: string; userHome: string }, abs: string): string {
  const w = path.relative(ctx.workspace, abs);
  if (w === '') return '.';
  if (!w.startsWith('..') && !path.isAbsolute(w)) return toPosix(w);
  const h = path.relative(ctx.userHome, abs);
  if (!h.startsWith('..') && !path.isAbsolute(h)) return '~/' + toPosix(h);
  return toPosix(abs);
}

/** sha256 of a whole file, read in chunks (for files larger than what assess reads into memory). */
function hashWholeFile(abs: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      h.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function readFileEntry(ctx: AssessContext, abs: string, pk: PathKind, level: InvFile['level'], repoRoot: string | null): InvFile | null {
  let st: fs.Stats;
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(abs);
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  let buf: Buffer;
  if (st.size > MAX_READ_BYTES) {
    ctx.notes.push(`${displayPath(ctx, abs)} is ${st.size} bytes; only the first ${MAX_READ_BYTES} were read`);
    const fd = fs.openSync(abs, 'r');
    buf = Buffer.alloc(MAX_READ_BYTES);
    fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    fs.closeSync(fd);
  } else buf = fs.readFileSync(abs);
  const { text, binary } = decode(buf);
  const lines = text === '' ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
  let symlinkTo: string | undefined;
  if (lst.isSymbolicLink()) {
    try {
      symlinkTo = fs.realpathSync(abs);
    } catch {
      symlinkTo = undefined;
    }
  }
  const never = (): AgentLoad => ({ when: 'never', note: 'not on this agent\'s load path' });
  return {
    abs,
    display: displayPath(ctx, abs),
    level,
    repoRoot,
    kind: pk.kind,
    label: pk.label,
    loads: { devin: never(), claude: never(), codex: never() },
    limit: '',
    bytes: st.size,
    lines,
    sha256: st.size > MAX_READ_BYTES ? hashWholeFile(abs) : sha256(buf),
    text,
    binary,
    symlinkTo,
  };
}

function repoOf(ctx: AssessContext, abs: string): string | null {
  let best: string | null = null;
  for (const r of ctx.repos) {
    const rel = path.relative(r.root, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && (!best || r.root.length > best.length)) best = r.root;
  }
  return best;
}

/** Collect every candidate file into ctx.files (deduplicated by real path; the first role wins). */
export function collectFiles(ctx: AssessContext): void {
  const devinHome = agentHomeDevin(ctx.userHome);
  const seen = new Set<string>();
  const push = (abs: string, pk: PathKind, level: InvFile['level'], repoRoot: string | null) => {
    const key = path.resolve(abs);
    if (seen.has(key)) return;
    seen.add(key);
    const f = readFileEntry(ctx, abs, pk, level, repoRoot);
    if (f) ctx.files.push(f);
  };
  for (const c of userLevelCandidates(ctx, devinHome)) push(c.abs, c.pk, 'user', null);
  for (const c of ancestorCandidates(ctx)) push(c.abs, c.pk, 'ancestor', null);
  for (const c of walkAgentFiles(ctx.workspace, kindOfPath, ctx.notes)) {
    const repo = repoOf(ctx, c.abs);
    push(c.abs, c.pk, repo ? 'repo' : 'workspace', repo);
  }
  for (const inc of ctx.includes) {
    for (const c of walkAgentFiles(inc, kindOfIncluded, ctx.notes)) {
      const real = (() => {
        try {
          return fs.realpathSync(c.abs);
        } catch {
          return c.abs;
        }
      })();
      if (seen.has(path.resolve(real))) continue;
      push(c.abs, c.pk, 'include', null);
    }
  }
}

export function agentHomeDevin(userHome: string): string {
  if (process.platform === 'win32' && process.env.APPDATA && !process.env.HARNESS_USER_HOME) return path.join(process.env.APPDATA, 'devin');
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'devin');
  return path.join(userHome, '.config', 'devin');
}

// ---------------------------------------------------------------------------
// Settings that change load paths: Devin read_config_from, Codex trust/budget
// ---------------------------------------------------------------------------

export function resolveLoadSettings(ctx: AssessContext): void {
  const devinHome = agentHomeDevin(ctx.userHome);
  const byAbs = new Map(ctx.files.map((f) => [path.resolve(f.abs), f]));
  const readJson = (p: string): Record<string, unknown> | null => {
    const f = byAbs.get(path.resolve(p));
    if (!f) return null;
    const r = tryParseJsonc<Record<string, unknown>>(f.text);
    return r.ok && r.value && typeof r.value === 'object' ? r.value : null;
  };
  const imports = { claude: true, cursor: true };
  for (const p of [path.join(devinHome, 'config.json'), path.join(ctx.workspace, '.devin', 'config.json'), path.join(ctx.workspace, '.devin', 'config.local.json')]) {
    const v = readJson(p);
    const rcf = v?.read_config_from;
    if (rcf && typeof rcf === 'object') {
      for (const k of ['claude', 'cursor'] as const) {
        const x = (rcf as Record<string, unknown>)[k];
        if (typeof x === 'boolean') imports[k] = x;
      }
    }
  }
  ctx.devinImports = imports;
  const codexCfg = byAbs.get(path.resolve(path.join(ctx.userHome, '.codex', 'config.toml')));
  if (codexCfg) {
    const r = tryParseToml(codexCfg.text);
    if (r.ok) {
      const v = r.value;
      if (typeof v.project_doc_max_bytes === 'number' && v.project_doc_max_bytes > 0) ctx.codexBudget = v.project_doc_max_bytes;
      if (Array.isArray(v.project_doc_fallback_filenames)) ctx.codexFallbackNames = v.project_doc_fallback_filenames.filter((x): x is string => typeof x === 'string');
      const projects = v.projects;
      if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
        for (const [p, cfg] of Object.entries(projects)) {
          if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg as Record<string, unknown>).trust_level === 'trusted') ctx.codexTrusted.add(path.resolve(p));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Load timing per agent
// ---------------------------------------------------------------------------

const RANK = { launch: 3, lazy: 2, never: 1 } as const;

export function better(a: AgentLoad, b: AgentLoad): AgentLoad {
  return RANK[b.when] > RANK[a.when] ? b : a;
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The folder an instruction file applies to (`.claude/CLAUDE.md` applies to the folder above `.claude`). */
export function instructionDir(abs: string): string {
  const dir = path.dirname(abs);
  return path.basename(dir) === '.claude' ? path.dirname(dir) : dir;
}

/** Path of `abs` relative to the nearest `.devin`/`.claude`/`.codex`/... folder owner, e.g. `.devin/rules/x.md` -> owner dir. */
function ownerDir(abs: string, marker: string): string | null {
  const parts = abs.split(path.sep);
  const i = parts.lastIndexOf(marker);
  return i > 0 ? parts.slice(0, i).join(path.sep) || path.sep : null;
}

function fm(f: InvFile): Record<string, unknown> {
  return parseFrontMatter(f.text).data;
}

function devinTrigger(f: InvFile): string {
  const t = fm(f).trigger;
  return typeof t === 'string' ? t : 'always_on';
}

export function devinLoad(ctx: AssessContext, f: InvFile, devinHome: string): AgentLoad {
  const W = ctx.workspace;
  const base = path.basename(f.abs);
  const abs = f.abs;
  const atRoot = (dir: string) => path.resolve(dir) === path.resolve(W);
  if (f.level === 'user') {
    if (abs === path.join(devinHome, 'AGENTS.md')) return { when: 'launch', note: 'global rules file (always on)' };
    if (abs === path.join(ctx.userHome, '.devin', 'global_rules.md')) return { when: 'launch', note: 'global rules file (always on)' };
    if (abs === path.join(ctx.userHome, '.claude', 'CLAUDE.md')) return { when: 'launch', note: 'Devin also reads ~/.claude/CLAUDE.md as a global rule' };
    if (f.kind === 'rule' && within(path.join(ctx.userHome, '.devin', 'rules'), abs)) {
      const t = devinTrigger(f);
      return t === 'always_on' ? { when: 'launch', note: 'global rule, trigger always_on' } : { when: 'lazy', note: `global rule, trigger ${t}` };
    }
    if (f.kind === 'skill') {
      if (within(path.join(ctx.userHome, '.agents', 'skills'), abs) || within(path.join(devinHome, 'skills'), abs) || within(path.join(ctx.userHome, '.codeium'), abs))
        return { when: 'lazy', note: 'global skill (description at start, body when used)' };
      if (within(path.join(ctx.userHome, '.claude', 'skills'), abs))
        return ctx.devinImports.claude ? { when: 'lazy', note: 'imported from ~/.claude/skills (read_config_from.claude)' } : { when: 'never', note: 'read_config_from.claude is off' };
    }
    if (abs === path.join(devinHome, 'config.json')) return { when: 'launch', note: 'user config (hooks, permissions, read_config_from)' };
    if (abs === path.join(devinHome, 'mcp_config.json')) return { when: 'launch', note: 'user MCP config' };
    if (abs === path.join(ctx.userHome, '.claude', 'settings.json') || abs === path.join(ctx.userHome, '.claude', 'settings.local.json') || abs === path.join(ctx.userHome, '.claude.json'))
      return ctx.devinImports.claude ? { when: 'launch', note: 'hooks imported from Claude Code user settings (read_config_from.claude)' } : { when: 'never', note: 'read_config_from.claude is off' };
    if (f.kind === 'legacy') return { when: 'never', note: 'legacy Cascade file; not documented for Devin Local' };
    return { when: 'never', note: 'not on Devin\'s load path' };
  }
  if (f.level === 'ancestor') return { when: 'never', note: 'above the workspace folder (Devin reads from the workspace root down)' };
  if (f.level === 'include') return { when: 'never', note: 'outside every Devin load path' };
  // workspace / repo level
  const dir = path.dirname(abs);
  if (DEVIN_RULE_NAMES.has(base) && path.basename(dir) !== '.claude') {
    return atRoot(dir) ? { when: 'launch', note: 'always-on rule at the workspace root (session start)' } : { when: 'lazy', note: 'always-on rule in a sub-folder (loaded when the agent touches files there)' };
  }
  if (base === 'global_rules.md' && path.basename(dir) === '.devin') {
    return atRoot(path.dirname(dir)) ? { when: 'launch', note: '.devin/global_rules.md at the workspace root' } : { when: 'lazy', note: '.devin/global_rules.md in a sub-folder' };
  }
  if (f.kind === 'rule') {
    const devinOwner = ownerDir(abs, '.devin');
    if (devinOwner && abs.includes(`${path.sep}.devin${path.sep}rules${path.sep}`)) {
      const t = devinTrigger(f);
      if (t === 'always_on' && atRoot(devinOwner)) return { when: 'launch', note: 'rule with trigger always_on at the workspace root' };
      return { when: 'lazy', note: `rule with trigger ${t}${atRoot(devinOwner) ? '' : ' in a sub-folder'}` };
    }
    const cursorOwner = ownerDir(abs, '.cursor');
    if (cursorOwner && abs.includes(`${path.sep}.cursor${path.sep}rules${path.sep}`)) {
      if (!ctx.devinImports.cursor) return { when: 'never', note: 'read_config_from.cursor is off' };
      const always = fm(f).alwaysApply === true;
      return always && atRoot(cursorOwner) ? { when: 'launch', note: 'Cursor rule with alwaysApply, imported (read_config_from.cursor)' } : { when: 'lazy', note: 'Cursor rule, imported (read_config_from.cursor)' };
    }
    return { when: 'never', note: 'not on Devin\'s load path' };
  }
  if (f.kind === 'skill') {
    if (/[\\/]\.(agents|devin|windsurf)[\\/]skills[\\/]/.test(abs)) return { when: 'lazy', note: 'project skill (description at start, body when used)' };
    if (/[\\/]\.claude[\\/]skills[\\/]/.test(abs)) return ctx.devinImports.claude ? { when: 'lazy', note: 'imported from .claude/skills (read_config_from.claude)' } : { when: 'never', note: 'read_config_from.claude is off' };
    return { when: 'never', note: 'not a Devin skills folder' };
  }
  const owner = path.dirname(dir);
  const sessionNote = atRoot(owner) ? 'project config at the workspace root' : 'project config of a sub-repo (loads when a session runs there)';
  const when = atRoot(owner) ? 'launch' : 'lazy';
  if (path.basename(dir) === '.devin' && ['config.json', 'config.local.json', 'hooks.v1.json', 'mcp_config.json', 'mcp_config.local.json'].includes(base)) return { when, note: sessionNote };
  if (path.basename(dir) === '.claude' && (base === 'settings.json' || base === 'settings.local.json'))
    return ctx.devinImports.claude ? { when, note: `${sessionNote}; hooks imported from .claude/ (read_config_from.claude)` } : { when: 'never', note: 'read_config_from.claude is off' };
  if (f.kind === 'legacy' || /legacy/.test(f.label ?? '')) return { when: 'never', note: 'legacy file; Devin Local does not load it' };
  return { when: 'never', note: 'not on Devin\'s load path' };
}

/** A project CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md applies to `dir` (the user memory file ~/.claude/CLAUDE.md does not count). */
function claudeFamilyIn(ctx: AssessContext, dir: string): boolean {
  return ctx.files.some((f) => f.kind === 'instructions' && f.level !== 'user' && CLAUDE_FAMILY.has(path.basename(f.abs)) && path.basename(path.dirname(f.abs)) !== '.codex' && path.resolve(instructionDir(f.abs)) === path.resolve(dir));
}

function chainOf(s: Session): string[] {
  const out: string[] = [];
  let d = path.resolve(s.cwd);
  for (let i = 0; i < 60; i++) {
    out.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

export function claudeLoadInSession(ctx: AssessContext, f: InvFile, s: Session): AgentLoad {
  const abs = f.abs;
  const base = path.basename(abs);
  const home = ctx.userHome;
  const P = s.gitRoot ?? s.cwd;
  if (f.level === 'user') {
    if (abs === path.join(home, '.claude', 'CLAUDE.md')) return { when: 'launch', note: 'user memory file (always on)' };
    if (f.kind === 'rule' && within(path.join(home, '.claude', 'rules'), abs)) return Array.isArray(fm(f).paths) || typeof fm(f).paths === 'string' ? { when: 'lazy', note: 'user rule with paths: (loaded when a matching file is read)' } : { when: 'launch', note: 'user rule without paths: (always on)' };
    if (f.kind === 'skill' && within(path.join(home, '.claude', 'skills'), abs)) return { when: 'lazy', note: 'user skill (description at start, body when used)' };
    if ((f.kind === 'command' || f.kind === 'subagent') && within(path.join(home, '.claude'), abs)) return { when: 'lazy', note: `user ${f.kind} (loaded when invoked)` };
    if (abs === path.join(home, '.claude', 'settings.json') || abs === path.join(home, '.claude', 'settings.local.json')) return { when: 'launch', note: 'user settings (hooks, permissions)' };
    if (abs === path.join(home, '.claude.json')) return { when: 'launch', note: 'user MCP servers' };
    return { when: 'never', note: 'not on Claude Code\'s load path' };
  }
  if (f.level === 'include') return { when: 'never', note: 'outside every Claude Code load path' };
  const chain = chainOf(s);
  const inChain = (d: string) => chain.includes(path.resolve(d));
  if (f.kind === 'instructions' && (CLAUDE_FAMILY.has(base) || (base === 'CLAUDE.md' && path.basename(path.dirname(abs)) === '.claude'))) {
    const d = instructionDir(abs);
    if (inChain(d)) return { when: 'launch', note: 'CLAUDE.md in the working folder or above (launch)' };
    if (within(s.cwd, d)) return { when: 'lazy', note: 'CLAUDE.md in a sub-folder (loaded when files there are read)' };
    return { when: 'never', note: 'not under the session folder' };
  }
  if (f.kind === 'instructions' && base === 'AGENTS.md') {
    const d = path.dirname(abs);
    if (inChain(d)) {
      const shadow = chain.some((c) => claudeFamilyIn(ctx, c));
      return shadow ? { when: 'never', note: 'a CLAUDE.md in the working folder or above shadows AGENTS.md' } : { when: 'launch', note: 'AGENTS.md read natively (no CLAUDE.md in the working folder or above)' };
    }
    if (within(s.cwd, d)) return claudeFamilyIn(ctx, d) ? { when: 'never', note: 'shadowed by the CLAUDE.md next to it' } : { when: 'lazy', note: 'AGENTS.md in a sub-folder (read natively when no CLAUDE.md is there)' };
    return { when: 'never', note: 'not under the session folder' };
  }
  if (f.kind === 'rule' && abs.includes(`${path.sep}.claude${path.sep}rules${path.sep}`)) {
    const owner = ownerDir(abs, '.claude');
    if (owner && path.resolve(owner) === path.resolve(P)) {
      const paths = fm(f).paths;
      return paths !== undefined ? { when: 'lazy', note: 'rule with paths: (loaded when a matching file is read; model-dependent)' } : { when: 'launch', note: 'project rule without paths: (always on)' };
    }
    return { when: 'never', note: 'rules load only from the project root' };
  }
  if (f.kind === 'skill' && /[\\/]\.claude[\\/]skills[\\/]/.test(abs)) {
    const owner = ownerDir(abs, '.claude');
    const top = s.gitRoot ?? s.cwd;
    if (owner && inChain(owner) && within(top, owner)) return { when: 'lazy', note: 'project skill (description at start, body when used)' };
    return { when: 'never', note: 'project skills are found from the working folder up to the git root only' };
  }
  if ((f.kind === 'command' || f.kind === 'subagent') && abs.includes(`${path.sep}.claude${path.sep}`)) {
    const owner = ownerDir(abs, '.claude');
    return owner && path.resolve(owner) === path.resolve(P) ? { when: 'lazy', note: `project ${f.kind} (loaded when invoked)` } : { when: 'never', note: 'not at the project root' };
  }
  if (f.kind === 'settings' && path.basename(path.dirname(abs)) === '.claude') {
    const owner = path.dirname(path.dirname(abs));
    return path.resolve(owner) === path.resolve(P) ? { when: 'launch', note: 'project settings (hooks, permissions)' } : { when: 'never', note: 'settings in another folder do not apply (hooks in a parent folder do not fire from a child repo)' };
  }
  if (base === '.mcp.json') return path.resolve(path.dirname(abs)) === path.resolve(P) ? { when: 'launch', note: 'project MCP servers' } : { when: 'never', note: 'not at the project root' };
  return { when: 'never', note: 'not on Claude Code\'s load path' };
}

function codexInstructionFor(ctx: AssessContext, dir: string): InvFile | null {
  const names = ['AGENTS.override.md', 'AGENTS.md', ...ctx.codexFallbackNames];
  for (const n of names) {
    const f = ctx.files.find((x) => (x.kind === 'instructions' || x.kind === 'legacy') && path.resolve(x.abs) === path.resolve(path.join(dir, n)));
    if (f) return f;
  }
  return null;
}

export function codexChain(ctx: AssessContext, s: Session): string[] {
  const out: string[] = [];
  if (!s.gitRoot) return [path.resolve(s.cwd)];
  let d = path.resolve(s.cwd);
  const top = path.resolve(s.gitRoot);
  for (let i = 0; i < 60; i++) {
    out.unshift(d);
    if (d === top) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

function codexTrusted(ctx: AssessContext, dir: string): boolean {
  for (const t of ctx.codexTrusted) if (within(t, dir)) return true;
  return false;
}

export function codexLoadInSession(ctx: AssessContext, f: InvFile, s: Session): AgentLoad {
  const abs = f.abs;
  const base = path.basename(abs);
  const home = ctx.userHome;
  if (f.level === 'user') {
    if (abs === path.join(home, '.codex', 'AGENTS.override.md')) return { when: 'launch', note: 'global instructions (outside the project budget)' };
    if (abs === path.join(home, '.codex', 'AGENTS.md'))
      return fs.existsSync(path.join(home, '.codex', 'AGENTS.override.md')) ? { when: 'never', note: 'replaced by ~/.codex/AGENTS.override.md' } : { when: 'launch', note: 'global instructions (outside the project budget)' };
    if (f.kind === 'skill' && within(path.join(home, '.agents', 'skills'), abs)) return { when: 'lazy', note: 'user skill (name and description at start, body when used)' };
    if (abs === path.join(home, '.codex', 'config.toml')) return { when: 'launch', note: 'user config' };
    if (abs === path.join(home, '.codex', 'hooks.json')) return { when: 'launch', note: 'user hooks (each needs trust by hash in /hooks)' };
    if (f.kind === 'codex-rules' && within(path.join(home, '.codex', 'rules'), abs)) return { when: 'launch', note: 'user command rules' };
    return { when: 'never', note: 'not on Codex\'s load path' };
  }
  if (f.level === 'include') return { when: 'never', note: 'outside every Codex load path' };
  const chain = codexChain(ctx, s);
  if (f.kind === 'instructions' || f.kind === 'legacy') {
    const d = path.dirname(abs);
    if (chain.includes(path.resolve(d))) {
      const chosen = codexInstructionFor(ctx, d);
      if (chosen && path.resolve(chosen.abs) === path.resolve(abs)) return { when: 'launch', note: s.gitRoot ? 'project instructions (git root down to the working folder; 32 KiB budget)' : 'project instructions (folder without .git: only this folder)' };
      if (['AGENTS.md', 'AGENTS.override.md'].includes(base) || ctx.codexFallbackNames.includes(base)) return { when: 'never', note: 'another file in the same folder takes precedence (AGENTS.override.md first)' };
    }
    return { when: 'never', note: 'Codex reads AGENTS.md only from the git root down to the working folder' };
  }
  if (f.kind === 'skill' && /[\\/]\.agents[\\/]skills[\\/]/.test(abs)) {
    const owner = ownerDir(abs, '.agents');
    if (owner && chain.includes(path.resolve(owner))) return { when: 'lazy', note: 'project skill (name and description at start, body when used)' };
    if (owner && path.resolve(owner) === path.resolve(s.cwd)) return { when: 'lazy', note: 'project skill' };
    return { when: 'never', note: 'skills are read from the working folder up to the repo root' };
  }
  const codexOwner = ownerDir(abs, '.codex');
  if (codexOwner) {
    const P = s.gitRoot ?? s.cwd;
    if (path.resolve(codexOwner) !== path.resolve(P)) return { when: 'never', note: 'project .codex/ loads only from the project root' };
    if (!codexTrusted(ctx, P)) return { when: 'never', note: 'project .codex/ loads only once the project is trusted (not trusted in ~/.codex/config.toml)' };
    if (f.kind === 'skill') return { when: 'lazy', note: 'project skill in a trusted project' };
    return { when: 'launch', note: 'project .codex/ in a trusted project' };
  }
  return { when: 'never', note: 'not on Codex\'s load path' };
}

/** Fill `loads` and `limit` for every file. */
export function computeLoads(ctx: AssessContext): void {
  const devinHome = agentHomeDevin(ctx.userHome);
  const rootSession = ctx.sessions.find((s) => s.isWorkspaceRoot) ?? ctx.sessions[0];
  for (const f of ctx.files) {
    f.loads.devin = devinLoad(ctx, f, devinHome);
    let c: AgentLoad = { when: 'never', note: 'not on Claude Code\'s load path' };
    let x: AgentLoad = { when: 'never', note: 'not on Codex\'s load path' };
    // The workspace-root session first so its note wins ties.
    for (const s of [rootSession, ...ctx.sessions.filter((s) => s !== rootSession)]) {
      const cl = claudeLoadInSession(ctx, f, s);
      const co = codexLoadInSession(ctx, f, s);
      c = better(c, s === rootSession ? cl : cl.when === 'launch' ? { when: 'launch', note: `${cl.note}, in a session started in ${displayPath(ctx, s.cwd)}` } : cl);
      x = better(x, s === rootSession ? co : co.when === 'launch' ? { when: 'launch', note: `${co.note}, in a session started in ${displayPath(ctx, s.cwd)}` } : co);
    }
    f.loads.claude = c;
    f.loads.codex = x;
    f.limit = limitFor(f);
  }
}

export function limitFor(f: InvFile): string {
  const parts: string[] = [];
  if (f.kind === 'skill') return 'SKILL.md body under 500 lines (about 5k tokens); description up to 1,024 characters';
  if (!['instructions', 'rule', 'legacy'].includes(f.kind)) return '';
  if (f.loads.claude.when !== 'never') parts.push('Claude Code: about 200 lines per file (guidance), 4 MiB hard cap');
  if (f.loads.codex.when !== 'never') parts.push(f.level === 'user' ? 'Codex: global file, outside the 32 KiB project budget' : 'Codex: counts toward the 32 KiB project budget (the file that crosses it is cut, later files dropped)');
  if (f.loads.devin.when !== 'never') parts.push('Devin Local: 16 KiB per always-on file (measured on Devin CLI 3000.11.92: the first 16,384 bytes are loaded, the model is told the rest was cut)');
  return parts.join('; ');
}

export function loadedByOf(f: InvFile): AgentId[] {
  return ALL_AGENTS.filter((a) => f.loads[a].when !== 'never');
}
