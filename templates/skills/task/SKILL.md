---
name: task
description: Take one coding task from intake to a proven, written-up change. Use it for every ticket or task (a pasted Jira ticket, a task from the tasks/ ledger, or a one-off change) before writing any code; it gives the exact harness command for each phase and what its output must show.
---

# Task: from ticket to proven change

You work inside a harness: hooks and checks around you that block unsafe
actions and refuse "done" without proof. This skill is the order of work.
Follow the phases in order. Each phase is one or two `harness` commands; read
their output before you move on.

**Evidence comes from commands, never from prose.** A check passed only when
a command you ran printed that it passed, in this session, on the current
code. "I believe it works" and "the tests should pass" are not evidence.
Earlier sessions' claims are not evidence either: run the command again.

**Run shell commands one at a time.** The opaque-command rail refuses
compound commands: `a && b`, `a; b`, a pipe into a second command, and
subshells. Run each command on its own and read its output before the next.

Words used here:

- **brief**: the harness's private copy of the work, split into numbered
  acceptance criteria (AC1, AC2, ...), each with a planned check.
- **check**: a test or an end-to-end assertion that proves one criterion.
- **red / green**: a check fails (red) or passes (green).
- **gate**: `harness gate`, the done-gate. It runs every check and writes
  `evidence.json`. Its verdict is PASS, FAIL or BLOCKED.
- **rail**: a safety rule the harness enforces (no force-push, test databases
  only, no secrets in commits, ...). A rail blocks the command; it cannot be
  switched off from here.
- **artefact**: a saved end-to-end result (an HTTP exchange or database rows)
  tied to the exact state of the code that produced it.

{{CLI_NOTE}}

## The phases at a glance

