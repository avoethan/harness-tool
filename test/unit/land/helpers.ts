/** Helpers for landing and runner tests: a temp repo with a task worktree, scripted gate, CI and sessions. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile } from '../../../src/types';
import { repoIdFor } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import { renderTask, type LedgerTask } from '../../../src/intake/ledger';
import type { GateCall, GateOutcome, GateRunner } from '../../../src/land/gaterun';
import type { CiCheck, CiProvider, CiResult, CiStatus } from '../../../src/land/ci';
import type { SessionRequest, SessionResult, SessionRunner } from '../../../src/runctl/session';
import { git, gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

export { git, gitRepo, tempHome, type TempHome };

export function put(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function commitAll(root: string, msg = 'change'): string {
  git(root, ['add', '-A']);
  const c = git(root, ['commit', '-q', '-m', msg]);
  if (c.code !== 0) throw new Error(`commit failed: ${c.stderr}`);
  return sha(root, 'HEAD');
}

export function sha(root: string, ref: string): string {
  return git(root, ['rev-parse', ref]).stdout.trim();
}

export function tree(root: string, ref: string): string {
  return git(root, ['rev-parse', `${ref}^{tree}`]).stdout.trim();
}

/** Hermetic git for the code under test (no global or system config). */
export function hermeticGit(home: TempHome): void {
  const empty = path.join(home.root, 'gitconfig-empty');
  fs.writeFileSync(empty, '');
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
}

export interface Fixture {
  home: TempHome;
  root: string;
  repoId: string;
  taskId: string;
  wt: string;
  main0: string;
  taskFile: string;
}

export function ledgerTaskText(id: string, title: string, extra: Partial<LedgerTask> = {}): string {
  return renderTask({ id, title, priority: 1, status: 'todo', depends_on: [], paths: ['src'], acceptance: ['a is 42'], body: `\n# ${title}\n`, ...extra } as LedgerTask);
}

/**
 * main: README, src/a.js, src/b.js, docs/notes.md and tasks/<id>-demo.md;
 * task/<id> in a worktree with one commit changing src/a.js.
 */
export function landingFixture(taskId = 'T-001', opts: { prefix?: string; noTaskCommit?: boolean } = {}): Fixture {
  const home = tempHome(opts.prefix ?? 'harness-land-');
  hermeticGit(home);
  const root = gitRepo(path.join(home.workspace, 'repo'), {
    'README.md': '# demo\n',
    'src/a.js': 'exports.a = 1;\n',
    'src/b.js': 'exports.b = 2;\n',
    'docs/notes.md': 'notes\n',
  });
  const taskFile = `tasks/${taskId}-demo.md`;
  put(root, taskFile, ledgerTaskText(taskId, 'Make a 42'));
  const main0 = commitAll(root, 'chore: add task');
  const wt = path.join(home.root, 'wt', taskId);
  const w = git(root, ['worktree', 'add', '-q', '-b', `task/${taskId}`, wt, 'main']);
  if (w.code !== 0) throw new Error(`worktree add failed: ${w.stderr}`);
  if (!opts.noTaskCommit) {
    put(wt, 'src/a.js', 'exports.a = 42;\n');
    commitAll(wt, 'feat: make a 42');
  }
  return { home, root, repoId: repoIdFor(root), taskId, wt, main0, taskFile };
}

