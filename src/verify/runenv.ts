/**
 * run.env: the run's variables as `KEY=value` lines (POSIX) and a PowerShell
 * variant. Redacted by construction: a secret-named variable (password,
 * token, key, credential) or a secret-shaped value is never written; the
 * password reaches the services through their process environment only.
 */
import { findSecrets } from '../lib/redact';

/** Variable names that may never appear in run.env. */
export const RUNENV_SECRET_NAME = /(pass(word|wd)?|pwd|secret|token|api_?key|private_?key|credential|cookie|session_?id|bearer|conn(ection)?_?str)/i;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface RunEnvVar {
  key: string;
  value: string;
}

/** True when the pair may be written to run.env. */
export function allowedRunEnv(key: string, value: string): boolean {
  if (!KEY_RE.test(key)) return false;
  if (RUNENV_SECRET_NAME.test(key)) return false;
  if (/[\r\n\0]/.test(value)) return false;
  if (findSecrets(value).length) return false;
  return true;
}

/** Keep only the variables run.env may hold; reports what was dropped (names only). */
export function filterRunEnv(vars: Record<string, string>): { kept: RunEnvVar[]; dropped: string[] } {
  const kept: RunEnvVar[] = [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (allowedRunEnv(key, String(value))) kept.push({ key, value: String(value) });
    else dropped.push(key);
  }
  return { kept, dropped };
}

function posixQuote(v: string): string {
  if (/^[A-Za-z0-9_./:,@%+=-]*$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** POSIX `KEY=value` lines (sourceable with `set -a; . ./run.env; set +a`). */
export function renderPosix(vars: Record<string, string>, header?: string[]): string {
  const { kept } = filterRunEnv(vars);
  const lines = (header ?? []).map((h) => `# ${h}`);
  for (const { key, value } of kept) lines.push(`${key}=${posixQuote(value)}`);
  return lines.join('\n') + '\n';
}

/** PowerShell lines: `$env:KEY = 'value'`. */
export function renderPowerShell(vars: Record<string, string>): string {
  const { kept } = filterRunEnv(vars);
  return kept.map(({ key, value }) => `$env:${key} = '${value.replace(/'/g, "''")}'`).join('\n') + '\n';
}

/** cmd.exe lines: `set "KEY=value"`. */
export function renderCmd(vars: Record<string, string>): string {
  const { kept } = filterRunEnv(vars);
  return kept.map(({ key, value }) => `set "${key}=${value.replace(/"/g, '')}"`).join('\n') + '\n';
}

/** Parse run.env text back into a map (comments and blank lines ignored). */
export function parseRunEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let v = line.slice(eq + 1);
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1).replace(/'\\''/g, "'");
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    out[key] = v;
  }
  return out;
}

/** `orders-api` -> `ORDERS_API` (env stem of a service). */
export function envStem(name: string): string {
  const s = name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return /^[0-9]/.test(s) ? `S_${s}` : s || 'SERVICE';
}
