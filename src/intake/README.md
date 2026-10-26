# Intake, phases and the write-up (`src/intake/`)

This part turns work into checks before any code is written, records which
phase the agent is in, and ends the work with a write-up that maps every
acceptance criterion to its proof.

Commands: `harness intake`, `harness phase`, `harness task`, `harness writeup`.

## The phases of one task

| Step | Team setting (pasted ticket) | Personal setting (task ledger) | Owner |
|---|---|---|---|
| 1. Intake | `harness intake --from <file\|->`; answer questions with `harness intake answer` | `harness task next`, then `harness task claim <id>` | this part |
| 2a. Write the checks | `harness phase tests`; write a failing check for every criterion and prove it red at the base commit | same | this part (phase); the agent writes the checks |
| 2b. Implement | `harness phase implement`; change product code (tests read-only) | same | this part (phase) |
| 3. Verify | `harness verify drive` / `harness verify db` with the `run:` lines from the brief | same | verify component |
| 4. Gate | `harness gate` writes `evidence.json` | same | gate component |
| 5. Write-up | written by `harness gate` itself at the end of every full run; `harness writeup` rewrites it on request | `harness writeup`, then `harness land`, whose landing commit marks the task done in `tasks/` (or `task fail` when it cannot finish) | this part (write-up, ledger); land component |

The `task` skill should describe the flow in this order: intake -> tests
phase (checks first, red) -> implement phase -> verify -> gate -> writeup. A
criterion that waits for an answer (marked `blocks`) is the only reason to
stop before code; every other question proceeds on its recommended option.

## State it writes

```
~/.harness/briefs/<id>.json                 the brief (team id: t-<10 hex of the ticket's sha256>; personal: the task id)
~/.harness/runs/<repoId>/current-task       the task id the gate, phase and write-up use when --task is absent
~/.harness/runs/<repoId>/<taskId>/phase.json   {phase, since, testsEntries, history[], expectChanges?[{file, reason, at}]}
~/.harness/runs/<repoId>/<taskId>/writeup.md   the last write-up (written by every full `harness gate` run, and by `harness writeup`)
~/.harness/runs/<repoId>/<taskId>/start-snapshot.json   the local changes already in the repo when the task started (below)
<repo>/tasks/*.md                           personal ledger (front matter + body), committed with the repo
<git common dir>/harness-locks/ledger.lock  short-lived lock while a ledger write happens
```

The ticket text exists only inside the brief (title, description, criteria).
The instrumentation log gets the brief id, the ticket's sha256 and counts;
`intake.lint` (after `harness intake`, `intake answer` and `intake lint`) carries
`{ criteria, covered, open, rejected }`: criteria in the brief, criteria with a
check, criteria waiting on a question, and plan-lint problems. Names, ids and
counts only.
`repoId` is `repoIdFor(<repo path>)` from `src/lib/config`.

### Local changes present at the start (`localchanges.ts`)

People keep uncommitted notes, investigations and write-ups inside their
repositories. They are not the ticket's change, so `harness intake` (every
mapped git repository), `harness task claim`, and the first `harness gate` of
a task that has none record a **start snapshot** in the task's run folder:

```
{version: 1, repoId, taskId, base: <HEAD then>, recordedAt, by: intake|claim|gate|runner|user,
 entries: [{path, state}], withheld: <n>}
```

`entries` are the paths `git status --porcelain=v1 -z --untracked-files=all`
lists (modified, added, deleted, renamed, untracked; ignored files never),
repository-relative with forward slashes as git prints them (spaces and
non-ASCII kept), each with its git object id at that moment (the
`git hash-object` blob id, read from a `git write-tree` of the working tree
through a temporary index) or `deleted`. No file content is stored. An
existing snapshot is never overwritten by intake, claim or the gate, so
running intake again later cannot move the line. The runner's own task
worktree gets an empty one (the harness made it; nothing there is yours).

`isTicketPath` / `partitionChanges` decide, for the gate's diff and the
write-up alike: a path whose state now equals its entry is left out; a
recorded path that changed since (or was committed since: it ships) is in,
and the write-up's "What changed" marks it "changed during the ticket (you
had local changes in it before)"; a path that was clean at the start is in.
"Existing tests changed" and the file count read the same filtered list.

The agent must not be able to hide its own work this way. A snapshot that an
agent's command can trigger (intake, claim, the gate) does not record a path
an agent session edited in the last 12 hours (the session edit log; a shell
write logged as the whole folder withholds everything), nor a path whose file
time is not older than the brief (`createdAt`, 2 s slack), nor, when taken
more than a minute after the brief, a deleted path. Those count as `withheld`
and stay part of the change. `harness intake show` prints the count per
repository ("Local changes present at the start in orders-api: 12 ..."),
never the names.

