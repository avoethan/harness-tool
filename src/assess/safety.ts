/**
 * Safety-rule inventory (hard rule 7, DESIGN 2.1): the rules a codebase
 * already has, collected so later steps can promote them to hard blocks and
 * never remove them (apply unions, never narrows).
 *
 * - deny and ask permission rules in every agent config (Claude settings,
 *   Devin config.json, Codex `.rules` prefix rules);
 * - git hooks tracked in the repos (.husky/*, .githooks/*, lefthook,
 *   simple-git-hooks, pre-commit);
 * - CI jobs that look required (name contains test/lint/typecheck/build/check);
 *   branch protection cannot be read offline, and the report says so;
 * - safety-looking "never / do not / must not / always" sentences in agent
 *   files, CONTRIBUTING* and README*.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryParseJsonc } from '../lib/jsonc';
import { readTextOr } from '../lib/fsx';
import { parseMarkdown, sentences, unitText } from './markdown';
import { escapeForReport } from './scan';
import { otherCiJobs, trackedAmong } from './project';
import { displayPath } from './inventory';
import type { SafetyRule } from '../types';
import type { AssessContext, InvFile } from './model';
import { PROSE_KINDS } from './model';

const POLARITY = /\b(never|do\s+not|don'?t|must\s+not|mustn'?t|should\s+not|shouldn'?t|may\s+not|cannot|can'?t|always|not\s+allowed|forbidden|prohibited|only)\b/i;

const SAFETY_TOPICS: Array<{ topic: string; re: RegExp }> = [
  { topic: 'production', re: /\b(production|prod|live (system|data|database|environment))\b/i },
  { topic: 'database', re: /\b(drop\s+table|truncate(\s+table)?|delete\s+from|migrations?|(test|shared|live|real|customer|staging|other)\s+(databases?|dbs?)|(databases?|dbs?)\s+(server|credentials|dumps?|backups?|allowlist))\b/i },
  { topic: 'secrets', re: /\b(secrets?|credentials?|passwords?|tokens?|api[ -]?keys?|private\s+keys?|ssh\s+keys?|\.env\b|key\s+material)/i },
  { topic: 'history', re: /\b(force[- ]push|push\s+(-f|--force)|--force-with-lease|rewrite\s+(the\s+)?(git\s+)?history|reset\s+--hard|rebase\s+(main|master))\b/i },
  { topic: 'protected-branch', re: /\b(push|commit|merge)\w*\b[^.]*\b(main|master|default\s+branch|release\s+branch)\b/i },
  { topic: 'destructive', re: /\b(rm\s+-rf|wipe|destroy|delete|remove)\b[^.]*\b(data|files?|branch(es)?|tables?|buckets?|volumes?|records?|users?|accounts?|backups?)\b/i },
  { topic: 'release', re: /\b(deploy|release|publish)\w*\b/i },
  { topic: 'personal-data', re: /\b(pii|personal\s+data|customer\s+data|user\s+data|gdpr)\b/i },
  { topic: 'bypass', re: /(--no-verify|\bskip\s+(the\s+)?(hooks?|ci|checks?)\b|\bbypass\b|\bdisable\s+(the\s+)?(hooks?|checks?|ci|lint|tests?)\b)/i },
  { topic: 'payments', re: /\b(payments?|billing|refunds?)\b/i },
  { topic: 'privilege', re: /\bsudo\b/i },
];

/** The safety topic of a sentence that states a rule (never/always/...), or null. */
export function safetyTopic(sentence: string): string | null {
  if (!POLARITY.test(sentence)) return null;
  for (const t of SAFETY_TOPICS) if (t.re.test(sentence)) return t.topic;
  return null;
}

function pushUnique(ctx: AssessContext, r: SafetyRule): void {
  if (ctx.safety.some((x) => x.source === r.source && x.kind === r.kind && x.text === r.text && x.line === r.line)) return;
  ctx.safety.push(r);
}

/** Safety sentences of a markdown text: one record per sentence, with its line. */
export function safetySentences(text: string): Array<{ line: number; text: string; topic: string }> {
  const out: Array<{ line: number; text: string; topic: string }> = [];
  const doc = parseMarkdown(text);
  for (const u of doc.units) {
    if (!['paragraph', 'list-item', 'table-row'].includes(u.kind)) continue;
    const ss = sentences(unitText(u), { semicolons: false });
    for (const s of ss) {
      const topic = safetyTopic(s);
      if (!topic) continue;
      // the line inside the unit where the sentence starts
      const probe = s.slice(0, 24).replace(/[`*_]/g, '');
      let line = u.start;
      for (let i = 0; i < u.lines.length; i++) {
        if (u.lines[i].replace(/[`*_]/g, '').includes(probe.slice(0, 12))) {
          line = u.start + i;
          break;
        }
      }
      out.push({ line, text: s, topic });
    }
  }
  return out;
}

function permissionRules(ctx: AssessContext, f: InvFile): void {
  const r = tryParseJsonc<Record<string, unknown>>(f.text);
  if (!r.ok || !r.value || typeof r.value !== 'object') return;
  const perms = (r.value as Record<string, unknown>).permissions;
  if (!perms || typeof perms !== 'object') return;
  for (const [key, kind] of [
    ['deny', 'deny-rule'],
    ['ask', 'ask-rule'],
  ] as const) {
    const list = (perms as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const idx = f.text.indexOf(JSON.stringify(item).slice(1, -1));
      const line = idx >= 0 ? f.text.slice(0, idx).split('\n').length : undefined;
      pushUnique(ctx, { source: f.abs, kind, text: escapeForReport(item, 400), line });
    }
  }
}

