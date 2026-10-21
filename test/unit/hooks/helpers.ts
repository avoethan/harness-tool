/**
 * Shared fixtures for the hook-runtime tests: a temp HARNESS_HOME and user
 * home, temp git repos, agent payloads for Claude, Codex and Devin, evidence
 * and ledger writers, and the instrumentation log reader.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentId, EvidenceFile, HookEvent, HookInput, Ledger, LedgerRecord } from '../../../src/types';
import type { HookContext } from '../../../src/hook';
import { run } from '../../../src/lib/exec';
import { writeTree } from '../../../src/lib/git';
import { repoIdFor } from '../../../src/lib/config';

export interface Sandbox {
  tmp: string;
  hh: string;
  home: string;
  restore: () => void;
}

const ENV_KEYS = ['HARNESS_HOME', 'HARNESS_USER_HOME', 'HARNESS_NO_INSTRUMENT', 'HARNESS_AGENT', 'HARNESS_REQUIRE_INTEGRITY', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

/** Point HARNESS_HOME and HARNESS_USER_HOME at a fresh temp folder. */
export function sandbox(prefix = 'harness-hooks-'): Sandbox {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const hh = path.join(tmp, 'hh');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HARNESS_HOME = hh;
  process.env.HARNESS_USER_HOME = home;
  delete process.env.HARNESS_NO_INSTRUMENT;
  delete process.env.HARNESS_AGENT;
  delete process.env.HARNESS_REQUIRE_INTEGRITY;
  process.env.GIT_AUTHOR_NAME = 'harness-test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid';
  process.env.GIT_COMMITTER_NAME = 'harness-test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
  return {
    tmp,
    hh,
    home,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function git(cwd: string, ...args: string[]): string {
  const r = run('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeoutMs: 30000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A git repo on branch `main` with the given files committed. */
export function makeRepo(dir: string, files: Record<string, string>, branch = 'main'): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'harness-test');
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function writeFile(root: string, rel: string, content: string, mode?: number): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mode !== undefined) fs.chmodSync(p, mode);
  return p;
}

export function ctxFor(agent: AgentId, event: HookEvent, sessionId: string): HookContext {
  return { agent, event, sessionId };
}

/** Edit payloads in each agent's dialect. */
export const payload = {
  claudeEdit: (sid: string, file: string, cwd: string): HookInput => ({
    session_id: sid,
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
    tool_response: { filePath: file, success: true },
  }),
  claudeWrite: (sid: string, file: string, cwd: string): HookInput => ({ session_id: sid, hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }),
  codexPatch: (sid: string, rels: string[], cwd: string): HookInput => ({
    session_id: sid,
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: 'apply_patch',
    tool_input: { input: ['*** Begin Patch', ...rels.flatMap((r) => [`*** Update File: ${r}`, '@@', '-old', '+new']), '*** End Patch'].join('\n') },
  }),
  devinEdit: (sid: string, file: string, cwd: string): HookInput => ({ session_id: sid, hook_event_name: 'PostToolUse', cwd, tool_name: 'edit', tool_input: { path: file } }),
  bash: (sid: string, command: string, cwd: string, tool = 'Bash'): HookInput => ({ session_id: sid, hook_event_name: 'PostToolUse', cwd, tool_name: tool, tool_input: { command } }),
};

export function writeEvidence(repoRoot: string, taskId: string, ev: Partial<EvidenceFile>, setCurrent = true): string {
  const repoId = repoIdFor(repoRoot);
  const dir = path.join(process.env.HARNESS_HOME as string, 'runs', repoId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const full: EvidenceFile = {
    version: 1,
    repo: repoId,
    task: taskId,
    verdict: 'PASS',
    reasons: [],
    treeHash: '',
    baseSha: '',
    steps: [],
    attempt: 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    e2e: [],
    ...ev,
  };
  const p = path.join(dir, 'evidence.json');
  fs.writeFileSync(p, JSON.stringify(full, null, 2));
  if (setCurrent) fs.writeFileSync(path.join(process.env.HARNESS_HOME as string, 'runs', repoId, 'current-task'), taskId + '\n');
  return p;
}

export function treeOf(root: string): string {
  const t = writeTree(root);
  if (!t) throw new Error('write-tree failed');
  return t;
}

export function record(id: string, repoId: string, over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    id,
    statement: `Statement for ${id}.`,
    family: 'other',
    scope: { repos: [repoId] },
    tier: 'counted-strong',
    confidence: 0.9,
    evidence: { sites: 10, conforming: 10, packages: 1, examples: [], sources: [] },
    check: { type: 'judgment', mode: 'warn' },
    conflicts: [],
    provenance: [],
    history: { firstSeen: '2026-01-01', lastCounted: '2026-01-01', disputes: 0 },
    ...over,
  };
}

export function writeLedger(records: LedgerRecord[]): void {
  const l: Ledger = { version: 1, generatedAt: new Date().toISOString(), workspaceRoot: '/', records, skipped: [], scanners: [] };
  const p = path.join(process.env.HARNESS_HOME as string, 'ledger', 'ledger.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(l));
}

export function events(): Array<Record<string, unknown>> {
  const p = path.join(process.env.HARNESS_HOME as string, 'logs', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function eventsText(): string {
  const p = path.join(process.env.HARNESS_HOME as string, 'logs', 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** A fake ESLint (node script) that reports `no-console` for every console.log line and leaves a marker when it runs. */
export const FAKE_ESLINT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const file = process.argv[process.argv.length - 1];
fs.writeFileSync(path.join(process.cwd(), '.fake-eslint-ran'), String(Date.now()));
const src = fs.readFileSync(file, 'utf8');
const messages = [];
src.split('\\n').forEach((l, i) => {
  if (l.includes('console.log')) messages.push({ ruleId: 'no-console', severity: 2, message: 'Unexpected console statement.', line: i + 1 });
  if (l.includes('var ')) messages.push({ ruleId: 'no-var', severity: 2, message: 'Unexpected var, use let or const instead.', line: i + 1 });
});
process.stdout.write(JSON.stringify([{ filePath: file, messages, errorCount: messages.length, warningCount: 0 }]));
process.exit(messages.length ? 1 : 0);
`;

/** A fake Prettier: `--check <file>` fails when the file contains the word UNFORMATTED. */
export const FAKE_PRETTIER = `#!/usr/bin/env node
const fs = require('fs');
const file = process.argv[process.argv.length - 1];
const src = fs.readFileSync(file, 'utf8');
if (src.includes('UNFORMATTED')) { process.stdout.write('[warn] ' + file + '\\n'); process.exit(1); }
process.exit(0);
`;

/** A repo with a tiny flat ESLint config, a Prettier config and the fake binaries (node_modules ignored). */
export function lintRepo(dir: string, extra: Record<string, string> = {}): string {
  makeRepo(dir, {
    '.gitignore': 'node_modules/\n.fake-eslint-ran\n',
    'eslint.config.mjs': 'export default [{ rules: { "no-console": "error", "no-var": "error" } }];\n',
    '.prettierrc.json': '{}\n',
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
    'src/ok.ts': 'export const ok = 1;\n',
    ...extra,
  });
  writeFile(dir, 'node_modules/.bin/eslint', FAKE_ESLINT, 0o755);
  writeFile(dir, 'node_modules/.bin/prettier', FAKE_PRETTIER, 0o755);
  return dir;
}
