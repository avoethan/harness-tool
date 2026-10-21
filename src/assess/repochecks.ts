/**
 * Checks per repository and per instruction-file arrangement:
 *
 *   R01 no instructions at a repo root (info)
 *   R02 a test command exists but no instruction file names one
 *   R03 verification commands that no agent file names (and no documented aggregator)
 *   R07 AGENTS.md that Claude Code will not read (shadowed), or that Codex skips for AGENTS.override.md
 *   R08 AGENTS.md without a CLAUDE.md pointer (info)
 *   R23 an instruction file that is a symlink to another (info)
 */
import * as path from 'node:path';
import { displayPath, instructionDir } from './inventory';
import type { AssessContext, InvFile, RepoInfo } from './model';

const ROOT_INSTRUCTIONS = ['AGENTS.md', 'AGENTS.override.md', 'AGENTS.local.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md', '.windsurfrules'];
const TEST_MENTION = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bmake\s+test\b|\bjust\s+test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\b(jest|vitest|mocha|playwright\s+test)\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradlew?\s+test\b|\bnode\s+--test\b|\bdeno\s+test\b/i;
const VERIFY = /^(lint|test|typecheck|type-check|tsc|format:check|check-format|fmt:check|e2e|test:e2e|test:unit|lint:types)$/;
const AGGREGATORS = ['check', 'ci', 'verify', 'validate', 'precommit', 'pre-commit', 'lgtm', 'test:all', 'check:all'];

/** Text of every agent file an agent would read for work in this repo (repo, workspace, ancestor and user level). */
function agentTextFor(ctx: AssessContext, repo: RepoInfo): string {
  return ctx.files
    .filter((f) => ['instructions', 'rule', 'skill', 'command'].includes(f.kind) && (f.repoRoot === repo.root || f.level === 'workspace' || f.level === 'user' || f.level === 'ancestor'))
    .map((f) => f.text)
    .join('\n');
}

function named(text: string, script: string): boolean {
  const esc = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(run(-script)?\\s+${esc}\\b|(npm|pnpm|yarn|bun)\\s+${esc}\\b|\`${esc}\`)`).test(text);
}

export function repoChecks(ctx: AssessContext): void {
  for (const repo of ctx.repos) {
    const rootFiles = ctx.files.filter((f) => f.kind === 'instructions' && ROOT_INSTRUCTIONS.includes(path.basename(f.abs)) && path.resolve(instructionDir(f.abs)) === path.resolve(repo.root));
    const where = displayPath(ctx, repo.root);
    if (!rootFiles.length) {
      ctx.findings.push({ check: 'R01', severity: 'info', file: repo.root, message: `${where} has no agent instruction file at its root${ctx.setting === 'team' ? '; in the team setting the harness adds nothing inside it and uses user-level files instead' : ''}.` });
    }
    const text = agentTextFor(ctx, repo);
    const rootScripts = repo.scripts.get(repo.root) ?? new Set<string>();
    const hasTest = rootScripts.has('test') || !!repo.makeTargets?.has('test') || !!repo.justRecipes?.has('test') || repo.workflows.some((w) => /\btest\b/i.test(w.text));
    const anyInstructions = ctx.files.some((f) => f.kind === 'instructions' && (f.repoRoot === repo.root || f.level !== 'repo'));
    if (hasTest && anyInstructions && !TEST_MENTION.test(text)) {
      ctx.findings.push({ check: 'R02', severity: 'warn', file: repo.root, message: `${where} has a test command, but no instruction file the agents read for it says how to run the tests.` });
    }
    const verify = [...rootScripts].filter((s) => VERIFY.test(s));
    if (verify.length >= 2) {
      const missing = verify.filter((s) => !named(text, s));
      const agg = AGGREGATORS.filter((a) => rootScripts.has(a));
      const aggDocumented = agg.some((a) => named(text, a));
      if (missing.length && !aggDocumented) {
        if (agg.length) ctx.findings.push({ check: 'R03', severity: 'warn', file: repo.root, message: `${where} has an aggregate check script ("${agg[0]}") that no agent file mentions; document it as the one command to run before finishing.` });
        else ctx.findings.push({ check: 'R03', severity: 'warn', file: repo.root, message: `${where} has ${verify.length} verification scripts (${verify.join(', ')}); ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} named in no agent file and there is no single check command.` });
      }
    }
  }
  // R07 / R08 / R23 over instruction files
  for (const f of ctx.files) {
    if (f.kind !== 'instructions' || f.level === 'user' || f.level === 'include') continue;
    const base = path.basename(f.abs);
    const dir = path.dirname(f.abs);
    if (base === 'AGENTS.md' && ctx.agents.includes('claude')) {
      const siblings = ctx.files.filter((x) => x.kind === 'instructions' && ['CLAUDE.md', 'CLAUDE.local.md'].includes(path.basename(x.abs)) && path.resolve(instructionDir(x.abs)) === path.resolve(dir));
      const imported = ctx.imports.some((i) => siblings.includes(i.from) && path.resolve(i.abs) === path.resolve(f.abs));
      const linked = siblings.some((s) => s.symlinkTo && path.resolve(s.symlinkTo) === path.resolve(f.symlinkTo ?? f.abs));
      if (siblings.length && !imported && !linked) {
        ctx.findings.push({ check: 'R07', severity: 'warn', file: f.abs, agent: 'claude', message: `Claude Code will not read ${f.display}: ${siblings.map((s) => s.display).join(' and ')} ${siblings.length > 1 ? 'sit' : 'sits'} next to it without an @AGENTS.md import.` });
      } else if (!siblings.length && f.loads.claude.when === 'never' && /shadow/.test(f.loads.claude.note)) {
        ctx.findings.push({ check: 'R07', severity: 'warn', file: f.abs, agent: 'claude', message: `Claude Code will not read ${f.display}: ${f.loads.claude.note}.` });
      } else if (!siblings.length && (dir === ctx.workspace || ctx.repos.some((r) => r.root === dir))) {
        ctx.findings.push({ check: 'R08', severity: 'info', file: f.abs, agent: 'claude', message: `${f.display} has no CLAUDE.md next to it; Claude Code reads AGENTS.md only while no CLAUDE.md exists in the folder or above, so a one-line CLAUDE.md with @AGENTS.md is the stable form.` });
      }
    }
    if (base === 'AGENTS.override.md' && ctx.agents.includes('codex')) {
      const sib = ctx.files.find((x) => path.resolve(x.abs) === path.resolve(path.join(dir, 'AGENTS.md')));
      if (sib) ctx.findings.push({ check: 'R07', severity: 'warn', file: sib.abs, agent: 'codex', message: `Codex reads ${f.display} instead of ${sib.display}; the AGENTS.md next to it is skipped.` });
    }
  }
  for (const f of ctx.files) {
    if (!f.symlinkTo || !['instructions', 'rule', 'legacy'].includes(f.kind)) continue;
    ctx.findings.push({ check: 'R23', severity: 'info', file: f.abs, message: `${f.display} is a symlink to ${displayPath(ctx, f.symlinkTo)} (no action needed; some tools load such a file twice).` });
  }
}

export function isInstruction(f: InvFile): boolean {
  return f.kind === 'instructions';
}
