/**
 * `harness assess` pipeline (DESIGN 2.2), deterministic and offline:
 *
 *   1. repos and sessions      find the repos of the workspace and the folders
 *                              an agent may start a session in
 *   2. inventory               every agent file at user, ancestor, workspace,
 *                              repo and --include level; load timing per agent
 *   3. raw scans               hidden Unicode and injection patterns on the raw
 *                              text before any parsing (R10-R13); quarantine
 *   4. checks                  R01-R31
 *   5. safety inventory        deny/ask rules, git hooks, CI jobs, safety sentences
 *   6. loaded per agent        bytes and lines at session start against limits
 *   7. classification          every line of every instruction file and skill
 *   8. report                  AssessReport + Markdown summary
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nearestRepoRoot } from '../lib/git';
import { userHome as defaultUserHome } from '../lib/paths';
import { findRepos, hasGit, readRepo } from './project';
import { collectFiles, computeLoads, displayPath, resolveLoadSettings } from './inventory';
import { computeLoaded, CODEX_BUDGET, findImports } from './load';
import { proseChecks, rawScans } from './checks';
import { skillChecks } from './skills';
import { broadPermissions, ciAgents, committedLocal, hookChecks, mcpChecks, unparseable } from './configchecks';
import { repoChecks } from './repochecks';
import { collectSafety } from './safety';
import { classifyAll } from './classify';
import { buildReport, renderMarkdown } from './report';
import type { AgentId, AssessReport, Setting } from '../types';
import type { AssessContext, Session } from './model';

export interface AssessOptions {
  workspace: string;
  setting: Setting;
  agents: AgentId[];
  includes?: string[];
  /** Defaults to HARNESS_USER_HOME or the OS home. */
  userHome?: string;
}

export interface AssessResult {
  report: AssessReport;
  markdown: string;
  ctx: AssessContext;
}

function real(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export function runAssess(opts: AssessOptions): AssessResult {
  const workspace = real(opts.workspace);
  const ctx: AssessContext = {
    workspace,
    setting: opts.setting,
    agents: opts.agents,
    userHome: real(opts.userHome ?? defaultUserHome()),
    includes: (opts.includes ?? []).map(real),
    workspaceIsRepo: hasGit(workspace),
    repos: [],
    sessions: [],
    files: [],
    findings: [],
    safety: [],
    notes: [],
    devinImports: { claude: true, cursor: true },
    codexTrusted: new Set(),
    codexBudget: CODEX_BUDGET,
    codexFallbackNames: [],
    imports: [],
    marks: [],
  };
  // 1. repos and sessions
  ctx.repos = findRepos(workspace).map((r) => readRepo(r, (p) => displayPath(ctx, p)));
  for (const r of ctx.repos) ctx.notes.push(...r.unparsed.map((u) => `${u} (not parsed)`));
  const rootSession: Session = { cwd: workspace, gitRoot: nearestRepoRoot(workspace), isWorkspaceRoot: true };
  // A sub-repo without its own .git is treated as its own project (never as part of a repo above the workspace).
  ctx.sessions = [rootSession, ...ctx.repos.filter((r) => r.root !== workspace).map((r) => ({ cwd: r.root, gitRoot: hasGit(r.root) ? r.root : null, isWorkspaceRoot: false }))];
  for (const inc of ctx.includes) if (!fs.existsSync(inc)) ctx.notes.push(`--include ${inc} does not exist`);
  // 2. inventory and load timing
  collectFiles(ctx);
  // A folder below a repo root with its own AGENTS.md / CLAUDE.md is a place a session may start
  // (Codex reads nested AGENTS.md only from there); add those as sessions, a bounded number.
  const sessionDirs = new Set(ctx.sessions.map((s) => s.cwd));
  for (const f of ctx.files) {
    if (ctx.sessions.length >= 40) break;
    if (f.kind !== 'instructions' || !f.repoRoot || !/^(AGENTS(\.override)?|CLAUDE)\.md$/.test(path.basename(f.abs))) continue;
    const dir = path.basename(path.dirname(f.abs)) === '.claude' ? path.dirname(path.dirname(f.abs)) : path.dirname(f.abs);
    if (sessionDirs.has(dir)) continue;
    sessionDirs.add(dir);
    const repoSession = ctx.sessions.find((s) => s.cwd === f.repoRoot);
    ctx.sessions.push({ cwd: dir, gitRoot: repoSession ? repoSession.gitRoot : rootSession.gitRoot, isWorkspaceRoot: false });
  }
  resolveLoadSettings(ctx);
  computeLoads(ctx);
  findImports(ctx);
  // 3. raw scans before parsing
  rawScans(ctx);
  // 4. checks
  unparseable(ctx);
  proseChecks(ctx);
  skillChecks(ctx);
  broadPermissions(ctx);
  hookChecks(ctx);
  mcpChecks(ctx);
  committedLocal(ctx);
  ciAgents(ctx);
  repoChecks(ctx);
  // 5. safety inventory
  collectSafety(ctx);
  // 6. loaded per agent (R09)
  const loaded = computeLoaded(ctx);
  ctx.findings.push(...loaded.findings);
  if (ctx.devinImports.claude && ctx.agents.includes('devin') && ctx.agents.includes('claude')) {
    ctx.notes.push('Devin reads Claude Code material by default (read_config_from.claude): hooks in .claude/settings.json run in both agents and CLAUDE.md files are rules for Devin too.');
  }
  // 7. classification, 8. report
  const classifications = classifyAll(ctx);
  const report = buildReport(ctx, { classifications, loaded: loaded.loaded, loadDetail: loaded.detail });
  const markdown = renderMarkdown(report, ctx);
  return { report, markdown, ctx };
}
