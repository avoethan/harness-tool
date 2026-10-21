# report: the code-free report, `harness status` and the self-check records

## Commands

```
harness report [--since <date>] [--json|--md] [--out <file>] [--worklog <file>] [--workspace <dir>]
harness report --check-scrub [--since <date>] [--workspace <dir>]
harness report row --task <id|ticket hash> [--header] [--append] [--worklog <file>]
harness digest [--task <id>] [--repo <path>] [--json]
harness status [--json]
harness selfcheck [list] [--agent devin|codex] [--json]
harness selfcheck record --agent <agent> --step <n> --result "<text>" [--outcome expected|different|noted]
harness selfcheck probe-files --agent <agent> [--remove]
harness selfcheck probe-mode --agent devin --stop off|block|slow
harness selfcheck probe-log --agent <agent> [--json] [--clear]
```

| Exit | `report` | `status` | `selfcheck` |
|---|---|---|---|
| 0 | written / scrub ok | always | ok |
| 1 | scrub failed (refused), task not found, row already in the work log | | probe removal incomplete, settings file not plain JSON |
| 2 | usage | | usage, unknown step |
| 4 | `--out` inside a git repository in the team setting | | a probe target inside a git repository |

## The report (counts only)

Read from `~/.harness` only (`collect.ts`), built in `build.ts`, rendered as
Markdown (one table per section) in `markdown.ts`; `--json` prints the
`Report` type of `src/types.ts`.

| Section | Source | What is counted |
|---|---|---|
| Standards by tier, by family | `ledger/ledger.json` | records per tier and family |
| Checks generated, by mode and tool | `ledger/checks/index.json` (else the ledger) | generated checks per mode (block, warn, judgment) and type |
| Assessment findings, line classes | `assess/assess.json` | findings per check id; classified lines per class |
| Team proposals | `proposals/<repoId>/<n>-*.md` | write-ups (the `.diff` files are not counted) |
| Tasks | `briefs/`, `runs/<repo>/<task>/`, `logs/events.jsonl`, `worklog.csv` | one row per task, below |
| Learning loop | `lessons/<id>.json` | captured (every lesson), proven (proven, approved or with a proven enforcer), approved, expired |
| Caps | evidence, `cap.json`, `stop.cap` events | tasks released at the gate attempt cap; Stop hook releases at the cap |
| Self-checks | `selfcheck/<agent>.json` | steps, recorded, the ids of steps that matched and that differed |
| Period | every dated record counted | first and last date; `--since` |

Per task (rows keyed by the ticket hash; the Markdown shows its first 12
characters):

| Field | How it is measured |
|---|---|
| criteria | criteria in the brief |
| checksRun | gate steps that ran (not skipped), per repository, over every gate run in the period (`gate.step`/`gate.fail` events) and the latest evidence |
| checksFailedThenFixed | of those, steps that failed in some run and pass (or are cached) in the latest evidence |
| gateVerdict | the latest evidence per repository, combined: FAIL over BLOCKED over PASS; `none` without evidence |
| gateRuns | `gate.verdict` events for the task |
| verificationEvidence | E2E artefact files in the task's run folders |
| standardsFlagged | distinct ledger rule ids the standards step named (block or warn), from `gate.fail` events and the latest evidence |
| clarificationsAsked | questions answered plus questions open in the brief |
| repeatCorrections | `correction` events of a class already corrected in the same task |
| steeringMessages | per session tied to the task: user prompts minus one |
| reworkRounds | `pr_rework_rounds` from the work log, when it has the ticket |
| outcome | the work log's outcome (merged, abandoned, reverted); otherwise gate-pass, blocked, capped or open |
| capReached | the attempt cap released the agent without a PASS |

A session is tied to the task that most of its task-bearing events name
(gate events carry the task; `correction` events carry `sha256(task id)`),
ties going to the later one. Runs named `adhoc` or `hook-*` are not tasks.

**Redaction by construction.** Every key comes from a fixed vocabulary
(tiers, families, modes, check types, classes, verdicts, outcomes, self-check
step ids, assess check ids shaped like `R10`); anything else is counted as
`other`. Ticket hashes that are not 64 hex characters are hashed again. No
title, task id, path, statement or message text is ever copied.

## The per-ticket digest (`digest.ts`, `harness digest`)

One page per ticket, built from the task's brief, its run folder(s) under
`runs/<repoId>/<taskId>/` and the instrumentation log, and saved as
`digest.md` beside the write-up (exit 0 ok, 1 unknown task, 2 usage). It is
names and counts only: the brief's title is the one piece of ticket text, and
criteria, descriptions, questions, check descriptions and the reasons given
for an expectation change are never copied. The BLOCKED reason is the gate's
own reason line, cut to 160 characters. The whole page, and the `--json`
form, go through the secret redaction (`src/lib/redact.ts`) before they are
printed or saved.

| Section | Source |
|---|---|
| Criteria and checks | the brief: criteria per kind, checks per kind, red-first and green-at-base counts |
| Prove-red | each check's `redProof` (red, green, no test found, could not run) and the checks not run yet |
| Gate | `gate.verdict` and `gate.partial` events (attempts, verdict order), `evidence.json` per repository (final verdict, steps by status, failing step names, BLOCKED reason, attempt cap) |
| Interventions | `guard.deny` events of the task's sessions, by rail (a rail outside the fixed list counts as `other`) |
| Tests phase | `phase.json`: entries, current phase and, when present, the `expectChanges` list (`{file, reason, at}`: file and time only); the field is optional |
| Live artefacts | `e2e/*.json`: fresh when the artefact's tree hash is the latest evidence's, stale otherwise, and the ones recording a failure |
| Sessions and cost | `run.json` (agent, status; optional `sessions`, `turns`, `costUsd`) and the runner's `run.session` / `run.task` events; cost only when the runner recorded it |
| Landing and pull request | `landing.json`, the `ci-*.json` count, `pr.json` |
| Time | first to last event of the task and of the sessions tied to it |

