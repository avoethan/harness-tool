/**
 * Pause-safely trail (DESIGN §2.13): `~/.harness/trail/<taskId>.md`, written
 * by the PreCompact / PostCompaction / SessionEnd hooks and printed by the
 * SessionStart hook so a fresh or compacted session can resume.
 *
 * Content: intent (the brief title), progress (from the session edit log),
 * verified state (from evidence.json, marked as needing a re-run: inherited
 * "verified" claims are never trusted, R-16), the next command, gotchas
 * (recent lint and standard notes), and the pause commit when one was made.
 *
 * The header carries machine-readable `key: value` lines (status, repo,
 * task, updated) so readers can filter open trails by workspace without
 * parsing the body. Text is single-line sanitised; hidden Unicode never
 * reaches the file (writeTextAtomic refuses it anyway).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from '../types';
import { readTextOr, writeTextAtomic } from '../lib/fsx';
import { harnessHome, subPath } from '../lib/paths';
import { stripHiddenUnicode } from '../lib/unicode';

export type TrailReason = 'PreCompact' | 'PostCompaction' | 'SessionEnd' | 'manual';

export interface TrailEvidence {
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  treeHash: string;
  finishedAt: string;
  reasons: string[];
  capReached?: boolean;
}

export interface TrailInput {
  taskId: string;
  repoId: string;
  repoRoot: string;
  agent: AgentId;
  reason: TrailReason;
  /** The brief title, when a brief exists for the task. */
  intent?: string | null;
  /** Edited files (repo-relative), newest first, with the time of the last edit. */
  files: Array<{ rel: string; ts: string }>;
  editCount: number;
  evidence?: TrailEvidence | null;
  /** `git write-tree` now, when known (to say whether the evidence is fresh). */
  treeNow?: string | null;
  next: string;
  gotchas: string[];
  /** One line about the pause commit (made, or why not). */
  wip?: string | null;
  now?: Date;
}

export interface TrailSummary {
  taskId: string;
  path: string;
  status: string;
  repoRoot: string | null;
  updated: string;
  mtimeMs: number;
  text: string;
}

const MAX_FILES = 15;
const MAX_GOTCHAS = 8;

export function trailDir(): string {
  return path.join(harnessHome(), 'trail');
}

function safeTaskFile(taskId: string): string {
  const id = String(taskId || 'none').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return id || 'none';
}

export function trailPath(taskId: string): string {
  return path.join(trailDir(), safeTaskFile(taskId) + '.md');
}

/** One line, no hidden Unicode, no control characters, capped. */
export function clean(s: unknown, max = 200): string {
  const t = stripHiddenUnicode(String(s ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function verifiedLines(t: TrailInput): string[] {
  const ev = t.evidence;
  if (!ev) return ['- No gate evidence for this task yet.'];
  const fresh = !!(t.treeNow && ev.treeHash && t.treeNow === ev.treeHash);
  const out = [`- Last gate verdict: ${ev.verdict} at tree ${ev.treeHash.slice(0, 12) || '?'} (${clean(ev.finishedAt, 40) || 'time unknown'}).`];
  if (t.treeNow) out.push(fresh ? '- The working tree has not changed since that run.' : '- The working tree changed after that run, so the verdict no longer applies.');
  if (ev.verdict === 'FAIL') for (const r of ev.reasons.slice(0, 5)) out.push(`  - ${clean(r, 160)}`);
  if (ev.capReached) out.push('- The gate-attempt cap was reached for this task (cap_reached); the write-up cannot cite PASS.');
  out.push('- Inherited verified claims are never trusted: re-run the gate before relying on this.');
  return out;
}

export function renderTrail(t: TrailInput): string {
  const now = (t.now ?? new Date()).toISOString();
  const L: string[] = [];
  L.push(`# harness trail: ${clean(t.taskId, 120)}`);
  L.push('');
  L.push('status: open');
  L.push(`repo: ${clean(t.repoRoot, 400)}`);
  L.push(`repoId: ${clean(t.repoId, 120)}`);
  L.push(`task: ${clean(t.taskId, 120)}`);
  L.push(`updated: ${now} (${t.reason}, ${t.agent})`);
  L.push('');
  L.push('## Intent');
  L.push(t.intent ? clean(t.intent, 200) : '(no brief found for this task; run `harness intake` if there is a ticket)');
  L.push('');
  L.push('## Progress');
  if (!t.files.length) L.push('- No edits recorded in the last session.');
  else {
    L.push(`- ${t.editCount} edit${t.editCount === 1 ? '' : 's'} to ${t.files.length} file${t.files.length === 1 ? '' : 's'} in the last session; newest first:`);
    for (const f of t.files.slice(0, MAX_FILES)) L.push(`  - ${clean(f.rel, 200)} (${clean(f.ts, 40)})`);
    if (t.files.length > MAX_FILES) L.push(`  - (+${t.files.length - MAX_FILES} more)`);
  }
  L.push('');
  L.push('## Verified state');
  L.push(...verifiedLines(t));
  L.push('');
  L.push('## Next');
  L.push(clean(t.next, 300));
  if (t.gotchas.length) {
    L.push('');
    L.push('## Gotchas');
    for (const g of t.gotchas.slice(0, MAX_GOTCHAS)) L.push(`- ${clean(g, 220)}`);
  }
  if (t.wip) {
    L.push('');
    L.push('## Pause commit');
    L.push(`- ${clean(t.wip, 200)}`);
  }
  L.push('');
  return L.join('\n');
}

export function writeTrail(t: TrailInput): string {
  const p = trailPath(t.taskId);
  writeTextAtomic(p, renderTrail(t));
  return p;
}

function headerValue(text: string, key: string): string | null {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(text.split('\n## ')[0] ?? '');
  return m ? m[1].trim() : null;
}

/** All trails, newest first. */
export function readTrails(): TrailSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(trailDir()).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const out: TrailSummary[] = [];
  for (const n of names) {
    const p = path.join(trailDir(), n);
    const text = readTextOr(p, null);
    if (text === null) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      /* keep 0 */
    }
    out.push({
      taskId: headerValue(text, 'task') ?? n.slice(0, -3),
      path: p,
      status: headerValue(text, 'status') ?? 'open',
      repoRoot: headerValue(text, 'repo'),
      updated: headerValue(text, 'updated') ?? '',
      mtimeMs,
      text,
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.updated < b.updated ? 1 : -1));
}

/**
 * Lines to print at session start: open trails whose repo lies inside one
 * of `roots` (or contains it), newest first, at most `maxLines` in total.
 */
export function openTrailLines(roots: string[], maxLines = 40): string[] {
  const inScope = (repo: string | null) => !!repo && roots.some((r) => subPath(r, repo) || subPath(repo, r));
  const trails = readTrails().filter((t) => t.status === 'open' && inScope(t.repoRoot));
  const all: string[] = [];
  for (const t of trails) {
    // Drop blank lines: the printed form is compact; the file keeps the layout.
    all.push(...t.text.split('\n').filter((l) => l.trim() !== ''));
  }
  if (all.length <= maxLines) return all;
  const kept = all.slice(0, Math.max(0, maxLines - 1));
  kept.push(`(trails cut at ${maxLines} lines; full text in ${trailDir()})`);
  return kept;
}

/** Mark a trail closed (the task landed or was abandoned); returns false when there is none. */
export function closeTrail(taskId: string): boolean {
  const p = trailPath(taskId);
  const text = readTextOr(p, null);
  if (text === null) return false;
  writeTextAtomic(p, text.replace(/^status: .*$/m, 'status: closed'));
  return true;
}
