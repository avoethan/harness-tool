/**
 * The three skills (DESIGN 2.4): `task` (model-invocable), `learn` and
 * `setup` (user-invoked). One template each under templates/skills/<name>/,
 * rendered per agent and setting:
 *
 *   front matter  only `name` and `description`; Claude Code also gets
 *                 `disable-model-invocation: true` for learn and setup.
 *                 Codex and Devin read only name/description, so they get
 *                 nothing else.
 *   body          `{{#team}}...{{/team}}` / `{{#personal}}...{{/personal}}`
 *                 sections kept for the setting; `{{CLI_NOTE}}` and
 *                 `{{GATE_ATTEMPTS}}` and `{{INBOX}}` (the pasted-ticket folder) filled in.
 *
 * Locations (RESEARCH 7.4):
 *   team      Claude ~/.claude/skills/<name>/SKILL.md; Devin and Codex share
 *             ~/.agents/skills/<name>/SKILL.md (Devin on Windows:
 *             %APPDATA%\devin\skills\<name>\SKILL.md)
 *   personal  <repo>/.claude/skills/<name>/SKILL.md and
 *             <repo>/.agents/skills/<name>/SKILL.md (copies)
 *
 * Text moved out of a user's files by SPLIT lands in the task skill's
 * `references/house-notes.md`, which the skill tells the agent to read.
 */
import * as path from 'node:path';
import { inboxHomeFor } from '../lib/paths';
import type { AgentId } from '../types';
import { readTextOr } from '../lib/fsx';
import { parseFrontMatter, renderFrontMatter } from '../lib/frontmatter';
import { sha256 } from '../lib/hash';
import { DEFAULT_CAPS } from '../types';
import { posix, type RenderContext, type RenderedFile } from './model';

export const SKILL_NAMES = ['task', 'learn', 'setup'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** Skills only the user starts (never chosen by the model on its own). */
export const USER_INVOKED: ReadonlySet<SkillName> = new Set<SkillName>(['learn', 'setup']);

export function templatesDir(packageRoot: string): string {
  return path.join(packageRoot, 'templates');
}

export function readTemplate(packageRoot: string, rel: string): string {
  const p = path.join(templatesDir(packageRoot), rel);
  const t = readTextOr(p, null);
  if (t === null) throw new Error(`template missing: ${p} (the harness package is incomplete; reinstall it)`);
  return t.replace(/\r\n/g, '\n');
}

/** The CLI line every rendered file uses when `harness` may not be on PATH. */
export function cliNote(ctx: RenderContext): string {
  if (ctx.setting === 'personal') {
    return '`harness` is the harness command line. If it is not on your PATH, ask the user to add the harness `bin` folder to it; do not look for another way to run it.';
  }
  return `If \`harness\` is not on your PATH, run \`node "${posix(path.join(ctx.packageRoot, 'dist', 'src', 'cli.js'))}"\` in its place.`;
}

/** Keep or drop `{{#flag}}...{{/flag}}` sections (whole-line blocks first, then inline ones). */
export function applyConditionals(text: string, flags: Record<string, boolean>): string {
  let out = text.replace(/^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n?/gm, (_m, flag: string, body: string) => (flags[flag] ? body : ''));
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, flag: string, body: string) => (flags[flag] ? body : ''));
  return out;
}

export function renderSkill(name: SkillName, ctx: RenderContext, agent: AgentId): string {
  const tpl = readTemplate(ctx.packageRoot, `skills/${name}/SKILL.md`);
  const fm = parseFrontMatter(tpl);
  const data: Record<string, unknown> = { name: String(fm.data.name ?? name), description: String(fm.data.description ?? '') };
  if (agent === 'claude' && USER_INVOKED.has(name)) data['disable-model-invocation'] = true;
  let body = applyConditionals(fm.body, { team: ctx.setting === 'team', personal: ctx.setting === 'personal' });
  let note = cliNote(ctx);
  if (name === 'task' && ctx.references?.length) {
    note += '\n\nAt intake, read `references/house-notes.md` next to this file: notes moved there from the user\'s own instruction files.';
  }
  if (name === 'task' && lessonNotes(ctx).length) {
    note += '\n\nAt intake, also read `references/lessons.md`: mistakes that came back before, as the user approved them.';
  }
  body = body
    .replace(/\{\{CLI_NOTE\}\}/g, note)
    .replace(/\{\{GATE_ATTEMPTS\}\}/g, String(ctx.config?.caps?.gateAttempts ?? DEFAULT_CAPS.gateAttempts))
    .replace(/\{\{INBOX\}\}/g, inboxHomeFor(ctx.harnessHome).split(path.sep).join('/'));
  body = body.replace(/\n{3,}/g, '\n\n');
  return renderFrontMatter(data) + '\n' + body.replace(/^\n+/, '');
}

