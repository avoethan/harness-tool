/**
 * Acceptance: `harness propose` on a team stand-in's rough starting harness.
 *
 *   HARNESS_STANDIN_TEAM   the stand-in folder (setup.js, rough-harness/,
 *                          expected/assess.json) or its rough-harness/ folder.
 *
 * The stand-in workspace is created in a temp folder (setup.js --no-install
 * --no-db), discovery runs without the repos' own binaries, and the plan is
 * built with the rough harness's fake home as the user home. Every planted
 * defect listed in expected/assess.json must get a hunk with its check id on
 * the right file and line; no quarantined line may appear in any file the
 * plan writes; the always-on files stay within 60 harness-owned lines.
 * Skips with a reason when the variable is unset.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/lib/exec';
import { stripHiddenUnicode } from '../../src/lib/unicode';
import type { PlanTarget } from '../../src/types';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');

interface Defect {
  defect: string;
  file: string;
  lines: number[];
  class: string;
  check: string;
}

function standinDir(): string | null {
  const v = process.env.HARNESS_STANDIN_TEAM;
  if (!v) return null;
  const d = path.resolve(v);
  if (fs.existsSync(path.join(d, 'setup.js'))) return d;
  if (path.basename(d) === 'rough-harness' && fs.existsSync(path.join(d, '..', 'setup.js'))) return path.dirname(d);
  return null;
}

function inRange(prov: string, line: number): boolean {
  const m = /:(\d+)(?:-(\d+))?$/.exec(prov);
  if (!m) return false;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return line >= a && line <= b;
}

test('propose on the team stand-in: every planted defect gets a hunk with its check id', (t) => {
  const standin = standinDir();
  if (!standin) {
    t.skip('HARNESS_STANDIN_TEAM is not set (or does not point at a stand-in with setup.js)');
    return;
  }
  if (!fs.existsSync(CLI)) {
    t.skip(`not built: ${CLI}`);
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-standin-propose-')));
  try {
    const ws = path.join(root, 'ws', 'shop');
    const home = path.join(root, 'ws', 'rough-harness-home');
    const hh = path.join(root, 'harness-home');
    const setup = run(process.execPath, [path.join(standin, 'setup.js'), ws, '--no-install', '--no-db'], { cwd: standin, timeoutMs: 300000 });
    assert.equal(setup.code, 0, setup.stdout + setup.stderr);
    const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: hh, HARNESS_USER_HOME: home, HARNESS_NO_INSTRUMENT: '1', GIT_CONFIG_NOSYSTEM: '1' };
    delete env.XDG_CONFIG_HOME;
    const disc = run(process.execPath, [CLI, 'discover', '--root', ws, '--no-exec', '--json'], { cwd: ws, env, timeoutMs: 300000 });
    assert.equal(disc.code, 0, disc.stderr);
    const t0 = Date.now();
    const prop = run(process.execPath, [CLI, 'propose', '--setting', 'team', '--agents', 'devin,claude,codex', '--workspace', ws, '--json'], { cwd: ws, env, timeoutMs: 300000 });
    const ms = Date.now() - t0;
    assert.equal(prop.code, 0, prop.stderr);
    const out = JSON.parse(prop.stdout) as { id: string; plan: { targets: PlanTarget[]; notes: string[] } };
    const targets = out.plan.targets;
    const expected = JSON.parse(fs.readFileSync(path.join(standin, 'expected', 'assess.json'), 'utf8')) as { defects: Defect[] };
    const where = (f: string) => (f.startsWith('home/') ? path.join(home, f.slice(5)) : path.join(ws, f.replace(/^workspace\//, '')));
    const missing: string[] = [];
    for (const d of expected.defects) {
      const file = where(d.file);
      const target = targets.find((x) => x.path === file);
      const want = d.check === 'safety-inventory' ? 'safety' : d.check;
      const ok = targets.some((x) => x.hunks.some((h) => h.checkId === want && (want === 'safety' ? h.provenance.endsWith(`:${d.lines[0]}`) && x.hunks.length > 0 : x === target && inRange(h.provenance, d.lines[0]))));
      if (!ok) missing.push(`${d.defect} ${d.file}:${d.lines[0]} (${want})`);
    }
    assert.deepEqual(missing, [], `planted defects without a hunk: ${missing.join('; ')}`);
    // no quarantined line in anything the plan writes
    for (const d of expected.defects.filter((x) => x.class === 'QUARANTINE')) {
      const raw = fs.readFileSync(where(d.file), 'utf8').split('\n')[d.lines[0] - 1];
      const visible = stripHiddenUnicode(raw).trim();
      for (const x of targets) if (x.after) assert.ok(!x.after.includes(visible), `quarantined line ${d.file}:${d.lines[0]} appears in ${x.path}`);
    }
    // always-on sizes, reported from the plan itself
    const sizes = targets.flatMap((x) => x.hunks.filter((h) => h.checkId === 'render.alwayson').map((h) => ({ path: x.path, ...(/: (\d+) harness-owned lines, (\d+) bytes/.exec(h.reason) ? { lines: Number(/: (\d+) harness-owned lines/.exec(h.reason)![1]), bytes: Number(/, (\d+) bytes/.exec(h.reason)![1]) } : {}) })));
    for (const s of sizes) assert.ok((s as { lines?: number }).lines! <= 60, `${s.path}: ${(s as { lines?: number }).lines} lines`);
    process.stdout.write(`# standin propose: plan ${out.id}: ${targets.length} targets, ${expected.defects.length} planted defects all with a hunk, propose ${ms} ms; always-on ${sizes.map((s) => `${path.basename(path.dirname(s.path))}/${path.basename(s.path)} ${(s as { lines?: number }).lines} lines ${(s as { bytes?: number }).bytes} bytes`).join(', ')}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
