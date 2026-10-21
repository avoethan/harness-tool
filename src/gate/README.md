# The done-gate (`src/gate/`, `harness gate`)

The gate decides whether a piece of agent work is done. It runs the
repository's own checks plus the harness's checks, cheapest first, writes
`evidence.json` for the Stop hook and the write-up, and prints a
plain-language report with what to do next. Tests the agent did not write
and a tamper diff are the evidenced part (R-01..R-03, R-05); the acceptance
checks proven red first (R-18) and the BLOCKED outcome (R-06) are bets that
the instrumentation measures.

## Command

```
harness gate [--task <id>] [--repo <path>] [--base <sha>] [--steps a,b,c] [--json] [--no-cache]
harness gate --hook pre-commit|pre-push|ci
harness gate --blocked "<reason>"
harness gate prove-red [--task <id>] [--repo <path>] [--base <sha>] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | PASS (or a `--steps` run with no failure; prove-red: every check as expected: red-first checks red, green-at-base checks green) |
| 1 | FAIL (prove-red: some check not as expected) |
| 2 | usage error, not a git repository, unknown `--steps` name; prove-red with nothing to prove |
| 4 | BLOCKED (recorded with the stated reason) |

- **prove-red and green-at-base criteria.** `prove-red` runs each unit-kind
  acceptance test at the base commit (a temporary checkout; your tree is not
  touched). A red-first check must fail there (`RED`). A check marked
  `greenAtBase` by intake (characterisation, "no behaviour change", "existing
  tests still pass", documentation, README text already present) is expected
  to pass there: a green result prints `BASE`, is recorded as
  `redProof.result = 'green'`, and does not fail the command. A green-at-base
  test that fails at the base commit is noted, not failed (the acceptance step
  never needs the proof); a test that is missing or could not run still fails.
  The summary line says how many checks were proven red and how many are
  green-at-base. In `--json` the result carries `greenAtBase: true`.
- **The `acceptance:<id>` step** for a green-at-base check asks only that a
  test file in the repository names `"<id>: ..."` (the same scan prove-red
  uses; without one the step fails with "no test names <id>", even when the
  runner prints no counts), and that it ran and passes on the current tree; the
  pass line says `green-at-base: <reason>`. The `e2e:<id>` step is unchanged.
- **Gate-proved criteria.** A check of kind `gate` (intake writes it for "the
  checks still pass", "nothing else changes", "the history is kept") has no
  test. `prove-red` prints `GATE  <id>  proved by the gate's own steps (...)`
  for it, runs nothing at the base commit and does not fail; `--json` lists
  them under `gate`. Its `acceptance:<id>` step runs after every other step and
  reads this run: every step in `gateSteps` passed (`cached` counts; a step
  skipped because the repository has no such script or config counts as passed
  and is named in the pass line; any other skip, a failure, or a step that did
  not run does not count); every path changed against the base commit, working
  tree and untracked files included (`ctx.diff`, renames by both names), is a
  `scopePaths` entry or inside one; and, for `keepsHistory`, `git merge-base
  --is-ancestor <base> HEAD` succeeds. It runs no repository code. In a
  partial `--steps` run, where a named step was not run, the check is skipped.
- **Repository**: `--repo` or the working directory, resolved the way the
  hooks resolve it (walk up to `.git`), so the repo id matches the Stop hook's.
- **Task**: `--task`; else `hook-<name>` in hook mode; else
  `~/.harness/runs/<repoId>/current-task` (set by `harness intake` and
  `harness task claim`); else `adhoc`.
- **Base commit**: `--base`; else the brief's `baseShas[repoId]` (HEAD at
  intake); else the base of this task's previous gate run; else HEAD (first
  run). Hook modes: pre-commit uses HEAD and checks the *staged* tree;
  pre-push and ci use `--base`, else the merge-base with `origin/$GITHUB_BASE_REF`
  (ci), the upstream branch, the default branch, else `HEAD^`.
