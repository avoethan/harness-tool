# discover

`harness discover` works out a workspace's standards with evidence and writes
the standards ledger. It is read-only for the workspace: it reads files, runs
`git ls-files` and `git log`, and (unless `--no-exec`) the repositories' own
`eslint --print-config`, `tsc --showConfig`, dependency-cruiser and knip from
their `node_modules`. It never installs anything and never runs repository
code from a hook.

## Pipeline (`index.ts` `runDiscover`)

| step | module | what |
| --- | --- | --- |
| 1 inventory | `inventory.ts` | repositories (every folder with `.git` up to four levels below the root, or the root itself), npm/pnpm/yarn workspace packages, package managers and scripts, every config by its documented name (ESLint, Prettier, Biome, EditorConfig, tsconfig chains, vitest/jest/mocha/playwright, commitlint, husky, lint-staged, CI workflows, CONTRIBUTING, READMEs, PR templates, CODEOWNERS, ADRs, agent files, SQL tooling, MCP configs, OpenAPI, dependency-cruiser, knip, docker-compose, `.env*`), files from `git ls-files -co --exclude-standard`; files over 1 MB, minified or binary are skipped and listed; `--max-files` stops counting and lists the rest |
| 2 declared | `declared.ts` | ESLint rules and their `files` overrides read from the config text; Prettier, Biome, EditorConfig, tsconfig (`strict`), test-runner `include` globs, commitlint presets, hooks, CI scripts; the `lint.rules` and `fmt` sections of `vite.config.*` / `vitest.config.*` (Vite+ keeps its linter and formatter settings there) read like an ESLint and a Prettier config, with their severities (oxlint-style `typescript/...` rule names map to `@typescript-eslint/...`); effective config for sampled files (3 per package: a source module, a test file, another source module) with the repo's own `eslint --print-config` and `tsc --showConfig` |
| 3 history | `history.ts` | last 2,000 commit subjects per repo (merges excluded), conventional share, types, scopes, lengths, revert and lint-fix counts, CODEOWNERS, review clusters saved by `harness reviews fetch` |
| 4 graph | `graph.ts` | dependency-cruiser (rules from the repo's config; counts and a baseline of violations) and knip, when installed in the repo |
| 5 probes | `probes.ts`, `astgrep.ts`, `scan.ts`, `builtins.ts` | the probe library (`probes/`, ~60 probes) over every file: one `ast-grep scan --json=stream` per repo with all compiled rules, regex probes and built-ins in process; tallies per variant, repo and package, with examples both ways; route probes (`api.route-path-case`, `layout.route-handlers-wrapped`) skip test files, example, demo, docs and fixture folders; probes of the `sql` family run only when the workspace has SQL (`domains.ts`: a `.sql` file, a SQL client or ORM dependency or import, or a SQL statement literal in a non-test file), otherwise the report says "sql probes skipped: no SQL in the repository" (finding kind `probes-skipped`) |
| 6 tiers | `tiers.ts`, `prose.ts` | records, findings, conflicts (below) |
| 7 emit | `emit.ts`, `checks.ts`, `dbcandidates.ts` | `~/.harness/ledger/`: `ledger.json`, `checks/<id>.json` (+ `<id>.yml` for ast-grep), `findings.json`, `db-candidates.json`, `inventory.json`, `discover.md` |
| 8 judgment | `judgment.ts` | `--judgment` bundle; `--import-judgment <id>` |

## Tiers and thresholds

- **declared**: every repository in the record's scope declares it (an
  explicit ESLint rule at error or warn, a formatter option, test-runner
  include globs that cover every test file, a commitlint preset, a CI step)
  and the code follows it at 80% or more. Below 80% it is a
  *declared-but-not-followed* finding with the measured share and examples,
  never a standard. A preset that merely turns on a community default (for
  example `no-var` from a recommended config) is not a team decision and does
  not make a declared record.
