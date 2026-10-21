/**
 * Shared fixtures for the guard tests: a synthetic home, protected roots,
 * a signed DB allowlist, and table runners.
 */
import * as assert from 'node:assert/strict';
import { evaluate, type GuardDecision, type GuardInput } from '../../../src/guard';
import { hashJson } from '../../../src/lib/hash';
import type { DbTarget, Setting } from '../../../src/types';

export const HOME = '/home/u';
export const REPO = '/work/repo';
export const PKG = '/opt/harness-pkg';

export const ALLOWLIST: DbTarget[] = [
  { server: 'sql-test', marked: 'test' },
  { server: 'localhost', marked: 'test' },
  { server: 'sql-prod', marked: 'not-test' },
  { server: 'ctr-db', marked: 'test' },
  { server: 'ported,1433', marked: 'test' },
  { server: 'dbonly', database: 'db1', marked: 'test' },
];

export function signedDb(list: DbTarget[] = ALLOWLIST) {
  return { allowlist: list, markedHash: hashJson(list) };
}

export const PROTECTED = [
  HOME + '/.harness',
  HOME + '/.claude',
  HOME + '/.codex',
  HOME + '/.config/devin',
  HOME + '/.devin',
  HOME + '/.agents/skills',
  PKG,
  HOME + '/.claude.json',
  'C:/Users/u/AppData/Roaming/devin',
  'C:/Users/u/.claude',
  'C:/Users/u/.harness',
  'C:/Users/u/.codex',
];

export type Extra = Partial<GuardInput>;

export function baseInput(setting: Setting = 'personal', extra: Extra = {}): Omit<GuardInput, 'toolName' | 'toolInput'> {
  return {
    agent: 'claude',
    setting,
    env: { HOME, HARNESS_HOME: HOME + '/.harness', APPDATA: 'C:/Users/u/AppData/Roaming', USERPROFILE: 'C:/Users/u', TMPDIR: '/tmp' },
    config: { db: signedDb(), mcp: { allowedServers: { 'test-db': ['sql-test', 'ctr-db'], any: ['*'], empty: [] } } },
    protectedRoots: PROTECTED,
    repoRoot: REPO,
    cwd: REPO,
    userHome: HOME,
    platform: 'linux',
    ...extra,
  };
}

export function run(command: string, setting: Setting = 'personal', extra: Extra = {}): GuardDecision {
  return evaluate({ ...baseInput(setting, extra), toolName: 'Bash', toolInput: { command } });
}

export function tool(toolName: string, toolInput: unknown, setting: Setting = 'personal', extra: Extra = {}): GuardDecision {
  return evaluate({ ...baseInput(setting, extra), toolName, toolInput });
}

export type Case = [command: string, setting: Setting, want: 'allow' | 'deny', rail?: string];

/** Run a table and assert every row; the failure message names the row. */
export function runTable(cases: Case[], extra: Extra = {}): number {
  const failures: string[] = [];
  for (const [cmd, setting, want, rail] of cases) {
    const r = run(cmd, setting, extra);
    if (r.decision !== want) {
      failures.push(`[${setting}] ${JSON.stringify(cmd)} -> ${r.decision}, want ${want} (${r.rail}: ${r.reason})`);
      continue;
    }
    if (rail && r.rail !== rail) failures.push(`[${setting}] ${JSON.stringify(cmd)} rail ${r.rail} != ${rail} (${r.reason})`);
    if (want === 'deny') {
      if (r.reason.length <= 20) failures.push(`reason too short for ${JSON.stringify(cmd)}: ${r.reason}`);
      if (/\n/.test(r.reason)) failures.push(`reason has newlines for ${JSON.stringify(cmd)}`);
    }
  }
  // Report every failing row at once so a run shows the whole gap, not the first miss.
  assert.equal(failures.length, 0, `${failures.length} of ${cases.length} rows failed:\n  ${failures.join('\n  ')}`);
  return cases.length;
}

export function b64utf16(s: string): string {
  return Buffer.from(s, 'utf16le').toString('base64');
}
