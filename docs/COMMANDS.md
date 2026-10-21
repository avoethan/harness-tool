# Command reference

Every `harness` command, its subcommands and flags, who runs it, and what it
writes. `harness help <command>` prints the exact syntax (which flags take a
value, which repeat). A unit test (`test/unit/docs/commands-doc.test.ts`)
keeps this page and the CLI in step: every command here exists in the CLI and
every CLI command is here, with the same subcommands and flags.

`~` below is the harness state folder `HARNESS_HOME` (default `~/.harness` in
your user folder). In the team setting nothing is ever written inside a team
repository; the rows that write into a repository are personal-setting only
and say so.

## Who runs it

| Mark | Meaning |
|---|---|
| **agent** | On the allow list the harness writes for each agent, so the agent runs it during a task without asking you. You can run it too. |
| **both** | The agent may run it (no rail blocks it, but the agent's own permission prompt applies), and so can you. |
| **user** | Admin rail: the guard denies it from every agent tool call. You run it in your own terminal. |
| **hooks** | Run by the hook entries the agents call. Nobody types it. |

## Commands

| Command | Subcommands | Flags | Who runs it | What it writes |
|---|---|---|---|---|
| `harness version` | — | — | both | nothing |
| `harness help` | — (takes a command name) | — | both | nothing |
| `harness doctor` | — | `--json` `--fix` | agent | nothing; `--fix` creates the private state repository (`~` as a git repository with no remote) when it is missing |
| `harness install` | — | `--setting` `--agents` `--workspace` `--yes` `--judgment` `--db-test` `--db-none` `--reject` `--commit` `--no-exec` `--json`; `--uninstall` with uninstall's `--setting` `--repo` `--dry-run` `--yes` `--json` | user | in one run: what `discover`, `assess`, `db mark`, `propose` and `apply` write (below), plus `~/config.json`, `~/integrity.json` and the state repository. Team: user-level agent configuration only. Personal: the repository files, and one commit with `--commit` |
| `harness discover` | — | `--root` `--max-files` `--no-exec` `--judgment` `--import-judgment` `--json` `--quiet` `--self-test` | both | `~/ledger/` (`ledger.json`, `checks/`, `findings.json`, `inventory.json`, `discover.md`, `db-candidates.json`); with `--judgment` a bundle in `~/judgment/<id>/`; `--self-test` writes nothing |
| `harness assess` | — | `--workspace` `--setting` `--agents` `--include` `--json` `--out` `--judgment` `--import-judgment` | both | `~/assess/assess.json` and `assess.md` (or the `--out` folder); with `--judgment` a bundle in `~/judgment/<id>/` |
| `harness propose` | — | `--setting` `--agents` `--workspace` `--include` `--out` `--no-diff` `--json` `--approve` `--reject` `--plan` `--for-team` | both; with `--approve` or `--reject`: user | `~/plans/<id>.json`, `~/archive/`, `~/quarantine/`; `--out` the plan text; `--approve`/`--reject` `~/plans/rejections.json`; `--for-team` `~/proposals/<repo>/` (never applied) |
| `harness apply` | — | `--plan` `--dry-run` `--commit` `--repo` `--json` `--yes` | user | the plan's files, a backup of each in `~/backups/<plan>/<time>/`, the manifest, `~/integrity.json`; `--commit` one commit in the personal repository; `--dry-run` nothing |
| `harness undo` | — | `--plan` `--dry-run` `--json` `--yes` | user | restores the files of the last (or named) plan from its backups by hash; files you edited since are kept and listed; removes only the settings entries the harness added; the manifest |
| `harness uninstall` | — | `--setting` `--repo` `--dry-run` `--json` `--yes` | user | undo of everything the manifest owns, and empty folders the harness created; backups are kept |
| `harness db` | `list`, `mark`, `unmark`, `candidates` | `--server` `--database` `--test` `--not-test` `--json` | `list`, `candidates`: agent; `mark`, `unmark`: user | `mark`/`unmark`: the test-database allowlist in `~/config.json` and its hash, integrity re-signed; `list`, `candidates`: nothing |
| `harness config` | `get`, `set` | `--json` `--from-install` | `get`: both; `set` and `--from-install`: user (an interactive terminal only) | `set`: `~/config.json`, integrity re-signed |
| `harness gate` | `prove-red` | `--task` `--repo` `--base` `--steps` `--json` `--no-cache` `--hook` `--blocked` `--session` | agent; also the git hooks and CI (personal) | `~/runs/<repo>/<task>/evidence.json`, `gate-cache.json` and (full runs) `writeup.md`, `~/cache/<repo>/`; `--hook` `~/runs/<repo>/hook-<name>/`; `prove-red` the red proof of each acceptance check into the brief |
| `harness phase` | `implement`, `tests`, `status` | `--task` `--repo` `--session` `--expect-change` `--json` | agent | `~/runs/<repo>/<task>/phase.json` and the session state `~/state/<session>.json`; `status` nothing |
| `harness verify` | `launch`, `doctor`, `drive`, `db`, `evidence`, `cleanup`, `env`, `map build`/`drift`/`show`, `maintain` | launch: `--services` `--task` `--repo` `--no-db` `--no-migrate` `--db-unreachable` `--ready-timeout` `--json`; drive: `--method` `--path` `--param` `--query` `--header` `--body` `--as` `--expect-status` `--expect-json` `--expect-body` `--expect-header` `--repeat` `--expect-p50-ms` `--expect-p95-ms` `--expect-p99-ms` `--timeout` `--no-recipe` `--criterion` `--service`; db: `--table` `--where` `--expect-columns` `--expect-rows` `--expect`; cleanup: `--keep-db`; env: `--powershell` `--cmd` `--posix`; maintain: `--add-missing` `--add` `--accept` `--accept-all` | agent | `launch`: `~/runs/<repo>/<task>/verify.json`, `run.env`, `logs/`, port reservations, and a `test_<run>` database on a server you marked as test; `drive`/`db`: redacted artefacts `e2e/<criterion>-http.json`/`-db.json` with the tree hash; `cleanup`: stops the services and drops the run database (kept with `--keep-db`), evidence stays; `map`: `~/runs/<repo>/feature-map.json`; `maintain`: `~/featuremap/<repo>/overlay.json`; `doctor`, `evidence`, `env`: nothing |
| `harness intake` | `show`, `answer`, `lint`, `list` | `--from` `--jira` `--jira-next` `--repo` `--json` `--q` `--answer` `--unattended` `--all-recommended` | agent | `~/briefs/<id>.json` and `~/runs/<repo>/current-task`; `answer` updates the brief; `--jira <KEY>` (not with `--from`) also saves the ticket as `~/.harness-inbox/<KEY>.txt` and the key in the brief; `--jira-next` reads the first ticket of the `jira.filter` search (read-only) and does the same; the ticket text is never logged |
| `harness brief` | — | `--repo` `--json` | agent | nothing; an alias of `harness intake show` (same output, same exit codes) |
| `harness task` | `add`, `list`, `next`, `claim`, `done`, `fail`, `release`, `import`, `validate` | `--title` `--priority` `--acceptance` `--paths` `--depends-on` `--status` `--stale-minutes` `--by` `--commit` `--evidence` `--reason` `--from-json` `--repo` `--json` | agent | personal only: `tasks/*.md` in the repository (the writing subcommands refuse a team repository with exit 4); `claim` also a brief and `current-task` |
| `harness writeup` | — | `--task` `--repo` `--out` `--json` | agent | `~/runs/<repo>/<task>/writeup.md` per touched repository; `--out` the combined text (refused inside a team repository) |
| `harness land` | — | `--task` `--repo` `--branch` `--main` `--ci` `--ci-command` `--squash` `--dry-run` `--no-wait` `--wait-minutes` `--fixer` `--model` `--ci-timeout-minutes` `--json` | agent (personal) | personal only: main fast-forwarded to the task (a merge commit on the task branch when main moved on, never a rebase), a plain push (never force), a revert commit when CI stays red; `~/runs/<repo>/<task>/landing.json` and `ci-<n>-<kind>.json`, the landing lock; `--dry-run` nothing |
| `harness pr` | `open` | `--task` `--repo` `--base` `--draft` `--dry-run` `--json` | user | personal only, the one command that writes to GitHub: needs the task branch pushed (same tip on `origin`) and a write-up; `GET` then `POST https://api.github.com/repos/<owner>/<repo>/pulls` (title = the brief title, body = the write-up); `~/runs/<repo>/<task>/pr.json` (url, number, at, head, base); team setting exit 4; an open pull request for the branch is reported, not duplicated; `--dry-run` nothing |
| `harness jira` | `comment`, `create` | `--task` `--repo` `--key` `--pr` `--from` `--one` `--project` `--type` `--yes` `--dry-run` `--json` | user | the only commands that write to Jira: `comment` posts the write-up's verification table, the gate line and the pull request link to the ticket (`POST /rest/api/2/issue/<KEY>/comment`; the key is the one `intake --jira` stored, else `--key`); `create` drafts follow-up tickets from `--from blocked`, `feedback` or a text and sends only with `--yes` (`POST /rest/api/2/issue`, then `/rest/api/2/issueLink` "Relates"); only the configured `jira.baseUrl` host is called; the token comes from the environment; `--dry-run` nothing |
| `harness run` | `pause`, `resume`, `check-stop` | `--agent` `--once` `--max-tasks` `--ci` `--ci-command` `--model` `--permission-mode` `--turns` `--unit-minutes` `--ticket-minutes` `--budget-usd` `--attempts` `--stale-minutes` `--main` `--repo` `--no-land` `--json` `--task` `--note` `--command` `--irreversible` `--not-reproduced` `--session` | the queue, `pause`, `resume`: user; `check-stop`: agent | personal only: a worktree per task in `~/worktrees/<repo>/<task>/` on branch `task/<id>`, `~/runs/<repo>/<task>/run.json`, and what `gate` and `land` write; `pause` `~/trail/<task>.md` and a work-in-progress commit on the task branch; `check-stop` nothing |
| `harness learn` | `prove`, `review`, `gc`, `stats`, `list`, `show` | `--scan` `--since` `--token-cap` `--json` `--import-judgment` `--fixture` `--repo` `--approve` `--reject` `--expire` `--renew` | `--scan`, `--import-judgment`, `prove`, `stats`: agent; `review` and `--approve`/`--reject`: user; `gc`, `list`, `show`: both | `~/lessons/<id>.json`; `--scan` a judgment bundle `~/judgment/lj<date>-<hex>/`; `prove` of a check in the private ledger: `~/ledger/learned.json` and `~/ledger/checks/learned/`; `review`: lesson status, an approved tier-1 lesson becomes a plan for `harness apply`; `gc` marks lessons to promote, never deletes |
| `harness judgment` | `submit`, `list` | `--from` `--json` | `submit`: agent; `list`: both | `submit`: `~/judgment/<id>/result.json` (the only way an agent hands a judgment result to the harness) |
| `harness digest` | — | `--task` `--repo` `--json` | both | `~/runs/<repo>/<task>/digest.md` beside the write-up (also printed): one page per ticket from the run folder and the instrumentation log, names and counts only (the ticket's title is the only ticket text), secrets redacted; exit 1 when the task is unknown |
| `harness report` | `row` | `--since` `--json` `--md` `--out` `--worklog` `--workspace` `--check-scrub` `--task` `--header` `--append` | agent | nothing by default (prints); `--out` the report file (refused inside a team repository); `row --append` a row in `~/worklog.csv` |
| `harness status` | — | `--json` | agent | nothing |
| `harness selfcheck` | `list`, `record`, `probe-files`, `probe-mode`, `probe-log`, `probe-hook` | `--agent` `--json` `--step` `--result` `--outcome` `--remove` `--stop` `--clear` | `list`, `probe-log`: both; `record`, `probe-files`, `probe-mode`, `probe-log --clear`: user; `probe-hook`: hooks | `record`: `~/selfcheck/<agent>.json`; `probe-files`: probe hook entries and marker files at user level with byte backups (`~/selfcheck/probe-<agent>.json`, `~/selfcheck/backup/`), `--remove` restores them; `probe-mode`: the Devin Stop-probe mode; `probe-hook`: `~/selfcheck/probe/<agent>-log.jsonl` (names, booleans, counts); `probe-log --clear` empties it |
| `harness reviews` | `fetch`, `import` | `--repo` `--path` `--max-pages` `--json` `--from` | both | `~/reviews/<repo>.json` (comment bodies redacted, logins hashed). `fetch` only reads `api.github.com`; the token is never stored |
| `harness self-update` | — | `--setting` `--repo` `--dry-run` `--yes` `--json` | user | replaces generated files that are still exactly as the harness wrote them, adds new settings entries (removes none), re-signs integrity; backups and manifest as `apply`; edited files are kept and their diff shown |
| `harness hook` | — (takes an event name) | `--agent` | hooks | `~/state/<session>.json`, `~/state/dedupe/`, `~/state/heartbeat-<agent>.json`, `~/logs/events.jsonl` (names, ids, counts); the Stop hook may write `cap.json` in the task's run folder; never anything inside a repository |

## The admin rail

The guard denies these from agent tool calls in every setting, however they
are spelled (`harness ...`, `harness.cmd ...`, `node <path>/dist/src/cli.js ...`,
`bin/harness ...`). The agent is told to ask you to run them. The list lives
in `src/guard/rails.ts` (`HARNESS_ADMIN_SUBS`, `HARNESS_ADMIN_SECOND`,
`HARNESS_ADMIN_SECOND_FLAGS`, `HARNESS_ADMIN_FLAGS`).

| Denied to agents | Why |
|---|---|
| `harness install`, `apply`, `undo`, `uninstall`, `self-update` | they write the agents' own hooks, permissions and instruction files |
| `harness pr open` (with or without `--dry-run`) | it is the only command that posts to GitHub; opening a pull request is your decision |
| `harness jira comment`, `jira create` (with or without `--dry-run`) | they write to your company's Jira; what goes on a ticket is your decision (`harness intake --jira` and `--jira-next` only read, and stay allowed) |
| `harness config set` (and `unset`, `reset`) | settings and caps; `set` also needs an interactive terminal |
| `harness db mark`, `db unmark` | the test-database allowlist is the database rail |
| `harness learn review` | approving what enters the agents' context is your decision |
| `harness selfcheck record`, `probe-files`, `probe-mode`, `probe-hook`, `probe-log --clear` | the self-check evidence is yours to produce |
| any command with `--from-install`, `--approve` or `--reject` | they change rails, plans or what is never proposed again |

## Allowed to agents without a prompt

The harness renders allow rules for these prefixes (`TASK_TIME_HARNESS` in
`src/render/model.ts`): `gate`, `verify`, `intake`, `phase`, `task`,
`writeup`, `doctor`, `report`, `status`, `land`, `run check-stop`,
`db list`, `db candidates`, `learn --scan`, `learn --import-judgment`,
`learn prove`, `learn stats`, `judgment submit`. In the team setting the same
commands are also allowed in the `node "<harness>/dist/src/cli.js" ...` form
the agents use when `harness` is not on PATH.

## Exit codes

0 ok; 1 failure (for `gate`: FAIL); 2 usage error; 3 not built (run
`npm run build`); 4 refused by a safety rail.
