/** Shared helpers for lifecycle tests: temp homes, temp git repos, plans. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../../src/lib/exec';
import { sha256 } from '../../../src/lib/hash';
import type { Plan, PlanTarget, Setting } from '../../../src/types';

export interface TempHome {
  root: string;
  userHome: string;
  harnessHome: string;
  workspace: string;
  cleanup(): void;
}

/** A fresh temp tree with HARNESS_HOME / HARNESS_USER_HOME pointed at it. */
export function tempHome(prefix = 'harness-test-'): TempHome {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const userHome = path.join(root, 'home');
  const harnessHome = path.join(userHome, '.harness');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(harnessHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  process.env.HARNESS_HOME = harnessHome;
  process.env.HARNESS_USER_HOME = userHome;
  process.env.HARNESS_NO_INSTRUMENT = '1';
  return {
    root,
    userHome,
    harnessHome,
    workspace,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function git(dir: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    timeoutMs: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** `git init` a repo with one committed file; returns its root. */
export function gitRepo(dir: string, files: Record<string, string> = { 'README.md': '# repo\n' }): string {
  fs.mkdirSync(dir, { recursive: true });
  const init = git(dir, ['init', '-q', '-b', 'main']);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
  git(dir, ['config', 'user.name', 'harness-test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(dir, ['add', '-A']);
  const c = git(dir, ['commit', '-q', '-m', 'init']);
  if (c.code !== 0) throw new Error(`git commit failed: ${c.stderr}`);
  return dir;
}

export function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function read(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function shaOf(p: string): string | null {
  const t = read(p);
  return t === null ? null : sha256(t);
}

/** A target whose beforeSha is taken from the file as it is now. */
export function target(p: string, action: PlanTarget['action'], after?: string, extra: Partial<PlanTarget> = {}): PlanTarget {
  return {
    path: p,
    owner: 'generated',
    action,
    beforeSha: shaOf(p),
    after,
    hunks: [{ checkId: 'T1', reason: 'test', provenance: 'test' }],
    ...extra,
  };
}

export function plan(id: string, setting: Setting, targets: PlanTarget[], extra: Partial<Plan> = {}): Plan {
  return { id, createdAt: new Date().toISOString(), setting, agents: ['claude'], targets, notes: [], rejections: [], ...extra };
}

/** Realistic agent settings, as users write them (comments, trailing commas). */
export const CLAUDE_SETTINGS = `// my settings
{
  "permissions": {
    "allow": ["Read", "Bash(npm test)", "Bash(npm run lint)"],
    "deny": ["Bash(git push --force *)", "Read(./.env)", "Bash(rm -rf *)"],
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /opt/mine/pre.js", "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /opt/mine/stop.js" }] }
    ],
  },
  "env": { "NODE_OPTIONS": "--max-old-space-size=4096" },
  "model": "sonnet",
}
`;

export const DEVIN_CONFIG = `{
  "permissions": {
    "deny": ["exec(git push *)", "write(**/.env)"],
    "ask": ["exec(docker *)"]
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "exec", "hooks": [{ "type": "command", "command": "node /opt/mine/devin-pre.js", "timeout": 10 }] }]
  },
  "mcpServers": { "jira": { "command": "jira-mcp", "args": ["--read-only"] } },
  "mode": "default"
}
`;

export const CODEX_HOOKS = `{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /opt/mine/codex-pre.js", "timeout": 20 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /opt/mine/session.js" }] }
    ]
  }
}
`;