/** The house-notes reference file: SPLIT text, verbatim, with its origin. */
export function renderReferences(ctx: RenderContext): string | null {
  if (!ctx.references?.length) return null;
  const lines = [
    '# House notes',
    '',
    'Moved here by `harness propose` from the user\'s own instruction files (SPLIT: detail that belongs',
    'with the task, not in the always-on file). The wording is the user\'s; each block names its origin.',
    '',
  ];
  for (const r of ctx.references) {
    lines.push(`From ${r.origin}:`, '', r.text.replace(/\n+$/, ''), '');
  }
  return lines.join('\n');
}

function lessonNotes(ctx: RenderContext): NonNullable<RenderContext['lessons']> {
  return (ctx.lessons ?? []).filter((l) => l.rung === 'skill' && l.text.trim());
}

/** Approved skill-text lessons (src/learn), each with its id and review date. */
export function renderLessonNotes(ctx: RenderContext): string | null {
  const notes = lessonNotes(ctx);
  if (!notes.length) return null;
  const lines = [
    '# Lessons',
    '',
    'Written by `harness learn` from mistakes that came back, and approved by the user in `harness learn review`.',
    'Each note expires on its review date unless the user renews it.',
    '',
  ];
  for (const l of notes) lines.push(`## ${l.id}${l.reviewBy ? ` (review by ${l.reviewBy})` : ''}`, '', l.text.replace(/\n+$/, ''), '');
  return lines.join('\n');
}

interface SkillHome {
  dir: string;
  agents: AgentId[];
}

/** Where the skills go for this setting and set of agents (one folder may serve several agents). */
export function skillHomes(ctx: RenderContext): SkillHome[] {
  const out: SkillHome[] = [];
  const has = (a: AgentId) => ctx.agents.includes(a);
  if (ctx.setting === 'personal') {
    const root = ctx.repoRoot ?? ctx.workspaceRoot;
    if (has('claude')) out.push({ dir: path.join(root, '.claude', 'skills'), agents: ['claude'] });
    const shared = (['devin', 'codex'] as AgentId[]).filter(has);
    if (shared.length) out.push({ dir: path.join(root, '.agents', 'skills'), agents: shared });
    return out;
  }
  if (has('claude')) out.push({ dir: path.join(ctx.userHome, '.claude', 'skills'), agents: ['claude'] });
  const sharedDir = path.join(ctx.userHome, '.agents', 'skills');
  const shared: AgentId[] = [];
  if (has('codex')) shared.push('codex');
  if (has('devin')) {
    if (ctx.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(ctx.userHome, 'AppData', 'Roaming');
      out.push({ dir: path.join(appData, 'devin', 'skills'), agents: ['devin'] });
    } else shared.push('devin');
  }
  if (shared.length) out.push({ dir: sharedDir, agents: shared });
  return out;
}

export function renderSkills(ctx: RenderContext): RenderedFile[] {
  const out: RenderedFile[] = [];
  const refs = renderReferences(ctx);
  const lessons = renderLessonNotes(ctx);
  for (const home of skillHomes(ctx)) {
    // Claude gets its own extras; a shared folder (Devin + Codex) gets name and description only.
    const agent: AgentId = home.agents.includes('claude') ? 'claude' : home.agents[0];
    for (const name of SKILL_NAMES) {
      const content = renderSkill(name, ctx, agent);
      out.push({
        path: path.join(home.dir, name, 'SKILL.md'),
        kind: 'text',
        content,
        role: 'skill',
        agent,
        hunks: [
          {
            checkId: `render.skill.${name}`,
            reason: `${name} skill for ${home.agents.join(' and ')}${USER_INVOKED.has(name) ? ' (user-invoked only)' : ' (the order of work for every task)'}`,
            provenance: `template skills/${name}/SKILL.md (harness ${ctx.harnessVersion})`,
            contentHash: sha256(content),
          },
        ],
      });
    }
    if (refs) {
      out.push({
        path: path.join(home.dir, 'task', 'references', 'house-notes.md'),
        kind: 'text',
        content: refs,
        role: 'skill-ref',
        agent,
        hunks: [{ checkId: 'SPLIT', reason: 'detail moved out of the always-on file into the task skill\'s reference', provenance: (ctx.references ?? []).map((r) => r.origin).join(', '), contentHash: sha256(refs) }],
      });
    }
    if (lessons) {
      out.push({
        path: path.join(home.dir, 'task', 'references', 'lessons.md'),
        kind: 'text',
        content: lessons,
        role: 'skill-ref',
        agent,
        hunks: [{ checkId: 'LEARN', reason: 'skill-text lessons approved in harness learn review', provenance: lessonNotes(ctx).map((l) => `lesson ${l.id}`).join(', '), contentHash: sha256(lessons) }],
      });
    }
  }
  return out;
}
