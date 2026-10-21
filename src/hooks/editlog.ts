/**
 * The per-session edit log (written by the PostToolUse hook, read by the
 * Stop hook and the pause trail).
 *
 * Which tool calls count as edits:
 *  - file tools of all three agents: Claude/Codex `Edit`, `Write`,
 *    `MultiEdit`, `NotebookEdit`; Devin `edit`, `write`; any tool the guard
 *    classifies as a write tool. Path fields read: `file_path`, `path`,
 *    `filePath`, `notebook_path` and a few other spellings, plus
 *    `tool_response.filePath`;
 *  - `apply_patch` bodies (Codex), wherever they appear: a tool input field
 *    or a shell heredoc. Paths come from the `*** Add/Update/Delete File:`
 *    and `*** Move to:` headers;
 *  - shell commands that visibly write into a repo: output redirects, `tee`,
 *    `sed -i`/`perl -i`, `cp`/`mv`/`rm`/`touch`/`truncate`/`install`, git
 *    sub-commands that rewrite the work tree (checkout, restore, apply,
 *    stash, merge, pull, reset, revert, cherry-pick, am, rm, mv, switch),
 *    `--write`/`--fix` formatter runs and package installs (recorded as the
 *    working folder).
 * Edits outside any git repository or inside the harness state are not
 * logged: the gate only runs on repositories.
 *
 * The log holds paths, repo ids and times; never file content or command text.
 */
import * as path from 'node:path';
import type { HookInput } from '../types';
import type { HookContext } from '../hook';
import { patchPaths } from '../guard';
import { allSegments, parseCommand, type Segment } from '../guard/parse';
import { COMMAND_TOOL_RE, WRITE_TOOL_RE } from '../guard/rails';
import { updateSession } from '../lib/session';
import { hasHiddenUnicode } from '../lib/unicode';
import { hookCwd, inHarnessHome, repoOf, type RepoHit } from './common';

const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path', 'target_file', 'TargetFile', 'filename', 'file', 'AbsolutePath', 'absolute_path', 'relative_path', 'relativePath'];
const MOVE_KEYS = ['source', 'destination', 'new_path', 'old_path', 'src', 'dest', 'target', 'targetPath'];
const PATCH_RE = /\*\*\* Begin Patch/;

export interface EditHit extends RepoHit {
  /** Absolute path of the edited file (or the working folder for opaque shell writes). */
  path: string;
  /** How the edit was seen. */
  via: 'file-tool' | 'patch' | 'shell';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function resolveFrom(cwd: string, p: string): string {
  let s = p;
  if (s.startsWith('~/') || s === '~') s = path.join(process.env.HARNESS_USER_HOME || process.env.HOME || process.env.USERPROFILE || '', s.slice(1));
  return path.resolve(cwd, s);
}

/** Every string field of a tool input that carries an apply_patch body. */
function patchBodies(ti: unknown, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 3 || ti === null || ti === undefined) return out;
  if (typeof ti === 'string') {
    if (PATCH_RE.test(ti)) out.push(ti);
    return out;
  }
  if (Array.isArray(ti)) {
    for (const x of ti) out.push(...patchBodies(x, depth + 1));
    return out;
  }
  if (typeof ti === 'object') for (const v of Object.values(ti as Record<string, unknown>)) out.push(...patchBodies(v, depth + 1));
  return out;
}

/** Paths in an apply_patch body (the `*** ... File:` and `*** Move to:` headers only). */
export function applyPatchPaths(body: string): string[] {
  return patchPaths(body).filter((p) => p && !/^[ab]\//.test(p) && p !== '/dev/null');
}

const GIT_TREE_SUBS = new Set(['checkout', 'restore', 'apply', 'stash', 'merge', 'pull', 'reset', 'revert', 'cherry-pick', 'am', 'rm', 'mv', 'switch', 'rebase', 'clean']);
const PKG_PROGS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PKG_WRITE_SUBS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'ci', 'dedupe', 'link']);

