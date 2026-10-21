/**
 * Step 1, tamper diff against the base commit (R-05: agents game editable
 * tests; read-only tests block that without hurting solves).
 *
 * FAILs, naming the files, when the change:
 *   - deletes or renames a test file,
 *   - adds `.only` / `.skip` / `.todo` / `xit` / `xfail` / `{ skip: true }` markers,
 *   - lowers the assertion count (`expect(`, `assert…(`, `should`) of a touched test file,
 *   - edits a protected file (CI, git hooks, lint/format/type-check/test-runner
 *     config, golden or snapshot files, harness files) or a gate-relevant
 *     package.json script or config key, unless the brief's allowed paths
 *     (the units' paths, `allowedPaths`) or the base commit's
 *     `.harness/config.json` `gate.allowedPaths` include it,
 *   - changes test files outside the tests phase (task runs with a phase record).
 *
 * A protected file is not a finding when its change came from a commit the
 * harness made itself (the personal setting's apply commit, whose sha the plan
 * record under ~/.harness keeps, where an agent cannot write), the commit lies
 * between the base and HEAD, and the file is byte-identical to that commit's
 * version: installing the harness is the user's act, not tampering, and the
 * first push after an install carries it. Any later change to the same file is
 * still a finding.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateContext, DiffEntry } from './context';
import { isGoldenFile, isTestFile } from './context';
import { entriesDigest } from './cache';
import { matchGlob } from '../discover/glob';
import { tryParseJsonc } from '../lib/jsonc';
import { rawGit } from '../lib/git';
import { listPlanIds, loadPlanRecord } from '../lifecycle/backup';
import { capReasons, fail, pass, type StepDef, type StepOutcome } from './steps';

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Remove comments so a commented-out assertion or marker does not count. */
export function stripComments(text: string, rel = ''): string {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  t = t.replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
  if (/\.py$/i.test(rel)) t = t.replace(/(^|\s)#.*$/gm, '$1');
  return t;
}

const ASSERTION_RES = [/\bexpect\s*\(/g, /\bassert(?:\.\w+)*\s*\(/g, /\.should\b/g, /\bshould\s*\(/g, /\bself\.assert\w*\s*\(/g];

/** Assertion calls in a test file (`expect(`, `assert(`, `assert.x(`, `.should`, `should(`, `self.assertX(`). */
export function countAssertions(text: string, rel = ''): number {
  const t = stripComments(text, rel);
  let n = 0;
  for (const re of ASSERTION_RES) n += (t.match(new RegExp(re.source, 'g')) ?? []).length;
  return n;
}

const SKIP_MARKERS: Array<{ name: string; re: RegExp }> = [
  { name: '.only', re: /\b(?:it|test|describe|suite|context|specify)\.only\b/g },
  { name: '.skip', re: /\b(?:it|test|describe|suite|context|specify)\.skip(?:If)?\b/g },
  { name: '.todo', re: /\b(?:it|test|describe|suite)\.todo\b/g },
  { name: '.fixme', re: /\b(?:it|test|describe)\.fixme\b/g },
  { name: 'xit/xdescribe', re: /\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/g },
  { name: 'fit/fdescribe', re: /\b(?:fit|fdescribe)\s*\(/g },
  { name: 't.skip/t.todo', re: /\bt\.(?:skip|todo)\s*\(/g },
  { name: '{ skip/only/todo }', re: /[{,]\s*(?:skip|only|todo)\s*:\s*(?!false\b)[^,}\s]/g },
  { name: 'xfail/skip mark', re: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.skip\w*/g },
];

/** Focus/skip markers per kind in a test file. */
export function countSkipMarkers(text: string, rel = ''): Record<string, number> {
  const t = stripComments(text, rel);
  const out: Record<string, number> = {};
  for (const m of SKIP_MARKERS) {
    const n = (t.match(new RegExp(m.re.source, 'g')) ?? []).length;
    if (n) out[m.name] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Protected files
// ---------------------------------------------------------------------------

const PROTECTED: Array<{ kind: string; test: (p: string, base: string) => boolean }> = [
  { kind: 'CI configuration', test: (p, b) => /(^|\/)\.github\/workflows\//.test(p) || /(^|\/)\.circleci\//.test(p) || /(^|\/)\.buildkite\//.test(p) || /^(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|bitbucket-pipelines\.yml|\.travis\.yml)$/.test(b) },
  { kind: 'git hook configuration', test: (p, b) => /(^|\/)\.husky\//.test(p) || /(^|\/)\.githooks\//.test(p) || /^(?:\.?lefthook(?:-local)?\.ya?ml|\.pre-commit-config\.ya?ml|\.simple-git-hooks\.(?:c?js|json)|\.lintstagedrc(?:\..+)?|lint-staged\.config\.[cm]?js|commitlint\.config\.[cm]?[jt]s|\.commitlintrc(?:\..+)?)$/.test(b) },
  { kind: 'lint or format configuration', test: (_p, b) => /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?|\.eslintignore|\.prettierrc(?:\..+)?|prettier\.config\.[cm]?[jt]s|\.prettierignore|\.editorconfig|biome\.jsonc?|\.stylelintrc(?:\..+)?|stylelint\.config\.[cm]?js|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|tslint\.json|\.markdownlint(?:\..+)?|\.golangci\.ya?ml)$/.test(b) },
  { kind: 'type-check configuration', test: (_p, b) => /^(?:tsconfig|jsconfig)(?:\.[\w-]+)*\.json$/.test(b) },
  { kind: 'test runner configuration', test: (_p, b) => /^(?:vitest\.(?:config|workspace)\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|\.mocharc(?:\..+)?|playwright\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|karma\.conf\.[cm]?js|pytest\.ini|\.c8rc(?:\..+)?|\.nycrc(?:\..+)?|codecov\.ya?ml|\.codecov\.ya?ml|ava\.config\.[cm]?js)$/.test(b) },
  { kind: 'golden or snapshot file', test: (p) => isGoldenFile(p) },
  { kind: 'harness file', test: (p, b) => /(^|\/)\.(?:harness|claude|codex|devin|agents)\//.test(p) || /^(?:AGENTS|CLAUDE)(?:[.-][\w.-]+)?\.md$/i.test(b) },
];

/** The kind of protected file a path is, or null. */
export function protectedKind(rel: string): string | null {
  const p = rel.replace(/\\/g, '/');
  const b = path.posix.basename(p);
  for (const k of PROTECTED) if (k.test(p, b)) return k.kind;
  return null;
}

const GATE_SCRIPT = /^(?:pre|post)?(?:test|tests|lint|build|typecheck|type-check|types|tsc|check|verify|coverage|cov|ci|format(?::check)?)(?::.+)?$/;
const GATE_KEYS = ['jest', 'c8', 'nyc', 'vitest', 'ava', 'mocha', 'eslintConfig', 'prettier', 'husky', 'lint-staged', 'simple-git-hooks', 'commitlint'];

/** Gate-relevant package.json changes: test/lint/build/... scripts changed or removed, test or lint config keys changed. */
export function packageJsonChanges(baseText: string | null, nowText: string | null): string[] {
  if (!baseText || !nowText) return [];
  const b = tryParseJsonc<Record<string, unknown>>(baseText);
  const n = tryParseJsonc<Record<string, unknown>>(nowText);
  if (!b.ok || !n.ok || !b.value || !n.value) return [];
  const out: string[] = [];
  const bs = (b.value.scripts ?? {}) as Record<string, unknown>;
  const ns = (n.value.scripts ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(bs)) {
    if (!GATE_SCRIPT.test(k)) continue;
    if (!(k in ns)) out.push(`script "${k}" removed`);
    else if (JSON.stringify(bs[k]) !== JSON.stringify(ns[k])) out.push(`script "${k}" changed`);
  }
  for (const k of GATE_KEYS) {
    if (JSON.stringify(b.value[k] ?? null) !== JSON.stringify(n.value[k] ?? null)) out.push(`"${k}" settings changed`);
  }
  return out;
}

/** Whether a path is allowed by a list of globs or folders. */
export function isAllowed(rel: string, allowed: string[]): boolean {
  const p = rel.replace(/\\/g, '/');
  for (const raw of allowed) {
    const a = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!a) continue;
    if (p === a || p.startsWith(a + '/')) return true;
    if (/[*?{[]/.test(a) && matchGlob(p, a)) return true;
  }
  return false;
}

/** Whether a path named by a ticket unit names a protected file or folder (or test files) itself. */
function namesProtected(entry: string): boolean {
  const e = entry.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!e || e === '.' || /[*?{[]/.test(e)) return !!e && (!!protectedKind(e) || isTestFile(e));
  return !!protectedKind(e) || !!protectedKind(`${e}/x.yml`) || isTestFile(e) || isTestFile(`${e}/x.test.ts`);
}

/**
 * Paths the change may touch even when protected: a unit path of the brief
 * that itself names a protected file or folder (a ticket that names `src/`
 * does not open the snapshots under it), the brief's explicit `allowedPaths`,
 * and `gate.allowedPaths` from the config at the base commit.
 */
export function allowedPaths(ctx: Pick<GateContext, 'brief' | 'repoId' | 'config'>): string[] {
  const out: string[] = [];
  const b = ctx.brief as (GateContext['brief'] & { allowedPaths?: unknown }) | null;
  if (b) {
    for (const u of b.units ?? []) if (u.repo === ctx.repoId || !u.repo) out.push(...(u.paths ?? []).filter(namesProtected));
    if (Array.isArray(b.allowedPaths)) out.push(...b.allowedPaths.map(String));
  }
  out.push(...(ctx.config.gate?.allowedPaths ?? []));
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

function fmtMarkers(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k} x${v}`)
    .join(', ');
}

/**
 * Paths whose change in base..HEAD came from a commit the harness made itself (a plan record under
 * ~/.harness names it) and that are byte-identical to that commit's version in the checked tree.
 */
export function harnessCommitted(ctx: Pick<GateContext, 'root' | 'base' | 'head' | 'entries'>): Set<string> {
  const out = new Set<string>();
  if (!ctx.head) return out;
  let ids: Array<{ planId: string; stamp: string }> = [];
  try {
    ids = listPlanIds();
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const { planId, stamp } of ids) {
    const c = loadPlanRecord(planId, stamp)?.commit;
    if (!c || !/^[0-9a-f]{40,64}$/i.test(c) || seen.has(c)) continue;
    seen.add(c);
    if (rawGit(ctx.root, ['merge-base', '--is-ancestor', c, ctx.head], 10_000).code !== 0) continue;
    if (rawGit(ctx.root, ['merge-base', '--is-ancestor', c, ctx.base], 10_000).code === 0) continue;
    const files = rawGit(ctx.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', c], 15_000);
    if (files.code !== 0) continue;
    for (const p of files.stdout.split('\0').filter(Boolean)) {
      const at = rawGit(ctx.root, ['rev-parse', '--verify', '--quiet', `${c}:${p}`], 5000);
      const blob = at.code === 0 ? at.stdout.trim() : null;
      if ((ctx.entries.get(p)?.blob ?? null) === blob) out.add(p);
    }
  }
  return out;
}

/** Tamper findings for a change (empty when clean). */
export function tamperFindings(ctx: GateContext, opts: { now?: number } = {}): string[] {
  const out: string[] = [];
  const allowed = allowedPaths(ctx);
  const ok = (p: string) => isAllowed(p, allowed);
  let own: Set<string> | null = null;
  const harnessOwn = (p: string) => (own ??= harnessCommitted(ctx)).has(p);
  for (const d of ctx.diff) {
    const p = d.path;
    const old = d.oldPath ?? p;
    // Deleted or renamed tests.
    if (d.status === 'D' && isTestFile(p) && !ok(p)) {
      out.push(`${p}: test file deleted (tests that existed at the base commit must stay)`);
      continue;
    }
    if (d.status === 'R' && isTestFile(old) && !ok(old)) out.push(`${old} -> ${p}: test file renamed (a renamed test can fall out of the runner's include pattern)`);
    // Markers and assertions in touched test files.
    if (d.status !== 'D' && isTestFile(p)) {
      const now = ctx.nowText(p);
      const before = d.status === 'A' ? '' : ctx.baseText(old) ?? '';
      if (now !== null) {
        const mb = countSkipMarkers(before, old);
        const mn = countSkipMarkers(now, p);
        const added: Record<string, number> = {};
        for (const [k, v] of Object.entries(mn)) if (v > (mb[k] ?? 0)) added[k] = v - (mb[k] ?? 0);
        if (Object.keys(added).length) out.push(`${p}: focus/skip markers added (${fmtMarkers(added)})`);
        if (d.status !== 'A') {
          const ab = countAssertions(before, old);
          const an = countAssertions(now, p);
          if (an < ab) out.push(`${p}: assertion count dropped from ${ab} to ${an}`);
        }
      }
    }
    // Protected files.
    for (const q of d.status === 'R' ? [old, p] : [p]) {
      const kind = protectedKind(q);
      if (kind && !ok(q) && !harnessOwn(q)) {
        out.push(`${q}: ${kind} ${d.status === 'A' ? 'added' : d.status === 'D' ? 'deleted' : 'changed'} (protected; allowed only when the brief names this path)`);
        break;
      }
    }
    if (path.posix.basename(p) === 'package.json' && (d.status === 'M' || d.status === 'R') && !ok(p)) {
      for (const c of packageJsonChanges(ctx.baseText(old), ctx.nowText(p))) out.push(`${p}: ${c} (the gate runs these from the base commit; change them only when the brief names package.json)`);
    }
  }
  // Tests changed outside the tests phase.
  if (ctx.mode === 'task' && ctx.phase) {
    const changedTests = ctx.diff.filter((d) => d.status !== 'D' && isTestFile(d.path) && !ok(d.path)).map((d) => d.path);
    if (changedTests.length) {
      if (!ctx.phase.testsEntries) {
        for (const p of changedTests) out.push(`${p}: test file changed but this task never entered the tests phase (run \`harness phase tests\` before changing tests)`);
      } else if (ctx.phase.phase === 'implement') {
        const since = Date.parse(ctx.phase.since);
        const slack = 2000;
        for (const p of changedTests) {
          let m = 0;
          try {
            m = fs.statSync(path.join(ctx.root, p)).mtimeMs;
          } catch {
            continue;
          }
          if (Number.isFinite(since) && m > since + slack && m <= (opts.now ?? Date.now()) + 60_000) out.push(`${p}: test file edited during the implement phase (after ${ctx.phase.since}); tests change only in the tests phase`);
        }
      }
    }
  }
  return out;
}

function tamperInputs(ctx: GateContext): string[] {
  const touched = new Set(ctx.diff.flatMap((d) => [d.path, d.oldPath ?? d.path]));
  const pick = (p: string) => touched.has(p) && (isTestFile(p) || !!protectedKind(p) || path.posix.basename(p) === 'package.json');
  const mtimes: string[] = [];
  if (ctx.mode === 'task' && ctx.phase?.phase === 'implement') {
    for (const p of [...touched].filter(isTestFile).sort()) {
      try {
        mtimes.push(`${p}@${fs.statSync(path.join(ctx.root, p)).mtimeMs}`);
      } catch {
        /* deleted */
      }
    }
  }
  return [
    entriesDigest(ctx.entries, pick),
    entriesDigest(ctx.baseEntries, pick),
    ctx.diff.map((d) => `${d.status}:${d.oldPath ?? ''}:${d.path}`).join('|'),
    JSON.stringify(allowedPaths(ctx)),
    // which protected changes are the harness's own (a new apply changes the answer, not the tree)
    ctx.diff.some((d) => !!protectedKind(d.path) || (!!d.oldPath && !!protectedKind(d.oldPath))) ? JSON.stringify([...harnessCommitted(ctx)].sort()) : '',
    JSON.stringify(ctx.phase ? { p: ctx.phase.phase, s: ctx.phase.since, n: ctx.phase.testsEntries } : null),
    ctx.mode,
    ...mtimes,
  ];
}

export function runTamper(ctx: GateContext): StepOutcome {
  const f = tamperFindings(ctx);
  if (f.length) return fail(capReasons(f));
  const touchedTests = ctx.diff.filter((d: DiffEntry) => isTestFile(d.path)).length;
  return pass(`${ctx.diff.length} changed file(s), ${touchedTests} test file(s); nothing deleted, skipped, weakened or protected was touched`);
}

export const tamperStep: StepDef = {
  name: 'tamper',
  design: 1,
  group: 'tamper',
  cacheFail: true,
  inputs: tamperInputs,
  run: runTamper,
};