/** Codex `.rules` files: `prefix_rule(pattern = [...], decision = "forbidden" | "prompt" | "allow")`. */
export function codexPrefixRules(text: string): Array<{ line: number; pattern: string[]; decision: string }> {
  const out: Array<{ line: number; pattern: string[]; decision: string }> = [];
  const re = /prefix_rule\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (let i = end; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = text.slice(m.index, end + 1);
    const pat = /pattern\s*=\s*\[([\s\S]*?)\]/.exec(body);
    const dec = /decision\s*=\s*["'](\w+)["']/.exec(body);
    const pattern = pat ? [...pat[1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]) : [];
    out.push({ line: text.slice(0, m.index).split('\n').length, pattern, decision: dec ? dec[1] : 'allow' });
  }
  return out;
}

function hookSummary(source: string, text: string): string {
  const base = source.split(/[\\/#]/).pop() ?? source;
  const cmds = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^(\.\s|#!\/|set -|\. "\$\(dirname)/.test(l));
  return escapeForReport(`${base}: ${cmds.slice(0, 3).join(' ; ')}`, 300);
}

export function collectSafety(ctx: AssessContext): void {
  // 1. permission rules (all three dialects)
  for (const f of ctx.files) {
    const base = path.basename(f.abs);
    if (f.kind === 'settings' && /\.json$/.test(base)) permissionRules(ctx, f);
    if (f.kind === 'codex-rules') {
      for (const r of codexPrefixRules(f.text)) {
        if (r.decision === 'forbidden') pushUnique(ctx, { source: f.abs, kind: 'deny-rule', text: escapeForReport(`${r.pattern.join(' ')} (forbidden)`, 300), line: r.line });
        else if (r.decision === 'prompt') pushUnique(ctx, { source: f.abs, kind: 'ask-rule', text: escapeForReport(`${r.pattern.join(' ')} (prompt)`, 300), line: r.line });
      }
    }
  }
  // 2. git hooks tracked in the repos, 3. CI jobs that look required
  for (const repo of ctx.repos) {
    const rels = repo.gitHooks.map((h) => path.relative(repo.root, h.abs).replace(/\\/g, '/'));
    const tracked = trackedAmong(repo.root, [...new Set(rels)]);
    repo.gitHooks.forEach((h, i) => {
      if (tracked && !tracked.has(rels[i])) return; // present but not tracked
      pushUnique(ctx, { source: h.abs + (h.source.includes('#') ? '#' + h.source.split('#')[1] : ''), kind: 'git-hook', text: hookSummary(h.source, h.text) });
    });
    if (!tracked && repo.gitHooks.length) ctx.notes.push(`${displayPath(ctx, repo.root)} is not a git repository here, so its hook files were listed without checking that git tracks them`);
    for (const wf of repo.workflows) {
      for (const j of wf.jobs) {
        if (/test|lint|typecheck|type-check|build|check/i.test(`${j.id} ${j.name}`)) pushUnique(ctx, { source: wf.file, kind: 'ci-required', text: escapeForReport(`job "${j.name}" looks required`, 200), line: j.line });
      }
    }
    for (const j of otherCiJobs(repo.root)) {
      if (/test|lint|typecheck|type-check|build|check/i.test(j.name)) pushUnique(ctx, { source: j.file, kind: 'ci-required', text: escapeForReport(`job "${j.name}" looks required`, 200), line: j.line });
    }
  }
  if (ctx.safety.some((r) => r.kind === 'ci-required')) ctx.notes.push('Branch protection (which CI jobs are really required) cannot be read offline; the CI jobs listed are the ones whose names look required.');
  // 4. safety sentences in agent files, CONTRIBUTING* and README*
  for (const f of ctx.files) {
    if (!PROSE_KINDS.has(f.kind) || f.binary) continue;
    for (const s of safetySentences(f.text)) pushUnique(ctx, { source: f.abs, kind: 'never-sentence', text: escapeForReport(s.text, 400), line: s.line });
  }
  for (const doc of docFiles(ctx, /^(CONTRIBUTING|README)[^/]*\.(md|markdown|txt|rst)$/i)) {
    const text = readTextOr(doc, '') ?? '';
    for (const s of safetySentences(text)) pushUnique(ctx, { source: doc, kind: 'never-sentence', text: escapeForReport(s.text, 400), line: s.line });
  }
}

/**
 * Documentation files at the workspace root, each repo root and `.github/`
 * whose name matches; with `docsMarkdown`, also every `.md` directly in `docs/`.
 */
export function docFiles(ctx: AssessContext, nameRe: RegExp, docsMarkdown = false): string[] {
  const dirs = new Set<string>([ctx.workspace, ...ctx.repos.map((r) => r.root)]);
  const out: string[] = [];
  for (const d of dirs) {
    for (const sub of ['', '.github', 'docs']) {
      const dir = path.join(d, sub);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names.sort()) {
        const p = path.join(dir, n);
        const wanted = nameRe.test(n) || (docsMarkdown && sub === 'docs' && /\.md$/i.test(n));
        try {
          if (wanted && fs.statSync(p).isFile()) out.push(p);
        } catch {
          /* vanished */
        }
      }
    }
  }
  return [...new Set(out)];
}