const FORMATTERS = new Set(['prettier', 'eslint', 'biome', 'stylelint', 'dprint']);
const FORMATTER_SUBS = new Set(['format', 'lint', 'check', 'fmt']);
const WRITE_FLAGS = new Set(['--write', '-w', '--fix', '--apply', '--apply-unsafe']);

/** Files of `sed -i` / `perl -pi`: positionals after the script (the first positional unless -e/-f gave it). */
function inPlaceFiles(args: string[]): string[] {
  const files: string[] = [];
  let scriptGiven = false;
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!rest && a === '--') {
      rest = true;
      continue;
    }
    if (!rest && (a === '-e' || a === '-f' || a === '--expression' || a === '--file' || /^-[a-zA-Z]*[ef]$/.test(a))) {
      scriptGiven = true;
      i++;
      continue;
    }
    if (!rest && (a.startsWith('--expression=') || a.startsWith('--file='))) {
      scriptGiven = true;
      continue;
    }
    if (!rest && a.startsWith('-')) continue;
    if (!scriptGiven) {
      scriptGiven = true;
      continue;
    }
    files.push(a);
  }
  return files;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  let rest = false;
  for (const a of args) {
    if (rest) out.push(a);
    else if (a === '--') rest = true;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

/** Paths (relative to `cwd`) a shell segment writes, or ['.'] when it rewrites the folder opaquely. */
export function segmentWrites(seg: Segment): string[] {
  const out: string[] = [];
  for (const r of seg.redirects) {
    if (/^(>|>>|&>|&>>|>\||\*>|\*>>)$/.test(r.op) && r.target && !r.dynamic && !/^(\/dev\/(null|stdout|stderr)|nul|NUL|-)$/.test(r.target) && !/^&?\d+$/.test(r.target)) out.push(r.target);
  }
  const prog = seg.prog;
  const args = seg.args;
  const pos = positionals(args);
  switch (prog) {
    case 'tee':
      out.push(...pos);
      break;
    case 'sed':
    case 'perl':
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) out.push(...inPlaceFiles(args));
      break;
    case 'cp':
    case 'install':
    case 'rsync':
    case 'ln':
      if (pos.length >= 2) out.push(pos[pos.length - 1]);
      break;
    case 'mv':
      out.push(...pos);
      break;
    case 'rm':
    case 'unlink':
    case 'touch':
    case 'truncate':
    case 'shred':
      out.push(...pos);
      break;
    case 'apply_patch':
    case 'patch':
      out.push('.');
      break;
    case 'git': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
      if (GIT_TREE_SUBS.has(args[i] ?? '')) out.push('.');
      break;
    }
    default:
      if (PKG_PROGS.has(prog) && PKG_WRITE_SUBS.has(pos[0] ?? '')) out.push('.');
      else if (FORMATTERS.has(prog) && args.some((a) => WRITE_FLAGS.has(a))) out.push(...(pos.filter((p) => !FORMATTER_SUBS.has(p)).length ? pos.filter((p) => !FORMATTER_SUBS.has(p)) : ['.']));
  }
  return out;
}

/** The working folder of a git segment (`git -C <dir> ...`). */
function gitDirArg(seg: Segment): string | null {
  if (seg.prog !== 'git') return null;
  const i = seg.args.indexOf('-C');
  return i >= 0 && seg.args[i + 1] ? seg.args[i + 1] : null;
}

/** Absolute paths a shell command writes (best effort; never throws). */
export function shellWrites(command: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const body of patchBodies(command)) for (const p of applyPatchPaths(body)) out.add(resolveFrom(cwd, p));
  let segs: Segment[] = [];
  try {
    segs = allSegments(parseCommand(command));
  } catch {
    return [...out];
  }
  let cur = cwd;
  for (const seg of segs) {
    if (seg.depth === 0 && (seg.prog === 'cd' || seg.prog === 'pushd') && seg.args[0] && !seg.args[0].startsWith('-')) {
      cur = resolveFrom(cur, seg.args[0]);
      continue;
    }
    const patched = seg.heredoc && PATCH_RE.test(seg.heredoc) ? applyPatchPaths(seg.heredoc) : [];
    for (const p of patched) out.add(resolveFrom(cur, p));
    const base = gitDirArg(seg) ? resolveFrom(cur, gitDirArg(seg) as string) : cur;
    for (const w of segmentWrites(seg)) {
      // A patch whose body named its files needs no whole-folder entry.
      if (w === '.' && patched.length && (seg.prog === 'apply_patch' || seg.prog === 'patch')) continue;
      out.add(w === '.' ? base : resolveFrom(base, w));
    }
  }
  return [...out];
}

