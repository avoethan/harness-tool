/**
 * `harness db` — the test-database allowlist (DESIGN §2.10).
 *
 *   harness db list [--json]
 *   harness db mark --server <host[,port]> [--database <name>] --test|--read-only|--not-test
 *   harness db mark                       (interactive: asks per discovered candidate)
 *   harness db unmark --server <host[,port]> [--database <name>]
 *   harness db candidates [--json]
 *
 * Every database command the agent runs is denied unless each resolved target
 * is marked `test` here, or `read-only` and the command is inline SQL the
 * guard proves only reads (src/guard/sqlreadonly.ts). The list holds hostnames (and optional port and
 * database name) only; never a user, password or connection string. Each
 * change recomputes `markedHash`, which the guard checks before trusting the
 * list, and re-signs the integrity manifest.
 *
 * Candidates come from `~/.harness/ledger/db-candidates.json`, written by a
 * later discovery step as `{ version: 1, generatedAt, candidates: [{ server,
 * database?, sources?: string[] }] }`.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import type { DbTarget, HarnessConfig } from '../types';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { allowlistHash, defaultConfig, loadConfig, saveConfig } from '../lib/config';
import { readJsonOr } from '../lib/fsx';
import { instrument } from '../lib/log';
import { configPath, harnessHome } from '../lib/paths';
import { askChoice, isInteractive } from '../lib/prompt';
import { resignIntegrity } from '../lifecycle/manifest';

export const meta: CommandMeta = {
  name: 'db',
  summary: 'Mark databases as test / read-only / not-test (the safety allowlist)',
  usage: 'harness db list | mark --server <host[,port]> [--database <name>] --test|--read-only|--not-test | unmark --server <host> [--database <name>] | candidates  [--json]',
  examples: [
    'harness db mark --server localhost,1433 --database shop_test --test',
    'harness db mark --server sql-shared --database reporting --read-only   (the agent may run inline SELECTs only; mark one database, not the whole server)',
    'harness db list',
    'harness db mark   (interactive, from discovered candidates)',
  ],
};

export interface DbCandidate {
  server: string;
  database?: string;
  sources?: string[];
}

export interface DbCandidatesFile {
  version: 1;
  generatedAt?: string;
  candidates: DbCandidate[];
}

export function candidatesPath(): string {
  return path.join(harnessHome(), 'ledger', 'db-candidates.json');
}

export function loadCandidates(): DbCandidatesFile | null {
  const c = readJsonOr<DbCandidatesFile | null>(candidatesPath(), null);
  return c && c.version === 1 && Array.isArray(c.candidates) ? c : null;
}

/** Normalise a server spelling: trimmed, lower-cased, `host,port` with no spaces. */
export function normaliseServer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ',')
    .replace(/^tcp:/, '');
}

/**
 * Hostnames only. Anything that looks like a connection string, a URL with
 * credentials, or carries a password is refused so no secret ever lands in
 * the config.
 */
