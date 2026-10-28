/**
 * The Stop-hook evidence check (DESIGN §2.5), shared by Stop, SubagentStop
 * and TaskCompleted. It never runs tests or repo code: it reads the session
 * edit log, the gate's evidence.json per edited repo, and compares the
 * evidence tree hash with `git write-tree` of the working tree now.
 *
 *   edit log empty                                   -> exit 0
 *   every repo: verdict PASS|BLOCKED, tree unchanged -> exit 0
 *   attempt counter for (session, repo, task) >= cap -> exit 0, cap_reached written
 *   same tree and same evidence as at the last block -> exit 0 (never block twice)
 *   otherwise                                        -> bump counter, block with
 *                                                       "run `harness gate`" + failures
 *
 * The tree hash is cached per repo (key: the edited files' mtimes and sizes,
 * the git index and HEAD, the evidence file, the session's shell-call count;
 * 2-minute TTL) so repeated Stops stay fast.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { readJsonOr, readTextOr, writeJson } from '../lib/fsx';
import { writeTree } from '../lib/git';
import { sha256 } from '../lib/hash';
import { instrument } from '../lib/log';
import { harnessHome, runsDir } from '../lib/paths';
import { bumpAttempt, loadSession, saveSession, type SessionState } from '../lib/session';
import { attemptCap, machineConfig, oneLine, readEvidence, repoOf, taskFor, validId, type EvidenceRecord, type TaskRef } from './common';

/** Total time the check may take (the dispatcher kills Stop at 1.8 s). */
export const STOP_BUDGET_MS = 1500;
const TREE_CACHE_TTL_MS = 120_000;
const MAX_REASONS = 8;

export type RepoStopState = 'pass' | 'no-evidence' | 'fail' | 'stale' | 'capped' | 'unchanged';

export interface RepoStop {
  repoId: string;
  root: string;
  name: string;
  taskId: string | null;
  evidencePath: string | null;
  verdict: 'PASS' | 'FAIL' | 'BLOCKED' | null;
  state: RepoStopState;
  reasons: string[];
  tree: string | null;
  treeCached: boolean;
  /** Stamp of the evidence file as read (verdict, time, tree, attempt), for the unchanged check. */
  evidenceStamp: string;
  /** Blocks so far for (session, repo, task), after this call. */
  attempts: number;
}

export interface StopOutcome {
  exitCode: 0 | 2;
  outcome: 'no-edits' | 'pass' | 'cap' | 'unchanged' | 'block';
  message?: string;
  repos: RepoStop[];
  cap: number;
  ms: number;
}

// ---------------------------------------------------------------------------
// Tree hash with a cache
// ---------------------------------------------------------------------------

interface TreeCacheEntry {
  key: string;
  tree: string;
  at: number;
}

function treeCachePath(repoId: string): string {
  return path.join(harnessHome(), 'cache', repoId, 'stop-tree.json');
}

/** The git dir of a work tree: `.git` itself, or where a `.git` file (worktree, submodule) points. */
export function gitDirOf(root: string): string | null {
  const dotgit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (m) return path.resolve(root, m[1].trim());
  } catch {
    /* none */
  }
  return null;
}

function statStamp(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'x';
  }
}

export function treeCacheKey(root: string, files: string[], evidencePath: string | null, shellRuns: number): string {
  const gd = gitDirOf(root);
  const parts = [
    root,
    gd ? statStamp(path.join(gd, 'index')) : '-',
    gd ? (readTextOr(path.join(gd, 'HEAD'), '') ?? '').trim() : '-',
    evidencePath ? statStamp(evidencePath) : '-',
    String(shellRuns),
    ...[...files].sort().map((f) => `${f}=${statStamp(f)}`),
  ];
  return sha256(parts.join('\n'));
}