/** Absolute paths a file tool (or an apply_patch tool) edited. */
export function fileToolPaths(input: HookInput, cwd: string): string[] {
  const ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const k of PATH_KEYS) {
    const v = str(ti[k]);
    if (v) out.add(resolveFrom(cwd, v));
  }
  if (/move|rename/i.test(String(input.tool_name ?? ''))) {
    for (const k of MOVE_KEYS) {
      const v = str(ti[k]);
      if (v) out.add(resolveFrom(cwd, v));
    }
  }
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e === 'object') {
        const v = str((e as Record<string, unknown>).file_path) ?? str((e as Record<string, unknown>).path);
        if (v) out.add(resolveFrom(cwd, v));
      }
    }
  }
  const tr = input.tool_response;
  if (tr && typeof tr === 'object') {
    const v = str((tr as Record<string, unknown>).filePath) ?? str((tr as Record<string, unknown>).file_path);
    if (v) out.add(resolveFrom(cwd, v));
  }
  for (const body of patchBodies(ti)) for (const p of applyPatchPaths(body)) out.add(resolveFrom(cwd, p));
  return [...out];
}

export function isShellTool(name: string): boolean {
  return COMMAND_TOOL_RE.test(name);
}

export function isFileEditTool(name: string): boolean {
  return WRITE_TOOL_RE.test(name) || /^apply_?patch$/i.test(name);
}

/**
 * The edits one PostToolUse call made, resolved to repos. Paths outside any
 * git repo, inside the harness state or under a `.git` folder are dropped.
 */
export function editsOf(input: HookInput): EditHit[] {
  const name = String(input.tool_name ?? '');
  const cwd = hookCwd(input);
  const ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
  let raw: Array<{ p: string; via: EditHit['via'] }> = [];
  if (isFileEditTool(name)) {
    raw = fileToolPaths(input, cwd).map((p) => ({ p, via: /^apply_?patch$/i.test(name) ? 'patch' : 'file-tool' }));
  } else if (isShellTool(name) || typeof ti.command === 'string') {
    const cmd = typeof ti.command === 'string' ? ti.command : typeof ti.cmd === 'string' ? ti.cmd : '';
    if (cmd) raw = shellWrites(cmd, cwd).map((p) => ({ p, via: 'shell' as const }));
  } else {
    raw = patchBodies(ti).flatMap((b) => applyPatchPaths(b)).map((p) => ({ p: resolveFrom(cwd, p), via: 'patch' as const }));
  }
  const out: EditHit[] = [];
  const seen = new Set<string>();
  for (const { p, via } of raw) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (inHarnessHome(p) || /[\\/]\.git([\\/]|$)/.test(p)) continue;
    const hit = repoOf(p);
    if (!hit) continue;
    out.push({ ...hit, path: p, via });
  }
  return out;
}

/**
 * Append edits to the session log (and count shell calls for the Stop hook's
 * tree cache). A path carrying hidden Unicode is logged as its repo root:
 * the state writer refuses hidden Unicode, and an edit must never drop out of
 * the log (the Stop hook would then let the agent stop unverified).
 */
export function recordEdits(sessionId: string, ctx: HookContext, edits: EditHit[], shellCall: boolean): void {
  if (!edits.length && !shellCall) return;
  updateSession(
    sessionId,
    (s) => {
      const ts = new Date().toISOString();
      for (const e of edits) s.edits.push({ path: hasHiddenUnicode(e.path) ? e.root : e.path, repo: e.id, ts });
      if (shellCall) s.shellRuns = (s.shellRuns ?? 0) + 1;
    },
    ctx.agent,
  );
}
