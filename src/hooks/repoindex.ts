/**
 * What the SessionStart hook prints besides the trail: the repo index (one
 * line per repo: name, path, the one-line verify command), the DB allowlist
 * summary and the integrity status.
 *
 * The verify command is read, never run: the first of the package.json
 * scripts `verify`, `check`, `test`, `ci` (script names from that fixed list
 * only; script bodies are never printed), run with the repo's package
 * manager; else a Makefile `test` target; else `harness gate`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessConfig, RepoRef } from '../types';
import { allowlistHash } from '../lib/config';
import { readJsonOr, readTextOr } from '../lib/fsx';
import { integrityPath, verifyIntegrity } from '../lib/integrity';
import { capLines, oneLine, repoOf } from './common';

const SCRIPT_ORDER = ['verify', 'check', 'test', 'ci'];

function packageManagerOf(root: string, declared?: RepoRef['packageManager']): string {
  if (declared && declared !== 'unknown') return declared;
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** The repo's one-line verify command (read from its files, never run). */
export function verifyCommandFor(root: string, declared?: RepoRef['packageManager']): string {
  const pj = readJsonOr<{ scripts?: Record<string, unknown> } | null>(path.join(root, 'package.json'), null);
  const scripts = pj?.scripts && typeof pj.scripts === 'object' ? pj.scripts : null;
  if (scripts) {
    const name = SCRIPT_ORDER.find((s) => typeof scripts[s] === 'string');
    if (name) {
      const pm = packageManagerOf(root, declared);
      return name === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${name}`;
    }
  }
  const mk = readTextOr(path.join(root, 'Makefile'), null);
  if (mk && /^test\s*:/m.test(mk)) return 'make test';
  return 'harness gate';
}

/** One line per repo from the config inventory (or the session's own repo when the config lists none). */
export function repoIndexLines(cfg: HarnessConfig, cwd: string, max = 20): string[] {
  const repos: Array<{ name: string; path: string; pm?: RepoRef['packageManager'] }> = (cfg.repos ?? [])
    .filter((r) => r && typeof r.path === 'string')
    .map((r) => ({ name: r.name || path.basename(r.path), path: r.path, pm: r.packageManager }));
  if (!repos.length) {
    const own = repoOf(cwd);
    if (own) repos.push({ name: own.name, path: own.root });
  }
  if (!repos.length) return [];
  const lines = repos.map((r) => `- ${oneLine(r.name, 60)}: ${oneLine(r.path, 200)} | verify: \`${verifyCommandFor(r.path, r.pm)}\``);
  return capLines(lines, max);
}

/** The DB allowlist in one or two lines (hostnames and database names only). */
export function dbSummaryLines(cfg: HarnessConfig): string[] {
  const list = cfg.db?.allowlist ?? [];
  if (!list.length) return ['Database: no target is marked as a test database, so every database command is denied. The user marks targets with `harness db mark` in a terminal.'];
  const tests = list.filter((t) => t.marked === 'test').map((t) => oneLine(t.database ? `${t.server}/${t.database}` : t.server, 80));
  const notTest = list.length - tests.length;
  const signed = !!cfg.db.markedHash && allowlistHash(cfg) === cfg.db.markedHash;
  const shown = tests.slice(0, 6).join(', ') + (tests.length > 6 ? ` (+${tests.length - 6} more)` : '');
  const out = [`Database: test targets ${tests.length ? shown : '(none)'}; ${notTest} marked not-test. Database commands may reach only the test targets.`];
  if (!signed) out.push('Database: the allowlist signature does not match, so the guard denies every database command; the user runs `harness doctor`.');
  return out;
}

/** Integrity of the hook files and config, in one line. */
export function integrityLine(): string {
  if (!fs.existsSync(integrityPath())) return 'Integrity: not signed yet (no integrity manifest; `harness install` writes it).';
  const r = verifyIntegrity();
  if (r.ok) return 'Integrity: ok (hook, guard and config hashes match).';
  return `Integrity: FAILED (${oneLine(r.reason, 80)}); the guard and Stop hook fail closed. The user runs \`harness doctor\`.`;
}