`harness report` carries the same numbers as a "Per ticket" table (one row
per task folder: criteria, gate attempts, verdict, rail denials, tests-phase
entries, expectation changes, sessions, cost, landing outcome, pull request
yes/no, minutes) and a "Rails" table with the denials per rail. Both are in
the report's fixed vocabulary, so the scrubber checks them like the rest.

## The scrubber (`scrub.ts`)

A token set, lower case, built from: the repository names and ids, the
workspace root, home folder, user and host names, every path segment of the
workspace's files (a walk capped at 20,000 files, segments also split on `-`,
`_` and `.` into parts of 4+ characters), identifiers longer than 6
characters from an evenly spaced sample of 400 source files (first 64 KiB of
each), and the words of every brief's title and criteria. Tokens that are a
word of the report's own vocabulary (every word a report can carry by
construction: headings, column names, keys, enum values), purely numeric, or
shorter than 3 characters (2 for a repository name) are dropped and counted.

The report (the JSON object field by field, and the Markdown line by line) is
split into words, case-insensitively, both as runs of letters and digits and
as runs that keep `-`, `_` and `.`; a word in the token set is a leak.
`harness report` refuses to print or write a report with a leak and names the
field (`tasks[2].outcome`, `assessment.findingsByCheck{key}`,
`markdown line 40`), never the token. `--check-scrub` prints the number of
tokens checked and how many were dropped.

## The work log (`worklog.ts`)

`~/.harness/worklog.csv` holds the user's rows with the columns of the
real-use log: `ticket_hash, date, task_kind, size_estimate, user_messages,
waiting_for_user_episodes, acus, time_to_pr_min, pr_rework_rounds,
review_findings_by_family, e2e_proof_in_writeup, clarifications_asked,
repeat_corrections, outcome, harness_version`. The report reads only
`ticket_hash` (a prefix of 8+ hex characters is enough), `pr_rework_rounds`
and `outcome`. `harness report row` fills the columns the harness measured:
`user_messages` (prompts minus one per session tied to the task),
`waiting_for_user_episodes` (an allowed stop followed by a prompt in the same
session), `task_kind` (the most common criterion kind),
`e2e_proof_in_writeup`, `clarifications_asked`, `repeat_corrections`; the
user fills the rest.

## `harness status` (`status.ts`)

One screen: setting, agents, workspace and repository count; ledger size,
blocking rules and age; the DB allowlist (test / not test, hash intact);
integrity; open tasks (not PASS) with repository, phase, attempt, last
verdict and title, the current task first; lessons waiting for review
(captured, proposed, proven); self-check progress for Devin and Codex; and
one next step, most urgent first: install, integrity, discover, allowlist
hash, a failing task, a task at the attempt cap, a current task with no gate
run, lessons, an unfinished self-check, a ledger older than 30 days.

## Self-checks (`selfcheck.ts`, `probes.ts`)

The step catalogues (`DEVIN_STEPS`, `CODEX_STEPS`) number the steps of
`selfcheck/devin-desktop.md` and `selfcheck/codex.md`; a unit test keeps the
pages and the catalogue in step. `record` stores the user's words with an
outcome (`expected` when the text starts with pass/ok/yes, `different` with
fail/no/different, `noted` otherwise, or `--outcome`).

`probe-files` writes, only at user level and never inside a git work tree:
for Devin a marked block at the end of the user-level `AGENTS.md`
(`MARKER-GLOBAL-PROBE`, filler, `MARKER-TAIL-PROBE` after byte 17,000) and
three probe hooks in `config.json` (SessionStart with a nonce marker as
`additionalContext`, PreToolUse on every tool, Stop with a 3-second timeout);
for Codex two probe hooks in `~/.codex/hooks.json`. Each write is recorded in
`selfcheck/probe-<agent>.json` with hashes and a byte copy; `--remove`
restores the bytes when the file is as the probe left it and otherwise takes
out only the probe block or the entries whose command contains
`selfcheck probe-hook`. A settings file that is not plain JSON is refused
(rewriting would drop its comments) and the entries are printed for adding
by hand. The machine manifest and the integrity manifest are never touched.

The probe hook (`harness selfcheck probe-hook <Event> --agent <agent>`) runs
the harness's own code, fails open, and appends names, booleans and counts to
`selfcheck/probe/<agent>-log.jsonl`: tool names and `tool_input` field names;
whether `DEVIN_PROJECT_DIR` is set, equals the hook's working folder, is a
git repository, is the configured workspace root; the agent's own
environment variable names; Stop events with `stop_hook_active`. The Devin
Stop probe's mode (`off`, `block` three times in a row, `slow`: 10 s against
a 3 s timeout) is set with `probe-mode`.

## Limits

- The report reads instrumentation the hooks and the gate wrote; with
  `HARNESS_NO_INSTRUMENT` set, or for sessions the hooks never saw, the
  event-based counts (steering, corrections, failed-then-fixed, gate runs) are
  zero.
- Landing outcomes are not read yet; without a work-log row a task's outcome
  is derived from its gate evidence.
- The scrubber samples source files; an identifier that appears only in
  files outside the sample is not in the token set. The report cannot carry
  identifiers by construction; the scrub is the second line.
- Learning-loop counts read `lessons/<id>.json` records as the `Lesson` type
  describes them.