/** Evidence for the task worktree's run folder; PASS at the branch tip's tree unless told otherwise. */
export function writeEvidence(fx: Fixture, over: Partial<EvidenceFile> = {}): string {
  const p = path.join(runsDir(), repoIdFor(fx.wt), fx.taskId, 'evidence.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const now = new Date().toISOString();
  const ev: EvidenceFile = {
    version: 1,
    repo: repoIdFor(fx.wt),
    task: fx.taskId,
    verdict: 'PASS',
    reasons: [],
    treeHash: tree(fx.wt, 'HEAD'),
    baseSha: fx.main0,
    steps: [{ name: 'tamper', status: 'pass', durationMs: 1 }],
    attempt: 1,
    startedAt: now,
    finishedAt: now,
    e2e: [],
    ...over,
  };
  fs.writeFileSync(p, JSON.stringify(ev, null, 2));
  return p;
}

export type ScriptedGate = GateRunner & { calls: GateCall[] };

/** A gate that answers PASS at the tree of the repo's HEAD unless `fn` says otherwise. */
export function scriptedGate(fn?: (call: GateCall, n: number) => Partial<GateOutcome> | undefined): ScriptedGate {
  const calls: GateCall[] = [];
  return {
    calls,
    async run(call) {
      calls.push(call);
      const base: GateOutcome = {
        exitCode: 0,
        verdict: call.steps?.length ? null : 'PASS',
        partial: !!call.steps?.length,
        steps: (call.steps ?? ['tamper', 'secrets']).map((s) => ({ name: s, status: 'pass' as const })),
        reasons: [],
        evidencePath: null,
        treeHash: tree(call.repo, 'HEAD'),
        report: '',
      };
      return { ...base, ...(fn?.(call, calls.length) ?? {}) };
    },
    async proveRed() {
      return { ok: true, detail: 'scripted' };
    },
  };
}

export type ScriptedCi = CiProvider & { calls: CiCheck[] };

/** A CI that answers the given statuses in order (the last one repeats). */
export function scriptedCi(statuses: CiStatus[], canRerun = true): ScriptedCi {
  const calls: CiCheck[] = [];
  return {
    name: 'local',
    canRerun,
    calls,
    async wait(c): Promise<CiResult> {
      calls.push(c);
      const st = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      const ev = path.join(runsDir(), c.repoId, c.taskId, `ci-${c.n}-${c.kind}.json`);
      fs.mkdirSync(path.dirname(ev), { recursive: true });
      fs.writeFileSync(ev, JSON.stringify({ verdict: st === 'green' ? 'PASS' : 'FAIL', reasons: st === 'red' ? ['tests:base: 1 failed'] : [] }));
      return { status: st, detail: `scripted ${st}`, durationMs: 1, evidencePath: ev, ...(st === 'red' ? { failureText: 'tests:base: test/a.test.js failed' } : {}) };
    },
  };
}

export type ScriptedSession = SessionRunner & { calls: SessionRequest[] };

export function scriptedSession(act?: (req: SessionRequest, n: number) => void | Promise<void>, result: Partial<SessionResult> = {}): ScriptedSession {
  const calls: SessionRequest[] = [];
  return {
    calls,
    available: () => ({ ok: true }),
    async run(req) {
      calls.push(req);
      if (act) await act(req, calls.length);
      return { ok: true, exitCode: 0, timedOut: false, capHit: null, durationMs: 1, detail: 'scripted', costUsd: 0.01, turns: 3, ...result };
    },
  };
}

export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function cleanupEnv(): void {
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
}

/**
 * A scripted gate that also writes evidence.json for full runs, the way the
 * real gate does (verdict, the working tree's hash), so the landing actor
 * can check it.
 */
export function evidenceGate(fn?: (call: GateCall, n: number) => Partial<GateOutcome> | undefined): ScriptedGate {
  const inner = scriptedGate(fn);
  return {
    calls: inner.calls,
    proveRed: inner.proveRed,
    async run(call) {
      const o = await inner.run(call);
      if (call.steps?.length || call.hook || !call.task) return o;
      const { writeTree } = require('../../../src/lib/git') as typeof import('../../../src/lib/git');
      const treeHash = writeTree(call.repo) ?? '';
      const p = path.join(runsDir(), repoIdFor(call.repo), call.task, 'evidence.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const now = new Date().toISOString();
      const prev = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as { attempt?: number }) : null;
      const ev: EvidenceFile = { version: 1, repo: repoIdFor(call.repo), task: call.task, verdict: o.verdict ?? 'FAIL', reasons: o.reasons, treeHash, baseSha: call.base ?? '', steps: o.steps.map((s) => ({ ...s, durationMs: 1 })), attempt: (prev?.attempt ?? 0) + 1, startedAt: now, finishedAt: now, e2e: [] };
      fs.writeFileSync(p, JSON.stringify(ev, null, 2));
      return { ...o, treeHash, evidencePath: p, attempt: ev.attempt };
    },
  };
}
