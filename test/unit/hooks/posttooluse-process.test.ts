/**
 * PostToolUse ledger checks through the real hook process (red-team item:
 * the hook once called discover's runLedgerChecks(ledger, files, opts) with
 * a single options object; the throw was swallowed and no ledger check ran
 * at edit time). Here nothing is stubbed: discovery writes a real ledger and
 * its check specs into a temp HARNESS_HOME, a file that breaks a planted
 * standard is written in the repo, and `dist/src/hook.js PostToolUse` runs
 * as a child process with the agent's JSON on stdin. The injected
 * additionalContext must carry the violated standard's id and statement.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDiscover } from '../../../src/discover/index';
import type { Ledger } from '../../../src/types';
import { syntheticWorkspace, tempEnv, writeTree } from '../discover/helpers';

const HOOK_JS = path.resolve(__dirname, '..', '..', '..', 'src', 'hook.js');

function runHook(event: string, payload: Record<string, unknown>, agent: string, env: NodeJS.ProcessEnv, cwd: string) {
  const r = spawnSync(process.execPath, [HOOK_JS, event, '--agent', agent], { cwd, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return { code: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr ?? '' };
}

test('PostToolUse (hook process): a planted violation in the edited file injects the ledger standard text', async () => {
  const saved = { ...process.env };
  const env = tempEnv('harness-post-proc-');
  try {
    const { alpha } = syntheticWorkspace(env.workspace);
    const res = await runDiscover({ root: env.workspace, exec: false });
    const ledger: Ledger = JSON.parse(fs.readFileSync(path.join(env.harnessHome, 'ledger', 'ledger.json'), 'utf8'));
    assert.ok(ledger.records.length >= res.ledger.records.length, 'discovery wrote the ledger to HARNESS_HOME');
    const naming = ledger.records.find((r) => r.id === 'naming.ts-file-case-kebab');
    assert.ok(naming, 'the synthetic workspace yields the kebab-case file-name standard');
    assert.ok(fs.existsSync(path.join(env.harnessHome, 'ledger', 'checks', 'naming.ts-file-case-kebab.json')), 'its check spec is on disk');

    // The planted violation: a camelCase file name (and a loose equality) in an edited source file.
    const file = path.join(alpha, 'src/lib/orderCsv.ts');
    const content = 'export function same(a: number, b: number): boolean {\n  return a == b;\n}\n';
    writeTree(alpha, { 'src/lib/orderCsv.ts': content });

    const childEnv: NodeJS.ProcessEnv = { ...saved, HARNESS_HOME: env.harnessHome, HARNESS_USER_HOME: path.dirname(env.harnessHome), HOME: path.dirname(env.harnessHome) };
    for (const k of ['HARNESS_NO_INSTRUMENT', 'HARNESS_AGENT', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'CODEX_HOME', 'CODEX_SANDBOX', 'DEVIN_PROJECT_DIR', 'DEVIN_SESSION_ID', 'HARNESS_REQUIRE_INTEGRITY']) delete childEnv[k];
    const payload = {
      session_id: 'post-proc-1',
      hook_event_name: 'PostToolUse',
      cwd: alpha,
      tool_name: 'Write',
      tool_input: { file_path: file, content },
      tool_response: { filePath: file, success: true },
    };
    const r = runHook('PostToolUse', payload, 'claude', childEnv, alpha);
    assert.equal(r.code, 0, `PostToolUse never blocks (stderr: ${r.stderr})`);
    const ctx = String(r.json?.hookSpecificOutput?.additionalContext ?? '');
    assert.match(ctx, /standard naming\.ts-file-case-kebab/, `the violated standard is named in: ${ctx}`);
    assert.ok(ctx.includes(naming!.statement.slice(0, 40)), 'the standard statement from the ledger is quoted');

    // Instrumentation counted the ledger hit (names and counts only).
    const ev = fs
      .readFileSync(path.join(env.harnessHome, 'logs', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === 'post.tool' && e.sessionId === 'post-proc-1');
    assert.ok(ev.length === 1 && ev[0].counts.ledgerHits >= 1, `post.tool counts ledgerHits >= 1: ${JSON.stringify(ev)}`);
    assert.ok(!JSON.stringify(ev).includes('a == b'), 'no file content in the event log');

    // Same session, same rule: not injected twice.
    const again = runHook('PostToolUse', { ...payload, tool_use_id: 'second' }, 'claude', childEnv, alpha);
    assert.doesNotMatch(String(again.json?.hookSpecificOutput?.additionalContext ?? ''), /standard naming\.ts-file-case-kebab/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    env.cleanup?.();
  }
});