/** `git write-tree` of the working tree, from the cache when the key still matches. */
export function treeNow(
  repoId: string,
  root: string,
  files: string[],
  evidencePath: string | null,
  shellRuns: number,
  timeoutMs: number,
): { tree: string | null; cached: boolean } {
  const key = treeCacheKey(root, files, evidencePath, shellRuns);
  const cp = treeCachePath(repoId);
  const hit = readJsonOr<TreeCacheEntry | null>(cp, null);
  if (hit && hit.key === key && typeof hit.tree === 'string' && Date.now() - hit.at < TREE_CACHE_TTL_MS) return { tree: hit.tree, cached: true };
  const tree = writeTree(root, Math.max(100, timeoutMs));
  if (tree) {
    try {
      const entry: TreeCacheEntry = { key, tree, at: Date.now() };
      writeJson(cp, entry);
    } catch {
      /* the cache is an optimisation */
    }
  }
  return { tree, cached: false };
}

// ---------------------------------------------------------------------------
// Cap marker
// ---------------------------------------------------------------------------

/**
 * Record that the attempt cap released the agent: `cap_reached: true` in the
 * evidence file (other fields untouched), or a `cap.json` beside where the
 * evidence would be when the gate never ran, so the write-up cannot cite PASS.
 */
export function markCapReached(repoId: string, task: TaskRef | null, sessionId: string, attempts: number): string | null {
  const at = new Date().toISOString();
  if (task && fs.existsSync(task.evidencePath)) {
    const raw = readJsonOr<Record<string, unknown> | null>(task.evidencePath, null);
    if (raw && typeof raw === 'object') {
      if (raw.cap_reached === true) return task.evidencePath;
      raw.cap_reached = true;
      raw.cap_reached_at = at;
      writeJson(task.evidencePath, raw);
      return task.evidencePath;
    }
  }
  const taskId = task?.taskId ?? 'none';
  if (!validId(repoId) || !validId(taskId)) return null;
  const p = path.join(runsDir(), repoId, taskId, 'cap.json');
  writeJson(p, { version: 1, cap_reached: true, cap_reached_at: at, attempts, sessionId });
  return p;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function evidenceStamp(ev: EvidenceRecord | null): string {
  return ev ? `${ev.verdict}|${ev.finishedAt}|${ev.treeHash}|${ev.attempt}` : 'none';
}

function failureList(ev: EvidenceRecord): string[] {
  const out = ev.reasons.map((r) => oneLine(r, 200)).filter(Boolean);
  if (!out.length) {
    for (const s of ev.steps ?? []) {
      if (s && s.status === 'fail') out.push(oneLine(`${s.name}${s.reasons?.length ? ': ' + s.reasons.join('; ') : ''}`, 200));
    }
  }
  return out;
}

export interface RepoGroup {
  repoId: string;
  root: string;
  name: string;
  files: Set<string>;
}

/** Edited files per repo from the session edit log (entries without a repo are ignored). */
export function groupEdits(state: SessionState): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const rootByDir = new Map<string, ReturnType<typeof repoOf>>();
  for (const e of state.edits) {
    if (!e || !e.repo || typeof e.path !== 'string') continue;
    const dir = path.dirname(e.path);
    let hit = rootByDir.get(dir);
    if (hit === undefined) {
      hit = repoOf(e.path);
      rootByDir.set(dir, hit);
    }
    if (!hit) continue;
    let g = groups.get(hit.id);
    if (!g) {
      g = { repoId: hit.id, root: hit.root, name: hit.name, files: new Set() };
      groups.set(hit.id, g);
    }
    g.files.add(path.resolve(e.path));
  }
  return [...groups.values()];
}

export function attemptKey(repoId: string, taskId: string | null): string {
  return `${repoId}/${taskId ?? 'none'}`;
}

