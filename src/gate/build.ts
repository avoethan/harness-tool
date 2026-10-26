/**
 * Step 3: build, typecheck and lint with the repository's own scripts and
 * binaries (argv arrays, timeouts from config, never installing).
 *
 *   build      the base commit's `build` script, when there is one.
 *   typecheck  the repository's own way, in this order: the base commit's
 *              `typecheck`, `type-check`, `tsc`, `check:types` or `types`
 *              script; else, when the `build` script runs tsc, a skip (the
 *              build step checks the types); else `tsc -b` when tsconfig.json
 *              has project references; else `tsc -p tsconfig.json --noEmit
 *              --incremental --tsBuildInfoFile ~/.harness/cache/<repoId>/tsbuildinfo`
 *              (nothing written in the repository).
 *   lint       ESLint and Prettier (`--check`) on the changed files only,
 *              when the repository configures and installs them; else the
 *              base commit's `lint` script.
 * An absent tool is reported as a skip with the reason, never silently.
 *
 * Each run function takes an optional checkout folder `at`: the same step,
 * the same commands and files, run in a checkout of the base commit, so a
 * failure can be compared with the base (src/gate/baseline.ts).
 */
import * as path from 'node:path';
import type { GateContext } from './context';
import { entriesDigest } from './cache';
import { harnessHome } from '../lib/paths';
import { tryParseJsonc } from '../lib/jsonc';
import { redactText } from '../lib/redact';
import { run } from '../lib/exec';
import { declaresBin, failureLines, resolveBin, runScript, scriptCommand, type ScriptCommand } from './scripts';
import { capReasons, fail, pass, skip, type FailureIdentity, type StepDef, type StepOutcome } from './steps';
import { inCheckout, rootsFor, scriptIdentity, tsDiagnostics, withoutLineNumbers } from './baseline';

const LINT_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const ESLINT_CONFIG = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:js|cjs|json|ya?ml))?)$/;
const PRETTIER_CONFIG = /^(?:\.prettierrc(?:\.(?:json|ya?ml|json5|js|cjs|mjs|toml))?|prettier\.config\.[cm]?[jt]s)$/;

function wholeTree(ctx: GateContext): string[] {
  return [ctx.tree];
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/** Run a repository script (in the checkout `at` when given); a failure carries a comparable identity. */
export function scriptOutcome(ctx: GateContext, step: string, cmd: ScriptCommand, at: string | undefined, passLine: (ms: number) => string | string[], timeoutKey = step): StepOutcome {
  const r = runScript(cmd, [], ctx.timeout(timeoutKey), at ? { cwd: inCheckout(ctx, cmd.cwd, at) } : {});
  if (r.code === 0) {
    const p = passLine(r.durationMs);
    return pass(...(Array.isArray(p) ? p : [p]));
  }
  const header = `\`${cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`;
  const id = scriptIdentity(r, `${step}:${cmd.display}`, header, rootsFor(ctx, at));
  return { status: 'fail', reasons: [header, ...failureLines(r)], ...(id ? { identity: id } : {}) };
}

export function runBuild(ctx: GateContext, at?: string): StepOutcome {
  if (!ctx.basePkg) return skip('no package.json at the base commit (not a Node project; no build to run)');
  const s = scriptCommand(ctx, 'build');
  if (!s.ok) return s.missing ? skip(`${s.reason}; nothing to build`) : fail([s.reason]);
  return scriptOutcome(ctx, 'build', s.cmd, at, (ms) => `ran \`${s.cmd.display}\` (${ms} ms)`);
}

// ---------------------------------------------------------------------------
// typecheck
// ---------------------------------------------------------------------------

export function tsBuildInfoPath(repoId: string, atBase = false): string {
  return path.join(harnessHome(), 'cache', repoId, atBase ? 'tsbuildinfo-base' : 'tsbuildinfo');
}

export function typecheckArgs(ctx: Pick<GateContext, 'baseText' | 'repoId'>, atBase = false): { args: string[]; how: string } {
  const cfg = ctx.baseText('tsconfig.json');
  const parsed = cfg ? tryParseJsonc<{ references?: unknown[] }>(cfg) : null;
  const refs = parsed && parsed.ok && Array.isArray(parsed.value?.references) && parsed.value!.references!.length > 0;
  if (refs) return { args: ['-b', 'tsconfig.json'], how: 'tsc -b (project references)' };
  return { args: ['-p', 'tsconfig.json', '--noEmit', '--incremental', '--tsBuildInfoFile', tsBuildInfoPath(ctx.repoId, atBase)], how: 'tsc --noEmit --incremental (build info kept under the harness cache)' };
}

/** The scripts that are the repository's own typecheck, in the order the gate prefers them. */
export const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'tsc', 'check:types', 'types'];

