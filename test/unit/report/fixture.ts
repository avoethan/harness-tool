/**
 * A scripted ~/.harness with known counts, for the report, status and scrub
 * tests. Every number the tests assert can be worked out from this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../../../src/lib/hash';
import { allowlistHash } from '../../../src/lib/config';
import type { HarnessConfig } from '../../../src/types';
import { recordStep } from '../../../src/report/selfcheck';

export const T1 = 't-1111111111';
export const T2 = 't-2222222222';
export const H1 = sha256('first ticket text');
export const H2 = sha256('second ticket text');
export const ALPHA = 'alpha-service-1a2b3c';
export const BETA = 'beta-service-4d5e6f';
/** Words planted in the workspace and briefs that the report must never carry. */
export const PLANTED = { repo: 'alpha-service', identifier: 'computeZanzibarTotals', ticketWord: 'quokkaledger' };

function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function putJson(file: string, v: unknown): void {
  put(file, JSON.stringify(v, null, 2) + '\n');
}

function ev(ts: string, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, event, ...extra });
}

export function buildWorkspace(ws: string): void {
  put(path.join(ws, 'alpha-service', 'src', 'zanzibar-exporter.ts'), `export function ${PLANTED.identifier}(rows: number[]): number {\n  return rows.reduce((a, b) => a + b, 0);\n}\n`);
  put(path.join(ws, 'alpha-service', 'package.json'), '{ "name": "alpha-service" }\n');
  put(path.join(ws, 'beta-service', 'src', 'index.ts'), 'export const betaServiceVersion = 1;\n');
}

