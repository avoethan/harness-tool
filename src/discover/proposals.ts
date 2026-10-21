/**
 * Team proposals (`harness propose --for-team <repo>`): changes a team could
 * adopt so its standards are enforced by its own tools, each as a diff plus
 * a short write-up with the evidence, written to
 * ~/.harness/proposals/<repoId>/<n>-<slug>.md and .diff. Never applied: the
 * user carries a proposal through the team's normal pull-request path.
 *
 * Kinds:
 *   eslint-baseline   a rule declared at warn level but not followed: raise
 *                     it to error and record the existing violations as a
 *                     baseline (or drop it); an unwritten counted-strong
 *                     convention that a core ESLint rule can express
 *   ci-step           a check-like script CI does not run; a commit-subject
 *                     check when subjects are counted-strong and nothing
 *                     enforces them
 *   contributing      one sentence per counted-strong convention that the
 *                     repository's CONTRIBUTING does not state
 * No proposal ever aligns two repositories that disagree (conflicts stay
 * scoped).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ledger, LedgerRecord } from '../types';
import { harnessHome } from '../lib/paths';
import { ensureDir, readJsonOr, writeTextAtomic } from '../lib/fsx';
import { repoIdFor } from '../lib/config';
import type { DiscoverFinding } from './model';
import { ledgerDir } from './emit';
import { unifiedDiff } from './diff';
import { matchBracket } from './declared';

export interface Proposal {
  n: number;
  slug: string;
  kind: 'eslint-baseline' | 'ci-step' | 'contributing' | 'config-fix';
  title: string;
  file: string;
  writeup: string;
  diff: string;
  records: string[];
}

interface InvRepo {
  id: string;
  name: string;
  path: string;
  relPath: string;
  packageManager: string;
  packages: Array<{ id: string; name: string; dir: string; scripts: Record<string, string> }>;
  configs: Record<string, string[]>;
  ci: Array<{ file: string; scripts: string[]; jobs: Array<{ id: string; name: string; runs: string[] }> }>;
}

export function proposalsDir(repoId: string): string {
  return path.join(harnessHome(), 'proposals', repoId);
}

/** Find a repository in the last discovery's inventory by path, name or id. */
export function resolveRepo(ref: string, repos: InvRepo[]): InvRepo | null {
  const abs = path.resolve(ref);
  return repos.find((r) => r.path === abs) ?? repos.find((r) => r.id === ref) ?? repos.find((r) => r.name === ref) ?? repos.find((r) => r.id === repoIdFor(abs)) ?? null;
}

function inScope(r: LedgerRecord, repoId: string): boolean {
  return r.scope.repos.includes('*') || r.scope.repos.includes(repoId);
}

function read(repo: InvRepo, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(repo.path, rel), 'utf8');
  } catch {
    return null;
  }
}

function quoteOf(ledger: Ledger, repoId: string): string {
  const q = ledger.records.find((r) => r.id.startsWith('format.quotes-') && inScope(r, repoId));
  return q?.id.endsWith('double') ? '"' : "'";
}

/** ESLint core-rule equivalent of a counted convention: rule, options (object literal text), exemptions. */
interface EslintEq {
  rule: string;
  /** Option objects (merged into one entry when several records use the same rule), or a plain option. */
  options: string[];
  exemptFiles?: string[];
  note: string;
}

