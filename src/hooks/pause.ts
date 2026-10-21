/**
 * Pause safely (DESIGN §2.13), shared by PreCompact, PostCompaction and
 * SessionEnd: for every repo in the session edit log (and the session's own
 * repo when it has a current task) write `~/.harness/trail/<taskId>.md`,
 * and in the personal setting make a `wip: pause` commit on the current
 * branch when there are uncommitted changes.
 *
 * The pause commit is never made: in the team setting; on main, master or
 * the remote's default branch; on a detached HEAD; during a merge, rebase,
 * cherry-pick, revert or bisect; when any changed path is one the guard's
 * staging rule refuses (secrets, env files); or when a changed file's
 * content matches a secret pattern. It never pushes. It runs no repo code:
 * git hooks are switched off for the commit (`core.hooksPath` pointed at an
 * empty folder, `--no-verify`) and signing is off so no prompt can hang it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookInput } from '../types';
import type { HookContext } from '../hook';
import { evaluate } from '../guard';
import { resolveConfig } from '../lib/config';
import { ensureDir, readJsonOr, readTextOr } from '../lib/fsx';
import { currentBranch, rawGit } from '../lib/git';
import { harnessHome } from '../lib/paths';
import { findSecrets } from '../lib/redact';
import { loadSession, type SessionState } from '../lib/session';
import { trailPath, writeTrail, type TrailReason } from '../runctl/trail';
import { buildGuardInput } from './PreToolUse';
import { currentTask, hookCwd, oneLine, readEvidence, relTo, repoOf, taskFor, type EvidenceRecord } from './common';
import { gitDirOf, groupEdits, treeNow, type RepoGroup } from './evidence';
import { loadLedger, standardLine } from './standards';

export interface WipResult {
  made: boolean;
  sha?: string;
  branch?: string;
  reason: string;
}

export interface PauseResult {
  trails: string[];
  wips: Array<WipResult & { repoId: string }>;
}

const MAIN_BRANCHES = new Set(['main', 'master']);
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'];
const SCAN_BYTES_PER_FILE = 512 * 1024;
const SCAN_BYTES_TOTAL = 8 * 1024 * 1024;

/** The remote's default branch name (`origin/HEAD`), when known. */
export function defaultBranchOf(root: string): string | null {
  const r = rawGit(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], 5000);
  if (r.code !== 0) return null;
  const s = r.stdout.trim();
  return s.includes('/') ? s.slice(s.indexOf('/') + 1) : s || null;
}

/** Paths from `git status --porcelain=v1 -z` (both sides of renames). */
export function porcelainPaths(z: string): string[] {
  const parts = z.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    out.push(e.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      if (parts[i + 1]) out.push(parts[i + 1]);
      i++;
    }
  }
  return out;
}

/** The `wip: pause` commit (personal setting, never on main, never pushed). */
export function wipCommit(root: string, input: HookInput, ctx: HookContext, why: TrailReason): WipResult {
  const setting = resolveConfig(root).config.setting;
  if (setting !== 'personal') return { made: false, reason: 'team setting: the harness never commits in team repos' };
  const branch = currentBranch(root);
  if (!branch || branch === 'HEAD') return { made: false, reason: 'detached HEAD: no pause commit' };
  const def = defaultBranchOf(root);
  if (MAIN_BRANCHES.has(branch) || (def && branch === def)) return { made: false, branch, reason: `on ${branch}: a pause commit is never made on the main branch` };
  const gd = gitDirOf(root);
  if (gd && IN_PROGRESS.some((f) => fs.existsSync(path.join(gd, f)))) return { made: false, branch, reason: 'a merge, rebase, cherry-pick, revert or bisect is in progress' };
  const st = rawGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 15000);
  if (st.code !== 0) return { made: false, branch, reason: 'git status failed' };
  const files = porcelainPaths(st.stdout);
  if (!files.length) return { made: false, branch, reason: 'no uncommitted changes' };

  const gi = buildGuardInput({ ...input, tool_name: 'Bash', tool_input: { command: 'git commit -m wip' }, cwd: root }, ctx);
  for (const f of files.slice(0, 5000)) {
    const d = evaluate({ ...gi, stagedFiles: () => [f], worktreeStatus: () => ({ modified: [], untracked: [] }) });
    if (d.decision === 'deny' && d.rail === 'staging') return { made: false, branch, reason: `${oneLine(f, 120)} must never be committed (secret or env file); commit by hand after removing it` };
  }
  let scanned = 0;
  for (const f of files) {
    if (scanned > SCAN_BYTES_TOTAL) return { made: false, branch, reason: 'too many changed bytes to scan for secrets; commit by hand' };
    const abs = path.join(root, f);
    let size = 0;
    try {
      const s = fs.statSync(abs);
      if (!s.isFile()) continue;
      size = s.size;
    } catch {
      continue;
    }
    if (size > SCAN_BYTES_PER_FILE) continue;
    scanned += size;
    const text = readTextOr(abs, '') ?? '';
    if (findSecrets(text).length) return { made: false, branch, reason: `${oneLine(f, 120)} may contain a secret; commit by hand after checking it` };
  }

  const hooksDir = path.join(harnessHome(), 'state', 'no-git-hooks');
  ensureDir(hooksDir);
  const add = rawGit(root, ['add', '-A', '--', '.'], 30000);
  if (add.code !== 0) return { made: false, branch, reason: 'git add failed' };
  // The subject follows the repository's commit-subject standard (the gate checks every subject on the
  // branch; `wip:` is not a Conventional Commits type), e.g. `chore(wip): pause the work`.
  const { pickSubject } = require('../land/gitops') as typeof import('../land/gitops');
  const { repoIdFor } = require('../lib/config') as typeof import('../lib/config');
  const subject = pickSubject(['wip: pause', 'chore(wip): pause the work', 'chore: pause the work in progress'], repoIdFor(root));
  const c = rawGit(root, ['-c', `core.hooksPath=${hooksDir}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', subject, '-m', `Paused by the harness (${why}); not pushed.`], 30000);
  if (c.code !== 0) return { made: false, branch, reason: 'git commit failed' };
  const sha = rawGit(root, ['rev-parse', '--short', 'HEAD'], 5000).stdout.trim();
  return { made: true, sha, branch, reason: 'ok' };
}

function nextFor(root: string, ev: EvidenceRecord | null, tree: string | null): string {
  const gate = `\`harness gate --repo "${root}"\``;
  if (!ev) return `Finish the remaining work, then run ${gate}.`;
  if (ev.verdict === 'FAIL') return `Fix the failures listed above, then run ${gate}.`;
  if (tree && ev.treeHash === tree) return `Re-run ${gate} to confirm (inherited verdicts are not trusted), then write up with \`harness writeup\`.`;
  return `The tree changed after the last gate run: run ${gate}.`;
}

/** Files and times from an earlier trail for the same task (so progress survives across sessions). */
function earlierFiles(taskId: string): Array<{ rel: string; ts: string }> {
  const text = readTextOr(trailPath(taskId), null);
  if (!text) return [];
  const section = text.split('\n## Progress')[1]?.split('\n## ')[0] ?? '';
  const out: Array<{ rel: string; ts: string }> = [];
  for (const line of section.split('\n')) {
    const m = /^ {2}- (.+) \((\d{4}-\d{2}-\d{2}T[^)]+)\)$/.exec(line);
    if (m) out.push({ rel: m[1], ts: m[2] });
  }
  return out;
}