- **Configuration** comes from the machine config and the repository's
  `.harness/config.json` *as it was at the base commit*; lint/test/build
  commands come from `package.json` at the base commit (`git show
  <base>:package.json`). The working tree never configures the gate that
  checks it.
- **`--steps`** takes step names, kinds (`acceptance`), groups (`tests`
  covers `tests:base` and every `acceptance:*`; `build` covers build,
  typecheck and lint) or DESIGN numbers (`1`..`9`). A partial run prints and
  caches results but writes **no verdict**, so it can never stand in for a PASS.

## Steps (in the order they run)

| Step | DESIGN §2.5 | What FAILs it | Skipped when |
|---|---|---|---|
| `tamper` | 1 | a test file deleted or renamed; `.only`/`.skip`/`.todo`/`xit`/`xfail`/`{ skip: true }` added; the assertion count (`expect(`, `assert…(`, `should`) of a touched test file dropped; a protected file changed (CI, git hooks, lint/format/type-check/test-runner config, golden/snapshot files, harness files) or a gate-relevant `package.json` script or config key changed, unless allowed (below); test files changed while the task never entered the tests phase, or edited after the switch back to `implement` (file time vs `phase.json`) | never |
| `secrets` | 2 | secret-shaped text (`src/lib/redact` patterns) in lines the change adds; a key or `.env` file added (`.env.example` and friends are content-scanned only); secret-shaped text in the evidence folder. The pattern and file are named, never the value | never |
| `map-drift` | 7 | a route registered in a changed source file, or an added/changed migration, has no entry in the feature-map overlay; the exact ids are listed | no feature map yet for the repository |
| `e2e:<id>` | 8 | no `<id>-http` / `<id>-db` artefact for an api/db criterion, or one from an older tree, or one that records a failed check; a check whose command has `--db-unreachable` counts only artefacts with `dbUnreachable: true` ("needs an artefact from a `--db-unreachable` launch") | the brief has no api or db checks |
| `standards` | 4 | a block-mode ledger record is violated in a changed file or in a commit subject since the base (`declared` and `counted-strong` tiers block; other tiers warn and are listed as `warn:`). Each line: rule id, file:line, statement, fix | no ledger yet |
| `lint` | 3 | ESLint errors and Prettier `--check` failures in the changed files (the repository's own binaries and config); else the base commit's `lint` script | no linter configured |
| `typecheck` | 3 | `tsc -b` (project references) or `tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile ~/.harness/cache/<repoId>/tsbuildinfo`; the `typecheck` script when there is no tsconfig.json | no tsconfig.json and no typecheck script |
| `build` | 3 | the base commit's `build` script fails | no build script |
| `tests:base` | 5 | the base commit's `test` script fails on the test files that exist at the base (restricted to them for vitest and jest; the whole suite otherwise, said in the report) | no test script |
| `acceptance:<id>` | 5 | a unit-kind criterion's test (named `"<id>: ..."`) was never proven red at this base commit, passed at the base, is missing, or fails now; a gate-proved criterion (`check.kind === 'gate'`) has no test: its named steps passed in this run, the change stays inside `scopePaths`, and the base commit is still an ancestor of HEAD; a green-at-base criterion (`check.greenAtBase`) needs only a test that exists and passes now | no brief, or no unit-kind criteria |
| `coverage` | 6 | changed-line coverage (Istanbul `coverage/coverage-final.json`) below the base's line coverage | no `coverage`/`test:coverage`/`test:cov`/`cov` script |
| `affected` | 9 | the affected packages' `test`/`lint` scripts fail (nx affected, turbo `--filter=...[base]`, or workspace packages holding changes plus their dependents) | single-package repository |

Rules that hold across steps:

- A tool the repository **declares** (in `package.json` at the base) but has
  not installed is a FAIL, not a skip: removing `node_modules` cannot turn
  checks off. A tool that is neither declared nor configured is a skip with
  the reason.
- When `build` fails, the test, coverage and affected steps are skipped with
  "not run: build failed".
- Scripts run as argv arrays: a simple script body is tokenised and its
  binary resolved inside the repository and run with the current Node; a
  body with shell operators runs through the package manager only when the
  working tree's script is byte-identical to the base commit's. Nothing is
  installed. `NODE_TEST_CONTEXT` is removed from the environment so a gate
  started from inside a test runner does not hijack the repository's runner.
- The tree is hashed again after the steps; if it changed while the gate ran
  (a step wrote an unignored file, or someone edited), the verdict is FAIL
  with the paths.

**Allowed protected paths**: a unit path of the brief that itself names a
protected file or folder (a ticket naming `.github/workflows/ci.yml`; a
ticket naming `src/` does not open the snapshots under it), the brief's
explicit `allowedPaths`, and `gate.allowedPaths` in the config at the base
commit.

## Verdicts, attempts and the cap

- **PASS** when every step that ran passed (skips are listed with reasons).
- **FAIL(reasons)**: every failing step's reasons, prefixed with the step name.
- **BLOCKED(reason)**: `harness gate --blocked "<reason>"`. A legitimate
  outcome; the tamper and secret steps still run and their findings are
  recorded. Exit 4.
- `attempt` increments on every full run of the task. The per-session cap is
  kept by the Stop hook (`caps.gateAttempts`, default 8): when it releases an
  agent it sets `cap_reached` in evidence.json (or writes `cap.json` when the
  gate never ran). The gate carries the marker over, still runs every step so
  the agent sees why, and **never reports PASS** for that task; the write-up
  (`src/intake/writeup.ts`) refuses to cite PASS too.
- **Write-up.** Every full run (PASS, FAIL or BLOCKED, including
  `--blocked`) ends by writing the task's `writeup.md` through the write-up
  module (`src/intake/writeup.ts`, via `src/gate/writeup.ts`) and prints
  `Write-up: <path>` as the last line (with `--json`, the path is the field
  `writeupPath` and stdout stays JSON). A BLOCKED write-up carries the blocked
  reason in its Verification section. A partial `--steps` run, and the
  `--hook` modes, write none. A task with no brief (`adhoc`) gets one line,
  `Write-up: none (this task has no brief ...)`, instead. A write-up that
  cannot be written never changes the exit code.

## Files

```
~/.harness/runs/<repoId>/<task>/evidence.json     EvidenceFile (src/types.ts)
~/.harness/runs/<repoId>/<task>/gate-cache.json   { version, entries: { <step>: { key, status, reasons, durationMs, at } } }
~/.harness/runs/<repoId>/<task>/e2e/*.json        E2E artefacts (written by harness verify; read here)
~/.harness/cache/<repoId>/tsbuildinfo             incremental typecheck state (nothing written in the repository)
~/.harness/cache/<repoId>/coverage-base-<sha>.json  the base commit's line coverage, measured once
~/.harness/featuremap/<repoId>/overlay.json       feature-map overlay (written by harness verify; read here)
```

**Evidence** fields the Stop hook reads: `verdict`, `treeHash` (`git
write-tree` of the working tree through a temporary index, identical to the
hash the Stop hook computes; the staged tree in pre-commit mode), `reasons`,
`attempt`, `cap_reached`. Also: `repo`, `task`, `baseSha`, `steps[]` (`name`,
`status` pass|fail|skip|cached, `durationMs`, `reasons`, `cacheKey`, `cache`
hit|miss|off), `startedAt`, `finishedAt`, `e2e[]` (`id`, `kind`, `path`
relative to the run folder, `treeHash`, `createdAt`), `phase`, `sessionId`
(`--session` or `HARNESS_SESSION_ID`).

**Cache**: a step's key hashes the step name, the base commit, the gate's
config and code version, and the blobs of the inputs that step reads (a
subset of the tree: tamper reads the touched tests and protected files;
secrets, lint, standards and map-drift the changed files; build, typecheck,
tests, coverage and affected the whole tree). Passing results are reused;
failures are reused only for the deterministic file checks, never for
steps that run the repository's commands.

## Interfaces with other components

- **Intake** (`src/intake`): the brief (`~/.harness/briefs/<id>.json`)
  gives the criteria, units, `baseShas` and optional `allowedPaths`;
  `phase.json` gives the phase. `prove-red` writes `check.redFirst` and
  `check.redProof` (`{ baseSha, at, result: red|green|missing|error, files,
  exitCode }`) into the brief; a green-at-base check keeps `greenAtBase`,
  `greenAtBaseReason` and its `redFirst: false` and only gets the proof. Step names carry the criterion id as a word
  (`acceptance:AC1`, `e2e:AC2`) so the write-up links criteria to steps.
- **Verify** (owns the files; the gate only reads them):
  - E2E artefacts `runs/<repoId>/<task>/e2e/<criterionId>-http.json` and
    `-db.json`: `{ version: 1, id, kind: http|db|browser, criterion?,
    treeHash, createdAt, pass }`. Counted when `treeHash` equals the tree
    the gate checks and `pass` (or `ok`) is not false.
  - Feature-map overlay `featuremap/<repoId>/overlay.json`: `{ version: 1,
    entries: { "<id>": { file? } } }` (also `routes`/`migrations` maps or
    arrays of `{ id }`). Route ids are `"<METHOD> <path>"` (a router's mount
    prefix may be part of the overlay path); migration ids are the file name
    without extension.
- **Discover**: the ledger and `runLedgerChecksDetailed` /
  `checkCommitSubjects` from `src/discover/checks.ts`.
- **Hooks**: the Stop hook runs nothing; it reads evidence.json (see above)
  and tells the agent to run `harness gate --repo <path>`.

## Git hooks and CI (personal setting)

The same gate runs outside the agent, so it holds when agent hooks are
bypassed:

```sh
# .git/hooks/pre-commit (or the husky/lefthook equivalent)
harness gate --hook pre-commit      # tamper, secrets, standards, lint, typecheck, build on the staged tree
# .git/hooks/pre-push
harness gate --hook pre-push        # every step, base = merge-base with the upstream
# CI job step
harness gate --hook ci --base "$BASE_SHA"
```

Each writes its own evidence under `runs/<repoId>/hook-<name>/` and exits
non-zero on FAIL, so git and CI stop.

Before any step, `--hook pre-push` reads the refs git hands the hook on
standard input (`<local ref> <local sha> <remote ref> <remote sha>`,
`prepush.ts`) and refuses the push when a line deletes a remote ref or
replaces a remote commit that is not an ancestor of the pushed one (a
forced, non-fast-forward update; a remote commit this clone does not have
is refused too, since it cannot be shown to be a fast-forward). This is the
no-history-rewrite rail for processes the guard does not see. A push that
skips hooks (`--no-verify`, `core.hooksPath`) is denied by the guard.

The harness's own install is not tampering: a protected file whose change in
the checked range came from the personal apply commit (its sha is in the plan
record under `~/.harness/backups/`, where an agent cannot write) and that is
byte-identical to that commit's version passes the tamper step, so the first
push after an install goes through the pre-push hook. A later change to the
same file is a finding again, and a commit that only looks like an apply
commit is not exempt. The apply commit's subject follows the repository's
commit-subject standard (`chore(harness): apply <plan>` under Conventional
Commits). CI on a hosted runner has no `~/.harness`: its full-gate mode
(`HARNESS_TOOL_REPO` set) reports the apply commit on the first push after an
install.

## A real run

Recorded on the team stand-in workspace (orders-api, installed; ledger from
`harness discover` on the workspace), with trap T06's naive fix (a pasted
snippet bringing `as any` and `!=`). Paths shortened to `~/.harness`.

