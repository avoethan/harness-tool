import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempHome, git, type TempHome } from '../lifecycle/helpers';
import { capture } from '../commands/capture';
import { main } from '../../../src/commands/selfcheck';
import { COMMANDS } from '../../../src/cli';
import { CODEX_STEPS, DEVIN_STEPS, SELFCHECK_DOCS, loadSelfcheck, outcomeOf, summarise } from '../../../src/report/selfcheck';
import { BLOCK_BEGIN, BLOCK_END, PROBE_MARK, TAIL_OFFSET, loadProbeManifest, probeHook, probeLogPath, readProbeLog, removeProbes, setStopMode, summariseProbeLog, writeProbes } from '../../../src/report/probes';
import { sha256File } from '../../../src/lib/hash';
import { packageRoot } from '../../../src/lib/paths';

let h: TempHome;
let devinHome: string;
let codexHome: string;
before(() => {
  h = tempHome('harness-selfcheck-');
  delete process.env.XDG_CONFIG_HOME;
  devinHome = path.join(h.userHome, '.config', 'devin');
  codexHome = path.join(h.userHome, '.codex');
});
after(() => h.cleanup());

function resetHomes(): void {
  fs.rmSync(devinHome, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
  fs.rmSync(path.join(h.harnessHome, 'selfcheck'), { recursive: true, force: true });
  fs.rmSync(path.join(h.userHome, '.git'), { recursive: true, force: true });
  fs.mkdirSync(devinHome, { recursive: true });
}

const HARNESS_HOOKS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^(exec|edit)$', hooks: [{ type: 'command', command: 'node "/opt/h/dist/src/hook.js" PreToolUse --agent devin', timeout: 20 }] }] }, permissions: { deny: ['x'] } }, null, 2) + '\n';
const ALWAYS_ON = '# My own notes\n\n<!-- harness:begin -->\n## How work is done here (harness)\n<!-- harness:end -->\n';

test('record: steps by number, outcome from the first word, unknown steps refused, list and summary', async () => {
  resetHomes();
  assert.equal(outcomeOf('pass: saw it'), 'expected');
  assert.equal(outcomeOf('OK'), 'expected');
  assert.equal(outcomeOf('fail - no marker'), 'different');
  assert.equal(outcomeOf('different: 2 blocks only'), 'different');
  assert.equal(outcomeOf('saw titles only'), 'noted');
  let r = await capture(() => main(['record', '--agent', 'devin', '--step', '4', '--result', 'pass: both markers']));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Recorded devin step 4 \(Markers in a session on the workspace folder.*\): as expected/);
  r = await capture(() => main(['record', '--agent', 'devin', '--step', '10', '--result', 'fail: only 2 in a row']));
  assert.match(r.stdout, /DIFFERENT/);
  r = await capture(() => main(['record', '--agent', 'devin', '--step', '15', '--result', 'titles only', '--outcome', 'noted']));
  assert.equal(r.code, 0);
  r = await capture(() => main(['record', '--agent', 'devin', '--step', '17', '--result', 'pass']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no step 17 in the devin self-check \(steps 1 to 16\)/);
  r = await capture(() => main(['record', '--agent', 'claude', '--step', '1', '--result', 'pass']));
  assert.equal(r.code, 2);
  r = await capture(() => main(['record', '--agent', 'devin', '--step', '4']));
  assert.equal(r.code, 2);
  const f = loadSelfcheck('devin')!;
  assert.deepEqual(Object.keys(f.steps).sort(), ['10', '15', '4']);
  assert.equal(f.steps['4'].result, 'pass: both markers');
  assert.deepEqual(summarise('devin'), { steps: 16, recorded: 3, confirmed: ['markers'], different: ['stop-consecutive'] });
  const list = await capture(() => main(['list', '--agent', 'devin']));
  assert.equal(list.code, 0);
  assert.match(list.stdout, /devin self-check \(.*selfcheck\/devin-desktop\.md\): 3 of 16 step\(s\) recorded/);
  assert.match(list.stdout, / 4\. as expected +Markers in a session/);
  assert.match(list.stdout, /10\. DIFFERENT +Consecutive Stop blocks/);
  assert.match(list.stdout, / 1\. not run +Devin Local version/);
  const json = await capture(() => main(['--json']));
  assert.deepEqual(JSON.parse(json.stdout).map((a: { agent: string }) => a.agent), ['devin', 'codex']);
});

test('probe-files devin: writes the marker block and probe hooks at user level, manifest-tracked; --remove restores the bytes', async () => {
  resetHomes();
  fs.writeFileSync(path.join(devinHome, 'config.json'), HARNESS_HOOKS);
  fs.writeFileSync(path.join(devinHome, 'AGENTS.md'), ALWAYS_ON);
  const before = { cfg: sha256File(path.join(devinHome, 'config.json')), md: sha256File(path.join(devinHome, 'AGENTS.md')) };
  const w = await capture(() => main(['probe-files', '--agent', 'devin']));
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /SessionStart marker for this probe: MARKER-HOOK-START-[0-9A-F]{6}/);
  const m = loadProbeManifest('devin')!;
  assert.equal(m.entries.length, 2);
  assert.deepEqual(m.entries.map((e) => [e.kind, path.basename(e.path), e.created, e.beforeSha]), [
    ['block', 'AGENTS.md', false, before.md],
    ['hooks', 'config.json', false, before.cfg],
  ]);
  for (const e of m.entries) {
    assert.equal(sha256File(e.path), e.afterSha);
    assert.ok(e.backup && fs.existsSync(e.backup), 'byte copy kept');
  }
  const md = fs.readFileSync(path.join(devinHome, 'AGENTS.md'), 'utf8');
  assert.ok(md.startsWith(ALWAYS_ON), "the user's text and the harness block stay first");
  assert.match(md, /MARKER-GLOBAL-PROBE/);
  assert.ok(Buffer.byteLength(md.slice(0, md.indexOf('MARKER-TAIL-PROBE'))) >= TAIL_OFFSET, 'tail marker after byte 17,000');
  const cfg = JSON.parse(fs.readFileSync(path.join(devinHome, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.permissions, { deny: ['x'] });
  assert.equal(cfg.hooks.PreToolUse.length, 2, 'the harness entry stays; the probe is added');
  assert.equal(cfg.hooks.PreToolUse[0].hooks[0].command, 'node "/opt/h/dist/src/hook.js" PreToolUse --agent devin');
  for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) {
    const probe = cfg.hooks[ev].find((g: { hooks: Array<{ command: string }> }) => g.hooks[0].command.includes(PROBE_MARK));
    assert.ok(probe, `probe hook for ${ev}`);
    assert.ok(fs.existsSync(/node "([^"]+)"/.exec(probe.hooks[0].command)![1]), 'the probe command runs the built CLI');
  }
  assert.equal(cfg.hooks.Stop[0].hooks[0].timeout, 3);
  // A second run changes nothing.
  const again = await capture(() => main(['probe-files', '--agent', 'devin']));
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already in place/);
  const rm = await capture(() => main(['probe-files', '--agent', 'devin', '--remove']));
  assert.equal(rm.code, 0, rm.stderr);
  assert.match(rm.stdout, /restored byte for byte[\s\S]*restored byte for byte/);
  assert.equal(sha256File(path.join(devinHome, 'config.json')), before.cfg);
  assert.equal(sha256File(path.join(devinHome, 'AGENTS.md')), before.md);
  assert.equal(loadProbeManifest('devin'), null);
  assert.equal(fs.existsSync(path.join(h.harnessHome, 'selfcheck', 'backup')), false);
  const none = await capture(() => main(['probe-files', '--agent', 'devin', '--remove']));
  assert.match(none.stdout, /nothing to remove/);
});