`harness task snapshot [--task <id>] [--repo <path>] [--json]` re-records the
snapshot as the tree is now, with nothing withheld: for when you deliberately
edit your notes mid-ticket. It is an **admin** command (the guard denies it to
Claude, Codex and Devin, and the rendered permission rules deny
`harness task snapshot`): an agent re-snapshotting after its own edits would
hide them from the gate, so only you run it, in a terminal. It writes only
under `~/.harness`, so it works in both settings.

## Command reference

| Command | Exit codes |
|---|---|
| `harness intake --from <file\|-> [--repo <path>] [--unattended] [--json]` | 0 ok; 1 plan lint failed (brief saved, problems listed); 2 usage, unreadable, empty or over 1 MB |
| `harness intake --jira <KEY> [--repo <path>] [--unattended] [--json]` | as `--from`; also 1 Jira refused (401, 403, 404, a redirect, unreachable); 2 `--from` given too, a key not like `SHOP-102`, Jira not set up, or no token in the environment |
| `harness intake --jira-next [--repo <path>] [--unattended] [--json]` | as `--jira`; also 1 "no ticket in the filter" (empty search) or Jira refused the search; 2 `--jira` or `--from` given too, or `jira.filter` / Jira / the token not set up |
| `harness intake show [id] [--repo <path>] [--json]` | 0; 1 no brief or lint failed |
| `harness brief [id] [--repo <path>] [--json]` | the same as `harness intake show` (an alias: same flags, same output, same exit codes) |
| `harness intake answer <id> --q <n> --answer "<letter or text>" [--json]` | 0; 1 unknown brief, `Qn` not open, or lint failed; 2 usage |
| `harness intake answer <id> --all-recommended [--json]` | 0; takes the recommended option for every blocking question (recorded as an unattended assumption); 1 unknown brief or lint failed; 2 usage |
| `harness intake lint [id]` | 0 every criterion has a red-first, green-at-base or gate-proved check, or an open question; 1 otherwise, with the list |
| `harness intake list [--json]` | 0 |
| `harness phase implement\|tests\|status [--task <id>] [--repo <path>] [--session <id>] [--expect-change "<file> <reason>"]... [--json]` | 0; 1 no current task; 2 usage, or an `--expect-change` that is not a test file that exists at the base commit |
| `harness task add --title <t> [--priority <n>] [--acceptance <a>]... [--paths a,b] [--depends-on <id>]` | 0; 1 refused (unknown dependency, secret-looking text) |
| `harness task list [--status <s>] [--json]` | 0 |
| `harness task next [--stale-minutes <n>] [--json]` | 0 a task is ready; 1 none is ready (the reasons are listed) |
| `harness task claim <id> [--by <name>] [--stale-minutes <n>] [--json]` | 0; 1 refused (fresh claim, unmet dependency, overlapping paths, not todo) |
| `harness task done <id> --commit <sha> [--evidence <path>]` | 0; 1 commit not in the repo or task already done |
| `harness task fail <id> --reason "<text>"` / `harness task release <id>` | 0; 1 unknown task or wrong state |
| `harness task import --from-json <file>` | 0; 2 not a JSON array |
| `harness task validate [--json]` | 0 clean; 1 problems listed |
| `harness task snapshot [--task <id>] [--repo <path>] [--json]` (user-run; denied to agents) | 0 recorded; 1 the task has no brief; 2 not a git repository or no task |
| `harness gate` (full run) | also writes `writeup.md` through this module and prints `Write-up: <path>` as its last line (see `src/gate/README.md`) |
| `harness writeup [--task <id>] [--repo <path>] [--out <file>] [--json]` | 0; 1 no task or brief; 4 `--out` inside a team repo (refused) |

### Reading a ticket from Jira

`harness intake --jira SHOP-102` fetches the issue itself and then behaves exactly like
`--from` on the text it fetched. It is read-only: one `GET <baseUrl>/rest/api/2/issue/<KEY>?fields=summary,description[,<acceptanceField>]`
(API v2, whose description is wiki-markup text that `parse.ts` already reads), 20 second
timeout, no redirect followed, an error shows the status and the key and never the body.
The ticket is composed as a pasted one would read (`h1. <summary>`, `h2. Description`, the
description, and `h2. Acceptance Criteria` with the acceptance field's text when one is
configured) and saved to the inbox as `<KEY>.txt`, the same place a pasted ticket goes.

