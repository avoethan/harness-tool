/**
 * File-scoped lint for the PostToolUse hook (DESIGN §2.4): the repo's own
 * formatter check (Prettier), ESLint, and for `.sql` files tsqllint or
 * sqlfluff, on the single edited file, with a total budget under 20 s.
 *
 * Rules:
 *  - binaries come from the repo's own node_modules (searched from the
 *    file's folder up to the repo root) or, for sqlfluff, from PATH; nothing
 *    is ever installed or fetched;
 *  - argv arrays only, every call with a timeout;
 *  - a lint config the agent could have written is never executed: when the
 *    config file a tool would load is untracked or has uncommitted changes,
 *    or the edited file is itself a lint config, that tool is skipped with a
 *    note (ESLint and Prettier configs can be JavaScript; running them from
 *    an unsandboxed hook would let agent-authored code escape the agent's
 *    sandbox);
 *  - a tool that is not installed is reported as absent, never silently skipped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAsync, which } from '../lib/exec';
import { rawGit } from '../lib/git';
import { isWindows } from '../lib/paths';
import { oneLine, relTo } from './common';

export type LintTool = 'prettier' | 'eslint' | 'tsqllint' | 'sqlfluff';

export interface LintFinding {
  tool: LintTool;
  /** Tool rule id (`no-console`, `L010`, `prettier/format`). */
  rule: string;
  line?: number;
  /** The tool's one-line message (tool output; injected to the agent, never logged). */
  message: string;
  severity: 'error' | 'warning';
}

export interface LintRun {
  tool: LintTool;
  status: 'ok' | 'fail' | 'absent' | 'skipped' | 'error' | 'timeout';
  findings: LintFinding[];
  note?: string;
  ms: number;
}

export const LINT_BUDGET_MS = 18_000;

const ESLINT_EXT = /\.(c|m)?(j|t)sx?$|\.(vue|svelte|astro)$/i;
const PRETTIER_EXT = /\.((c|m)?(j|t)sx?|json5?|css|scss|less|md|mdx|ya?ml|html?|vue|graphql|gql|svelte|astro|hbs|handlebars)$/i;
const SQL_EXT = /\.sql$/i;

export const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
export const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.ts', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts'];
const SQLFLUFF_CONFIGS = ['.sqlfluff'];
const TSQLLINT_CONFIGS = ['.tsqllintrc'];

export interface BinRef {
  cmd: string;
  args: string[];
  /** Folder whose node_modules held the binary (the tool's working folder). */
  pkgDir: string;
}

