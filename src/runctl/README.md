# Run control (`src/runctl/`, `harness run`)

Caps, stop-the-line, pause and resume, and the queue driver of the personal
setting (DESIGN §2.13). Every unattended loop that works keeps per-item
state in a durable file, a finish predicate, a hard cap and a resume note
(R-16): here the task ledger (`tasks/`), the gate's PASS, the caps below and
the trail.

## Commands

```
harness run [--agent claude|codex] [--once] [--max-tasks <n>] [--ci local|github|none] [--ci-command "<cmd>"]
            [--model <m>] [--turns <n>] [--unit-minutes <n>] [--ticket-minutes <n>]
            [--budget-usd <x>] [--attempts <n>] [--permission-mode <mode>]
            [--stale-minutes <n>] [--no-land] [--repo <path>] [--json]
harness run pause  [--task <id>] [--note "<text>"] [--json]
harness run resume [--task <id>] [--agent claude|codex] [--ci ...] [cap flags] [--json]
harness run check-stop [--task <id>] [--command "<cmd>"] [--irreversible "<what>"]
            [--not-reproduced "<what>"] [--session <id>] [--json]
```

| Exit | `run` / `resume` | `pause` | `check-stop` |
|---|---|---|---|
| 0 | every task landed (or the queue was empty) | paused | no stop condition holds |
| 1 | a task failed, hit a cap, was blocked, reverted or paused; the agent is missing | - | a stop condition holds (reasons printed) |
| 2 | usage | usage | usage |
| 4 | the team setting (the runner lands and pushes; never in a team repository) | - | - |

## The queue driver

For each task, until the queue is empty, `--once`, or `--max-tasks`:

1. `task next` (most urgent `todo`, or a claim older than `--stale-minutes`,
   default 90; dependencies done; paths disjoint from fresh claims).
2. Claim it in the main checkout's ledger; create (or reuse) the worktree
   `~/.harness-worktrees/<repoId>/<id>` (outside the protected `~/.harness`) on branch `task/<id>` from main, with
   the main checkout's `node_modules` linked in (nothing installed); build
   the brief and bind it to the worktree (the gate there resolves its repo
   id from the worktree path, so the brief's repo, units and base commit name
   that id); make it the current task of both.
3. A fresh headless session in the worktree (`src/runctl/session.ts`):

   ```
   claude -p <prompt> --output-format json --max-turns <turns> [--max-budget-usd <usd>] [--model <m>] --permission-mode acceptEdits [--allowedTools <rule>...]
   codex exec --full-auto [--model <m>] <prompt>
   ```

   with the wall-time cap as the process timeout. `--allowedTools` carries
   the allow rules of the worktree's committed `.claude/settings.json` (read
   from HEAD before the session): Claude Code applies a project's allow rules
   only once its trust dialog was accepted, which never happens for a fresh
   worktree in a headless session, so without them `harness gate` and the
   test runner were refused as "requires approval" (measured with Claude Code
   2.1.303: project rules ignored, the same rules at user level or with the
   folder trusted honoured). The prompt names the task file
   (`tasks/<file>.md`) and carries the task's text from the main checkout's
   ledger, fenced (a task file that was never committed is not in the
   worktree; to be read as the task, not as instructions about the
   harness), names the `task` skill, says the task is already claimed, to
   stay inside its paths, to commit on the branch without pushing or landing,
   to use `harness run check-stop` and record BLOCKED instead of asking, and
   gives the caps. After a stale claim or a pause, the earlier trail is
   added.
4. The gate, in process, on the worktree (a full run). Codex: while it
   FAILs, the driver re-prompts the same session with the gate's report
   (`codex exec resume --last <prompt>`), up to `--attempts` (default 3)
   sessions in all. Claude needs no driver loop: its Stop hook holds the
   turn until the gate passes or the attempt cap releases it.
5. PASS: uncommitted changes are committed only when the working tree is
   exactly the tree the gate passed; a branch with no change against main
   fails the task (`no change`) instead of landing an empty commit; then
   `harness land` (src/land) with the same CI choice and the run's agent as
   the fixer.
6. The ledger: landed -> `done`, carried by the landing commit itself (the
   task file with the commit and evidence; see src/land), the worktree
   removed (the branch stays); reverted -> already re-queued by the landing;
   refused or failed -> `failed` with the reason; BLOCKED -> `blocked` with
   the reason. Claims, failures, blocks and re-queues are written in the
   main checkout and stay uncommitted (local state); only `done` lands.

**A cap hit is a reportable outcome, never a retry**: the task is `failed`
with reason `cap:turns`, `cap:wall`, `cap:budget`, `cap:gate-attempts`
(the Stop hook released the agent: `cap_reached` in the evidence) or
`cap:ticket-wall` (the ticket's wall time ran out across sessions). A
session that ends early without a cap (a usage limit, a crash) pauses the
task (below) and stops the run.

## Caps (`caps.ts`)

From the machine config's `caps` (`turns` 80, `unitMinutes` 25,
`ticketMinutes` 60, `gateAttempts` 8, optional `budgetUsd`; chosen, no
evidence). Flags can only lower a cap. A session gets the unit's wall time,
never more than what is left of the ticket's. Without `budgetUsd` (config or
`--budget-usd`) Claude runs have no cost cap and the run says so; Codex has
no turn or budget flag, so its caps are wall time and the attempt count.