Settings (machine config only; a repository's `.harness/config.json` is not consulted, so a
repository cannot point the token at another host), set by the user in a terminal:
`jira.baseUrl` (https only; the only host called), `jira.acceptanceField` (for example
`customfield_10042`; absent means the criteria stay inside the description), `jira.emailEnv`
(name of the variable holding the account email, default `HARNESS_JIRA_EMAIL`) and
`jira.tokenEnv` (default `HARNESS_JIRA_TOKEN`). The token comes from the environment only and is
never stored, printed or logged. When the email variable is set the request uses HTTP Basic
`email:token` (Jira Cloud); otherwise `Authorization: Bearer <token>` (Data Center personal
access tokens). `--jira` and `--from` together exit 2.

The brief stores the ticket key as `jiraKey` (kept across answers and re-reads), so
`harness jira comment` knows which ticket to write to (see `src/jira/README.md`).

### The queue: `--jira-next`

`harness intake --jira-next` takes the first ticket of a search you saved as `jira.filter`
(a JQL string, or a saved filter id, which is sent as `filter=<id>`), then does exactly what
`--jira <KEY>` does. Read-only: one `GET <baseUrl>/rest/api/2/search?jql=<jql>&maxResults=1&fields=key`
first (same host pinning, no redirect followed, an error never shows the body), then the
issue request. An empty search exits 1 with "no ticket in the filter". It cannot be combined
with `--jira` or `--from`. Set it once in a terminal:
`harness config set jira.filter "project = SHOP AND status = \"Ready for dev\" ORDER BY priority DESC"`
(non-empty, one line).

All `task` subcommands and `phase` take `--repo <path>` (default: the git
root of the working directory). In the team setting, the `task` subcommands
that write (`add`, `claim`, `done`, `fail`, `release`, `import`) refuse a
configured team repo with exit 4, because the ledger lives inside the repo. Priority: lower number = more urgent
(default 2). `--stale-minutes` defaults to 90. A task with no `paths` counts
as touching the whole repo, so it never runs beside another claim.
`--session <id>` (or `HARNESS_SESSION_ID`) also writes the phase into that
session's state, which the guard reads.

## A real run

Recorded on a temp `~/.harness` with one temp repo `orders-api` registered
in the config (team setting). Only the absolute temp paths were shortened to
`~/.harness` and `~/work`.

The ticket (`ticket.txt`, Jira wiki markup):

```
h1. Add order total
h2. Description
Customers want to see the order total on the order page.
h2. Acceptance Criteria
# GET /orders/:id returns total
# total stored in orders.total column
# The order page shows the total
# Only admins can see the cost price via GET /orders/:id/cost
# The page must load fast
```

```
$ harness intake --from ticket.txt    # exit 0
Brief t-2b49dd5275: Add order total
Saved: ~/.harness/briefs/t-2b49dd5275.json
Repos: orders-api (current task set to t-2b49dd5275)

Acceptance criteria (5):
  AC1  [api 0.95] GET /orders/:id returns total
        check: e2e-http - GET /orders/:id -> 200; body has "total" in orders-api (prove it red first)
        run:   harness verify drive --method GET --path /orders/:id --expect-status 200 --expect-body total
        repo:  orders-api (resource)
  AC2  [db 0.90] total stored in orders.total column
        check: e2e-db - Table orders has column total after the change (test database only) in orders-api (prove it red first)
        run:   harness verify db --table orders --expect-columns total
        repo:  orders-api (resource)
  AC3  [ui-artifact 0.85] The order page shows the total
        check: manual - Manual: capture ac3-the-order-page-shows-the-total.png showing "The order page shows the total" in orders-api; the write-up links it (prove it red first)
        repo:  orders-api (default)
  AC4  [api 0.95] Only admins can see the cost price via GET /orders/:id/cost
        check: e2e-http - GET /orders/:id/cost -> 200 in orders-api; live drive, or a unit test named "AC4:" that names the route "GET /orders/:id/cost" (until answered: 403 Forbidden) (prove it red first)
        run:   harness verify drive --method GET --path /orders/:id/cost --expect-status 200
        repo:  orders-api (resource)
  AC5  [untestable 0.70] The page must load fast
        EARS: The page shall load fast [measurable: a time limit, e.g. p95 under 500 ms].
        check: waits for an answer (see Questions)
        repo:  orders-api (default)

Units (in order; each one repo, a short piece of work):
  U1  orders-api: orders (AC2, AC1), about 5 files
  U2  orders-api: orders (AC4), about 3 files, after U1
  U3  orders-api: general (AC3, AC5), about 5 files

Assumptions (taken without asking; say so if one is wrong):
  - AC1: expected status 200 for GET
  - AC4: expected status 200 for GET
  - AC4: until answered, assumed "403 Forbidden" (security)

Questions (2; answer them all in one message, e.g. "Q1: B". A question you skip keeps its recommended option, except those marked "blocks", whose criterion waits for you):
Q1 [meaning, AC5, blocks AC5] AC5 ("The page must load fast") is not testable as written. I would check: "The page shall load fast [measurable: a time limit, e.g. p95 under 500 ms].". What should replace the bracketed part?
   A) p95 under 500 ms  (recommended)
   B) p95 under 200 ms
   C) p95 under 1 s
   D) Another limit: say which
   E) Drop it from this ticket
Q2 [security, AC4] AC4 restricts access. What should a caller without access get?
   A) 403 Forbidden  (recommended)
   B) 404 Not Found (hide that it exists)
   C) 401 and a sign-in prompt
Record an answer: harness intake answer t-2b49dd5275 --q <n> --answer "<letter or text>"

Next: harness phase tests (write the failing checks, prove them red), then harness phase implement, then harness verify, harness gate, harness writeup.
```