/** Write the fixture state into `hh` (HARNESS_HOME) for a workspace `ws`. */
export function buildFixture(hh: string, ws: string): void {
  buildWorkspace(ws);
  const config: HarnessConfig = {
    version: 1,
    setting: 'team',
    agents: ['devin', 'claude'],
    workspaceRoot: ws,
    repos: [
      { id: ALPHA, name: 'alpha-service', path: path.join(ws, 'alpha-service'), isGit: true },
      { id: BETA, name: 'beta-service', path: path.join(ws, 'beta-service'), isGit: true },
    ],
    db: { allowlist: [{ server: 'localhost,1433', marked: 'test' }] },
    mcp: { allowedServers: {} },
    caps: { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8 },
    include: [],
    reviews: { source: 'none' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  config.db.markedHash = allowlistHash(config);
  putJson(path.join(hh, 'config.json'), config);

  // Ledger: 5 records; one with a tier and family outside the vocabulary.
  const rec = (id: string, tier: string, family: string, type: string, mode: string) => ({
    id,
    statement: `statement of ${id}`,
    family,
    scope: { repos: ['*'] },
    tier,
    confidence: 0.9,
    evidence: { sites: 10, conforming: 9, packages: 1, examples: [], sources: [] },
    check: { type, mode },
    conflicts: [],
    provenance: [],
    history: { firstSeen: '2026-09-01', lastCounted: '2026-09-01', disputes: 0 },
  });
  putJson(path.join(hh, 'ledger', 'ledger.json'), {
    version: 1,
    generatedAt: '2026-10-01T08:00:00.000Z',
    workspaceRoot: ws,
    records: [
      rec('lint.no-explicit-any', 'declared', 'lint', 'eslint', 'block'),
      rec('naming.camel-case', 'counted-strong', 'naming', 'ast-grep', 'block'),
      rec('naming.kebab-files', 'counted-majority', 'naming', 'ast-grep', 'warn'),
      rec('errors.wrap', 'single-source', 'errors', 'judgment', 'judgment'),
      rec('other.zanzibar', 'weird-tier', 'secret-family', 'regex', 'block'),
    ],
    skipped: [],
    scanners: [],
  });
  putJson(path.join(hh, 'ledger', 'checks', 'index.json'), {
    version: 1,
    generatedAt: '2026-10-01T08:00:00.000Z',
    records: [
      { id: 'lint.no-explicit-any', type: 'eslint', mode: 'block' },
      { id: 'naming.camel-case', type: 'ast-grep', mode: 'block' },
      { id: 'naming.kebab-files', type: 'ast-grep', mode: 'warn' },
      { id: 'errors.wrap', type: 'judgment', mode: 'judgment' },
    ],
  });
  for (const f of ['lint.no-explicit-any.json', 'naming.camel-case.json', 'naming.kebab-files.json', 'errors.wrap.json']) putJson(path.join(hh, 'ledger', 'checks', f), {});
  put(path.join(hh, 'ledger', 'checks', 'naming.camel-case.yml'), 'id: x\n');

  // Assessment: findings R10 x2, R30 x1, two odd ids (-> other; QX42 has an id's shape but is not a catalogue id); classes KEEP 3, CONVERT 2, QUARANTINE 1, odd (-> other).
  const f = (check: string) => ({ check, severity: 'warn', file: '~/x.md', message: 'm' });
  const c = (cls: string) => ({ file: '~/x.md', line: 1, text: PLANTED.ticketWord, cls, reason: 'r' });
  putJson(path.join(hh, 'assess', 'assess.json'), {
    version: 1,
    generatedAt: '2026-10-01T08:30:00.000Z',
    files: [],
    findings: [f('R10'), f('R10'), f('R30'), f('weird check id'), f('QX42')],
    classifications: [c('KEEP'), c('KEEP'), c('KEEP'), c('CONVERT'), c('CONVERT'), c('QUARANTINE'), c('BOGUS')],
    safetyRules: [],
    loaded: {},
    neverLoaded: [],
  });

  // Team proposals: two write-ups (the .diff files are not counted).
  put(path.join(hh, 'proposals', ALPHA, '1-lint-rule.md'), 'x');
  put(path.join(hh, 'proposals', ALPHA, '1-lint-rule.diff'), 'x');
  put(path.join(hh, 'proposals', BETA, '2-contributing.md'), 'x');

  // Briefs.
  const brief = (id: string, hash: string, title: string, criteria: Array<[string, string]>, clar: number, open: number, at: string) => ({
    version: 1,
    id,
    ticketHash: hash,
    title,
    description: 'd',
    criteria: criteria.map(([cid, kind]) => ({ id: cid, text: `${PLANTED.ticketWord} criterion ${cid}`, kind })),
    units: [],
    repos: [ALPHA],
    questions: [],
    assumptions: [],
    createdAt: at,
    updatedAt: at,
    source: 'ticket',
    format: 'plain',
    inferred: false,
    codeBlocks: 0,
    hiddenRemoved: 0,
    criteriaMeta: {},
    questionDetails: Array.from({ length: open }, (_, i) => ({ n: i + 1 })),
    queued: [],
    markers: [],
    observations: [],
    clarifications: Array.from({ length: clar }, (_, i) => ({ n: i + 1, key: 'k', topic: 't', q: 'q', a: 'a', at })),
    dropped: [],
    repoMap: { ticket: [ALPHA], byCriterion: {}, repos: { [ALPHA]: { name: 'alpha-service', path: path.join(ws, 'alpha-service') } } },
    landingOrder: [],
    unitEstimates: {},
    baseShas: {},
    lint: [],
  });
  putJson(path.join(hh, 'briefs', `${T1}.json`), brief(T1, H1, `Export the ${PLANTED.ticketWord} totals`, [['AC1', 'unit'], ['AC2', 'api'], ['AC3', 'db']], 1, 1, '2026-10-01T10:00:00.000Z'));
  putJson(path.join(hh, 'briefs', `${T2}.json`), brief(T2, H2, 'Second task', [['AC1', 'unit'], ['AC2', 'unit']], 0, 0, '2026-10-05T08:59:00.000Z'));

  // Runs.
  const step = (name: string, status: string, reasons?: string[]) => ({ name, status, durationMs: 5, ...(reasons ? { reasons } : {}) });
  const evidence = (task: string, verdict: string, attempt: number, steps: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1,
    repo: ALPHA,
    task,
    verdict,
    reasons: [],
    treeHash: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    steps,
    attempt,
    startedAt: extra.startedAt ?? '2026-10-01T10:05:00.000Z',
    finishedAt: extra.finishedAt ?? '2026-10-01T10:06:00.000Z',
    e2e: [],
    ...extra,
  });
  const r1 = path.join(hh, 'runs', ALPHA, T1);
  putJson(path.join(r1, 'evidence.json'), evidence(T1, 'PASS', 2, [step('tamper', 'pass'), step('secrets', 'pass'), step('standards', 'pass'), step('lint', 'pass'), step('tests:base', 'pass'), step('acceptance:AC1', 'pass'), step('coverage', 'skip')]));
  putJson(path.join(r1, 'e2e', 'AC2-http.json'), { version: 1 });
  putJson(path.join(r1, 'e2e', 'AC3-db.json'), { version: 1 });
  put(path.join(r1, 'writeup.md'), 'w');
  putJson(path.join(r1, 'phase.json'), { version: 1, phase: 'implement' });
  const r2 = path.join(hh, 'runs', ALPHA, T2);
  putJson(
    path.join(r2, 'evidence.json'),
    evidence(T2, 'FAIL', 8, [step('tamper', 'pass'), step('standards', 'fail', ['lint.no-explicit-any at src/zanzibar-exporter.ts:3: No any', 'warn: naming.camel-case at src/b.ts:9: camel']), step('lint', 'fail'), step('build', 'skip')], {
      cap_reached: true,
      startedAt: '2026-10-05T09:00:30.000Z',
      finishedAt: '2026-10-05T09:01:30.000Z',
    }),
  );
  putJson(path.join(r2, 'phase.json'), { version: 1, phase: 'tests' });
  put(path.join(hh, 'runs', ALPHA, 'current-task'), `${T2}\n`);
  putJson(path.join(hh, 'runs', ALPHA, 'hook-pre-commit', 'evidence.json'), evidence('hook-pre-commit', 'PASS', 1, []));
  putJson(path.join(hh, 'runs', BETA, 'adhoc', 'evidence.json'), evidence('adhoc', 'FAIL', 1, []));

  // Events.
  const g = (ts: string, event: string, task: string, sid: string, ids: Record<string, string>) => ev(ts, event, { sessionId: sid, repo: ALPHA, task, ids });
  const lines = [
    ev('2026-09-01T12:00:00.000Z', 'prompt.submit', { sessionId: 's9' }),
    ev('2026-10-01T10:01:00.000Z', 'prompt.submit', { sessionId: 's1' }),
    g('2026-10-01T10:02:00.000Z', 'gate.step', T1, 's1', { step: 'lint', status: 'fail' }),
    g('2026-10-01T10:02:01.000Z', 'gate.fail', T1, 's1', { step: 'lint' }),
    g('2026-10-01T10:02:02.000Z', 'gate.step', T1, 's1', { step: 'tests:base', status: 'pass' }),
    g('2026-10-01T10:02:03.000Z', 'gate.verdict', T1, 's1', { verdict: 'FAIL' }),
    ev('2026-10-01T10:03:00.000Z', 'prompt.submit', { sessionId: 's1' }),
    ev('2026-10-01T10:03:10.000Z', 'correction', { sessionId: 's1', class: 'style', ids: { ticket: sha256(T1) } }),
    ev('2026-10-01T10:04:00.000Z', 'correction', { sessionId: 's1', class: 'style', ids: { ticket: sha256(T1) } }),
    ev('2026-10-01T10:04:10.000Z', 'correction', { sessionId: 's1', class: 'test', ids: { ticket: sha256(T1) } }),
    ev('2026-10-01T10:05:00.000Z', 'prompt.submit', { sessionId: 's1' }),
    g('2026-10-01T10:06:00.000Z', 'gate.verdict', T1, 's1', { verdict: 'PASS' }),
    ev('2026-10-01T10:07:00.000Z', 'stop.pass', { sessionId: 's1' }),
    ev('2026-10-01T10:08:00.000Z', 'prompt.submit', { sessionId: 's1' }),
    ev('2026-10-05T09:00:00.000Z', 'prompt.submit', { sessionId: 's2' }),
    g('2026-10-05T09:01:00.000Z', 'gate.fail', T2, 's2', { step: 'standards', rules: 'lint.no-explicit-any' }),
    g('2026-10-05T09:01:01.000Z', 'gate.verdict', T2, 's2', { verdict: 'FAIL', cap: 'reached' }),
    ev('2026-10-05T09:02:00.000Z', 'correction', { sessionId: 's2', class: 'scope', ids: { ticket: 'none' } }),
    ev('2026-10-05T09:03:00.000Z', 'stop.cap', { sessionId: 's2' }),
    ev('2026-10-05T09:04:00.000Z', 'prompt.submit', { sessionId: 's2' }),
    'not json at all',
  ];
  put(path.join(hh, 'logs', 'events.jsonl'), lines.join('\n') + '\n');

  // Lessons.
  const lesson = (id: string, status: string, provenOn?: string) => ({ id, class: 'style', occurrences: 2, firstSeen: '2026-10-02T00:00:00.000Z', lastSeen: '2026-10-03T00:00:00.000Z', sources: [], status, tier: 1, ...(provenOn ? { enforcer: { rung: 'lint', ref: 'r', provenOn, fires: 1 } } : {}) });
  putJson(path.join(hh, 'lessons', 'l1.json'), lesson('l1', 'captured'));
  putJson(path.join(hh, 'lessons', 'l2.json'), lesson('l2', 'proven', '2026-10-03'));
  putJson(path.join(hh, 'lessons', 'l3.json'), lesson('l3', 'approved', '2026-10-03'));
  putJson(path.join(hh, 'lessons', 'l4.json'), lesson('l4', 'expired'));

  // The user's work log: columns in another order, one row for T1 (hash prefix), one unusable row.
  put(path.join(hh, 'worklog.csv'), ['outcome,ticket_hash,date,pr_rework_rounds,notes', `Merged,${H1.slice(0, 12)},2026-10-01,2,"free text, with a comma"`, 'merged,not-a-hash,2026-10-02,1,x'].join('\r\n') + '\r\n');

  // Self-check records.
  recordStep('devin', 4, 'pass: saw MARKER-GLOBAL-PROBE and MARKER-HOOK-START', undefined, new Date('2026-10-04T00:00:00.000Z'));
  recordStep('devin', 11, 'different: the agent waited the full 10 s', undefined, new Date('2026-10-04T00:01:00.000Z'));
}
