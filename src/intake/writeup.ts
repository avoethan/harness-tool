/**
 * End-of-work write-up: the PR description the user pastes (team setting) or
 * the landing commit body (personal setting).
 *
 * Built from the brief, each touched repo's evidence file
 * (runs/<repoId>/<taskId>/evidence.json; a missing one reads "gate not run"),
 * the e2e artifact refs it lists, the tests-phase record and `git diff`
 * against the base commit (file names and line counts only, never content).
 *
 * Sections: Why / What changed / Scope / Tradeoffs / Blast radius /
 * Verification (criterion -> check -> result -> artifact) / Assumptions /
 * Feedback wanted / Cross-repo (when the ticket spans repos) / Branch and
 * next steps (team) or Landing (personal).
 *
 * The rendered text goes through redactText as a whole (redaction by
 * construction), and artifact paths are shown relative to the run folder so
 * no local home path ends up in a PR.
 */
import * as path from 'node:path';
import type { CheckSpec, EvidenceFile, GateStep, Setting } from '../types';
import { readJsonOr } from '../lib/fsx';
import { currentBranch, isGitRepo, rawGit, writeTree } from '../lib/git';
import { redactText } from '../lib/redact';
import { toPosix } from '../lib/paths';
import type { BriefFile } from './brief';
import { runDir } from './brief';
import { readPhaseRecord, type PhaseRecord } from './phase';
import { UNMAPPED } from './units';
import { gateWhat } from './gatecheck';
import { isTestFile } from '../gate/context';
import { committedSince, indexOf, partitionChanges, readStartSnapshot, treeStates, workingTreeOf, type StartSnapshot } from './localchanges';

export interface FileChange {
  status: string;
  file: string;
  added?: number;
  removed?: number;
  /** The path had local changes when the ticket started and changed again during it. */
  localBefore?: boolean;
}

export interface RepoWork {
  repoId: string;
  name: string;
  path?: string;
  evidence: EvidenceFile | null;
  /** The evidence was written for a different tree than the current one. */
  evidenceStale?: boolean;
  /**
   * The Stop hook released the agent at the gate-attempt cap (`cap_reached`
   * in evidence.json, or cap.json when the gate never ran): the write-up
   * must not cite PASS for this task.
   */
  capReached?: boolean;
  changes: FileChange[];
  baseSha?: string;
  branch?: string;
  phase?: PhaseRecord | null;
}

export interface WriteupInput {
  brief: BriefFile;
  setting: Setting;
  /** Touched repos, in landing order. */
  repos: RepoWork[];
}

export interface VerificationRow {
  id: string;
  text: string;
  check: string;
  result: string;
  artifact: string;
}

function idRe(id: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
}

function stepResult(s: GateStep): string {
  if (s.status === 'pre-existing') return 'already failing before this change (pre-existing)';
  return s.status === 'pass' ? 'PASS' : s.status === 'fail' ? 'FAIL' : s.status === 'cached' ? 'PASS (cached)' : 'skipped';
}

