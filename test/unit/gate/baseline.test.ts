/**
 * Failures already present at the starting commit (`pre-existing`), and the
 * repository's own typecheck command.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile, GateStep } from '../../../src/types';
import { decideVerdict, runGate } from '../../../src/gate';
import { buildContext } from '../../../src/gate/context';
import { runTypecheck, typecheckPlan } from '../../../src/gate/build';
import { compareFailures, normaliseDiagnostic, outputIdentity, tsDiagnostics, type FailureIdentity } from '../../../src/gate/baseline';
import { checkoutCount } from '../../../src/gate/checkout';
import { runSecrets } from '../../../src/gate/secrets';
import { renderReport } from '../../../src/gate/report';
import { stepProblem } from '../../../src/gate/gatecheck';
import { main as gateMain } from '../../../src/commands/gate';
import { repoIdFor } from '../../../src/lib/config';
import { runsDir } from '../../../src/lib/paths';
import { capture } from '../commands/capture';
import { commitAll, demoRepo, gitRepo, put, tempHome, writeBrief, type TempHome } from './helpers';

let h: TempHome;
let n = 0;
before(() => {
  h = tempHome('harness-gate-baseline-');
});
after(() => h.cleanup());

/**
 * A stand-in tsc: reports `// TSnnnn message` comments in src/**.ts as tsc
 * diagnostics (file(line,col): error TSnnnn: message) and exits 2; with a file
 * named CRASH in the folder it runs in, it prints no diagnostics and exits 3.
 */
const FAKE_TSC = [
  '#!/usr/bin/env node',
  "const fs = require('fs'), path = require('path');",
  'const cwd = process.cwd();',
  "if (fs.existsSync(path.join(cwd, 'CRASH'))) { console.log('Segmentation fault'); process.exit(3); }",
  'const out = [];',
  'const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);',
  '  if (e.isDirectory()) walk(p);',
  "  else if (/\\.ts$/.test(e.name)) fs.readFileSync(p, 'utf8').split(/\\r?\\n/).forEach((l, i) => { const m = /\\/\\/ (TS\\d+) (.*)$/.exec(l); if (m) out.push(path.relative(cwd, p).split(path.sep).join('/') + '(' + (i + 1) + ',1): error ' + m[1] + ': ' + m[2]); });",
  '} };',
  "if (fs.existsSync(path.join(cwd, 'src'))) walk(path.join(cwd, 'src'));",
  "console.log(out.join('\\n'));",
  'process.exit(out.length ? 2 : 0);',
  '',
].join('\n');

/** A stand-in ESLint: `// LINT <rule> <message>` lines in the files it is given, as ESLint JSON. */
const FAKE_ESLINT = [
  '#!/usr/bin/env node',
  "const fs = require('fs'), path = require('path');",
  "const files = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== 'json');",
  'const res = files.map((f) => ({ filePath: path.resolve(f), messages: fs.readFileSync(f, \'utf8\').split(/\\r?\\n/).flatMap((l, i) => { const m = /\\/\\/ LINT (\\S+) (.*)$/.exec(l); return m ? [{ ruleId: m[1], severity: 2, line: i + 1, message: m[2] }] : []; }) }));',
  'process.stdout.write(JSON.stringify(res));',
  'process.exit(res.some((r) => r.messages.length) ? 1 : 0);',
  '',
].join('\n');

function tsRepo(extra: Record<string, string> = {}, pkg: Record<string, unknown> = {}): string {
  const r = gitRepo(path.join(h.workspace, `ts${++n}`), {
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify({ name: `ts${n}`, devDependencies: { typescript: '^5.0.0' }, ...pkg }, null, 2) + '\n',
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
    'src/a.ts': "export const a: number = 'x'; // TS2322 Type 'string' is not assignable to type 'number'.\n",
    ...extra,
  });
  put(r, 'node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.0.0', bin: { tsc: 'bin/tsc' } }));
  put(r, 'node_modules/typescript/bin/tsc', FAKE_TSC);
  fs.chmodSync(path.join(r, 'node_modules/typescript/bin/tsc'), 0o755);
  return r;
}

