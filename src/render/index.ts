/**
 * renderHarness(ctx): every file of the rendered harness for one setting and
 * set of agents, from one source (the ledger, the inventory, the config and
 * the templates). propose turns the result into plan targets; self-update
 * compares it with what the manifest says the harness wrote.
 *
 * Nothing here writes to disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, SafetyRule } from '../types';
import { readTextOr } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { allRepoFacts, homeRelative, type RenderContext, type RenderedFile } from './model';
import { alwaysOnTargets, renderAlwaysOnFile } from './alwayson';
import { renderSkills, SKILL_NAMES } from './skills';
import { renderScoped } from './scoped';
import { hookFilePath, hooksFragment } from './hooks';
import { agentDirs, claudeSettingsFragment, codexConfigFile, codexRulesPath, devinSettingsFragment, renderPermissions, type RenderedPermissions } from './permissions';
import { prettierIgnoreFile, renderPersonal } from './personal';

export interface RenderOptions {
  /** The user's own text of a file after propose's moves; defaults to the file on disk. */
  userText?: (p: string) => string | null;
  /** The safety inventory (deny/ask rules are translated into every agent's dialect). */
  safety?: SafetyRule[];
}

export interface RenderResult {
  files: RenderedFile[];
  notes: string[];
  permissions: RenderedPermissions;
  /** Always-on files over the size limit because of the user's own text. */
  over: Array<{ path: string; why: string }>;
}

export function renderHarness(ctx: RenderContext, opts: RenderOptions = {}): RenderResult {
  const files: RenderedFile[] = [];
  const notes: string[] = [];
  const over: RenderResult['over'] = [];
  const userText = opts.userText ?? ((p: string) => readTextOr(p, null));
  const facts = allRepoFacts(ctx);
  const dirs = agentDirs(ctx);

  // 1. always-on files
  for (const t of alwaysOnTargets(ctx)) {
    const local: RenderContext = { ...ctx, pointers: [...(ctx.pointers ?? []), ...devinPointers(ctx, t.agents)] };
    const f = renderAlwaysOnFile(local, t.agents, userText(t.path));
    if (f.over) over.push({ path: t.path, why: f.over });
    files.push({
      path: t.path,
      kind: 'text',
      content: f.text,
      role: 'always-on',
      agent: t.agents[0],
      hunks: [
        {
          checkId: 'render.alwayson',
          reason: `always-on instructions for ${t.agents.join(', ')}: ${f.block.lines} harness-owned lines, ${f.bytes} bytes in the file (limits 60 lines, 4096 bytes)${f.block.dropped.length ? `; left out to fit: ${f.block.dropped.join(', ')}` : ''}`,
          provenance: `ledger + inventory + templates (harness ${ctx.harnessVersion})`,
          contentHash: sha256(f.block.body),
        },
      ],
    });
  }

  // 2. skills, 3. scoped rules
  files.push(...renderSkills(ctx));
  files.push(...renderScoped(ctx));

  // 4. hooks and permissions per agent
  const perms = renderPermissions(ctx, facts, opts.safety ?? []);
  const fileDirs = { ...dirs, repoRoot: ctx.setting === 'personal' ? ctx.repoRoot ?? ctx.workspaceRoot : undefined };
  for (const agent of ctx.agents) {
    const p = hookFilePath(agent, ctx.setting, fileDirs);
    const hooks = hooksFragment(agent, ctx.packageRoot);
    if (agent === 'claude') {
      const frag = { ...hooks, ...claudeSettingsFragment(ctx, perms) };
      files.push(jsonFile(p, frag, 'settings', agent, ctx, 'hooks, permission deny/allow rules' + (ctx.setting === 'team' ? ' and attribution off' : '')));
    } else if (agent === 'devin') {
      const frag: Record<string, unknown> = { ...hooks, ...devinSettingsFragment(ctx, perms) };
      const extras = [frag.read_config_from ? 'read_config_from.claude = false (Devin would otherwise run the Claude hooks a second time)' : '', frag.attribution === false ? 'attribution false' : ''].filter(Boolean);
      files.push(jsonFile(p, frag, 'settings', agent, ctx, `hooks, permission deny/ask/allow rules${extras.length ? ', ' + extras.join(', ') : ''}`));
      notes.push(...devinNotes(ctx, p, frag));
    } else {
      files.push(jsonFile(p, hooks, 'hooks', agent, ctx, 'hooks (Codex loads hooks only from hooks.json; each needs trust in /hooks)'));
      const rp = codexRulesPath(ctx);
      files.push({ path: rp, kind: 'text', content: perms.codexRules, role: 'rules', agent, hunks: [{ checkId: 'render.permissions', reason: 'Codex prefix rules: forbidden for the rails, allow for the exact verification commands', provenance: `guard rails (harness ${ctx.harnessVersion})`, contentHash: sha256(perms.codexRules) }] });
    }
  }

  // 5. personal set
  if (ctx.setting === 'personal') {
    const p = renderPersonal(ctx);
    files.push(...p.files);
    notes.push(...p.notes);
    const pi = prettierIgnoreFile(ctx, files);
    if (pi) files.push(pi);
  }

  // 6. Codex user config: the harness folder writable in the sandbox; personal: the project trusted
  if (ctx.agents.includes('codex')) {
    const c = codexConfigFile(ctx, ctx.harnessVersion);
    if (c.file) files.push(c.file);
    notes.push(...c.notes);
  }
  return { files, notes, permissions: perms, over };
}