test('probe-files --remove after the user edited the files takes out only the probe parts', () => {
  resetHomes();
  fs.writeFileSync(path.join(devinHome, 'config.json'), HARNESS_HOOKS);
  fs.writeFileSync(path.join(devinHome, 'AGENTS.md'), ALWAYS_ON);
  assert.equal(writeProbes('devin').code, 0);
  fs.appendFileSync(path.join(devinHome, 'AGENTS.md'), 'A line the user added afterwards.\n');
  const cfg = JSON.parse(fs.readFileSync(path.join(devinHome, 'config.json'), 'utf8'));
  cfg.model = 'user-choice';
  fs.writeFileSync(path.join(devinHome, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const r = removeProbes('devin');
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /only the probe block was taken out/.test(l)));
  assert.ok(r.lines.some((l) => /only the probe hook entries were taken out/.test(l)));
  assert.equal(fs.readFileSync(path.join(devinHome, 'AGENTS.md'), 'utf8'), ALWAYS_ON + 'A line the user added afterwards.\n');
  const after = JSON.parse(fs.readFileSync(path.join(devinHome, 'config.json'), 'utf8'));
  assert.equal(after.model, 'user-choice');
  assert.deepEqual(after.hooks, JSON.parse(HARNESS_HOOKS).hooks);
  assert.ok(!JSON.stringify(after).includes(PROBE_MARK.trim()));
});

