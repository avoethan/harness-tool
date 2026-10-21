/**
 * Checks over agent configuration (settings, hooks, MCP, Codex config) and CI:
 *
 *   R14 broad permission         R15 hook command (info; high when it downloads,
 *   R16 MCP server declared          pipes to a shell or runs package code)
 *   R17 committed local settings R20 CI agent on untrusted input
 *   R24 config that cannot be parsed
 *
 * Hook scripts that a hook command names are read as text, never run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryParseJsonc } from '../lib/jsonc';
import { escapeForReport } from './scan';
import { tryParseToml, type TomlTable } from './toml';
import { displayPath } from './inventory';
import { trackedAmong } from './project';
import type { AssessContext, InvFile } from './model';

function lineOfText(text: string, needle: string): number | undefined {
  if (!needle) return undefined;
  const idx = text.indexOf(needle);
  return idx >= 0 ? text.slice(0, idx).split('\n').length : undefined;
}

function jsonOf(ctx: AssessContext, f: InvFile): Record<string, unknown> | null {
  const r = tryParseJsonc<Record<string, unknown>>(f.text);
  if (r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) return r.value;
  return null;
}

function tomlOf(f: InvFile): TomlTable | null {
  const r = tryParseToml(f.text);
  return r.ok ? r.value : null;
}

// ---------------------------------------------------------------------------
// R24
// ---------------------------------------------------------------------------

export function unparseable(ctx: AssessContext): void {
  for (const f of ctx.files) {
    if (!['settings', 'hook-config', 'mcp'].includes(f.kind) || f.binary) continue;
    if (/\.toml$/.test(f.abs)) {
      const r = tryParseToml(f.text);
      if (!r.ok) {
        ctx.findings.push({ check: 'R24', severity: 'warn', file: f.abs, message: `${f.display} could not be parsed (${r.error}); this reader handles tables, strings, booleans, numbers, arrays and inline tables only. Automatic changes to it are off.` });
        ctx.notes.push(`${f.display}: could not be parsed (${r.error})`);
      }
      continue;
    }
    if (!/\.json$/.test(f.abs)) continue;
    const r = tryParseJsonc(f.text);
    if (!r.ok) {
      ctx.findings.push({ check: 'R24', severity: 'warn', file: f.abs, message: `${f.display} could not be parsed even after removing comments and trailing commas (${r.error}). Automatic changes to it are off.` });
      ctx.notes.push(`${f.display}: could not be parsed (${r.error})`);
    }
  }
}

// ---------------------------------------------------------------------------
// R14 broad permission
// ---------------------------------------------------------------------------

const BROAD_CLAUDE = /^(Bash|Bash\(\*\)|Bash\(\*:\*\)|\*|Bash\((curl|wget|sh|bash|zsh|pwsh|powershell|sudo|iwr|irm)\b.*\))$/;
const BROAD_DEVIN = /^(Exec|Exec\(\*\)|\*|Exec\((curl|wget|sh|bash|zsh|pwsh|powershell|sudo)\b.*\)|Write\(\*\*\)|Write\(\/\*\*\))$/;

export function broadPermissions(ctx: AssessContext): void {
  for (const f of ctx.files) {
    if (f.kind !== 'settings' || f.binary) continue;
    const base = path.basename(f.abs);
    const dir = path.basename(path.dirname(f.abs));
    if (base.endsWith('.json')) {
      const v = jsonOf(ctx, f);
      if (!v) continue;
      const perms = v.permissions as Record<string, unknown> | undefined;
      const isDevin = dir === '.devin' || (dir === 'devin' && base === 'config.json');
      const re = isDevin ? BROAD_DEVIN : BROAD_CLAUDE;
      if (perms && Array.isArray(perms.allow)) {
        for (const item of perms.allow) {
          if (typeof item !== 'string' || !re.test(item.trim())) continue;
          ctx.findings.push({ check: 'R14', severity: 'high', file: f.abs, line: lineOfText(f.text, JSON.stringify(item)), message: `${f.display} allows "${escapeForReport(item, 60)}" without asking; that lets the agent run ${/curl|wget|iwr|irm/.test(item) ? 'downloads' : 'any command'} unprompted.`, evidence: escapeForReport(item, 80) });
        }
      }
      if (perms && perms.defaultMode === 'bypassPermissions')
        ctx.findings.push({ check: 'R14', severity: 'high', file: f.abs, line: lineOfText(f.text, 'bypassPermissions'), message: `${f.display} sets defaultMode to bypassPermissions: every tool call runs without a prompt.`, evidence: 'defaultMode: bypassPermissions' });
    } else if (base === 'config.toml') {
      const t = tomlOf(f);
      if (!t) continue;
      const tables: Array<[string, TomlTable]> = [['', t]];
      const profiles = t.profiles;
      if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) for (const [k, p] of Object.entries(profiles)) if (p && typeof p === 'object' && !Array.isArray(p)) tables.push([`profile ${k}: `, p as TomlTable]);
      for (const [where, tb] of tables) {
        if (tb.approval_policy === 'never') ctx.findings.push({ check: 'R14', severity: 'high', file: f.abs, line: lineOfText(f.text, 'approval_policy'), message: `${f.display} ${where}sets approval_policy = "never": Codex never asks before running commands.`, evidence: 'approval_policy = "never"' });
        if (tb.sandbox_mode === 'danger-full-access') ctx.findings.push({ check: 'R14', severity: 'high', file: f.abs, line: lineOfText(f.text, 'danger-full-access'), message: `${f.display} ${where}sets sandbox_mode = "danger-full-access": no sandbox at all.`, evidence: 'sandbox_mode = "danger-full-access"' });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// R15 hook commands
// ---------------------------------------------------------------------------

const NET = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat)\b|https?:\/\//i;
const PIPE_SHELL = /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\|\s*iex\b|\|\s*(python3?|node|perl|ruby)\b/i;
const PKG_CODE = /node_modules[\\/]|(^|[\s"'/\\])vendor[\\/]|\b(npx|bunx|pnpx|uvx)\s|\b(pnpm|yarn)\s+dlx\b/i;

interface HookCmd {
  event: string;
  command: string;
}

/** Hook commands in a hook config (Claude / Codex / Devin / Cursor shapes). */
export function hookCommands(v: unknown): HookCmd[] {
  const out: HookCmd[] = [];
  const visit = (node: unknown, event: string, depth: number) => {
    if (depth > 8 || !node) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, event, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.command === 'string' && (o.type === undefined || o.type === 'command')) out.push({ event, command: o.command });
    else if (Array.isArray(o.command) && o.command.every((x) => typeof x === 'string')) out.push({ event, command: (o.command as string[]).join(' ') });
    for (const [k, val] of Object.entries(o)) {
      if (k === 'command') continue;
      visit(val, /^[A-Z][A-Za-z]+$/.test(k) || /^[a-z]+[A-Z]\w*$/.test(k) ? k : event, depth + 1);
    }
  };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    visit(o.hooks !== undefined ? o.hooks : o, '', 0);
  }
  return out;
}

