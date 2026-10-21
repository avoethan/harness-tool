/**
 * `harness judgment submit <id> --from <file>|-` (`-` reads standard input)
 * `harness judgment list [--json]`
 *
 * The one channel through which the driving agent hands a judgment result to
 * the harness. The judgment passes (assess, discover, learn) write a bundle
 * and a prompt under ~/.harness/judgment/<id>/; the agent may not write there
 * itself (the self-protection rail denies agent file tools on the harness
 * state), so it writes its answer anywhere it may write (the system temp
 * folder, never a team repository) or pipes it in, and runs this command.
 *
 * submit checks only what keeps the state safe: the id names an existing
 * bundle folder; the input is at most 1 MiB of JSON with `version: 1`, no
 * hidden Unicode; a discovery result that was already imported is never
 * replaced (discovery re-counts imported results on every run). The full
 * validation stays with the import command it prints next
 * (`harness assess|discover|learn --import-judgment <id>`), unchanged.
 *
 * Exit 0 saved; 1 refused (the reason says what to do); 2 usage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { flagBool, flagStr, parseArgv } from '../lib/argv';
import { readJsonOr, writeTextAtomic } from '../lib/fsx';
import { loadConfig } from '../lib/config';
import { harnessHome } from '../lib/paths';
import { instrument } from '../lib/log';
import { scanHiddenUnicode } from '../lib/unicode';

export const meta: CommandMeta = {
  name: 'judgment',
  summary: 'Hand a judgment result to the harness (the agent may not write the harness state itself)',
  usage: 'harness judgment submit <id> --from <file>|- | list [--json]',
  examples: ['harness judgment submit j20261019-a1b2c3 --from /tmp/judgment-result.json', 'harness judgment list'],
};

export const MAX_RESULT_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

export type JudgmentKind = 'assess' | 'discover' | 'learn';

export function judgmentRoot(): string {
  return path.join(harnessHome(), 'judgment');
}

/** Which pass wrote a bundle, from its bundle.json. */
export function bundleKind(bundle: Record<string, unknown>): JudgmentKind {
  if (bundle.kind === 'learn') return 'learn';
  if (typeof bundle.reportSha256 === 'string') return 'assess';
  return 'discover';
}

/** The import command that comes after a submit. */
export function importCommand(kind: JudgmentKind, id: string, workspace?: string): string {
  if (kind === 'assess') return `harness assess --import-judgment ${id}`;
  if (kind === 'learn') return `harness learn --import-judgment ${id}`;
  return `harness discover --root ${workspace ? JSON.stringify(workspace) : '<workspace>'} --import-judgment ${id}`;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
  kind?: JudgmentKind;
  file?: string;
  next?: string;
  replaced?: boolean;
}

/** Validate and store one result as ~/.harness/judgment/<id>/result.json. */
export function submitJudgment(id: string, text: string): SubmitResult {
  if (!ID_RE.test(id)) return { ok: false, error: `"${id}" is not a judgment bundle id (letters, digits, dot, dash, underscore)` };
  const dir = path.join(judgmentRoot(), id);
  const bundleFile = path.join(dir, 'bundle.json');
  if (!fs.existsSync(bundleFile)) return { ok: false, error: `no judgment bundle ${id} (run \`harness judgment list\` to see the open ones)` };
  const bundle = readJsonOr<Record<string, unknown>>(bundleFile, {});
  const kind = bundleKind(bundle);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) return { ok: false, error: `the result is ${Buffer.byteLength(text, 'utf8')} bytes; the limit is ${MAX_RESULT_BYTES}` };
  const hidden = scanHiddenUnicode(text);
  if (hidden.length) return { ok: false, error: `the result carries ${hidden.length} hidden Unicode character(s) (${[...new Set(hidden.map((h) => h.kind))].join(', ')}); write it again without them` };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `the result is not valid JSON (${(e as Error).message}); the prompt.md of the bundle shows the shape` };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || (j as { version?: unknown }).version !== 1) return { ok: false, error: 'the result must be a JSON object with "version": 1 (the prompt.md of the bundle shows the shape)' };
  const imported = readJsonOr<{ ids?: string[] }>(path.join(judgmentRoot(), 'imported.json'), {}).ids ?? [];
  const file = path.join(dir, 'result.json');
  const replaced = fs.existsSync(file);
  if (replaced && kind === 'discover' && imported.includes(id)) return { ok: false, error: `bundle ${id} was already imported; its result is never replaced. Start a new pass: harness discover --judgment` };
  writeTextAtomic(file, text.endsWith('\n') ? text : text + '\n');
  const ws = loadConfig()?.workspaceRoot;
  return { ok: true, kind, file, replaced, next: importCommand(kind, id, ws) };
}

function readInput(from: string): { text: string } | { error: string } {
  if (from === '-') {
    try {
      return { text: fs.readFileSync(0, 'utf8') };
    } catch {
      return { error: 'nothing on standard input' };
    }
  }
  try {
    const st = fs.statSync(from);
    if (!st.isFile()) return { error: `${from} is not a file` };
    if (st.size > MAX_RESULT_BYTES) return { error: `${from} is ${st.size} bytes; the limit is ${MAX_RESULT_BYTES}` };
    return { text: fs.readFileSync(from, 'utf8') };
  } catch {
    return { error: `cannot read ${from}` };
  }
}

function listBundles(): Array<{ id: string; kind: JudgmentKind; result: boolean; imported: boolean; createdAt?: string }> {
  const root = judgmentRoot();
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const imported = readJsonOr<{ ids?: string[] }>(path.join(root, 'imported.json'), {}).ids ?? [];
  const out = [];
  for (const id of names.sort()) {
    const b = readJsonOr<Record<string, unknown> | null>(path.join(root, id, 'bundle.json'), null);
    if (!b) continue;
    out.push({ id, kind: bundleKind(b), result: fs.existsSync(path.join(root, id, 'result.json')), imported: imported.includes(id), createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined });
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv);
  const [sub, id] = a.positional;
  if (sub === 'list') {
    const rows = listBundles();
    if (flagBool(a, 'json')) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    else if (!rows.length) process.stdout.write('No judgment bundles.\n');
    else for (const r of rows) process.stdout.write(`${r.id}  ${r.kind}  ${r.result ? 'result saved' : 'waiting for a result'}${r.imported ? ', imported' : ''}\n`);
    return 0;
  }
  if (sub !== 'submit' || !id) {
    process.stderr.write(`judgment: usage: ${meta.usage}\n`);
    return 2;
  }
  const from = flagStr(a, 'from');
  if (!from) {
    process.stderr.write('judgment: --from <file> or --from - (standard input) is required\n');
    return 2;
  }
  const input = readInput(from);
  if ('error' in input) {
    process.stderr.write(`judgment: ${input.error}\n`);
    return 1;
  }
  const r = submitJudgment(id, input.text);
  instrument({ event: 'judgment.submit', ids: { bundle: ID_RE.test(id) ? id : 'invalid', ok: r.ok ? 'yes' : 'no', kind: r.kind ?? 'unknown' }, counts: { bytes: Buffer.byteLength(input.text, 'utf8') } });
  if (!r.ok) {
    process.stderr.write(`judgment: refused: ${r.error}\n`);
    return 1;
  }
  process.stdout.write(`Saved the result for ${r.kind} bundle ${id}${r.replaced ? ' (replacing the earlier one)' : ''}.\nNext: ${r.next}\n`);
  return 0;
}
