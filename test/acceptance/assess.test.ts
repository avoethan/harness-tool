/**
 * Acceptance: `harness assess` end to end through the CLI on the workspace
 * fixture (in place, read-only) into a temp HARNESS_HOME, once with an empty
 * fake HOME and once with the fixture HOME. Checks that assess.json has the
 * AssessReport shape and that assess.md is non-empty and quotes at most one
 * line per finding. Skips with a reason when the build is missing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/lib/exec';
import type { AssessReport } from '../../src/types';

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli.js');
const PKG = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(PKG, 'test', 'fixtures', 'assess');

const CLASSES = ['KEEP', 'CONVERT', 'TRIM', 'FIX', 'SPLIT', 'QUARANTINE'];
const AGENTS = ['devin', 'claude', 'codex'];

/** Structural check of an AssessReport; returns the problems found. */
export function shapeProblems(r: unknown): string[] {
  const p: string[] = [];
  const o = r as Record<string, unknown>;
  const isStr = (v: unknown) => typeof v === 'string';
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!o || typeof o !== 'object') return ['not an object'];
  if (o.version !== 1) p.push('version must be 1');
  if (!isStr(o.generatedAt) || Number.isNaN(Date.parse(o.generatedAt as string))) p.push('generatedAt must be an ISO date');
  for (const k of ['files', 'findings', 'classifications', 'safetyRules', 'neverLoaded']) if (!Array.isArray(o[k])) p.push(`${k} must be an array`);
  if (!o.loaded || typeof o.loaded !== 'object') p.push('loaded must be an object');
  if (p.length) return p;
  (o.files as unknown[]).forEach((f, i) => {
    const x = f as Record<string, unknown>;
    if (!isStr(x.path) || !isStr(x.kind) || !isNum(x.bytes) || !isNum(x.lines) || !Array.isArray(x.loadedBy) || !/^[0-9a-f]{64}$/.test(String(x.sha256))) p.push(`files[${i}] shape`);
    for (const a of (x.loadedBy as unknown[]) ?? []) if (!AGENTS.includes(String(a))) p.push(`files[${i}].loadedBy has ${String(a)}`);
  });
  (o.findings as unknown[]).forEach((f, i) => {
    const x = f as Record<string, unknown>;
    if (!isStr(x.check) || !['high', 'warn', 'info'].includes(String(x.severity)) || !isStr(x.file) || !isStr(x.message)) p.push(`findings[${i}] shape`);
    if (x.line !== undefined && !isNum(x.line)) p.push(`findings[${i}].line`);
  });
  (o.classifications as unknown[]).forEach((c, i) => {
    const x = c as Record<string, unknown>;
    if (!isStr(x.file) || !isNum(x.line) || !isStr(x.text) || !CLASSES.includes(String(x.cls)) || !isStr(x.reason)) p.push(`classifications[${i}] shape`);
  });
  (o.safetyRules as unknown[]).forEach((s, i) => {
    const x = s as Record<string, unknown>;
    if (!isStr(x.source) || !['deny-rule', 'ask-rule', 'git-hook', 'ci-required', 'never-sentence'].includes(String(x.kind)) || !isStr(x.text)) p.push(`safetyRules[${i}] shape`);
  });
  for (const [a, v] of Object.entries(o.loaded as Record<string, unknown>)) {
    const x = v as Record<string, unknown>;
    if (!AGENTS.includes(a) || !isNum(x.bytes) || !isNum(x.lines) || !Array.isArray(x.files)) p.push(`loaded.${a} shape`);
  }
  for (const n of o.neverLoaded as unknown[]) if (!isStr(n)) p.push('neverLoaded entries must be strings');
  return p;
}

function runCli(home: string, harnessHome: string): { code: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, HARNESS_HOME: harnessHome, HARNESS_USER_HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), HARNESS_NO_INSTRUMENT: '1' };
  return run(process.execPath, [CLI, 'assess', '--workspace', path.join(FIXTURE, 'workspace')], { cwd: PKG, env, timeoutMs: 60000 });
}

function checkOutputs(harnessHome: string, sources: string[]): AssessReport {
  const json = path.join(harnessHome, 'assess', 'assess.json');
  const md = path.join(harnessHome, 'assess', 'assess.md');
  assert.ok(fs.existsSync(json) && fs.existsSync(md));
  const r = JSON.parse(fs.readFileSync(json, 'utf8')) as AssessReport;
  assert.deepEqual(shapeProblems(r), []);
  const text = fs.readFileSync(md, 'utf8');
  assert.ok(text.trim().length > 200, 'assess.md is not empty');
  // At most one quoted line per finding / safety rule, each a single line.
  const quoted: string[] = [];
  let inBlock = false;
  for (const l of text.split('\n')) {
    if (l === '```text') inBlock = true;
    else if (l === '```') inBlock = false;
    else if (inBlock) quoted.push(l);
  }
  assert.ok(quoted.length <= r.findings.length + r.safetyRules.length, `${quoted.length} quoted lines for ${r.findings.length} findings`);
  for (const q of quoted) {
    assert.match(q, /^\S+ \| /, 'every quoted line is attributed to one file:line');
    assert.ok(q.length <= 320, 'one short line per quote');
  }
  // Outside the attributed quotes, no whole line of a source file appears.
  const outside = text
    .split('```text')
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf('```') + 3)))
    .join('\n');
  for (const src of sources) {
    for (const l of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
      const s = l.trim();
      if (s.length >= 30) assert.ok(!outside.includes(s), `assess.md reproduces a line of ${path.basename(src)} outside the quotes`);
    }
  }
  return r;
}

test('assess CLI end to end on the workspace fixture (empty fake HOME and the fixture HOME)', (t) => {
  if (!fs.existsSync(CLI)) {
    t.skip(`not built: ${CLI} missing (run npm run build)`);
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assess-acc-')));
  try {
    const sources = ['AGENTS.md', 'billing-api/AGENTS.md', 'billing-api/CLAUDE.md', 'inventory-api/AGENTS.md'].map((p) => path.join(FIXTURE, 'workspace', p));
    // 1. empty fake HOME: the acceptance command from the brief
    const empty = path.join(root, 'empty-home');
    fs.mkdirSync(empty);
    const a = runCli(empty, path.join(root, 'hh1'));
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /Assessed \d+ agent files/);
    assert.match(a.stdout, /Wrote .*assess\.json/);
    const r1 = checkOutputs(path.join(root, 'hh1'), sources);
    assert.ok(r1.findings.some((f) => f.check === 'R04'));
    // 2. with the fixture HOME (user-level files for all three agents)
    const b = runCli(path.join(FIXTURE, 'home'), path.join(root, 'hh2'));
    assert.equal(b.code, 0, b.stderr);
    const r2 = checkOutputs(path.join(root, 'hh2'), [...sources, path.join(FIXTURE, 'home', '.claude', 'CLAUDE.md')]);
    assert.ok(r2.files.length > r1.files.length, 'user-level files are inventoried');
    for (const c of ['R10', 'R11', 'R13', 'R14', 'R15', 'R29', 'R30', 'R31']) assert.ok(r2.findings.some((f) => f.check === c), `${c} found`);
    process.stdout.write(`# acceptance: empty HOME ${r1.files.length} files / ${r1.findings.length} findings; fixture HOME ${r2.files.length} files / ${r2.findings.length} findings / ${r2.classifications.length} lines\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