function eslintEquivalent(r: LedgerRecord, s: (x: string) => string): EslintEq | null {
  if (r.id === 'lint.curly') return { rule: 'curly', options: [s('all')], note: 'core rule `curly`' };
  if (r.id === 'lint.eqeqeq') return { rule: 'eqeqeq', options: [s('always')], note: 'core rule `eqeqeq`' };
  if (r.id === 'logging.logger-not-console') return { rule: 'no-console', options: [], note: 'core rule `no-console`' };
  if (r.id.startsWith('layout.driver-gateway-')) {
    const m = /Only (.+?) imports `([^`]+)`/.exec(r.statement);
    if (!m) return null;
    return { rule: 'no-restricted-imports', options: [`{ name: ${s(m[2])}, message: ${s(`Go through ${m[1]}.`)} }`], exemptFiles: m[1].split(' / ').map((g) => `**/${g}`), note: 'core rule `no-restricted-imports`, off for the gateway module' };
  }
  if (r.id === 'layout.env-access') {
    const m = /Only (.+?) reads process\.env/.exec(r.statement);
    if (!m) return null;
    return { rule: 'no-restricted-properties', options: [`{ object: ${s('process')}, property: ${s('env')}, message: ${s(`Read configuration from ${m[1]}.`)} }`], exemptFiles: m[1].split(' / ').map((g) => `**/${g}`), note: 'core rule `no-restricted-properties`, off for the configuration module' };
  }
  if (r.id === 'layout.route-handlers-wrapped') {
    const m = /wrapped in (\w+)\(/.exec(r.statement);
    const w = m ? m[1] : 'the wrapper';
    return { rule: 'no-restricted-syntax', options: [`{ selector: ${s('CallExpression[callee.property.name=/^(get|post|put|patch|delete)$/] > :matches(ArrowFunctionExpression, FunctionExpression)[async=true]:last-child')}, message: ${s(`Wrap the route handler in ${w}(...).`)} }`], note: 'core rule `no-restricted-syntax` with an AST selector' };
  }
  if (r.id === 'layout.named-exports-named') return { rule: 'no-restricted-syntax', options: [`{ selector: ${s('ExportDefaultDeclaration')}, message: ${s('Use named exports.')} }`], exemptFiles: ['**/*.config.*'], note: 'core rule `no-restricted-syntax`; tool config files keep their default export' };
  return null;
}

/** Flat-config objects for a set of equivalents: one object with every rule, then one per exemption. */
function eslintObjects(eqs: EslintEq[], s: (x: string) => string): string[] {
  const byRule = new Map<string, string[]>();
  for (const e of eqs) byRule.set(e.rule, [...(byRule.get(e.rule) ?? []), ...e.options]);
  const key = (r: string) => (/^[a-z]+$/.test(r) ? r : s(r));
  const rules = [...byRule.entries()].map(([rule, opts]) => `      ${key(rule)}: [${[s('error'), ...opts].join(', ')}],`);
  const out = [`{\n    files: [${s('**/*.{ts,tsx,js,mjs,cjs}')}],\n    rules: {\n${rules.join('\n')}\n    },\n  }`];
  const exempt = new Map<string, Set<string>>();
  for (const e of eqs) for (const g of e.exemptFiles ?? []) exempt.set(g, new Set([...(exempt.get(g) ?? []), e.rule]));
  for (const [glob, rs] of exempt) out.push(`{\n    files: [${s(glob)}],\n    rules: { ${[...rs].map((r) => `${key(r)}: ${s('off')}`).join(', ')} },\n  }`);
  return out;
}

/** Insert config objects before the closing bracket of a flat config's export. */
function addToFlatConfig(text: string, objects: string[]): string | null {
  const m = /export\s+default\s+(?:[\w.]+\s*\(|\[)/.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBracket(text, open);
  if (close < 0) return null;
  let insertAt = close;
  while (insertAt > 0 && /\s/.test(text[insertAt - 1])) insertAt--;
  const needsComma = text[insertAt - 1] !== ',' && text[insertAt - 1] !== '(' && text[insertAt - 1] !== '[';
  const block = objects.map((o) => `  ${o},`).join('\n');
  return text.slice(0, insertAt) + (needsComma ? ',' : '') + '\n' + block + '\n' + text.slice(insertAt).replace(/^\s*/, '');
}

const CONVENTIONAL_RE = '^(feat|fix|chore|docs|style|refactor|perf|test|tests|build|ci|revert)(\\([a-z0-9./ -]+\\))?!?: .+$';

/** Build (not write) the proposals for one repository. */
export function buildProposals(repo: InvRepo, ledger: Ledger, findings: DiscoverFinding[]): Proposal[] {
  const out: Array<Omit<Proposal, 'n'>> = [];
  const q = quoteOf(ledger, repo.id);
  const eslintFile = (repo.configs.eslint ?? []).find((f) => !f.includes('/') && /^eslint\.config\./.test(f)) ?? (repo.configs.eslint ?? [])[0];
  const eslintText = eslintFile ? read(repo, eslintFile) : null;

  // 1. Declared but not followed: raise to error with a baseline (or drop the rule).
  for (const f of findings.filter((x) => x.kind === 'declared-but-not-followed' && (x.scope.includes('*') || x.scope.includes(repo.id)))) {
    const src = (f.sources ?? []).find((s) => s.startsWith(`eslint:${repo.relPath === '.' ? '' : repo.relPath + '/'}`));
    if (!src || !eslintText || !eslintFile) continue;
    const lm = /#L(\d+)$/.exec(src);
    if (!lm) continue;
    const lines = eslintText.split('\n');
    const idx = Number(lm[1]) - 1;
    // The severity may sit on the declaring line or the next one (multi-line array).
    let changed = false;
    for (let k = idx; k < Math.min(lines.length, idx + 3) && !changed; k++) {
      const nl = lines[k].replace(/(['"])warn\1/, '$1error$1');
      if (nl !== lines[k]) {
        lines[k] = nl;
        changed = true;
      }
    }
    if (!changed) continue;
    const after = lines.join('\n');
    const c = f.counts;
    out.push({
      slug: `enforce-${f.id.replace(/^declared-not-followed\./, '')}`,
      kind: 'eslint-baseline',
      title: 'Enforce a rule that is declared but not followed, with a baseline',
      file: eslintFile,
      records: [f.id],
      diff: unifiedDiff(eslintFile, eslintText, after),
      writeup: [
        `The ESLint config declares this rule at warn level, but the code follows it at ${c ? Math.round(c.ratio * 100) : '?'}% of ${c?.sites ?? '?'} sites (${c ? c.sites - c.conforming : '?'} without). A warning nobody acts on teaches agents and people to ignore the rule.`,
        '',
        `Evidence: ${f.message}`,
        f.examples?.length ? `Examples without it: ${f.examples.filter((e) => !e.conforms).map((e) => `${e.file}:${e.line}`).join(', ')}.` : '',
        '',
        'Proposed change (the .diff next to this file): raise the rule to `error`. To keep existing code passing, record today\'s violations as a baseline: with ESLint 9.24 or later run `npx eslint --suppress-all` once and commit `eslint-suppressions.json`; new violations then fail while the old ones are paid down. If the team does not want the rule, delete the line instead; either is better than a warning nobody follows.',
      ].filter((x) => x !== '').join('\n'),
    });
  }

  // 2. Counted-strong conventions with a core-ESLint equivalent and no declared enforcer.
  if (eslintText && eslintFile && /eslint\.config\.[cm]?[jt]s$/.test(eslintFile)) {
    const sq = (x: string) => `${q}${x.split('\\').join('\\\\').split(q).join('\\' + q)}${q}`;
    const eqs: EslintEq[] = [];
    const used: LedgerRecord[] = [];
    const notes: string[] = [];
    for (const r of ledger.records.filter((x) => x.tier === 'counted-strong' && inScope(x, repo.id))) {
      const eq = eslintEquivalent(r, sq);
      if (!eq) continue;
      eqs.push(eq);
      used.push(r);
      notes.push(`- ${r.id}: ${r.statement} Evidence: ${r.evidence.conforming}/${r.evidence.sites} sites. Enforced by ${eq.note}.`);
    }
    const after = eqs.length ? addToFlatConfig(eslintText, eslintObjects(eqs, sq)) : null;
    if (after) {
      out.push({
        slug: 'eslint-rules-for-counted-conventions',
        kind: 'eslint-baseline',
        title: 'Turn conventions the code already follows into ESLint rules',
        file: eslintFile,
        records: used.map((r) => r.id),
        diff: unifiedDiff(eslintFile, eslintText, after),
        writeup: [
          'These conventions hold across the repository by count, but no config enforces them, so a new contributor (or an agent) can break them without any tool noticing. Each maps to a core ESLint rule, so no new dependency is needed.',
          '',
          ...notes,
          '',
          'Existing exceptions, if any, are listed in the ledger; run `npx eslint --suppress-all` (ESLint 9.24+) to baseline them before switching the rules on in CI.',
        ].join('\n'),
      });
    }
  }

  // 3. CI steps: check-like scripts CI does not run; commit-subject check.
  const wf = repo.ci.find((w) => /\.ya?ml$/.test(w.file));
  const wfText = wf ? read(repo, wf.file) : null;
  if (wf && wfText) {
    const root = repo.packages.find((p) => p.dir === '');
    const ran = new Set(wf.scripts);
    const pm = repo.packageManager === 'unknown' ? 'npm' : repo.packageManager;
    const missing = Object.keys(root?.scripts ?? {}).filter((s) => /^(build|typecheck|type-check|lint|format:check|test|check)$/.test(s) && !ran.has(s));
    const lines = wfText.split('\n');
    const lastRun = lines.map((l, i) => (/^\s*-\s+run:/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    const indent = lastRun !== undefined ? /^(\s*)-/.exec(lines[lastRun])![1] : '      ';
    const extra: string[] = [];
    for (const s of missing) extra.push(`${indent}- run: ${s === 'test' ? `${pm} test` : `${pm} run ${s}`}`);
    const subjects = ledger.records.find((r) => r.id.startsWith('naming.commit-subjects-conventional') && r.tier === 'counted-strong' && inScope(r, repo.id));
    const hasCommitlint = !!(repo.configs.commitlint ?? []).length;
    if (subjects && !hasCommitlint) {
      extra.push(
        `${indent}- name: Check commit subjects (Conventional Commits)`,
        `${indent}  if: github.event_name == 'pull_request'`,
        `${indent}  run: |`,
        `${indent}    git fetch --no-tags origin "$GITHUB_BASE_REF"`,
        `${indent}    bad=$(git log --no-merges --format=%s "origin/$GITHUB_BASE_REF..HEAD^2" | grep -Ev '${CONVENTIONAL_RE}' || true)`,
        `${indent}    if [ -n "$bad" ]; then echo "Commit subjects must be type(scope): summary:"; echo "$bad"; exit 1; fi`,
      );
    }
    if (extra.length && lastRun !== undefined) {
      let end = lastRun + 1;
      while (end < lines.length && lines[end].trim() && /^\s+/.test(lines[end]) && !/^\s*-\s/.test(lines[end]) && (lines[end].match(/^\s*/)![0].length > indent.length)) end++;
      const after = [...lines.slice(0, end), ...extra, ...lines.slice(end)].join('\n');
      out.push({
        slug: 'ci-steps',
        kind: 'ci-step',
        title: 'Add CI steps for checks the repository already has',
        file: wf.file,
        records: subjects ? [subjects.id] : [],
        diff: unifiedDiff(wf.file, wfText, after),
        writeup: [
          missing.length ? `CI does not run these scripts, which the repository defines: ${missing.join(', ')}. Running them in CI makes them a gate rather than a habit.` : '',
          subjects && !hasCommitlint
            ? `Commit subjects follow Conventional Commits at ${subjects.evidence.conforming}/${subjects.evidence.sites} commits, but nothing checks them. The proposed step checks the subjects of a pull request's own commits with a plain grep (no new dependency). It assumes actions/checkout runs with \`fetch-depth: 0\` so the branch history is present; adjust if the workflow fetches differently.`
            : '',
        ].filter(Boolean).join('\n\n'),
      });
    }
  }

  // 4. CONTRIBUTING sentences for counted-strong conventions not written down in this repository.
  const contribFile = (repo.configs.contributing ?? []).find((f) => !f.includes('/')) ?? (repo.configs.contributing ?? [])[0] ?? 'CONTRIBUTING.md';
  const contribText = read(repo, contribFile);
  const prefix = repo.relPath === '.' ? '' : repo.relPath + '/';
  const unwritten = ledger.records.filter(
    (r) => r.tier === 'counted-strong' && inScope(r, repo.id) && !r.provenance.some((p) => (p.kind === 'doc' || p.kind === 'agent-file') && p.ref.startsWith(prefix) && /CONTRIBUTING/i.test(p.ref)),
  );
  if (unwritten.length) {
    const section = ['', '## Conventions the code follows', '', ...unwritten.map((r) => `- ${r.statement}`), ''].join('\n');
    const after = (contribText ?? `# Contributing\n`).replace(/\s*$/, '\n') + section;
    out.push({
      slug: 'contributing-conventions',
      kind: 'contributing',
      title: 'Write down the conventions the code already follows',
      file: contribFile,
      records: unwritten.map((r) => r.id),
      diff: unifiedDiff(contribFile, contribText, after),
      writeup: [
        'Each sentence below describes something the whole repository already does, measured by counting every site in the workspace (counts below); none of it is written in this repository\'s CONTRIBUTING, so people and agents learn it only by reading code.',
        '',
        ...unwritten.map((r) => `- ${r.id}: ${r.evidence.conforming}/${r.evidence.sites} sites in ${r.evidence.packages} package(s).`),
      ].join('\n'),
    });
  }
  return out.filter((p) => p.diff).map((p, i) => ({ ...p, n: i + 1 }));
}