Answering re-classifies the criterion (the rest of the brief is printed again
and is unchanged apart from these lines):

```
$ harness intake answer t-2b49dd5275 --q 1 --answer "p95 under 500 ms"    # exit 0
Recorded Q1: p95 under 500 ms
...
  AC5  [nonfunctional 0.96] The page must load fast
        check: manual - Measure before and after: p95 < 500 ms in orders-api; record both numbers as an artifact (prove it red first)
...
  - AC5: answered Q1 (meaning): p95 under 500 ms
```

```
$ harness phase tests    # exit 0
Task t-2b49dd5275: phase tests (entry 1). (No session id given: recorded for the task only.)
You may add or change test files now. Each entry is counted and shown in the write-up; the gate still checks for deleted or weakened tests.

$ harness phase implement    # exit 0
Task t-2b49dd5275: phase implement. (No session id given: recorded for the task only.)
Change product code now. Test and golden files are read-only in this phase; run `harness phase tests` to change them.

$ harness phase status    # exit 0
Task t-2b49dd5275: implement since 2026-10-19T11:18:16.814Z; tests phase entered 1 time(s).
```

The write-up before any gate run (no `evidence.json` yet):

```
$ harness writeup    # exit 0
# Add order total

## Why
Customers want to see the order total on the order page.

## What changed
- `src/orders.ts` modified (+1 -1)
- `test/orders.test.ts` new, untracked

## Scope
- In this change: AC1 (GET /orders/:id returns total); AC2 (total stored in orders.total column); AC3 (The order page shows the total); AC4 (Only admins can see the cost price via GET /orders/:id/cost); AC5 (The page must load fast)
- Nothing else: changes outside these criteria are not part of this ticket.

## Tradeoffs
- AC4: until answered, assumed "403 Forbidden" (security)

## Blast radius
- Repos: orders-api (this change)
- Routes named in the ticket: GET /orders/:id, GET /orders/:id/cost
- Tables named in the ticket: orders (columns: orders.total)
- Files changed here: 2

## Verification
Gate: not run (no evidence file for this task). Run `harness gate` before opening the PR.

| Criterion | Check | Result | Artifact |
|---|---|---|---|
| AC1 GET /orders/:id returns total | e2e-http: GET /orders/:id -> 200; body has "total" in orders-api | gate not run | - |
| AC2 total stored in orders.total column | e2e-db: Table orders has column total after the change (test database only) in orders-api | gate not run | - |
| AC3 The order page shows the total | manual: Manual: capture ac3-the-order-page-shows-the-total.png showing "The order page shows the… | gate not run | - |
| AC4 Only admins can see the cost price via GET /orders/:id/cost | e2e-http: GET /orders/:id/cost -> 200 in orders-api; live drive, or a unit test named "AC4:" that names the route "GET /orders/:id/cost" (until answered: 403 Forbidden) | gate not run | - |
| AC5 The page must load fast | manual: Measure before and after: p95 < 500 ms in orders-api; record both numbers as an artifact | gate not run | - |

Tests were added or changed in the tests phase (entered 1 time(s)); the gate has not checked them yet.

## Assumptions
- AC1: expected status 200 for GET
- AC4: expected status 200 for GET
- AC4: until answered, assumed "403 Forbidden" (security)
- AC5: answered Q1 (meaning): p95 under 500 ms

## Feedback wanted
- Open question Q2 (security, AC4): AC4 restricts access. What should a caller without access get? I went with "403 Forbidden"; tell me if that is wrong.
- AC3 is checked by hand (Manual: capture ac3-the-order-page-shows-the-total.png showing "The order page…); please look at the artifact.
- AC5 is checked by hand (Measure before and after: p95 < 500 ms in orders-api; record both numbers as an…); please look at the artifact.

## Branch and next steps
Branch: `feature/order-total` (local only; the harness never pushes).
1. Push the branch: `git push -u origin feature/order-total`
2. Open a pull request from it with this text as the description.
3. Request review.

(saved: ~/.harness/runs/orders-api-94f4f7/t-2b49dd5275/writeup.md)
```