function addEslint(r: string): void {
  put(r, 'node_modules/eslint/package.json', JSON.stringify({ name: 'eslint', version: '9.0.0', bin: { eslint: 'bin/eslint.js' } }));
  put(r, 'node_modules/eslint/bin/eslint.js', FAKE_ESLINT);
}

function readEvidence(root: string, task: string): EvidenceFile {
  return JSON.parse(fs.readFileSync(path.join(runsDir(), repoIdFor(root), task, 'evidence.json'), 'utf8')) as EvidenceFile;
}

function step(ev: EvidenceFile, name: string): GateStep {
  const s = ev.steps.find((x) => x.name === name);
  assert.ok(s, `step ${name} ran`);
  return s!;
}

// ---------------------------------------------------------------------------
// Normalising and comparing failure identities
// ---------------------------------------------------------------------------

test('diagnostics are normalised: file relative to the repo, TS code, message without line numbers; Windows separators and CRLF match', () => {
  const posix = normaliseDiagnostic("/work/repo/src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.", ['/work/repo']);
  const win = normaliseDiagnostic("C:\\Work\\Repo\\src\\a.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.\r", ['c:\\work\\repo']);
  const pretty = normaliseDiagnostic("src/a.ts:12:7 - error TS2322: Type 'string' is not assignable to type 'number'.", ['/elsewhere']);
  assert.ok(posix && win && pretty);
  assert.equal(posix!.id, "src/a.ts|TS2322|Type 'string' is not assignable to type 'number'.");
  assert.equal(win!.id, posix!.id);
  assert.equal(pretty!.id, posix!.id);
  assert.equal(normaliseDiagnostic('Found 3 errors.', []), null);
  const many = tsDiagnostics('src/a.ts(1,1): error TS1005: \';\' expected.\r\n    more detail\r\nsrc/b.ts(2,2): error TS2304: Cannot find name \'x\'.\r\n', ['/r']);
  assert.deepEqual(many.map((d) => d.id), ["src/a.ts|TS1005|';' expected.", "src/b.ts|TS2304|Cannot find name 'x'."]);
});

test('compareFailures: pre-existing only when every current failure is also at the base; a base that cannot be evaluated never makes a failure pre-existing', () => {
  const id = (items: string[], extra: Partial<FailureIdentity> = {}): FailureIdentity => ({ kind: 'diagnostics', fingerprint: 'f', exit: null, header: 'h', items: items.map((i) => ({ id: i, text: i })), ...extra });
  assert.equal(compareFailures(id(['a', 'b']), { status: 'fail', identity: id(['a', 'b', 'c']) }).status, 'pre-existing');
  const mixed = compareFailures(id(['a', 'n']), { status: 'fail', identity: id(['a']) });
  assert.equal(mixed.status, 'fail');
  assert.deepEqual(mixed.status === 'fail' && mixed.newItems.map((i) => i.id), ['n']);
  assert.equal(compareFailures(id(['a']), { status: 'pass' }).status, 'fail');
  assert.equal(compareFailures(id(['a']), { status: 'error', why: 'could not check out' }).status, 'error');
  // a different kind of identity at the base cannot be compared
  assert.equal(compareFailures(id(['a']), { status: 'fail', identity: id(['a'], { kind: 'output', exit: 1 }) }).status, 'error');
  // another command at the base cannot be compared
  assert.equal(compareFailures(id(['a']), { status: 'fail', identity: id(['a'], { fingerprint: 'g' }) }).status, 'error');
  // script steps: the exit code is part of the identity
  const out = (exit: number, items: string[]) => id(items, { kind: 'output', exit });
  assert.equal(compareFailures(out(1, []), { status: 'fail', identity: out(1, []) }).status, 'pre-existing');
  assert.equal(compareFailures(out(2, []), { status: 'fail', identity: out(1, []) }).status, 'fail');
  assert.equal(compareFailures(out(1, ['x']), { status: 'fail', identity: out(1, []) }).status, 'fail');
  // an empty current identity of diagnostics proves nothing
  assert.equal(compareFailures(id([]), { status: 'fail', identity: id(['a']) }).status, 'error');
  // counted, not a set: a second copy of an error already at the base is new
  const twice = compareFailures(id(['a', 'a']), { status: 'fail', identity: id(['a']) });
  assert.equal(twice.status, 'fail');
  assert.equal(twice.status === 'fail' && twice.newItems.length, 1);
});

