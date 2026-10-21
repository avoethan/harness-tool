# Acceptance tests

These tests drive the built CLI end to end. They are slower than the unit
tests, may need tools beyond Node (git, Docker, a SQL Server), and **skip with
a printed reason** when something they need is missing. Run them with
`npm test` (unit + acceptance) or one file at a time:

```sh
npm run build
node --test dist/test/acceptance/discover.test.js
```

## discover.test.ts: discovery graded on stand-in workspaces

The test runs `harness discover` on stand-in workspaces whose standards are
planted and known, and grades the ledger against the stand-in's own expected
ledger. The stand-ins are not part of this tool; point the test at them with
environment variables (each case skips when its variable is unset):

| Variable | Meaning |
| --- | --- |
| `HARNESS_STANDIN_TEAM` | Folder of a multi-repository stand-in: it holds `setup.js` (`node setup.js <dest> [--no-install] [--no-db]` creates the workspace), `standards/planted.json`, `standards/fixtures/<id>/valid.*` and `invalid.*`, and `expected/ledger.json`. |
| `HARNESS_STANDIN_PERSONAL` | The same for a single-repository stand-in. |
| `HARNESS_STANDIN_INSTALL=1` | Let `setup.js` install the repositories' dependencies (slow, needs the npm registry). With it, discovery also resolves the effective ESLint and TypeScript config with each repository's own binaries. Without it, configs are read statically and the report says so. |
| `HARNESS_STANDIN_TEAM_WORKSPACE`, `HARNESS_STANDIN_PERSONAL_WORKSPACE` | Reuse a workspace that `setup.js` already created (skips setup). |
| `HARNESS_ACCEPTANCE_OUT` | Append one JSON line per case with the measured precision and recall. |

`setup.js` always runs with `--no-db`: discovery reads files and git history
and never needs the database.

How a case is graded:

1. **Planted standards.** A ledger record matches a planted standard when the
   check discovery generated for it flags the standard's `invalid` fixture and
   passes its `valid` fixture (the same judgement as the stand-in's own
   checker), and its family, tier (the expected tier or stronger), scope (the
   whole workspace) and evidence site count (at least `minSites`) agree.
   Recall = planted standards matched / planted standards; it must be 1.
2. **Precision** is printed, not asserted: records that match a planted
   standard / all records that are standards (records on either side of a
   conflict excluded), plus the same over the counted and declared tiers only.
   Unmatched records are listed by id so a person can judge them; on a
   realistic codebase most of them are real conventions the stand-in did not
   plant.
3. **Declared but not followed.** The expected finding must appear in
   `findings.json` with the measured share of sites in the expected range, and
   no ledger record may claim that rule as a standard.
4. **Conflicts.** Each side of an expected per-repo conflict must be its own
   record scoped to its repositories; no workspace-wide record may average
   them.
5. **Database candidates.** The local test server and database must be listed;
   no password from any `.env*` file may appear in any output file.
6. **Report and proposals.** `discover.md` must carry its sections; `harness
   propose --for-team` must write proposals whose diffs pass `git apply
   --check` in the repository.

All state goes to a temporary `HARNESS_HOME`; the real home is never touched.

## gate.test.ts: the done-gate on the team stand-in

Needs `HARNESS_STANDIN_TEAM` (skips with the reason when unset). The
workspace comes from `HARNESS_STANDIN_TEAM_WORKSPACE` (an installed
workspace `setup.js` created) or from `setup.js <tmp> --no-db` (with `npm ci`
only when `HARNESS_STANDIN_INSTALL=1`). `--no-db` because the gate never
connects to a database (E2E artefacts come from `harness verify`), so a
database would add state to the shared test container and prove nothing
here. The test runs the real `harness discover` into a temporary home, then
clones a repository per scenario (node_modules linked, never installed):

1. **Traps** T01-T08 from `traps/plan.md` with their naive fix: the gate must
   FAIL naming a ledger record that stands for the planted rule (the record
   whose check flags that standard's invalid fixture and passes its valid
   one). Every trap applied must be caught.