function jsonFile(p: string, frag: Record<string, unknown>, role: RenderedFile['role'], agent: AgentId, ctx: RenderContext, what: string): RenderedFile {
  const content = JSON.stringify(frag);
  const hunks: RenderedFile['hunks'] = [
    { checkId: 'render.hooks', reason: `${agent}: ${what}; existing entries are kept (union)`, provenance: `harness ${ctx.harnessVersion}`, contentHash: sha256(JSON.stringify((frag as { hooks?: unknown }).hooks ?? null)) },
  ];
  if (Object.keys(frag).some((k) => k !== 'hooks')) {
    hunks.push({ checkId: 'render.permissions', reason: `${agent}: the rails as permission rules (the cheap first layer; the PreToolUse guard is the real rail)`, provenance: 'guard rail data', contentHash: sha256(JSON.stringify({ ...frag, hooks: undefined })) });
  }
  return { path: p, kind: 'json', content, role, agent, hunks };
}

/** Pointer lines for Devin's always-on file when it stops reading Claude's files. */
function devinPointers(ctx: RenderContext, agents: AgentId[]): string[] {
  if (ctx.setting !== 'team' || !agents.includes('devin') || !ctx.agents.includes('claude')) return [];
  const claudeMd = path.join(agentDirs(ctx).claudeHome, 'CLAUDE.md');
  const skills = path.join(agentDirs(ctx).claudeHome, 'skills');
  const parts: string[] = [];
  if (fs.existsSync(claudeMd)) parts.push(`\`${homeRelative(claudeMd, ctx.userHome)}\``);
  if (userSkills(skills).length) parts.push(`\`${homeRelative(skills, ctx.userHome)}/\``);
  if (!parts.length) return [];
  return [`Devin does not load ${parts.join(' or ')} (Claude Code config reading is off so hooks do not run twice); read them when a task needs the user's own notes.`];
}

function devinNotes(ctx: RenderContext, p: string, frag: Record<string, unknown>): string[] {
  const out: string[] = [];
  const cur = readTextOr(p, null);
  if (!cur) return out;
  let doc: Record<string, unknown> | null = null;
  try {
    doc = JSON.parse(cur.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return out;
  }
  const rcf = (doc?.read_config_from ?? {}) as Record<string, unknown>;
  if (frag.read_config_from && rcf.claude === true) out.push(`${p} sets read_config_from.claude to true; the harness leaves your explicit choice alone. Devin then also runs the Claude Code hooks; the dispatcher runs each event once.`);
  if (frag.attribution === false && doc?.attribution === true) out.push(`${p} sets attribution to true; the harness leaves it. Devin will add its attribution to commits.`);
  return out;
}

/** The user's own skill folders (the harness's task, learn and setup do not count). */
function userSkills(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !(SKILL_NAMES as readonly string[]).includes(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
