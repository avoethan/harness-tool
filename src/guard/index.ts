/**
 * Guard entry point: `evaluate(input)` -> allow | deny.
 *
 * Pure apart from the optional callbacks the caller supplies (staged files,
 * tracked-path check, realpath). Never throws: any internal error becomes a
 * deny with rail "internal", because a guard that fails open is no guard.
 *
 * Order of checks for a shell command, per segment (outer command, then
 * command substitutions, then inner commands of wrappers):
 *   hidden Unicode / unreadable program  -> opaque
 *   nested agent with bypass flags        -> nested-agent
 *   git history rewrite, hooks bypass, team push/remote/config, add/commit staging
 *   gh/glab/hub mutations, HTTP writes to code hosts (team)
 *   secret-file reads, copies, writes
 *   writes into protected roots           -> protect
 *   harness-shaped in-tree writes (team)  -> team-shaped
 *   test-file writes in implement phase   -> phase-tests
 *   database clients                      -> db
 */
import * as path from 'node:path';
import type { AgentId, DbConfig, Setting } from '../types';
import { isSecretFile } from '../lib/redact';
import { parseCommand, segmentText, expandShortFlags, normalizeProg, type ParsedCommand, type Segment, type Dialect, type Token } from './parse';
import { evaluateDbSegment, evaluateMcp } from './db';
import {
  AGENT_CONFIG_READ_SUBS,
  AGENT_CONFIG_SUBS,
  BYPASS_ENV_RE,
  BYPASS_FLAGS,
  BYPASS_FLAG_PREFIXES,
  BYPASS_VALUE_PAIRS,
  CODE_HOST_RE,
  CODE_WRITE_RE,
  COMMAND_TOOL_RE,
  COPY_PROGS,
  CURL_FILE_ARG_RE,
  DB_KEYWORD_RE,
  DESTRUCTIVE_PROGS,
  GH_API_MUTATING_FLAGS,
  GH_READONLY,
  GIT_CONFIG_DENY,
  GIT_DENY,
  GIT_ENV_PATHS,
  GIT_GLOBAL_FLAGS,
  GIT_GLOBAL_VALUE_OPTS,
  GIT_MUTATING_SUBS,
  GIT_REBASE_FALSE,
  GLAB_READONLY,
  HARNESS_SHAPED_DIR_RE,
  HARNESS_SHAPED_FILE_RE,
  HTTP_MUTATING_FLAGS,
  HUB_READONLY,
  MCP_TOOL_RE,
  NESTED_AGENTS,
  PROTECTED_SHAPE_RE,
  READ_ONLY_PROGS,
  READ_TOOL_RE,
  SECRET_EXAMPLE_RE,
  SECRET_EXTRA_RE,
  SECRET_LOAD_PARENTS,
  SECRET_SAFE_PROGS,
  TEST_PATH_RES,
  WORKFLOW_RE,
  WRITE_TOOL_RE,
  WRITE_VALUE_OPTS,
  type RailId,
  HARNESS_PROGS,
  HARNESS_CLI_PATH_RE,
  HARNESS_ADMIN_SUBS,
  HARNESS_ADMIN_SECOND,
  HARNESS_ADMIN_SECOND_FLAGS,
  HARNESS_ADMIN_FLAGS,
} from './rails';

export interface GuardInput {
  agent: AgentId;
  setting: Setting;
  toolName: string;
  toolInput: unknown;
  /** The hook process environment (inherited from the agent). */
  env: NodeJS.ProcessEnv;
  config: { db: DbConfig; mcp: { allowedServers: Record<string, string[]> } };
  /** Absolute paths the agent may never write: harness home, agent config homes, the package root, ~/.claude.json. */
  protectedRoots: string[];
  repoRoot?: string | null;
  /** Working directory of the tool call. */
  cwd?: string;
  trackedPathCheck?: (p: string) => boolean;
  phase?: 'implement' | 'tests';
  /** Absolute paths of files the harness owns (from the manifest). */
  harnessOwnedPaths?: string[];
  /** Repo-relative or absolute path prefixes excluded from team commits. */
  excludedPaths?: string[];
  stagedFiles?: () => string[];
  /** Modified (tracked) and untracked files, for `git add -A` / `commit -a` simulation. */
  worktreeStatus?: () => { modified: string[]; untracked: string[] };
  /** The repo's own test globs, when known. */
  testGlobs?: string[];
  /** Harness-shaped paths the brief explicitly allows (repo-relative). */
  allowedShapedPaths?: string[];
  platform?: NodeJS.Platform;
  userHome?: string;
  /** Symlink resolution for path checks. */
  realpath?: (p: string) => string;
}

export interface GuardDecision {
  decision: 'allow' | 'deny';
  rail: RailId | string;
  reason: string;
  matched?: string;
}

const ALLOW: GuardDecision = { decision: 'allow', rail: 'none', reason: 'no rail matched' };

// ---------------------------------------------------------------------------
// Context and path helpers
// ---------------------------------------------------------------------------

interface Ctx {
  input: GuardInput;
  setting: Setting;
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  roots: string[];
  rootsNorm: string[];
  repoRoot: string | null;
  repoRootNorm: string | null;
  windows: boolean;
  phase?: 'implement' | 'tests';
  testGlobRes: RegExp[];
  owned: string[];
  excluded: string[];
  allowedShaped: string[];
  /** The target filesystem folds case (Windows, macOS), so protected roots match case-insensitively. */
  caseInsensitive: boolean;
}

function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1);
  s = path.posix.normalize(s);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function isAbs(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function hasDrive(p: string): boolean {
  return /^[A-Za-z]:\//.test(p);
}

function cmpPath(a: string, b: string, caseFold: boolean): [string, string] {
  if (caseFold || hasDrive(a) || hasDrive(b)) return [a.toLowerCase(), b.toLowerCase()];
  return [a, b];
}

type Relation = 'equal' | 'inside' | 'ancestor' | 'none';

function relation(pNorm: string, rootNorm: string, caseFold: boolean): Relation {
  const [p, r] = cmpPath(pNorm, rootNorm, caseFold);
  if (p === r) return 'equal';
  if (p.startsWith(r.endsWith('/') ? r : r + '/')) return 'inside';
  if (r.startsWith(p.endsWith('/') ? p : p + '/')) return 'ancestor';
  return 'none';
}

function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += '(' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('(^|/)' + re + '$', 'i');
}

function makeCtx(input: GuardInput): Ctx {
  const platform = input.platform ?? process.platform;
  const windows = platform === 'win32';
  const home = normPath(input.userHome ?? input.env.HARNESS_USER_HOME ?? input.env.HOME ?? input.env.USERPROFILE ?? '/');
  const cwd = normPath(input.cwd ?? (typeof (input.toolInput as { cwd?: string })?.cwd === 'string' ? (input.toolInput as { cwd: string }).cwd : process.cwd()));
  const roots = (input.protectedRoots ?? []).filter((r) => typeof r === 'string' && r.trim());
  const repoRoot = input.repoRoot ? normPath(input.repoRoot) : null;
  return {
    input,
    setting: input.setting,
    cwd,
    home,
    env: input.env ?? {},
    roots,
    rootsNorm: roots.map(normPath),
    repoRoot,
    repoRootNorm: repoRoot,
    windows,
    phase: input.phase,
    testGlobRes: (input.testGlobs ?? []).map(globToRe),
    owned: (input.harnessOwnedPaths ?? []).map(normPath),
    excluded: (input.excludedPaths ?? []).map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')),
    allowedShaped: (input.allowedShapedPaths ?? []).map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')),
    caseInsensitive: windows || platform === 'darwin',
  };
}

interface Resolved {
  /** Normalised absolute path, or null when it could not be resolved. */
  abs: string | null;
  /** The text after expanding what we could (for shape checks). */
  text: string;
  dynamic: boolean;
  glob: boolean;
}

const GLOB_CH_RE = /[*?[]/;

/** Expand ~, $HOME-style variables and %VAR%; resolve against cwd. */
function resolvePath(raw: string, ctx: Ctx, cwd = ctx.cwd): Resolved {
  let s = raw.trim();
  if (!s) return { abs: null, text: s, dynamic: false, glob: false };
  // scp/rsync remote prefix "user@host:path" or "host:path" (not a drive letter, not a URL)
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(s)) s = s.slice(s.indexOf(':') + 1);
  else if (/^[A-Za-z0-9._-]{2,}:(?![\\/]{2})/.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) s = s.slice(s.indexOf(':') + 1);
  const vars: Record<string, string | undefined> = {
    HOME: ctx.home,
    USERPROFILE: ctx.home,
    HARNESS_HOME: ctx.env.HARNESS_HOME ?? path.posix.join(ctx.home, '.harness'),
    HARNESS_USER_HOME: ctx.home,
    APPDATA: ctx.env.APPDATA,
    LOCALAPPDATA: ctx.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: ctx.env.XDG_CONFIG_HOME ?? path.posix.join(ctx.home, '.config'),
    CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR ?? path.posix.join(ctx.home, '.claude'),
    CODEX_HOME: ctx.env.CODEX_HOME ?? path.posix.join(ctx.home, '.codex'),
    PWD: cwd,
    TMPDIR: ctx.env.TMPDIR,
    TEMP: ctx.env.TEMP,
    TMP: ctx.env.TMP,
  };
  const lookup = (name: string): string | undefined => {
    const v = vars[name] ?? vars[name.toUpperCase()];
    if (v !== undefined) return v;
    const e = ctx.env[name];
    return typeof e === 'string' ? e : undefined;
  };
  let dynamic = false;
  s = s.replace(/^~(?=\/|$|\\)/, ctx.home);
  s = s.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, n: string) => {
    const v = lookup(n);
    if (v === undefined) dynamic = true;
    return v ?? m;
  });
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, (m, n: string) => {
    const v = lookup(n);
    if (v === undefined) dynamic = true;
    return v ?? m;
  });
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n: string) => {
    const v = lookup(n);
    if (v === undefined) dynamic = true;
    return v ?? m;
  });
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => {
    const v = lookup(n);
    if (v === undefined) dynamic = true;
    return v ?? m;
  });
  if (/\$\(|`|\$\{|\$[A-Za-z_(]|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/.test(s)) dynamic = true;
  let glob = false;
  const gi = s.search(GLOB_CH_RE);
  if (gi >= 0) {
    glob = true;
    s = s.slice(0, gi);
  }
  if (dynamic) return { abs: null, text: s, dynamic: true, glob };
  // On Windows a path that starts with a separator is relative to the current drive.
  if (ctx.windows && /^[\\/]/.test(s) && !s.startsWith('\\\\') && hasDrive(normPath(cwd))) s = normPath(cwd).slice(0, 2) + s;
  const joined = isAbs(s) ? s : joinPath(cwd, s.replace(/\\/g, '/'));
  return { abs: normPath(joined), text: s, dynamic: false, glob };
}

/** Join a relative path onto cwd; a drive root (c:/) is never climbed above. */
function joinPath(cwd: string, rel: string): string {
  const c = normPath(cwd);
  if (hasDrive(c)) return c.slice(0, 2) + path.posix.join(c.slice(2) || '/', rel);
  return path.posix.join(c, rel);
}

interface Hit {
  root: string;
  rel: Relation;
  path: string;
}

/** Protected-root hit for a resolved path; `destructive` also matches ancestors. */
function protectedHit(r: Resolved, ctx: Ctx, destructive: boolean): Hit | null {
  const candidates: string[] = [];
  if (r.abs) {
    candidates.push(r.abs);
    if (ctx.input.realpath) {
      try {
        const real = ctx.input.realpath(r.abs);
        if (real && real !== r.abs) candidates.push(normPath(real));
      } catch {
        /* ignore */
      }
    }
  }
  for (const c of candidates) {
    for (let i = 0; i < ctx.rootsNorm.length; i++) {
      const rel = relation(c, ctx.rootsNorm[i], ctx.caseInsensitive);
      if (rel === 'equal' || rel === 'inside') return { root: ctx.roots[i], rel, path: c };
      if (rel === 'ancestor' && (destructive || r.glob)) return { root: ctx.roots[i], rel, path: c };
    }
    // A glob prefix like ~/.cla* : the prefix is a prefix of a root path
    if (r.glob) {
      for (let i = 0; i < ctx.rootsNorm.length; i++) {
        const [a, b] = cmpPath(c, ctx.rootsNorm[i], ctx.caseInsensitive);
        if (b.startsWith(a) && a.length > ctx.home.length) return { root: ctx.roots[i], rel: 'ancestor', path: c };
      }
    }
  }
  if (r.dynamic && PROTECTED_SHAPE_RE.test(r.text)) return { root: '(dynamic)', rel: 'inside', path: r.text };
  return null;
}

function isSecretPath(p: string): boolean {
  const s = p.replace(/\\/g, '/');
  if (SECRET_EXAMPLE_RE.test(s)) return false;
  return isSecretFile(s) || SECRET_EXTRA_RE.test(s);
}

function isTestPath(p: string, ctx: Ctx): boolean {
  const s = p.replace(/\\/g, '/');
  // The phase rule guards the repository's tests; an absolute path outside it (/tmp/a.test.ts.log) is not one.
  if (ctx.repoRootNorm && isAbs(s) && relation(normPath(s), ctx.repoRootNorm, ctx.caseInsensitive) === 'none') return false;
  const rel = ctx.repoRootNorm && s.startsWith(ctx.repoRootNorm + '/') ? s.slice(ctx.repoRootNorm.length + 1) : s;
  for (const re of TEST_PATH_RES) if (re.test(rel)) return true;
  for (const re of ctx.testGlobRes) if (re.test(rel)) return true;
  return false;
}

/** Harness-shaped check for an in-repo path; returns the kind or null. */
function shapedKind(p: string, ctx: Ctx): 'file' | 'dir' | 'workflow' | null {
  const s = p.replace(/\\/g, '/');
  const base = ctx.repoRootNorm ?? ctx.cwd;
  let rel = s;
  if (isAbs(s)) {
    const r = relation(normPath(s), base, ctx.caseInsensitive);
    if (r !== 'inside' && r !== 'equal') return null;
    rel = normPath(s).slice(base.length + 1);
  }
  if (ctx.allowedShaped.some((a) => rel === a || rel.startsWith(a + '/'))) return null;
  if (WORKFLOW_RE.test(rel)) return 'workflow';
  if ((rel.includes('/') ? HARNESS_SHAPED_FILE_RE_CS : HARNESS_SHAPED_FILE_RE).test(rel)) return 'file';
  if (HARNESS_SHAPED_DIR_RE.test(rel)) return 'dir';
  return null;
}

/** Case-sensitive variant for sub-folders: docs/agents.md is a document, sub/AGENTS.md is an agent file. */
const HARNESS_SHAPED_FILE_RE_CS = new RegExp(HARNESS_SHAPED_FILE_RE.source);

function deny(rail: RailId | string, reason: string, matched?: string): GuardDecision {
  return { decision: 'deny', rail, reason, matched };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function evaluate(input: GuardInput): GuardDecision {
  try {
    return evaluateInner(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny('internal', `The harness guard hit an internal error (${msg.slice(0, 120)}) and fails closed; retry with a simpler command or run \`harness doctor\`.`);
  }
}

