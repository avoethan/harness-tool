/**
 * Format text the harness writes INTO a repository with that repository's
 * own formatter, so the harness's own files pass the repository's checks
 * (the gate's lint step, pre-commit hooks, CI). Today: Prettier, when the
 * repository declares a Prettier config and has Prettier installed; the
 * text is fed through `prettier --stdin-filepath <path>` as an argv array
 * with a timeout. Anything missing or failing leaves the text unchanged:
 * formatting is a courtesy to the repository, never a gate of its own.
 */
import * as path from 'node:path';
import { run } from './exec';

export interface FormatResult {
  text: string;
  /** Which formatter ran, or why none did. */
  note: 'prettier' | 'no-config' | 'no-binary' | 'failed' | 'timeout' | 'unsupported';
}

export function formatForRepo(repoRoot: string, relPath: string, text: string, opts: { timeoutMs?: number } = {}): FormatResult {
  let lint: typeof import('../hooks/lint');
  try {
    lint = require('../hooks/lint') as typeof import('../hooks/lint');
  } catch {
    return { text, note: 'unsupported' };
  }
  const abs = path.resolve(repoRoot, relPath);
  const dir = path.dirname(abs);
  const cfg = lint.nearestConfig(dir, repoRoot, lint.PRETTIER_CONFIGS, 'prettier');
  if (!cfg) return { text, note: 'no-config' };
  const bin = lint.resolveRepoBin(dir, repoRoot, 'prettier', 'prettier');
  if (!bin) return { text, note: 'no-binary' };
  const r = run(bin.cmd, [...bin.args, '--stdin-filepath', relPath.replace(/\\/g, '/'), '--no-color'], {
    cwd: repoRoot,
    input: text,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  if (r.timedOut) return { text, note: 'timeout' };
  if (r.code !== 0 || !r.stdout) return { text, note: 'failed' };
  return { text: r.stdout, note: 'prettier' };
}