```
$ harness gate --task t-status-filter        # exit 1, 7100 ms wall (cold)
harness gate: orders-api, task t-status-filter
Base 35765ddd22 (HEAD (first gate run of this task)); tree ea47e61e6f; attempt 1 (attempt cap 8)

  PASS  tamper      5 ms     1 changed file(s), 0 test file(s); nothing deleted, skipped, weakened or protected was touched
  PASS  secrets     7 ms     1 changed file(s) and 0 evidence file(s) scanned; no secret-shaped text
  skip  map-drift   5 ms     no feature map yet for this repository (no overlay: `harness verify maintain --add-missing` writes its skeleton entries; `verify launch` does not); route and migration changes were not checked against it
  skip  e2e                  no brief for this task, so no api or db checks
  FAIL  standards   122 ms
                             - lint.no-explicit-any at src/routes/orders.ts:48: No explicit `any`: annotations, assertions and type arguments use `unknown` or a precise type. Fix: Replace `any` with `unknown` and narrow it, or with the precise type (an interface, a union, a generic parameter).
                             - lint.no-explicit-any at src/routes/orders.ts:49: ...
                             - lint.eqeqeq at src/routes/orders.ts:49: Compare with === and !==, never == or !=. Fix: Replace == with === and != with !==; to accept null and undefined together write `x === null || x === undefined`.
                             - warn: validation.request-input at src/routes/orders.ts:48: Request input (req.body, req.params, req.query) is passed through a validator or parser before use, never cast with `as`. Fix: ...
                             - 5 record(s) not checked here (not file-scoped; ...)
  FAIL  lint        1.3 s
                             - src/routes/orders.ts:48 @typescript-eslint/no-explicit-any: Unexpected any. Specify a different type.
                             - src/routes/orders.ts:49 @typescript-eslint/no-explicit-any: Unexpected any. Specify a different type.
                             - src/routes/orders.ts:49 eqeqeq: Expected '!==' and instead saw '!='.
  PASS  typecheck   1.7 s    tsc --noEmit --incremental (build info kept under the harness cache): no errors (1679 ms)
  PASS  build       1.2 s    ran `tsc -p tsconfig.build.json` (1155 ms)
  PASS  tests:base  2.7 s    `vitest run` on the whole suite: 37 passed, 0 skipped
  skip  acceptance           no brief for this task (run `harness intake` or `harness task claim` to get acceptance checks)
  skip  coverage    1 ms     no coverage output configured (no coverage / test:coverage / test:cov / cov script at the base commit)
  skip  affected    1 ms     single-package repository (no nx, turbo or workspaces); the earlier steps covered it

Verdict: FAIL. 12 step(s): 5 passed, 2 failed, 5 skipped.

What to do next:
  - standards: Change the code to follow each listed rule; the fix text says how. These are the codebase's own standards with evidence.
  - lint: Fix the lint and format problems in the files you changed (the repository's own ESLint and Prettier).
  Then run `harness gate` again (unchanged steps come from the cache). If the work cannot pass, run `harness gate --blocked "<reason>"`.

Evidence: ~/.harness/runs/orders-api-a4a0fe/t-status-filter/evidence.json
```

Running it again without a change took 224 ms wall: every step except the
skips came from the cache. The acceptance test (`test/acceptance/gate.test.ts`)
records the full numbers on the stand-in.

## Limits

- The tests-phase rule compares file modification times with the phase
  switch in `phase.json`; a checkout or stash that rewrites test files during
  the implement phase looks like an edit.
- pre-commit runs ESLint, Prettier and the ledger checks on the files on
  disk; a partially staged file is checked as it is in the working tree.
- Route ids are read with a registration pattern (`router.get('/x', ...)`,
  `app.post(...)`, `@app.get("/x")`); routes built dynamically are not seen.
- Changed-line coverage needs Istanbul JSON from a repository script; other
  coverage formats are reported as a skip.
- Restricting the base tests to the base commit's test files works for
  vitest and jest (file filters); other runners run the whole suite and the
  report says so.