The personal ledger, in a second temp repo:

```
$ harness task add --title "Schema for totals" --priority 1 --acceptance "total stored in orders.total column" --paths db/migrations    # exit 0
Added T-001: tasks/T-001-schema-for-totals.md
T-001  Schema for totals  (priority 1, todo)
  paths: db/migrations
  acceptance:
    - total stored in orders.total column

$ harness task add --title "Expose total" --priority 0 --acceptance "GET /orders/:id returns total" --paths src/routes --depends-on T-001    # exit 0
Added T-002: tasks/T-002-expose-total.md
...
$ harness task next    # exit 0
T-001  Schema for totals  (priority 1, todo)
  paths: db/migrations
  acceptance:
    - total stored in orders.total column
Claim it: harness task claim T-001

$ harness task claim T-001 --by claude    # exit 0
Claimed T-001; it is now the current task for this repo.
T-001  Schema for totals  (priority 1, claimed)
  paths: db/migrations
  acceptance:
    - total stored in orders.total column
  claimed by claude at 2026-10-19T11:18:17.321Z
Next: harness phase tests (write the failing checks), then harness phase implement.

$ harness task claim T-001 --by codex    # exit 1
Refused: T-001 is already claimed by claude at 2026-10-19T11:18:17.321Z (stale after 90 minutes)

$ harness task next    # exit 1
No task is ready.
  T-002: waits for T-001

$ harness task done T-001 --commit 51e6e34    # exit 0
Done T-001 at 51e6e34.

$ harness task list    # exit 0
T-001    done     p1  Schema for totals
T-002    todo     p0  Expose total  (after T-001)

$ harness task validate    # exit 0
Task ledger ok: 2 task(s), no problems.
```

A task file after `done`:

```
---
id: T-001
title: Schema for totals
priority: 1
status: done
depends_on: []
paths: ["db/migrations"]
acceptance: ["total stored in orders.total column"]
claimed_at: "2026-10-19T11:18:17.321Z"
claimed_by: claude
commit: 51e6e34
created_at: ...
done_at: ...
---

# Schema for totals
```

### Green-at-base, command-line and unattended

Recorded the same way on a repository `orders-api` whose README already
mentions `--json`, with `--unattended` (no one to answer):

```
h1. Export orders
h2. Description
Add GET /orders/export for finance.
h2. Acceptance Criteria
# GET /orders/export returns the orders as CSV
# `--json` prints a JSON array of orders
# All existing tests still pass
# The README documents the `--json` flag
# A pure helper with unit tests formats the orders.total column
# The export page must load fast
```

