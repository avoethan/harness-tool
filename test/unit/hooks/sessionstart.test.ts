import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handle, heartbeatPath } from '../../../src/hooks/SessionStart';
import { verifyCommandFor, dbSummaryLines, integrityLine } from '../../../src/hooks/repoindex';
import { renderOutput } from '../../../src/hook';
import { writeTrail } from '../../../src/runctl/trail';
import { loadSession } from '../../../src/lib/session';
import { defaultConfig, repoIdFor, saveConfig, allowlistHash } from '../../../src/lib/config';
import { writeIntegrity } from '../../../src/lib/integrity';
import type { AgentId } from '../../../src/types';
import { ctxFor, events, makeRepo, sandbox, writeFile, type Sandbox } from './helpers';

let sb: Sandbox;
let repo: string;

before(() => {
  sb = sandbox('harness-start-');
  repo = makeRepo(path.join(sb.tmp, 'ws', 'orders'), { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }), 'pnpm-lock.yaml': '' });
});
after(() => sb.restore());

function trailFor(root: string, taskId: string, intent: string) {
  return writeTrail({
    taskId,
    repoId: repoIdFor(root),
    repoRoot: root,
    agent: 'claude',
    reason: 'PreCompact',
    intent,
    files: [{ rel: 'src/a.ts', ts: '2026-10-19T10:00:00.000Z' }],
    editCount: 2,
    evidence: null,
    next: 'Run `harness gate`.',
    gotchas: [],
  });
}

test('SessionStart records the session and the agent, and writes the heartbeat (all three agents)', async () => {
  for (const agent of ['claude', 'codex', 'devin'] as AgentId[]) {
    const sid = `start-${agent}`;
    const r = await handle({ session_id: sid, hook_event_name: 'SessionStart', source: 'startup', cwd: repo }, ctxFor(agent, 'SessionStart', sid));
    assert.equal(r.exitCode, 0);
    const s = loadSession(sid);
    assert.equal(s.agent, agent);
    assert.equal(s.cwd, repo);
    const hb = JSON.parse(fs.readFileSync(heartbeatPath(agent), 'utf8'));
    assert.equal(hb.agent, agent);
    assert.equal(hb.sessionId, sid);
    assert.ok(Date.now() - Date.parse(hb.at) < 60_000);
    const out = renderOutput(agent, 'SessionStart', r) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(out.hookSpecificOutput.additionalContext, /harness: session context/);
  }
  assert.ok(events().some((e) => e.event === 'session.start'));
});

test('SessionStart prints the open trail of this workspace (not other workspaces, not closed ones) and the repo index', async () => {
  trailFor(repo, 't-orders1', 'Add an idempotency key to order creation');
  const elsewhere = makeRepo(path.join(sb.tmp, 'other-ws', 'x'), { 'a.txt': 'a' });
  trailFor(elsewhere, 't-elsewhere', 'Something in another workspace');
  const r = await handle({ session_id: 'start-trail', source: 'resume', cwd: repo }, ctxFor('claude', 'SessionStart', 'start-trail'));
  const ctx = String(r.additionalContext);
  assert.match(ctx, /Open task trail/);
  assert.match(ctx, /Add an idempotency key to order creation/);
  assert.doesNotMatch(ctx, /another workspace/);
  assert.match(ctx, /Repos \(name: path \| verify\):/);
  assert.ok(ctx.includes(`- orders: ${repo} | verify: \`pnpm test\``), ctx);
  assert.match(ctx, /Done-gate: run `harness gate`/);
  assert.match(ctx, /Database: no target is marked as a test database/);
  assert.match(ctx, /Integrity: not signed yet/);
});

test('SessionStart caps the trail at 40 lines', async () => {
  for (let i = 0; i < 6; i++) trailFor(repo, `t-many-${i}`, `Task number ${i}`);
  const r = await handle({ session_id: 'start-cap', cwd: repo }, ctxFor('codex', 'SessionStart', 'start-cap'));
  const ctx = String(r.additionalContext);
  const start = ctx.indexOf('Open task trail');
  const end = ctx.indexOf('\n\nRepos');
  const trailLines = ctx.slice(start, end).split('\n').slice(1);
  assert.ok(trailLines.length <= 40, `trail printed ${trailLines.length} lines`);
  assert.match(ctx, /trails cut at 40 lines/);
});

test('SessionStart lists every configured repo and the signed DB allowlist', async () => {
  const second = makeRepo(path.join(sb.tmp, 'ws', 'billing'), { Makefile: 'test:\n\techo ok\n' });
  const list = [{ server: 'sql-test', marked: 'test' as const }, { server: 'sql-prod', marked: 'not-test' as const }];
  const cfg = defaultConfig({
    workspaceRoot: path.join(sb.tmp, 'ws'),
    repos: [
      { id: repoIdFor(repo), name: 'orders', path: repo, isGit: true },
      { id: repoIdFor(second), name: 'billing', path: second, isGit: true },
    ],
    db: { allowlist: list, markedHash: '' },
  });
  cfg.db.markedHash = allowlistHash(cfg);
  saveConfig(cfg);
  try {
    const r = await handle({ session_id: 'start-cfg', cwd: path.join(sb.tmp, 'ws') }, ctxFor('devin', 'SessionStart', 'start-cfg'));
    const ctx = String(r.additionalContext);
    assert.ok(ctx.includes(`- billing: ${second} | verify: \`make test\``));
    assert.ok(ctx.includes(`- orders: ${repo} | verify: \`pnpm test\``));
    assert.match(ctx, /Database: test targets sql-test; 1 marked not-test/);
    assert.doesNotMatch(ctx, /signature does not match/);
  } finally {
    fs.rmSync(path.join(sb.hh, 'config.json'), { force: true });
  }
});

test('repo index helpers: verify command order, unsigned allowlist, integrity states', () => {
  const r = makeRepo(path.join(sb.tmp, 'verify'), { 'package.json': JSON.stringify({ scripts: { test: 'x', verify: 'y' } }) });
  assert.equal(verifyCommandFor(r), 'npm run verify');
  const none = makeRepo(path.join(sb.tmp, 'none'), { 'a.txt': '' });
  assert.equal(verifyCommandFor(none), 'harness gate');
  const unsigned = defaultConfig({ db: { allowlist: [{ server: 'h', marked: 'test' }] } });
  assert.match(dbSummaryLines(unsigned).join('\n'), /signature does not match/);
  assert.match(integrityLine(), /not signed yet/);
  saveConfig(defaultConfig());
  writeIntegrity();
  assert.match(integrityLine(), /Integrity: ok/);
  fs.writeFileSync(path.join(sb.hh, 'config.json'), '{"tampered":true}');
  assert.match(integrityLine(), /Integrity: FAILED/);
  fs.rmSync(path.join(sb.hh, 'config.json'), { force: true });
  fs.rmSync(path.join(sb.hh, 'integrity.json'), { force: true });
  writeFile(sb.tmp, 'unused.txt', '');
});