function renderBlock(blocking: RepoStop[], all: RepoStop[], cap: number): string {
  const lines: string[] = [];
  lines.push('harness: this work is not verified yet, so stopping is blocked. Run `harness gate` and fix what it reports, then stop again.');
  for (const r of all) {
    if (r.state === 'pass') continue;
    const cmd = `harness gate --repo "${r.root}"`;
    // edits in a repository the ticket of the other edited repositories does not cover
    const ticket = r.state === 'no-evidence' && !r.taskId ? all.find((x) => x.taskId)?.taskId : undefined;
    if (ticket) lines.push(`- ${r.name}: edited, but not part of ticket ${ticket}. Ask the user whether the ticket needs ${r.name}; if they agree, run: harness intake add-repo "${r.root}" --task ${ticket} --reason "<why>" [--criteria AC1], then: ${cmd}. If not, undo the edits there.`);
    else if (r.state === 'no-evidence') lines.push(`- ${r.name}: no evidence yet. Run: ${cmd}`);
    else if (r.state === 'stale') lines.push(`- ${r.name}: the ${r.verdict} evidence is stale (${r.reasons[0] ?? 'the working tree changed after the gate ran'}). Run: ${cmd}`);
    else if (r.state === 'fail') {
      lines.push(`- ${r.name}: the last gate run failed${r.reasons.length ? ':' : '.'}`);
      for (const why of r.reasons.slice(0, MAX_REASONS)) lines.push(`    ${why}`);
      if (r.reasons.length > MAX_REASONS) lines.push(`    (+${r.reasons.length - MAX_REASONS} more in the evidence file)`);
      lines.push(`  Fix these, then run: ${cmd}`);
    } else if (r.state === 'capped') lines.push(`- ${r.name}: gate attempt cap (${cap}) reached; recorded as cap_reached, so the write-up cannot cite PASS.`);
    else if (r.state === 'unchanged') lines.push(`- ${r.name}: unchanged since the last block; not blocking again for it.`);
  }
  const most = Math.max(...blocking.map((r) => r.attempts));
  lines.push(`Stop attempt ${most} of ${cap}. If the work cannot pass, record the gate's BLOCKED verdict with the reason instead of stopping silently; never weaken tests or checks to pass.`);
  return lines.join('\n');
}

/** Decide one Stop / SubagentStop / TaskCompleted call. Mutates session state (attempts, stop marks). */
export function evaluateStop(input: HookInput, ctx: HookContext, opts: { budgetMs?: number } = {}): StopOutcome {
  const started = Date.now();
  const budget = opts.budgetMs ?? STOP_BUDGET_MS;
  const state = loadSession(ctx.sessionId, ctx.agent);
  const groups = groupEdits(state);
  const cap = attemptCap(machineConfig());
  if (!groups.length) return { exitCode: 0, outcome: 'no-edits', repos: [], cap, ms: Date.now() - started };

  const repos: RepoStop[] = [];
  const shellRuns = state.shellRuns ?? 0;
  for (const g of groups) {
    const task = taskFor(g.repoId);
    const ev = task ? readEvidence(task.evidencePath) : null;
    const left = budget - (Date.now() - started) - 150;
    const t = left > 50 ? treeNow(g.repoId, g.root, [...g.files], task?.evidencePath ?? null, shellRuns, Math.floor(left / 2)) : { tree: null, cached: false };
    const r: RepoStop = {
      repoId: g.repoId,
      root: g.root,
      name: g.name,
      taskId: task?.taskId ?? null,
      evidencePath: task?.evidencePath ?? null,
      verdict: ev?.verdict ?? null,
      state: 'no-evidence',
      reasons: [],
      tree: t.tree,
      treeCached: t.cached,
      evidenceStamp: evidenceStamp(ev),
      attempts: state.attempts[attemptKey(g.repoId, task?.taskId ?? null)] ?? 0,
    };
    if (ev && (ev.verdict === 'PASS' || ev.verdict === 'BLOCKED')) {
      if (t.tree && ev.treeHash && t.tree === ev.treeHash) r.state = 'pass';
      else {
        r.state = 'stale';
        r.reasons = [t.tree ? 'the working tree changed after the gate ran' : 'the working tree could not be hashed in time'];
      }
    } else if (ev && ev.verdict === 'FAIL') {
      r.state = 'fail';
      r.reasons = failureList(ev);
      if (t.tree && ev.treeHash && t.tree !== ev.treeHash) r.reasons.push('(that run was on an earlier version of the tree)');
    }
    repos.push(r);
  }

  const marks = (state.stopBlocks ??= {});
  const nonPass = repos.filter((r) => r.state !== 'pass');
  if (!nonPass.length) {
    for (const r of repos) delete marks[attemptKey(r.repoId, r.taskId)];
    saveSession(state);
    return { exitCode: 0, outcome: 'pass', repos, cap, ms: Date.now() - started };
  }

  for (const r of nonPass) {
    const key = attemptKey(r.repoId, r.taskId);
    if (r.attempts >= cap) {
      r.state = 'capped';
      try {
        markCapReached(r.repoId, r.taskId ? taskFor(r.repoId) : null, ctx.sessionId, r.attempts);
      } catch {
        /* the release still happens; the counter shows the cap */
      }
      continue;
    }
    const m = marks[key];
    if (m && m.tree === r.tree && m.evidence === r.evidenceStamp) r.state = 'unchanged';
  }

  const blocking = nonPass.filter((r) => r.state !== 'capped' && r.state !== 'unchanged');
  if (!blocking.length) {
    saveSession(state);
    const outcome = nonPass.some((r) => r.state === 'capped') ? 'cap' : 'unchanged';
    return { exitCode: 0, outcome, repos, cap, ms: Date.now() - started };
  }

  const at = new Date().toISOString();
  for (const r of blocking) {
    const key = attemptKey(r.repoId, r.taskId);
    r.attempts += 1;
    state.attempts[key] = r.attempts;
    marks[key] = { tree: r.tree, evidence: r.evidenceStamp, at };
  }
  saveSession(state);
  return { exitCode: 2, outcome: 'block', message: renderBlock(blocking, repos, cap), repos, cap, ms: Date.now() - started };
}

