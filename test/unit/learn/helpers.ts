/** Helpers for learning-loop tests: scripted events, a small ledger with an ast-grep check. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LedgerRecord } from '../../../src/types';
import { findAstGrep } from '../../../src/discover/astgrep';

export { tempHome, git, gitRepo, put, commitAll, demoRepo, type TempHome } from '../gate/helpers';

export const T0 = Date.parse('2026-09-01T10:00:00Z');

export function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

export interface ScriptedEvent {
  ts: string;
  event: string;
  [k: string]: unknown;
}

export const gateFail = (m: number, o: { rules?: string; step?: string; session?: string; repo?: string; task?: string } = {}): ScriptedEvent => ({
  ts: at(m),
  event: 'gate.fail',
  repo: o.repo ?? 'repo-a',
  task: o.task ?? 't1',
  sessionId: o.session ?? 's1',
  ids: { step: o.step ?? 'standards', kind: (o.step ?? 'standards').split(':')[0], mode: 'task', ...(o.rules ? { rules: o.rules } : {}) },
  counts: { reasons: 1, attempt: 1 },
});

export const correction = (m: number, cls: string, session = 's1', extra: Record<string, unknown> = {}): ScriptedEvent => ({ ts: at(m), event: 'correction', sessionId: session, agent: 'claude', class: cls, ids: { ticket: 'abc123' }, ...extra });

export function writeEvents(harnessHome: string, events: ScriptedEvent[], append = false): string {
  const p = path.join(harnessHome, 'logs', 'events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (append) fs.appendFileSync(p, text);
  else fs.writeFileSync(p, text);
  return p;
}

export const CONSOLE_RULE = {
  id: 'logging.logger-not-console/console',
  language: 'TypeScript',
  severity: 'info',
  rule: {
    kind: 'call_expression',
    has: {
      field: 'function',
      kind: 'member_expression',
      all: [{ has: { field: 'object', regex: '^console$' } }, { has: { field: 'property', regex: '^(log|info|warn|error|debug|trace)$' } }],
    },
  },
};

export function record(id: string, o: Partial<LedgerRecord> & { mode?: 'block' | 'warn' | 'judgment'; type?: LedgerRecord['check']['type'] } = {}): LedgerRecord {
  return {
    id,
    statement: o.statement ?? 'Log through the project logger, never console.*.',
    family: o.family ?? (id.split('.')[0] as LedgerRecord['family']),
    scope: o.scope ?? { repos: ['*'] },
    tier: o.tier ?? 'counted-majority',
    confidence: 0.85,
    evidence: { sites: 10, conforming: 8, packages: 1, examples: [], sources: [] },
    check: { type: o.type ?? 'ast-grep', mode: o.mode ?? 'warn', ref: `${id}.json`, fixText: 'Use logger.info / logger.error.' },
    conflicts: [],
    provenance: [],
    history: { firstSeen: '2026-01-01', lastCounted: '2026-01-01', disputes: 0 },
  };
}

/** Write a discovered ledger (ledger.json + one spec per record) into a harness home. */
export function writeLedger(harnessHome: string, records: Array<{ rec: LedgerRecord; spec: Record<string, unknown> }>, workspaceRoot = '/'): void {
  const dir = path.join(harnessHome, 'ledger');
  fs.mkdirSync(path.join(dir, 'checks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ version: 1, generatedAt: '2026-01-01T00:00:00Z', workspaceRoot, records: records.map((r) => r.rec), skipped: [], scanners: [] }));
  for (const { rec, spec } of records) {
    fs.writeFileSync(path.join(dir, 'checks', `${rec.id}.json`), JSON.stringify({ version: 1, id: rec.id, mode: rec.check.mode, statement: rec.statement, fixText: rec.check.fixText, scope: rec.scope, ...spec }));
  }
}

export function consoleSpec(): Record<string, unknown> {
  return { engine: 'ast-grep', files: ['**/*.ts'], rules: [CONSOLE_RULE] };
}

/** ast-grep from the harness's own node_modules, or a skip reason. */
export function astGrepOrSkip(): { bin: ReturnType<typeof findAstGrep>; skip?: string } {
  const bin = findAstGrep();
  return bin ? { bin } : { bin: null, skip: 'ast-grep is not installed (npm install in harness/ adds @ast-grep/cli); skipped' };
}