export interface ProposeResult {
  repo: { id: string; name: string; path: string };
  dir: string;
  proposals: Array<{ n: number; slug: string; kind: string; title: string; md: string; diff: string; records: string[] }>;
}

/** Write the proposals for one repository; returns what was written. */
export function proposeForTeam(ref: string): ProposeResult | { error: string } {
  const dir = ledgerDir();
  const ledger = readJsonOr<Ledger | null>(path.join(dir, 'ledger.json'), null);
  const inv = readJsonOr<{ repos?: InvRepo[] } | null>(path.join(dir, 'inventory.json'), null);
  const fnd = readJsonOr<{ findings?: DiscoverFinding[] } | null>(path.join(dir, 'findings.json'), null);
  if (!ledger || !inv?.repos) return { error: `no ledger yet (${dir}); run \`harness discover\` first` };
  const repo = resolveRepo(ref, inv.repos);
  if (!repo) return { error: `'${ref}' is not a repository of the last discovery (${inv.repos.map((r) => r.name).join(', ')})` };
  const props = buildProposals(repo, ledger, fnd?.findings ?? []);
  const out = proposalsDir(repo.id);
  ensureDir(out);
  for (const f of fs.readdirSync(out)) if (/^\d+-.*\.(md|diff)$/.test(f)) fs.rmSync(path.join(out, f), { force: true });
  const written: ProposeResult['proposals'] = [];
  for (const p of props) {
    const base = `${p.n}-${p.slug}`;
    const md = path.join(out, `${base}.md`);
    const diff = path.join(out, `${base}.diff`);
    writeTextAtomic(diff, p.diff);
    writeTextAtomic(
      md,
      [
        `# ${p.title}`,
        '',
        `Repository: ${repo.name} · file: \`${p.file}\` · kind: ${p.kind} · from ledger records: ${p.records.join(', ') || 'none'}`,
        '',
        p.writeup,
        '',
        '## How to use it',
        '',
        `Review \`${base}.diff\`, then in the repository: \`git apply ${diff}\` on a branch and open a pull request through the team's normal process. The harness never applies team proposals and never pushes.`,
        '',
      ].join('\n'),
    );
    written.push({ n: p.n, slug: p.slug, kind: p.kind, title: p.title, md, diff, records: p.records });
  }
  return { repo: { id: repo.id, name: repo.name, path: repo.path }, dir: out, proposals: written };
}