/**
 * The handler body shared by Stop, SubagentStop and TaskCompleted.
 * An internal error blocks (fail closed) but is counted against the same
 * cap, so a persistent fault cannot loop an agent that has no cap of its own;
 * when even the counter cannot be written the hook lets the agent stop and
 * says so on stderr.
 */
export async function handleStopLike(input: HookInput, ctx: HookContext): Promise<HookResult> {
  try {
    const o = evaluateStop(input, ctx);
    instrument({
      event: `stop.${o.outcome}`,
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      ids: { hook: ctx.event },
      counts: {
        repos: o.repos.length,
        blocking: o.repos.filter((r) => r.state === 'no-evidence' || r.state === 'fail' || r.state === 'stale').length,
        capped: o.repos.filter((r) => r.state === 'capped').length,
        attempts: o.repos.reduce((n, r) => Math.max(n, r.attempts), 0),
        treeCached: o.repos.filter((r) => r.treeCached).length,
        stopHookActive: input.stop_hook_active === true ? 1 : 0,
        ms: o.ms,
      },
    });
    if (o.exitCode === 2) return { exitCode: 2, stderr: o.message };
    return { exitCode: 0 };
  } catch (e) {
    const msg = oneLine((e as Error)?.message ?? e, 160);
    instrument({ event: 'stop.error', sessionId: ctx.sessionId, agent: ctx.agent, ids: { hook: ctx.event } });
    let n: number;
    try {
      n = bumpAttempt(ctx.sessionId, '__stop_error__', ctx.agent);
    } catch {
      return { exitCode: 0, stderr: `harness ${ctx.event} check failed (${msg}) and could not record the attempt; letting the agent stop. Run \`harness doctor\`.` };
    }
    let cap = 8;
    try {
      cap = attemptCap(machineConfig());
    } catch {
      /* default */
    }
    if (n > cap) return { exitCode: 0, stderr: `harness ${ctx.event} check failed ${n} times (${msg}); letting the agent stop. Run \`harness doctor\`.` };
    return { exitCode: 2, stderr: `harness: the stop check failed internally (${msg}). Run \`harness gate\` to verify the work, then stop again; run \`harness doctor\` if this repeats.` };
  }
}