- **counted-strong**: at least 95% conforming, at least S sites and P
  packages; or a written rule (CONTRIBUTING, PR template, ADR, README, agent
  file) that the code follows at 100% over at least 3 sites.
- **counted-majority**: at least 80% conforming over at least M sites.
- **review-derived**: a review cluster with at least 3 accepted comments over
  2 PRs and 2 reviewers, or one accepted from a code owner; judgment check.
- **single-source**: a normative sentence (never, must, always, only, do not)
  in CONTRIBUTING, a PR template or an ADR that no count proves; judgment
  check, never blocking. Text matching injection patterns is rejected. Not
  rules: a glossary entry (`**chore**: Other changes that don't ...`), a
  sentence whose normative word only sits in a relative clause ("changes that
  do not affect ...", "dependencies that are required"), "you don't want to".

Reassurance ("don't worry"), forecast ("may not be accepted", "will be",
"is likely", "you may") and dangling-referent sentences ("install both", "do
this", "use it" with nothing in the sentence to point at) are not single-source
records either; a forecast sentence that also carries a real obligation ("you
may use X, but it must never ...") stays one.

A rule the repository's lint config declares at `warn` is never promoted to a
blocking tier by a probe hit: the record is warn-mode (`check.mode: warn`)
only when every unit that declares the rule declares `warn`, whatever its
tier. The declared severity is resolved per unit the way ESLint does it:
entries in source order, the last matching one wins, and an extension-wide
override (`**/*.ts`, `*.{ts,tsx}`) applies only to files it matches (the file
extensions come from the probe's counted sites). When one group mixes units
that declare `warn` with units that declare `error`, the record keeps `block`
(option chosen: keep `block` and name the warn units in the statement, for
example "(The lint config declares it as a warning, not an error, in app.)",
plus a provenance line); it is not split into one record per severity.

A probe whose ESLint rule the repository's own config turns `off` (for all
files, at the root or in the unit's package) makes no standard there, however
high its count; it is reported as a finding with the counts. ESLint-only and
`types.strict` records take the scope of the configs that declare them: a
config inside a package folder covers that package (`paths`), not the whole
repository.

Thresholds scale with the estate (F = source files counted, P = packages):
F >= 10,000 uses RESEARCH 2.3 as written (S = 100, P = min(3, packages), M =
30). Below that S = clamp(ceil(F/100), 10, 100), M = clamp(ceil(F/333), 5,
30) and P = min(2, packages); the rule in use is printed by the command and in
`discover.md`. Confidence is the Wilson lower bound (95%) of the conformance.

Imports and accessor reads (the driver gateway, `process.env`) are read from
code only: comments and template-literal text are masked first, so a JSDoc
"defaults to `require("mssql")`" or a code generator's template is not an
import, and a package of the workspace itself is never a driver. A single
accessor must be at least half of the modules in its package that read it
(one stray reader at most); with more readers the package has none.

Not standards: community defaults followed without a config (camelCase
functions, `await` rather than `.then`, LF endings ...), hygiene probes
(`.only`, empty catch, thrown literals, suppression comments: reported as
findings when they occur), informational probes (mocking library, folder
histogram), and variants that too few sites distinguish (folder names that
are all one word).

Conflicts are never averaged: each repository (or package, when a repository
is itself split while its packages are consistent) is a unit; units that
follow different variants become separate records, each listing the others
under `conflicts` with both counts. Scopes: `['*']` for the whole workspace,
repository ids, and `paths` globs; when a record mixes whole repositories
with packages of another, the package globs are repository-qualified
(`<repoId>:<glob>`). `recordAppliesTo(record, repoId, rel)` in `checks.ts`
interprets scopes for every consumer.

Formatter-owned options (semicolons, trailing commas, indentation, line
endings, final newline) are folded into one `format.formatter` record when
Prettier or Biome is configured; quote style keeps its own records because
repositories disagree on it.

Record ids are `<family>.<slug>` from the probe (`-<variant>` for `either`
probes, `-<driver>` for the driver gateway); the same convention keeps the
same id across runs, and `history.firstSeen` is carried over.

## Checks and the runner

Every record gets `checks/<id>.json`:

```ts
{ version: 1, id, engine: 'ast-grep' | 'regex' | 'builtin' | 'eslint' | 'config' | 'judgment' | 'subjects',
  mode, statement, fixText, scope, files?, exclude?,
  rules?,                       // ast-grep: the violating variants' rules (also written as <id>.yml)
  target?, conform?, violate?, flags?,  // regex: basename | dirname | content | match
  builtin?, data?,              // built-in check and its data (gateway paths, test root, exemptions)
  eslint?: { rule, fragment },  // the ESLint rule the record stands for
  baseline?,                    // `<workspace-relative file>::<snippet>` of violations that existed at discovery
  note? }
```

`runLedgerChecks(ledger, files, { mode })` (and `runLedgerChecksDetailed`,
which also lists what it checked and skipped) maps each file to its
repository, keeps the records whose scope covers it, and runs regex and
built-in checks in process and all ast-grep checks in one `ast-grep scan` over
the given files. Existing violations in the baseline are not reported.
ESLint-only records run the repository's own ESLint only with `eslint: true`
(the gate); config and judgment records are listed as skipped with the
reason. `checkCommitSubjects(ledger, subjects)` checks commit subjects.

## Judgment pass

`--judgment` writes `~/.harness/judgment/<id>/bundle.json` (escaped excerpts:
per package max(4, 24/packages) files, one per src/ folder in turn, 40 lines
each; up to 2 excerpts per package around sites that break a dominant
variant; at most 60; the 25 largest variant clusters; the most frequent call
names; the standards already found) and `prompt.md`. The agent may not write in `~/.harness` (the self-protection rail denies its file tools there), so it writes its answer outside every repository and hands it over with `harness judgment submit <id> --from <file>` (or `--from -` on standard input; `src/commands/judgment.ts`), which checks the id names an existing bundle, the size (1 MiB), JSON with `version: 1` and no hidden Unicode, and saves it as `result.json`; the full validation stays with the import. A discovery result already imported is never replaced. `--import-judgment <id>` rejects the file on hidden Unicode,
drops candidates whose text matches injection patterns or whose own
valid/invalid examples fail, compiles the rest to probes and counts them with
everything else. Candidates that reach a counted tier enter the ledger with
`judgment` provenance; the rest are `judgment-unproven` findings. Imported
results are listed in `~/.harness/judgment/imported.json` and re-validated and
re-counted on every later run; delete an id there to drop its candidates.

## Reviews

When `~/.harness/reviews/<repoId>.json` exists (written by `harness reviews
fetch`), discovery reads `{ clusters: [{ id, summary, comments, prs,
reviewers, accepted, codeOwner?, probe?, family?, examples? }] }`, or raw `{
comments: [{ body, pr, author, accepted?, codeOwner? }] }` grouped by their
first sentence. A cluster naming a probe that produced a record adds review
provenance to it.

## Team proposals

`harness propose --for-team <repo>` (`proposals.ts`) writes
`~/.harness/proposals/<repoId>/<n>-<slug>.md` and `.diff`: raise a
declared-but-not-followed ESLint rule to error with a baseline
(`eslint --suppress-all`), core-ESLint equivalents of counted conventions,
CI steps for check scripts CI does not run and for commit subjects, and
CONTRIBUTING sentences for counted conventions nobody wrote down. Never
applied; conflicts between repositories never produce an "align" proposal.

## Database candidates

`dbcandidates.ts` reads host, port and database keys from `.env*` files,
connection strings (URL and `Server=...;Database=...` forms) in app configs
and code, and database images with published ports in docker-compose files.
User names and passwords are never kept; the result is re-scanned for secrets
before it is written.
