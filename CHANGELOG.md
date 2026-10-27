# Changelog

All notable changes to the harness. Versions follow semantic versioning; the
version is in `package.json` and `harness version` prints it.

## 0.9.0 (2026-10-27)

- `harness jira token set` (`--email` for Jira Cloud, none for a Data Center personal access token, `--from-env` to move `HARNESS_JIRA_TOKEN`), `token status`, `token clear`: the token is asked for without echo and kept in `~/secrets/jira.json` under the harness home, which the guard treats as secret (no agent reads or writes it; Devin, Claude and Codex read rules for it), so it is no longer in the environment every agent command inherits. The environment variables still work and take precedence. `harness jira` stays admin-only.
- Guard (secrets rail): a command that names one of the user's own credentials, `HARNESS_JIRA_TOKEN`, `SQLCMDPASSWORD`, `GITHUB_TOKEN`/`GH_TOKEN`, `DEVIN_CREDENTIALS_B64` and other `HARNESS_*` tokens (`$env:X`, `%X%`, `$X`, `process.env.X`, `os.environ`, `os.getenv`, `[Environment]::GetEnvironmentVariable`, `printenv X`, `env:X`), is denied for every agent: it would land in the transcript or let the agent call Jira, the database or GitHub without the harness. Printing the whole environment (`env`, `printenv`, `set`, `Get-ChildItem env:`, `export -p`, `console.log(process.env)`, `print(os.environ)`) is denied while one of them is set. Other secret-looking variables and programs that read their own (sqlcmd) are unaffected.
- Team setup guide: the token setup above, the permissions the token needs, and an epic's stories one at a time through `jira.filter` (`parent = EPIC-1` on Cloud, `'Epic Link' = EPIC-1` on Data Center).

## 0.8.0 (2026-10-27)

- `harness changes` says why: under each file the harness changed, every change its install or self-update plan recorded (the reason and the line it came from, consecutive lines with the same reason as one range), a "better because" sentence for that kind of change (by check id, e.g. a stale command corrected, derivable text trimmed, an autonomy grant quarantined, the hooks and rails added), and where text taken out is kept (`~/archive/`, `~/quarantine/`). A plan file that is gone is said, not guessed. Agent-file changes say whether the harness made them; one it did not make has no recorded reason, only the diff. `--json` carries the reasons.

## 0.7.0 (2026-10-26)

- `harness changes`: lists every file installs and self-updates added, changed or removed (from the plan records kept with the backups) and how each stands now (as the harness left it, edited since, deleted since, back to the original), and every agent file (instructions, skills, rules, workflows, agent settings, the `assess` inventory) added, changed or removed since the record, by anyone. `--diff` prints line diffs, `--path` filters, `--json` for tools. `harness changes record` sets the starting point (a copy of each text file up to 1 MB under `~/agentfiles/`); install takes the first record; the guard and the rendered permission rules deny `changes record` to Claude, Codex and Devin, since re-recording after an agent's own edits would hide them.
- Team setup guide: Windows "Extract All" can nest the zip one folder deeper, which makes `npm ci` report a missing lockfile; the guide says to move the inner folder up.

## 0.6.0 (2026-10-26)

