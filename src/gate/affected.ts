/**
 * Step 9: affected scope. In a monorepo the change can break a package it
 * does not touch, so the gate runs the test and lint scripts of every
 * affected package: the packages holding changed files and, transitively,
 * the workspace packages that depend on them.
 *
 *   nx      (nx.json + the repo's nx)      `nx affected -t test lint --files=<changed>`
 *   turbo   (turbo.json + the repo's turbo) `turbo run test lint --filter=...[<base>]`
 *   npm / yarn / pnpm workspaces            each affected package's own `test` and `lint`
 *                                           scripts, from its package.json at the base commit
 * Skipped with the reason when the repository is a single package.
 */
import type { GateContext } from './context';
import { matchGlob } from '../discover/glob';
import { run } from '../lib/exec';
import { declaresBin, failureLines, readPackageJson, resolveBin, runScript, scriptCommand } from './scripts';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';

export interface WorkspacePackage {
  rel: string;
  name: string;
  deps: string[];
  scripts: Record<string, string>;
}

/** Workspace globs from package.json `workspaces` or pnpm-workspace.yaml at the base commit. */
export function workspaceGlobs(ctx: Pick<GateContext, 'basePkg' | 'baseText'>): string[] {
  const w = ctx.basePkg?.workspaces;
  const globs = Array.isArray(w) ? w : Array.isArray(w?.packages) ? w!.packages! : [];
  const pnpm = ctx.baseText('pnpm-workspace.yaml');
  if (pnpm) {
    const block = /^packages:\s*\n((?:\s+-\s*.+\n?)+)/m.exec(pnpm);
    if (block) for (const m of block[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) if (!m[1].startsWith('!')) globs.push(m[1]);
  }
  return globs.map((g) => g.replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
}

/** The workspace packages at the base commit. */
export function workspacePackages(ctx: Pick<GateContext, 'basePkg' | 'baseText' | 'baseEntries'>): WorkspacePackage[] {
  const globs = workspaceGlobs(ctx);
  if (!globs.length) return [];
  const out: WorkspacePackage[] = [];
  for (const p of ctx.baseEntries.keys()) {
    if (!p.endsWith('/package.json') || p.includes('node_modules/')) continue;
    const dir = p.slice(0, -'/package.json'.length);
    if (!globs.some((g) => dir === g || matchGlob(dir, g))) continue;
    const pkg = readPackageJson(ctx.baseText(p));
    if (!pkg) continue;
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
    out.push({ rel: dir, name: pkg.name ?? dir, deps, scripts: pkg.scripts ?? {} });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Packages holding changed paths, plus their transitive dependents inside the workspace. */
export function affectedPackages(pkgs: WorkspacePackage[], changed: string[]): { direct: WorkspacePackage[]; all: WorkspacePackage[] } {
  const owner = (p: string) => pkgs.filter((k) => p === k.rel || p.startsWith(k.rel + '/')).sort((a, b) => b.rel.length - a.rel.length)[0];
  const direct = new Map<string, WorkspacePackage>();
  for (const p of changed) {
    const o = owner(p);
    if (o) direct.set(o.name, o);
  }
  const all = new Map(direct);
  let grew = true;
  while (grew) {
    grew = false;
    for (const k of pkgs) {
      if (all.has(k.name)) continue;
      if (k.deps.some((d) => all.has(d))) {
        all.set(k.name, k);
        grew = true;
      }
    }
  }
  return { direct: [...direct.values()], all: [...all.values()] };
}

function runTool(ctx: GateContext, bin: string[], args: string[], label: string): StepOutcome {
  const r = run(bin[0], [...bin.slice(1), ...args], { cwd: ctx.root, timeoutMs: ctx.timeout('affected'), env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0', NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.code === 0) return pass(`${label}: passed (${r.durationMs} ms)`);
  return fail([`${label} exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r, 12)]);
}

export function runAffected(ctx: GateContext): StepOutcome {
  const changed = ctx.diff.flatMap((d) => (d.oldPath ? [d.oldPath, d.path] : [d.path]));
  if (ctx.baseEntries.has('nx.json')) {
    const nx = resolveBin(ctx.root, ctx.root, 'nx');
    if (!nx) return declaresBin(ctx.basePkg, 'nx') ? fail(["nx is declared in package.json but not installed; run the repository's install, then the gate again"]) : skip('nx.json is present but nx is neither declared nor installed; the affected projects were not run');
    if (!changed.length) return pass('no changed files, so no affected projects');
    return runTool(ctx, nx, ['affected', '-t', 'test', 'lint', `--files=${changed.join(',')}`], 'nx affected -t test lint');
  }
  if (ctx.baseEntries.has('turbo.json')) {
    const turbo = resolveBin(ctx.root, ctx.root, 'turbo');
    if (!turbo) return declaresBin(ctx.basePkg, 'turbo') ? fail(["turbo is declared in package.json but not installed; run the repository's install, then the gate again"]) : skip('turbo.json is present but turbo is neither declared nor installed; the affected packages were not run');
    if (!changed.length) return pass('no changed files, so no affected packages');
    return runTool(ctx, turbo, ['run', 'test', 'lint', `--filter=...[${ctx.base}]`], 'turbo run test lint (affected since the base)');
  }
  const pkgs = workspacePackages(ctx);
  if (!pkgs.length) return skip('single-package repository (no nx, turbo or workspaces); the earlier steps covered it');
  const { direct, all } = affectedPackages(pkgs, changed);
  if (!all.length) return pass(`no workspace package changed (${pkgs.length} package(s) in the workspace)`);
  const names = all.map((k) => k.name).join(', ');
  const reasons: string[] = [];
  const ran: string[] = [];
  for (const k of all) {
    for (const script of ['test', 'lint']) {
      if (typeof k.scripts[script] !== 'string') continue;
      const s = scriptCommand(ctx, script, k.rel);
      if (!s.ok) {
        reasons.push(`${k.name}: ${s.reason}`);
        continue;
      }
      const r = runScript(s.cmd, [], ctx.timeout('affected'));
      ran.push(`${k.name} ${script}`);
      if (r.code !== 0) reasons.push(`${k.name}: \`${s.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r, 6).map((l) => `  ${l}`));
    }
  }
  if (reasons.length) return fail(capReasons(reasons, 20));
  const dependents = all.length - direct.length;
  if (!ran.length) return pass(`affected packages: ${names} (${direct.length} changed, ${dependents} dependent); none has its own test or lint script, so the repository-level runs covered them`);
  return pass(`affected packages: ${names} (${direct.length} changed, ${dependents} dependent); ran ${ran.join(', ')}`);
}

export const affectedStep: StepDef = { name: 'affected', design: 9, group: 'affected', cacheFail: false, after: ['build'], inputs: (ctx) => [ctx.tree], run: runAffected };