/** Folders from `start` up to and including `root` (start must be inside root). */
function upTo(start: string, root: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(start);
  const top = path.resolve(root);
  for (let i = 0; i < 64; i++) {
    out.push(cur);
    if (cur === top) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

function firstLine(p: string): string {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(200);
      const n = fs.readSync(fd, buf, 0, 200, 0);
      return buf.subarray(0, n).toString('utf8').split(/\r?\n/)[0] ?? '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * The repo's own binary: `node_modules/<pkg>/package.json` `bin`, else
 * `node_modules/.bin/<name>`, searched from the file's folder up to the repo
 * root. JavaScript entry points run under this Node (no shell, works on
 * Windows); other executables run directly except on Windows.
 */
export function resolveRepoBin(fromDir: string, repoRoot: string, pkg: string, binName: string): BinRef | null {
  for (const dir of upTo(fromDir, repoRoot)) {
    const pkgDir = path.join(dir, 'node_modules', pkg);
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
      const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[binName];
      if (rel) {
        const js = path.resolve(pkgDir, rel);
        if (fs.existsSync(js)) return { cmd: process.execPath, args: [js], pkgDir: dir };
      }
    } catch {
      /* not here */
    }
    const link = path.join(dir, 'node_modules', '.bin', binName);
    if (fs.existsSync(link)) {
      let real = link;
      try {
        real = fs.realpathSync(link);
      } catch {
        /* keep link */
      }
      const head = firstLine(real);
      if (/\.(c|m)?js$/i.test(real) || (head.startsWith('#!') && /\bnode\b/.test(head))) return { cmd: process.execPath, args: [real], pkgDir: dir };
      if (!isWindows) return { cmd: real, args: [], pkgDir: dir };
    }
  }
  return null;
}

/** Nearest config file among `names`, from the file's folder up to the repo root. */
export function nearestConfig(fromDir: string, repoRoot: string, names: string[], pkgJsonKey?: string): string | null {
  for (const dir of upTo(fromDir, repoRoot)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
    if (pkgJsonKey) {
      const pj = path.join(dir, 'package.json');
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8')) as Record<string, unknown>;
        if (j && typeof j === 'object' && pkgJsonKey in j) return pj;
      } catch {
        /* none */
      }
    }
  }
  return null;
}

/** Config files with uncommitted changes or untracked (relative to the repo root). */
export function untrustedConfigs(repoRoot: string, configs: string[]): Set<string> {
  const out = new Set<string>();
  if (!configs.length) return out;
  const rels = configs.map((c) => relTo(repoRoot, c));
  const r = rawGit(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...rels], 5000);
  if (r.code !== 0) {
    for (const c of configs) out.add(c);
    return out;
  }
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const f = line.slice(3).trim().replace(/^"|"$/g, '');
    const hit = configs.find((c) => relTo(repoRoot, c) === f || f.endsWith('-> ' + relTo(repoRoot, c)));
    if (hit) out.add(hit);
  }
  return out;
}

