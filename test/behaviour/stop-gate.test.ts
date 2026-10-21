/**
 * Behaviour: the Stop hook holds a real Claude Code session until the gate
 * has evidence. An isolated HOME registers the harness PostToolUse and Stop
 * hooks; `claude -p` (haiku, few turns) edits a file in a temp repo and tries
 * to stop. Expected: the first stop is blocked with "run `harness gate`",
 * the agent runs the gate, and the run ends (by fresh evidence, the cap, or
 * the unchanged-tree release).
 *
 * The gate itself is another component; this test puts a stand-in
 * `harness` on PATH whose `gate` writes PASS evidence for the current tree
 * (the same write-tree the Stop hook compares against) and leaves a marker.
 * Skips with a reason when `claude` is not available.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeAvailable, harnessHookEntry, runClaude } from './claude-runner';
import { hookEntryPath } from '../../src/lib/paths';
import { run } from '../../src/lib/exec';

const distSrc = path.resolve(__dirname, '..', '..', 'src');

function fakeHarness(binDir: string, hh: string): string {
  const marker = path.join(hh, 'fake-gate-runs.txt');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { writeTree, nearestRepoRoot } = require(${JSON.stringify(path.join(distSrc, 'lib', 'git'))});
const { repoIdFor } = require(${JSON.stringify(path.join(distSrc, 'lib', 'config'))});
const args = process.argv.slice(2);
if (args[0] !== 'gate') { console.log('stand-in harness: only "gate" is available here'); process.exit(2); }
const i = args.indexOf('--repo');
const root = nearestRepoRoot(i >= 0 ? args[i + 1] : process.cwd());
if (!root) { console.log('not in a repository'); process.exit(1); }
const home = process.env.HARNESS_HOME;
const id = repoIdFor(root);
const dir = path.join(home, 'runs', id, 't-behaviour');
fs.mkdirSync(dir, { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ version: 1, repo: id, task: 't-behaviour', verdict: 'PASS', reasons: [], treeHash: writeTree(root), baseSha: '', steps: [], attempt: 1, startedAt: now, finishedAt: now, e2e: [] }));
fs.writeFileSync(path.join(home, 'runs', id, 'current-task'), 't-behaviour\\n');
fs.appendFileSync(${JSON.stringify(marker)}, now + '\\n');
console.log('harness gate: PASS (all checks passed; evidence written)');
`;
  fs.mkdirSync(binDir, { recursive: true });
  const p = path.join(binDir, 'harness');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return marker;
}

test('behaviour: claude -p is held by the Stop hook until `harness gate` has evidence', (t) => {
  const avail = claudeAvailable();
  if (!avail.ok) return t.skip(`skipped: ${avail.reason}`);
  if (process.platform === 'win32') return t.skip('skipped: the stand-in gate script needs a POSIX shebang');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stopgate-')));
  const repo = path.join(tmp, 'repo');
  const hh = path.join(tmp, 'hh');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) => run('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: repo, timeoutMs: 20000 });
  g('init', '-q', '-b', 'feature');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'harness-test');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first line\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const marker = fakeHarness(path.join(tmp, 'bin'), hh);
  fs.mkdirSync(hh, { recursive: true });
  const hookJs = hookEntryPath();
  try {
    const r = runClaude({
      prompt: 'Use the Edit tool to append a new line containing exactly "second line" to notes.txt in the current folder. Then you are done. If a hook tells you to run a command before stopping, run exactly that command with the Bash tool, then stop.',
      cwd: repo,
      maxTurns: 10,
      model: 'claude-haiku-5-5',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Edit', 'Write', 'Bash(harness gate:*)', 'Bash(harness:*)'],
      userSettings: {
        hooks: {
          PostToolUse: [harnessHookEntry(hookJs, 'PostToolUse', 'Edit|Write|MultiEdit|Bash', 20)],
          Stop: [harnessHookEntry(hookJs, 'Stop', undefined, 5)],
        },
      },
      env: { HARNESS_HOME: hh, HARNESS_AGENT: 'claude', PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
      timeoutMs: 240000,
    });
    const eventsPath = path.join(hh, 'logs', 'events.jsonl');
    const events = fs.existsSync(eventsPath)
      ? fs
          .readFileSync(eventsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { event: string; counts?: Record<string, number> })
      : [];
    const stops = events.filter((e) => e.event.startsWith('stop.')).map((e) => e.event);
    const gateRuns = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0;
    // The transcript, when Claude kept one in the isolated HOME, shows the block reason the agent saw.
    let transcriptHasReason: boolean | null = null;
    const projects = path.join(r.home, '.claude', 'projects');
    if (fs.existsSync(projects)) {
      const files: string[] = [];
      for (const d of fs.readdirSync(projects)) for (const f of fs.readdirSync(path.join(projects, d))) if (f.endsWith('.jsonl')) files.push(path.join(projects, d, f));
      if (files.length) transcriptHasReason = files.some((f) => fs.readFileSync(f, 'utf8').includes('harness gate'));
    }
    const summary = `claude ${avail.version}: exit=${r.exitCode} turns=${r.numTurns} cost_usd=${r.costUsd} stops=[${stops.join(', ')}] gate_runs=${gateRuns} transcript_has_reason=${transcriptHasReason}`;
    t.diagnostic(summary);
    process.stdout.write(`# ${summary}\n`);

    assert.ok(r.ok, `claude failed: ${r.stderr.slice(0, 400)}`);
    assert.match(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), /second line/, 'the edit happened');
    assert.ok(events.some((e) => e.event === 'post.tool' && (e.counts?.edits ?? 0) > 0), 'PostToolUse logged the edit');
    assert.equal(stops[0], 'stop.block', 'the first stop was blocked');
    const last = stops[stops.length - 1];
    assert.ok(['stop.pass', 'stop.cap', 'stop.unchanged'].includes(last), `the run ended by evidence, the cap or the unchanged release (last: ${last})`);
    if (last === 'stop.pass') assert.ok(gateRuns >= 1, 'a pass came from gate evidence');
    if (transcriptHasReason !== null) assert.ok(transcriptHasReason, 'the transcript carries the "harness gate" block reason');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