## Stop the line (`caps.ts`, `harness run check-stop`)

Fixed triggers; each returns one sentence the agent reports and records with
`harness gate --blocked "<reason>"`, never a question:

| Kind | Detected when |
|---|---|
| `rail` | `--command` would be refused by the guard (the same evaluation as the PreToolUse hook), or the instrumentation log holds `guard.deny` events for `--session` |
| `irreversible` | `--command` drops or truncates data, deletes every row, drops a column, force-pushes or deletes a remote branch, deletes a branch with `-D`, resets, cleans or rewrites history, deletes a home or root folder, or publishes (npm, GitHub release, docker push); or `--irreversible "<what>"` |
| `repeated-failure` | the same gate step failed in 3 consecutive full gate runs of the task, each recomputed (cache miss: the inputs changed, so a fix was tried); read from `gate.step` / `gate.verdict` events |
| `not-reproducible` | a bug task's check (title says fix/bug/crash/..., or the criterion came from an "Expected result" section) was proven green at the base commit by `harness gate prove-red`; or `--not-reproduced "<what>"` |
| `scope` | files changed since the task's base commit (committed or not) lie outside the units' paths and the task's `paths`; test files and `tasks/` are not counted; no declared paths means the whole repository |

## Pause and resume (`pause.ts`)

- `harness run pause` (or the runner, when a session ends early) writes the
  trail `~/.harness/trail/<id>.md` with `src/runctl/trail.ts` (intent,
  changed files, the last verdict marked as needing a re-run, the next
  command `harness run resume --task <id>`, the note) and makes the
  `wip: pause` commit on `task/<id>` with the hooks' own pause commit
  (`src/hooks/pause.ts`: never on main, never pushed, refused for secret
  files or secret-shaped content, repository hooks off).
- `harness run resume` reads the trail, prints it, re-claims the task if its
  claim lapsed, recreates the worktree if it is gone, **re-runs the gate
  first** (an inherited "verified" claim is never trusted) and continues:
  PASS lands without a new session; otherwise a fresh session gets the trail
  and the gate's report in its prompt. Landing closes the trail.
- The run state per task is `~/.harness/runs/<repoId>/<id>/run.json`
  (`worktree`, `branch`, `agent`, `status`: running, paused, landed, failed,
  reverted, blocked, passed); resume takes the agent from it.

## Files

```
~/.harness-worktrees/<repoId>/<id>/        the task worktree (branch task/<id>); a sibling of ~/.harness
~/.harness/runs/<repoId>/<id>/run.json     run state (resume reads it)
~/.harness/trail/<id>.md                   the trail (src/runctl/trail.ts)
```

## Instrumentation

`run.start`, `run.session` (cap kind, turns, ms), `run.task` (outcome,
sessions, ms, cost in thousandths of a USD as the agent reported it),
`run.stop`, `run.pause`, `run.resume`, `run.resume.gate`, `run.check-stop`
(counts per stop kind). Ids and counts only.

## A recorded run

`test/acceptance/run-claude.test.ts` on the build machine (Claude Code
2.1.303, haiku, 8 turns, 4 minutes per unit, 0.25 USD): one task (a typo in
README.md) in a repository without a harness install. Two runs, both the
same way: one session; the gate passed; land fast-forwarded main, the local
CI gate was green; the task was marked done. Wall 18.5 s and 17.4 s; the
cost Claude reported was 0.0062 and 0.0059 USD.

With the harness installed (guard, permission rules, hooks) on the personal
stand-in, recorded in `test/acceptance/INTEGRATION-PERSONAL.md`: the first
two attempts were stopped by the harness itself (worktrees inside the
protected `~/.harness`, project allow rules ignored in untrusted worktrees,
the task file missing from the worktree, no allow rule for `git commit`, the
`wip: pause` subject), all fixed; then one task landed with the stand-in's CI
green (43 turns, 187.5 s, 0.0421 USD; graded resolved), and a second task,
paused mid-session, cut off, resumed (gate PASS first, landed), went through
the planted post-landing failure: red, rerun red, one fix attempt
(0.0094 USD), one revert, re-queued, `revert_correct` true.

## Limits

- The ledger's local status changes (claim, failed, blocked, re-queue) are
  written in the main checkout's `tasks/` and not committed; `done` is
  committed by the landing. `--ci-command` is passed to `harness land`.
- The Codex command shape (`codex exec --full-auto`, `codex exec resume
  --last`) follows the documented CLI; it is not exercised by the tests
  here (no Codex binary on the build machine), which use a scripted session.
- `--permission-mode acceptEdits` lets a Claude session edit files; shell
  commands still follow the installed allow and deny rules and the guard.