test('probe-files refuses a target inside a git repository, and a settings file with comments; nothing is written', () => {
  resetHomes();
  fs.writeFileSync(path.join(devinHome, 'AGENTS.md'), ALWAYS_ON);
  assert.equal(git(h.userHome, ['init', '-q']).code, 0);
  const r = writeProbes('devin');
  assert.equal(r.code, 4);
  assert.match(r.lines[0], /^Refused: .*AGENTS\.md lies inside a git repository/);
  assert.equal(fs.readFileSync(path.join(devinHome, 'AGENTS.md'), 'utf8'), ALWAYS_ON);
  assert.equal(loadProbeManifest('devin'), null);
  fs.rmSync(path.join(h.userHome, '.git'), { recursive: true, force: true });
  fs.writeFileSync(path.join(devinHome, 'config.json'), '{\n  // my comment\n  "hooks": {}\n}\n');
  const c = writeProbes('devin');
  assert.equal(c.code, 1);
  assert.match(c.lines[0], /is not plain JSON/);
  assert.match(c.lines[1], /selfcheck probe-hook SessionStart --agent devin/);
  assert.equal(fs.readFileSync(path.join(devinHome, 'AGENTS.md'), 'utf8'), ALWAYS_ON);
  assert.equal(loadProbeManifest('devin'), null);
});

test('probe-files codex creates hooks.json when absent and --remove deletes it', () => {
  resetHomes();
  const r = writeProbes('codex');
  assert.equal(r.code, 0, r.lines.join('\n'));
  const file = path.join(codexHome, 'hooks.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(doc.hooks), ['SessionStart', 'PreToolUse']);
  assert.equal(doc.hooks.PreToolUse[0].matcher, '.*');
  assert.equal(loadProbeManifest('codex')!.entries[0].created, true);
  assert.equal(removeProbes('codex').ok, true);
  assert.equal(fs.existsSync(file), false);
});

test('the probe hook records names only, prints the SessionStart marker, and runs the Stop modes', async () => {
  resetHomes();
  writeProbes('devin');
  const nonce = loadProbeManifest('devin')!.nonce;
  const secret = 'value-that-must-not-be-logged-7731';
  let o = await probeHook('PreToolUse', 'devin', JSON.stringify({ session_id: 's', tool_name: 'write', tool_input: { file_path: `/x/${secret}.ts`, content: secret } }));
  assert.equal(o.code, 0);
  o = await probeHook('SessionStart', 'devin', JSON.stringify({ cwd: h.workspace }), { DEVIN_PROJECT_DIR: h.workspace, DEVIN_SESSION_ID: secret, OTHER_VAR: secret });
  assert.equal(o.code, 0);
  assert.deepEqual(JSON.parse(o.stdout!), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `MARKER-HOOK-START-${nonce}: this line comes from the harness self-check SessionStart probe hook.` } });
  setStopMode('devin', 'block');
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = await probeHook('Stop', 'devin', JSON.stringify({ stop_hook_active: i > 0 }));
    codes.push(s.code);
    if (s.code === 2) assert.deepEqual(JSON.parse(s.stdout!), { decision: 'block', reason: `MARKER-STOP-PROBE ${i + 1} of 3: reply with the single word CONTINUE-${i + 1}, then finish again.` });
  }
  assert.deepEqual(codes, [2, 2, 2, 0]);
  setStopMode('devin', 'slow');
  process.env.HARNESS_PROBE_SLOW_MS = '20';
  try {
    assert.equal((await probeHook('Stop', 'devin', '{}', process.env)).code, 0);
  } finally {
    delete process.env.HARNESS_PROBE_SLOW_MS;
  }
  const raw = fs.readFileSync(probeLogPath('devin'), 'utf8');
  assert.ok(!raw.includes(secret), 'no value, path or variable content in the probe log');
  assert.ok(!raw.includes(h.workspace), 'no path in the probe log');
  const s = summariseProbeLog(readProbeLog('devin'));
  assert.deepEqual(s.tools, { write: ['content', 'file_path'] });
  assert.equal(s.sessionStarts, 1);
  assert.deepEqual(s.projectDir, { set: 1, notSet: 0, sameAsCwd: 1, isGit: 0, isWorkspaceRoot: 0 });
  assert.deepEqual(s.envNames, ['DEVIN_PROJECT_DIR', 'DEVIN_SESSION_ID']);
  assert.deepEqual({ ...s.stop, stopHookActive: undefined }, { allow: 0, blocks: 3, maxRun: 3, releases: 1, stopHookActive: undefined, slowStarts: 1, slowEnds: 1 });
  assert.deepEqual(s.stop.stopHookActive, ['absent', 'false', 'true']); // the slow stop had no field
  const log = await capture(() => main(['probe-log', '--agent', 'devin']));
  assert.match(log.stdout, /tool_input field names per tool: write: content, file_path\./);
  assert.match(log.stdout, /3 block\(s\) delivered, longest run 3 in a row, 1 release\(s\) after 3/);
  assert.match(log.stdout, /started 1, finished 1 -> never cut off/);
  const mode = await capture(() => main(['probe-mode', '--agent', 'devin', '--stop', 'sideways']));
  assert.equal(mode.code, 2);
  await capture(() => main(['probe-log', '--agent', 'devin', '--clear']));
  assert.equal(readProbeLog('devin').length, 0);
  removeProbes('devin');
});