function short(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** An artifact path as it may appear in a PR: relative to the run folder, never an absolute local path. */
export function artifactLabel(p: string, repoId: string, taskId: string): string {
  let base: string;
  try {
    base = runDir(repoId, taskId);
  } catch {
    base = '';
  }
  const abs = path.resolve(base || '.', p);
  const rel = base ? path.relative(base, abs) : '';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  return path.basename(p);
}

function checkLabel(c: CheckSpec | undefined): string {
  if (!c) return 'none yet (open question)';
  if (c.kind === 'gate') return `gate: ${short(gateWhat(c), 110)}`;
  if (c.greenAtBase) return `${c.kind}: green-at-base: ${short(c.greenAtBaseReason ?? 'it passes before the change and must keep passing', 90)}`;
  return `${c.kind}: ${short(c.description, 90)}`;
}

/** The verification table rows for the criteria of one repo. */
export function verificationRows(brief: BriefFile, criteriaIds: string[], work: Pick<RepoWork, 'evidence' | 'evidenceStale' | 'repoId' | 'capReached'>): VerificationRow[] {
  const rows: VerificationRow[] = [];
  const ev = work.evidence;
  const capped = isCapped(work);
  for (const id of criteriaIds) {
    const c = brief.criteria.find((x) => x.id === id);
    if (!c) continue;
    let result: string;
    let artifact = '-';
    if (!ev) result = 'gate not run';
    else {
      const re = idRe(id);
      const step = ev.steps.find((s) => re.test(s.name));
      const arts = ev.e2e.filter((a) => re.test(a.id));
      if (arts.length) artifact = arts.map((a) => artifactLabel(a.path, work.repoId, brief.id)).join(', ');
      if (step) result = stepResult(step);
      else if (arts.length) result = ev.verdict === 'PASS' ? 'PASS' : ev.verdict;
      else if (c.check?.kind === 'manual') result = 'manual: no artifact linked';
      else result = `not linked to a gate step (gate ${ev.verdict})`;
      if (ev.verdict === 'BLOCKED' && !/BLOCKED/.test(result)) result += ' (gate BLOCKED)';
      if (work.evidenceStale) result += ' (evidence is for an older tree)';
    }
    if (capped && /PASS/.test(result)) result = 'not cited: gate attempt cap reached (needs review)';
    rows.push({ id, text: c.text, check: checkLabel(c.check), result, artifact });
  }
  return rows;
}

function criteriaFor(brief: BriefFile, repoId: string): string[] {
  const ids = new Set<string>();
  for (const u of brief.units) if (u.repo === repoId) for (const c of u.criteria) ids.add(c);
  return brief.criteria.map((c) => c.id).filter((id) => ids.has(id));
}

function repoLabel(brief: BriefFile, repos: RepoWork[], id: string): string {
  return repos.find((r) => r.repoId === id)?.name ?? brief.repoMap.repos[id]?.name ?? (id === UNMAPPED ? 'unmapped repo' : id);
}

/** Render the write-up for one repo. The result is already redacted. */
export function renderWriteup(input: WriteupInput, work: RepoWork): string {
  const { brief, setting, repos } = input;
  const L: string[] = [];
  const mine = criteriaFor(brief, work.repoId);
  const ids = mine.length ? mine : brief.criteria.map((c) => c.id);
  const crit = (id: string) => brief.criteria.find((c) => c.id === id);

  L.push(`# ${brief.title}`, '');

  L.push('## Why');
  const para = brief.description.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(```|~~~|\{code|\{noformat)/.test(p));
  L.push(para ? short(para, 600) : 'The ticket gives no description; the criteria below are the reason for this change.', '');

  L.push('## What changed');
  if (!work.changes.length) L.push(`No file changes against the base commit${work.baseSha ? ` ${work.baseSha.slice(0, 12)}` : ''}.`);
  else {
    for (const ch of work.changes.slice(0, 40)) {
      const counts = ch.added !== undefined || ch.removed !== undefined ? ` (+${ch.added ?? 0} -${ch.removed ?? 0})` : '';
      const st = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', '?': 'new, untracked' }[ch.status[0] as 'A'] ?? ch.status;
      L.push(`- \`${ch.file}\` ${st}${counts}${ch.localBefore ? ' - changed during the ticket (you had local changes in it before)' : ''}`);
    }
    if (work.changes.length > 40) L.push(`- and ${work.changes.length - 40} more file(s)`);
    // Pre-existing tests the change edited (not new ones): a reviewer should read these first, because an
    // expectation changed to match new behaviour is exactly what the hidden suite of a reviewer would catch.
    const editedTests = work.changes.filter((ch) => /^[MR]/.test(ch.status) && isTestFile(ch.file)).map((ch) => ch.file);
    if (editedTests.length) L.push('', `Existing tests changed (read these first; an expectation may have been moved to match the new behaviour): ${editedTests.slice(0, 20).map((f) => `\`${f}\``).join(', ')}${editedTests.length > 20 ? ` and ${editedTests.length - 20} more` : ''}.`);
  }
  L.push('');

  L.push('## Scope');
  L.push(`- In this change: ${ids.map((id) => `${id} (${short(crit(id)?.text ?? '', 60)})`).join('; ') || 'no criteria mapped to this repo'}`);
  const others = repos.filter((r) => r.repoId !== work.repoId);
  for (const o of others) {
    const oc = criteriaFor(brief, o.repoId);
    if (oc.length) L.push(`- In the ${o.name} change: ${oc.join(', ')}`);
  }
  if (brief.dropped.length) L.push(`- Left out by your answers: ${brief.dropped.map((d) => `${d.id} (${short(d.text, 60)})`).join('; ')}`);
  const waiting = brief.criteria.filter((c) => !c.check && ids.includes(c.id));
  if (waiting.length) L.push(`- Not done, waiting for an answer: ${waiting.map((c) => c.id).join(', ')}`);
  L.push(`- Nothing else: changes outside these criteria are not part of this ticket.`, '');

  L.push('## Tradeoffs');
  const forks = brief.clarifications.filter((c) => !['meaning', 'measure'].includes(c.topic));
  const defaults = brief.assumptions.filter((a) => /until answered|question cap/.test(a));
  if (!forks.length && !defaults.length) L.push('- No forks in this ticket needed a choice beyond the assumptions below.');
  for (const f of forks) L.push(`- ${f.criterionId ? f.criterionId + ': ' : ''}${f.topic} - chose "${short(f.a, 120)}" (your answer to Q${f.n})`);
  for (const d of defaults) L.push(`- ${short(d, 160)}`);
  L.push('');

  L.push('## Blast radius');
  const touched = repos.map((r) => (r.repoId === work.repoId ? `${r.name} (this change)` : r.name));
  L.push(`- Repos: ${touched.join(', ') || work.name}`);
  const routes = new Set<string>();
  const tables = new Set<string>();
  for (const id of ids) {
    const m = brief.criteriaMeta[id];
    if (!m) continue;
    for (const r of m.facts.routes) routes.add(`${r.method ?? ''} ${r.path}`.trim());
    for (const t of m.facts.tables) tables.add(t);
    for (const c of m.facts.columns) if (c.includes('.')) tables.add(c.split('.')[0]);
  }
  if (routes.size) L.push(`- Routes named in the ticket: ${[...routes].join(', ')}`);
  if (tables.size) {
    const cols = ids.flatMap((id) => brief.criteriaMeta[id]?.facts.columns ?? []);
    L.push(`- Tables named in the ticket: ${[...tables].join(', ')}${cols.length ? ` (columns: ${[...new Set(cols)].join(', ')})` : ''}`);
  }
  const risky = work.changes.filter((c) => /migrat|schema|\.sql$|(^|\/)\.github\/|ci\.|(^|\/)(package\.json|tsconfig[^/]*\.json)$|auth|secur|permission/i.test(c.file));
  if (risky.length) L.push(`- Sensitive files changed: ${risky.map((c) => `\`${c.file}\``).join(', ')}`);
  L.push(`- Files changed here: ${work.changes.length}`, '');

  L.push('## Verification');
  const ev = work.evidence;
  const capped = isCapped(work);
  if (capped) L.push(`Gate: NOT PASSED. The gate-attempt cap was reached for this task${ev?.cap_reached_at ? ` (${ev.cap_reached_at})` : ''}, so the agent was let go without a fresh PASS; ${ev ? `the last recorded verdict was ${ev.verdict === 'PASS' ? 'PASS on an earlier tree or before the cap, and is not cited' : ev.verdict}` : 'the gate never ran'}. A person must review this change.`);
  const blockedReason = ev?.verdict === 'BLOCKED' ? ev.reasons.map((r) => /^BLOCKED: (.*)$/s.exec(r)?.[1]).find((x) => x) : undefined;
  if (blockedReason) L.push(`Blocked: ${short(blockedReason, 500)}`);
  if (!ev) {
    if (!capped) L.push('Gate: not run (no evidence file for this task). Run `harness gate` before opening the PR.');
  } else if (capped) {
    if (ev.reasons.length && ev.verdict !== 'PASS') L.push(`Reasons: ${ev.reasons.map((r) => short(r, 120)).join('; ')}`);
  } else {
    L.push(`Gate: ${ev.verdict} at tree ${ev.treeHash.slice(0, 12)}, attempt ${ev.attempt}, ${ev.finishedAt}${work.evidenceStale ? ' - the code changed after this run; run `harness gate` again' : ''}.`);
    if (ev.reasons.length && ev.verdict !== 'PASS') L.push(`Reasons: ${ev.reasons.map((r) => short(r, 120)).join('; ')}`);
    if (ev.steps.length) L.push(`Steps: ${ev.steps.map((s) => `${s.name} ${s.status}`).join(', ')}`);
  }
  const preExisting = ev?.steps.filter((s) => s.status === 'pre-existing') ?? [];
  if (preExisting.length) {
    L.push('', '### Already failing before this change');
    L.push(`These checks fail the same way at the base commit ${ev!.baseSha.slice(0, 10)}, so this change did not cause them and they did not fail the gate; nothing in them is new.`);
    for (const s of preExisting) L.push(`- ${s.name}: ${short((s.reasons ?? []).slice(1, 6).join('; ') || s.reasons?.[0] || 'failing at the base commit', 300)}`);
  }
  L.push('');
  L.push('| Criterion | Check | Result | Artifact |', '|---|---|---|---|');
  for (const r of verificationRows(brief, ids, work)) L.push(`| ${cell(`${r.id} ${short(r.text, 70)}`)} | ${cell(r.check)} | ${cell(r.result)} | ${cell(r.artifact)} |`);
  L.push('');
  const entries = work.phase?.testsEntries ?? 0;
  const tamper = ev ? `the gate's tamper check ran after them (verdict ${ev.verdict})` : 'the gate has not checked them yet';
  L.push(entries ? `Tests were added or changed in the tests phase (entered ${entries} time(s)); ${tamper}.` : 'The tests phase was not entered for this task (no test files were changed through it).', '');
  const declared = work.phase?.expectChanges ?? [];
  if (declared.length) L.push(`Expectations changed in existing tests (declared): ${declared.map((e) => `${e.file}: ${short(e.reason, 160)}`).join('; ')}.`, '');

  L.push('## Assumptions');
  if (!brief.assumptions.length) L.push('- None.');
  for (const a of brief.assumptions) L.push(`- ${short(a, 200)}`);
  L.push('');

  L.push('## Feedback wanted');
  const fb: string[] = [];
  for (const q of [...brief.questionDetails, ...brief.queued]) {
    fb.push(`- Open question Q${q.n} (${q.topic}${q.criterionId ? `, ${q.criterionId}` : ''}): ${short(q.text, 160)}${q.blocking ? ' This criterion is not done until it is answered.' : ` I went with "${q.options[q.recommended]}"; tell me if that is wrong.`}`);
  }
  for (const id of ids) {
    const m = brief.criteriaMeta[id];
    const c = crit(id);
    if (!m || !c) continue;
    if (m.parseConfidence < 0.7) fb.push(`- ${id} was read from the ticket's prose, not from a criteria list: is it really a requirement?`);
    if (m.kindConfidence < 0.6) fb.push(`- ${id}: I guessed the kind of check (${c.kind}, confidence ${m.kindConfidence.toFixed(2)}); does the check prove it?`);
    if (c.check?.kind === 'manual') fb.push(`- ${id} is checked by hand (${short(c.check.description, 80)}); please look at the artifact.`);
  }
  if (capped) fb.push('- The gate-attempt cap was reached: nothing here is verified by a PASS; review the change and the failing steps before merging.');
  if (ev) {
    for (const s of ev.steps.filter((x) => x.status === 'fail' || x.status === 'skip')) fb.push(`- Gate step ${s.name} ${s.status === 'fail' ? 'failed' : 'was skipped'}${s.reasons?.length ? `: ${short(s.reasons.join('; '), 120)}` : ''}.`);
    if (work.evidenceStale) fb.push('- The evidence predates the last code change.');
  }
  if (risky.length) fb.push(`- Review the sensitive files closely: ${risky.map((c) => c.file).join(', ')}.`);
  if (entries > 1) fb.push(`- Tests were changed in ${entries} separate tests phases; check that no assertion was weakened.`);
  if (!fb.length) fb.push('- A review of the change itself; no open questions and no risky spots were found.');
  L.push(...fb, '');

  if (repos.length > 1) {
    L.push('## Cross-repo');
    L.push(`This ticket lands as ${repos.length} changes. Landing order: ${brief.landingOrder.filter((r) => repos.some((x) => x.repoId === r)).map((r, i) => `${i + 1}. ${repoLabel(brief, repos, r)}`).join('  ')}`);
    for (const o of others) {
      const oc = criteriaFor(brief, o.repoId);
      L.push(`- ${o.name}: ${oc.join(', ') || 'no criteria'}${o.branch ? ` (branch \`${o.branch}\`)` : ''}`);
    }
    const deps = brief.units.filter((u) => u.repo === work.repoId && u.dependsOn.length);
    for (const u of deps) {
      const on = u.dependsOn.map((d) => brief.units.find((x) => x.id === d)).filter((x) => x && x.repo !== work.repoId);
      if (on.length) L.push(`- ${u.id} here depends on ${on.map((x) => `${x!.id} in ${repoLabel(brief, repos, x!.repo)}`).join(', ')}: land that first.`);
    }
    L.push('');
  }

  if (setting === 'team') {
    L.push('## Branch and next steps');
    L.push(`Branch: \`${work.branch ?? '(unknown)'}\` (local only; the harness never pushes).`);
    if (!work.branch || DEFAULT_BRANCHES.has(work.branch)) {
      // The work sits on the default branch (or a detached HEAD): never suggest pushing that.
      const name = suggestedBranch(brief);
      L.push(`1. Move the change to its own branch and commit it there: \`git switch -c ${name}\`, then \`git add\` the files above and \`git commit\`.`);
      L.push(`2. Push that branch: \`git push -u origin ${name}\``);
      L.push('3. Open a pull request from it with this text as the description, and request review.');
    } else {
      L.push(`1. Push the branch: \`git push -u origin ${work.branch}\``);
      L.push('2. Open a pull request from it with this text as the description.');
      L.push('3. Request review.');
    }
  } else {
    L.push('## Landing');
    L.push('Land with `harness land` after the gate passes; it fast-forwards main, waits for CI and reverts on red.');
  }
  return redactText(L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
}

/** Branch names that are a repository's main line, never a change branch. */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'development', 'HEAD']);