export type TypecheckPlan =
  | { kind: 'script'; name: string; cmd: ScriptCommand }
  | { kind: 'tsc'; bin: string[]; args: string[]; how: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

const RUNS_TSC = /(?:^|[\s;&|(])(?:npx\s+)?tsc(?=\s|$|[;&|)])/;

/** Whether the base commit's `build` script runs tsc (directly, or through the script it names). */
export function buildRunsTsc(ctx: Pick<GateContext, 'basePkg' | 'root' | 'baseText' | 'nowText' | 'pm'>): boolean {
  const body = ctx.basePkg?.scripts?.build;
  if (typeof body !== 'string' || !body.trim()) return false;
  if (RUNS_TSC.test(body)) return true;
  const s = scriptCommand(ctx, 'build');
  return s.ok && s.cmd.how === 'direct' && RUNS_TSC.test(s.cmd.display);
}

/** How the typecheck step checks types in this repository (the order is in the header). */
export function typecheckPlan(ctx: GateContext): TypecheckPlan {
  const scripts = ctx.basePkg?.scripts ?? {};
  for (const name of TYPECHECK_SCRIPTS) {
    const body = scripts[name];
    if (typeof body !== 'string' || !body.trim()) continue;
    const s = scriptCommand(ctx, name);
    if (s.ok) return { kind: 'script', name, cmd: s.cmd };
    return s.missing ? { kind: 'skip', reason: s.reason } : { kind: 'fail', reason: s.reason };
  }
  if (buildRunsTsc(ctx)) return { kind: 'skip', reason: 'the `build` script runs tsc, so the build step checks the types; no separate typecheck ran (there is no typecheck script)' };
  if (!ctx.entries.has('tsconfig.json')) return { kind: 'skip', reason: `no tsconfig.json and no typecheck script at the base commit (${TYPECHECK_SCRIPTS.join(', ')})` };
  const tsc = resolveBin(ctx.root, ctx.root, 'tsc');
  if (!tsc) {
    // Declared but missing means the dependencies are not installed: the gate cannot verify, so it fails rather than skipping.
    if (declaresBin(ctx.basePkg, 'tsc')) return { kind: 'fail', reason: "TypeScript is declared in package.json but not installed (node_modules is missing or incomplete); run the repository's install, then the gate again (the gate never installs)" };
    return { kind: 'skip', reason: 'tsconfig.json is present but TypeScript is neither declared nor installed in the repository; no typecheck ran' };
  }
  const { args, how } = typecheckArgs(ctx);
  return { kind: 'tsc', bin: tsc, args, how };
}

export function runTypecheck(ctx: GateContext, at?: string): StepOutcome {
  const plan = typecheckPlan(ctx);
  if (plan.kind === 'skip') return skip(plan.reason);
  if (plan.kind === 'fail') return fail([plan.reason]);
  const roots = rootsFor(ctx, at);
  if (plan.kind === 'script') {
    const r = runScript(plan.cmd, [], ctx.timeout('typecheck'), at ? { cwd: inCheckout(ctx, plan.cmd.cwd, at) } : {});
    if (r.code === 0) return pass(`ran \`${plan.cmd.display}\` (the repository's \`${plan.name}\` script, ${r.durationMs} ms)`);
    const header = `\`${plan.cmd.display}\` exited ${r.timedOut ? 'on timeout' : r.code}`;
    const errs = tsDiagnostics(`${r.stdout}\n${r.stderr}`, roots);
    const id = scriptIdentity(r, `typecheck:script:${plan.name}:${plan.cmd.display}`, header, roots);
    return { status: 'fail', reasons: capReasons(errs.length ? [`${header}: ${errs.length} type error(s):`, ...errs.map((e) => e.text)] : [header, ...failureLines(r)], 21), ...(id ? { identity: id } : {}) };
  }
  const args = at ? typecheckArgs(ctx, true).args : plan.args;
  const r = run(plan.bin[0], [...plan.bin.slice(1), ...args], { cwd: at ?? ctx.root, timeoutMs: ctx.timeout('typecheck'), env: { ...process.env, FORCE_COLOR: '0' } });
  if (r.code === 0) return pass(`${plan.how}: no errors (${r.durationMs} ms)`);
  const errs = tsDiagnostics(`${r.stdout}\n${r.stderr}`, roots);
  const fingerprint = `typecheck:${plan.how}`;
  if (!errs.length) {
    const header = `tsc exited ${r.timedOut ? 'on timeout' : r.code}`;
    const id = scriptIdentity(r, fingerprint, header, roots);
    return { status: 'fail', reasons: [header, ...failureLines(r)], ...(id ? { identity: id } : {}) };
  }
  const identity: FailureIdentity | undefined = r.timedOut ? undefined : { kind: 'diagnostics', fingerprint, exit: null, header: `${plan.how.split(' (')[0]} reported ${errs.length} type error(s)`, items: errs };
  return { status: 'fail', reasons: capReasons([`${errs.length} type error(s):`, ...errs.map((e) => e.text)], 21), ...(identity ? { identity } : {}) };
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

/**
 * ESLint and Prettier on the changed files, else the `lint` script. With
 * `at` (a base checkout) the same linters run there on the changed files
 * that exist at the base, and the script fallback is taken only when it was
 * taken for the current tree, so both runs check the same way.
 */
export function runLint(ctx: GateContext, at?: string): StepOutcome {
  const dir = at ?? ctx.root;
  const changed = ctx.changedPresent();
  const lintable = changed.filter((p) => LINT_EXT.test(p) && !/(^|\/)(?:node_modules|dist|build|coverage)\//.test(p));
  const formattable = changed.filter((p) => !/(^|\/)(?:node_modules|dist|build|coverage)\//.test(p));
  const here = (files: string[]) => (at ? files.filter((p) => ctx.baseEntries.has(p)) : files);
  const fingerprint = `lint:eslint=${lintable.join(',')}|prettier=${formattable.join(',')}`;
  const reasons: string[] = [];
  const notes: string[] = [];
  const items: Array<{ id: string; text: string }> = [];
  let unstructured = false;
  let ran = 0;
  let fileScoped = false;
  if (hasEslintConfig(ctx)) {
    const eslint = resolveBin(ctx.root, ctx.root, 'eslint');
    const files = here(lintable);
    if (!eslint) {
      if (declaresBin(ctx.basePkg, 'eslint')) reasons.push("ESLint is declared in package.json but not installed; run the repository's install, then the gate again");
      else notes.push('ESLint is configured but neither declared nor installed in the repository; ESLint did not run');
      unstructured = unstructured || reasons.length > 0;
    } else if (lintable.length) {
      fileScoped = true;
      ran++;
      if (files.length) {
        const r = run(eslint[0], [...eslint.slice(1), '--format', 'json', ...files], { cwd: dir, timeoutMs: ctx.timeout('lint'), maxBuffer: 64 * 1024 * 1024 });
        let parsed: EslintFileResult[] | null = null;
        try {
          const s = r.stdout.indexOf('[');
          parsed = JSON.parse(s >= 0 ? r.stdout.slice(s) : r.stdout) as EslintFileResult[];
        } catch {
          parsed = null;
        }
        if (!parsed) {
          if (r.code !== 0) {
            reasons.push(`eslint exited ${r.timedOut ? 'on timeout' : r.code} without a report`, ...failureLines(r, 8));
            unstructured = true;
          }
        } else {
          for (const f of parsed) {
            const rel = path.relative(dir, f.filePath).split(path.sep).join('/');
            for (const m of f.messages) {
              if (m.severity !== 2) continue;
              const msg = redactText(m.message).slice(0, 200);
              const text = `${rel}:${m.line ?? 0} ${m.ruleId ?? 'parse'}: ${msg}`;
              reasons.push(text);
              items.push({ id: `${rel}|${m.ruleId ?? 'parse'}|${withoutLineNumbers(msg)}`, text });
            }
          }
        }
      }
      notes.push(`eslint on ${lintable.length} changed file(s)`);
    } else notes.push('no lintable files changed');
  }
  if (hasPrettierConfig(ctx)) {
    const prettier = resolveBin(ctx.root, ctx.root, 'prettier');
    const files = here(formattable);
    if (!prettier) {
      if (declaresBin(ctx.basePkg, 'prettier')) {
        reasons.push("Prettier is declared in package.json but not installed; run the repository's install, then the gate again");
        unstructured = true;
      } else notes.push('Prettier is configured but neither declared nor installed in the repository; the format check did not run');
    } else if (formattable.length) {
      fileScoped = true;
      ran++;
      if (files.length) {
        const r = run(prettier[0], [...prettier.slice(1), '--check', '--ignore-unknown', '--no-color', ...files], { cwd: dir, timeoutMs: ctx.timeout('lint') });
        if (r.code === 1) {
          const bad = `${r.stdout}\n${r.stderr}`
            .split(/\r?\n/)
            .map((l) => /^\[warn\]\s+(.+)$/.exec(l.trim())?.[1])
            .filter((f): f is string => !!f && !/Code style issues|Run Prettier/i.test(f) && files.includes(f.trim()));
          for (const f of bad) {
            const text = `${f.trim()}: not formatted (run the repository's prettier --write on it)`;
            reasons.push(text);
            items.push({ id: `${f.trim()}|prettier`, text });
          }
          if (!bad.length) {
            reasons.push('prettier --check reported unformatted files', ...failureLines(r, 5));
            unstructured = true;
          }
        } else if (r.code !== 0) {
          reasons.push(`prettier exited ${r.timedOut ? 'on timeout' : r.code}`, ...failureLines(r, 5));
          unstructured = true;
        } else notes.push(`prettier --check on ${files.length} changed file(s)`);
      } else notes.push(`prettier --check on ${files.length} changed file(s)`);
    }
  }
  if (!ran && !reasons.length && !fileScoped) {
    const s = scriptCommand(ctx, 'lint');
    if (s.ok && (lintable.length || !notes.length)) {
      return scriptOutcome(ctx, 'lint', s.cmd, at, () => [`ran \`${s.cmd.display}\` (the whole repository: no file-scoped linter resolved)`, ...notes]);
    }
    if (notes.some((n) => /not installed/.test(n))) return skip(notes.join('; '));
    if (!notes.length) return skip('no linter configured (no ESLint or Prettier config and no lint script at the base commit)');
  }
  if (reasons.length) {
    const identity: FailureIdentity | undefined = !unstructured && items.length === reasons.length ? { kind: 'diagnostics', fingerprint, exit: null, header: `${items.length} lint problem(s) in the changed files`, items } : undefined;
    return { status: 'fail', reasons: capReasons(reasons), ...(identity ? { identity } : {}) };
  }
  return pass(...notes);
}

function lintInputs(ctx: GateContext): string[] {
  const changed = new Set(ctx.changedPresent());
  const cfg = (p: string) => !p.includes('/') && (ESLINT_CONFIG.test(p) || PRETTIER_CONFIG.test(p) || p === 'package.json' || /^tsconfig.*\.json$/.test(p));
  return [entriesDigest(ctx.entries, (p) => changed.has(p) || cfg(p))];
}

export const buildStep: StepDef = { name: 'build', design: 3, group: 'build', cacheFail: false, inputs: wholeTree, run: (ctx) => runBuild(ctx), baseline: runBuild };
export const typecheckStep: StepDef = { name: 'typecheck', design: 3, group: 'build', cacheFail: false, inputs: wholeTree, run: (ctx) => runTypecheck(ctx), baseline: runTypecheck };
export const lintStep: StepDef = { name: 'lint', design: 3, group: 'build', cacheFail: true, inputs: lintInputs, run: (ctx) => runLint(ctx), baseline: runLint };