```
$ harness intake --from ticket.txt --unattended    # exit 0
Brief t-87f9e60b08: Export orders
Saved: ~/.harness/briefs/t-87f9e60b08.json
Repos: orders-api (current task set to t-87f9e60b08)

Acceptance criteria (6):
  AC1  [api 0.95] GET /orders/export returns the orders as CSV
        check: e2e-http - GET /orders/export -> 200; body has "orders" in orders-api (prove it red first)
        run:   harness verify drive --method GET --path /orders/export --expect-status 200 --expect-body orders --criterion AC1
        repo:  orders-api (resource)
  AC2  [unit 0.88] `--json` prints a JSON array of orders
        check: unit - Unit test named "AC2: `--json` prints a JSON array of orders" in orders-api that runs the command-line tool `orders-api` with `--json` (the built command line or its entry point) and checks its output; red at the base commit, green after the change (prove it red first)
        run:   npm test -- -t "AC2:"
        repo:  orders-api (default)
  AC3  [unit 0.90] All existing tests still pass
        check: gate - proved by the gate: tests:base passes in this run
        repo:  orders-api (default)
  AC4  [unit 0.90] The README documents the `--json` flag
        check: unit - Unit test named "AC4: The README documents the `--json` flag" in orders-api that reads README.md and checks it contains "--json"; green at the base commit and must stay green after the change (green-at-base: README.md already holds "--json", so the check passes before the change and must keep passing)
        run:   npm test -- -t "AC4:"
        repo:  orders-api (default)
  AC5  [unit 0.90] A pure helper with unit tests formats the orders.total column
        check: unit - Unit test named "AC5: A pure helper with unit tests formats the orders.…" in orders-api; red at the base commit, green after the change (prove it red first)
        run:   npm test -- -t "AC5:"
        repo:  orders-api (resource)
  AC6  [nonfunctional 0.96] The export page must load fast
        check: manual - Measure before and after: p95 < 500 ms in orders-api; record both numbers as an artifact (prove it red first)
        repo:  orders-api (default)

Units (in order; each one repo, a short piece of work):
  U1  orders-api: orders (AC1, AC5), about 5 files
  U2  orders-api: general (AC2, AC3), about 4 files
  U3  orders-api: general (AC4, AC6), about 4 files

Assumptions (taken without asking; say so if one is wrong):
  - AC1: expected status 200 for GET
  - AC6: answered Q1 (meaning): p95 under 500 ms (unattended: no one to answer)

Questions (1; answer them all in one message, e.g. "Q1: B". A question you skip keeps its recommended option, except those marked "blocks", whose criterion waits for you):
Q1 [meaning, AC6, assumed: unattended] AC6 ("The export page must load fast") is not testable as written. I would check: "The export page shall load fast [measurable: a time limit, e.g. p95 under 500 ms].". What should replace the bracketed part?
   A) p95 under 500 ms  (recommended)
   B) p95 under 200 ms
   C) p95 under 1 s
   D) Another limit: say which
   E) Drop it from this ticket
Questions marked "assumed: unattended" took their recommended option because no one was there to answer; they are in the assumptions too. Overturn one with the command below.
Record an answer: harness intake answer t-87f9e60b08 --q <n> --answer "<letter or text>"

Next: harness phase tests (write the failing checks, prove them red), then harness phase implement, then harness verify, harness gate, harness writeup.
```

AC2 is a unit check naming the command line; AC3 and AC4 are green at the
base commit (AC4 because the README already holds `--json`); AC5 is a
code-structure criterion, so it is `unit` although it names a table column;
AC6 waits for an answer in an interactive run and here took its recommended
option.

## Green-at-base and unattended intake

**Live optional (status-only `api` criteria).** An `api` criterion whose
expectation is only a status on a named route (no body, JSON, header, timing
or database expectation, and not the database-down case) is classified with
`liveOptional: true` and `liveOptionalRoute: "<METHOD> <path>"`. Its
description says "live drive, or a unit test named `<id>:` that names the
route `<METHOD> <path>`"; the `run:` line is unchanged. The gate's `e2e:<id>`
step passes on a fresh passing artefact or on a passing test named `<id>:`
in a test file that contains the route path, so the agent may skip
`harness verify launch` and `drive` when every `api` criterion is live
optional and it wrote the route tests. `harness gate prove-red` treats such a
check like a unit check once a changed test names it. Anything richer stays
live-only. See `src/gate/README.md`.

**Expectation changes in existing tests.** `harness phase tests
--expect-change "<file> <reason>"` (repeatable) records `{file, reason, at}`
under `expectChanges` in `phase.json`. The file must be a test file that
exists at the base commit (else exit 2, nothing recorded). The gate's tamper
step accepts a changed assertion literal in a declared file, and the
write-up prints "Expectations changed in existing tests (declared): <file>:
<reason>". Use it when the ticket really changes behaviour that an existing
test pinned.

**Green-at-base.** Some criteria must *keep* passing rather than start
failing: characterisation tests, "no behaviour change", "the existing tests
still pass", documentation-only changes, and "the README documents X" when
the README already holds X (a README criterion is a unit check that the named
file contains the named text; when the text is not there yet it is an ordinary
red-first check). Their check carries `greenAtBase: true` and a
`greenAtBaseReason`, is not `redFirst`, and shows as `green-at-base: <reason>`
in the brief and in the write-up's check column. `harness gate prove-red`
expects such a check green at the base commit, and the gate's
`acceptance:<id>` step asks only that the named test exists and passes now.
Plan lint counts it as covered. A document criterion is green-at-base only
when the file already holds every named text as a whole token (`--verbose`
does not hold `-v` or `--verb`); a lone single-letter flag is never enough
to name a text. See `src/gate/README.md`.