test('build: a build script failing the same way at the base is pre-existing; a different failure is new', async () => {
  const r = gitRepo(path.join(h.workspace, `bu${++n}`), {
    'package.json': JSON.stringify({ name: 'bu', scripts: { build: 'node build.js' } }) + '\n',
    'build.js': "console.error('Error: the config file is missing');\nprocess.exit(1);\n",
  });
  put(r, 'src/x.js', 'exports.x = 1;\n');
  const a = await runGate({ repo: r, task: 'build-old' });
  assert.equal(a.evidence.steps.find((s) => s.name === 'build')!.status, 'pre-existing');
  assert.equal(a.evidence.verdict, 'PASS');
  put(r, 'build.js', "console.error('Error: the config file is missing');\nconsole.error('Error: src/x.js does not compile');\nprocess.exit(1);\n");
  const b = await runGate({ repo: r, task: 'build-new' });
  const bs = b.evidence.steps.find((s) => s.name === 'build')!;
  assert.equal(bs.status, 'fail');
  assert.match(bs.reasons!.join('\n'), /does not compile/);
  assert.doesNotMatch(bs.reasons!.join('\n'), /config file is missing/);
});

test('outputIdentity: failure lines without digits or the repository path, so durations and checkout folders do not count as new', () => {
  const a = outputIdentity({ code: 1, stdout: 'ok 1 - fine (12ms)\nnot ok 2 - broken (3ms)\r\nError: at /tmp/harness-base-x/base/src/a.js:3:9\n', stderr: '', timedOut: false, durationMs: 1 } as never, 'fp', 'h', ['/tmp/harness-base-x/base']);
  const b = outputIdentity({ code: 1, stdout: 'not ok 7 - broken (40ms)\nError: at /work/repo/src/a.js:5:1\n', stderr: '', timedOut: false, durationMs: 1 } as never, 'fp', 'h', ['/work/repo']);
  assert.ok(a && b);
  assert.deepEqual(new Set(b!.items.map((i) => i.id)), new Set(a!.items.map((i) => i.id)));
  assert.equal(outputIdentity({ code: 1, stdout: '', stderr: '', timedOut: true, durationMs: 1 } as never, 'fp', 'h', []), null, 'a timeout has no identity');
});

// ---------------------------------------------------------------------------
// typecheck
// ---------------------------------------------------------------------------

test('typecheck failing identically at the base passes the gate as pre-existing, listed in the report and the write-up', async () => {
  const r = tsRepo();
  writeBrief(r, `pre-tc-${n}`, []);
  // the change moves the old error down a line and adds a clean file
  put(r, 'src/a.ts', "export const ok = 1;\nexport const a: number = 'x'; // TS2322 Type 'string' is not assignable to type 'number'.\n");
  put(r, 'src/b.ts', 'export const b = 2;\n');
  const out = await capture(() => gateMain(['--repo', r]));
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /PRE-EXISTING\s+typecheck/);
  assert.match(out.stdout, /Verdict: PASS\./);
  assert.match(out.stdout, /1 already failing at the base commit/);
  const ev = readEvidence(r, `pre-tc-${n}`);
  assert.equal(ev.verdict, 'PASS');
  const tc = step(ev, 'typecheck');
  assert.equal(tc.status, 'pre-existing');
  assert.match(tc.reasons!.join('\n'), /already failing at the base commit/);
  assert.match(tc.reasons!.join('\n'), /TS2322/);
  const wu = fs.readFileSync(path.join(runsDir(), repoIdFor(r), `pre-tc-${n}`, 'writeup.md'), 'utf8');
  const sec = wu.slice(wu.indexOf('## Verification'), wu.indexOf('## Assumptions'));
  assert.match(sec, /### Already failing before this change/);
  assert.match(sec, /typecheck: .*TS2322/);
});

