# The landing actor (`src/land/`, `harness land`)

In the personal setting work reaches `main` only through `harness land`
(DESIGN §2.8). It lands one task branch at a time, checks the gate's proof
against the exact commit, watches CI after the landing, and fixes or reverts
when main goes red. Serial landing makes the culprit of a red main its HEAD
by construction (R-17).

## Command

```
harness land [--task <id>] [--repo <path>] [--branch <name>] [--main <branch>]
             [--ci local|github|none] [--ci-command "<cmd>"] [--squash] [--dry-run] [--no-wait]
             [--wait-minutes <n>] [--fixer claude|codex|none] [--model <m>]
             [--ci-timeout-minutes <n>] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | landed: CI green, skipped (`--ci none`), green on the rerun, or fixed by the one fix attempt |
| 1 | refused (nothing changed on main), reverted, CI gave no result, or the push failed |
| 2 | usage: not a git repository, no task, no main branch, `--ci github` without a token or a github.com remote |
| 4 | refused by a safety rail: the repository's effective setting is team (the harness never merges, commits or pushes there; land pushes from inside its own process, where the guard cannot see it, so it checks this itself) |

- **Task**: `--task`; else `task/<id>` checked out where it runs; else the
  repository's current task. **Branch**: `task/<id>` unless `--branch`.
  **Main**: `main`, else `master`, unless `--main`.
- **Default CI** is `local`. `--json` prints the landing record.

## What it does, in order

1. **Lock** `~/.harness/runs/<repoId>/land.lock` (`{pid, host, at, task}`,
   created atomically). A second landing waits (30 minutes by default) or,
   with `--no-wait`, fails at once. A lock is stale after an hour, or as
   soon as its process is gone on this host; a stale lock is moved aside
   and taken over.
2. **Evidence**: `evidence.json` of the task (the task worktree's run folder,
   then the repository's) must say `PASS`, must not carry `cap_reached`,
   and its `treeHash` must equal the tree of the branch tip
   (`git rev-parse task/<id>^{tree}`). Uncommitted changes in the task
   worktree are refused too: the PASS must be about the commit that lands.
3. **Behind main**: `git merge --no-ff main` into the task worktree as a new
   commit (never a rebase). A conflict aborts the merge and refuses. Then
   the gate re-runs the steps the merge invalidated, judged by the files the
   merge brought in, with `--base <main>`:

   | The merge brought | Re-run |
   |---|---|
   | only documentation (`*.md`, `docs/`, README, LICENSE, ...) | `tamper`, `secrets` |
   | files the task did not touch | every step except `acceptance:*` and `e2e:*` (their proofs are about the task's own files, unchanged by the merge) |
   | a file the task also changed, or dependency/compiler config (`package.json`, lockfiles, `tsconfig*.json`, `.nvmrc`) | unsure: `prove-red` at the new base, then the full gate, which must PASS on the merged tree |

   A failing re-run refuses; the merge commit stays on the branch.
4. **Landing commit**: the subject (`<id>: <title>`, or the first candidate
   that follows the repository's commit-subject standard in the ledger,
   such as `chore: <title> (<id>)`) and the write-up (`harness writeup`'s
   text from the brief; a short gate summary when there is no brief) as the
   body, plus a `Harness-Task: <id>` trailer. Default: a commit on top of
   the branch (so the agent's commits land unchanged and the write-up rides
   on the tip) whose only change is the **task file**: the task as the main
   checkout's ledger holds it, with `status: done`, `commit:` the branch tip
   that lands, `evidence:` the gate evidence (home-relative, `~/.harness/...`)
   and `done_at`, claim fields left out. So main's history says what landed
   and the main checkout is left with nothing uncommitted; claims stay local
   (uncommitted) in the main checkout until then. `--squash`: one commit on
   top of main with the branch's whole tree change plus the task file (the
   branch is left as it was). A task not in the ledger: no task file change.
5. **Fast-forward main** (`git merge --ff-only` in the main checkout; a
   compare-and-swap `update-ref` when main is not checked out anywhere).
   The main checkout's local copy of the task file (the claim, modified or
   untracked) gives way to the committed one, which was built from it,
   under the ledger lock; it is put back if main does not move.
6. **Push** the landed commit to the remote's main with a plain
   `git push <remote> <sha>:refs/heads/main` (never force), from the
   **landing checkout**: one detached worktree per repository
   (`~/.harness-worktrees/<repoId>/_land`, dependencies linked, removed at
   the end) moved to each commit main gets, so the repository's own
   `pre-push` gate checks exactly the pushed tree. No remote: nothing to
   push. A rejected push keeps the local landing and says to merge the
   remote in and push by hand.
7. **CI** on the landed commit:
   - `local` with a CI command (`--ci-command "<cmd>"`, or `land.ciCommand`
     in the machine config or the repository's `.harness/config.json` as it
     is on main before the landing, so a task cannot change how its own
     landing is checked): the command as an argv array (a command line is
     split without a shell; pipes, redirects, `;`, `&&` and `$(...)` are
     refused, so put several steps in a script), run in the landing
     checkout at that commit with `CI=true`, `HARNESS_CI_SHA`,
     `HARNESS_CI_BASE` and `HARNESS_CI_CHECKOUT`; `{checkout}`, `{sha}` and
     `{base}` in its arguments are replaced. Exit 0 is green, anything else
     red; its output (redacted, last 200 lines) goes to
     `runs/<repoId>/<task>/ci-<n>-<kind>.json` and its last 60 lines are the
     failure text the fix session gets. The guard denies `--ci-command` from
     an agent's tool call (it would run a command inside the harness process,
     out of the guard's sight); it is the user's flag.
   - `local` without one: `harness gate --hook ci --base <main before the landing>` in
     the landing checkout at that commit, in a child process with `CI=true`
     (like a CI job's fresh checkout: the main checkout's uncommitted files,
     such as the task ledger, and the harness's current task, whose brief a
     CI machine never has, do not change the result); its evidence is
     copied to `runs/<repoId>/<task>/ci-<n>-<kind>.json`.
   - `github`: `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` on
     api.github.com, read-only, token from `GITHUB_TOKEN` / `GH_TOKEN`
     (never stored, printed or logged), polled every 15 s, 3 minutes for a
     first check run to appear, 45 minutes at most (`--ci-timeout-minutes`).
     The harness never triggers a rerun on GitHub (that is a write).
   - `none`: skipped, and the record says so.
8. **On red**: one rerun (local CI). Green on the rerun: landed, recorded as
   a flake. Still red: **one fix attempt** by a fresh headless session
   (`--fixer`, default the agent of the run or the first of the configured
   agents) in its own worktree `task/<id>-fix` from the landed commit, with
   the configured caps (turns, wall minutes, budget) and the CI failure as
   the prompt. The fix lands only through the same gate (a full run with
   `--base <landed commit>`, PASS on the fix's committed tree) and the same
   CI. Still red, or no fix: **one revert commit** of the task commits and
   any fix commits together, then the task is marked `reverted` with the
   failure evidence and re-queued (`todo`, priority kept, a note in its body).
9. Every transition is a `land.<state>` instrumentation event (ids and
   counts only) and is written to `runs/<repoId>/<task>/landing.json`.

## The revert

- **Wrong-revert guard**: the commits on main since the landing
  (`git rev-list <old main>..main`) must be exactly the landed commits plus
  the fix commits. Anything else (someone else's commit) refuses the
  automatic revert (`revert_correct: false`) and says to revert by hand.
- The revert restores every path the landing and the fix changed to the old
  main (`git restore --source=<old main>`), in one commit
  `Revert "<landing subject>"` (or `revert: ...` when the repository's
  subject standard wants that) whose body names the reverted commits and the
  failure evidence. It never resets: history keeps the landed commits.
- The repository's commit and push hooks are off for this one commit and
  its push (the restored tree is one main already had; a pre-commit or
  pre-push gate would call the removal of the task's tests tampering).
  Every other commit and push the harness makes runs the hooks.
- `revert_correct` is true when main's tree after the revert equals the old
  main's tree and the guard held.

## Files

```
~/.harness/runs/<repoId>/land.lock                    {pid, host, at, task}
~/.harness/runs/<repoId>/<task>/landing.json          LandingRecord (record.ts)
~/.harness/runs/<repoId>/<task>/ci-<n>-<kind>.json    local CI evidence per run (initial, rerun, after-fix)
~/.harness-worktrees/<repoId>/<task>/                 the task worktree, when land had to check the branch out
~/.harness-worktrees/<repoId>/<task>-fix/             the fix attempt's worktree (removed after a landed fix)
~/.harness-worktrees/<repoId>/_land/                  the landing checkout (pushes and the local CI; removed at the end)
(outside ~/.harness: the agent edits task and fix worktrees, and ~/.harness/** is protected)
```

Worktrees the harness creates (task, fix, a temporary main checkout for CI)
get the main checkout's `node_modules` linked in with the gate's own
`linkNodeModules` (a folder of links that the repository's `node_modules/`
ignore rule hides from git; nothing is installed), so the gate there finds
the declared tools.

`landing.json` carries the landing metrics of EVAL-PLAN §7 at the top:
`landed`, `post_landing_red`, `auto_fixed`, `reverted`, `revert_correct`
(null when there was no revert), then `outcome` (`landed`, `deflaked`,
`auto_fixed`, `reverted`, `refused`, `failed`, `dry-run`), `reason`,
`evidence`, `merge`, `oldMain`, `landedTip`, `landedCommits`, `subject`,
`push`, `ciRuns[]`, `fix`, `revert`, `requeued`, `failureEvidence` and
`transitions[]`.

## Modules

| File | What |
|---|---|
| `land.ts` | the state machine; `planAfterMerge`, `requeue`, `writeupBody`, `fixPrompt` |
| `lock.ts` | the landing lock |
| `record.ts` | `landing.json` and the `land.<state>` events |
| `ci.ts` | `localCi`, `githubCi` (injectable HTTP layer), `noCi` |
| `gaterun.ts` | the gate as an interface: in process, or the CLI as a child process |
| `gitops.ts` | worktrees, ancestry, fast-forward, merge with abort, commit-tree, subjects that follow the repository's standard (shared with `src/runctl`) |

## A recorded run

`test/acceptance/land-standin.test.ts` on the personal stand-in (installed,
no database), one run on the build machine:

| Landing | What happened | Wall | CI runs |
|---|---|---|---|
| T-101 | evidence PASS at the tip; ff main; pushed; CI red (the planted probe, `tests:base` only), rerun green | 10.5 s | red 6.9 s, green 3.2 s |
| T-102 | behind main by T-101's landing: merged main in, re-ran 10 steps (partial, all passed); CI red twice; `--fixer none`; one revert commit, main back at T-101's tree, pushed, task re-queued | 21.0 s | red 8.5 s, red 4.7 s |

Landing fields: T-101 `landed` true, `post_landing_red` true, `auto_fixed`
false, `reverted` false, `revert_correct` null; T-102 `landed` true,
`post_landing_red` true, `auto_fixed` false, `reverted` true,
`revert_correct` true. The task's own gate run before landing took 9.8 s;
creating the stand-in (`setup.js` with `npm ci` from the local cache) 8.9 s.

## Limits

- The re-run after a merge from main leaves out `acceptance:*` and `e2e:*`
  unless the merge touched the task's own files; then it is a full gate, and
  an API or database criterion's artefact from before the merge is stale, so
  the landing refuses until `harness verify` runs again on the merged tree.
- `--ci github` cannot rerun a check (read-only); a red result goes straight
  to the fix attempt. A commit with no check runs after the grace period is
  reported as `none` (landed, CI not configured for pushes to main).
- The fix attempt's session needs `claude` or `codex` on PATH; without it
  the landing goes from the red rerun straight to the revert.
- The task ledger lives in the main checkout's `tasks/`. `done` travels in
  the landing commit; the revert restores main's old tree (a task file only
  the landing brought is removed again) and the re-queue (`todo` with the
  note) is written in the main checkout, uncommitted, like a claim. With
  `--squash` the ledger's `commit:` is the task branch tip, which is not on
  main (the landing commit is; its `Harness-Task` trailer names the task).
