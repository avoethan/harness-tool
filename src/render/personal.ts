/**
 * The in-repo set of the personal setting (DESIGN 3, 2.5, 2.8), beyond the
 * always-on AGENTS.md, skills, scoped rules and settings files rendered by
 * the other modules:
 *
 *   CLAUDE.md                     `@AGENTS.md` import (a new file, or a marker block at the
 *                                 top of the user's own CLAUDE.md: a diff proposal)
 *   .harness/config.json          the repo's overlay: setting and agents (no machine paths)
 *   tasks/README.md               how the task ledger works (only when absent)
 *   <git hooks>/pre-commit, pre-push (+ .cmd shims)
 *                                 run `harness gate --hook ...` and fail closed; local to
 *                                 this clone (inside .git), never committed
 *   .github/workflows/harness-gate.yml
 *                                 CI runs the gate's verification steps, and the harness
 *                                 gate itself when the repository variable names the tool
 *   .gitignore                    entries for local run artefacts
 *   .prettierignore               (repos that use Prettier) the files the harness writes, so the
 *                                 repository's own format check never fails on them
 *   ~/.codex/config.toml          trust the project so Codex loads its .codex/ (Codex only)
 *
 * Never emits `.windsurfrules`, `.cursorrules` or other tool-specific rule files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTextOr } from '../lib/fsx';
import { rawGit } from '../lib/git';
import { sha256 } from '../lib/hash';
import { subPath } from '../lib/paths';
import { HASH_BEGIN, HASH_END, allRepoFacts, posix, type RenderContext, type RenderedFile, type RepoFacts } from './model';


export const GIT_HOOKS = ['pre-commit', 'pre-push'] as const;

const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.toml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.ts', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts', '.prettierignore'];

/** The repository formats with Prettier: a Prettier config or ignore file, a `prettier` key, or the dependency. */
export function usesPrettier(root: string): boolean {
  if (PRETTIER_CONFIGS.some((n) => fs.existsSync(path.join(root, n)))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { prettier?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return pkg.prettier !== undefined || 'prettier' in (pkg.devDependencies ?? {}) || 'prettier' in (pkg.dependencies ?? {});
  } catch {
    return false;
  }
}

/**
 * `.prettierignore` block for the files the harness writes in the repository. Prettier rewrites
 * them by the repository's own settings (quote style in front matter, table padding, blank lines
 * after headings, short JSON arrays on one line), which no rendering matches for every repository,
 * so without it the repository's own `prettier --check .` (often a CI step) fails right after the
 * install and on every landing. Root-anchored paths of every rendered file inside the repository
 * (never `.git`), plus `/.harness/` (manifest, overlay), `/tasks/` (the ledger the harness writes)
 * and `/CLAUDE.md` when Claude is targeted (rendered only until it imports AGENTS.md), so the list
 * is the same on every run. Null when the repository does not use Prettier.
 */
export function prettierIgnoreFile(ctx: RenderContext, rendered: RenderedFile[]): RenderedFile | null {
  const root = ctx.repoRoot ?? ctx.workspaceRoot;
  if (!usesPrettier(root)) return null;
  const own = path.join(root, '.prettierignore');
  const entries = new Set<string>(['/.harness/', '/tasks/']);
  if (ctx.agents.includes('claude')) entries.add('/CLAUDE.md');
  for (const f of rendered) {
    const abs = path.resolve(f.path);
    if (!subPath(root, abs) || subPath(path.join(root, '.git'), abs) || abs === own || f.role === 'gitignore' || f.role === 'git-hook') continue;
    const rel = posix(path.relative(root, abs));
    if (!rel || rel.startsWith('.harness/') || rel.startsWith('tasks/')) continue;
    entries.add(`/${rel}`);
  }
  const body = ['# Files the harness writes; the formatter leaves them alone (they are regenerated, not hand-edited).', ...[...entries].sort()].join('\n');
  return { path: own, kind: 'block', block: { style: 'hash', position: 'end' }, content: body, role: 'prettierignore', hunks: [{ checkId: 'render.prettierignore', reason: "the repository's Prettier leaves the harness's files alone, so its format check does not fail on them after the install", provenance: `harness ${ctx.harnessVersion}`, contentHash: sha256(body) }] };
}

/** Where git looks for this clone's hooks (respects core.hooksPath); null when not a git repository. */
export function gitHooksDir(repoRoot: string): string | null {
  const r = rawGit(repoRoot, ['rev-parse', '--git-path', 'hooks'], 5000);
  if (r.code !== 0) return null;
  return path.resolve(repoRoot, r.stdout.trim());
}

function hookBlock(cli: string, hook: string): string {
  return [
    HASH_BEGIN,
    `# The done-gate (personal setting). Fails closed: when the gate cannot run, the ${hook === 'pre-commit' ? 'commit' : 'push'} is refused.`,
    `HARNESS_CLI="${cli}"`,
    'if [ ! -f "$HARNESS_CLI" ]; then',
    `  echo "harness: $HARNESS_CLI is missing, so the gate cannot run and this ${hook === 'pre-commit' ? 'commit' : 'push'} is refused. Re-run harness install, or remove this hook by hand if you uninstalled the harness." >&2`,
    '  exit 1',
    'fi',
    `node "$HARNESS_CLI" gate --hook ${hook} || exit 1`,
    HASH_END,
  ].join('\n');
}

/** The POSIX hook: ours alone, or ours right after the shebang of the user's own hook. */
export function gitHookText(existing: string | null, cli: string, hook: string): string {
  const block = hookBlock(cli, hook);
  if (existing === null || !existing.trim()) return `#!/bin/sh\n${block}\n`;
  const text = existing.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const b = lines.findIndex((l) => /^# harness:begin\b/.test(l.trim()));
  const e = b >= 0 ? lines.findIndex((l, i) => i > b && l.trim() === HASH_END) : -1;
  if (b >= 0 && e >= 0) return [...lines.slice(0, b), block, ...lines.slice(e + 1)].join('\n');
  if (lines[0].startsWith('#!')) return [lines[0], block, ...lines.slice(1)].join('\n');
  return ['#!/bin/sh', block, ...lines].join('\n');
}

export function gitHookCmd(cli: string, hook: string): string {
  return ['@echo off', 'rem Generated by harness (personal setting): the done-gate; fails closed.', `if not exist "${cli}" (echo harness: ${cli} is missing, so the gate cannot run. 1>&2 & exit /b 1)`, `node "${cli}" gate --hook ${hook} %*`, 'if errorlevel 1 exit /b 1', ''].join('\r\n');
}

/** The personal CI workflow (exported for tests). */
export function ciWorkflow(f: RepoFacts | undefined): string {
  const pm = f?.pm ?? 'npm';
  const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : pm === 'bun' ? 'bun install --frozen-lockfile' : 'npm ci';
  const steps: Array<[string, string]> = [];
  const c = f?.commands ?? {};
  if (c.build) steps.push(['build', c.build]);
  if (c.typecheck) steps.push(['typecheck', c.typecheck]);
  if (c.lint) steps.push(['lint', c.lint]);
  if (c.format) steps.push(['format', c.format]);
  if (c.test) steps.push(['test', c.test]);
  const lines = [
    '# Generated by harness (personal setting): the same gate as the git hooks.',
    '# The verification steps below are the ones the gate runs. The harness gate itself',
    '# (tamper check, standards, evidence) runs when the repository variable HARNESS_TOOL_REPO',
    '# names the harness tool repository (owner/name; the tool at its root or in a harness/ folder);',
    '# HARNESS_TOOL_REF pins a tag or commit.',
    'name: harness-gate',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
  ];
  if (pm !== 'npm') lines.push(`      - run: npm install -g ${pm === 'bun' ? 'bun' : pm}`);
  lines.push(`      - run: ${install}`);
  for (const [name, cmd] of steps) lines.push(`      - name: ${name}`, `        run: ${cmd}`);
  if (!steps.length) lines.push('      - run: echo "no build, lint or test scripts found; the harness gate below is the only check"');
  lines.push(
    '      - name: harness tool',
    "        if: ${{ vars.HARNESS_TOOL_REPO != '' }}",
    '        uses: actions/checkout@v4',
    '        with:',
    '          repository: ${{ vars.HARNESS_TOOL_REPO }}',
    "          ref: ${{ vars.HARNESS_TOOL_REF || '' }}",
    '          path: .harness-tool',
    '      - name: harness gate',
    "        if: ${{ vars.HARNESS_TOOL_REPO != '' }}",
    '        run: |',
    '          tool=.harness-tool',
    '          if [ ! -f "$tool/package.json" ] && [ -f "$tool/harness/package.json" ]; then tool="$tool/harness"; fi',
    '          (cd "$tool" && npm ci --ignore-scripts && npm run build)',
    '          node "$tool/dist/src/cli.js" gate --hook ci',
    '      - name: harness gate not configured',
    "        if: ${{ vars.HARNESS_TOOL_REPO == '' }}",
    '        run: echo "::notice::the harness gate did not run in CI (set the repository variable HARNESS_TOOL_REPO); the verification steps above did"',
  );
  return lines.join('\n') + '\n';
}

function tasksReadme(): string {
  return [
    '# Tasks',
    '',
    'The task ledger of this repository (managed with `harness task`). One Markdown file per',
    'task, front matter first:',
    '',
    '```',
    '---',
    'id: T-001',
    'title: Short title',
    'priority: 1            # lower is more urgent',
    'status: todo           # todo | claimed | done | failed | reverted | blocked',
    'depends_on: []',
    'paths: ["src/orders"]  # the files the task may touch',
    'acceptance: ["GET /orders/:id returns total"]',
    '---',
    '',
    'Free text for the agent.',
    '```',
    '',
    'Commands: `harness task add`, `harness task next`, `harness task claim <id>`,',
    '`harness task done <id> --commit <sha>`, `harness task fail <id> --reason "..."`,',
    '`harness task list`, `harness task validate`. An agent picks work with the `task` skill;',
    '`harness run` drives the queue with fresh headless sessions.',
    '',
  ].join('\n');
}

const GITIGNORE_BLOCK = ['# Local harness run artefacts (evidence and caches live under ~/.harness; these are local overrides).', '.harness/*.local.json', '.harness/cache/', '.harness/runs/', '.harness-tool/'].join('\n');

export interface PersonalRender {
  files: RenderedFile[];
  notes: string[];
}

export function renderPersonal(ctx: RenderContext): PersonalRender {
  const files: RenderedFile[] = [];
  const notes: string[] = [];
  const root = ctx.repoRoot ?? ctx.workspaceRoot;
  const facts = allRepoFacts(ctx);
  const f = facts.find((x) => path.resolve(x.path) === path.resolve(root)) ?? facts[0];
  const v = ctx.harnessVersion;
  const h = (checkId: string, reason: string, content: string, provenance = `harness ${v}`) => [{ checkId, reason, provenance, contentHash: sha256(content) }];

  // CLAUDE.md: Claude Code reads AGENTS.md only without a CLAUDE.md, so import it (R-57).
  if (ctx.agents.includes('claude')) {
    const p = path.join(root, 'CLAUDE.md');
    const cur = readTextOr(p, null);
    const imports = cur !== null && /^@AGENTS\.md\s*$/m.test(cur.replace(/<!--[\s\S]*?-->/g, ''));
    if (!imports) {
      const body = '@AGENTS.md\nThe agent instructions of this repository are in AGENTS.md (imported above); keep project notes there.';
      files.push({ path: p, kind: 'block', block: { style: 'md', position: 'start' }, content: body, role: 'claude-pointer', agent: 'claude', hunks: h('render.claude-import', 'Claude Code reads AGENTS.md only through an import when a CLAUDE.md exists', body) });
    }
  }

  // .harness/config.json: the repo's overlay; no machine paths (the file is committed).
  const cfg = { version: 1, setting: 'personal', agents: [...ctx.agents] };
  const cfgText = JSON.stringify(cfg);
  files.push({ path: path.join(root, '.harness', 'config.json'), kind: 'json', content: cfgText, role: 'repo-config', hunks: h('render.repo-config', 'personal setting overlay read by resolveConfig (setting and agents)', cfgText) });

  // tasks/README.md, only when the repo has none.
  const tasksReadmePath = path.join(root, 'tasks', 'README.md');
  if (!fs.existsSync(tasksReadmePath)) {
    const t = tasksReadme();
    files.push({ path: tasksReadmePath, kind: 'text', content: t, role: 'tasks', hunks: h('render.tasks', 'the task ledger folder the personal intake reads', t) });
  }

  // git hooks: local to this clone, absolute path to this machine's harness.
  const hooksDir = gitHooksDir(root);
  const cli = posix(path.join(ctx.packageRoot, 'dist', 'src', 'cli.js'));
  if (!hooksDir) notes.push('not a git repository: the pre-commit and pre-push gate hooks were not written');
  else if (subPath(root, hooksDir) && !subPath(path.join(root, '.git'), hooksDir)) {
    notes.push(`git hooks live in ${posix(path.relative(root, hooksDir))} (core.hooksPath inside the work tree, committed with the repo): the harness does not write machine paths there. Add \`node "${cli}" gate --hook pre-commit\` (and pre-push) to those hooks by hand.`);
  } else {
    for (const hook of GIT_HOOKS) {
      const p = path.join(hooksDir, hook);
      const cur = readTextOr(p, null);
      const text = gitHookText(cur, cli, hook);
      if (cur !== text) files.push({ path: p, kind: 'text', content: text, role: 'git-hook', mode: 0o755, hunks: h('render.git-hook', `${hook}: runs the done-gate and fails closed (the gate holds even when agent hooks are bypassed)`, text) });
      const cmdPath = path.join(hooksDir, `${hook}.cmd`);
      const cmd = gitHookCmd(cli, hook);
      if (readTextOr(cmdPath, null) !== cmd) files.push({ path: cmdPath, kind: 'text', content: cmd, role: 'git-hook', hunks: h('render.git-hook', `${hook}.cmd: the same gate for Windows tools that run .cmd hooks`, cmd) });
    }
  }

  // CI
  const ci = ciWorkflow(f);
  files.push({ path: path.join(root, '.github', 'workflows', 'harness-gate.yml'), kind: 'text', content: ci, role: 'ci', hunks: h('render.ci', 'CI runs the same gate steps as the git hooks', ci) });

  // .gitignore
  files.push({ path: path.join(root, '.gitignore'), kind: 'block', block: { style: 'hash', position: 'end' }, content: GITIGNORE_BLOCK, role: 'gitignore', hunks: h('render.gitignore', 'keeps local run artefacts out of commits', GITIGNORE_BLOCK) });

  // Codex: ~/.codex/config.toml (the project trusted, the harness folder writable in the sandbox) is
  // rendered for both settings by codexConfigFile (src/render/permissions.ts).
  if (ctx.agents.includes('codex')) {
    notes.push('Codex: for end-to-end checks against a local service, the sandbox needs network access; set `[sandbox_workspace_write] network_access = true` in ~/.codex/config.toml yourself if you want that. `shell_environment_policy` is left as it is (secrets stay out of spawned commands).');
  }
  return { files, notes };
}
