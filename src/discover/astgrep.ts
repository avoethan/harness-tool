/**
 * The ast-grep scanner: find the binary, scan with a set of compiled rules,
 * and run ast-grep's own `test` command over probe rules.
 *
 * Resolution order (first that reports `ast-grep <version>` wins):
 *   1. HARNESS_AST_GREP (an absolute path; `none` forces "absent", for tests)
 *   2. the platform binary of the optional dependency `@ast-grep/cli-<platform>`
 *      resolved from the harness package
 *   3. the `@ast-grep/cli` launcher in the harness's node_modules, run with node
 *   4. `ast-grep` then `sg` on PATH, only when `--version` says ast-grep
 *      (on Linux `sg` is usually shadow-utils' setgroups, not ast-grep)
 *
 * Every run uses an argv array, a temporary sgconfig.yml that names only the
 * harness's own rule folder, `--custom-languages ignore`, and a timeout.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, runAsync, which } from '../lib/exec';
import { packageRoot } from '../lib/paths';
import { stringifyYaml } from './yaml';

export interface AstGrepBinary {
  /** The program to spawn (a binary, or node for the launcher). */
  cmd: string;
  /** Leading arguments (the launcher script when cmd is node). */
  pre: string[];
  version: string;
  via: 'env' | 'harness' | 'harness-launcher' | 'path';
}

export interface AstMatch {
  ruleId: string;
  file: string;
  /** 0-based line of the match start. */
  line: number;
  startByte: number;
  endByte: number;
  text: string;
  lines: string;
  captures: Record<string, string>;
}

function platformPackage(): string | null {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? '@ast-grep/cli-darwin-arm64' : arch === 'x64' ? '@ast-grep/cli-darwin-x64' : null;
  if (platform === 'win32') {
    if (arch === 'arm64') return '@ast-grep/cli-win32-arm64-msvc';
    if (arch === 'ia32') return '@ast-grep/cli-win32-ia32-msvc';
    if (arch === 'x64') return '@ast-grep/cli-win32-x64-msvc';
    return null;
  }
  if (platform === 'linux') return arch === 'arm64' ? '@ast-grep/cli-linux-arm64-gnu' : arch === 'x64' ? '@ast-grep/cli-linux-x64-gnu' : null;
  return null;
}

function versionOf(cmd: string, pre: string[]): string | null {
  const r = run(cmd, [...pre, '--version'], { timeoutMs: 15000 });
  if (r.code !== 0) return null;
  const m = /^ast-grep\s+(\d+\.\d+\.\d+\S*)/m.exec(r.stdout);
  return m ? m[1] : null;
}

let cached: { key: string; bin: AstGrepBinary | null } | undefined;

/** Find ast-grep; null when absent. Cached per process (and per HARNESS_AST_GREP value) unless `fresh`. */
export function findAstGrep(fresh = false): AstGrepBinary | null {
  const key = process.env.HARNESS_AST_GREP ?? '';
  if (cached && cached.key === key && !fresh) return cached.bin;
  cached = { key, bin: resolveAstGrep() };
  return cached.bin;
}

function resolveAstGrep(): AstGrepBinary | null {
  const env = process.env.HARNESS_AST_GREP;
  if (env) {
    if (env === 'none') return null;
    const v = versionOf(env, []);
    return v ? { cmd: env, pre: [], version: v, via: 'env' } : null;
  }
  const exe = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  const pkg = platformPackage();
  if (pkg) {
    try {
      const dir = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [packageRoot()] }));
      const bin = path.join(dir, exe);
      if (fs.existsSync(bin)) {
        const v = versionOf(bin, []);
        if (v) return { cmd: bin, pre: [], version: v, via: 'harness' };
      }
    } catch {
      /* not installed */
    }
  }
  try {
    const dir = path.dirname(require.resolve('@ast-grep/cli/package.json', { paths: [packageRoot()] }));
    const launcher = path.join(dir, 'ast-grep');
    if (fs.existsSync(launcher)) {
      const v = versionOf(process.execPath, [launcher]);
      if (v) return { cmd: process.execPath, pre: [launcher], version: v, via: 'harness-launcher' };
    }
  } catch {
    /* not installed */
  }
  for (const name of ['ast-grep', 'sg']) {
    const p = which(name);
    if (!p) continue;
    const v = versionOf(p, []);
    if (v) return { cmd: p, pre: [], version: v, via: 'path' };
  }
  return null;
}

/** Write rules into a fresh temp project; returns the sgconfig path. */
export function writeRuleProject(rules: Array<Record<string, unknown>>, tests?: Array<{ id: string; valid: string[]; invalid: string[] }>): { dir: string; config: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sg-'));
  const rulesDir = path.join(dir, 'rules');
  fs.mkdirSync(rulesDir);
  rules.forEach((r, i) => {
    fs.writeFileSync(path.join(rulesDir, `r${String(i).padStart(4, '0')}.yml`), stringifyYaml(r));
  });
  const cfg: Record<string, unknown> = { ruleDirs: ['rules'] };
  if (tests) {
    const testDir = path.join(dir, 'tests');
    fs.mkdirSync(testDir);
    tests.forEach((t, i) => {
      fs.writeFileSync(path.join(testDir, `t${String(i).padStart(4, '0')}-test.yml`), stringifyYaml(t));
    });
    cfg.testConfigs = [{ testDir: 'tests' }];
  }
  const config = path.join(dir, 'sgconfig.yml');
  fs.writeFileSync(config, stringifyYaml(cfg));
  return { dir, config };
}

