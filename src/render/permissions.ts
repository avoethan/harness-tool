/**
 * Per-agent permission blocks (DESIGN 2.4, 2.10), built from the guard's rail
 * data (src/guard/permissions.ts) so the cheap first layer and the PreToolUse
 * guard read one source.
 *
 *   Claude  permissions.deny / allow (+ ask for promoted ask rules) in the
 *           settings file; absolute-path Edit/Write denies for the protected
 *           roots (`//abs/**`; in the personal setting `~/...` when under the
 *           home folder, so a committed file holds no machine path for them);
 *           allow the exact verification commands and reads of the runs folder.
 *   Devin   permissions deny / ask / allow with absolute paths (Devin globs
 *           resolve against the working folder).
 *   Codex   a `.rules` file of prefix rules: forbidden for the rails, allow for
 *           the verification commands.
 *
 * Plus the settings edits of the setting: Devin `attribution: false` (team,
 * user config only), Claude `attribution` with empty commit and PR texts
 * (team), Devin `read_config_from.claude = false` when Devin and Claude are
 * both targeted (so Devin does not load Claude's hooks a second time).
 * Codex's commit attribution has no documented config key that was verified,
 * so nothing is written for it.
 *
 * Safety rules the user already had (deny/ask rules in any agent's settings)
 * are kept where they are (apply only unions) and translated into the other
 * agents' dialects, so a rule written for one agent holds for all of them.
 */
import * as path from 'node:path';
import { inboxHomeFor } from '../lib/paths';
import type { SafetyRule } from '../types';
import { buildPermissions, buildPermissionsByRail, codexRulesFile, type AgentRules, type PermissionOptions, type RulesByRail } from '../guard/permissions';
import { readTextOr } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { homeRelative, posix, removeBlock, upsertBlock, verificationArgv, type RenderContext, type RenderedFile, type RepoFacts } from './model';

export interface AgentDirs {
  claudeHome: string;
  codexHome: string;
  devinHome: string;
}

/** Agent config folders for a render context (mirrors src/lib/paths agentHome, with the context's home). */
export function agentDirs(ctx: RenderContext): AgentDirs {
  let devinHome: string;
  if (ctx.platform === 'win32') devinHome = path.join(process.env.APPDATA || path.join(ctx.userHome, 'AppData', 'Roaming'), 'devin');
  else devinHome = path.join(process.env.XDG_CONFIG_HOME || path.join(ctx.userHome, '.config'), 'devin');
  return { claudeHome: path.join(ctx.userHome, '.claude'), codexHome: path.join(ctx.userHome, '.codex'), devinHome };
}