2. **A deleted test**: tamper FAIL naming the file.
3. **A clean change** with a red-first acceptance check (`prove-red`, then the
   code): PASS with tamper, secrets, standards, lint, typecheck, build, base
   tests and the acceptance step all passing. Wall time is measured for the
   cold run, a cached re-run and a re-run after a one-file edit. Without
   installed dependencies this part is skipped with the reason (the gate
   then FAILs the build/typecheck/lint/test steps as "declared but not
   installed", by design).

`HARNESS_ACCEPTANCE_OUT` receives one JSON line with the traps caught and the
timings.

## verify-e2e.test.ts: end-to-end verification on the team stand-in

Needs `HARNESS_STANDIN_TEAM`, an installed workspace
(`HARNESS_STANDIN_TEAM_WORKSPACE`, or `HARNESS_STANDIN_INSTALL=1` so
`setup.js` runs `npm ci`), Docker with a running SQL Server container
(`HARNESS_STANDIN_DB_CONTAINER` when more than one runs) and the container
login's password in `HARNESS_STANDIN_DB_PASSWORD` (`HARNESS_STANDIN_DB_USER`,
default `sa`); each missing piece is a skip with the reason. The password is
only ever passed through the environment.

In a temporary home it marks the container as a test server with
`harness db mark`, then: `verify launch` of catalog-api and orders-api (a
per-run database from the migrations and the stand-in seed), `verify doctor`
(passes, both services on the run database), the cross-service
`POST /orders` recipe written into the overlay (status, body, the order row
and the stock change asserted), a GET, a `verify db` row assertion, a query
outside the run database (refused, exit 4), a failing assertion (exit 1),
`verify evidence` (every artefact fresh; the gate's own reader passes the
three criteria), `verify map build` (the 15 routes the stand-in lists) and
`verify cleanup` (the database gone, checked with sqlcmd; ports free). The
launch time and the artefact count are printed and, with
`HARNESS_ACCEPTANCE_OUT`, appended as one JSON line.

## land-standin.test.ts: landing with a planted post-landing failure

Needs `HARNESS_STANDIN_PERSONAL` (skips with the reason when unset). Creates
the personal stand-in with `setup.js <repo> --no-db --no-env --origin <temp
bare repo>` (its `npm ci` needs the registry or a cache; skipped with the
reason when the install fails), plants on main a unit test that passes
everywhere except under `CI=true` once a given file has landed (then it fails
once, or always), and works two tasks in harness worktrees (`task/<id>`,
node_modules linked), each gated with the real `harness gate`:

- T-101: `harness land --ci local` lands it; the CI stand-in is red once and
  green on the rerun. Asserted: `landed`, `post_landing_red`, not
  `auto_fixed`, not `reverted`, `revert_correct` null, outcome `deflaked`,
  only `tests:base` failed in the red CI run, origin updated.
- T-102 (branched before T-101 landed): land merges main in and re-runs the
  invalidated steps (partial, all passing), CI stays red, `--fixer none`:
  one revert commit, `reverted`, `revert_correct`, main back at T-101's tree,
  the revert pushed, the task `todo` again with the note.

`HARNESS_ACCEPTANCE_OUT` receives one JSON line with the landing fields and
the timings.

## run-claude.test.ts: the runner with a real headless Claude

Needs `claude` on PATH and logged in (skipped otherwise, or with
`HARNESS_SKIP_CLAUDE=1`). A temp repository with one ledger task (fix a typo
in README.md), a temp HOME holding only the Claude login, and `harness run
--once --agent claude --model haiku --turns 8 --unit-minutes 4
--ticket-minutes 6 --budget-usd 0.25 --ci local`. It asserts the runner's
bookkeeping for whatever the model did (landed: `done`, the fix on main,
green CI; a cap: `failed` with `cap:<kind>`; otherwise failed or blocked with
a reason) and prints the cost Claude reported. The repository has no harness
install, so this checks the runner's mechanics, not the agent's use of the
skills.

## learn-protocol.test.ts: the learning protocol in miniature

