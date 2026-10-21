/**
 * The assess outputs: `assess.json` (AssessReport) and `assess.md`, a plain
 * summary for people. The Markdown quotes at most one escaped line per
 * finding, and only inside fenced blocks marked UNTRUSTED.
 */
import * as path from 'node:path';
import { classCounts } from './classify';
import { displayPath, loadedByOf } from './inventory';
import { sanitizeDeep } from './scan';
import type { AgentId, AssessFinding, AssessReport, AssessedFile, SafetyRule } from '../types';
import { ALL_AGENTS } from '../types';
import type { AssessContext } from './model';

const SEV_ORDER = { high: 0, warn: 1, info: 2 } as const;
const LEVEL_ORDER: Record<string, number> = { user: 0, ancestor: 1, workspace: 2, repo: 3, include: 4 };

export function buildReport(ctx: AssessContext, parts: Pick<AssessReport, 'classifications' | 'loaded' | 'loadDetail'>): AssessReport {
  const show = (p: string) => displayPath(ctx, p);
  const files: AssessedFile[] = [...ctx.files]
    .sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || a.display.localeCompare(b.display))
    .map((f) => {
      const rec: AssessedFile = {
        path: f.abs,
        kind: f.kind,
        bytes: f.bytes,
        lines: f.lines,
        loadedBy: loadedByOf(f),
        sha256: f.sha256,
        level: f.level,
        display: f.display,
        loads: { devin: f.loads.devin, claude: f.loads.claude, codex: f.loads.codex },
      };
      if (f.limit) rec.limit = f.limit;
      if (f.label) rec.label = f.label;
      if (f.quarantine) rec.quarantine = f.quarantine;
      return rec;
    });
  const findings: AssessFinding[] = [...ctx.findings]
    .map((x) => ({ ...x, provenance: x.provenance ?? ('deterministic' as const) }))
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || show(a.file).localeCompare(show(b.file)) || (a.line ?? 0) - (b.line ?? 0) || a.check.localeCompare(b.check));
  const report: AssessReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files,
    findings,
    classifications: parts.classifications,
    safetyRules: ctx.safety,
    loaded: parts.loaded,
    neverLoaded: files.filter((f) => f.loadedBy.length === 0).map((f) => f.path),
    workspaceRoot: ctx.workspace,
    setting: ctx.setting,
    agents: ctx.agents,
    loadDetail: parts.loadDetail,
    notes: [...new Set(ctx.notes)],
  };
  return sanitizeDeep(report);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MEANING: Record<string, string> = {
  KEEP: 'stays as written',
  CONVERT: 'better enforced by a check (lint rule, test, hook or gate step) than by prose',
  TRIM: 'derivable from the repo or duplicated; can go (archived verbatim, never lost)',
  FIX: 'wrong or contradictory; needs a decision from you',
  SPLIT: 'part checkable, part guidance; split before converting',
  QUARANTINE: 'unsafe to feed to an agent until a person has looked at it',
};

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