function noColorEnv(): NodeJS.ProcessEnv {
  return { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
}

async function runEslint(bin: BinRef, file: string, timeoutMs: number): Promise<LintRun> {
  const t0 = Date.now();
  const r = await runAsync(bin.cmd, [...bin.args, '--format', 'json', file], { cwd: bin.pkgDir, timeoutMs, env: noColorEnv() });
  const ms = Date.now() - t0;
  if (r.timedOut) return { tool: 'eslint', status: 'timeout', findings: [], note: `ESLint did not finish in ${Math.round(timeoutMs / 1000)} s`, ms };
  let parsed: Array<{ messages?: Array<{ ruleId?: string | null; severity?: number; message?: string; line?: number; fatal?: boolean }> }> | null = null;
  try {
    const text = r.stdout.trim();
    parsed = JSON.parse(text.slice(text.indexOf('[')));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return { tool: 'eslint', status: 'error', findings: [], note: `ESLint could not lint this file (exit ${r.code}); run it yourself to see why`, ms };
  const findings: LintFinding[] = [];
  let fatal = false;
  for (const res of parsed) {
    for (const m of res.messages ?? []) {
      if (!m.ruleId) {
        if (m.fatal) {
          fatal = true;
          findings.push({ tool: 'eslint', rule: 'eslint/parse', line: m.line, message: oneLine(m.message ?? 'parse error', 160), severity: 'error' });
        }
        continue; // "File ignored ..." and similar notices
      }
      findings.push({ tool: 'eslint', rule: m.ruleId, line: m.line, message: oneLine(m.message ?? '', 160), severity: m.severity === 2 ? 'error' : 'warning' });
    }
  }
  const errors = findings.filter((f) => f.severity === 'error');
  return { tool: 'eslint', status: errors.length || fatal ? 'fail' : 'ok', findings, ms };
}

async function runPrettier(bin: BinRef, file: string, timeoutMs: number): Promise<LintRun> {
  const t0 = Date.now();
  const r = await runAsync(bin.cmd, [...bin.args, '--check', file], { cwd: bin.pkgDir, timeoutMs, env: noColorEnv() });
  const ms = Date.now() - t0;
  if (r.timedOut) return { tool: 'prettier', status: 'timeout', findings: [], note: `Prettier did not finish in ${Math.round(timeoutMs / 1000)} s`, ms };
  if (r.code === 0) return { tool: 'prettier', status: 'ok', findings: [], ms };
  if (r.code === 1) {
    return { tool: 'prettier', status: 'fail', findings: [{ tool: 'prettier', rule: 'prettier/format', message: 'the file is not formatted with the repo\'s Prettier config', severity: 'error' }], ms };
  }
  return { tool: 'prettier', status: 'skipped', findings: [], note: 'Prettier could not check this file type', ms };
}

const TSQLLINT_LINE = /\((\d+),\s*\d+\):\s*(error|warning)\s+([A-Za-z0-9-]+)\s*:\s*(.*)$/;

async function runTsqllint(bin: BinRef, file: string, timeoutMs: number): Promise<LintRun> {
  const t0 = Date.now();
  const r = await runAsync(bin.cmd, [...bin.args, file], { cwd: bin.pkgDir, timeoutMs, env: noColorEnv() });
  const ms = Date.now() - t0;
  if (r.timedOut) return { tool: 'tsqllint', status: 'timeout', findings: [], note: 'tsqllint did not finish in time', ms };
  const findings: LintFinding[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = TSQLLINT_LINE.exec(line);
    if (m) findings.push({ tool: 'tsqllint', rule: m[3], line: Number(m[1]), message: oneLine(m[4], 160), severity: m[2] === 'error' ? 'error' : 'warning' });
  }
  if (!findings.length && r.code !== 0) return { tool: 'tsqllint', status: 'error', findings, note: `tsqllint could not lint this file (exit ${r.code})`, ms };
  return { tool: 'tsqllint', status: findings.some((f) => f.severity === 'error') ? 'fail' : 'ok', findings, ms };
}

async function runSqlfluff(cmd: string, configDir: string, file: string, timeoutMs: number): Promise<LintRun> {
  const t0 = Date.now();
  const r = await runAsync(cmd, ['lint', file, '--format', 'json', '--nocolor'], { cwd: configDir, timeoutMs, env: noColorEnv() });
  const ms = Date.now() - t0;
  if (r.timedOut) return { tool: 'sqlfluff', status: 'timeout', findings: [], note: 'sqlfluff did not finish in time', ms };
  let parsed: Array<{ violations?: Array<{ code?: string; description?: string; line_no?: number; start_line_no?: number }> }> | null = null;
  try {
    const text = r.stdout.trim();
    parsed = JSON.parse(text.slice(text.indexOf('[')));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return { tool: 'sqlfluff', status: 'error', findings: [], note: `sqlfluff could not lint this file (exit ${r.code})`, ms };
  const findings: LintFinding[] = [];
  for (const f of parsed) for (const v of f.violations ?? []) findings.push({ tool: 'sqlfluff', rule: String(v.code ?? 'sqlfluff'), line: v.start_line_no ?? v.line_no, message: oneLine(v.description ?? '', 160), severity: 'error' });
  return { tool: 'sqlfluff', status: findings.length ? 'fail' : 'ok', findings, ms };
}

/** Lint one edited file with the repo's own tools. Never throws. */
export async function lintFile(file: string, repoRoot: string, opts: { budgetMs?: number } = {}): Promise<LintRun[]> {
  const deadline = Date.now() + (opts.budgetMs ?? LINT_BUDGET_MS);
  const left = (cap: number) => Math.max(0, Math.min(cap, deadline - Date.now()));
  const runs: LintRun[] = [];
  if (!fs.existsSync(file)) return runs;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const isConfig = [...ESLINT_CONFIGS, ...PRETTIER_CONFIGS, ...SQLFLUFF_CONFIGS, ...TSQLLINT_CONFIGS].includes(base);
  if (isConfig) return [{ tool: 'eslint', status: 'skipped', findings: [], note: 'the edited file is a lint config; the hook does not run configs it cannot trust', ms: 0 }];

  const wantsEslint = ESLINT_EXT.test(base);
  const wantsPrettier = PRETTIER_EXT.test(base);
  const wantsSql = SQL_EXT.test(base);
  if (!wantsEslint && !wantsPrettier && !wantsSql) return runs;

  const eslintCfg = wantsEslint ? nearestConfig(dir, repoRoot, ESLINT_CONFIGS, 'eslintConfig') : null;
  const prettierCfg = wantsPrettier ? nearestConfig(dir, repoRoot, PRETTIER_CONFIGS, 'prettier') : null;
  const sqlfluffCfg = wantsSql ? nearestConfig(dir, repoRoot, SQLFLUFF_CONFIGS) : null;
  const tsqllintCfg = wantsSql ? nearestConfig(dir, repoRoot, TSQLLINT_CONFIGS) : null;
  const configs = [eslintCfg, prettierCfg, sqlfluffCfg, tsqllintCfg].filter((c): c is string => !!c && path.basename(c) !== 'package.json');
  const pkgJsonCfgs = [eslintCfg, prettierCfg].filter((c): c is string => !!c && path.basename(c) === 'package.json');
  const untrusted = untrustedConfigs(repoRoot, [...new Set([...configs, ...pkgJsonCfgs])]);
  const skipNote = (c: string) => `skipped: ${relTo(repoRoot, c)} is untracked or has uncommitted changes, and the hook does not run lint configs it cannot trust`;

  if (wantsPrettier && prettierCfg) {
    const t0 = Date.now();
    const bin = resolveRepoBin(dir, repoRoot, 'prettier', 'prettier');
    if (!bin) runs.push({ tool: 'prettier', status: 'absent', findings: [], note: 'Prettier is configured but not installed in node_modules', ms: Date.now() - t0 });
    else if (untrusted.has(prettierCfg)) runs.push({ tool: 'prettier', status: 'skipped', findings: [], note: skipNote(prettierCfg), ms: 0 });
    else if (left(6000) > 200) runs.push(await runPrettier(bin, file, left(6000)));
  }
  if (wantsEslint) {
    const t0 = Date.now();
    const bin = resolveRepoBin(dir, repoRoot, 'eslint', 'eslint');
    if (!bin) {
      if (eslintCfg) runs.push({ tool: 'eslint', status: 'absent', findings: [], note: 'ESLint is configured but not installed in node_modules', ms: Date.now() - t0 });
    } else if (!eslintCfg) runs.push({ tool: 'eslint', status: 'skipped', findings: [], note: 'no ESLint config found between the file and the repo root', ms: 0 });
    else if (untrusted.has(eslintCfg)) runs.push({ tool: 'eslint', status: 'skipped', findings: [], note: skipNote(eslintCfg), ms: 0 });
    else if (left(12000) > 200) runs.push(await runEslint(bin, file, left(12000)));
  }
  if (wantsSql) {
    const tsql = resolveRepoBin(dir, repoRoot, 'tsqllint', 'tsqllint');
    const fluff = sqlfluffCfg ? which('sqlfluff') : null;
    if (tsql) {
      if (tsqllintCfg && untrusted.has(tsqllintCfg)) runs.push({ tool: 'tsqllint', status: 'skipped', findings: [], note: skipNote(tsqllintCfg), ms: 0 });
      else if (left(10000) > 200) runs.push(await runTsqllint(tsql, file, left(10000)));
    } else if (fluff && sqlfluffCfg) {
      if (untrusted.has(sqlfluffCfg)) runs.push({ tool: 'sqlfluff', status: 'skipped', findings: [], note: skipNote(sqlfluffCfg), ms: 0 });
      else if (left(10000) > 200) runs.push(await runSqlfluff(fluff, path.dirname(sqlfluffCfg), file, left(10000)));
    } else {
      runs.push({ tool: 'tsqllint', status: 'absent', findings: [], note: 'no SQL linter (tsqllint in node_modules, or sqlfluff with a .sqlfluff config)', ms: 0 });
    }
  }
  return runs;
}
