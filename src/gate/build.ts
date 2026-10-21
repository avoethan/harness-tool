/**
 * Step 3: build, typecheck and lint with the repository's own scripts and
 * binaries (argv arrays, timeouts from config, never installing).
 *
 *   build      the base commit's `build` script, when there is one.
 *   typecheck  `tsc -b` when tsconfig.json has project references, else
 *              `tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile
 *              ~/.harness/cache/<repoId>/tsbuildinfo` (nothing written in
 *              the repository); the `typecheck` script when there is no
 *              tsconfig.json.
 *   lint       ESLint and Prettier (`--check`) on the changed files only,
 *              when the repository configures and installs them; else the
 *              base commit's `lint` script.
 * An absent tool is reported as a skip with the reason, never silently.
 */
import * as path from 'node:path';
import type { GateContext } from './context';
import { entriesDigest } from './cache';
import { harnessHome } from '../lib/paths';
import { tryParseJsonc } from '../lib/jsonc';
import { redactText } from '../lib/redact';
import { run } from '../lib/exec';
import { declaresBin, failureLines, resolveBin, runScript, scriptCommand } from './scripts';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';

const LINT_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const ESLINT_CONFIG = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:js|cjs|json|ya?ml))?)$/;
const PRETTIER_CONFIG = /^(?:\.prettierrc(?:\.(?:json|ya?ml|json5|js|cjs|mjs|toml))?|prettier\.config\.[cm]?[jt]s)$/;

