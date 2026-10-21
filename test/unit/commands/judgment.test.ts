/**
 * `harness judgment submit`: the channel through which the driving agent hands
 * a judgment result to the harness, while the self-protection rail keeps
 * denying agent file tools in ~/.harness.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run as exec } from '../../../src/lib/exec';
import { evaluate } from '../../../src/guard';
import { bundleKind, importCommand, submitJudgment } from '../../../src/commands/judgment';

const CLI = path.resolve(__dirname, '..', '..', '..', 'src', 'cli.js');

function withHome<T>(fn: (hh: string) => T): T {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-judgment-')));
  const hh = path.join(root, '.harness');
  fs.mkdirSync(hh, { recursive: true });
  const prev = { HARNESS_HOME: process.env.HARNESS_HOME, HARNESS_USER_HOME: process.env.HARNESS_USER_HOME, HARNESS_NO_INSTRUMENT: process.env.HARNESS_NO_INSTRUMENT };
  process.env.HARNESS_HOME = hh;
  process.env.HARNESS_USER_HOME = root;
  process.env.HARNESS_NO_INSTRUMENT = '1';
  try {
    return fn(hh);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function bundle(hh: string, id: string, data: Record<string, unknown>): string {
  const dir = path.join(hh, 'judgment', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({ version: 1, id, ...data }));
  fs.writeFileSync(path.join(dir, 'prompt.md'), '# prompt\n');
  return dir;
}

test('bundle kind and the import command that follows', () => {
  assert.equal(bundleKind({ kind: 'learn' }), 'learn');
  assert.equal(bundleKind({ reportSha256: 'ab' }), 'assess');
  assert.equal(bundleKind({ excerpts: [] }), 'discover');
  assert.equal(importCommand('assess', 'a1'), 'harness assess --import-judgment a1');
  assert.equal(importCommand('learn', 'lj1'), 'harness learn --import-judgment lj1');
  assert.equal(importCommand('discover', 'j1', '/w s'), 'harness discover --root "/w s" --import-judgment j1');
});

test('submit saves a valid result next to the prompt and names the import', () => {
  withHome((hh) => {
    const dir = bundle(hh, 'a20261019-abc', { reportSha256: 'ff' });
    const r = submitJudgment('a20261019-abc', '{"version":1,"bundleId":"a20261019-abc","items":[]}');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.kind, 'assess');
    assert.equal(r.next, 'harness assess --import-judgment a20261019-abc');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')), { version: 1, bundleId: 'a20261019-abc', items: [] });
    // a second submit replaces an assess result (the import re-validates it)
    const again = submitJudgment('a20261019-abc', '{"version":1,"items":[{"id":"q1","decision":"none"}]}');
    assert.equal(again.ok, true);
    assert.equal(again.replaced, true);
  });
});

test('submit refuses what could harm the state: bad ids, missing bundles, non-JSON, wrong version, hidden Unicode, oversize', () => {
  withHome((hh) => {
    bundle(hh, 'lj20261019-aaa', { kind: 'learn' });
    for (const id of ['../config', 'a/b', '', '.hidden', 'x'.repeat(200)]) {
      const r = submitJudgment(id, '{"version":1}');
      assert.equal(r.ok, false, `id ${JSON.stringify(id)} must be refused`);
    }
    assert.match(submitJudgment('lj-none', '{"version":1}').error ?? '', /no judgment bundle/);
    assert.match(submitJudgment('lj20261019-aaa', 'not json').error ?? '', /not valid JSON/);
    assert.match(submitJudgment('lj20261019-aaa', '[1]').error ?? '', /"version": 1/);
    assert.match(submitJudgment('lj20261019-aaa', '{"version":2}').error ?? '', /"version": 1/);
    assert.match(submitJudgment('lj20261019-aaa', '{"version":1,"items":["a​b"]}').error ?? '', /hidden Unicode/);
    assert.match(submitJudgment('lj20261019-aaa', JSON.stringify({ version: 1, pad: 'x'.repeat(1024 * 1024) })).error ?? '', /limit/);
    assert.equal(fs.existsSync(path.join(hh, 'judgment', 'lj20261019-aaa', 'result.json')), false, 'nothing was written');
    // nothing outside the judgment folder is reachable through the id
    assert.equal(fs.existsSync(path.join(hh, 'config', 'result.json')), false);
  });
});

test('an imported discovery result is never replaced', () => {
  withHome((hh) => {
    const dir = bundle(hh, 'j20261019-ddd', { excerpts: [] });
    fs.writeFileSync(path.join(dir, 'result.json'), '{"version":1,"candidates":[]}\n');
    fs.writeFileSync(path.join(hh, 'judgment', 'imported.json'), JSON.stringify({ version: 1, ids: ['j20261019-ddd'] }));
    const r = submitJudgment('j20261019-ddd', '{"version":1,"candidates":[{"id":"x.y"}]}');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /already imported/);
    assert.equal(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'), '{"version":1,"candidates":[]}\n');
  });
});

test('the CLI reads the result from a file or from standard input', (t) => {
  if (!fs.existsSync(CLI)) return t.skip(`not built: ${CLI}`);
  withHome((hh) => {
    bundle(hh, 'lj20261019-cli', { kind: 'learn' });
    const env = { ...process.env, HARNESS_HOME: hh, HARNESS_NO_INSTRUMENT: '1' };
    const answer = path.join(path.dirname(hh), 'answer.json');
    fs.writeFileSync(answer, '{"version":1,"bundle":"lj20261019-cli","items":[]}');
    const r1 = exec(process.execPath, [CLI, 'judgment', 'submit', 'lj20261019-cli', '--from', answer], { env, timeoutMs: 20000 });
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(r1.stdout, /Next: harness learn --import-judgment lj20261019-cli/);
    const r2 = exec(process.execPath, [CLI, 'judgment', 'submit', 'lj20261019-cli', '--from', '-'], { env, timeoutMs: 20000, input: '{"version":1,"items":[]}' });
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /replacing the earlier one/);
    const r3 = exec(process.execPath, [CLI, 'judgment', 'submit', 'lj20261019-cli'], { env, timeoutMs: 20000 });
    assert.equal(r3.code, 2, 'usage without --from');
    const r4 = exec(process.execPath, [CLI, 'judgment', 'list'], { env, timeoutMs: 20000 });
    assert.match(r4.stdout, /lj20261019-cli {2}learn {2}result saved/);
  });
});

test('the rail is unchanged: agent file tools still may not write the result; the submit command is not an admin command', () => {
  const base = {
    agent: 'claude' as const,
    setting: 'team' as const,
    env: { HOME: '/home/u', HARNESS_HOME: '/home/u/.harness' },
    config: { db: { allowlist: [] }, mcp: { allowedServers: {} } },
    protectedRoots: ['/home/u/.harness', '/home/u/.claude'],
    userHome: '/home/u',
    cwd: '/work/repo',
    repoRoot: '/work/repo',
    platform: 'linux' as const,
  };
  const write = evaluate({ ...base, toolName: 'Write', toolInput: { file_path: '/home/u/.harness/judgment/j1/result.json', content: '{}' } });
  assert.equal(write.decision, 'deny', 'Write into ~/.harness stays denied');
  const shell = evaluate({ ...base, toolName: 'Bash', toolInput: { command: 'cp /tmp/r.json /home/u/.harness/judgment/j1/result.json' } });
  assert.equal(shell.decision, 'deny', 'copying into ~/.harness stays denied');
  const submit = evaluate({ ...base, toolName: 'Bash', toolInput: { command: 'harness judgment submit j1 --from /tmp/r.json' } });
  assert.notEqual(submit.decision, 'deny', submit.reason);
});
