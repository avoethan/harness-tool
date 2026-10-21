/**
 * What each agent loads at session start, in bytes and lines, against its
 * limit (R-40), and the R09 oversized-always-on findings.
 *
 * - Claude Code: per-file guidance of about 200 lines (a CLAUDE.md plus its
 *   `@` imports counts as one), 4 MiB hard cap.
 * - Codex: the project chain (git root down to the cwd) shares a 32 KiB
 *   budget (`project_doc_max_bytes`); the file that crosses it is cut and the
 *   files after it are dropped. The global file sits outside the budget.
 * - Devin Local: 16 KiB per always-on file, measured on Devin CLI 3000.11.92
 *   (the first 16,384 bytes are loaded; the model is told the rest was cut); the
 *   figure measured on the CLI, and the report says so.
 *   Devin's effective set is everything it loads once every sub-repo has
 *   been touched (launch plus lazily loaded rule files).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeSpans, parseMarkdown, fenceLines } from './markdown';
import { better, claudeLoadInSession, codexChain, codexLoadInSession, displayPath, limitFor } from './inventory';
import { decode } from './scan';
import { sha256 } from '../lib/hash';
import type { AgentId, AssessFinding, AssessLoadDetail, AssessLoadSession, AssessReport } from '../types';
import type { AssessContext, InvFile, Session } from './model';

export const CLAUDE_LINE_GUIDANCE = 200;
export const CLAUDE_HARD_CAP = 4 * 1024 * 1024;
export const CODEX_BUDGET = 32 * 1024;
export const DEVIN_YARDSTICK = 16 * 1024;
/** Above this, the report offers Devin's read_config_from toggles for imported third-party files. */
const IMPORT_NOTE_BYTES = 8 * 1024;

const IMPORT_RE = /(^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_.\-/]*[A-Za-z0-9_\-]\.[A-Za-z0-9]+)\b/g;

/** Find `@path` imports in CLAUDE.md-family files (and Cursor rules), outside code. */
export function findImports(ctx: AssessContext): void {
  const queue: InvFile[] = ctx.files.filter(isImporter);
  const done = new Set<string>();
  while (queue.length) {
    const f = queue.shift()!;
    if (done.has(f.abs)) continue;
    done.add(f.abs);
    const doc = parseMarkdown(f.text);
    const inFence = fenceLines(doc);
    doc.lines.forEach((line, idx) => {
      const n = idx + 1;
      if (inFence.has(n)) return;
      const spans = codeSpans(line);
      let m: RegExpExecArray | null;
      const re = new RegExp(IMPORT_RE.source, 'g');
      while ((m = re.exec(line))) {
        const at = m.index + m[1].length;
        if (spans.some((s) => at >= s.index && at < s.index + s.text.length + 2)) continue;
        const target = m[2];
        const abs = target.startsWith('~/') ? path.join(ctx.userHome, target.slice(2)) : path.isAbsolute(target) ? target : path.resolve(path.dirname(f.abs), target);
        const exists = fs.existsSync(abs);
        ctx.imports.push({ from: f, line: n, target, abs, exists });
        if (!exists) continue;
        let imported = ctx.files.find((x) => path.resolve(x.abs) === path.resolve(abs));
        if (!imported) {
          const buf = fs.readFileSync(abs);
          const { text, binary } = decode(buf);
          imported = {
            abs,
            display: displayPath(ctx, abs),
            level: f.level,
            repoRoot: f.repoRoot,
            kind: 'instructions',
            label: `imported by ${f.display}`,
            loads: { devin: { when: 'never', note: 'not on Devin\'s load path' }, claude: { when: 'never', note: '' }, codex: { when: 'never', note: 'not on Codex\'s load path' } },
            limit: '',
            bytes: buf.length,
            lines: text === '' ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0),
            sha256: sha256(buf),
            text,
            binary,
          };
          ctx.files.push(imported);
        }
        if (f.loads.claude.when !== 'never') {
          imported.loads.claude = better(imported.loads.claude, { when: f.loads.claude.when, note: `imported by ${f.display} (@${target})` });
          imported.limit = limitFor(imported);
        }
        if (/\.md$/i.test(abs)) queue.push(imported);
      }
    });
  }
}

function isImporter(f: InvFile): boolean {
  const base = path.basename(f.abs);
  if (f.kind === 'instructions' && (base === 'CLAUDE.md' || base === 'CLAUDE.local.md')) return true;
  if (f.kind === 'rule' && /[\\/]\.cursor[\\/]rules[\\/]/.test(f.abs)) return true;
  return /^imported by /.test(f.label ?? '');
}

