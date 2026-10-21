/** Shared helpers for assess tests: copy a fixture into a temp sandbox with a fake HOME. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../../src/lib/exec';
import { packageRoot } from '../../../src/lib/paths';
import { runAssess, type AssessResult } from '../../../src/assess/index';
import type { AgentId, AssessReport, Setting } from '../../../src/types';

export const FIXTURES = path.join(packageRoot(), 'test', 'fixtures', 'assess');

export interface Sandbox {
  root: string;
  home: string;
  ws: string;
  harnessHome: string;
  cleanup(): void;
}

export function gitAvailable(): boolean {
  return run('git', ['--version'], { timeoutMs: 5000 }).code === 0;
}

export function git(dir: string, args: string[]): number | null {
  return run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd: dir,
    timeoutMs: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).code;
}

/**
 * Copy `fixture` (a folder under test/fixtures/assess) to <tmp>/home/work/<name>
 * and `home` (optional) to <tmp>/home, so the ancestor scan stops at the fake
 * HOME. `gitInit` lists folders (relative to the workspace) to `git init` and
 * stage, so git-dependent checks (R17, tracked hooks) can run.
 */
export function sandbox(opts: { fixture?: string; home?: string; gitInit?: string[]; name?: string } = {}): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-assess-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (opts.home) fs.cpSync(path.join(FIXTURES, opts.home), home, { recursive: true });
  const ws = path.join(home, 'work', opts.name ?? opts.fixture ?? 'ws');
  fs.mkdirSync(ws, { recursive: true });
  if (opts.fixture) fs.cpSync(path.join(FIXTURES, opts.fixture), ws, { recursive: true });
  for (const d of opts.gitInit ?? []) {
    const dir = path.join(ws, d);
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
  }
  const harnessHome = path.join(root, 'harness-home');
  process.env.HARNESS_HOME = harnessHome;
  process.env.HARNESS_USER_HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.HARNESS_NO_INSTRUMENT = '1';
  return { root, home, ws, harnessHome, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function assess(sb: Sandbox, opts: { setting?: Setting; agents?: AgentId[]; includes?: string[] } = {}): AssessResult {
  return runAssess({ workspace: sb.ws, setting: opts.setting ?? 'team', agents: opts.agents ?? ['devin', 'claude', 'codex'], includes: opts.includes ?? [], userHome: sb.home });
}

/** Display path of a report file path. */
export function disp(r: AssessReport, abs: string): string {
  return r.files.find((f) => f.path === abs)?.display ?? abs;
}

export function findingsOf(r: AssessReport, check: string, display?: string) {
  return r.findings.filter((f) => f.check === check && (display === undefined || disp(r, f.file) === display || f.file.endsWith('/' + display)));
}

export function classOf(r: AssessReport, display: string, line: number) {
  const f = r.files.find((x) => x.display === display);
  return r.classifications.find((c) => c.file === f?.path && c.line === line);
}

export function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