function filesOf(state: SessionState, g: RepoGroup, taskId: string): { files: Array<{ rel: string; ts: string }>; count: number } {
  const byRel = new Map<string, string>();
  for (const f of earlierFiles(taskId)) byRel.set(f.rel, f.ts);
  let count = 0;
  for (const e of state.edits) {
    if (!e || typeof e.path !== 'string') continue;
    if (!g.files.has(path.resolve(e.path))) continue;
    count++;
    const rel = relTo(g.root, e.path);
    const prev = byRel.get(rel);
    if (!prev || prev < e.ts) byRel.set(rel, e.ts);
  }
  const files = [...byRel].map(([rel, ts]) => ({ rel, ts })).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { files, count };
}

/** Write the trail for every repo of the session and make the personal-setting pause commit. */
export function pauseSafely(input: HookInput, ctx: HookContext, reason: TrailReason): PauseResult {
  const state = loadSession(ctx.sessionId, ctx.agent);
  const groups = groupEdits(state);
  const own = repoOf(hookCwd(input));
  if (own && !groups.some((g) => g.repoId === own.id) && currentTask(own.id)) groups.push({ repoId: own.id, root: own.root, name: own.name, files: new Set() });
  const ledger = state.notes?.length ? loadLedger() : null;
  const result: PauseResult = { trails: [], wips: [] };
  for (const g of groups) {
    const task = taskFor(g.repoId);
    const taskId = task?.taskId ?? `adhoc-${g.repoId}`;
    const ev = task ? readEvidence(task.evidencePath) : null;
    const t = treeNow(g.repoId, g.root, [...g.files], task?.evidencePath ?? null, state.shellRuns ?? 0, 15000);
    const { files, count } = filesOf(state, g, taskId);
    const brief = readJsonOr<{ title?: unknown } | null>(path.join(harnessHome(), 'briefs', `${taskId}.json`), null);
    const gotchas = (state.notes ?? [])
      .filter((n) => n && n.repo === g.repoId)
      .slice(-8)
      .reverse()
      .map((n) => {
        const rec = ledger?.records.find((r) => r.id === n.rule);
        return rec ? `${n.rule} in ${n.file}: ${standardLine(rec, 160)}` : `${n.rule} in ${n.file}`;
      });
    let wip: WipResult;
    try {
      // In a `harness run` session the runner commits the tree the gate passed and pauses the task
      // itself when a session is cut off; a pause commit at every session end would only add a
      // commit the gate has not seen.
      wip = process.env.HARNESS_RUN ? { made: false, reason: 'a harness run session: the runner commits the work and pauses the task itself' } : wipCommit(g.root, input, ctx, reason);
    } catch (e) {
      wip = { made: false, reason: `pause commit failed: ${oneLine((e as Error).message, 80)}` };
    }
    result.wips.push({ ...wip, repoId: g.repoId });
    const wipLine = wip.made ? `wip: pause commit ${wip.sha} on branch ${wip.branch} (not pushed).` : wip.reason === 'team setting: the harness never commits in team repos' ? null : `No pause commit: ${wip.reason}.`;
    const p = writeTrail({
      taskId,
      repoId: g.repoId,
      repoRoot: g.root,
      agent: ctx.agent,
      reason,
      intent: typeof brief?.title === 'string' ? brief.title : null,
      files,
      editCount: count,
      evidence: ev ? { verdict: ev.verdict, treeHash: ev.treeHash, finishedAt: ev.finishedAt, reasons: ev.reasons, capReached: ev.cap_reached === true } : null,
      treeNow: t.tree,
      next: nextFor(g.root, ev, t.tree),
      gotchas,
      wip: wipLine,
    });
    result.trails.push(p);
  }
  return result;
}