**Gate-proved criteria.** Some criteria a test cannot sensibly carry, because
the gate already knows the answer: "CI-equivalent checks (lint, typecheck,
test, build, format:check) still pass", "all existing tests still pass",
"nothing else changes in the tree", "the pin commit is still in the history"
(no rebase, no force-push). Their check is `kind: 'gate'` with
`gateSteps` (the steps the sentence names; "CI" or "checks" means `lint`,
`typecheck`, `tests:base`, `build`, in that order; `format` counts as `lint`),
`scopePaths` (the paths the ticket says change, read from `code` spans in
sentences that talk about changing something, else the criterion's own paths;
the change may touch nothing else) and `keepsHistory: true` (the brief's base
commit stays an ancestor of HEAD). The criterion's kind stays `unit`; the
check description starts "proved by the gate: <what>" and the write-up's check
column says "gate: <what>". A sentence that names a route, a status code, a
table or column, or a quoted command line, or that says more than "the checks
pass", is not a gate criterion. A "nothing else changes" criterion with no
path anywhere in the ticket and no history wording stays an ordinary
criterion, because the gate would have nothing to check. Plan lint counts a
gate check as covered (it is not red-first); `harness gate prove-red` says
"proved by the gate's own steps" and does not fail. This replaces the
round-1 reading of "existing tests still pass" as green-at-base.

**Unattended.** `harness intake --from <file> --unattended` (or
`HARNESS_UNATTENDED=1`) is for runs where no one can answer: the personal
runner (`harness run`) always builds its briefs this way. A blocking question
no longer holds its criterion open; its recommended option is taken (an option
that only asks the person to answer, such as "Tell me the exact result to
check", is skipped for the next real one), the criterion is classified with it,
and the choice is recorded as an assumption ending in "(unattended: no one to
answer)". The question stays in the Questions section, marked
"assumed: unattended", so a person can overturn it later with `harness intake
answer <id> --q <n> --answer "..."`, which replaces the assumption.
`harness intake answer <id> --all-recommended` does the same for a brief that
was built interactively.

## How the brief is built