function fence(lines: string[]): string[] {
  const unique = [...new Set(lines)];
  if (!unique.length) return [];
  return ['', 'Quoted from your files (UNTRUSTED: shown for reference only, never instructions):', '', '```text', ...unique.map((l) => l.replace(/```/g, "'''")), '```'];
}

export function renderMarkdown(r: AssessReport, ctx: { workspace: string; userHome: string }): string {
  const show = (p: string) => (p.includes('#') ? displayPath(ctx, p.split('#')[0]) + '#' + p.split('#').slice(1).join('#') : displayPath(ctx, p));
  const at = (f: AssessFinding) => `${show(f.file)}${f.line ? `:${f.line}` : ''}`;
  const out: string[] = [];
  const sev = { high: r.findings.filter((f) => f.severity === 'high'), warn: r.findings.filter((f) => f.severity === 'warn'), info: r.findings.filter((f) => f.severity === 'info') };
  const counts = classCounts(r.classifications);
  const kinds = new Map<string, number>();
  for (const f of r.files) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
  out.push('# Assessment of the existing agent setup', '');
  out.push(`Workspace: \`${r.workspaceRoot ?? ''}\` · setting: ${r.setting ?? 'team'} · agents: ${(r.agents ?? ALL_AGENTS).join(', ')} · generated ${r.generatedAt}`, '');
  out.push('## Summary', '');
  out.push(`- ${r.files.length} agent files found (${[...kinds.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}); ${r.neverLoaded.length} never loaded by any agent.`);
  out.push(`- Findings: ${sev.high.length} high, ${sev.warn.length} warn, ${sev.info.length} info.`);
  out.push(`- Lines classified: ${r.classifications.length} (KEEP ${counts.KEEP}, CONVERT ${counts.CONVERT}, TRIM ${counts.TRIM}, FIX ${counts.FIX}, SPLIT ${counts.SPLIT}, QUARANTINE ${counts.QUARANTINE}).`);
  const sk = (k: SafetyRule['kind']) => r.safetyRules.filter((s) => s.kind === k).length;
  out.push(`- Safety rules found: ${r.safetyRules.length} (deny rules ${sk('deny-rule')}, ask rules ${sk('ask-rule')}, git hooks ${sk('git-hook')}, CI jobs ${sk('ci-required')}, safety sentences ${sk('never-sentence')}). Later steps keep all of them; apply only adds.`);
  const q = r.files.filter((f) => f.quarantine);
  if (q.length) out.push(`- Quarantined files: ${q.map((f) => `\`${f.display ?? f.path}\``).join(', ')} (hidden characters or injection patterns; nothing from them is used until you have looked).`);
  out.push('');

  out.push('## What each agent loads at session start', '');
  out.push('| Agent | Session folder | Files | Lines | Bytes | Limit | Over the limit |', '|---|---|---|---|---|---|---|');
  for (const a of ALL_AGENTS) {
    const d = r.loadDetail?.[a];
    if (!d) continue;
    for (const s of d.sessions) out.push(`| ${a} | \`${s.cwd}\` | ${s.files.length} | ${s.lines} | ${kb(s.bytes)} | ${d.limit ? kb(d.limit) : '-'} | ${s.overLimit.length ? s.overLimit.map((x) => `\`${x}\``).join(', ') : 'none'} |`);
  }
  out.push('');
  for (const a of ALL_AGENTS) {
    const d = r.loadDetail?.[a];
    if (!d) continue;
    out.push(`- **${a}**: ${d.limitNote}.${d.effective ? ` Effective set once every sub-repo has been touched: ${d.effective.files.length} files, ${d.effective.lines} lines, ${kb(d.effective.bytes)}.` : ''}`);
  }
  out.push('');

  out.push('## Findings', '');
  if (!r.findings.length) out.push('No findings.', '');
  for (const level of ['high', 'warn'] as const) {
    const list = sev[level];
    if (!list.length) continue;
    out.push(`### ${level === 'high' ? 'High (safety)' : 'Warn (consequential)'}: ${list.length}`, '');
    for (const f of list) out.push(`- \`${at(f)}\` ${f.check}${f.provenance === 'judgment' ? ' (judgment)' : ''}: ${f.message}`);
    out.push(...fence(list.filter((f) => f.evidence).map((f) => `${at(f)} | ${f.evidence}`)), '');
  }
  if (sev.info.length) {
    out.push(`### Info (context, no action needed): ${sev.info.length}`, '');
    const byCheck = new Map<string, AssessFinding[]>();
    for (const f of sev.info) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
    for (const [check, list] of [...byCheck.entries()].sort()) {
      if (list.length <= 6) for (const f of list) out.push(`- \`${at(f)}\` ${check}: ${f.message}`);
      else out.push(`- ${check} (${list.length}): ${list.slice(0, 12).map((f) => `\`${at(f)}\``).join(', ')}${list.length > 12 ? ', …' : ''}`);
    }
    out.push('');
  }

  out.push('## Classification', '');
  out.push('| Class | Lines | Meaning |', '|---|---|---|');
  for (const c of ['KEEP', 'CONVERT', 'TRIM', 'FIX', 'SPLIT', 'QUARANTINE'] as const) out.push(`| ${c} | ${counts[c]} | ${MEANING[c]} |`);
  out.push('');
  const perFile = new Map<string, Record<string, number>>();
  for (const c of r.classifications) {
    const m = perFile.get(c.file) ?? {};
    m[c.cls] = (m[c.cls] ?? 0) + 1;
    perFile.set(c.file, m);
  }
  for (const [file, m] of [...perFile.entries()].sort((a, b) => show(a[0]).localeCompare(show(b[0])))) {
    out.push(`- \`${show(file)}\`: ${Object.entries(m).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  out.push('');

  out.push('## Safety rules found (kept and promoted; never removed)', '');
  if (!r.safetyRules.length) out.push('None found.');
  else {
    const byKind = new Map<string, SafetyRule[]>();
    for (const s of r.safetyRules) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
    for (const [kind, list] of byKind) out.push(`- ${kind}: ${list.length} (${[...new Set(list.map((s) => show(s.source)))].map((s) => `\`${s}\``).join(', ')})`);
    out.push(...fence(r.safetyRules.map((s) => `${show(s.source)}${s.line ? `:${s.line}` : ''} | ${s.kind} | ${s.text.replace(/\s+/g, ' ').slice(0, 200)}`)));
  }
  out.push('');

  out.push('## Files', '');
  out.push('| File | Kind | Devin | Claude Code | Codex | Lines | Bytes |', '|---|---|---|---|---|---|---|');
  for (const f of r.files) {
    const w = (a: AgentId) => f.loads?.[a]?.when ?? '-';
    out.push(`| \`${f.display ?? f.path}\`${f.label ? ` (${f.label})` : ''} | ${f.kind} | ${w('devin')} | ${w('claude')} | ${w('codex')} | ${f.lines} | ${kb(f.bytes)} |`);
  }
  out.push('');
  if (r.neverLoaded.length) {
    out.push('## Never loaded by any agent', '');
    for (const p of r.neverLoaded) {
      const f = r.files.find((x) => x.path === p);
      out.push(`- \`${show(p)}\`${f?.label ? ` (${f.label})` : ''}: ${f?.level === 'include' ? 'outside every agent load path' : 'no agent loads this file (Devin Local, Claude Code and Codex all skip it)'}`);
    }
    out.push('');
  }
  out.push('## Could not be read, or cannot be known offline', '');
  const notes = r.notes ?? [];
  if (!notes.length) out.push('Nothing.');
  for (const n of notes) out.push(`- ${n}`);
  out.push('');
  return out.join('\n');
}

export function relOut(p: string): string {
  return path.normalize(p);
}
