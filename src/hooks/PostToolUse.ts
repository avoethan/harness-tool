/**
 * PostToolUse hook (DESIGN §2.4, §2.10). Never blocks; findings become a
 * short additionalContext note.
 *
 *  (a) edit log: every edit (file tools of all three agents, apply_patch
 *      bodies, shell commands that visibly write) is appended to the
 *      session state with its repo id (./editlog.ts);
 *  (b) file-scoped lint on each edited file (at most three per call): the
 *      repo's own Prettier check, ESLint, and tsqllint/sqlfluff for `.sql`
 *      (./lint.ts), all within 18 s;
 *  (c) the ledger's file-scoped checks on that file through
 *      `runLedgerChecks` when discovery provides it (./standards.ts);
 *  (d) a note of at most 20 lines with each lint failure and the violated
 *      standard's statement and fix text, once per (session, repo, rule);
 *  (e) after `git add` / `git commit -a`, the staging check names any staged
 *      path the commit guard would refuse (./staging.ts).
 *
 * Instrumentation: tool name and counts only.
 */
import type { HookInput, HookResult, LedgerRecord } from '../types';
import type { HookContext } from '../hook';
import { isFile } from '../lib/fsx';
import { instrument } from '../lib/log';
import { markInjected, updateSession, type SessionNote } from '../lib/session';
import { capLines, failOpen, oneLine, relTo } from './common';
import { editsOf, isFileEditTool, isShellTool, recordEdits, type EditHit } from './editlog';
import { lintFile, type LintFinding, type LintRun } from './lint';
import { stagingCheck, stagingWarning } from './staging';
import { externalLedgerChecks, loadLedger, recordForFinding, recordsFor, standardLine, type LedgerCheckFinding } from './standards';

const MAX_LINT_FILES = 3;
const MAX_NOTE_LINES = 20;
const MAX_SESSION_NOTES = 50;
const LINT_TOTAL_MS = 18_000;

interface NoteItem {
  /** The id used for once-per-(session, repo, rule): a ledger id, `<tool>:<rule>`, or `<tool>:<status>`. */
  id: string;
  lines: string[];
  /** A real failure (kept for the pause trail), as opposed to an availability notice. */
  failure: boolean;
}

function findingItems(runs: LintRun[], records: LedgerRecord[], ledgerHits: LedgerCheckFinding[]): NoteItem[] {
  const items = new Map<string, { id: string; found: string[]; more: number; failure: boolean; std: LedgerRecord | null }>();
  const add = (rawId: string, line: string, failure: boolean, std: LedgerRecord | null = null) => {
    // Ids land in the session state, whose writer refuses hidden Unicode: keep them plain.
    const id = oneLine(rawId, 120);
    const it = items.get(id) ?? { id, found: [], more: 0, failure, std };
    items.set(id, it);
    if (it.found.length < 2) it.found.push(line);
    else it.more++;
  };
  for (const run of runs) {
    if (run.status === 'fail') {
      const errors = run.findings.filter((f: LintFinding) => f.severity === 'error');
      for (const f of errors) {
        const rec = recordForFinding(f, records);
        const where = f.line ? ` (line ${f.line})` : '';
        add(rec ? rec.id : `${f.tool}:${f.rule}`, `- ${f.tool} ${f.rule}${where}: ${f.message}`, true, rec);
      }
    } else if (run.status !== 'ok' && run.note) {
      add(`${run.tool}:${run.status}`, `- ${run.tool}: ${oneLine(run.note, 200)}`, false);
    }
  }
  for (const h of ledgerHits) {
    const rec = records.find((r) => r.id === h.ruleId) ?? null;
    const where = h.line ? ` (line ${h.line})` : '';
    const text = rec ? standardLine(rec) : oneLine(h.message ?? '', 200);
    add(h.ruleId, `- standard ${h.ruleId}${where}: ${text}`, true);
  }
  return [...items.values()].map((it) => ({
    id: it.id,
    failure: it.failure,
    lines: [...it.found, ...(it.more ? [`  (+${it.more} more of the same)`] : []), ...(it.std ? [`  Standard ${it.std.id}: ${standardLine(it.std)}`] : [])],
  }));
}