1. **Parse** (`parse.ts`). Title from `Title:`/`Summary:`, the first heading,
   or the first line. Sections from Markdown headings, Jira `hN.`, bold labels
   or bare label lines. Criteria from the acceptance-criteria section:
   numbered, bulleted, `AC1:`, `[ ]`/`[x]`, Given/When/Then scenarios, tables,
   nested items and continuation lines; Jira `#`/`*` lists. Code blocks
   (``` / ~~~ / `{code}` / `{noformat}`) never become criteria. With no
   criteria list, `AC` labels, checkboxes, scenarios or an "Expected result"
   section count; failing those, list items and must/should/shall sentences
   are read as criteria with low confidence, and the brief asks to confirm
   them. Hidden Unicode is removed and counted.
2. **Classify** (`classify.ts`). Keyword and shape rules give a kind and a
   confidence: `api` (method + route, route + response words), `db`
   (`table.column`, "X table", stored in the database, SQL), `ui-artifact`
   (UI noun + visible verb), `nonfunctional` (a measure with a unit and a
   metric, or metric words), `unit` (code words or an outcome verb),
   `untestable` (vague words with nothing concrete, or no outcome). Some
   shapes decide the kind outright, before the scoring: a service that must
   answer (returns, responds, serves, runs) while its database is down,
   unreachable, unavailable, offline or refusing connections is `api` (a
   database that merely "fails" or "stopped" is not that shape, and a sentence
   that also says "available" or "database is up" is scored instead);
   characterisation, "no behaviour change", "existing tests still pass" and
   documentation-only criteria, and criteria about a document ("the README
   documents ...") are `unit`; so is a code-structure criterion ("a pure
   helper function", "a helper with unit tests", "extracted into a module",
   "no duplicated logic", "shared in one place"), even when it names a table,
   column or route. These wording shortcuts give way to the scoring when the
   criterion states an HTTP outcome (a status code, or a route that returns
   or answers) or, for the green-at-base wording, names a table or column
   ("The orders table is not duplicated ..." is `db`; so is "The helper
   column is added to the orders table"). A criterion that names a flag (`--json`,
   `-v`), an exit code ("exits 1 when ...", "non-zero exit") or printed output
   ("prints a table", "outputs ... to stdout") of a command-line tool, with no
   route in it. A criterion that is not testable as written gets an EARS
   rewrite with the missing fact in brackets, and a question.
3. **Map repos**: configured repo names, package names (scope dropped), paths
   that exist inside a repo, then the route or table resource matched against
   repo names, then the one repo the ticket names, then `--repo` / the current
   git root, then the only configured repo. Generic names (`api`, `web`,
   `orders`, …) match only in code form (`` `web` ``, `web/`, "web repo").
4. **Checks** (`redFirst: true`, except green-at-base ones, below): `unit` -> the repo's test script with
   a name filter for the criterion id (`jest`/`vitest -t`, `mocha --grep`,
   `node --test --test-name-pattern`), and the description names the command
   line the test runs (the quoted command, else the package's `bin` name, else
   the repo name) or the document and text it reads; `api` -> `harness verify
   drive --method --path --expect-status --expect-body`, plus `--expect-header
   "<Name>~<value>"` (or `"<Name>=*"` when the ticket gives no value) for a
   named response header such as `Content-Type: text/csv`, and for a
   database-down criterion two `run:` lines: the launch line with
   `--db-unreachable`, then the drive line with the status the ticket names
   (else a 5xx the sentence names, else 503; the status written after the
   "database is down" wording wins over one written before it); a header name
   is read only as a whole word outside a route (`X-` names need that exact
   capital form and the word "header": `GET /x-ray/scan` names none); `db` -> `harness verify db --table
   --expect-columns|--expect-rows`; `ui-artifact` -> manual with an artifact
   name; `nonfunctional` -> `verify drive --repeat 20 --expect-p95-ms <n>` for
   a timed route, a before/after measurement otherwise, a question without a
   number; `untestable` -> question.
5. **Ambiguity gate** (`ambiguity.ts`): observable -> a command to run (no
   question); reasonable default -> an assumption; scope / security / privacy
   / UX fork or a missing fact -> a question with options and a recommended
   one (with `--unattended` a blocking question takes its recommended option
   instead; see "Green-at-base and unattended intake"). Caps: 3 open markers (criteria waiting for an answer) and 5 questions
   per batch, blocking first, then impact x uncertainty. These caps are
   conventions from a published spec template, not measured effects. Blocking
   questions over the caps are queued for the next batch; non-blocking forks
   over the cap take their recommended option and say so.
6. **Size gate** (`units.ts`): one unit per repo and area (path folder,
   else route resource, else table), at most about 5 estimated files each;
   database work before API, API before UI; a unit depends on an earlier unit
   that shares its resource, on the other repo's part of a criterion that
   spans repos, or (across repos, when it names no resource) on the layer
   below. Landing order = repos by their first unit.
7. **Plan lint**: every criterion needs a red-first, green-at-base or gate-proved check, or an open
   question; at least one criterion or a question asking for them; every
   criterion in a unit.

## Interfaces for other components

- **Current task**: `getCurrentTask(repoId)` / `setCurrentTask` in `brief.ts`.
- **Phase**: `setTaskPhase(repoId, taskId, phase)`, `getTaskPhase(repoId,
  taskId)` and `phaseForRepo(repoRoot)` in `phase.ts`. The guard reads the
  session state first (`src/lib/session` `getPhase`); `phaseForRepo` is meant
  as its fallback when the session has no phase.
- **Evidence -> criterion**: the write-up links a gate step or an e2e
  artifact to a criterion when the step name or artifact id contains the
  criterion id as a word (`acceptance:AC1`, `AC1-http`). Anything else shows
  as "not linked to a gate step".
- **Artifacts** are shown relative to the run folder (`e2e/AC1-http.json`),
  never as absolute local paths.
- **verify flags**: the `run:` lines use `harness verify drive --method
  --path --expect-status --expect-body --repeat --expect-p95-ms` and `harness
  verify db --table --expect-columns --expect-rows`, plus two flags that
  `harness verify` has to accept: `--expect-header` on drive and
  `--db-unreachable` on launch. A brief's `command` holds one `run:` line per
  line of text (the database-down check has two); the verify component
  must accept these or the brief's text changes with it.

## Limits

- Classification is keyword rules. It reports a confidence and the rule that
  fired; low-confidence kinds and prose-read criteria are listed under
  "Feedback wanted" in the write-up.
- The file estimate per unit is a rule of thumb (named paths, else 2-3 per
  criterion), not a measurement of the change.
- The ledger lock is a directory in the git common dir (shared by worktrees
  of one clone); two separate clones of one repo do not share it.