/** A branch name for the change: the ticket key and title words (`shop-102-low-stock-endpoint`), else the brief id. */
export function suggestedBranch(brief: Pick<BriefFile, 'id' | 'title'>): string {
  const s = (brief.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return s.length >= 3 ? s : brief.id;
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/** Whether a task's gate attempts were capped (evidence marker or cap.json). */
export function isCapped(work: Pick<RepoWork, 'evidence' | 'capReached'>): boolean {
  return work.capReached === true || work.evidence?.cap_reached === true;
}

/** cap.json beside the evidence: the Stop hook writes it when the cap released the agent and the gate never ran. */
export function readCapMarker(repoId: string, taskId: string): boolean {
  try {
    const c = readJsonOr<{ cap_reached?: unknown } | null>(path.join(runDir(repoId, taskId), 'cap.json'), null);
    return !!c && c.cap_reached === true;
  } catch {
    return false;
  }
}

export function readEvidence(repoId: string, taskId: string): EvidenceFile | null {
  let p: string;
  try {
    p = path.join(runDir(repoId, taskId), 'evidence.json');
  } catch {
    return null;
  }
  const e = readJsonOr<EvidenceFile | null>(p, null);
  if (!e || e.version !== 1 || !Array.isArray(e.steps)) return null;
  return { ...e, e2e: Array.isArray(e.e2e) ? e.e2e : [], reasons: Array.isArray(e.reasons) ? e.reasons : [] };
}

/**
 * Changed files against a base commit: tracked changes in the working tree plus untracked files. Names and
 * counts only. With the task's start snapshot, local changes present when the ticket started and unchanged
 * since are left out, and a recorded path that changed since is marked `localBefore`
 * (the decision is `partitionChanges` in src/intake/localchanges.ts, the same one the gate uses).
 */
export function diffAgainst(repoPath: string, base: string, snapshot?: StartSnapshot | null): FileChange[] {
  const ok = rawGit(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], 5000).code === 0;
  const b = ok ? base : 'HEAD';
  const out = new Map<string, FileChange>();
  // -z: paths come raw (spaces, non-ASCII), never quoted.
  const ns = rawGit(repoPath, ['diff', '--name-status', '-z', '--no-renames', b], 30000);
  if (ns.code === 0) {
    const parts = ns.stdout.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const st = parts[i];
      const file = parts[i + 1];
      if (st && file && /^[A-Z]/.test(st)) out.set(file, { status: st[0], file });
    }
  }
  const num = rawGit(repoPath, ['diff', '--numstat', '-z', '--no-renames', b], 30000);
  if (num.code === 0) {
    for (const rec of num.stdout.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
      if (!m) continue;
      const ch = out.get(m[3]) ?? { status: 'M', file: m[3] };
      if (m[1] !== '-') ch.added = Number(m[1]);
      if (m[2] !== '-') ch.removed = Number(m[2]);
      out.set(m[3], ch);
    }
  }
  const un = rawGit(repoPath, ['ls-files', '-z', '--others', '--exclude-standard'], 30000);
  if (un.code === 0) for (const f of un.stdout.split('\0').filter(Boolean)) if (!out.has(f)) out.set(f, { status: '?', file: f });
  let changes = [...out.values()];
  const idx = indexOf(snapshot ?? null, snapshot ? committedSince(repoPath, snapshot.base, headOf(repoPath)) : []);
  if (idx) {
    const tree = workingTreeOf(repoPath);
    const states = tree ? treeStates(repoPath, tree) : new Map<string, string>();
    const split = partitionChanges(changes.map((c) => ({ ...c, path: c.file })), idx, (p) => states.get(p) ?? null);
    const marked = new Set(split.changedSince);
    changes = split.kept.map(({ path: _p, ...c }) => (marked.has(c.file) ? { ...c, localBefore: true } : c));
  }
  return changes.sort((a, b2) => a.file.localeCompare(b2.file));
}

function headOf(repoPath: string): string | null {
  const r = rawGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 5000);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Evidence, diff, branch and phase for one repo of a brief. */
export function gatherRepoWork(brief: BriefFile, repoId: string, name: string, repoPath?: string): RepoWork {
  const evidence = readEvidence(repoId, brief.id);
  const work: RepoWork = { repoId, name, evidence, changes: [], phase: readPhaseRecord(repoId, brief.id) };
  if (evidence?.cap_reached === true || readCapMarker(repoId, brief.id)) work.capReached = true;
  if (repoPath) work.path = repoPath;
  if (repoPath && isGitRepo(repoPath)) {
    const base = evidence?.baseSha || brief.baseShas[repoId] || 'HEAD';
    work.baseSha = base;
    work.changes = diffAgainst(repoPath, base, readStartSnapshot(repoId, brief.id));
    const br = currentBranch(repoPath);
    if (br) work.branch = br;
    if (evidence?.treeHash) {
      const tree = writeTree(repoPath);
      if (tree && tree !== evidence.treeHash) work.evidenceStale = true;
    }
  }
  return work;
}