/** Replace temp rule file names (rNNNN.yml) in ast-grep messages with the rule ids. */
export function nameRuleFiles(text: string, rules: Array<Record<string, unknown>>): string {
  return text.replace(/\S*r(\d{4})\.yml/g, (all, n: string) => {
    const r = rules[Number(n)];
    return r && typeof r.id === 'string' ? `'${r.id}'` : all;
  });
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Globs never scanned, whatever the repo's ignore files say. */
export const SCAN_EXCLUDES = ['!**/node_modules/**', '!**/dist/**', '!**/build/**', '!**/coverage/**', '!**/.git/**', '!**/*.min.js'];

export interface ScanResult {
  matches: AstMatch[];
  ok: boolean;
  error?: string;
  durationMs: number;
}

function parseMatchLine(line: string): AstMatch | null {
  if (!line.trim()) return null;
  try {
    const m = JSON.parse(line) as {
      ruleId?: string;
      file: string;
      text: string;
      lines?: string;
      range: { byteOffset: { start: number; end: number }; start: { line: number } };
      metaVariables?: { single?: Record<string, { text: string }> };
    };
    const captures: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.metaVariables?.single ?? {})) captures[k] = v.text;
    return {
      ruleId: m.ruleId ?? '',
      file: m.file,
      line: m.range.start.line,
      startByte: m.range.byteOffset.start,
      endByte: m.range.byteOffset.end,
      text: m.text,
      lines: m.lines ?? '',
      captures,
    };
  } catch {
    return null;
  }
}

/**
 * Scan `paths` with the given rule documents. Files outside the caller's
 * inventory are the caller's to filter out.
 */
export async function scanRules(
  bin: AstGrepBinary,
  rules: Array<Record<string, unknown>>,
  paths: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ScanResult> {
  const start = Date.now();
  if (!rules.length || !paths.length) return { matches: [], ok: true, durationMs: 0 };
  const proj = writeRuleProject(rules);
  try {
    const args = [...bin.pre, 'scan', '-c', proj.config, '--json=stream', '--custom-languages', 'ignore', '--color', 'never'];
    for (const g of SCAN_EXCLUDES) args.push('--globs', g);
    args.push(...paths);
    const r = await runAsync(bin.cmd, args, { cwd: opts.cwd ?? proj.dir, timeoutMs: opts.timeoutMs ?? 600000, maxBuffer: 1024 * 1024 * 1024 });
    const matches: AstMatch[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = parseMatchLine(line);
      if (m) matches.push(m);
    }
    const ok = !r.timedOut && (r.code === 0 || r.code === 1);
    return {
      matches,
      ok,
      error: ok ? undefined : r.timedOut ? 'ast-grep timed out' : nameRuleFiles(r.stderr.trim().split('\n').slice(-6).join(' ') || `exit ${r.code}`, rules),
      durationMs: Date.now() - start,
    };
  } finally {
    removeDir(proj.dir);
  }
}

/** Synchronous scan of a few files (the PostToolUse hook and the gate use it). */
export function scanRulesSync(bin: AstGrepBinary, rules: Array<Record<string, unknown>>, paths: string[], timeoutMs = 15000): ScanResult {
  const start = Date.now();
  if (!rules.length || !paths.length) return { matches: [], ok: true, durationMs: 0 };
  const proj = writeRuleProject(rules);
  try {
    const args = [...bin.pre, 'scan', '-c', proj.config, '--json=stream', '--custom-languages', 'ignore', '--color', 'never', ...paths];
    const r = run(bin.cmd, args, { cwd: proj.dir, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    const matches: AstMatch[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = parseMatchLine(line);
      if (m) matches.push(m);
    }
    const ok = !r.timedOut && (r.code === 0 || r.code === 1);
    return { matches, ok, error: ok ? undefined : r.timedOut ? 'ast-grep timed out' : r.stderr.trim().slice(-300), durationMs: Date.now() - start };
  } finally {
    removeDir(proj.dir);
  }
}

export interface SgTestResult {
  ran: boolean;
  passed: number;
  failed: number;
  failures: string[];
  output: string;
}

/** Run `ast-grep test --skip-snapshot-tests` over rules and their sg-test cases. */
export function runSgTest(
  bin: AstGrepBinary,
  rules: Array<Record<string, unknown>>,
  tests: Array<{ id: string; valid: string[]; invalid: string[] }>,
): SgTestResult {
  const proj = writeRuleProject(rules, tests);
  try {
    const r = run(bin.cmd, [...bin.pre, 'test', '-c', proj.config, '--skip-snapshot-tests', '--color', 'never', '--custom-languages', 'ignore'], {
      cwd: proj.dir,
      timeoutMs: 120000,
    });
    const out = nameRuleFiles(r.stdout + r.stderr, rules);
    const m = /test (?:result: \w+|failed)\. (\d+) passed; (\d+) failed;/.exec(out);
    const failures = out
      .split('\n')
      .filter((l) => /^(FAIL|\[Incorrect\]|\[Noisy\]|\[Missing\]|Error)/i.test(l.trim()) || /\bFAIL\b/.test(l))
      .map((l) => l.trim());
    return { ran: !!m, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : 0, failures, output: out };
  } finally {
    removeDir(proj.dir);
  }
}