function importsOf(ctx: AssessContext, f: InvFile, seen = new Set<string>()): InvFile[] {
  const out: InvFile[] = [];
  for (const imp of ctx.imports) {
    if (imp.from !== f || !imp.exists) continue;
    const t = ctx.files.find((x) => path.resolve(x.abs) === path.resolve(imp.abs));
    if (!t || seen.has(t.abs)) continue;
    seen.add(t.abs);
    out.push(t, ...importsOf(ctx, t, seen));
  }
  return out;
}

const PROSE = new Set(['instructions', 'rule', 'legacy']);

function sessionLabel(ctx: AssessContext, s: Session): string {
  return displayPath(ctx, s.cwd);
}

function linesInPrefix(text: string, bytes: number): number {
  const buf = Buffer.from(text, 'utf8').subarray(0, bytes);
  return buf.toString('utf8').split('\n').length;
}

export function computeLoaded(ctx: AssessContext): { loaded: AssessReport['loaded']; detail: Partial<Record<AgentId, AssessLoadDetail>>; findings: AssessFinding[] } {
  const loaded: AssessReport['loaded'] = {};
  const detail: Partial<Record<AgentId, AssessLoadDetail>> = {};
  const findings: AssessFinding[] = [];
  const root = ctx.sessions.find((s) => s.isWorkspaceRoot) ?? ctx.sessions[0];
  const flagged = new Set<string>();

  if (ctx.agents.includes('claude')) {
    const sessions: AssessLoadSession[] = [];
    for (const s of ctx.sessions) {
      const base = ctx.files.filter((f) => PROSE.has(f.kind) && claudeLoadInSession(ctx, f, s).when === 'launch');
      const all = new Map<string, InvFile>();
      for (const f of base) {
        all.set(f.abs, f);
        for (const i of importsOf(ctx, f)) all.set(i.abs, i);
      }
      const files = [...all.values()];
      const over: string[] = [];
      for (const f of base) {
        const total = f.lines + importsOf(ctx, f).reduce((a, i) => a + i.lines, 0);
        if (total > CLAUDE_LINE_GUIDANCE) {
          over.push(f.display);
          if (!flagged.has('claude:' + f.abs)) {
            flagged.add('claude:' + f.abs);
            findings.push({ check: 'R09', severity: 'warn', file: f.abs, agent: 'claude', message: `Claude Code loads ${f.display} at launch with ${total} lines${total !== f.lines ? ' including its imports' : ''}; the guidance is under ${CLAUDE_LINE_GUIDANCE} lines per file.`, evidence: `${total} lines` });
          }
        }
      }
      const bytes = files.reduce((a, f) => a + f.bytes, 0);
      if (bytes > CLAUDE_HARD_CAP) over.push(`total ${bytes} bytes over the 4 MiB cap`);
      sessions.push({ cwd: sessionLabel(ctx, s), bytes, lines: files.reduce((a, f) => a + f.lines, 0), files: files.map((f) => f.display), overLimit: over });
    }
    detail.claude = { limit: CLAUDE_HARD_CAP, limitNote: `about ${CLAUDE_LINE_GUIDANCE} lines per file (guidance); 4 MiB hard cap`, sessions };
    const r = sessions[ctx.sessions.indexOf(root)];
    loaded.claude = { bytes: r.bytes, lines: r.lines, files: r.files, limit: CLAUDE_HARD_CAP };
  }

  if (ctx.agents.includes('codex')) {
    const sessions: AssessLoadSession[] = [];
    for (const s of ctx.sessions) {
      const launch = ctx.files.filter((f) => PROSE.has(f.kind) && codexLoadInSession(ctx, f, s).when === 'launch');
      const global = launch.filter((f) => f.level === 'user');
      const chainDirs = codexChain(ctx, s);
      const chain = launch.filter((f) => f.level !== 'user').sort((a, b) => chainDirs.indexOf(path.dirname(a.abs)) - chainDirs.indexOf(path.dirname(b.abs)));
      let used = 0;
      let truncated: string | undefined;
      const dropped: string[] = [];
      let lines = global.reduce((a, f) => a + f.lines, 0);
      const files = global.map((f) => f.display);
      for (const f of chain) {
        if (used >= ctx.codexBudget) {
          dropped.push(f.display);
          continue;
        }
        if (used + f.bytes > ctx.codexBudget) {
          const keep = ctx.codexBudget - used;
          truncated = f.display;
          lines += linesInPrefix(f.text, keep);
          used = ctx.codexBudget;
          files.push(f.display);
          continue;
        }
        used += f.bytes;
        lines += f.lines;
        files.push(f.display);
      }
      const over: string[] = [];
      if (truncated) over.push(truncated);
      over.push(...dropped);
      if (truncated || dropped.length) {
        const key = `codex:${truncated ?? ''}:${dropped.join(',')}`;
        if (!flagged.has(key)) {
          flagged.add(key);
          const first = chain.find((f) => f.display === truncated) ?? chain.find((f) => f.display === dropped[0]) ?? chain[0];
          findings.push({ check: 'R09', severity: 'warn', file: first.abs, agent: 'codex', message: `In a Codex session started in ${sessionLabel(ctx, s)}, the AGENTS.md chain is ${chain.reduce((a, f) => a + f.bytes, 0)} bytes, over the ${ctx.codexBudget}-byte budget: ${truncated ? `${truncated} is cut` : ''}${truncated && dropped.length ? ' and ' : ''}${dropped.length ? `${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} dropped` : ''}.`, evidence: `${chain.length} files in the chain` });
        }
      }
      sessions.push({ cwd: sessionLabel(ctx, s), bytes: global.reduce((a, f) => a + f.bytes, 0) + used, lines, files, overLimit: over, truncated, dropped: dropped.length ? dropped : undefined });
    }
    detail.codex = { limit: ctx.codexBudget, limitNote: `${ctx.codexBudget} bytes over the project AGENTS.md chain (git root down to the working folder); the global ~/.codex file is outside it${root && !root.gitRoot ? '; a folder without .git loads only its own AGENTS.md, and codex exec needs --skip-git-repo-check there' : ''}`, sessions };
    const r = sessions[ctx.sessions.indexOf(root)];
    loaded.codex = { bytes: r.bytes, lines: r.lines, files: r.files, limit: ctx.codexBudget };
  }

  if (ctx.agents.includes('devin')) {
    const launch = ctx.files.filter((f) => PROSE.has(f.kind) && f.loads.devin.when === 'launch');
    const lazy = ctx.files.filter((f) => PROSE.has(f.kind) && f.loads.devin.when === 'lazy');
    const over: string[] = [];
    for (const f of [...launch, ...lazy]) {
      if (f.bytes > DEVIN_YARDSTICK) {
        over.push(f.display);
        findings.push({ check: 'R09', severity: 'warn', file: f.abs, agent: 'devin', message: `${f.display} is ${f.bytes} bytes; Devin loads only the first 16,384 bytes of an always-on file (measured on Devin CLI 3000.11.92, 2026-10-20; the same 16 KiB is documented for the cloud agent) and tells the model the rest was cut, so keep always-on files under that.`, evidence: `${f.bytes} bytes` });
      }
    }
    const session: AssessLoadSession = { cwd: sessionLabel(ctx, root), bytes: launch.reduce((a, f) => a + f.bytes, 0), lines: launch.reduce((a, f) => a + f.lines, 0), files: launch.map((f) => f.display), overLimit: over };
    const eff = [...launch, ...lazy];
    // Third-party material Devin imports by default (read_config_from): offer the toggle when it is large.
    const imported = ctx.files.filter((f) => f.loads.devin.when !== 'never' && /read_config_from\.(claude|cursor)/.test(f.loads.devin.note) && (PROSE.has(f.kind) || f.kind === 'skill'));
    const importedBytes = imported.reduce((a, f) => a + f.bytes, 0);
    const toggleNote = importedBytes > IMPORT_NOTE_BYTES ? `; Devin imports ${importedBytes} bytes of Claude Code / Cursor material by default (${imported.length} files): read_config_from.claude / .cursor = false in ~/.config/devin/config.json turns that off` : '';
    detail.devin = {
      limit: DEVIN_YARDSTICK,
      limitNote: `16 KiB per always-on file: Devin CLI 3000.11.92 loads the first 16,384 bytes of an always-on file and tells the model the rest was cut (measured 2026-10-20; the same 16 KiB is documented for the cloud agent)${toggleNote}`,
      sessions: [session],
      effective: { bytes: eff.reduce((a, f) => a + f.bytes, 0), lines: eff.reduce((a, f) => a + f.lines, 0), files: eff.map((f) => f.display) },
    };
    loaded.devin = { bytes: session.bytes, lines: session.lines, files: session.files, limit: DEVIN_YARDSTICK };
  }
  return { loaded, detail, findings };
}