export function validateServer(s: string): string | null {
  if (!s) return 'a server name is required (--server <host[,port]>)';
  if (s.length > 253) return 'server name is too long';
  if (/[;=\s"'`]/.test(s)) return 'hostnames only: no connection strings or key=value pairs';
  if (/password|pwd|secret|token/i.test(s)) return 'hostnames only: this looks like a credential';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.includes('@')) return 'hostnames only: no URLs or user@host';
  const m = /^([^,]+)(?:,(\d{1,5}))?$/.exec(s);
  if (!m) return 'expected <host> or <host,port>';
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return 'port must be 1..65535';
  if (!/^[a-z0-9._\\\-]+$/i.test(m[1]) && !/^\[[0-9a-f:]+\]$/i.test(m[1])) return 'host may contain letters, digits, dots, hyphens, underscores and a backslash instance name only';
  return null;
}

export function validateDatabase(d: string | undefined): string | null {
  if (d === undefined) return null;
  if (!d.trim()) return 'database name is empty';
  if (d.length > 128 || /[;=\s"'`]/.test(d)) return 'database names carry no spaces, quotes, ";" or "="';
  return null;
}

function sameTarget(a: DbTarget, b: { server: string; database?: string }): boolean {
  return a.server.toLowerCase() === b.server.toLowerCase() && (a.database ?? '').toLowerCase() === (b.database ?? '').toLowerCase();
}

/** Add or update one entry and recompute the hash. Returns whether it was new. */
export function markTarget(c: HarnessConfig, t: DbTarget, now: Date = new Date()): boolean {
  const idx = c.db.allowlist.findIndex((x) => sameTarget(x, t));
  const isNew = idx < 0;
  if (isNew) c.db.allowlist.push({ server: t.server, database: t.database, marked: t.marked });
  else c.db.allowlist[idx] = { ...c.db.allowlist[idx], marked: t.marked };
  for (const x of c.db.allowlist) if (x.database === undefined) delete x.database;
  c.db.markedAt = now.toISOString();
  c.db.markedHash = allowlistHash(c);
  return isNew;
}

export function unmarkTarget(c: HarnessConfig, t: { server: string; database?: string }, now: Date = new Date()): boolean {
  const before = c.db.allowlist.length;
  c.db.allowlist = c.db.allowlist.filter((x) => !sameTarget(x, t));
  if (c.db.allowlist.length === before) return false;
  c.db.markedAt = now.toISOString();
  c.db.markedHash = allowlistHash(c);
  return true;
}

function loadOrCreate(notes: string[]): HarnessConfig {
  const c = loadConfig();
  if (c) return c;
  notes.push(`no config yet; creating ${configPath()} with defaults (run \`harness install\` to finish the setup)`);
  return defaultConfig();
}

function formatList(c: HarnessConfig | null): string {
  if (!c || !c.db.allowlist.length) {
    return [
      'Database allowlist: empty. Every database command is denied until you mark a test server:',
      '  harness db mark --server <host[,port]> [--database <name>] --test',
    ].join('\n');
  }
  const lines = ['Database allowlist (effective for every setting):'];
  const w = Math.max(...c.db.allowlist.map((x) => x.server.length), 6);
  for (const x of c.db.allowlist) lines.push(`  ${x.server.padEnd(w)}  ${(x.database ?? '(every database)').padEnd(20)}  ${x.marked.padEnd(9)}  marked ${c.db.markedAt ?? 'unknown'}`);
  const live = allowlistHash(c);
  lines.push(`  hash: ${live}`);
  if (c.db.markedHash !== live) lines.push('  WARNING: the stored hash does not match the list; it was edited outside `harness db mark`. Re-mark to fix (the guard denies every database command until then).');
  const tests = c.db.allowlist.filter((x) => x.marked === 'test').length;
  const readOnly = c.db.allowlist.filter((x) => x.marked === 'read-only').length;
  if (readOnly) lines.push('  read-only: the agent may run only inline SELECT statements there; anything else is denied and it asks you');
  if (!tests && !readOnly) lines.push('  no server is marked test: every database command is still denied');
  else if (!tests) lines.push('  no server is marked test: only inline reads of the read-only entries are allowed');
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['json', 'test', 'read-only', 'not-test', 'help', 'h', 'yes', 'y']));
  const sub = p.positional[0] ?? 'list';
  const json = flagBool(p, 'json');

  if (sub === 'list') {
    const c = loadConfig();
    if (json) {
      const live = c ? allowlistHash(c) : null;
      process.stdout.write(JSON.stringify({ allowlist: c?.db.allowlist ?? [], markedAt: c?.db.markedAt ?? null, markedHash: c?.db.markedHash ?? null, hash: live, hashMatches: !!c && c.db.markedHash === live }, null, 2) + '\n');
    } else process.stdout.write(formatList(c) + '\n');
    return 0;
  }

  if (sub === 'candidates') {
    const cf = loadCandidates();
    if (json) {
      process.stdout.write(JSON.stringify(cf ?? { version: 1, candidates: [] }, null, 2) + '\n');
      return 0;
    }
    if (!cf || !cf.candidates.length) {
      process.stdout.write(`No discovered candidates yet (${candidatesPath()} is ${cf ? 'empty' : 'missing'}; \`harness discover\` writes it).\nMark a server by hand:\n  harness db mark --server <host[,port]> [--database <name>] --test|--read-only|--not-test\n`);
      return 0;
    }
    const c = loadConfig();
    process.stdout.write(`Candidate servers (hostnames only)${cf.generatedAt ? `, discovered ${cf.generatedAt}` : ''}:\n`);
    for (const x of cf.candidates) {
      const marked = c?.db.allowlist.find((a) => sameTarget(a, x))?.marked ?? 'unmarked';
      process.stdout.write(`  ${x.server}${x.database ? `  ${x.database}` : ''}  [${marked}]${x.sources?.length ? `  from ${x.sources.length} source(s)` : ''}\n`);
    }
    process.stdout.write('Mark each with: harness db mark --server <host[,port]> [--database <name>] --test|--read-only|--not-test\n');
    return 0;
  }

  if (sub === 'mark' || sub === 'unmark') {
    const notes: string[] = [];
    const serverRaw = flagStr(p, 'server');
    const database = flagStr(p, 'database') ?? flagStr(p, 'db');
    const isTest = flagBool(p, 'test');
    const isReadOnly = flagBool(p, 'read-only');
    const isNotTest = flagBool(p, 'not-test');
    const marks = [isTest, isReadOnly, isNotTest].filter(Boolean).length;

    if (sub === 'mark' && !serverRaw && !marks) return interactiveMark(json, notes);

    if (!serverRaw) {
      process.stderr.write(`error: --server <host[,port]> is required\n`);
      return 2;
    }
    const server = normaliseServer(serverRaw);
    const bad = validateServer(server) ?? validateDatabase(database);
    if (bad) {
      process.stderr.write(`error: ${bad}\n`);
      return 2;
    }
    const c = loadOrCreate(notes);
    if (sub === 'unmark') {
      const removed = unmarkTarget(c, { server, database });
      if (!removed) {
        process.stdout.write(`Not in the list: ${server}${database ? ` ${database}` : ''}\n`);
        return 0;
      }
    } else {
      if (marks !== 1) {
        process.stderr.write(`error: ${marks ? 'give only one of' : 'say which it is:'} --test, --read-only or --not-test\n`);
        return 2;
      }
      markTarget(c, { server, database, marked: isTest ? 'test' : isReadOnly ? 'read-only' : 'not-test' });
      if (isReadOnly && !database) notes.push('a server-wide read-only mark covers every database on that server; the normal use is one database (--database <name>)');
    }
    saveConfig(c);
    resignIntegrity('db.' + sub);
    instrument({ event: `db.${sub}`, counts: { allowlist: c.db.allowlist.length, test: c.db.allowlist.filter((x) => x.marked === 'test').length, readOnly: c.db.allowlist.filter((x) => x.marked === 'read-only').length } });
    for (const n of notes) process.stdout.write(`Note: ${n}\n`);
    if (json) process.stdout.write(JSON.stringify({ allowlist: c.db.allowlist, markedAt: c.db.markedAt, markedHash: c.db.markedHash }, null, 2) + '\n');
    else {
      process.stdout.write(sub === 'mark' ? `Marked ${server}${database ? ` ${database}` : ' (every database)'} as ${isTest ? 'test' : isReadOnly ? 'read-only' : 'not-test'}.\n` : `Removed ${server}${database ? ` ${database}` : ''}.\n`);
      process.stdout.write(formatList(c) + '\n');
    }
    return 0;
  }

  process.stderr.write(`unknown subcommand: ${sub}\nUsage: ${meta.usage}\n`);
  return 2;
}

/** The answers the interactive prompt offers for each candidate (first letters work too). */
export const MARK_CHOICES = ['test', 'read-only', 'not-test', 'skip'];

export async function interactiveMark(json: boolean, notes: string[], ask: typeof askChoice = askChoice, interactive: () => boolean = isInteractive): Promise<number> {
  if (!interactive()) {
    process.stderr.write('error: no flags given and no terminal to ask in. Use: harness db mark --server <host[,port]> [--database <name>] --test|--read-only|--not-test\n');
    return 2;
  }
  const cf = loadCandidates();
  if (!cf || !cf.candidates.length) {
    process.stdout.write(`No discovered candidates to ask about (${candidatesPath()} is ${cf ? 'empty' : 'missing'}).\nMark a server by hand:\n  harness db mark --server <host[,port]> [--database <name>] --test\n`);
    return 0;
  }
  const c = loadOrCreate(notes);
  let changed = 0;
  process.stdout.write('For each discovered server, say whether it is a test database (the agent may read and write), read-only (the agent may run inline SELECTs only) or not-test (denied).\n');
  for (const x of cf.candidates) {
    const server = normaliseServer(x.server);
    if (validateServer(server)) {
      process.stdout.write(`  skipping ${x.server}: not a plain hostname\n`);
      continue;
    }
    const current = c.db.allowlist.find((a) => sameTarget(a, { server, database: x.database }))?.marked;
    const answer = await ask(`  ${server}${x.database ? ` ${x.database}` : ''}${current ? ` (now: ${current})` : ''}:`, MARK_CHOICES, 'skip');
    if (answer === 'skip') continue;
    markTarget(c, { server, database: x.database, marked: answer as DbTarget['marked'] });
    changed++;
  }
  if (!changed) {
    process.stdout.write('Nothing marked.\n');
    return 0;
  }
  saveConfig(c);
  resignIntegrity('db.mark');
  instrument({ event: 'db.mark', counts: { allowlist: c.db.allowlist.length, changed } });
  for (const n of notes) process.stdout.write(`Note: ${n}\n`);
  if (json) process.stdout.write(JSON.stringify({ allowlist: c.db.allowlist, markedAt: c.db.markedAt, markedHash: c.db.markedHash }, null, 2) + '\n');
  else process.stdout.write(formatList(c) + '\n');
  return 0;
}
