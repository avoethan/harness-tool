/**
 * Safety: the code-free report carries no workspace text (DESIGN §2.11
 * scrubber, §6 privacy; EVAL-PLAN §8 report "scrubber test passes").
 *
 * How (CLI): a real `harness install --setting team` on the team stand-in
 * (HARNESS_STANDIN_TEAM) or a synthetic team workspace, then activity that
 * feeds the report: an intake whose ticket names repos and carries made-up
 * words, the real gate, hook events per agent dialect (Claude, Codex,
 * Devin payloads). Then:
 *   - `harness report --check-scrub` passes and the written JSON and
 *     Markdown reports share no word with the workspace token set (built
 *     from the stand-in the way the scrubber builds it: repo names and ids,
 *     path segments, source identifiers, ticket words, user/host/home), and
 *     contain none of the high-signal strings verbatim (repo names, the
 *     workspace and home paths, the task id, the planted ticket words and
 *     source identifier);
 *   - construction: a repository named like a check id, planted as an
 *     assessment finding key in the state the report reads, is counted as
 *     `other` and never reaches the report;
 *   - the second line: a doctored report (the one free-text field, the
 *     harness version from the package's own package.json, made to carry a
 *     repository name) fails `--check-scrub`, the report is refused and
 *     nothing is written, and the output names the field, never the token.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTokenSet, wordsOf } from '../../src/report/scrub';
import { built, cli, copyPackage, DIALECTS, editPayload, git, hook, initRepo, install, report, sandbox, sid, teamWorkspace } from './helpers';

const PLANTED_WORD = 'zorbexquill';
const PLANTED_IDENT = 'reconcileQuarkLedgerTotals';

test('report: after a team install and activity, --check-scrub passes and the written reports carry no repo names, paths, identifiers or ticket words', (t) => {
  const nb = built();
  if (nb) return t.skip(nb);
  const sb = sandbox('report');
  try {
    const ws = teamWorkspace(sb);
    const repo = ws.repos[0];
    const names = ws.repos.map((r) => path.basename(r));
    // a distinctive identifier in the code, committed (the scrubber samples source files)
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'quark.js'), `exports.${PLANTED_IDENT} = (xs) => xs.length;\n`);
    git(repo, ['add', '-A'], sb.env);
    git(repo, ['commit', '-q', '-m', 'feat: quark totals'], sb.env);
    install(sb, 'team', ['claude', 'codex', 'devin'], ws.root);
    const ticketText = `Fix ${PLANTED_WORD} rounding in ${names[0]}\n\nThe ${PLANTED_WORD} totals in ${names.join(' and ')} drift by a cent.\n\nAcceptance criteria:\n- ${PLANTED_IDENT} returns the count of ${PLANTED_WORD} lines\n`;
    const ticket = path.join(sb.tmp, 'ticket.txt');
    fs.writeFileSync(ticket, ticketText);
    const intake = cli(sb, ['intake', '--from', ticket, '--repo', repo, '--json'], repo);
    assert.equal(intake.code, 0, `intake: ${intake.stdout.slice(-400)}${intake.stderr.slice(-400)}`);
    const taskId = /"id"\s*:\s*"(t-[0-9a-f]+)"/.exec(intake.stdout)?.[1] ?? '';
    // agent-like activity per dialect, then the gate
    for (const d of DIALECTS) {
      const s = sid(`rep-${d}`);
      const f = path.join(repo, 'src', 'quark.js');
      hook(sb, 'UserPromptSubmit', { session_id: s, hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: ticketText }, d, { cwd: repo });
      hook(sb, 'PostToolUse', { ...editPayload(d, f, 'exports.', 'exports.', repo, s), hook_event_name: 'PostToolUse', tool_response: { success: true } }, d, { cwd: repo });
      hook(sb, 'Stop', { session_id: s, hook_event_name: 'Stop', cwd: repo, last_assistant_message: `done with ${PLANTED_WORD}` }, d, { cwd: repo });
    }
    const gate = cli(sb, ['gate'], repo);
    const out = path.join(sb.tmp, 'out');
    fs.mkdirSync(out);
    const check = cli(sb, ['report', '--check-scrub', '--workspace', ws.root], ws.root);
    const js = cli(sb, ['report', '--json', '--out', path.join(out, 'report.json'), '--workspace', ws.root], ws.root);
    const md = cli(sb, ['report', '--md', '--out', path.join(out, 'report.md'), '--workspace', ws.root], ws.root);
    assert.equal(check.code, 0, `check-scrub: ${check.stdout}${check.stderr}`);
    assert.equal(js.code, 0, `report --json: ${js.stdout}${js.stderr}`);
    assert.equal(md.code, 0, `report --md: ${md.stdout}${md.stderr}`);
    const texts = [fs.readFileSync(path.join(out, 'report.json'), 'utf8'), fs.readFileSync(path.join(out, 'report.md'), 'utf8')];
    const reportJson = JSON.parse(texts[0]);

    // The stand-in's token set, built from the workspace the way the scrubber builds it.
    const ts = buildTokenSet({
      workspaceRoot: ws.root,
      repos: ws.repos.map((r) => ({ name: path.basename(r), path: r })),
      briefs: [{ title: ticketText.split('\n')[0], criteria: [{ text: ticketText }] }],
      extra: [sb.userHome, os.userInfo().username, os.hostname()],
    });
    const words = new Set<string>();
    for (const x of texts) for (const w of wordsOf(x)) words.add(w);
    const shared = [...ts.tokens].filter((tok) => words.has(tok));
    // High-signal strings, verbatim (case-insensitive), independent of the scrubber's word rules.
    const literal = [...names, ws.root, sb.userHome, sb.tmp, PLANTED_WORD, PLANTED_IDENT, ...(taskId ? [taskId] : [])];
    const verbatim = literal.filter((s) => texts.some((x) => x.toLowerCase().includes(s.toLowerCase())));
    report(t, `report scrub (${ws.kind} workspace, ${ws.repos.length} repos): intake=${intake.code} gate=${gate.code} check-scrub=${check.code} (${check.stdout.trim().split('\n').pop()?.slice(0, 200)}); reports written json+md; tasks in report ${reportJson.tasks?.length ?? '?'}; workspace tokens ${ts.tokens.size} (${ts.stats.files} files, ${ts.stats.sourceFiles} source files), shared words ${shared.length}; ${literal.length} high-signal strings, verbatim hits ${verbatim.length}`);
    assert.ok((reportJson.tasks?.length ?? 0) >= 1, 'the report has the task row (the activity reached it)');
    assert.deepEqual(shared, [], 'no workspace token in the reports');
    assert.deepEqual(verbatim, [], 'no high-signal workspace string in the reports');
  } finally {
    sb.cleanup();
  }
});

test('report: a check-id-shaped repo name planted in assess state never reaches the report; a doctored report carrying a repository name fails --check-scrub, is refused and nothing is written; the output names the field, never the token', (t) => {
  const nb = built();
  if (nb) return t.skip(nb);
  const sb = sandbox('reportdoc');
  try {
    const ws = path.join(sb.tmp, 'ws');
    const idShaped = 'qx42'; // a repository named like a check id
    const plain = 'ledgerweb';
    initRepo(path.join(ws, idShaped), { 'package.json': '{"name":"x","private":true}\n', 'src/a.js': 'exports.a = 1;\n' }, sb.env);
    initRepo(path.join(ws, plain), { 'package.json': '{"name":"y","private":true}\n' }, sb.env);
    install(sb, 'team', ['claude'], ws);
    const before = cli(sb, ['report', '--check-scrub', '--workspace', ws], ws);
    assert.equal(before.code, 0, `clean state passes: ${before.stdout}${before.stderr}`);

    // A) construction: an assessment finding keyed by the repository's name (doctored state) is counted as `other`
    const assessPath = path.join(sb.home, 'assess', 'assess.json');
    const assess = fs.existsSync(assessPath) ? JSON.parse(fs.readFileSync(assessPath, 'utf8')) : { version: 1, generatedAt: new Date().toISOString(), files: [], findings: [], classifications: [], safetyRules: [], loaded: {}, neverLoaded: [] };
    assess.findings.push({ check: idShaped.toUpperCase(), severity: 'warn', file: 'AGENTS.md', line: 1, message: 'doctored' });
    fs.mkdirSync(path.dirname(assessPath), { recursive: true });
    fs.writeFileSync(assessPath, JSON.stringify(assess));
    const a = cli(sb, ['report', '--json', '--workspace', ws], ws);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const byCheck = JSON.parse(a.stdout).assessment.findingsByCheck as Record<string, number>;
    assert.ok(!a.stdout.toLowerCase().includes(idShaped) && (byCheck.other ?? 0) >= 1, `the doctored key is counted as other: ${JSON.stringify(byCheck)}`);

    // B) the second line: the report's one free-text field (the harness version, from the package's own
    //    package.json) doctored to carry a repository name; --check-scrub fails, nothing is written or printed
    const pkg = copyPackage(path.join(sb.tmp, 'pkg'));
    const pj = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8'));
    pj.version = `0.1.0-${plain}`;
    fs.writeFileSync(path.join(pkg.root, 'package.json'), JSON.stringify(pj, null, 2));
    const after = cli(sb, ['report', '--check-scrub', '--workspace', ws], ws, {}, 300_000, pkg.cliJs);
    const outFile = path.join(sb.tmp, 'report.md');
    const write = cli(sb, ['report', '--md', '--out', outFile, '--workspace', ws], ws, {}, 300_000, pkg.cliJs);
    const printed = cli(sb, ['report', '--json', '--workspace', ws], ws, {}, 300_000, pkg.cliJs);
    report(t, `doctored report: check-scrub clean ${before.code}; check-id-shaped repo name in assess state -> findingsByCheck ${JSON.stringify(byCheck)}; planted name in harnessVersion -> check-scrub ${after.code} (${after.stdout.trim().split('\n').pop()?.replace(/\d+ token/, 'N token').slice(0, 220)}); --out refused ${write.code} (file written ${fs.existsSync(outFile)}); print refused ${printed.code}`);
    assert.equal(after.code, 1, `doctored report fails: ${after.stdout}${after.stderr}`);
    assert.match(after.stdout, /scrub: FAILED/);
    assert.match(after.stdout, /harnessVersion/);
    assert.notEqual(write.code, 0);
    assert.ok(!fs.existsSync(outFile), 'nothing written');
    assert.notEqual(printed.code, 0);
    for (const o of [after, write, printed]) assert.ok(!(o.stdout + o.stderr).toLowerCase().includes(plain), 'the token itself is never printed');
  } finally {
    sb.cleanup();
  }
});