test('one new type error fails the typecheck naming only the new one', async () => {
  const r = tsRepo();
  put(r, 'src/b.ts', "export const b = foo; // TS2304 Cannot find name 'foo'.\n");
  const run = await runGate({ repo: r, task: 'new-tc' });
  const tc = run.evidence.steps.find((s) => s.name === 'typecheck')!;
  assert.equal(tc.status, 'fail');
  assert.equal(run.evidence.verdict, 'FAIL');
  const text = tc.reasons!.join('\n');
  assert.match(text, /src\/b\.ts.*TS2304/);
  assert.doesNotMatch(text, /TS2322/, 'the error already at the base is not named');
  assert.match(text, /1 new .*1 already failing at the base commit/);
});

test('a base that cannot be evaluated says so plainly and the failure stays a failure', async () => {
  const r = tsRepo({ CRASH: 'the stand-in tsc crashes here\n' });
  fs.rmSync(path.join(r, 'CRASH'));
  put(r, 'src/b.ts', 'export const b = 2;\n');
  const run = await runGate({ repo: r, task: 'crash' });
  const tc = run.evidence.steps.find((s) => s.name === 'typecheck')!;
  assert.equal(tc.status, 'fail');
  assert.match(tc.reasons!.join('\n'), /TS2322/);
  assert.match(tc.reasons!.join('\n'), /the base commit [0-9a-f]+ could not be checked for comparison/);
});

test('the base checkout is made once per base commit: one for several failing steps in a run, none on the next run (cache)', async () => {
  const r = tsRepo({ 'eslint.config.mjs': 'export default [];\n', 'src/c.js': 'var c = 1; // LINT no-var Unexpected var, use let or const instead.\n' });
  addEslint(r);
  put(r, 'src/c.js', 'const z = 0;\nvar c = 1; // LINT no-var Unexpected var, use let or const instead.\n');
  const before = checkoutCount();
  const first = await runGate({ repo: r, task: 'once' });
  assert.equal(first.evidence.steps.find((s) => s.name === 'typecheck')!.status, 'pre-existing');
  assert.equal(first.evidence.steps.find((s) => s.name === 'lint')!.status, 'pre-existing');
  assert.equal(checkoutCount() - before, 1, 'one checkout for both steps');
  const second = await runGate({ repo: r, task: 'once' });
  assert.equal(second.evidence.verdict, 'PASS');
  assert.equal(checkoutCount() - before, 1, 'the second run reads the cached base results');
});

test('the typecheck script is preferred over tsc, in the documented order', () => {
  const r = tsRepo({ 'scripts/tc.js': "console.log('types ok');\n" }, { scripts: { 'check:types': 'node scripts/tc.js' } });
  const ctx = buildContext({ repo: r });
  const plan = typecheckPlan(ctx);
  assert.equal(plan.kind, 'script');
  const out = runTypecheck(ctx);
  assert.equal(out.status, 'pass', out.reasons.join('\n'));
  assert.match(out.reasons[0], /node scripts\/tc\.js/);
  const order = (scripts: Record<string, string>) => {
    const x = tsRepo({}, { scripts });
    const p = typecheckPlan(buildContext({ repo: x }));
    return p.kind === 'script' ? p.name : p.kind;
  };
  assert.equal(order({ types: 'node a.js', typecheck: 'node b.js' }), 'typecheck');
  assert.equal(order({ types: 'node a.js', 'type-check': 'node b.js' }), 'type-check');
  assert.equal(order({ types: 'node a.js', tsc: 'node b.js' }), 'tsc');
  assert.equal(order({}), 'tsc');
  const refs = tsRepo({ 'tsconfig.json': '{ "files": [], "references": [{ "path": "./src" }] }\n' });
  const rp = typecheckPlan(buildContext({ repo: refs }));
  assert.equal(rp.kind === 'tsc' && rp.args[0], '-b');
});

