/**
 * `harness config get [key] [--json]`
 * `harness config set <key> <value> [--from-install]`
 *
 * Reads and changes the machine config (~/.harness/config.json). Dotted keys
 * (`caps.turns`, `reviews.source`); values are parsed as JSON when they are
 * valid JSON, else taken as strings.
 *
 * Self-protection (DESIGN §2.10): `set` runs only from an interactive
 * terminal (stdin and stdout both TTYs). The installer passes
 * `--from-install` because it runs `config set` from a script; nothing else
 * should. An agent running `harness config set` through a tool call has no
 * TTY, so the guard denies it by design; the guard builder may additionally
 * deny the literal command `harness config set` and `--from-install` in
 * agent commands. The database allowlist is never set here: use
 * `harness db mark`, which keeps the marked hash in step.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { ALL_AGENTS, type AgentId, type HarnessConfig } from '../types';
import { flagBool, parseArgv } from '../lib/argv';
import { defaultConfig, loadConfig, saveConfig } from '../lib/config';
import { getPath, setPath } from '../lib/jsonc';
import { instrument } from '../lib/log';
import { configPath } from '../lib/paths';
import { isInteractive } from '../lib/prompt';
import { resignIntegrity } from '../lifecycle/manifest';

export const meta: CommandMeta = {
  name: 'config',
  summary: 'Read or change harness settings from an interactive terminal',
  usage: 'harness config get [key] [--json] | harness config set <key> <value> [--from-install]',
  examples: ['harness config get', 'harness config get caps.turns', 'harness config set setting personal', 'harness config set agents \'["claude","codex"]\''],
};

/** Top-level keys `set` may touch. Everything else is refused. */
export const SETTABLE_TOP = new Set(['setting', 'agents', 'workspaceRoot', 'repos', 'mcp', 'caps', 'include', 'reviews', 'verify']);

/** Keys that `set` must never write: the DB allowlist has its own command with a hash; the rest is bookkeeping. */
export function refusedKeyReason(key: string): string | null {
  const top = key.split('.')[0];
  if (top === 'db') return 'the database allowlist is set with `harness db mark` (it keeps the marked hash in step); `harness config set` never writes db.*';
  if (top === 'version' || top === 'createdAt' || top === 'updatedAt') return `${top} is maintained by the harness`;
  if (!SETTABLE_TOP.has(top)) return `unknown setting "${top}"; settable keys: ${[...SETTABLE_TOP].join(', ')}`;
  return null;
}

export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Validate and apply one dotted-key change. Returns an error message or null. */
export function setConfigValue(c: HarnessConfig, key: string, value: unknown): string | null {
  const refused = refusedKeyReason(key);
  if (refused) return refused;
  switch (key) {
    case 'setting':
      if (value !== 'team' && value !== 'personal') return 'setting must be "team" or "personal"';
      break;
    case 'agents': {
      const list = typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;
      if (!Array.isArray(list) || !list.length || !list.every((a) => ALL_AGENTS.includes(a as AgentId))) return `agents must be a list from ${ALL_AGENTS.join(', ')}`;
      value = list;
      break;
    }
    case 'workspaceRoot':
      if (typeof value !== 'string' || !path.isAbsolute(value)) return 'workspaceRoot must be an absolute path';
      break;
    case 'reviews.source':
      if (value !== 'github-api' && value !== 'pasted' && value !== 'none') return 'reviews.source must be github-api, pasted or none';
      break;
    // verify.* (VerifyConfig): nothing here widens the DB rail, every identity is still checked against db.allowlist.
    case 'verify.db.passwordEnv':
      // The *name* of the variable, never the password: refuse anything that does not look like a variable name.
      if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(value)) return 'verify.db.passwordEnv is the NAME of an environment variable (upper case, digits, _), for example DB_PASSWORD; never the password itself';
      break;
    case 'verify.db.user':
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.@\\-]{1,128}$/.test(value)) return 'verify.db.user must be a login name (letters, digits, _ . @ \\ -)';
      break;
    case 'verify.db.server':
      if (typeof value !== 'string' || !/^[A-Za-z0-9_.\\-]+(,\d{1,5})?$/.test(value)) return 'verify.db.server must be host[,port], for example localhost,1433';
      break;
    case 'verify.db.sqlcmd':
      if (value !== 'auto' && value !== 'local' && value !== 'docker') return 'verify.db.sqlcmd must be auto, local or docker';
      break;
    case 'verify.db.mode':
      if (value !== 'per-run' && value !== 'existing') return 'verify.db.mode must be per-run or existing';
      break;
    case 'verify.db.migrateAfterSnapshot':
      if (typeof value !== 'boolean') return 'verify.db.migrateAfterSnapshot must be true or false';
      break;
    default:
      if (key === 'verify' || key === 'verify.db') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return `${key} must be a JSON object`;
      } else if (key === 'verify.portBase' || key === 'verify.readyTimeoutMs') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return `${key} must be a positive whole number`;
      } else if (key.startsWith('caps.')) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `${key} must be a non-negative number`;
      } else if (key === 'caps' || key === 'mcp' || key === 'reviews') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return `${key} must be a JSON object`;
      } else if (key === 'repos' || key === 'include') {
        if (!Array.isArray(value)) return `${key} must be a JSON array`;
      }
  }
  setPath(c as unknown as Record<string, unknown>, key, value);
  return null;
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, new Set(['json', 'from-install', 'help', 'h']));
  const sub = p.positional[0] ?? 'get';
  const json = flagBool(p, 'json');

  if (sub === 'get') {
    const c = loadConfig();
    const key = p.positional[1];
    if (!c) {
      process.stdout.write(json ? 'null\n' : `No config yet at ${configPath()}; run \`harness install\` or \`harness config set <key> <value>\`.\n`);
      return key ? 1 : 0;
    }
    if (!key) {
      process.stdout.write(JSON.stringify(c, null, 2) + '\n');
      return 0;
    }
    const v = getPath(c, key);
    if (v === undefined) {
      process.stderr.write(`no such key: ${key}\n`);
      return 1;
    }
    process.stdout.write((typeof v === 'string' && !json ? v : JSON.stringify(v, null, 2)) + '\n');
    return 0;
  }

  if (sub === 'set') {
    const key = p.positional[1];
    const raw = p.positional[2];
    if (!key || raw === undefined) {
      process.stderr.write(`usage: harness config set <key> <value>\n`);
      return 2;
    }
    const fromInstall = flagBool(p, 'from-install');
    if (!fromInstall && !isInteractive()) {
      process.stderr.write('error: harness config set runs only from an interactive terminal (self-protection: agents cannot change the harness config). Open a terminal and run it there.\n');
      return 4;
    }
    const notes: string[] = [];
    let c = loadConfig();
    if (!c) {
      c = defaultConfig();
      notes.push(`no config yet; creating ${configPath()} with defaults`);
    }
    const err = setConfigValue(c, key, parseValue(raw));
    if (err) {
      process.stderr.write(`error: ${err}\n`);
      return err.startsWith('the database allowlist') ? 4 : 2;
    }
    saveConfig(c);
    resignIntegrity('config.set');
    instrument({ event: 'config.set', ids: { key } });
    for (const n of notes) process.stdout.write(`Note: ${n}\n`);
    process.stdout.write(json ? JSON.stringify({ key, value: getPath(c, key) }) + '\n' : `Set ${key} = ${JSON.stringify(getPath(c, key))}\n`);
    return 0;
  }

  process.stderr.write(`unknown subcommand: ${sub}\nUsage: ${meta.usage}\n`);
  return 2;
}