- Devin self-check: a PreToolUse block probe (`echo harness-pre-block-probe`) that only the probe hook denies, for step 8 when the agent refuses forbidden commands before the hook sees them; step 3 says to quit Devin fully (tray icon); step 5's record line reads the right way round.
- Local changes present when a ticket starts are not the ticket's: intake, `task claim` and the first gate run of a task without one record a start snapshot (`~/.harness/runs/<repo>/<task>/start-snapshot.json`: each locally changed, deleted or untracked path with its git hash, never content). The gate's diff (and with it the secret scan, tamper, standards, lint of changed files, map-drift and `gate`-kind scope paths), the write-up's "What changed" and "Existing tests changed", and the digest leave out a path that is unchanged since; a recorded path that changes again, or is committed, is in and the write-up marks it. The gate prints one line with the count; `--json` lists the paths; `intake show` prints the count.
- An agent cannot hide its own work this way: an automatic snapshot does not record a path an agent session edited in the last 12 hours, a file changed after the brief, or (late) a deleted file. `harness task snapshot [--task <id>]` re-records it as the tree is now; it is an admin command, denied to Claude, Codex and Devin by the guard and the rendered permission rules.
- The guard's admin check also catches the admin word after a flag's value (`harness task --repo . snapshot`, `harness db --server x mark`), which the CLI would still run.
- The gate's working-tree hash keeps the index's own time on its temporary copy, so a same-size edit made within a second of the last index write is no longer missed; the gate's added lines and the write-up's file list read non-ASCII and spaced paths unquoted.
- Gate: a failure already present at the starting commit no longer blocks the ticket. When `lint`, `typecheck`, `build`, `tests:base`, `coverage` (its script) or `affected` fails, the same step runs once in a temporary checkout of the base commit and the failures are compared (diagnostics by file, rule or TS code and message without line numbers; tests by exit code and failing test names; other scripts by exit code and failure lines). When every current failure is also at the base, the step is `pre-existing`: shown as `PRE-EXISTING`, it does not fail the verdict, and the write-up lists it under "Already failing before this change". Any new failure FAILs, naming only the new ones; a base that cannot be evaluated is said plainly and the step keeps failing. Base results are cached per base commit in `~/.harness/cache/<repoId>/baseline-<sha>.json`, and one checkout serves the whole run.
- Gate: `typecheck` runs the repository's own way: the base commit's `typecheck`, `type-check`, `tsc`, `check:types` or `types` script first; else, when the `build` script runs tsc, it is skipped with that reason (the build step checks the types); else `tsc -b` for project references; else `tsc -p tsconfig.json --noEmit` as before. The gate's own `tsc` call reported unresolved-module errors on repositories that build cleanly with their scripts.
- `GateStep.status` gains `pre-existing`; the Stop hook and the write-up treat it as not failing, `harness report` counts it in a new `checksPreExisting` field and an "Already failing at base" column, and `harness digest` counts it per repository.
- The secret scan is unchanged and still scans only added lines; a test now pins that a secret already in a file at the base is not flagged.

- Intake: answering "I found no acceptance criteria" now adds the answer as the criteria (one per line or per `;`, a leading option letter removed), or the title when that option is chosen; before, the answer was only recorded and the brief stayed without criteria, so the gate reported BLOCKED. The task skill says to pass the criteria themselves as the answer.
- Devin self-check step 1: the About box shows the app's own version (Devin Desktop 1.96.x), not the agent's 3.9.19 from the documentation; the step now records the app version and relies on steps 2 and 4 for hook support.
- Intake: a criterion that says a file contains some quoted text (`README.md contains the line "second line"`) becomes a `gate`-kind check the gate proves by reading the file in the working tree, so a docs-only ticket needs no test runner. A path outside the repository, a missing file or missing text fails it; text that was already in the file at the base is noted.

## 0.5.0 (2026-10-23)

From the first work-machine setup: a read-only database mark, a per-agent hook check in doctor, and setup fixes.