async function ledgerChecks(e: EditHit, records: LedgerRecord[], timeoutMs: number): Promise<LedgerCheckFinding[]> {
  const run = externalLedgerChecks();
  if (!run || !records.length || timeoutMs < 500) return [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      Promise.resolve(run({ repoRoot: e.root, repoId: e.id, files: [e.path], records, timeoutMs, scope: 'file' })),
      new Promise<LedgerCheckFinding[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeoutMs);
      }),
    ]);
    return Array.isArray(res) ? res.filter((h) => h && typeof h.ruleId === 'string') : [];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, async () => {
    const started = Date.now();
    const name = String(input.tool_name ?? '');
    const ti = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
    const command = typeof ti.command === 'string' ? ti.command : '';
    const shell = !isFileEditTool(name) && (isShellTool(name) || !!command);

    const edits = editsOf(input);
    recordEdits(ctx.sessionId, ctx, edits, shell);

    const sections: string[][] = [];
    const counts = { edits: edits.length, linted: 0, findings: 0, injected: 0, suppressed: 0, staged: 0, ledgerHits: 0 };

    // (b)-(d) lint and ledger checks on the edited files.
    const targets = edits.filter((e) => e.via !== 'shell' && isFile(e.path)).slice(0, MAX_LINT_FILES);
    const ledger = targets.length ? loadLedger() : null;
    const notes: SessionNote[] = [];
    for (const e of targets) {
      const budget = LINT_TOTAL_MS - (Date.now() - started);
      if (budget < 1000) break;
      const rel = oneLine(relTo(e.root, e.path), 300);
      const runs = await lintFile(e.path, e.root, { budgetMs: budget - 500 });
      counts.linted++;
      const records = recordsFor(ledger, e.id, rel);
      const hits = await ledgerChecks(e, records, Math.min(5000, LINT_TOTAL_MS - (Date.now() - started) - 300));
      counts.ledgerHits += hits.length;
      const items = findingItems(runs, records, hits);
      counts.findings += items.filter((i) => i.failure).length;
      if (!items.length) continue;
      const fresh = new Set(markInjected(ctx.sessionId, e.id, items.map((i) => i.id), ctx.agent));
      const show = items.filter((i) => fresh.has(i.id));
      counts.injected += show.length;
      counts.suppressed += items.length - show.length;
      for (const i of items) if (i.failure) notes.push({ repo: e.id, rule: i.id, file: rel, ts: new Date().toISOString() });
      if (show.length) sections.push([`harness lint feedback for ${rel} (${e.name}); fix before moving on:`, ...show.flatMap((i) => i.lines)]);
    }
    if (notes.length) {
      updateSession(
        ctx.sessionId,
        (s) => {
          s.notes = [...(s.notes ?? []), ...notes].slice(-MAX_SESSION_NOTES);
        },
        ctx.agent,
      );
    }

    // (e) staging check after git add / git commit -a.
    if (shell && command && /\bgit\b/.test(command) && /\b(add|commit)\b/.test(command)) {
      const results = stagingCheck(input, ctx, command);
      counts.staged = results.reduce((n, r) => n + r.offending.length, 0);
      const warn = stagingWarning(results);
      if (warn) sections.unshift(warn.split('\n'));
    }

    instrument({ event: 'post.tool', sessionId: ctx.sessionId, agent: ctx.agent, ids: { tool: oneLine(name, 60) }, counts: { ...counts, ms: Date.now() - started } });
    if (!sections.length) return { exitCode: 0 };
    const lines = capLines(sections.flatMap((s, i) => (i ? ['', ...s] : s)), MAX_NOTE_LINES);
    return { exitCode: 0, additionalContext: lines.join('\n') };
  });
}