| # | Phase | Command | Move on when |
|---|---|---|---|
| 1 | Intake | {{#team}}`harness intake --from <file>` (the ticket saved to a file){{/team}}{{#personal}}`harness task next`, then `harness task claim <id>`{{/personal}} | the brief is printed and `harness intake lint` exits 0 |
| 2 | Tests | `harness phase tests`, write the failing checks, `harness gate prove-red` | every criterion's check is proven red |
| 3 | Implement | `harness phase implement`, change the product code | the new checks pass when you run them |
| 4 | Verify (only when a criterion is `api` or `db`) | the `run:` lines of the brief (`harness verify ...`) | every api/db criterion has a fresh artefact |
| 5 | Gate | `harness gate` | it prints PASS, or you recorded BLOCKED with a reason |
| 6 | Write-up | the gate already wrote it; read it and report{{#personal}}, then `harness land` (it marks the task done){{/personal}} | the write-up is shown to the user |

Never reorder 2 and 3: the checks exist and fail before the code changes.

**Match the work to the brief.** Look at the kind of each criterion in the
brief. When no criterion is `api` or `db`, skip phase 4 entirely (no `harness
verify launch`, no `harness verify drive`) and go tests -> implement -> gate
-> write-up. When the brief has `api` or `db` criteria, launch once, drive
every `run:` line, and clean up once (phase 4).

## 1. Intake

{{#team}}
The user pastes a ticket (title, description, acceptance criteria). Save the
ticket text exactly as pasted to a file with your file-writing tool in the
harness inbox folder, `{{INBOX}}/` (outside every repository; the install
pre-approves your file tool there, so no permission prompt stops a session).
Never write it inside a team repository. Then give intake that file:

```
harness intake --from <the ticket file>
```

Do not pipe the ticket through the shell (a here-document or `echo`): tickets
hold backticks, quotes and `$`, which the shell or the agent's own permission
check reads as code, and the command is refused. `--from -` (standard input)
exists for people typing in a terminal.

When the user gives a ticket key (for example `SHOP-102`) instead of pasted
text, run `harness intake --jira SHOP-102`; it reads the ticket itself.

When the user says which repository the ticket is in, add
`--repo <that repository's folder>` to the intake command; it wins over the
harness's own guess. When the brief's `repo:` line names a repository the
user did not expect, ask before going on, and run intake again with `--repo`.

Expected output (shape):

```
Brief t-<10 hex>: <ticket title>
Saved: ~/.harness/briefs/t-<10 hex>.json
Repos: <repo> (current task set to t-<10 hex>)

Acceptance criteria (N):
  AC1  [api 0.95] <criterion>
        check: e2e-http - <what will be asserted> (prove it red first)
        run:   harness verify drive --method GET --path /x --expect-status 200 --criterion AC1
        repo:  <repo>
  ...
Units (in order; each one repo, a short piece of work):
  U1  <repo>: <area> (AC1, AC2), about 5 files
Assumptions (taken without asking; say so if one is wrong):
Questions (...):
Q1 [meaning, AC5, blocks AC5] ...
Next: harness phase tests (write the failing checks, prove them red), then ...
```

What to do with it:

- **Questions.** Show the user every question exactly as printed, in one
  message, with the options and the recommended one. Ask nothing else.
  Record each answer with
  `harness intake answer <brief id> --q <n> --answer "<letter or text>"`.
  When the question is that the ticket has no acceptance criteria and the
  user gives them, pass the criteria themselves as the answer text (several:
  separate them with `;`), not the option letter.
  A question you do not get an answer to keeps its recommended option,
  except one marked `blocks`: that criterion waits. Work on the other
  criteria meanwhile.
- **Assumptions** are taken without asking; list them in your reply so the
  user can object.
- **Units.** Work through the units in the printed order, one at a time. A
  unit names one repo; stay inside it.
- Run `harness intake lint`. Exit 0 means every criterion has a red-first
  check or an open question. Exit 1 lists what is missing: fix the brief
  (answer the question, or ask the user) before coding.
- To read a brief again, use `harness intake show [id]`, its alias `harness
  brief [id]`, or `harness intake list` for all briefs. No other brief
  command exists; do not guess one.
- A criterion that must keep passing (a characterisation test, "no behaviour
  change", documentation only) is marked green-at-base: its check is allowed
  to pass at the base commit, and `harness gate prove-red` reports that as
  expected.
- Without a person to answer (an unattended run), `harness intake --from
  <file> --unattended` takes each recommended option and records it as an
  assumption; for a brief that already exists, run `harness intake answer
  <id> --all-recommended`.
{{/team}}
{{#personal}}
The work comes from the task ledger in `tasks/` (one Markdown file per task).
Pick the next task and claim it, so no other session takes it:

```
harness task next
harness task claim <id> --by <your agent name>
```

Expected output of `task claim`:

```
Claimed T-001; it is now the current task for this repo.
T-001  <title>  (priority 1, claimed)
  paths: <paths the task may touch>
  acceptance:
    - <criterion>
Next: harness phase tests (write the failing checks), then harness phase implement.
```

- `task next` exit 1 means nothing is ready; it lists why (a task waits for
  another). Tell the user and stop; do not invent work.
- To read the brief later: `harness intake show [id]` or its alias `harness
  brief [id]`; `harness intake list` lists all briefs. No other brief command
  exists.
- A criterion marked green-at-base must keep passing; its check may pass at
  the base commit, and `harness gate prove-red` reports that as expected.
- A criterion whose check is `gate` ("CI checks still pass", "nothing else
  changes", "the history is kept") needs no test: the gate proves it from its
  own steps, the changed paths and git. Write no test for it.
- `task claim` exit 1 means another session holds it, a dependency is open,
  or the paths overlap a claimed task. Run `harness task next` again.
- Stay inside the task's `paths`. Touching other files is scope growth (see
  "Stop the line").
- Work and commit on the branch `task/<id>` (`git switch -c task/<id>`,
  unless `harness run` already started you on it in its own worktree).
  `harness land` lands that branch; never commit the work on main.
- For a one-off request typed into the chat, write it to a file and run
  `harness intake --from <file>` so it gets a brief and checks like any task.
{{/personal}}

## 2. Tests phase: write the failing checks first

```
harness phase tests
```

Expected: `Task <id>: phase tests (entry 1).` and a line saying you may add
or change test files now. Outside this phase the hooks block edits to test
and golden files.

For every criterion, write the check the brief planned:

- `unit`: a test named after the criterion id (for example `AC1 returns the
  total`), so the gate can link it. Use the repo's test runner and the place
  where its tests live (the always-on file and the hook notes say where).
- `api` / `db`: an end-to-end assertion you will run in phase 4 with the
  brief's `run:` line. If the route or table does not exist yet, the
  assertion is red now by construction; note that.
- `ui-artifact` and manual checks: name the artefact (screenshot, measured
  numbers) you will produce; there is nothing to run yet.

Then prove the checks are red at the base commit (the commit you started
from), without touching your working tree:

```
harness gate prove-red
```

Expected: one line per check with `red` (good: it fails without your change)
or `green` (bad: the check does not test the change; rewrite it). Every
unit check must be proven red; the gate fails a check that never was. When
the brief has only `api` / `db` checks, prove-red says there is nothing to
run at the base commit and exits 0: those checks are red until phase 4
records their artefacts on the changed code.

Do not weaken a check to make it pass later. Deleting a test, adding
`.only`/`.skip`, or dropping assertions is caught by the gate's tamper step.
So is changing the expected value in a test that already existed. When the
ticket really changes that behaviour, declare it:
`harness phase tests --expect-change "<test file> <why the expectation changes>"`
(the file must exist at the base commit; the write-up lists it for review).
If a check is wrong, come back to this phase (`harness phase tests`), fix it,
and prove it red again; each entry is counted and shown in the write-up.

## 3. Implement phase

```
harness phase implement
```

Expected: `Task <id>: phase implement.` Test files are read-only now.

- Change the product code for the current unit only.
- After each edit the hooks may add a short note: a lint error on the file you
  just edited, or a standard of this repo that the edit breaks, with its fix.
  Fix it now; the gate checks the same rules.
- Run the checks you wrote and the repo's own commands (the always-on file
  lists them per repo: build, typecheck, lint, one test). Run one test file
  while iterating; run the whole suite once before the gate.
- To undo a commit, run `git revert --no-commit <sha>` and commit with a
  subject in the repository's convention (for example `revert: <original
  subject>`), because the default `Revert "..."` subject can fail the
  commit-subject standard and amending is refused.
- `harness phase status` shows the phase and how often you entered the tests
  phase.

## 4. Verify: prove the change end to end

Only when the brief has an `api` or `db` criterion. With none, skip this
phase: do not launch or drive anything.

An `api` criterion whose check says "live optional" expects only a status. When
every `api` criterion is marked "live optional" and you wrote the route tests
(each test named `<id>:` and naming the route, as the check says), you may skip
launch and drive: the gate accepts the passing test. Any `api` criterion that
expects a body, JSON, a header, a timing or a database effect, and every `db`
criterion, still needs the live drive.

For every `api` and `db` criterion, run the brief's `run:` line against the
running service and the test database, as printed: it ends with
`--criterion <id>`, which links the artefact to that criterion (the gate
counts only linked artefacts). Add expectations (`--expect-json`,
`--expect-body`) when they make the check stronger; never drop the
criterion. A `:id` or `<id>` in a path is yours to fill with a real id. The
usual sequence:

```
harness verify launch          # start the touched services on free ports with a per-run test database
harness verify doctor          # the database is a marked test target, migrations applied, services answer
harness verify drive --method GET --path /orders/1 --expect-status 200 --expect-body total --criterion AC1
harness verify db --table orders --expect-columns total --criterion AC2
harness verify evidence        # lists the artefacts: each must say fresh
harness verify cleanup         # stop services, drop the run database; the evidence stays
```

- A criterion that says the service must keep answering while its database
  is down: launch with `harness verify launch --db-unreachable`, then drive
  the `run:` line (it expects a 503, or the status the ticket names).
- To check a response header, use `harness verify drive --expect-header
  "Name=value"` (exact), `"Name~text"` (contains) or `"Name=*"` (present).
- `harness verify env` prints the run's variables (base URLs, database name)
  for your own `curl` or `sqlcmd` commands. Use them; never point a command
  at a database by hand.
- Database commands reach only targets the user marked as test. A denied
  database command is a rail, not a bug: do not retry it another way.
- On a database marked read-only, run only a `SELECT`, inline (`sqlcmd -Q`);
  for any change, stop and ask the user.
- An artefact is fresh only for the exact code that produced it. Change the
  code, and you must drive the check again.
- Manual checks (`ui-artifact`, measurements): produce the named artefact and
  say where it is.

## 5. Gate

```
harness gate
```

The gate runs, cheapest first: tamper check, secret scan, build, typecheck,
lint, the standards checks, the tests (the ones that existed before you
started, plus your checks), coverage, feature-map drift, the fresh end-to-end
artefacts, and the affected packages. It prints each step, its result, and
what to do next, and writes `evidence.json`.

- **PASS** (exit 0): you may stop; read the write-up the gate wrote. The stop
  hook reads this evidence; it lets you finish only while the code is exactly
  what the gate saw. Edit anything afterwards and you run the gate again.
- **FAIL** (exit 1): read the reasons, fix the cause in the right phase
  (product code in implement; a wrong check in tests), and run the gate
  again. Re-runs repeat only the steps your change invalidated.
- **BLOCKED** (exit 4): the honest exit when the work cannot pass for a reason
  you cannot fix (see "Stop the line"). Record it with the reason, in one
  sentence:

```
harness gate --blocked "<what blocks the work and what you need>"
```

  Then tell the user the same reason and what you need from them. BLOCKED is
  a legitimate outcome; gaming the gate is not.

If you try to stop without a fresh PASS or BLOCKED, the stop hook stops you
and repeats "run `harness gate`". After {{GATE_ATTEMPTS}} attempts it lets you
go and marks the task as capped; a capped task can never claim PASS.

## 6. Write-up

The gate writes the write-up itself at the end of every full run (PASS, FAIL
or BLOCKED) and prints `Write-up: <path>` as its last line. Your last step is
to read that file and report it to the user; do not write it yourself. Run
`harness writeup` only to rebuild it after you changed something.

It is built from the brief and the evidence: Why, What changed,
Scope, Tradeoffs, Blast radius, Verification (a table: criterion -> check ->
result -> artefact), Assumptions, Feedback wanted, and the branch with the
next steps. Show it to the user as printed. With no brief the gate says so
in one line and there is nothing to show.

- Do not edit the verification table by hand and do not add results to it.
  If a row says "gate not run" or "not linked", go back and fix that instead.
- Add one or two plain sentences under Tradeoffs or Feedback wanted only when
  they help the reviewer; keep the rest.
{{#team}}
- One write-up per touched repo. With several repos, give the landing order
  the write-up prints.
- Commit on a local branch if the user wants commits: one logical change per
  commit, subject in the form the repo's history uses, no AI attribution
  trailers. **Never push and never open a pull request**: both are denied in
  this setting. The user pushes and opens the pull request with the write-up.
{{/team}}
{{#personal}}
- Land it: `harness land` is the only way onto main. It checks the evidence
  against the branch tip, merges main in if needed (never a rebase), re-runs
  the invalidated gate steps, fast-forwards main, pushes, and waits for CI.
  On a red CI it reruns once, tries one fix, and otherwise reverts the task
  commit and re-queues the task.
- The landing commit marks the task done in `tasks/` (status, commit,
  evidence), so there is no `harness task done` to run after it. If the
  work could not be finished: `harness task fail <id> --reason "<one sentence>"`.
- Never force-push and never rewrite history (no `rebase`, `reset --hard`,
  `commit --amend` on pushed commits). The rails block these.
{{/personal}}

## Stop the line

Stop working and tell the user, in one short message, when any of these is
true. These are fixed triggers; "should I keep going?" is never a question
to ask instead.

1. **A rail would be touched**: the next step needs a command a rail blocks
   (push, a non-test database, a secret file, a harness or agent setting).
   Do not look for another way to run it.
2. **An irreversible action is needed**: deleting data, a migration on a
   shared database, anything that cannot be undone by reverting a commit.
3. **The same gate step fails 3 times after fixes.** Record
   `harness gate --blocked "<step> fails after 3 fixes: <why>"`.
4. **The problem cannot be reproduced**: the bug the ticket describes does
   not happen on the test setup, so no check can go red.
5. **Scope grows beyond the ticket's units**: the change needs repos, files
   or behaviour the brief does not cover.
{{#personal}}

`harness run check-stop` reports these conditions when the runner drives you.
{{/personal}}

For 1-5, record BLOCKED with the reason (phase 5) so the stop hook lets you
go, and say what you need. Never stop silently, never weaken a check, and
never claim a result you did not get from a command.

## Pausing and resuming

When the session ends early (a usage limit, a context compaction), the
harness writes a trail with your intent, progress and next command{{#personal}}
and makes a `wip:` commit on the task branch{{/personal}}. A new session shows
the trail at the start. Resume from its next command, and re-run the gate:
"verified" from an earlier session is never trusted.

## When something is blocked by a rail

The harness explains every block in one line. Read it. Common ones:

- `git push`, `gh pr create`{{#team}} (team: always blocked){{/team}}{{#personal}} (personal: only `harness land` pushes){{/personal}}.
- Force-push, `reset --hard`, `rebase`, `--no-verify`, changing `core.hooksPath`.
- Database commands whose target is not marked as test, or that read a
  script or connection string the harness cannot check.
- Reading, staging or copying `.env*` and key files.
- Editing harness state or agent configuration (`~/.harness`, settings files,
  hooks, permission rules).
- Harness admin commands (`install`, `apply`, `undo`, `config set`,
  `db mark`, ...): only the user runs those, in a terminal.

None of these is a reason to try a different spelling of the same command.