The EVAL-PLAN section 8 protocol, shrunk to one scripted trial on a temp
repository and a temp `HARNESS_HOME`, through the built CLI. Needs git and
ast-grep (the harness's optional dependency); skips with the reason when
either is missing. No stand-in, network or agent.

1. A ledger as discovery writes it: the probe library's
   `logging.logger-not-console` standard in warn mode with its real ast-grep
   rules.
2. A mistake class planted in `events.jsonl`: one `gate.fail` naming the
   rule and two corrections in the same session.
3. `harness learn --scan`: one lesson, 3 occurrences, a `lint` enforcer, tier 0.
4. `harness learn prove <id> --fixture <the original mistake>`: `ast-grep
   test` reports it; tier 0, so the lesson is approved and the learned check
   is written under `ledger/checks/learned/` with a block-mode record.
5. A new event of the same class is fed, and the real `harness gate --steps
   standards` runs on the repository with the mistake in the working tree: it
   FAILs on the learned rule at the right line (block, not warn) and logs its
   own `gate.fail`.
6. `harness learn stats`: 0 repeats before the enforcer landed, and the
   repeats after it (2 in the recorded run) are counted.

## report.test.ts: the code-free report on the team stand-in

Needs `HARNESS_STANDIN_TEAM` (skips with the reason when it is unset) and git.
In a temporary `HARNESS_HOME` it creates the stand-in workspace (`setup.js
--no-install --no-db`, or reuses `HARNESS_STANDIN_TEAM_WORKSPACE`), writes a
team config for its repositories, and runs the real commands: `harness
discover`, `harness assess`, `harness intake` on a ticket written by the test
(mapped to the first repository), and `harness gate --task <brief id>` there.
Then `harness report --json` must count the ledger, the assessment and one
task row that matches the brief and the evidence; neither the JSON nor the
Markdown may contain a repository name, the workspace path or the ticket's
planted word; `harness report --check-scrub` must pass, and the test prints
the number of tokens checked. `harness status` must show the task.

Recorded run (2026-10-19, no `node_modules`, so the gate reports declared
tools as not installed and FAILs): discover 1,099 ms, assess 171 ms, intake
108 ms, gate 201 ms; scrub ok with 580 tokens checked (3 repositories, 126
file paths, 83 sampled source files, 1 brief; 31 dropped as the report's own
words, 4 numeric, 14 too short).

## integration-team.test.ts: the team setting end to end

Needs `HARNESS_STANDIN_TEAM`, Docker answering and a SQL Server container
running (skips with the reason otherwise). On a fresh scratch folder:

1. `setup.js <tmp>/shop --db-name test_it<hex>` (with `npm ci` only when
   `HARNESS_STANDIN_INSTALL=1` or the Claude case runs); the repositories
   start clean;
2. `harness install --setting team --agents devin,claude,codex --yes
   --db-test localhost,<port>` into the stand-in's fake HOME (`HOME`,
   `HARNESS_HOME`, `HARNESS_USER_HOME`, `XDG_CONFIG_HOME` all inside it):
   the always-on file, skills and scoped rules of each agent where it loads
   them (each always-on file at most 4096 bytes), the hook and permission
   files of all three, both spellings of the `node <cli.js>` allow rule;
   `git status` clean in every repository and only the parent-folder
   `AGENTS.md` changed in the workspace; every touched file in the manifest;
   doctor with hooks for the three agents, the allowlist and the integrity
   manifest ok and 0 failures; `harness status`;
3. behind `HARNESS_RUN_CLAUDE=1` (it costs money): a fresh install, the
   user's verify setting (`config set verify.db.snapshot db:<the test
   database>`), the Claude login copied into the fake HOME, and `claude -p`
   on ticket T02 (`HARNESS_CLAUDE_MODEL`, default `claude-sonnet-5-5`;
   `--max-turns 50 --max-budget-usd 1`, default permission mode plus the
   installed allow rules, Edit/Write allowed). Asserted whatever the model
   does: a brief was written, nothing was committed, only `src/` and `test/`
   files changed, the other repositories untouched. Printed: verdicts,
   turns, cost, guard denials, Stop hook outcomes;
4. the round trip: a second install is a no-op plan; `undo --plan <id>
   --yes` puts every file back to its before-state (modified files hash-equal
   to their backups, created files gone) and the fake HOME and workspace
   equal their snapshots; install again (the same number of files), a no-op
   again; `uninstall --yes` leaves the fake HOME (outside the state folder,
   which keeps its backups by design) and the workspace as before.

The test drops its database at the end; `HARNESS_KEEP_SCRATCH=1` keeps the
scratch folder. The manual runs behind it are recorded in
`INTEGRATION-TEAM.md`.

## Other acceptance tests

`guard-hook.test.ts` and `lifecycle-roundtrip.test.ts` exercise the PreToolUse
guard and the propose/apply/undo lifecycle through the CLI in temporary homes.

`render-standin.test.ts` (needs `HARNESS_STANDIN_TEAM`; the stand-in folder
or its `rough-harness/`) creates the team stand-in, runs discovery without
the repos' binaries and `harness propose` with the rough harness's fake home,
and checks that every planted defect in `expected/assess.json` gets a hunk
with its check id on the right file and line, that no quarantined line is in
any file the plan writes, and that the always-on files stay within 60
harness-owned lines (their sizes are printed).

`../behaviour/install-team.test.ts` (needs `claude` on PATH and logged in)
installs the team setting into a temp home, seeds an isolated Claude Code
HOME with exactly the rendered files, and checks in `claude -p` (haiku) that
`git push --force` and a `sqlcmd` against an unmarked server are denied and
that the `task` skill is listed. Cost and the denials are printed.