/** Folders and files the agent must never write: harness state, agent configuration, the harness package. */
export function protectedRoots(ctx: RenderContext): string[] {
  const d = agentDirs(ctx);
  const roots = [
    ctx.harnessHome,
    d.claudeHome,
    d.codexHome,
    d.devinHome,
    path.join(ctx.userHome, '.devin'),
    path.join(ctx.userHome, '.agents'),
    ctx.packageRoot,
    path.join(ctx.userHome, '.claude.json'),
  ];
  if (ctx.setting === 'personal') {
    const r = ctx.repoRoot ?? ctx.workspaceRoot;
    for (const sub of ['.claude', '.codex', '.devin', '.agents', '.harness']) roots.push(path.join(r, sub));
  }
  const seen = new Set<string>();
  return roots.filter((p) => {
    const k = posix(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function permissionOptions(ctx: RenderContext, facts: RepoFacts[]): PermissionOptions {
  return {
    setting: ctx.setting,
    protectedRoots: protectedRoots(ctx),
    // Personal: the agent commits its work on the task branch (the runner's prompt asks for it), so a
    // headless session must not stop at "requires approval" for `git add` / `git commit`, nor for a
    // `git mv` that moves a file to where a standard wants it, nor a `git revert` that undoes a commit with a new one (neither rewrites history); the deny
    // rules (Claude: deny beats allow), the guard's git and staging rails, the tamper step and the pre-commit gate still apply.
    verificationAllow: [...verificationArgv(facts, ctx.setting === 'team' ? posix(path.join(ctx.packageRoot, 'dist', 'src', 'cli.js')) : undefined), ...(ctx.setting === 'personal' ? [['git', 'add'], ['git', 'commit'], ['git', 'mv'], ['git', 'revert']] : [])],
    runsDir: path.join(ctx.harnessHome, 'runs'),
    inboxDir: inboxHomeFor(ctx.harnessHome),
  };
}

/**
 * Claude path rules without machine paths (personal setting: the settings file
 * is committed): inside the repository as repo-relative globs (sessions start
 * at the repo root), under the home folder as `~/...`; anything else stays absolute.
 */
export function portableClaudeRule(rule: string, userHome: string, repoRoot?: string): string {
  const m = /^(Read|Edit|Write|MultiEdit|NotebookEdit)\(\/\/(.+)\)$/.exec(rule);
  if (!m) return rule;
  const abs = '/' + m[2];
  const tail = abs.endsWith('/**') ? '/**' : '';
  const base = tail ? abs.slice(0, -3) : abs;
  if (repoRoot) {
    const r = path.posix.relative(posix(repoRoot), base);
    if (r && !r.startsWith('..') && !path.posix.isAbsolute(r)) return `${m[1]}(${r}${tail})`;
  }
  const rel = homeRelative(base, posix(userHome));
  if (!rel.startsWith('~/')) return rule;
  return `${m[1]}(${rel}${tail})`;
}

// ---------------------------------------------------------------------------
// promotion of the user's own deny / ask rules into every agent's dialect
// ---------------------------------------------------------------------------

export interface PromotedRule {
  from: SafetyRule;
  kind: 'deny' | 'ask';
  claude: string[];
  devin: string[];
  codex: string[];
  /** Why it could not be translated (kept in its own file only). */
  note?: string;
}

function prefixWords(s: string): string[] | null {
  const words = s.trim().replace(/(:\*| \*)$/, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.some((w) => /[*?[\]{}]/.test(w))) return null;
  return words;
}

export function translateSafetyRule(r: SafetyRule): PromotedRule | null {
  if (r.kind !== 'deny-rule' && r.kind !== 'ask-rule') return null;
  const kind = r.kind === 'deny-rule' ? 'deny' : 'ask';
  const out: PromotedRule = { from: r, kind, claude: [], devin: [], codex: [] };
  const text = r.text.trim();
  let m: RegExpExecArray | null;
  let words: string[] | null = null;
  if ((m = /^Bash\((.*)\)$/.exec(text)) || (m = /^Exec\((.*)\)$/.exec(text))) words = prefixWords(m[1]);
  else if ((m = /^(.+?) \((forbidden|prompt)\)$/.exec(text))) words = prefixWords(m[1]);
  else if ((m = /^(Read|Edit|Write)\((.+)\)$/.exec(text))) {
    const tool = m[1];
    const glob = m[2];
    if (tool === 'Read') {
      out.claude.push(`Read(${glob})`);
      out.devin.push(`Read(${glob.replace(/^\/\//, '/')})`);
    } else {
      out.claude.push(`Edit(${glob})`, `Write(${glob})`);
      out.devin.push(`Write(${glob.replace(/^\/\//, '/')})`);
    }
    out.note = 'path rule: Codex has no path rules; the PreToolUse guard covers it there';
    return out;
  }
  if (!words) {
    out.note = 'not a plain command prefix (wildcards or an unknown form); kept in its own file only';
    return out;
  }
  const p = words.join(' ');
  out.claude.push(`Bash(${p})`, `Bash(${p} *)`);
  out.devin.push(`Exec(${p})`);
  out.codex.push(`prefix_rule(pattern=[${words.map((w) => JSON.stringify(w)).join(', ')}], decision="${kind === 'deny' ? 'forbidden' : 'prompt'}", justification="kept from the user's own ${kind} rule")`);
  return out;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

export interface RenderedPermissions {
  rules: AgentRules;
  byRail: RulesByRail;
  claudeAsk: string[];
  codexRules: string;
  promoted: PromotedRule[];
}

export function renderPermissions(ctx: RenderContext, facts: RepoFacts[], safety: SafetyRule[] = []): RenderedPermissions {
  const opts = permissionOptions(ctx, facts);
  const rules = buildPermissions(opts);
  const byRail = buildPermissionsByRail(opts);
  const promoted = safety.map(translateSafetyRule).filter((x): x is PromotedRule => !!x);
  const claudeAsk: string[] = [];
  const extraCodex: string[] = [];
  for (const p of promoted) {
    if (p.kind === 'deny') {
      rules.claude.deny.push(...p.claude);
      rules.devin.deny.push(...p.devin);
    } else {
      claudeAsk.push(...p.claude);
      rules.devin.ask.push(...p.devin);
    }
    extraCodex.push(...p.codex);
  }
  if (ctx.setting === 'personal') {
    const repo = ctx.repoRoot ?? ctx.workspaceRoot;
    rules.claude.deny = rules.claude.deny.map((r) => portableClaudeRule(r, ctx.userHome, repo));
    rules.claude.allow = rules.claude.allow.map((r) => portableClaudeRule(r, ctx.userHome, repo));
  }
  const uniq = (a: string[]) => [...new Set(a)];
  rules.claude.deny = uniq(rules.claude.deny);
  rules.claude.allow = uniq(rules.claude.allow);
  rules.devin.deny = uniq(rules.devin.deny);
  rules.devin.ask = uniq(rules.devin.ask);
  rules.devin.allow = uniq(rules.devin.allow);
  let codexRules = codexRulesFile(opts);
  const extra = uniq(extraCodex).filter((x) => !codexRules.includes(x));
  if (extra.length) codexRules += ['# Kept from the user\'s own rules (translated from another agent\'s settings):', ...extra].join('\n') + '\n';
  return { rules, byRail, claudeAsk: uniq(claudeAsk), codexRules, promoted };
}

/** The Claude settings fragment (permissions and, in the team setting, attribution off). */
export function claudeSettingsFragment(ctx: RenderContext, p: RenderedPermissions): Record<string, unknown> {
  const perms: Record<string, unknown> = { deny: p.rules.claude.deny, allow: p.rules.claude.allow };
  if (p.claudeAsk.length) perms.ask = p.claudeAsk;
  const frag: Record<string, unknown> = { permissions: perms };
  if (ctx.setting === 'team') frag.attribution = { commit: '', pr: '' };
  return frag;
}

/** The Devin config fragment: permissions, and the settings edits of the setting. */
export function devinSettingsFragment(ctx: RenderContext, p: RenderedPermissions): Record<string, unknown> {
  const frag: Record<string, unknown> = { permissions: { deny: p.rules.devin.deny, ask: p.rules.devin.ask, allow: p.rules.devin.allow } };
  if (ctx.agents.includes('devin') && ctx.agents.includes('claude')) frag.read_config_from = { claude: false };
  if (ctx.setting === 'team') frag.attribution = false;
  return frag;
}

/** The Codex `.rules` file path. */
export function codexRulesPath(ctx: RenderContext): string {
  if (ctx.setting === 'personal') return path.join(ctx.repoRoot ?? ctx.workspaceRoot, '.codex', 'rules', 'harness.rules');
  return path.join(agentDirs(ctx).codexHome, 'rules', 'harness.rules');
}

// ---------------------------------------------------------------------------
// Codex config.toml (personal setting: trust the project so its .codex/ loads)
// ---------------------------------------------------------------------------

function tomlKey(p: string): string {
  return JSON.stringify(p);
}

/** The string values of a one-line TOML array (`["a", 'b']`); null when the line is not one. */
function tomlArrayValues(line: string): string[] | null {
  const m = /=\s*\[(.*)\]\s*(#.*)?$/.exec(line);
  if (!m) return null;
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1]))) out.push(x[1] !== undefined ? (JSON.parse(`"${x[1]}"`) as string) : x[2]);
  return out;
}

/**
 * The edit to `~/.codex/config.toml` that lets the harness write its evidence from inside Codex's
 * workspace-write sandbox: `[sandbox_workspace_write] writable_roots` gets the harness folder (the
 * gate, which the agent runs, writes `runs/`, `cache/` and `logs/` there; without it every gate run
 * inside the sandbox fails with a permission error). `existing` is the file without the harness's own
 * block. No table yet: `block` (lines for the harness block). The user's own table: `text` with the
 * path added in place (a second `[sandbox_workspace_write]` header would make the file invalid).
 * A form the edit cannot change safely (a multi-line array, a dotted or inline table): a `note`.
 */
export function codexSandboxEdit(existing: string | null, harnessHome: string): { text: string | null; block?: string; note?: string } {
  const cur = (existing ?? '').replace(/\r\n/g, '\n');
  const lines = cur.split('\n');
  const val = JSON.stringify(harnessHome);
  const manual = `add ${val} to \`[sandbox_workspace_write] writable_roots\` in ~/.codex/config.toml yourself, or \`harness gate\` cannot write its evidence inside the Codex sandbox`;
  if (lines.some((l) => /^\s*sandbox_workspace_write\s*[.=]/.test(l))) return { text: null, note: `~/.codex/config.toml sets sandbox_workspace_write as a dotted key or an inline table: ${manual}` };
  const h = lines.findIndex((l) => /^\s*\[\s*sandbox_workspace_write\s*\]\s*(#.*)?$/.test(l));
  if (h < 0) return { text: null, block: `[sandbox_workspace_write]\nwritable_roots = [${val}]` };
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const k = lines.findIndex((l, i) => i > h && i < end && /^\s*writable_roots\s*=/.test(l));
  let next: string[];
  if (k < 0) next = [...lines.slice(0, h + 1), `writable_roots = [${val}]`, ...lines.slice(h + 1)];
  else {
    const vals = tomlArrayValues(lines[k]);
    if (!vals) return { text: null, note: `~/.codex/config.toml lists writable_roots over several lines: ${manual}` };
    if (vals.some((v) => v === harnessHome || v.replace(/\\/g, '/').replace(/\/+$/, '') === harnessHome.replace(/\\/g, '/').replace(/\/+$/, ''))) return { text: null };
    const line = lines[k].replace(/\[(.*)\]/, (_m, inner: string) => (inner.trim() ? `[${inner.replace(/,?\s*$/, '')}, ${val}]` : `[${val}]`));
    next = [...lines.slice(0, k), line, ...lines.slice(k + 1)];
  }
  const text = next.join('\n');
  return { text: text.endsWith('\n') ? text : text + '\n' };
}

/**
 * `~/.codex/config.toml` for a Codex install, in both settings: the harness folder writable inside
 * the workspace-write sandbox, and (personal) the project trusted so its `.codex/` loads. Read without
 * the harness's own block, so a second run renders the same block. A marker block when the user's
 * own text needs no change (undo removes exactly it); the whole file when a table of the user's had
 * to change in place. Null file when nothing changes.
 */
export function codexConfigFile(ctx: RenderContext, version: string): { file: RenderedFile | null; notes: string[] } {
  const p = path.join(agentDirs(ctx).codexHome, 'config.toml');
  const cur = readTextOr(p, null);
  const outsideRaw = cur === null ? null : removeBlock(cur.replace(/\r\n/g, '\n'), 'hash');
  let outside = outsideRaw;
  let inPlace = false;
  const notes: string[] = [];
  const parts: string[] = [];
  const hunks: RenderedFile['hunks'] = [];
  if (ctx.setting === 'personal') {
    const t = codexTrustEdit(outside, ctx.repoRoot ?? ctx.workspaceRoot);
    if (t.note) notes.push(t.note);
    if (t.text !== null) {
      outside = t.text;
      inPlace = true;
    }
    if (t.block) parts.push(t.block);
    if (t.text !== null || t.block) hunks.push({ checkId: 'render.codex-trust', reason: "Codex loads a project's .codex/ hooks and rules only when the project is trusted", provenance: 'RESEARCH 7.3', contentHash: sha256(t.block ?? t.text ?? '') });
  }
  const sb = codexSandboxEdit(outside, ctx.harnessHome);
  if (sb.note) notes.push(`Codex: ${sb.note}.`);
  if (sb.text !== null) {
    outside = sb.text;
    inPlace = true;
  }
  if (sb.block) parts.push(sb.block);
  if (sb.text !== null || sb.block) hunks.push({ checkId: 'render.codex-sandbox', reason: `Codex runs commands in a workspace-write sandbox; \`harness gate\` writes its evidence under ${homeRelative(ctx.harnessHome, ctx.userHome)}, so that folder is added to writable_roots`, provenance: `harness ${version}`, contentHash: sha256(sb.block ?? sb.text ?? '') });
  if (!hunks.length) return { file: null, notes };
  const body = parts.join('\n\n');
  if (!inPlace) return { file: { path: p, kind: 'block', block: { style: 'hash', position: 'end' }, content: body, role: 'toml', agent: 'codex', hunks }, notes };
  const text = parts.length ? upsertBlock(outside, body, 'hash', 'end') : outside ?? '';
  return { file: { path: p, kind: 'text', content: text, role: 'toml', agent: 'codex', hunks }, notes };
}

/**
 * The edit to `~/.codex/config.toml` that trusts the personal repository.
 * Returns the new file text, or null when nothing changes (already trusted)
 * plus a note when the user marked the project untrusted (never overridden).
 */
export function codexTrustEdit(existing: string | null, repoRoot: string): { text: string | null; note?: string; block?: string } {
  const cur = (existing ?? '').replace(/\r\n/g, '\n');
  const key = tomlKey(repoRoot);
  const keys = [key, `'${repoRoot}'`];
  const lines = cur.split('\n');
  const headerIdx = lines.findIndex((l) => keys.some((k) => l.trim() === `[projects.${k}]`));
  if (headerIdx >= 0) {
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const body = lines.slice(headerIdx + 1, end);
    const tl = body.find((l) => /^\s*trust_level\s*=/.test(l));
    if (tl && /"trusted"|'trusted'/.test(tl)) return { text: null };
    if (tl) return { text: null, note: `~/.codex/config.toml marks ${repoRoot} as not trusted; the harness leaves your choice alone, but Codex will not load the project's .codex/ hooks and rules until you trust it` };
    const next = [...lines.slice(0, headerIdx + 1), 'trust_level = "trusted"', ...lines.slice(headerIdx + 1)].join('\n');
    return { text: next.endsWith('\n') ? next : next + '\n' };
  }
  const block = `[projects.${key}]\ntrust_level = "trusted"`;
  return { text: null, block };
}