test('the self-check documents match the step catalogue, and every harness command they name exists', () => {
  const known = new Set(COMMANDS.map(([n]) => n));
  const subs = new Set(['list', 'record', 'probe-files', 'probe-mode', 'probe-log', 'probe-hook']);
  for (const [agent, steps] of [['devin', DEVIN_STEPS], ['codex', CODEX_STEPS]] as const) {
    const doc = fs.readFileSync(path.join(packageRoot(), SELFCHECK_DOCS[agent]), 'utf8');
    const headings = [...doc.matchAll(/^### Step (\d+) · (.+) \(`([a-z-]+)`\)$/gm)].map((m) => ({ n: Number(m[1]), id: m[3] }));
    assert.deepEqual(headings, steps.map((s) => ({ n: s.n, id: s.id })), `${agent}: headings follow the catalogue`);
    const records = [...doc.matchAll(/harness selfcheck record --agent (\w+) --step (\d+)/g)].map((m) => [m[1], Number(m[2])]);
    for (const s of steps) assert.ok(records.some(([a, n]) => a === agent && n === s.n), `${agent}: step ${s.n} has a record command`);
    assert.ok(records.every(([a]) => a === agent), `${agent}: record commands name the right agent`);
    for (const m of doc.matchAll(/`harness ([a-z-]+)(?: ([a-z][a-z-]*))?[^`]*`/g)) {
      assert.ok(known.has(m[1]), `${agent}: unknown command harness ${m[1]}`);
      if (m[1] === 'selfcheck' && m[2]) assert.ok(subs.has(m[2]), `${agent}: unknown selfcheck subcommand ${m[2]}`);
    }
    for (const section of doc.split(/^### Step /m).slice(1)) {
      for (const part of ['**Do:**', '**Expect:**', '**If different:**', '**Record:**']) assert.ok(section.includes(part), `${agent} step ${section.split(' ')[0]} has ${part}`);
    }
  }
  const readme = fs.readFileSync(path.join(packageRoot(), 'selfcheck', 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`\\| ${DEVIN_STEPS.length} \\|`));
  assert.match(readme, new RegExp(`\\| ${CODEX_STEPS.length} \\|`));
  assert.ok(BLOCK_BEGIN.startsWith('<!--') && BLOCK_END.endsWith('-->'));
});