/**
 * A command given as an argv array (Codex `shell` / `local_shell` style, e.g.
 * ["bash", "-lc", "git push --force"]) as one POSIX command line, so the
 * parser sees the wrappers. Null when the value is not a non-empty string array.
 */
export function argvToCommand(v: unknown): string | null {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) return null;
  return (v as string[]).map((a) => (a !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function evaluateInner(input: GuardInput): GuardDecision {
  const ctx = makeCtx(input);
  const toolName = String(input.toolName ?? '');
  const ti = (input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : {}) as Record<string, unknown>;

  if (MCP_TOOL_RE.test(toolName) || toolName.startsWith('mcp__')) {
    return evaluateMcp(toolName, input.toolInput, input.config?.mcp);
  }
  const argvCommand = argvToCommand(ti.command) ?? argvToCommand(ti.cmd);
  const command = typeof ti.command === 'string' ? ti.command : argvCommand ?? (typeof ti.cmd === 'string' ? ti.cmd : typeof ti.script === 'string' && COMMAND_TOOL_RE.test(toolName) ? ti.script : null);
  if (command !== null && (COMMAND_TOOL_RE.test(toolName) || typeof ti.command === 'string' || argvCommand !== null)) {
    return evaluateCommandText(command, ctx);
  }
  if (WRITE_TOOL_RE.test(toolName)) return evaluateFileTool(toolName, ti, ctx, 'write');
  if (READ_TOOL_RE.test(toolName)) return evaluateFileTool(toolName, ti, ctx, 'read');
  return ALLOW;
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

const PATH_FIELDS = ['file_path', 'path', 'filePath', 'notebook_path', 'target_file', 'TargetFile', 'filename', 'file', 'AbsolutePath', 'absolute_path', 'new_path', 'old_path', 'destination', 'source', 'dest', 'src', 'target', 'targetPath', 'relative_path', 'relativePath', 'dir', 'directory', 'folder', 'cwd'];
const CONTENT_FIELDS = new Set(['content', 'new_string', 'old_string', 'text', 'body', 'patch', 'input', 'contents', 'new_content', 'old_content', 'code', 'replacement', 'pattern', 'query', 'instruction', 'description', 'prompt', 'message', 'code_edit', 'CodeContent', 'TargetContent', 'ReplacementContent', 'new_str', 'old_str', 'file_text']);

function collectToolPaths(ti: Record<string, unknown>, out: string[], depth = 0): void {
  if (depth > 3) return;
  for (const [k, v] of Object.entries(ti)) {
    if (CONTENT_FIELDS.has(k)) continue;
    if (typeof v === 'string') {
      if (PATH_FIELDS.includes(k) || /path|file|dest|target|dir|folder/i.test(k)) {
        if (v.trim()) out.push(v);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' && (PATH_FIELDS.includes(k) || /path|file/i.test(k))) out.push(x);
        else if (x && typeof x === 'object') collectToolPaths(x as Record<string, unknown>, out, depth + 1);
      }
    } else if (v && typeof v === 'object') collectToolPaths(v as Record<string, unknown>, out, depth + 1);
  }
}

/** Paths named in an apply_patch body or a unified diff. */
export function patchPaths(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^\+\+\+ (?:b\/)?(.+)$|^--- (?:a\/)?(.+)$|^diff --git a\/(.+?) b\/(.+)$|^rename (?:from|to) (.+)$/gm;
  while ((m = re.exec(text))) {
    for (const g of m.slice(1)) if (g && g !== '/dev/null') out.push(g.trim());
  }
  return out;
}

function evaluateFileTool(toolName: string, ti: Record<string, unknown>, ctx: Ctx, mode: 'write' | 'read'): GuardDecision {
  const paths: string[] = [];
  collectToolPaths(ti, paths);
  const patchText = typeof ti.patch === 'string' ? ti.patch : typeof ti.input === 'string' && /apply_patch|patch/i.test(toolName) ? ti.input : typeof ti.content === 'string' && /apply_patch|patch/i.test(toolName) ? ti.content : null;
  if (patchText) paths.push(...patchPaths(patchText));
  for (const raw of paths) {
    if (/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/.test(raw)) {
      return deny('opaque', `The path contains hidden Unicode characters, which the guard treats as tampering; retype it with plain characters.`, raw);
    }
    const r = resolvePath(raw, ctx);
    const p = r.abs ?? r.text;
    if (mode === 'write') {
      const hit = protectedHit(r, ctx, false);
      if (hit) return deny('protect', `${p} is harness-protected (agent configuration or harness state is managed by the harness itself); leave it unchanged and continue with the task.`, p);
      if (isSecretPath(p)) return deny('secrets', `${p} is a secret or env file; the agent never writes those, so leave it alone and tell the user which value is needed.`, p);
      if (ctx.setting === 'team') {
        const kind = shapedKind(p, ctx);
        if (kind === 'file' || kind === 'dir') return deny('team-shaped', `${p} looks like agent-harness configuration, which must never be written inside a team repository; harness files live under the user's home, so skip this file.`, p);
        if (kind === 'workflow') {
          const tracked = ctx.input.trackedPathCheck ? safeTracked(ctx, p) : false;
          if (!tracked) return deny('team-shaped', `${p} would add a new CI workflow to a team repository, which the harness never does; leave CI changes to the user.`, p);
        }
      }
      if (ctx.phase === 'implement' && isTestPath(p, ctx)) {
        return deny('phase-tests', `Test and golden files are read-only during the implement phase (${p}); run \`harness phase tests\` to enter the tests phase, then edit it.`, p);
      }
    } else if (isSecretPath(p)) {
      return deny('secrets', `${p} looks like key material or an env secret and is never read into the transcript; use .env.example or ask the user for the value you need.`, p);
    }
  }
  return ALLOW;
}

function safeTracked(ctx: Ctx, p: string): boolean {
  try {
    const rel = ctx.repoRootNorm && p.startsWith(ctx.repoRootNorm + '/') ? p.slice(ctx.repoRootNorm.length + 1) : p;
    return !!ctx.input.trackedPathCheck?.(rel);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const PS_HINT_RE = /(^|[\s;|&({"'])[A-Z][a-z]+-[A-Z][A-Za-z]+\b|\$env:|-(ServerInstance|LiteralPath|FilePath|Command|EncodedCommand|Query|Database|Path)\b|\|\s*%|\[IO\.|\[System\./;
const CMD_HINT_RE = /%[A-Za-z_][A-Za-z0-9_]*%|(^|[\s&|])(del|erase|rd|rmdir|md|copy|move|ren|type|attrib|icacls|xcopy|robocopy|dir)\s+[^|&]*\\|(^|[\s"'=>])[A-Za-z]:\\|\s\/[ck]\s/i;

function dialectsFor(command: string, ctx: Ctx): Dialect[] {
  const out: Dialect[] = ['posix'];
  if (ctx.windows || PS_HINT_RE.test(command)) out.push('powershell');
  if (ctx.windows || CMD_HINT_RE.test(command)) out.push('cmd');
  return out;
}

export function evaluateCommandText(command: string, ctx: Ctx): GuardDecision {
  if (typeof command !== 'string') return ALLOW;
  if (command.length > 200_000) return deny('opaque', 'The command is too long for the guard to read; split it into smaller commands.');
  for (const d of dialectsFor(command, ctx)) {
    const parsed = parseCommand(command, { dialect: d });
    if (parsed.hiddenUnicode) {
      return deny('opaque', 'The command contains hidden Unicode characters (zero-width or bidi controls), which the guard treats as tampering; retype it with plain characters.');
    }
    const r = evaluateParsed(parsed, ctx, ctx.cwd);
    if (r.decision === 'deny') return r;
  }
  return ALLOW;
}

/** Evaluate a parsed command; cwd is tracked across top-level segments. */
function evaluateParsed(parsed: ParsedCommand, ctx: Ctx, startCwd: string): GuardDecision {
  let cwd = startCwd;
  for (const seg of parsed.segments) {
    const r = evaluateSegment(seg, parsed, ctx, cwd);
    const subDeny = (): GuardDecision | null => {
      for (const sub of seg.subshells) {
        const rs = evaluateParsed(sub, ctx, cwd);
        if (rs.decision === 'deny') return rs;
      }
      return null;
    };
    if (r.decision === 'deny') {
      // $(git push --force): the substitution's rail is more specific than "opaque".
      if (r.rail === 'opaque') {
        const sd = subDeny();
        if (sd && sd.rail !== 'opaque') return sd;
      }
      return r;
    }
    const sd = subDeny();
    if (sd) return sd;
    if (seg.inner) {
      const ri = evaluateParsed(seg.inner, ctx, cwd);
      if (ri.decision === 'deny') return ri;
    }
    if ((seg.prog === 'cd' || seg.prog === 'pushd' || seg.prog === 'set-location' || seg.prog === 'sl' || seg.prog === 'chdir') && seg.args.length) {
      const target = seg.args.find((a) => !a.startsWith('-') && !(seg.dialect === 'cmd' && /^\/[a-zA-Z]$/.test(a))) ?? '';
      const r2 = resolvePath(target, ctx, cwd);
      if (r2.abs) cwd = r2.abs;
    }
  }
  return ALLOW;
}

const STDIN_OPAQUE = new Set(['shell reads its script from stdin', 'PowerShell reads its command from stdin', 'cmd reads its commands from stdin', 'interpreter reads code from stdin', 'Invoke-Expression reads from stdin']);
const HARD_OPAQUE = new Set(['program name is computed at run time', 'unreadable program name', 'nesting too deep', 'too many wrappers', 'undecodable -EncodedCommand', 'code string is a variable', 'remote command is a variable', 'tokenizer error', 'eval of a variable', 'Invoke-Expression of a variable', 'shell -c without a command string']);
const FETCH_PROGS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'fetch', 'aria2c', 'nc', 'ncat']);
/** Programs that turn opaque bytes into a command (`... | base64 -d | sh`); the decoded script cannot be read. */
const DECODER_PROGS = new Set(['base64', 'base32', 'basenc', 'xxd', 'uudecode', 'uncompress', 'gunzip', 'zcat', 'gzip', 'bunzip2', 'bzcat', 'bzip2', 'unxz', 'xzcat', 'xz', 'zstd', 'zstdcat', 'brotli', 'openssl', 'gpg', 'gpg2']);
/** True when a decoder is actually decoding (not just a header or re-encode) on this segment. */
function isDecoding(seg: Segment): boolean {
  if (!DECODER_PROGS.has(seg.prog)) return false;
  if (seg.prog === 'xxd') return seg.args.some((a) => a === '-r' || a === '--revert');
  if (seg.prog === 'base64' || seg.prog === 'base32' || seg.prog === 'basenc') return seg.args.some((a) => a === '-d' || a === '-D' || a === '--decode');
  if (seg.prog === 'openssl') return seg.args.some((a) => a === '-d' || a === '-decrypt') || seg.args.includes('base64');
  if (seg.prog === 'gpg' || seg.prog === 'gpg2') return seg.args.some((a) => a === '-d' || a === '--decrypt');
  // The decompressors below default to decompressing; zcat/bzcat/xzcat/zstdcat always decompress.
  if (['gzip', 'bzip2', 'xz', 'zstd', 'brotli'].includes(seg.prog)) return seg.args.some((a) => a === '-d' || a === '--decompress' || a === '--decode');
  return true;
}

function pipelinePeers(seg: Segment, parsed: ParsedCommand): Segment[] {
  return parsed.segments.filter((s) => s !== seg && s.pipeline === seg.pipeline);
}

function evaluateSegment(seg: Segment, parsed: ParsedCommand, ctx: Ctx, cwd: string): GuardDecision {
  // --- opaque -------------------------------------------------------------
  if (seg.opaque && seg.opaqueReason) {
    const reason = seg.opaqueReason;
    if (reason === 'program name is computed at run time') {
      return deny('opaque', 'The command\'s program is computed at run time ($(...), a backtick or a variable), so the guard cannot check it; write the program name literally.', seg.progRaw);
    }
    if (HARD_OPAQUE.has(reason)) {
      return deny('opaque', `Part of the command cannot be read by the guard (${reason}); write it literally without variables or nested encoding.`, reason);
    }
    if (STDIN_OPAQUE.has(reason)) {
      const peers = pipelinePeers(seg, parsed);
      const peerText = peers.map(segmentText).join('\n');
      if (peers.some((p) => FETCH_PROGS.has(p.prog))) {
        return deny('opaque', 'Piping a download straight into a shell or interpreter cannot be checked; download to a file, read it, then run it.', reason);
      }
      if (peers.some((p) => isDecoding(p))) {
        return deny('opaque', 'Piping decoded or decompressed bytes straight into a shell or interpreter cannot be checked; write the decoded output to a file, read it, then run it.', reason);
      }
      if (DB_KEYWORD_RE.test(peerText) || PROTECTED_SHAPE_RE.test(peerText) || /\bgit\b/.test(peerText)) {
        return deny('opaque', `A shell reads its script from stdin and the input mentions a database client, git or harness files, so the guard cannot check it (${reason}); write the commands literally.`, reason);
      }
    }
  }
  if (!seg.prog) {
    // Assignment-only segments (VAR=value) and PowerShell expression statements run no
    // program by name; the text-based rails (writes, secrets, database) still apply.
    const w0 = writeChecks(seg, parsed, ctx, cwd);
    if (w0) return w0;
    const s0 = secretsCheck(seg, parsed, ctx, cwd);
    if (s0) return s0;
    const d = dbCheck(seg, ctx, parsed);
    return d ?? ALLOW;
  }

  // --- nested agent -------------------------------------------------------
  const nested = nestedAgentCheck(seg);
  if (nested) return nested;

  // --- harness admin commands ---------------------------------------------
  const admin = harnessAdminCheck(seg);
  if (admin) return admin;

  // --- git ----------------------------------------------------------------
  if (seg.prog === 'git') {
    const g = gitCheck(seg, parsed, ctx, cwd);
    if (g) return g;
  }

  // --- gh / glab / hub and HTTP mutations (team) -------------------------
  const team = teamPublishCheck(seg, ctx);
  if (team) return team;

  // --- protected roots, harness-shaped, test phase ------------------------
  const w = writeChecks(seg, parsed, ctx, cwd);
  if (w) return w;

  // --- secrets ------------------------------------------------------------
  const sec = secretsCheck(seg, parsed, ctx, cwd);
  if (sec) return sec;

  // --- database -----------------------------------------------------------
  const d = dbCheck(seg, ctx, parsed);
  if (d) return d;

  return ALLOW;
}

function dbCheck(seg: Segment, ctx: Ctx, parsed?: ParsedCommand): GuardDecision | null {
  let producer: Segment | undefined;
  if (seg.stdinFromPipe && parsed) {
    const idx = parsed.segments.indexOf(seg);
    if (idx > 0) producer = parsed.segments[idx - 1];
  }
  const r = evaluateDbSegment(seg, ctx.env, ctx.input.config?.db ?? { allowlist: [] }, producer);
  if (!r) return null;
  if (r.decision === 'deny') return deny(r.rail, r.reason, r.matched);
  return null;
}

// ---------------------------------------------------------------------------
// Harness admin commands
// ---------------------------------------------------------------------------

/** Returns the harness subcommand words when the segment invokes the harness CLI, else null. */
function harnessArgs(seg: Segment): string[] | null {
  if (HARNESS_PROGS.has(seg.prog)) return seg.args;
  if (seg.prog === 'node' || seg.prog === 'nodejs') {
    // The script path is the argument that names the harness CLI, wherever it
    // sits: node options that take a separate-token value (-r <m>, -C <cond>,
    // --loader <m>, --import <m>, ...) would otherwise push it past "the first
    // non-flag argument" and hide the invocation (admin-rail bypass).
    const i = seg.args.findIndex((a) => HARNESS_CLI_PATH_RE.test(a));
    if (i >= 0) return seg.args.slice(i + 1);
    return null;
  }
  if (HARNESS_CLI_PATH_RE.test(seg.prog) || HARNESS_CLI_PATH_RE.test(seg.progRaw)) return seg.args;
  return null;
}

function harnessAdminCheck(seg: Segment): GuardDecision | null {
  const args = harnessArgs(seg);
  if (!args) return null;
  // The harness invoked with its arguments coming from stdin (`... | xargs
  // harness`, `harness $(cat file)`): the subcommand cannot be read, so the
  // guard cannot tell an admin command from a read-only one. Fail closed.
  if (seg.argsFromStdin) {
    return deny(
      'harness-admin',
      `The harness is being run with its arguments coming from stdin (e.g. through xargs), so the guard cannot tell whether this is an admin command; run the harness command yourself with the subcommand written out.`,
      'harness <args-from-stdin>',
    );
  }
  const words = args.filter((a) => !a.startsWith('-'));
  const sub = (words[0] ?? '').toLowerCase();
  const second = (words[1] ?? '').toLowerCase();
  const flagged = args.find((a) => HARNESS_ADMIN_FLAGS.has(a.toLowerCase().split('=')[0]));
  const secondFlags = HARNESS_ADMIN_SECOND_FLAGS[sub]?.[second] ?? [];
  const secondFlag = args.find((a) => secondFlags.includes(a.toLowerCase().split('=')[0]));
  let what: string | null = null;
  if (HARNESS_ADMIN_SUBS.has(sub)) what = `harness ${sub}`;
  else if (HARNESS_ADMIN_SECOND[sub]?.has(second)) what = `harness ${sub} ${second}`;
  else if (secondFlag) what = `harness ${sub} ${second} ${secondFlag}`;
  else if (flagged) what = `harness ${sub} ${flagged}`;
  if (!what) return null;
  return deny(
    'harness-admin',
    `${what} changes the harness's rails or agent configuration, so only the user runs it, in a terminal; ask the user to run: harness ${args.join(' ')}`,
    what,
  );
}

// ---------------------------------------------------------------------------
// Nested agents
// ---------------------------------------------------------------------------

function nestedAgentCheck(seg: Segment): GuardDecision | null {
  if (!NESTED_AGENTS.has(seg.prog)) return null;
  const agent = seg.prog === 'claude-code' ? 'claude' : seg.prog;
  const args = seg.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const lower = a.toLowerCase();
    if (BYPASS_FLAGS.has(lower)) return deny('nested-agent', `Nested ${agent} runs must keep hooks and permissions on; drop ${a} and run it again.`, a);
    if (BYPASS_FLAG_PREFIXES.some((p) => lower.startsWith(p))) return deny('nested-agent', `Nested ${agent} runs must keep hooks and permissions on; drop ${a} and run it again.`, a);
    for (const pair of BYPASS_VALUE_PAIRS) {
      if (lower === pair.flag && pair.valueRe.test(args[i + 1] ?? '')) return deny('nested-agent', `Nested ${agent} runs must keep hooks, sandbox and permissions on; drop ${a} ${args[i + 1]} and run it again.`, `${a} ${args[i + 1]}`);
      if (lower.startsWith(pair.flag + '=') && pair.valueRe.test(a.slice(pair.flag.length + 1))) return deny('nested-agent', `Nested ${agent} runs must keep hooks, sandbox and permissions on; drop ${a} and run it again.`, a);
    }
    const tok = seg.argTokens[i];
    if (tok?.dynamic && /^\$/.test(tok.text)) return deny('nested-agent', `Flags for a nested ${agent} run come from a variable (${a}), which the guard cannot check; write the flags literally.`, a);
  }
  for (const name of Object.keys(seg.env)) {
    if (BYPASS_ENV_RE.test(name)) return deny('nested-agent', `The environment variable ${name} on a nested ${agent} run could change its hooks or permissions; drop it and run again.`, name);
  }
  const positionals = args.filter((a) => !a.startsWith('-'));
  const cfg = AGENT_CONFIG_SUBS.find((c) => c.agent === agent);
  if (cfg && positionals[0] && cfg.re.test(positionals[0]) && !AGENT_CONFIG_READ_SUBS.has(positionals[1] ?? '')) {
    return deny('protect', `\`${agent} ${positionals.slice(0, 2).join(' ')}\` edits the agent's own configuration, which the harness manages; leave agent settings, plugins and MCP servers to the user.`, positionals.slice(0, 2).join(' '));
  }
  return null;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface GitSplit {
  sub: string;
  subArgs: string[];
  subTokens: Token[];
  dirs: string[];
  configs: string[];
  configFiles: string[];
}

function splitGit(seg: Segment): GitSplit {
  const args = seg.args;
  const toks = seg.argTokens;
  const out: GitSplit = { sub: '', subArgs: [], subTokens: [], dirs: [], configs: [], configFiles: [] };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-C') {
      out.dirs.push(args[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (a === '-c') {
      out.configs.push(args[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (a.startsWith('-c') && a.length > 2 && !a.startsWith('--')) {
      out.configs.push(a.slice(2));
      i++;
      continue;
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      out.dirs.push(a.slice(a.indexOf('=') + 1));
      i++;
      continue;
    }
    if (a === '--git-dir' || a === '--work-tree') {
      out.dirs.push(args[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (a.startsWith('--config-env=')) {
      out.configs.push(a.slice(13).replace(/=.*$/, '=env'));
      i++;
      continue;
    }
    if (a === '--config-env') {
      out.configs.push((args[i + 1] ?? '').replace(/=.*$/, '=env'));
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTS.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('--') && GIT_GLOBAL_VALUE_OPTS.has(a.split('=')[0])) {
      i++;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(a) || a.startsWith('--list-cmds') || a === '--version' || a === '--help' || a === '-h') {
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    out.sub = a.toLowerCase();
    out.subArgs = args.slice(i + 1);
    out.subTokens = toks.slice(i + 1);
    break;
  }
  return out;
}

const GIT_VALUE_FLAGS: Record<string, Set<string>> = {
  commit: new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author', '--date', '--trailer', '-t', '--template', '--fixup', '--squash', '--cleanup', '--gpg-sign', '-S']),
  push: new Set(['--receive-pack', '--exec', '--repo', '-o', '--push-option', '--signed']),
  tag: new Set(['-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format']),
  branch: new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--sort', '--format', '--points-at', '-u', '--set-upstream-to', '--color']),
  stash: new Set(['-m', '--message']),
  add: new Set(['--chmod', '--pathspec-from-file']),
  merge: new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--gpg-sign', '--cleanup', '--into-name']),
  pull: new Set(['-s', '--strategy', '-X', '--strategy-option', '--gpg-sign', '--cleanup', '--log', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--upload-pack', '-o', '--server-option', '--negotiation-tip', '--recurse-submodules', '-j', '--jobs']),
  reset: new Set(['--pathspec-from-file']),
  rebase: new Set([]),
  checkout: new Set(['-b', '--orphan', '--conflict', '--pathspec-from-file']),
  switch: new Set(['-c', '--create', '--orphan', '--conflict']),
};

/** Flags and positionals of a subcommand, with value-taking flags' values removed. */
function gitFlagsAndPositionals(sub: string, subArgs: string[]): { flags: string[]; positionals: string[] } {
  const valueFlags = GIT_VALUE_FLAGS[sub] ?? new Set<string>();
  const flags: string[] = [];
  const positionals: string[] = [];
  let i = 0;
  let afterDashDash = false;
  while (i < subArgs.length) {
    const a = subArgs[i];
    if (afterDashDash) {
      positionals.push(a);
      i++;
      continue;
    }
    if (a === '--') {
      afterDashDash = true;
      i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (valueFlags.has(name) && !a.includes('=')) {
        flags.push(a);
        i += 2;
        continue;
      }
      // short cluster with attached message: -mfoo
      if (/^-[a-zA-Z]{2,}$/.test(a)) {
        const letters = a.slice(1).split('');
        const expanded: string[] = [];
        for (let k = 0; k < letters.length; k++) {
          const f = '-' + letters[k];
          expanded.push(f);
          if (valueFlags.has(f)) {
            // rest of the cluster is the value
            if (k === letters.length - 1) i++; // value is the next arg
            break;
          }
        }
        flags.push(...expanded);
        i++;
        continue;
      }
      flags.push(a);
      i++;
      continue;
    }
    positionals.push(a);
    i++;
  }
  return { flags, positionals };
}

function settingApplies(settings: Setting[] | 'all', setting: Setting): boolean {
  return settings === 'all' || settings.includes(setting);
}

function gitCheck(seg: Segment, parsed: ParsedCommand, ctx: Ctx, cwd: string): GuardDecision | null {
  const g = splitGit(seg);
  const sub = g.sub;
  const setting = ctx.setting;

  // -c key=value global config and --config-env (checked after the subcommand rails, which are more specific)
  const configDeny = (): GuardDecision | null => {
    for (const c of g.configs) {
      const key = c.split('=')[0];
      const value = c.includes('=') ? c.slice(c.indexOf('=') + 1) : 'true';
      const d = configKeyCheck(key, value, ctx);
      if (d) return d;
    }
    return null;
  };

  // Protected roots reached through -C / --git-dir / --work-tree / GIT_* env / cwd
  const protectDirs: string[] = [...g.dirs];
  for (const name of GIT_ENV_PATHS) if (seg.env[name] !== undefined) protectDirs.push(seg.env[name]);
  const mutating = GIT_MUTATING_SUBS.has(sub) || (sub === 'config' && !isConfigRead(g.subArgs));
  for (const dRaw of protectDirs) {
    const r = resolvePath(dRaw, ctx, cwd);
    const hit = protectedHit(r, ctx, false);
    if (hit && (mutating || r.dynamic)) return deny('protect', `git would operate inside ${hit.path}, which is harness-protected (harness state or agent configuration); leave it unchanged and work in the task repository.`, hit.path);
  }
  if (mutating && !g.dirs.length) {
    const r: Resolved = { abs: cwd, text: cwd, dynamic: false, glob: false };
    const hit = protectedHit(r, ctx, false);
    if (hit) return deny('protect', `git ${sub} would modify ${hit.path}, which is harness-protected; the harness manages its own state, so leave it unchanged and work in the task repository.`, hit.path);
  }

  if (!sub) return configDeny();
  const { flags, positionals } = gitFlagsAndPositionals(sub, g.subArgs);
  // Long options match case-insensitively (--Force); short ones exactly (-d is not -D).
  const flagsN = flags.map((f) => (f.startsWith('--') ? f.toLowerCase() : f));
  const expanded = expandShortFlags(flagsN);
  const hasFlag = (f: string) => expanded.includes(f) || flagsN.includes(f);

  // Deny specs
  for (const spec of GIT_DENY) {
    if (!settingApplies(spec.settings, setting)) continue;
    if (!spec.sub.includes(sub)) continue;
    let hit: string | null = null;
    if (spec.always) hit = `git ${sub}`;
    if (!hit && spec.flags) for (const f of spec.flags) if (hasFlag(f)) hit = f;
    if (!hit && spec.flagPrefixes) for (const p of spec.flagPrefixes) for (const f of flagsN) if (f.startsWith(p)) hit = f;
    if (!hit && spec.flagCombos) for (const combo of spec.flagCombos) if (combo.every((f) => hasFlag(f))) hit = combo.join(' ');
    if (!hit && spec.argRe) for (const p of positionals) if (spec.argRe.test(p)) hit = p;
    if (!hit && spec.firstArg && positionals.length && spec.firstArg.includes(positionals[0].toLowerCase())) hit = positionals[0];
    if (hit) return deny(spec.rail, spec.reason, `git ${sub} ${hit}`.trim());
  }

  // Dynamic flags on push (personal: could hide --force)
  if (sub === 'push' && g.subTokens.some((t) => t.dynamic && /^\$|`/.test(t.text))) {
    return deny('git-history', 'git push takes its flags from a variable, which the guard cannot check for --force; write the push command literally.', 'git push $...');
  }
  const cd = configDeny();
  if (cd) return cd;

  // config key
  if (sub === 'config') {
    const d = configSubCheck(g.subArgs, ctx, cwd);
    if (d) return d;
  }

  // Secret / shaped reads and writes through git itself
  const secretArg = (p: string) => isSecretPath(p.replace(/^[^:]*:(?=[^/\\])/, ''));
  if (['show', 'diff', 'grep', 'blame', 'cat-file', 'log', 'archive', 'annotate', 'difftool'].includes(sub)) {
    const hitP = positionals.find(secretArg);
    if (hitP) return deny('secrets', `git ${sub} would print ${hitP}, which looks like a secret or env file; secrets are never read into the transcript, so ask the user for the value you need.`, hitP);
  }
  if (['checkout', 'restore', 'rm', 'mv', 'clean', 'apply', 'am'].includes(sub)) {
    const hitP = positionals.find(secretArg);
    if (hitP && !(sub === 'rm' && flags.includes('--cached'))) return deny('secrets', `git ${sub} would change ${hitP}, which is a secret or env file; the agent never writes those, so leave it alone.`, hitP);
    if (ctx.phase === 'implement') {
      const t = positionals.find((p) => isTestPath(resolvePath(p, ctx, cwd).abs ?? p, ctx));
      if (t) return deny('phase-tests', `Test and golden files are read-only during the implement phase (${t}); run \`harness phase tests\` to enter the tests phase, then change it.`, t);
    }
  }

  // git add
  if (sub === 'add') {
    const d = gitAddCheck(positionals, flags, ctx, cwd);
    if (d) return d;
  }

  // git commit: staging check
  if (sub === 'commit') {
    const d = gitCommitCheck(flags, positionals, seg, parsed, ctx, cwd);
    if (d) return d;
  }

  // clone / init / worktree add into protected roots
  if (sub === 'clone' || sub === 'init' || (sub === 'worktree' && positionals[0] === 'add')) {
    const dest = sub === 'clone' ? positionals[1] : sub === 'init' ? positionals[0] : positionals[1];
    if (dest) {
      const hit = protectedHit(resolvePath(dest, ctx, cwd), ctx, false);
      if (hit) return deny('protect', `git ${sub} would write into ${hit.path}, which is harness-protected; choose a location inside the task workspace.`, hit.path);
    }
  }
  return null;
}

function isConfigRead(subArgs: string[]): boolean {
  return subArgs.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--show-origin|--show-scope|--name-only|--get-colorbool|--get-color|list|get)$/.test(a)) && !subArgs.some((a) => /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|set|unset|--edit|-e)$/.test(a));
}

function configKeyCheck(key: string, value: string, ctx: Ctx): GuardDecision | null {
  const k = key.trim();
  for (const rule of GIT_CONFIG_DENY) {
    if (!settingApplies(rule.settings, ctx.setting)) continue;
    if (!rule.re.test(k)) continue;
    if (rule.id === 'git.config.rebase' && GIT_REBASE_FALSE.has(value.trim().toLowerCase())) continue;
    return deny(rule.rail, rule.reason, `${k}=${value.slice(0, 40)}`);
  }
  return null;
}

function configSubCheck(subArgs: string[], ctx: Ctx, cwd: string): GuardDecision | null {
  if (subArgs.some((a) => a === '--edit' || a === '-e')) {
    return deny('git-hooks-bypass', 'Editing git config in an editor cannot be checked by the guard; set single keys explicitly (git config <key> <value>) or leave the config alone.', '--edit');
  }
  // --file / -f target
  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    const fileVal = a === '-f' || a === '--file' ? subArgs[i + 1] : a.startsWith('--file=') ? a.slice(7) : null;
    if (fileVal) {
      const hit = protectedHit(resolvePath(fileVal, ctx, cwd), ctx, false);
      if (hit) return deny('protect', `git config would write ${hit.path}, which is harness-protected; leave it unchanged.`, hit.path);
    }
  }
  if (isConfigRead(subArgs)) return null;
  const valueOpts = new Set(['-f', '--file', '--blob', '--type', '--default', '--worktree-file']);
  const positionals: string[] = [];
  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    if (a === '--') {
      positionals.push(...subArgs.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (valueOpts.has(a)) i++;
      continue;
    }
    positionals.push(a);
  }
  // `git config set key value` (new syntax) and `git config key value`
  const idx = positionals[0] === 'set' || positionals[0] === 'unset' ? 1 : 0;
  const key = positionals[idx];
  const value = positionals[idx + 1] ?? 'true';
  if (!key) return null;
  if (positionals[0] === 'unset' || subArgs.includes('--unset') || subArgs.includes('--unset-all')) return null;
  return configKeyCheck(key, value, ctx);
}

function gitAddCheck(positionals: string[], flags: string[], ctx: Ctx, cwd: string): GuardDecision | null {
  const updateOnly = flags.some((f) => f === '-u' || f === '--update');
  const broad = updateOnly || flags.some((f) => ['-A', '--all', '--no-ignore-removal', '--ignore-removal'].includes(f)) || positionals.some((p) => p === '.' || p === ':/' || p === '*' || p === './');
  const candidates: string[] = [...positionals];
  if (broad && ctx.input.worktreeStatus) {
    try {
      const st = ctx.input.worktreeStatus();
      candidates.push(...st.modified);
      if (!updateOnly) candidates.push(...st.untracked);
    } catch {
      /* ignore */
    }
  }
  for (const p of candidates) {
    if (isSecretPath(p)) return deny('secrets', `git add would stage ${p}, which looks like a secret or env file; add it to .gitignore and keep it out of the commit.`, p);
  }
  if (ctx.setting === 'team') {
    for (const p of candidates) {
      const kind = shapedKind(p, ctx);
      if (kind === 'file' || kind === 'dir') return deny('team-shaped', `git add would stage ${p}, which looks like agent-harness configuration; nothing of the harness goes into a team repository, so leave it unstaged.`, p);
      if (kind === 'workflow' && !safeTracked(ctx, p)) return deny('team-shaped', `git add would stage a new CI workflow (${p}) in a team repository, which the harness never does; leave it unstaged.`, p);
      const owned = ownedHit(p, ctx, cwd);
      if (owned) return deny('staging', `git add would stage ${p}, a file the harness owns; harness files never go into a team repository, so leave it unstaged.`, p);
    }
  }
  return null;
}

function ownedHit(p: string, ctx: Ctx, cwd: string): string | null {
  if (!ctx.owned.length) return null;
  const r = resolvePath(p, ctx, cwd);
  if (!r.abs) return null;
  for (const o of ctx.owned) {
    const rel = relation(r.abs, o, ctx.caseInsensitive);
    if (rel === 'equal' || rel === 'inside') return o;
  }
  return null;
}

function excludedHit(p: string, ctx: Ctx): string | null {
  const s = p.replace(/\\/g, '/');
  for (const e of ctx.excluded) {
    if (!e) continue;
    if (s === e || s.startsWith(e + '/') || s.endsWith('/' + e) || s.includes('/' + e + '/')) return e;
  }
  return null;
}

function gitCommitCheck(flags: string[], positionals: string[], seg: Segment, parsed: ParsedCommand, ctx: Ctx, cwd: string): GuardDecision | null {
  // A commit that redirects the index, git-dir or work-tree through the
  // environment commits a different set of files than `git diff --cached`
  // reports from the default index, so the staging check below would inspect
  // the wrong set. The guard cannot verify such a commit; fail closed.
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'] as const) {
    if (seg.env[name] !== undefined || parsed.segments.some((s) => s !== seg && s.env[name] !== undefined && s.pipeline === seg.pipeline)) {
      return deny('staging', `This commit sets ${name}, so it would commit from a different index than the one the harness can inspect; commit from the repository's own index (unset ${name}) so the staging check can run.`, name);
    }
  }
  const files = new Set<string>();
  try {
    for (const f of ctx.input.stagedFiles?.() ?? []) files.add(f);
  } catch {
    /* treated as no staged files */
  }
  const all = flags.some((f) => ['-a', '--all', '-i', '--include'].includes(f));
  let status: { modified: string[]; untracked: string[] } | null = null;
  const getStatus = () => {
    if (status) return status;
    try {
      status = ctx.input.worktreeStatus?.() ?? { modified: [], untracked: [] };
    } catch {
      status = { modified: [], untracked: [] };
    }
    return status;
  };
  if (all) for (const f of getStatus().modified) files.add(f);
  for (const p of positionals) files.add(p);
  // Earlier `git add` segments in the same command stage more files before the commit runs.
  for (const other of parsed.segments) {
    if (other === seg) break;
    if (other.prog !== 'git') continue;
    const og = splitGit(other);
    if (og.sub !== 'add') continue;
    const { flags: of, positionals: op } = gitFlagsAndPositionals('add', og.subArgs);
    const broad = of.some((f) => ['-A', '--all', '-u', '--update'].includes(f)) || op.some((p) => p === '.' || p === ':/' || p === '*');
    for (const p of op) if (p !== '.' && p !== ':/' && p !== '*') files.add(p);
    if (broad) {
      const st = getStatus();
      for (const f of st.modified) files.add(f);
      if (!of.includes('-u') && !of.includes('--update')) for (const f of st.untracked) files.add(f);
    }
  }
  for (const f of files) {
    if (isSecretPath(f)) return deny('staging', `Commit refused while ${f} is staged (it looks like a secret or env file); run \`git rm --cached ${f}\` and commit again.`, f);
  }
  if (ctx.setting === 'team') {
    for (const f of files) {
      const owned = ownedHit(f, ctx, cwd);
      if (owned) return deny('staging', `Commit refused while ${f} is staged (the harness owns it and nothing of the harness goes into a team repository); run \`git rm --cached ${f}\` and commit again.`, f);
      const ex = excludedHit(f, ctx);
      if (ex) return deny('staging', `Commit refused while ${f} is staged (it is under the excluded path ${ex}); run \`git rm --cached ${f}\` and commit again.`, f);
      const kind = shapedKind(f, ctx);
      if (kind === 'file' || kind === 'dir') return deny('staging', `Commit refused while ${f} is staged (it looks like agent-harness configuration, which never goes into a team repository); run \`git rm --cached ${f}\` and commit again.`, f);
      if (kind === 'workflow' && !safeTracked(ctx, f)) return deny('staging', `Commit refused while ${f} is staged (a new CI workflow in a team repository); run \`git rm --cached ${f}\` and commit again.`, f);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Team: gh / glab / hub and HTTP writes to code hosts
// ---------------------------------------------------------------------------

const HTTP_PROGS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'fetch']);

function teamPublishCheck(seg: Segment, ctx: Ctx): GuardDecision | null {
  const prog = seg.prog;
  if (prog === 'gh' || prog === 'glab' || prog === 'hub') {
    const list = prog === 'gh' ? GH_READONLY : prog === 'glab' ? GLAB_READONLY : HUB_READONLY;
    const args = seg.args;
    // global flags with values
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-R' || a === '--repo' || a === '--hostname' || a === '-H') {
        i++;
        continue;
      }
      if (a.startsWith('-')) {
        positionals.push(a);
        continue;
      }
      positionals.push(a);
    }
    const words = positionals.filter((p) => !p.startsWith('-'));
    const sub = (words[0] ?? '').toLowerCase();
    const sub2 = (words[1] ?? '').toLowerCase();
    // Token printing is a secret leak in every setting.
    if (sub === 'auth' && (sub2 === 'token' || sub2 === 'login' || sub2 === 'refresh' || sub2 === 'setup-git')) {
      if (sub2 === 'token') return deny('secrets', '`gh auth token` would print a credential into the transcript; use gh commands that need no explicit token.', 'gh auth token');
      if (ctx.setting === 'team') return deny('team-gh', `\`${prog} auth ${sub2}\` changes credentials, which the agent never does in the team setting; ask the user.`, `${prog} auth ${sub2}`);
    }
    if (prog === 'gh' && sub === 'repo' && (sub2 === 'delete' || sub2 === 'archive')) {
      return deny('team-gh', `\`gh repo ${sub2}\` is irreversible and is never run by the agent; ask the user.`, `gh repo ${sub2}`);
    }
    if (ctx.setting !== 'team') {
      if (sub === 'api') {
        const method = apiMethod(args);
        if (method === 'DELETE') return deny('team-gh', '`gh api -X DELETE` is irreversible and is never run by the agent; ask the user.', 'gh api DELETE');
      }
      return null;
    }
    const key = `${sub} ${sub2}`.trim();
    const allowed = list.includes(sub) || list.includes(key) || sub === '' || sub.startsWith('-');
    if (!allowed) {
      return deny('team-gh', `In the team setting the agent never posts to the code host (\`${prog} ${key}\` would); finish with \`harness writeup\` and let the user open the pull request or comment.`, `${prog} ${key}`);
    }
    if (sub === 'api') {
      const method = apiMethod(args);
      const mutating = args.some((a) => GH_API_MUTATING_FLAGS.has(a) || a.startsWith('--method=') || a.startsWith('--field=') || a.startsWith('--raw-field=') || a.startsWith('--input=')) || (method !== null && method !== 'GET' && method !== 'HEAD');
      if (mutating && !(method === 'GET' && !args.some((a) => a === '-f' || a === '-F' || a === '--field' || a === '--raw-field' || a === '--input')))
        return deny('team-gh', `In the team setting \`${prog} api\` may only read (GET without fields); this call would write to the code host, so leave it to the user.`, `${prog} api`);
    }
    return null;
  }
  if (ctx.setting === 'team' && HTTP_PROGS.has(prog)) {
    const args = seg.args;
    const url = args.find((a) => CODE_HOST_RE.test(a) && /^(https?:\/\/|api\.|github\.com|gitlab\.com)/i.test(a)) ?? args.find((a) => CODE_HOST_RE.test(a));
    if (!url) return null;
    let mutating = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (HTTP_MUTATING_FLAGS.has(name) || HTTP_MUTATING_FLAGS.has(name.toLowerCase())) mutating = true;
      if (/^(-X|--request|--method|-Method|-m)$/i.test(a) && !/^(GET|HEAD|OPTIONS)$/i.test(args[i + 1] ?? '')) mutating = true;
      if (/^(--request|--method)=(?!GET|HEAD|OPTIONS)/i.test(a)) mutating = true;
      if (/^-(Body|InFile|Method:(?!GET|HEAD))/i.test(a)) mutating = true;
      if (prog === 'http' || prog === 'https' || prog === 'xh') {
        if (/^(POST|PUT|PATCH|DELETE)$/i.test(a)) mutating = true;
        if (/^[A-Za-z_]+[:=]/.test(a) && !a.startsWith('http')) mutating = true;
      }
    }
    if (mutating) return deny('team-gh', `In the team setting the agent never writes to the code host (${url.slice(0, 60)}); finish with \`harness writeup\` and let the user post it.`, url.slice(0, 60));
  }
  return null;
}

function apiMethod(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') return (args[i + 1] ?? '').toUpperCase();
    if (a.startsWith('--method=')) return a.slice(9).toUpperCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const READER_PROGS = new Set(['cat', 'type', 'gc', 'get-content', 'less', 'more', 'head', 'tail', 'bat', 'view', 'strings', 'xxd', 'hexdump', 'hd', 'od', 'base64', 'base32', 'uuencode', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'gawk', 'mawk', 'sed', 'cut', 'sort', 'uniq', 'tac', 'nl', 'pr', 'fold', 'fmt', 'column', 'paste', 'join', 'comm', 'diff', 'cmp', 'jq', 'yq', 'select-string', 'sls', 'import-csv', 'get-item', 'cat', 'tee', 'rev', 'iconv', 'dos2unix', 'unix2dos', 'expand', 'unexpand', 'look', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'lua', 'rscript', 'xargs', 'openssl', 'gpg', 'gpg2', 'age', 'sops', 'git-crypt', 'certutil', 'envsubst', 'dotenv-linter', 'source', '.']);
const VALUE_FLAGS_GENERIC = new Set(['-e', '-f', '--regexp', '--file', '-o', '--output', '-n', '-c', '-m', '--max-count', '-A', '-B', '-C', '--context', '-t', '--type', '-g', '--glob', '--exclude', '--include', '-d', '--delimiter', '-k', '--key', '-s', '-i', '-F', '-o', '-p', '-l', '-P', '-J', '-S', '-D', '--from-file', '--arg', '--argjson', '--slurpfile', '--rawfile', '-I', '-L', '--max-args', '-E', '--expression']);

/** Positional path-like arguments (flags and their values skipped conservatively). */
function positionalArgs(seg: Segment): Token[] {
  const out: Token[] = [];
  const toks = seg.argTokens;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].text;
    if (t === '--') {
      out.push(...toks.slice(i + 1));
      break;
    }
    if (t.startsWith('-') && t.length > 1) {
      if (VALUE_FLAGS_GENERIC.has(t) && (seg.prog === 'ssh' || seg.prog === 'scp' || seg.prog === 'rsync' || seg.prog === 'grep' || seg.prog === 'rg' || seg.prog === 'sed' || seg.prog === 'awk' || seg.prog === 'jq' || seg.prog === 'xargs' || seg.prog === 'curl' || seg.prog === 'wget')) {
        // value: still a candidate when it is a path (e.g. awk -f prog.awk) but not for -e/-i keys
        if (!['-e', '--regexp', '--expression', '-i', '-I', '-t', '-g', '-k', '-c', '-n', '-m', '-A', '-B', '-C', '-d', '-s', '-p', '-P', '-J', '-L', '-E', '--arg', '--argjson', '-o', '-F', '-D', '-S'].includes(t)) out.push(toks[i + 1]);
        i++;
      }
      continue;
    }
    out.push(toks[i]);
  }
  return out.filter(Boolean);
}

/** Tools that take a key or env file as a normal argument without exposing or overwriting it. */
const KEY_TOOLS = new Set(['ssh-keygen', 'openssl', 'gpg', 'gpg2', 'age', 'sops', 'certutil', 'keytool', 'chmod', 'chown', 'chgrp', 'chattr', 'attrib', 'icacls', 'setfacl', 'takeown', 'ssh-add', 'ssh-agent', 'ssh-copy-id', 'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'terraform', 'ansible', 'ansible-playbook', 'vault', 'aws', 'az', 'gcloud']);
/** curl / wget / PowerShell options whose value is sent to a server. */
const UPLOAD_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '-F', '--form', '--form-string', '-T', '--upload-file', '--json', '--post-file', '--post-data', '--body-file', '--body-data', '-infile', '-body']);
const UPLOAD_WHOLE_FILE_OPTS = new Set(['-T', '--upload-file', '--post-file', '--body-file', '-infile']);
const CODE_READ_RE = /\b(readFile(Sync)?|createReadStream|open\s*\(|read_text|read_bytes|ReadAllText|ReadAllLines|ReadAllBytes|ReadLines|OpenText|OpenRead|Get-Content|Import-Csv|Select-String|FileStream|StreamReader|File\.read|IO\.read|file_get_contents|load_dotenv|dotenv_values|Import-Clixml|\bgc\s|\bcat\s)/i;
const PS_CODE_HINT_RE = /\[(System\.)?IO\.|Get-Content|Import-Csv|Select-String|Set-Content|Out-File|Add-Content|Import-Clixml|\bgc\s|\bsc\s/i;

/** A string literal from code, with perl/php open() mode prefixes (">", "+<") removed. */
function stripMode(lit: string): string {
  return lit.replace(/^\s*[<>+|]+\s*/, '').trim();
}

function secretsCheck(seg: Segment, parsed: ParsedCommand, ctx: Ctx, cwd: string): GuardDecision | null {
  const prog = seg.prog;
  // git is covered in gitCheck (show/diff/grep print, add/commit stage, rm --cached and status only name the file).
  if (prog === 'git') return null;
  const secretOf = (t: string): string | null => {
    const stripped = t.replace(/^(file=|data=|@|=)+/, '');
    const m = CURL_FILE_ARG_RE.exec(t);
    const cand = m ? m[1] : stripped;
    const r = resolvePath(cand, ctx, cwd);
    const p = r.abs ?? r.text;
    return isSecretPath(p) || isSecretPath(cand) ? p : null;
  };
  // 1. Writes: redirects, tee, cp/mv destinations, sed -i, rm, editors. Key tools and
  //    permission changes (chmod 600 id_rsa, ssh-keygen -f) handle key files by design.
  for (const r of seg.redirects) {
    if (!/^(>|>>|&>|&>>|>\||\*>|\*>>)$/.test(r.op) || !r.target) continue;
    const p = resolvePath(r.target, ctx, cwd);
    const s = p.abs ?? p.text;
    if (isSecretPath(s)) return deny('secrets', `Redirecting output into ${s} would overwrite a secret or env file; the agent never writes those, so tell the user which value is needed.`, s);
  }
  if (!KEY_TOOLS.has(prog)) {
    const writeDest = writeDestinations(seg, ctx, cwd);
    for (const d of writeDest.paths) {
      const s = d.resolved.abs ?? d.resolved.text;
      if (isSecretPath(s) || isSecretPath(d.raw)) return deny('secrets', `${prog} would write or remove ${s}, which is a secret or env file; the agent never changes those, so leave it alone and tell the user what is needed.`, s);
    }
  }
  // 2. One-liners (node -e, python -c, perl -e, PowerShell inline .NET calls): reads and writes by literal path.
  const codeText = seg.innerCode ?? (seg.dialect === 'powershell' && PS_CODE_HINT_RE.test(seg.raw) ? seg.raw : null);
  if (codeText) {
    const lits = codeLiterals(codeText).map(stripMode);
    if (CODE_READ_RE.test(codeText) && !/dotenv/i.test(codeText)) {
      const hit = lits.find((l) => isSecretPath(l));
      if (hit) return deny('secrets', `The one-liner reads ${hit}, which looks like a secret or env file; secrets are never read into the transcript, so use .env.example or ask the user for the value you need.`, hit);
    }
    if (CODE_WRITE_RE.test(codeText)) {
      const hit = lits.find((l) => isSecretPath(l));
      if (hit) return deny('secrets', `The one-liner writes ${hit}, which is a secret or env file; the agent never changes those, so leave it alone and tell the user what is needed.`, hit);
    }
  }
  // 3. find -name '.env*' -exec cat {} ; / -exec cp {} /tmp ;
  if (prog === 'find') {
    const nameIdx = seg.args.findIndex((a) => a === '-name' || a === '-iname' || a === '-path' || a === '-ipath' || a === '-regex' || a === '-iregex' || a === '-wholename');
    const namePat = nameIdx >= 0 ? seg.args[nameIdx + 1] ?? '' : '';
    const innerProg = seg.inner?.segments[0]?.prog ?? '';
    const looksSecret = !!namePat && ['', 'x', '.local', 'id_rsa'].some((fill) => isSecretPath(namePat.replace(/\*/g, fill).replace(/\?/g, 'x')));
    if (looksSecret && innerProg && (READER_PROGS.has(innerProg) || COPY_PROGS.has(innerProg))) {
      return deny('secrets', `find would run ${innerProg} on files matching ${namePat}, which are secret files; secrets are never read into the transcript.`, namePat);
    }
    return null;
  }
  // 4. Uploads: curl -d @.env, -F f=@id_rsa, -T key, wget --post-file=.env, Invoke-WebRequest -InFile.
  if (HTTP_PROGS.has(prog)) {
    const args = seg.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      const name = eq > 0 ? a.slice(0, eq) : a;
      const lower = name.toLowerCase();
      let value: string | null = null;
      let whole = false;
      if (UPLOAD_OPTS.has(name) || UPLOAD_OPTS.has(lower)) {
        value = eq > 0 ? a.slice(eq + 1) : args[i + 1] ?? '';
        whole = UPLOAD_WHOLE_FILE_OPTS.has(name) || UPLOAD_WHOLE_FILE_OPTS.has(lower);
      } else if (/^-[a-zA-Z]*[dFT]$/.test(a) && !a.startsWith('--')) {
        // short cluster ending in an upload flag: -sd @file, -sT file
        value = args[i + 1] ?? '';
        whole = a.endsWith('T');
      } else if (/^-(d|F|T)./.test(a) && !a.startsWith('--')) {
        value = a.slice(2);
        whole = a.startsWith('-T');
      }
      if (value === null) continue;
      const file = whole ? value : (CURL_FILE_ARG_RE.exec(value)?.[1] ?? null);
      if (!file) continue;
      const hit = secretOf(file);
      if (hit) return deny('secrets', `${prog} would send ${hit}, which is a secret or env file, to a server; secrets stay where they are, so leave it out.`, hit);
    }
    return null;
  }
  // 5. Readers and copiers by positional path.
  if (SECRET_SAFE_PROGS.has(prog) && !COPY_PROGS.has(prog)) return null;
  const isReader = READER_PROGS.has(prog) || COPY_PROGS.has(prog);
  if (!isReader) return null;
  if (seg.parentProg !== undefined && SECRET_LOAD_PARENTS.has(seg.parentProg) && READER_PROGS.has(prog) && !COPY_PROGS.has(prog)) {
    // export $(cat .env | xargs): loading into the environment, not printing
    return null;
  }
  // ssh -i key host is normal; scp/rsync sources are checked by position below
  if (prog === 'ssh') return null;
  const candidates: Token[] = [...positionalArgs(seg)];
  if (seg.argsFromStdin || seg.args.includes('{}')) {
    for (const peer of pipelinePeers(seg, parsed)) candidates.push(...positionalArgs(peer));
    if (seg.inner) for (const x of seg.inner.segments) candidates.push(...positionalArgs(x));
    for (const sub of seg.subshells) for (const x of sub.segments) candidates.push(...positionalArgs(x));
  }
  for (const t of candidates) {
    const hit = secretOf(t.text);
    if (hit) {
      if (COPY_PROGS.has(prog)) return deny('secrets', `${prog} would copy or send ${hit}, which is a secret or env file; secrets stay where they are, so leave it out.`, hit);
      return deny('secrets', `${prog} would read ${hit}, which looks like key material or an env secret; secrets are never read into the transcript, so use .env.example or ask the user for the value you need.`, hit);
    }
  }
  // A reader whose argument is a command substitution that names a secret file: cat $(find . -name .env), cat `ls .env`
  for (const sub of seg.subshells) {
    for (const x of sub.segments) {
      const named = x.args.find((a) => isSecretPath(a) || isSecretPath(a.replace(/\*/g, '')));
      if (named) return deny('secrets', `${prog} would read the files that $(${x.raw.slice(0, 40)}) lists, which include ${named} (a secret or env file); secrets are never read into the transcript.`, named);
    }
  }
  return null;
}

function codeLiterals(code: string): string[] {
  const out: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) if (m[2].length < 512) out.push(m[2]);
  return out;
}

// ---------------------------------------------------------------------------
// Writes: protected roots, harness-shaped paths, test files
// ---------------------------------------------------------------------------

interface WriteDest {
  raw: string;
  resolved: Resolved;
  /** Path is removed, moved or re-permissioned: ancestors matter. */
  destructive: boolean;
}

/** Writable bind-mount sources of a docker/podman run: the container can change them. */
function mountSources(seg: Segment): string[] {
  const out: string[] = [];
  for (const m of seg.dockerMounts ?? []) {
    // -v src:dst[:ro] ; --mount type=bind,source=src,target=dst[,readonly]
    let src = '';
    let ro = false;
    if (m.includes('=')) {
      const kv = Object.fromEntries(m.split(',').map((p) => [p.split('=')[0].trim().toLowerCase(), p.split('=').slice(1).join('=')]));
      src = kv.source ?? kv.src ?? '';
      ro = 'readonly' in kv || 'ro' in kv || kv.readonly === 'true';
    } else {
      const parts = m.split(':');
      if (parts.length >= 2) {
        src = /^[A-Za-z]$/.test(parts[0]) && parts.length >= 3 ? parts[0] + ':' + parts[1] : parts[0];
        ro = /(^|,)ro(,|$)/.test(parts[parts.length - 1]);
      }
    }
    if (src && !ro && (src.includes('/') || src.includes('\\') || src.startsWith('~') || src.startsWith('$') || src.startsWith('%'))) out.push(src);
  }
  return out;
}

function dest(raw: string, ctx: Ctx, cwd: string, destructive: boolean): WriteDest {
  return { raw, resolved: resolvePath(raw, ctx, cwd), destructive };
}

const PS_PATH_PARAMS = /^-(path|literalpath|filepath|destination|name|newname|target|outfile|destinationpath|include)(:(.*))?$/i;
const PS_PATH_PARAM_NAMES = ['path', 'literalpath', 'filepath', 'destination', 'name', 'newname', 'target', 'outfile', 'destinationpath', 'include', 'pspath'];
const PS_SWITCH_PARAM_NAMES = ['force', 'recurse', 'confirm', 'whatif', 'verbose', 'debug', 'passthru', 'append', 'noclobber', 'nonewline', 'notypeinformation', 'usequotes', 'asbytestream', 'raw', 'wait', 'container', 'usetransaction', 'includeequal', 'excludedifferent', 'casesensitive', 'simplematch', 'quiet', 'list', 'notmatch', 'allmatches', 'usebasicparsing', 'skipcertificatecheck', 'skiphttperrorcheck', 'disablekeepalive', 'nocache', 'followsymlink', 'file', 'directory', 'hidden', 'readonly', 'system', 'name', 'noenumerate', 'allowunencryptedauthentication', 'preservehttpmethodonredirect', 'update'];
const PS_VALUE_PARAM_NAMES = ['exclude', 'filter', 'value', 'encoding', 'credential', 'erroraction', 'errorvariable', 'warningaction', 'warningvariable', 'informationaction', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'progressaction', 'itemtype', 'stream', 'delimiter', 'width', 'depth', 'inputobject', 'uri', 'method', 'headers', 'body', 'contenttype', 'useragent', 'sessionvariable', 'websession', 'timeoutsec', 'maximumredirection', 'proxy', 'proxycredential', 'certificate', 'certificatethumbprint', 'transferencoding', 'compressionlevel', 'format', 'type', 'propertytype', 'attributes', 'totalcount', 'first', 'last', 'skip', 'tail', 'head', 'readcount', 'token', 'authentication', 'retryintervalsec', 'maximumretrycount', 'resumefrom', 'customheaders', 'confirmpreference', 'whatifpreference', 'literal', 'newline', 'useragent'];

/**
 * How a PowerShell parameter name is read: a path parameter (its value is a destination),
 * a known value parameter (its value is skipped), or a switch. PowerShell accepts
 * unambiguous prefixes; anything ambiguous or unknown is read as a switch so the token
 * after it is still checked as a path (fail closed).
 */
function psParamKind(token: string): 'path' | 'value' | 'switch' {
  const name = token.replace(/^-+/, '').replace(/:.*$/, '').toLowerCase();
  if (!name) return 'switch';
  if (PS_PATH_PARAM_NAMES.includes(name)) return 'path';
  if (PS_VALUE_PARAM_NAMES.includes(name)) return 'value';
  if (PS_SWITCH_PARAM_NAMES.includes(name)) return 'switch';
  const paths = PS_PATH_PARAM_NAMES.filter((n) => n.startsWith(name));
  const values = PS_VALUE_PARAM_NAMES.filter((n) => n.startsWith(name));
  const switches = PS_SWITCH_PARAM_NAMES.filter((n) => n.startsWith(name));
  if (paths.length >= 1) return 'path';
  if (values.length === 1 && switches.length === 0) return 'value';
  return 'switch';
}

/** Paths a segment writes to, by program. */
function writeDestinations(seg: Segment, ctx: Ctx, cwd: string): { paths: WriteDest[]; cwdWrite: boolean } {
  const prog = seg.prog;
  const out: WriteDest[] = [];
  let cwdWrite = false;
  const destructive = DESTRUCTIVE_PROGS.has(prog);
  const args = seg.args;
  const toks = seg.argTokens;
  const push = (raw: string, d = destructive) => {
    if (raw && raw !== '-' && raw !== '/dev/null' && raw !== 'nul') out.push(dest(raw, ctx, cwd, d));
  };
  // redirects
  for (const r of seg.redirects) {
    if (/^(>|>>|&>|&>>|>\||<>|\*>|\*>>)$/.test(r.op) && r.target) push(r.target, false);
    if (r.op === '>&' && r.target && !/^\d+$/.test(r.target) && r.target !== '-') push(r.target, false);
  }
  const positionals = (): string[] => {
    const res: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        res.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('-') && a.length > 1 && !(prog === 'cd' || prog === 'ln')) continue;
      if (a.startsWith('-') && a.length > 1) continue;
      res.push(a);
    }
    return res;
  };
  const valueOpts = WRITE_VALUE_OPTS[prog] ?? [];
  const valueOf = (opt: string): string[] => {
    const vals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === opt) vals.push(args[i + 1] ?? '');
      else if (a.startsWith(opt + '=')) vals.push(a.slice(opt.length + 1));
      else if (opt.endsWith('=') && a.startsWith(opt)) vals.push(a.slice(opt.length));
      else if (/^-[A-Za-z]$/.test(opt) && a.startsWith(opt) && a.length > 2 && !a.startsWith('--') && prog !== 'sed') vals.push(a.slice(2));
      else if (opt.startsWith('-') && !opt.startsWith('--') && opt.length > 2 && a.toLowerCase() === opt.toLowerCase()) vals.push(args[i + 1] ?? '');
      else if (opt.startsWith('-') && !opt.startsWith('--') && opt.length > 2 && a.toLowerCase().startsWith(opt.toLowerCase() + ':')) vals.push(a.slice(opt.length + 1));
    }
    return vals.filter(Boolean);
  };
  switch (prog) {
    case 'tee': {
      for (const p of positionals()) push(p, false);
      break;
    }
    case 'sed': {
      const inPlace = args.some((a) => a === '-i' || a === '--in-place' || a.startsWith('--in-place=') || (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--')) );
      if (inPlace) {
        // files are positionals after the script (unless -e/-f given)
        const hasExpr = args.some((a) => a === '-e' || a === '--expression' || a.startsWith('--expression=') || a === '-f' || a === '--file' || /^-[a-zA-Z]*e$/.test(a));
        const files: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-e' || a === '--expression' || a === '-f' || a === '--file') {
            i++;
            continue;
          }
          if (a.startsWith('-') && a.length > 1) continue;
          files.push(a);
        }
        for (const f of hasExpr ? files : files.slice(1)) push(f, false);
      }
      break;
    }
    case 'perl':
    case 'ruby': {
      const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) && !a.startsWith('--'));
      if (inPlace) {
        const files: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === '-e' || a === '-E') {
            i++;
            continue;
          }
          if (a.startsWith('-') && a.length > 1) continue;
          files.push(a);
        }
        for (const f of files) push(f, false);
      }
      break;
    }
    case 'cp':
    case 'copy':
    case 'install':
    case 'scp':
    case 'rsync':
    case 'xcopy':
    case 'robocopy': {
      const pos = positionals();
      const t = valueOf('-t').concat(valueOf('--target-directory'));
      if (t.length) for (const x of t) push(x, false);
      else if (prog === 'robocopy') {
        if (pos[1]) push(pos[1], true);
      } else if (pos.length >= 2) push(pos[pos.length - 1], false);
      else if (pos.length === 1 && prog === 'install') push(pos[0], false);
      if (prog === 'rsync' && args.some((a) => a.startsWith('--delete'))) for (const p of pos.slice(0, -1)) push(p, true);
      // `cp -l` / `cp --link` creates a hard link: the new file aliases the
      // source inode, so a later edit of the (unprotected) copy would mutate a
      // protected source in place. Treat the sources as write targets too, as
      // `ln` is. (`--reflink` is copy-on-write and does not alias, so it is
      // left as an ordinary copy.)
      if ((prog === 'cp' || prog === 'copy') && args.some((a) => a === '-l' || a === '--link' || (/^-[a-zA-Z]*l[a-zA-Z]*$/.test(a) && !a.startsWith('--')))) {
        for (const p of pos.slice(0, -1)) push(p, true);
      }
      break;
    }
    case 'mv':
    case 'move':
    case 'rename':
    case 'ren': {
      const t = valueOf('-t').concat(valueOf('--target-directory'));
      for (const x of t) push(x, false);
      for (const p of positionals()) push(p, true);
      break;
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'setfacl':
    case 'attrib':
    case 'chattr': {
      const pos = positionals();
      // first positional is the mode/owner/attribute; for attrib/chattr the modifiers start with + or -
      const files = prog === 'attrib' || prog === 'chattr' ? pos.filter((p) => !/^[+-]/.test(p)) : pos.slice(1);
      for (const f of files) push(f, true);
      break;
    }
    case 'ln':
    case 'link':
    case 'mklink': {
      for (const p of positionals()) push(p, false);
      for (const x of valueOf('-t').concat(valueOf('--target-directory'))) push(x, false);
      break;
    }
    case 'dd': {
      for (const x of valueOf('of=')) push(x, false);
      break;
    }
    case 'curl': {
      for (const opt of valueOpts) for (const v of valueOf(opt)) push(v, false);
      if (args.some((a) => a === '-O' || a === '--remote-name' || a === '--remote-name-all' || /^-[a-zA-Z]*O/.test(a))) cwdWrite = true;
      break;
    }
    case 'wget': {
      for (const opt of valueOpts) for (const v of valueOf(opt)) push(v, false);
      if (!args.some((a) => a === '-O' || a.startsWith('--output-document') || a === '-P' || a.startsWith('--directory-prefix')) && !args.some((a) => a === '--spider')) cwdWrite = true;
      break;
    }
    case 'tar': {
      const first = args[0] ?? '';
      const extract = args.some((a) => a === '-x' || a === '--extract' || a === '--get' || /^-[a-zA-Z]*x/.test(a)) || (/^[a-zA-Z]+$/.test(first) && first.includes('x'));
      const create = args.some((a) => a === '-c' || a === '--create' || /^-[a-zA-Z]*c/.test(a)) || (/^[a-zA-Z]+$/.test(first) && first.includes('c'));
      const dirs = valueOf('-C').concat(valueOf('--directory'));
      if (extract) {
        if (dirs.length) for (const d of dirs) push(d, false);
        else cwdWrite = true;
      }
      if (create) {
        const files = valueOf('-f').concat(valueOf('--file'));
        if (files.length) for (const f of files) push(f, false);
        else if (/^[a-zA-Z]+$/.test(first) && first.includes('f')) push(args[1] ?? '', false);
      }
      break;
    }
    case 'unzip': {
      const d = valueOf('-d');
      if (d.length) for (const x of d) push(x, false);
      else cwdWrite = true;
      break;
    }
    case '7z':
    case '7za': {
      const o = args.filter((a) => a.startsWith('-o')).map((a) => a.slice(2));
      if (o.length) for (const x of o) push(x, false);
      else if (args[0] === 'x' || args[0] === 'e') cwdWrite = true;
      break;
    }
    case 'zip': {
      const pos = positionals();
      if (pos[0]) push(pos[0], false);
      break;
    }
    case 'patch': {
      const d = valueOf('-d').concat(valueOf('--directory'));
      if (d.length) for (const x of d) push(x, false);
      else cwdWrite = true;
      for (const x of valueOf('-o').concat(valueOf('--output'))) push(x, false);
      for (const p of positionals()) push(p, false);
      break;
    }
    case 'git': {
      const g = splitGit(seg);
      if (g.sub === 'apply' || g.sub === 'am') {
        const d = valueOf('--directory');
        if (d.length) for (const x of d) push(x, false);
        else cwdWrite = true;
      }
      break;
    }
    case 'docker':
    case 'podman':
    case 'nerdctl': {
      if (args[0] === 'cp' || args[1] === 'cp') {
        const pos = positionals().filter((p) => p !== 'cp');
        const last = pos[pos.length - 1];
        if (last && !/^[^/\\:]+:/.test(last)) push(last, false);
      }
      break;
    }
    case 'find': {
      const hasDelete = args.includes('-delete');
      const innerProg = seg.inner?.segments[0]?.prog ?? '';
      const innerWrites = innerProg && (DESTRUCTIVE_PROGS.has(innerProg) || ['tee', 'sed', 'touch', 'truncate', 'ln', 'perl'].includes(innerProg));
      for (const opt of ['-fprint', '-fprint0', '-fprintf', '-fls']) for (const v of valueOf(opt)) push(v, false);
      if (hasDelete || innerWrites) {
        const starts: string[] = [];
        for (const a of args) {
          if (a.startsWith('-') || a === '(' || a === '!' || a === '\\(') break;
          starts.push(a);
        }
        if (!starts.length) starts.push('.');
        for (const s of starts) push(s, true);
      }
      break;
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'pip':
    case 'pip3':
    case 'code':
    case 'cargo':
    case 'go':
    case 'dotnet':
    case 'make':
    case 'cmake':
    case 'rustup':
    case 'openssl':
    case 'ssh-keygen':
    case 'gpg':
    case 'certutil':
    case 'sqlcmd':
    case 'psql':
    case 'mysql': {
      for (const opt of valueOpts) for (const v of valueOf(opt)) push(v, false);
      break;
    }
    case 'node':
    case 'python':
    case 'python3':
    case 'php':
    case 'lua':
    case 'rscript': {
      for (const opt of valueOpts) for (const v of valueOf(opt)) push(v, false);
      break;
    }
    case 'crontab': {
      // crontab - / crontab file installs a crontab (not a protected path); nothing to resolve
      break;
    }
    default: {
      // PowerShell cmdlets and plain destructive/creating programs: all positionals plus -Path style params
      if (/^(set-content|sc|add-content|ac|clear-content|clc|out-file|new-item|ni|remove-item|ri|copy-item|ci|cpi|move-item|mi|rename-item|rni|set-itemproperty|sp|remove-itemproperty|rp|new-itemproperty|clear-item|cli|export-csv|export-clixml|expand-archive|compress-archive|invoke-webrequest|iwr|invoke-restmethod|irm|rmdir|rd|del|erase|md|mkdir|rm|unlink|shred|truncate|touch|ed|ex|vi|vim|nvim|nano|emacs|pico|xattr|icacls|takeown|split|csplit|gzip|gunzip|bzip2|xz|zstd|expand-archive)$/.test(prog)) {
        const isPs = /-/.test(prog) || ['sc', 'ac', 'clc', 'ni', 'ri', 'ci', 'cpi', 'mi', 'rni', 'sp', 'rp', 'cli', 'iwr', 'irm'].includes(prog);
        if (isPs) {
          for (let i = 0; i < toks.length; i++) {
            const a = toks[i].text;
            if (a.startsWith('-') && a.length > 1) {
              const kind = psParamKind(a);
              const colon = a.indexOf(':');
              if (kind === 'path') {
                if (colon > 0) push(a.slice(colon + 1), destructive);
                else if (toks[i + 1]) {
                  push(toks[i + 1].text, destructive);
                  i++;
                }
                continue;
              }
              if (kind === 'value' && colon < 0 && toks[i + 1] && !toks[i + 1].text.startsWith('-')) i++;
              continue;
            }
            push(a, destructive);
          }
          // Out-File / Set-Content with piped input and a bare positional path
        } else {
          for (const p of positionals()) push(p, destructive);
          if (prog === 'rm' || prog === 'rmdir' || prog === 'shred') {
            /* all positionals already pushed */
          }
        }
      }
    }
  }
  return { paths: out, cwdWrite };
}

/** A string literal that could be a file path: has a separator, a tilde, a dotted name or a leading dot. */
const PATHISH_RE = /[\/\\]|^~|^\.{0,2}[A-Za-z0-9_-]+\.[A-Za-z0-9]+$|^\.[A-Za-z]/;
/** Code that builds a path from the home folder, the environment or a config-dir lookup. */
const RUNTIME_PATH_RE = /process\.env|os\.environ|homedir\(\)|expanduser|path\.join|os\.path\.join|\$\{|Path\.home\(\)|joinpath|USERPROFILE|HOMEPATH|APPDATA|XDG_CONFIG_HOME|GetFolderPath|\$env:|\$HOME|\$PROFILE|ENV\[|getenv/i;

function isRecursiveDelete(seg: Segment): boolean {
  const p = seg.prog;
  if (p === 'rm' || p === 'shred') return seg.args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive');
  if (p === 'rd' || p === 'rmdir') return seg.args.some((a) => /^\/s$/i.test(a) || a === '-r' || a === '--recursive' || /^-[a-z]*r/i.test(a));
  if (p === 'remove-item' || p === 'ri') return seg.args.some((a) => /^-rec/i.test(a) || /^-r$/i.test(a));
  if (p === 'rsync') return seg.args.some((a) => a.startsWith('--delete'));
  return false;
}

function writeChecks(seg: Segment, parsed: ParsedCommand, ctx: Ctx, cwd: string): GuardDecision | null {
  const prog = seg.prog;
  const { paths, cwdWrite } = writeDestinations(seg, ctx, cwd);
  const candidates: WriteDest[] = [...paths];
  if (cwdWrite) candidates.push({ raw: cwd, resolved: { abs: cwd, text: cwd, dynamic: false, glob: false }, destructive: false });
  // xargs rm / {} : paths come from the pipeline producer
  if ((seg.argsFromStdin || seg.args.includes('{}')) && (DESTRUCTIVE_PROGS.has(prog) || ['tee', 'sed', 'touch', 'truncate', 'ln', 'cp', 'install'].includes(prog))) {
    for (const peer of pipelinePeers(seg, parsed)) for (const t of positionalArgs(peer)) candidates.push(dest(t.text, ctx, cwd, true));
  }
  // A writable bind mount of a protected root lets the container change it.
  for (const src of mountSources(seg)) candidates.push(dest(src, ctx, cwd, true));
  // One-liners (node -e, python -c, perl -e) and inline PowerShell .NET calls that write files:
  // every path-like string literal is a candidate; a path built at run time that names
  // agent configuration is denied outright.
  const codeTexts: string[] = [];
  if (seg.innerCode && CODE_WRITE_RE.test(seg.innerCode)) codeTexts.push(seg.innerCode);
  if (seg.dialect === 'powershell' && CODE_WRITE_RE.test(seg.raw) && /\[(System\.)?IO\./.test(seg.raw)) codeTexts.push(seg.raw);
  for (const code of codeTexts) {
    for (const lit of codeLiterals(code).map(stripMode)) if (PATHISH_RE.test(lit)) candidates.push(dest(lit, ctx, cwd, true));
    if (RUNTIME_PATH_RE.test(code) && PROTECTED_SHAPE_RE.test(code)) {
      return deny('protect', 'The one-liner writes to a path built at run time that names agent configuration or harness state; those files are managed by the harness, so leave them unchanged.', 'one-liner');
    }
  }
  for (const c of candidates) {
    const hit = protectedHit(c.resolved, ctx, c.destructive);
    if (hit) {
      const what = hit.rel === 'ancestor' ? `${hit.path} (which contains ${hit.root})` : hit.path;
      return deny('protect', `${prog} would write to ${what}, which is harness-protected (harness state, agent configuration or the harness package are managed by the harness itself); leave it unchanged and continue with the task.`, hit.path);
    }
    // A recursive delete of a path the guard cannot resolve could reach anything.
    if (c.destructive && c.resolved.dynamic && !c.resolved.abs && isRecursiveDelete(seg)) {
      return deny('protect', `${prog} would recursively delete ${c.raw}, a path built from a variable the guard cannot resolve; write the path literally.`, c.raw);
    }
  }
  // env assignments that redirect config homes (CLAUDE_CONFIG_DIR=/tmp/x claude ...) are a nested-agent concern; here: GIT_DIR etc. handled in gitCheck.
  if (ctx.setting === 'team') {
    for (const c of candidates) {
      const p = c.resolved.abs ?? c.resolved.text;
      const kind = shapedKind(p, ctx);
      if (kind === 'file' || kind === 'dir') return deny('team-shaped', `${prog} would write ${p}, which looks like agent-harness configuration; nothing of the harness is written inside a team repository, so skip it.`, p);
      if (kind === 'workflow' && !safeTracked(ctx, p)) return deny('team-shaped', `${prog} would add a new CI workflow (${p}) to a team repository, which the harness never does; leave CI changes to the user.`, p);
    }
  }
  if (ctx.phase === 'implement') {
    for (const c of candidates) {
      const p = c.resolved.abs ?? c.resolved.text;
      if (c.raw === cwd && !c.resolved.glob) continue;
      if (isTestPath(p, ctx) || (c.resolved.glob && isTestPath(p + '/x', ctx))) {
        return deny('phase-tests', `Test and golden files are read-only during the implement phase (${p}); run \`harness phase tests\` to enter the tests phase, then change it.`, p);
      }
    }
  }
  // READ_ONLY_PROGS with no redirect never write; nothing else to do.
  void READ_ONLY_PROGS;
  void normalizeProg;
  return null;
}