function wholeTree(ctx: GateContext): string[] {
  return [ctx.tree];
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export function runBuild(ctx: GateContext): StepOutcome {
  if (!ctx.basePkg) return skip('no package.json at the base commit (not a Node project; no build to run)');
  const s = scriptCommand(ctx, 'build');
  if (!s.ok) return s.missing ? skip(`${s.reason}; nothing to build`) : fail([s.reason]);
  const r = runScript(s.cmd, [], ctx.timeout('build'));
  if (r.code === 0) return pass(`ran \`${s.cmd.display}\` (${r.durationMs} ms)`);
  return fail([`\`${s.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r)]);
}

// ---------------------------------------------------------------------------
// typecheck
// ---------------------------------------------------------------------------

export function tsBuildInfoPath(repoId: string): string {
  return path.join(harnessHome(), 'cache', repoId, 'tsbuildinfo');
}

export function typecheckArgs(ctx: Pick<GateContext, 'baseText' | 'repoId'>): { args: string[]; how: string } {
  const cfg = ctx.baseText('tsconfig.json');
  const parsed = cfg ? tryParseJsonc<{ references?: unknown[] }>(cfg) : null;
  const refs = parsed && parsed.ok && Array.isArray(parsed.value?.references) && parsed.value!.references!.length > 0;
  if (refs) return { args: ['-b', 'tsconfig.json'], how: 'tsc -b (project references)' };
  return { args: ['-p', 'tsconfig.json', '--noEmit', '--incremental', '--tsBuildInfoFile', tsBuildInfoPath(ctx.repoId)], how: 'tsc --noEmit --incremental (build info kept under the harness cache)' };
}

function tsErrors(out: string): string[] {
  return out
    .split(/\r?\n/)
    .filter((l) => /error TS\d+/.test(l))
    .map((l) => redactText(l.trim()).slice(0, 240));
}

export function runTypecheck(ctx: GateContext): StepOutcome {
  const hasTsconfig = ctx.entries.has('tsconfig.json');
  if (!hasTsconfig) {
    const s = scriptCommand(ctx, 'typecheck');
    if (!s.ok) return s.missing ? skip('no tsconfig.json and no typecheck script at the base commit') : fail([s.reason]);
    const r = runScript(s.cmd, [], ctx.timeout('typecheck'));
    return r.code === 0 ? pass(`ran \`${s.cmd.display}\``) : fail([`\`${s.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r)]);
  }
  const tsc = resolveBin(ctx.root, ctx.root, 'tsc');
  if (!tsc) {
    // Declared but missing means the dependencies are not installed: the gate cannot verify, so it fails rather than skipping.
    if (declaresBin(ctx.basePkg, 'tsc')) return fail(["TypeScript is declared in package.json but not installed (node_modules is missing or incomplete); run the repository's install, then the gate again (the gate never installs)"]);
    return skip('tsconfig.json is present but TypeScript is neither declared nor installed in the repository; no typecheck ran');
  }
  const { args, how } = typecheckArgs(ctx);
  const r = run(tsc[0], [...tsc.slice(1), ...args], { cwd: ctx.root, timeoutMs: ctx.timeout('typecheck'), env: { ...process.env, FORCE_COLOR: '0' } });
  if (r.code === 0) return pass(`${how}: no errors (${r.durationMs} ms)`);
  const out = `${r.stdout}\n${r.stderr}`;
  // Option conflicts (TS5xxx/TS6xxx at the config level): fall back to the repository's own typecheck script.
  if (/error TS5\d{3}|error TS6\d{3}/.test(out) && !/\.tsx?\(\d+,\d+\)/.test(out)) {
    const s = scriptCommand(ctx, 'typecheck');
    if (s.ok) {
      const r2 = runScript(s.cmd, [], ctx.timeout('typecheck'));
      return r2.code === 0 ? pass(`ran \`${s.cmd.display}\` (the incremental tsc call conflicted with the tsconfig options)`) : fail([`\`${s.cmd.display}\` exited ${r2.code}`, ...failureLines(r2)]);
    }
  }
  const errs = tsErrors(out);
  return fail(capReasons(errs.length ? [`${errs.length} type error(s):`, ...errs] : [`tsc exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r)], 21));
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

interface EslintFileResult {
  filePath: string;
  messages: Array<{ ruleId: string | null; severity: number; line?: number; message: string; fatal?: boolean }>;
}

function hasEslintConfig(ctx: GateContext): boolean {
  for (const p of ctx.entries.keys()) if (!p.includes('/') && ESLINT_CONFIG.test(p)) return true;
  return !!ctx.basePkg?.eslintConfig;
}

function hasPrettierConfig(ctx: GateContext): boolean {
  for (const p of ctx.entries.keys()) if (!p.includes('/') && PRETTIER_CONFIG.test(p)) return true;
  return !!ctx.basePkg?.prettier;
}

export function runLint(ctx: GateContext): StepOutcome {
  const changed = ctx.changedPresent();
  const lintable = changed.filter((p) => LINT_EXT.test(p) && !/(^|\/)(?:node_modules|dist|build|coverage)\//.test(p));
  const reasons: string[] = [];
  const notes: string[] = [];
  let ran = 0;
  if (hasEslintConfig(ctx)) {
    const eslint = resolveBin(ctx.root, ctx.root, 'eslint');
    if (!eslint) {
      if (declaresBin(ctx.basePkg, 'eslint')) reasons.push("ESLint is declared in package.json but not installed; run the repository's install, then the gate again");
      else notes.push('ESLint is configured but neither declared nor installed in the repository; ESLint did not run');
    }
    else if (lintable.length) {
      ran++;
      const r = run(eslint[0], [...eslint.slice(1), '--format', 'json', ...lintable], { cwd: ctx.root, timeoutMs: ctx.timeout('lint'), maxBuffer: 64 * 1024 * 1024 });
      let parsed: EslintFileResult[] | null = null;
      try {
        const s = r.stdout.indexOf('[');
        parsed = JSON.parse(s >= 0 ? r.stdout.slice(s) : r.stdout) as EslintFileResult[];
      } catch {
        parsed = null;
      }
      if (!parsed) {
        if (r.code !== 0) reasons.push(`eslint exited ${r.timedOut ? 'on timeout' : r.code} without a report`, ...failureLines(r, 8));
      } else {
        for (const f of parsed) {
          const rel = path.relative(ctx.root, f.filePath).split(path.sep).join('/');
          for (const m of f.messages) {
            if (m.severity !== 2) continue;
            reasons.push(`${rel}:${m.line ?? 0} ${m.ruleId ?? 'parse'}: ${redactText(m.message).slice(0, 200)}`);
          }
        }
        notes.push(`eslint on ${lintable.length} changed file(s)`);
      }
    } else notes.push('no lintable files changed');
  }
  if (hasPrettierConfig(ctx)) {
    const prettier = resolveBin(ctx.root, ctx.root, 'prettier');
    const files = changed.filter((p) => !/(^|\/)(?:node_modules|dist|build|coverage)\//.test(p));
    if (!prettier) {
      if (declaresBin(ctx.basePkg, 'prettier')) reasons.push("Prettier is declared in package.json but not installed; run the repository's install, then the gate again");
      else notes.push('Prettier is configured but neither declared nor installed in the repository; the format check did not run');
    }
    else if (files.length) {
      ran++;
      const r = run(prettier[0], [...prettier.slice(1), '--check', '--ignore-unknown', '--no-color', ...files], { cwd: ctx.root, timeoutMs: ctx.timeout('lint') });
      if (r.code === 1) {
        const bad = `${r.stdout}\n${r.stderr}`
          .split(/\r?\n/)
          .map((l) => /^\[warn\]\s+(.+)$/.exec(l.trim())?.[1])
          .filter((f): f is string => !!f && !/Code style issues|Run Prettier/i.test(f) && files.includes(f.trim()));
        for (const f of bad) reasons.push(`${f.trim()}: not formatted (run the repository's prettier --write on it)`);
        if (!bad.length) reasons.push('prettier --check reported unformatted files', ...failureLines(r, 5));
      } else if (r.code !== 0) reasons.push(`prettier exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r, 5));
      else notes.push(`prettier --check on ${files.length} changed file(s)`);
    }
  }
  if (!ran && !reasons.length) {
    const s = scriptCommand(ctx, 'lint');
    if (s.ok && (lintable.length || !notes.length)) {
      const r = runScript(s.cmd, [], ctx.timeout('lint'));
      if (r.code === 0) return pass(`ran \`${s.cmd.display}\` (the whole repository: no file-scoped linter resolved)`, ...notes);
      return fail([`\`${s.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r)]);
    }
    if (notes.some((n) => /not installed/.test(n))) return skip(notes.join('; '));
    if (!notes.length) return skip('no linter configured (no ESLint or Prettier config and no lint script at the base commit)');
  }
  if (reasons.length) return fail(capReasons(reasons));
  return pass(...notes);
}

function lintInputs(ctx: GateContext): string[] {
  const changed = new Set(ctx.changedPresent());
  const cfg = (p: string) => !p.includes('/') && (ESLINT_CONFIG.test(p) || PRETTIER_CONFIG.test(p) || p === 'package.json' || /^tsconfig.*\.json$/.test(p));
  return [entriesDigest(ctx.entries, (p) => changed.has(p) || cfg(p))];
}

export const buildStep: StepDef = { name: 'build', design: 3, group: 'build', cacheFail: false, inputs: wholeTree, run: runBuild };
export const typecheckStep: StepDef = { name: 'typecheck', design: 3, group: 'build', cacheFail: false, inputs: wholeTree, run: runTypecheck };
export const lintStep: StepDef = { name: 'lint', design: 3, group: 'build', cacheFail: true, inputs: lintInputs, run: runLint };