function risk(text: string): string | null {
  if (PIPE_SHELL.test(text) && NET.test(text)) return 'downloads and pipes into a shell';
  if (NET.test(text)) return 'reaches the network';
  if (PIPE_SHELL.test(text)) return 'pipes into an interpreter';
  if (PKG_CODE.test(text)) return 'runs package code (node_modules, vendor, npx and the like)';
  return null;
}

/** Repo-local script files a hook command names (read as text, never run). */
function scriptsNamed(command: string, projectRoot: string, home: string): string[] {
  const out: string[] = [];
  const cleaned = command.replace(/\$\{?(CLAUDE_PROJECT_DIR|DEVIN_PROJECT_DIR|CODEX_PROJECT_DIR|PWD)\}?/g, projectRoot).replace(/["']/g, ' ');
  for (const tok of cleaned.split(/\s+/)) {
    if (!/[\\/]/.test(tok) && !/\.(sh|js|mjs|cjs|ts|py|ps1|rb|pl)$/.test(tok)) continue;
    const abs = tok.startsWith('~/') ? path.join(home, tok.slice(2)) : path.isAbsolute(tok) ? tok : path.resolve(projectRoot, tok);
    try {
      if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 1024 * 1024) out.push(abs);
    } catch {
      /* not a file */
    }
  }
  return out;
}

const HOOK_FILE = (f: InvFile) => f.kind === 'hook-config' || (f.kind === 'settings' && /\.json$/.test(f.abs));

export function hookChecks(ctx: AssessContext): void {
  for (const f of ctx.files) {
    if (!HOOK_FILE(f) || f.binary) continue;
    const v = jsonOf(ctx, f);
    if (!v) continue;
    if (f.kind === 'settings' && v.hooks === undefined) continue;
    const projectRoot = f.level === 'user' ? ctx.userHome : path.dirname(path.dirname(f.abs));
    for (const h of hookCommands(v)) {
      const line = lineOfText(f.text, JSON.stringify(h.command).slice(1, -1).slice(0, 60));
      const r = risk(h.command);
      if (r) {
        ctx.findings.push({ check: 'R15', severity: 'high', file: f.abs, line, message: `A ${h.event || ''} hook in ${f.display} ${r}; hooks run with your rights on every matching event.`, evidence: escapeForReport(h.command, 140) });
        continue;
      }
      let scriptRisk: { script: string; why: string } | null = null;
      for (const s of scriptsNamed(h.command, projectRoot, ctx.userHome)) {
        const why = risk(fs.readFileSync(s, 'utf8'));
        if (why) {
          scriptRisk = { script: s, why };
          break;
        }
      }
      if (scriptRisk) ctx.findings.push({ check: 'R15', severity: 'high', file: f.abs, line, message: `A ${h.event || ''} hook in ${f.display} runs ${displayPath(ctx, scriptRisk.script)}, which ${scriptRisk.why} (the script was read, not run).`, evidence: escapeForReport(h.command, 140) });
      else ctx.findings.push({ check: 'R15', severity: 'info', file: f.abs, line, message: `A ${h.event || ''} hook in ${f.display} runs a command.`, evidence: escapeForReport(h.command, 140) });
    }
  }
}

// ---------------------------------------------------------------------------
// R16 MCP servers
// ---------------------------------------------------------------------------

function serverEvidence(cfg: unknown): string {
  if (!cfg || typeof cfg !== 'object') return '';
  const o = cfg as Record<string, unknown>;
  if (typeof o.url === 'string') {
    try {
      return `url ${new URL(o.url).origin}`;
    } catch {
      return 'url (unparseable)';
    }
  }
  if (typeof o.command === 'string') return `command ${escapeForReport(path.basename(o.command), 40)}`;
  return '';
}

export function mcpChecks(ctx: AssessContext): void {
  for (const f of ctx.files) {
    if (f.binary) continue;
    const servers: Array<[string, unknown]> = [];
    if (/\.toml$/.test(f.abs)) {
      const t = tomlOf(f);
      const m = t?.mcp_servers;
      if (m && typeof m === 'object' && !Array.isArray(m)) servers.push(...Object.entries(m));
    } else if (/\.json$/.test(f.abs) && (f.kind === 'mcp' || f.kind === 'settings')) {
      const v = jsonOf(ctx, f);
      if (!v) continue;
      for (const key of ['mcpServers', 'servers']) {
        const m = v[key];
        if (m && typeof m === 'object' && !Array.isArray(m)) servers.push(...Object.entries(m as Record<string, unknown>));
      }
      const projects = v.projects;
      if (path.basename(f.abs) === '.claude.json' && projects && typeof projects === 'object') {
        for (const p of Object.values(projects as Record<string, unknown>)) {
          const m = p && typeof p === 'object' ? (p as Record<string, unknown>).mcpServers : undefined;
          if (m && typeof m === 'object' && !Array.isArray(m)) servers.push(...Object.entries(m as Record<string, unknown>));
        }
      }
    }
    for (const [name, cfg] of servers) {
      ctx.findings.push({ check: 'R16', severity: 'info', file: f.abs, line: lineOfText(f.text, name), message: `MCP server "${escapeForReport(name, 60)}" is declared in ${f.display}${serverEvidence(cfg) ? ` (${serverEvidence(cfg)})` : ''}.`, evidence: serverEvidence(cfg) });
    }
  }
}

// ---------------------------------------------------------------------------
// R17 committed local settings
// ---------------------------------------------------------------------------

const LOCAL_FILES = ['.claude/settings.local.json', 'CLAUDE.local.md', 'AGENTS.local.md', '.devin/config.local.json', '.devin/mcp_config.local.json'];

export function committedLocal(ctx: AssessContext): void {
  for (const repo of ctx.repos) {
    const present = ctx.files.filter((f) => f.repoRoot === repo.root && LOCAL_FILES.some((l) => f.abs.replace(/\\/g, '/').endsWith('/' + l)));
    if (!present.length) continue;
    const rels = present.map((f) => path.relative(repo.root, f.abs).replace(/\\/g, '/'));
    const tracked = trackedAmong(repo.root, rels);
    if (!tracked) {
      ctx.notes.push(`${displayPath(ctx, repo.root)}: ${rels.join(', ')} present; not a git repository here, so whether ${rels.length > 1 ? 'they are' : 'it is'} committed is unknown`);
      continue;
    }
    present.forEach((f, i) => {
      if (!tracked.has(rels[i])) return;
      ctx.findings.push({ check: 'R17', severity: 'warn', file: f.abs, message: `${f.display} is committed to git; local settings are personal (they often hold permissions or paths for one machine) and belong in .gitignore.` });
    });
  }
}

// ---------------------------------------------------------------------------
// R20 CI agents on untrusted input
// ---------------------------------------------------------------------------

const AGENT_ACTION = /uses:\s*['"]?([\w.-]+\/(?:claude-code-action|codex-action|claude-code-base-action|[\w-]*(?:claude|codex|devin)[\w-]*))(?:@[\w.-]+)?/i;
const AGENT_RUN = /\b(claude\s+(-p|--print)\b|npx\s+(-y\s+)?@anthropic-ai\/claude-code\b|codex\s+exec\b|npx\s+(-y\s+)?@openai\/codex\b|devin\s+(-p|--print|run)\b)/i;
const UNTRUSTED = ['issues', 'issue_comment', 'pull_request_target', 'discussion', 'discussion_comment', 'pull_request_review_comment'];

export function ciAgents(ctx: AssessContext): void {
  for (const repo of ctx.repos) {
    for (const wf of repo.workflows) {
      const lines = wf.text.split(/\r?\n/);
      const i = lines.findIndex((l) => AGENT_ACTION.test(l) || AGENT_RUN.test(l));
      if (i < 0) continue;
      const bad = UNTRUSTED.filter((t) => wf.triggers.has(t));
      if (bad.length) ctx.findings.push({ check: 'R20', severity: 'high', file: wf.file, line: i + 1, message: `${displayPath(ctx, wf.file)} runs a coding agent on ${bad.join(', ')} events, which anyone can trigger with text the agent will read.`, evidence: escapeForReport(lines[i], 120) });
      else ctx.findings.push({ check: 'R20', severity: 'info', file: wf.file, line: i + 1, message: `${displayPath(ctx, wf.file)} runs a coding agent in CI (on ${[...wf.triggers].join(', ') || 'unknown'} events).`, evidence: escapeForReport(lines[i], 120) });
    }
    for (const n of ['.gitlab-ci.yml', 'azure-pipelines.yml', 'azure-pipelines.yaml', 'Jenkinsfile', '.circleci/config.yml', 'bitbucket-pipelines.yml']) {
      const p = path.join(repo.root, n);
      let text: string;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      const i = lines.findIndex((l) => AGENT_RUN.test(l));
      if (i >= 0) ctx.findings.push({ check: 'R20', severity: 'info', file: p, line: i + 1, message: `${displayPath(ctx, p)} runs a coding agent in CI; check which events can trigger it.`, evidence: escapeForReport(lines[i], 120) });
    }
  }
}