- `harness doctor` reports, per configured agent, the last hook event seen and when the guard last checked one of its tool calls (`hooks-seen-<agent>`); the team guide says how to read it instead of a heartbeat only Codex had.
- `harness install --reject` accepts a path relative to the workspace (`.devin/workflows/x.md`) or starting with `~`, not only the full path the plan prints.
- Team guide: use `npm.cmd` on Windows, where disabled PowerShell scripts refuse the `npm` wrapper; the zip download is named as an alternative to cloning.
- A third database mark, `read-only`: `harness db mark --server <host[,port]> --database <name> --read-only` (exactly one of `--test`, `--read-only`, `--not-test`, else exit 2; a database-scoped mark is the normal use). The interactive prompt offers test / read-only / not-test / skip, `harness db list` shows the mark, and the allowlist signature covers it.
- Database rail: on a read-only target the agent may run only inline SQL (`sqlcmd`/`osql`/`isql`/`mssql-cli -Q`, `Invoke-Sqlcmd`/`Invoke-DbaQuery -Query`, a here-string) that the new read-only classifier (`src/guard/sqlreadonly.ts`) proves reads: every statement starts with SELECT or WITH, no write or control word, no `sp_`/`xp_`, no sqlcmd directive or variable, no other database or linked server, ASCII only. Anything else is denied with "<db> is marked read-only: this statement could write (<word>); stop and ask the user to run it or approve it". A command mixing test and read-only targets follows the read-only rule.
- Database rail: a database entry now beats a server-wide entry, the strictest mark wins within a scope, and a target without a database takes the read-only or not-test marks of its server's databases (the login's default database may be one of them). Before, the first matching test entry won.
- Database rail: a test target on a server that also holds read-only or not-test databases, or matched by a database-scoped test entry, may not reach other databases (three- and four-part names, the protected database's name, dynamic SQL, `sp_MSforeachdb` and other system procedures, DBCC, assemblies); `bcp` there is refused.
- Database rail, all marks: `xargs` arguments to a database client and a flag taken as another flag's value (`-h -i x.sql`) are refused; sqlcmd's `-C` no longer swallows the next argument, and `-K` takes one.
- `harness verify` never creates on, restores into, copies from or seeds a read-only database (exit 4 naming the mark); `verify db` on a run database re-marked read-only only reads, and refuses a recipe that writes. `verify db --query` ends with the same classifier, so a three-part column name (`dbo.t.col`) is now refused.
- The task skill says: on a read-only database run only SELECT inline; for any change, stop and ask the user. The always-on file and the session index list read-only targets.

## 0.4.1 (2026-10-21)

- Docs only: the README status table says what the Devin command-line check and the 24 Devin lab runs exercised, and the publishing guide records the three published commits.

## 0.4.0 (2026-10-21)

The user's second round of requests: a Jira queue and two user-run Jira writes, a cost cut for status-only API criteria, a tamper rule for changed expectations in existing tests, and a per-ticket digest.

- New `harness digest [--task <id>] [--repo <path>] [--json]`: one page per ticket from the task's run folder and the instrumentation log. Sections: criteria and checks, prove-red, gate (attempts, verdicts, final verdict, BLOCKED reason), interventions (tool calls the hooks denied, by rail), tests phase (entries and declared expectation changes from the optional `phase.json` `expectChanges`), live artefacts (fresh or stale against the latest evidence), sessions and cost (from `run.json` and the runner's events, when recorded), landing and pull request, and time. Names and counts only: the title is the only ticket text, and the page goes through secret redaction. Printed and saved as `digest.md` beside the write-up.
- `harness report` gains a "Per ticket" table (one row per task folder with the digest's headline numbers) and a "Rails" table (denials per rail). The existing report fields are unchanged; the scrubber runs over the new fields too.
- Cost cut: an `api` criterion that expects only a status on a named route is classified `liveOptional` (description: "live drive, or a unit test named `<id>:` that names the route `<METHOD> <path>`"). The gate's `e2e:<id>` step passes on a fresh passing artefact or on a passing test named `<id>:` in a test file that contains the route path; body, JSON, header, timing, database and database-down checks stay live-only. `prove-red` treats a `liveOptional` check like a unit check once a test names it. The task skill says the agent may skip launch and drive when every `api` criterion is live optional and it wrote the route tests.
- Tamper: changing a literal on an assertion line of a test file that existed at the base commit now fails ("expectation changed in a pre-existing test: <file>:<line>") unless the brief's unit paths include the file, a criterion's text quotes the new literal, or the change is declared with the new `harness phase tests --expect-change "<file> <reason>"` (recorded as `expectChanges` in `phase.json`; the write-up prints "Expectations changed in existing tests (declared)").
- `harness intake --jira-next` (read-only): config `jira.filter` is a JQL string or a saved filter id; the harness asks Jira for the first issue of that search (`GET /rest/api/2/search?jql=...&maxResults=1&fields=key`) and runs `--jira <KEY>` on it. An empty result exits 1 with "no ticket in the filter". The brief now stores `jiraKey` when the ticket came from Jira.
- New `harness jira comment [--task <id>] [--repo <path>] [--key <KEY>] [--pr <url>] [--dry-run] [--json]` (run by you): posts the write-up's Verification table (as a Jira wiki table), the gate verdict line and the pull request link (`--pr`, else `pr.json`) to the ticket with `POST /rest/api/2/issue/<KEY>/comment`.
- New `harness jira create [--task <id>] [--repo <path>] [--key <KEY>] [--from blocked|feedback|"<text>"] [--one] [--project <KEY>] [--type <name>] [--pr <url>] [--yes] [--dry-run] [--json]` (run by you): drafts follow-up tickets (the gate's BLOCKED reason, the write-up's "Feedback wanted" items, or your text), always prints the draft, and sends only with `--yes` (`POST /rest/api/2/issue`, then a "Relates" link to the source ticket; a failed link is reported, not fatal). New config keys `jira.filter`, `jira.project`, `jira.followupType`.
- `jira` is an admin subcommand in the guard: denied to every agent, with a deny prefix in the rendered rules of all three agents. `intake --jira` and `--jira-next` stay allowed.

## 0.3.0 (2026-10-21)

Integrations the user asked for after the first public release.

- Publishing: `scripts/publish-copy.js` (`npm run publish:check`, `npm run publish:copy`) publishes `HEAD:harness` to the public repository as a child commit of its `main` (one commit per publish, checks run on the copy first, optional tag), and `--check` reports any difference between the public `main` and `harness/` so the copy cannot drift. `docs/PUBLISHING.md` is rewritten around it and records the public repository's state.
- `harness intake --jira <KEY>` reads the ticket from Jira (read-only: one request to the configured https host, API v2, token from the environment only) and runs intake on it; the ticket is saved to the inbox as `<KEY>.txt`. New settings `jira.baseUrl`, `jira.acceptanceField`, `jira.emailEnv`, `jira.tokenEnv` (machine config only); environment variables `HARNESS_JIRA_EMAIL` and `HARNESS_JIRA_TOKEN` by default.
- New `harness pr open [--task <id>] [--repo <path>] [--base <branch>] [--draft] [--dry-run] [--json]` (personal setting, run by you): opens the pull request for a pushed task branch from the write-up (title = the brief title, body = the write-up), prints its address and records it in the run folder (`pr.json`). Refuses in the team setting (exit 4), when the branch is not on the remote at the same tip, and when there is no write-up; reports an already open pull request instead of duplicating it; `--dry-run` sends nothing. Agents cannot run it: `pr` is in `HARNESS_ADMIN_SUBS` and in the rendered deny rules of Claude, Codex and Devin.

## 0.2.0 (2026-10-21)

Every change below came from the Stage 3 evaluation on the stand-in workspaces and the review of the first fix round; the counted evaluation describes 0.1.0.

- The write-up names the pre-existing test files a change edited ("Existing tests changed (read these first …)") so a reviewer sees an expectation moved to match new behaviour.
- Intake and gate: criteria the gate proves by itself get a `gate` check (`CheckSpec.kind: 'gate'`, with `gateSteps`, `scopePaths`, `keepsHistory`): "CI checks (lint, typecheck, test, build, format:check) still pass" and "existing tests still pass" name gate steps, "nothing else changes in the tree" names the ticket's changed paths, "the commit is still in the history / no rebase" keeps the base commit an ancestor. The `acceptance:<id>` step reads this run's step results, the changed paths against the base commit and `git merge-base --is-ancestor`, and runs no repository code; `prove-red` prints "proved by the gate's own steps" and does not fail; `intake lint` counts the check as covered; the write-up column reads "gate: <what>". "Existing tests still pass" alone is now a gate check on `tests:base`, no longer green-at-base.
- Task skill: one line in the implement phase says to undo a commit with `git revert --no-commit <sha>` and a subject in the repository's convention, because the default `Revert "..."` subject can fail the commit-subject standard and amending is refused.
- Intake: the green-at-base, code-structure and document wording shortcuts no longer override a status code, a route that returns or answers, or (for green-at-base wording) a table or column; "helper" is code structure only as "helper function/method/module/class" or "helper with unit tests"; a bare "not duplicated" is no longer code structure. "GET /health returns 200 and the existing tests pass" is `api`, "The orders table is not duplicated ..." is `db`.
- Intake: the database-down shape needs unreachable wording (down, unreachable, unavailable, offline, not reachable, not running, cannot be reached, connection refused) and an answering verb; "fails", "failed" and "stopped" no longer qualify. A sentence that also says "available" or "database is up" is scored normally, and the expected status is the one after the down wording, else a 5xx in the sentence, else 503.
- Intake: a document criterion is green-at-base only when every named flag or quoted text appears in the file as a whole token, and a single-letter flag (`-v`) is never a needle, so a README with `--verbose` no longer makes "documents the -v flag" green-at-base.
- Gate: a green-at-base `acceptance:<id>` step needs a test file that names `<id>:`, even when the runner reports no counts; otherwise it fails with "no test names <id>".
- Gate: the `e2e:<id>` step for a check that launches with `--db-unreachable` counts only artefacts with `dbUnreachable: true`.
- Intake: response-header names are not read inside a route (`/x-ray/scan`), and an `X-` header must be written `X-Name` with the word "header" in the sentence (`/reports/x-axis-labels` names none).

- Discover: a written rule that points at a code span or a colon after "this" ("Always run this before committing: `npm test`.") is kept, and a sentence that ends on "will be rejected/blocked/closed/refused/reverted" is a rule; reassurance and forecast sentences stay out.
- Discover: the declared lint severity is resolved per unit (last entry wins; an extension-wide override applies only to files it matches); a count is capped at `warn` only when every unit that declares the rule declares `warn`, and a unit that declares `error` keeps `block`, with the warn units named in the statement.
- Guard: the rendered secret-file rules and the hook also cover `.env.qa`, `.env.uat`, `.env.stage`, `.env.sandbox`, `.env.preview`, `.env.e2e`, `.env.integration`, `.env.docker`, `.env.prd`, `.env.preprod`, `.env.secrets`, `.env.secret`, `.env.backup`, `.env.bak`, `.env.old`, `.env.encrypted`, `.env.vault`, `.env.*.bak` and `.env.*.backup`; the templates (`.env.example` and the others) stay readable.
- README and the team guide state that a task costs about 2× the agent money of a plain run.
- Task skill: the workflow is proportional to the brief (no `api` or `db` criterion: skip launch and drive); it names the only commands for reading a brief; it says up front that compound shell commands are refused; it mentions green-at-base criteria, `--db-unreachable`, `--expect-header`, `--unattended` and `--all-recommended` in one line each; and it says the gate writes the write-up. The always-on file is unchanged.
- `harness gate`: every full run (PASS, FAIL or BLOCKED, including `--blocked`) now writes the task's `writeup.md` itself and prints `Write-up: <path>` as the last line; `--steps` runs do not. A BLOCKED write-up carries the blocked reason. A task with no brief gets one line saying so.
- `harness brief [id] [--repo <path>] [--json]` is an alias of `harness intake show`, listed in the CLI help.
- `harness verify launch` now applies, after a snapshot restore, the `.sql`
  migrations the snapshot lacks (added or changed since the base commit, or
  whose tables are missing), lists them as "Migrations applied after the
  snapshot" and counts them in `verify doctor`. `--no-migrate` or
  `verify.db.migrateAfterSnapshot: false` skips the step.
- `harness verify launch --db-unreachable` starts the services with their
  database variables pointing at a reserved loopback port nothing listens on;
  the run record and every artefact carry `dbUnreachable: true` and doctor
  reports it instead of failing.
- `harness verify drive --expect-header` asserts a response header (exact
  `Name=value`, contains `Name~text`, present `Name=*`); secret-named header
  values are never recorded.
- `harness verify launch` decides which migrations to apply after a snapshot object by object: a migration whose tables, added columns or indexes are missing from the restored database is applied (so an unchanged `ALTER TABLE ... ADD` the snapshot predates is no longer skipped); one whose objects are all present is reported "already in the snapshot" and not run, even when it changed; one with no detectable object runs only when it changed; one recorded in a migration-history table is never applied.
- `harness verify drive --expect-header` records the actual value only for a list of safe header names; every other header records `matched` / `not matched` (or `present` / `absent`). A malformed expectation is echoed for 20 characters at most.
- `harness verify launch --db-unreachable` gives the unreachable port only to the entry and touched services; dependency services keep the real run database. The launch output and the run record say which services got it.
- Discover: the SQL client list also knows `pg-promise`, `@vercel/postgres`, `@libsql/client`, `@electric-sql/pglite` and `node:sqlite`.
- Discover: route probes (`api.route-path-case`, `layout.route-handlers-wrapped`) no longer count routes in test files, example, demo, docs or fixture folders.
- Discover: the `sql` probes run only in a repository that has SQL; the report says "sql probes skipped: no SQL in the repository" otherwise.
- Discover: a rule the lint config declares at `warn` is never made a blocking record by a probe count.
- Discover: reassurance, forecast and dangling-referent sentences ("don't worry", "may not be accepted", "install both") are no longer read as written rules.
- Discover: `lint.rules` and `fmt` in `vite.config.*` and `vitest.config.*` are read as declared sources, with their severities.
- Guard: the rendered deny rules of all three agents list concrete env secret spellings instead of `.env.*`, so `.env.example` and the other templates can be read; `.env` and `.env.local` stay denied.
- Intake: criteria that must keep passing (characterisation, "no behaviour change", "existing tests still pass", documentation-only, "the README documents X" when it already does) become `unit` checks marked `greenAtBase`. `harness gate prove-red` expects them green, the gate's `acceptance:<id>` step needs only a test that exists and passes now, plan lint counts them as covered, and the write-up says `green-at-base: <reason>`.
- Intake: a criterion about a document is a unit check that the named file contains the named text, instead of `untestable` or `ui-artifact`.
- Intake: criteria that name a flag, an exit code or printed output of a command-line tool are `unit` checks naming the command, not `api`.
- Intake: code-structure criteria ("a pure helper with unit tests", "extracted into a module", "no duplicated logic") are `unit`, never `db` or `api`, even when they name a table, column or route.
- Intake: a criterion saying the service must answer while its database is down gets two run lines (the launch with `--db-unreachable`, then a drive line expecting 503, or the status the ticket names); a named response header adds `--expect-header "<Name>~<value>"` to the drive line.
- Intake: `harness intake --unattended` (and `HARNESS_UNATTENDED=1`) and `harness intake answer <id> --all-recommended` take the recommended option for blocking questions and record it as an assumption marked "(unattended: no one to answer)"; the question stays listed. The personal runner builds its briefs unattended.
- Intake: `harness intake` and `harness intake lint` log an `intake.lint` event with `{ criteria, covered, open, rejected }`.

## 0.1.0 (2026-10-19)

The first version.

### Settings and agents

- Two settings of one tool: **team** (private: everything under your user
  folder, nothing written inside team repositories, work from a pasted ticket
  to a PR write-up you paste yourself) and **personal** (in the repository,
  with git hooks and CI, landing on main once every check passes).
- Three agents: Claude Code (behaviour-tested), Codex and Devin desktop (built
  from their documentation; each has a self-check to run on your machine).

### Commands

- `install`, `discover`, `assess`, `propose`, `apply`, `undo`, `uninstall`,
  `self-update`: discover the standards with evidence, read the existing agent
  setup, propose an upgraded harness with a diff and a reason per change,
  apply it with backups and a manifest, undo or remove it by content hash.
- `gate` (with `prove-red`), `phase`, `verify`, `intake`, `task`, `writeup`,
  `land`, `run`: the done-gate, end-to-end checks against running services
  and a per-run test database, ticket intake, the task ledger, the write-up,
  landing with CI watch and fix-or-revert, and the headless task runner.
- `learn`, `judgment`: the learning loop (lessons with proven enforcers) and
  the channel through which an agent hands a judgment result over.
- `report`, `status`, `doctor`, `selfcheck`, `db`, `config`, `reviews`:
  the code-free report, where things stand, install checks, the work-machine
  self-checks, the test-database allowlist, settings, past review comments.
- `docs/COMMANDS.md` lists every command, flag, who runs it and what it
  writes; a unit test keeps it in step with the CLI.

### Safety rails (cannot be turned off by the agent)

- Database work only against databases you marked as test.
- No secrets in commits or logs.
- No force-push or history rewrite.
- Team setting: nothing of the harness in team repositories; no push, no PR.
- Self-protection: the rails fail closed when their files change; admin
  commands are the user's only. Gate tampering and Stop-hook loops are caught.
- Personal setting: a change that breaks main after landing is fixed once or
  reverted.

### Packaging

- Node 20 or newer, no runtime npm dependencies; `@ast-grep/cli` is optional.
- Installs with `git clone`, `npm ci --ignore-scripts`, `npm run build`,
  without admin rights; `bin/harness` and `bin/harness.cmd` launchers.
- The npm package holds the built runtime, templates, the probe library, the
  self-check pages and the docs; no tests or fixtures.
- Test suites: `test:quick` (unit), `test:acceptance`, `test:safety`,
  `test:behaviour`; `npm test` runs them all.