test('a build-only repository whose build runs tsc skips typecheck with the reason', () => {
  const r = tsRepo({}, { scripts: { build: 'tsc -p tsconfig.json' } });
  const out = runTypecheck(buildContext({ repo: r }));
  assert.equal(out.status, 'skip');
  assert.match(out.reasons[0], /`build` script runs tsc, so the build step checks the types/);
  // a gate check that names typecheck follows the build step instead
  assert.deepEqual(stepProblem('typecheck', [{ name: 'typecheck', status: 'skip', durationMs: 0, reasons: out.reasons }, { name: 'build', status: 'pass', durationMs: 1 }]).ok, true);
  assert.deepEqual(stepProblem('typecheck', [{ name: 'typecheck', status: 'skip', durationMs: 0, reasons: out.reasons }, { name: 'build', status: 'fail', durationMs: 1 }]).ok, false);
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

test('a lint error present at the base is pre-existing; a new one fails naming only it', async () => {
  const r = gitRepo(path.join(h.workspace, `li${++n}`), {
    '.gitignore': 'node_modules/\n',
    'package.json': JSON.stringify({ name: 'li', devDependencies: { eslint: '^9.0.0' } }) + '\n',
    'eslint.config.mjs': 'export default [];\n',
    'src/c.js': 'var c = 1; // LINT no-var Unexpected var, use let or const instead.\n',
  });
  addEslint(r);
  put(r, 'src/c.js', 'const z = 0;\nvar c = 1; // LINT no-var Unexpected var, use let or const instead.\n');
  const a = await runGate({ repo: r, task: 'lint-old' });
  const la = a.evidence.steps.find((s) => s.name === 'lint')!;
  assert.equal(la.status, 'pre-existing', JSON.stringify(la));
  assert.equal(a.evidence.verdict, 'PASS');
  put(r, 'src/c.js', 'const z = 0;\nvar c = 1; // LINT no-var Unexpected var, use let or const instead.\nif (z == 1) c++; // LINT eqeqeq Expected === and instead saw ==.\n');
  const b = await runGate({ repo: r, task: 'lint-new' });
  const lb = b.evidence.steps.find((s) => s.name === 'lint')!;
  assert.equal(lb.status, 'fail');
  const text = lb.reasons!.join('\n');
  assert.match(text, /src\/c\.js:3 eqeqeq/);
  assert.doesNotMatch(text, /no-var/);
});

// ---------------------------------------------------------------------------
// tests:base
// ---------------------------------------------------------------------------

test('a test failing at the base stays pre-existing; a newly failing test fails naming only it', async () => {
  const broken = "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('broken already', () => assert.equal(1, 2));\n";
  const r = demoRepo(path.join(h.workspace, `tb${++n}`), { 'test/broken.test.js': broken });
  put(r, 'src/other.js', 'exports.other = 1;\n');
  const a = await runGate({ repo: r, task: 'tests-old' });
  const ta = a.evidence.steps.find((s) => s.name === 'tests:base')!;
  assert.equal(ta.status, 'pre-existing', JSON.stringify(ta));
  assert.match(ta.reasons!.join('\n'), /broken already/);
  assert.equal(a.evidence.verdict, 'PASS');
  put(r, 'src/add.js', 'exports.add = (a, b) => a - b;\n');
  const b = await runGate({ repo: r, task: 'tests-new' });
  const tb = b.evidence.steps.find((s) => s.name === 'tests:base')!;
  assert.equal(tb.status, 'fail');
  const text = tb.reasons!.join('\n');
  assert.match(text, /failing: adds/);
  assert.doesNotMatch(text, /broken already/);
});

// ---------------------------------------------------------------------------
// Verdict, report, Stop hook, secrets
// ---------------------------------------------------------------------------

test('pre-existing does not FAIL the verdict, and the report counts it apart from passes', () => {
  const steps: GateStep[] = [
    { name: 'tamper', status: 'pass', durationMs: 1 },
    { name: 'typecheck', status: 'pre-existing', durationMs: 1, reasons: ['already failing at the base commit'] },
  ];
  assert.equal(decideVerdict(steps, {}).verdict, 'PASS');
  const ev = { version: 1, repo: 'r', task: 't', verdict: 'PASS', reasons: [], treeHash: 'a'.repeat(40), baseSha: 'b'.repeat(40), steps, attempt: 1, startedAt: '', finishedAt: '', e2e: [] } as EvidenceFile;
  const text = renderReport({ evidence: ev, repoName: 'r', mode: 'task', baseSource: 'x', cap: 8, evidencePath: null, partial: null, warnings: [] });
  assert.match(text, /2 step\(s\): 1 passed, 0 failed, 0 skipped, 1 already failing at the base commit \(pre-existing\)/);
});

test('the Stop hook lets a PASS with pre-existing steps through', async () => {
  const { evaluateStop } = await import('../../../src/hooks/evidence');
  const { recordEdit } = await import('../../../src/lib/session');
  const { setCurrentTask } = await import('../../../src/intake/brief');
  const r = tsRepo();
  const repoId = repoIdFor(r);
  setCurrentTask(repoId, 'stop-pre');
  const sid = `gate-stop-pre-${n}`;
  put(r, 'src/b.ts', 'export const b = 2;\n');
  recordEdit(sid, { path: path.join(r, 'src/b.ts'), repo: repoId });
  const run = await runGate({ repo: r });
  assert.equal(run.evidence.steps.find((s) => s.name === 'typecheck')!.status, 'pre-existing');
  assert.equal(run.evidence.verdict, 'PASS');
  const ok = evaluateStop({ session_id: sid }, { agent: 'claude', event: 'Stop', sessionId: sid }, { budgetMs: 10_000 });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.outcome, 'pass');
});

test('the secret scan flags only added lines: a secret already in a modified file at the base is not flagged', () => {
  const token = 'ghp_' + 'B'.repeat(36);
  const r = demoRepo(path.join(h.workspace, `se${++n}`), { 'src/old.js': `const old = '${token}';\n` });
  commitAll(r, 'base');
  put(r, 'src/old.js', `const old = '${token}';\nconst more = 1;\n`);
  assert.equal(runSecrets(buildContext({ repo: r, task: 'sec-old' })).status, 'pass');
  put(r, 'src/old.js', `const old = '${token}';\nconst again = '${'ghp_' + 'C'.repeat(36)}';\n`);
  const out = runSecrets(buildContext({ repo: r, task: 'sec-new' }));
  assert.equal(out.status, 'fail');
  assert.match(out.reasons.join('\n'), /src\/old\.js:2: secret-shaped text/);
  assert.doesNotMatch(out.reasons.join('\n'), /src\/old\.js:1:/);
});

test('harness report counts pre-existing steps apart from failed and fixed ones', async () => {
  const { taskRow } = await import('../../../src/report/build');
  const { renderMarkdown } = await import('../../../src/report/markdown');
  const { vocabularySample } = await import('../../../src/report/scrub');
  const ev = (steps: GateStep[]) => ({ version: 1, repo: 'r', task: 't', verdict: 'PASS', reasons: [], treeHash: 'a'.repeat(40), baseSha: 'b'.repeat(40), steps, attempt: 1, startedAt: '', finishedAt: '', e2e: [] }) as EvidenceFile;
  const acc = {
    id: 't-report-pre',
    runs: [{ repo: 'r', evidence: ev([{ name: 'tamper', status: 'pass', durationMs: 1 }, { name: 'typecheck', status: 'pre-existing', durationMs: 1 }, { name: 'tests:base', status: 'pre-existing', durationMs: 1 }]), e2eFiles: 0 }],
    events: [],
    sessions: new Set<string>(),
  };
  const row = taskRow(acc as never, { worklog: null } as never, new Map(), new Map(), []);
  assert.equal(row.checksPreExisting, 2);
  assert.equal(row.checksFailedThenFixed, 0);
  assert.equal(row.gateVerdict, 'PASS');
  const md = renderMarkdown({ ...vocabularySample(), tasks: [row] });
  assert.match(md, /\| Already failing at base \|/);
});
