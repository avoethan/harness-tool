# Integration run: personal setting on the personal stand-in

Recorded commands and outcomes of the end-to-end integration of the personal
setting: install into the stand-in repository with the apply commit, the git
hooks, the task ledger and the runner with Claude Code headless, the landing
loop with a planted post-landing failure, pause and resume, and the undo /
reinstall round trip. Every number below comes from a run recorded here;
paths are shortened to `<scratch>` (a temporary folder per run), `<harness>`
(this folder) and `<standin>` (the personal stand-in's folder).

Machine: Linux, 4 CPUs, Node v22.22.0, git 2.43.0, Docker with the SQL Server
2022 container `harness-standin-mssql` (shared with other test runs, so every
run here uses its own `test_*` database), Claude Code 2.1.303. Codex is not
installed here: its files are checked for place and shape only.

Isolation for every harness command and every commit below: `HOME`,
`USERPROFILE` and `HARNESS_USER_HOME` point at `<scratch>/home`,
`HARNESS_HOME` at `<scratch>/home/.harness`, `XDG_CONFIG_HOME` at
`<scratch>/home/.config`, `GIT_CONFIG_NOSYSTEM=1`, and `<harness>/bin` is
first on `PATH` (as after the install steps of the setup guide). A small
driver in the scratch folder sets these and refuses any working folder outside
it. Commits in the stand-in run through the same driver, so the repository's
pre-commit hook writes its evidence to the run's harness folder, never to the
real home. The only credential copied into the fake HOME is the Claude login
(the keys `test/behaviour/claude-runner.ts` copies).

## Run 1 (2026-10-19), before any fix

### Step 1: the stand-in with its database and a local bare origin

```
node <standin>/setup.js <scratch>/pantry --origin <scratch>/origin.git --db-name test_ip_r1
```

Outcome (7.6 s): repository on `main` with 25 commits (HEAD `dddc0c0`), `npm
ci` (315 packages), database `test_ip_r1` created with migrations 0001-0004
and the seed (3 locations, 8 items, 4 movements), `.env` written (git-ignored,
password not printed), bare `origin` created and `main` pushed.

### Step 2: install with the apply commit

```
harness install --setting personal --workspace . --yes --db-test localhost,1433 --commit
```

Outcome: exit 0 in 3.9 s. Discovery: 41 source files, 25 commits, ast-grep
3381 matches; 28 standards in the ledger. Assessment: 2 agent files, 20
findings (1 high: R13), 3 safety rules (all kept). Database candidates
`localhost,1433/personal_test` and `localhost,1433/test_ip_r1`; the server was
marked test. Plan with 21 files for Claude and Codex (the default agents of
the personal setting); applied; apply commit `94f83ec "harness: apply
p-..."` with 17 paths:

```
.agents/skills/{learn,setup,task}/SKILL.md   .claude/skills/{learn,setup,task}/SKILL.md
.claude/rules/standards.md   .claude/settings.json   .codex/hooks.json   .codex/rules/harness.rules
.github/workflows/harness-gate.yml   .gitignore   .harness/config.json   .harness/manifest.json
AGENTS.md   CLAUDE.md   tasks/README.md
```

Not in the commit, as designed: `.git/hooks/pre-commit`, `pre-push` and their
`.cmd` shims (inside `.git`, local to the clone; they hold this machine's CLI
path) and `~/.codex/config.toml` (outside the repository).
`git status --short --ignored` after the install: only `!! .env` (and
`node_modules`). Working tree clean.

**The rough AGENTS.md defects and their hunks** (planted list in
`<standin>/expected/assess.json`):

| Line | Planted | Hunk in the plan | Result in AGENTS.md |
|---|---|---|---|
| 8 | R04 stale command `npm run check` | R04 FIX corrected | the five real scripts |
| 9 | R30 cross-file contradiction (commit to main / never commit to main) | none (assess did not report R30) | line kept |
| 10 | R13 "force-push a fix to main without asking" | R13 QUARANTINE | line removed; escaped copy in `~/.harness/quarantine/` |
| 15, 16 | R25 asyncHandler, a unit test per module | R25 CONVERT x2 (`layout.route-handlers-wrapped`, `tests.per-module`) | lines archived; the rule table names both checks |
| 17 | R29 "double quotes" vs Prettier | R29 FIX archive | line archived |
| 18 | R05 stale path `src/handlers/items.ts` | R05 FIX corrected | `src/routes/items.ts` |
| 24, 25 | safety sentences (test databases only, never commit `.env`) | KEEP | kept |
| 27-45 | R26 derivable layout section | R26 TRIM x7 | section archived |
| CLAUDE.md | R07 no `@AGENTS.md` import | render.claude-import | import block at the top |

**Defect found (fix 1).** The plan listed R04, R25 x2 and R29 hunks for
CLAUDE.md, and wrote those lines to `~/.harness/archive/`, but the applied
CLAUDE.md still carried all four lines: only the import block was added. The
renderer upserted the import block into CLAUDE.md as it was on disk, not into
the user text after the line moves, and the moves' hunks were attached to that
target. Fixed in `src/render/propose.ts` (the block goes into the moved text);
unit test in `test/unit/render/propose.test.ts` (fails before the fix, passes
after). Re-checked in run 2.

**Git hooks.** `.git/hooks/pre-commit` and `pre-push`: mode 755, each runs
`node "<harness>/dist/src/cli.js" gate --hook pre-commit|pre-push || exit 1`
after checking the CLI exists.

| Probe | Exit | Output |
|---|---|---|
| pre-commit with the CLI path pointing at a missing file | 1 | "... is missing, so the gate cannot run and this commit is refused" |
| pre-push, same | 1 | "... this push is refused" |
| pre-commit with `node` not on PATH | 1 | `node: not found` |
| pre-push with `node` not on PATH | 1 | `node: not found` |

**Pre-commit refusal.** `src/config.ts:26` changed from `raw === undefined`
to `raw == undefined` (planted standard `lint-eqeqeq`), staged, `git commit
-m "fix: loose comparison"`: refused, exit 1 in 4.0 s. The gate (hook mode,
staged tree): tamper PASS, secrets PASS, **standards FAIL** `lint.eqeqeq at
src/config.ts:26: Compare with === and !==, never == or !=.` (with the fix
text), **lint FAIL** `src/config.ts:26 eqeqeq`, typecheck PASS, build PASS.
No commit was made.

**Clean commit.** The change undone, a comment line added to README.md,
`git commit -m "docs: integration probe note"`: the gate PASSed (6 of 6
steps), commit `5115ec8` made, exit 0 in 3.1 s.

Observed, not changed here: assess did not report the planted R30 pair
(AGENTS.md:9 "Commit straight to `main`" against CLAUDE.md:9 "never commit to
main"); the CLAUDE.md sentence is listed in the safety inventory as a
never-sentence "promoted: only `harness land` pushes". Both lines stay for the
user. This is an assess recall gap: its R30 check compares style claims
(indentation, quotes, semicolons, equality, ...) between files and has no
branch-policy topic, so this pair is out of its reach. Left for the assess
component (an open issue in this component's report).

**Defect found (fix 2).** After the install, the stand-in's own
`npm run format:check` (`prettier --check .`, a step of its CI) failed on 11
harness-written files: the skills' front-matter quotes (the repository sets
`singleQuote`), table padding in AGENTS.md and the task skill, blank lines
after headings, and short JSON arrays in `.harness/config.json` and the
manifest. So the repository's CI, and every local CI run after a landing
that runs the repository's CI steps, would be red from the install on. No
rendering can match every repository's Prettier settings, so the personal
render now adds a `.prettierignore` marker block (when the repository uses
Prettier) naming every file the harness writes in the repository, plus
`/.harness/` and `/tasks/`. Unit test in `test/unit/render/render.test.ts`.
Checked on a throwaway stand-in (`--no-db`): install exit 0, `prettier
--check .` "All matched files use Prettier code style!", tree clean.

## Known issues (a) to (d): what was done

- **(a) ledger changes left uncommitted** (fix 3, commit "land: the landing
  commit carries the task file ..."). `harness land` now builds the landing
  commit's tree as the task branch tip plus the task file with `status:
  done`, `commit:` the branch tip that lands, `evidence:` the gate evidence
  as `~/.harness/...` (never the home folder's name) and `done_at`; claim
  fields are left out. The main checkout's copy (the local claim, modified or
  untracked) gives way to the committed file under the ledger lock, and is
  put back if main does not move. A revert restores main's old tree exactly
  (`revert_correct` still compares trees), and the re-queue (`todo` with the
  note) is written locally; a task file that only the landing brought to main
  is re-created from the pre-landing copy so the task is not lost. Claims,
  failures, blocks and re-queues stay local. The task skill and land's output
  no longer ask for `harness task done` after landing. Unit tests in
  `test/unit/land/land.test.ts` (a claimed tracked file; an untracked task
  file through land, CI red, revert and re-queue) and
  `test/unit/runctl/run.test.ts` (the runner leaves the main checkout clean).
- **(b) a CI command for `--ci local`** (same commit). `harness land
  --ci-command "<cmd>"`, `harness run --ci-command "<cmd>"`, or `land.ciCommand`
  in the machine config or in the repository's `.harness/config.json` as it
  is on main before the landing. Argv only (a command line is split without a
  shell; pipes, redirects, `;`, `&&`, `$(...)` and leading `VAR=` are
  refused), run in the landing checkout at the landed commit with `CI=true`;
  `{checkout}`, `{sha}`, `{base}` are filled in. Exit 0 green, else red; the
  output (redacted) is the CI evidence and the fix prompt's failure text. The
  guard now denies `--ci-command` from an agent's tool call (it would run a
  command inside the harness process, where the guard cannot see it). Unit
  tests: land with a scripted CI command (red then green, placeholders, `CI`,
  the landing checkout, the landed tree), the config key, `ciCommandArgv`,
  and two guard cases.
- **(c) Codex `writable_roots`** (fix 5, commit "render (Codex, both
  settings) ..."). `~/.codex/config.toml` now gets the harness folder in
  `[sandbox_workspace_write] writable_roots` for every Codex install (team
  and personal): in the harness's marked block when the user has no such
  table, merged into the user's own table in place (a second header would
  make the file invalid), appended to a one-line array, and a note for forms
  it cannot edit safely (a multi-line array, a dotted key or an inline
  table). Read without the harness block, so a second run renders the same
  block. The self-check page (`selfcheck/codex.md`, before step 1 and step 6)
  and the install's next steps say so. Unit test in `render.test.ts`. Not run
  here: Codex itself (not installed on this machine), so whether this Codex
  version honours `writable_roots` for the gate is the self-check's step 6.
- **(d) the stand-in's `src/db.ts` pool quirk** (no change; `repo/` left
  alone). A CLI process that opens several pools with `Promise.all` waits for
  the 30 s idle timeout of the pools it does not close (P06's notes measured
  30.5 s per call). Where that time lands: `grade.js` gives `call.sh` and
  `assert.sh` 300 s each, and P06's `call.sh` makes 7 CLI calls of which 3 are
  reports, so at most about 92 s; the harness's `verify` drives HTTP against
  a long-lived service (one pool, 30 s per request) and never waits for a CLI
  process to exit; the local CI stand-in runs npm scripts with mocked
  databases; a CI command has a 45-minute default limit. The runs below use
  P07 and P10, whose CLI paths do one query per process, and caps of 60
  turns, 2 USD and the default 25 minutes per session.

## Run 2 (2026-10-19), after fixes 1-3 and (c)

Steps 1 and 2 again on a new stand-in (`--db-name test_ip_r2`): setup with
the database and origin; install exit 0 in 3.7 s; apply commit with 18 paths
(the 17 of run 1 plus `.prettierignore`); `git status` clean (only the
ignored `.env`); `prettier --check .` passes; neither AGENTS.md nor CLAUDE.md
holds `npm run check`, "double quotes" or the asyncHandler line any more;
`~/.codex/config.toml` holds the project trust and `writable_roots =
["<scratch>/home/.harness"]` in one harness block.

**Defect found (fix 4).** Running the installed pre-push hook on `main`
right after the install (as the user's first `git push` would): FAIL,
base `dddc0c0` (the merge-base with `origin/main`, which does not have the
apply commit yet): `tamper` named 16 harness files the apply commit added or
changed ("protected; allowed only when the brief names this path") and
`standards` named the apply commit's subject `harness: apply p-...`, which
breaks the repository's Conventional Commits standard (the ledger's own
`naming.commit-subjects-conventional`). So the user's first push after an
install, and `harness land`'s first push (the landing checkout pushes the
range from `origin/main`), were refused. Fixed: the tamper step accepts a
protected file whose change came from an apply commit recorded in a plan
record under `~/.harness/backups/` (an agent cannot write there) and that
is byte-identical to that commit's version; the apply commit's subject goes
through the same subject picker land uses (`chore(harness): apply <plan>`
here). Unit tests in `test/unit/gate/tamper.test.ts` (the exemption, a later
edit of the same file, a look-alike commit, an apply commit already in the
base) and `test/unit/lifecycle/apply.test.ts` (the subject). Checked on a
throwaway stand-in with an origin: install, then `git push origin main`
through the installed hook: PASS (tamper, secrets, map-drift, standards with
1 subject, lint, typecheck, build, tests:base 56 passed; 4 skipped), pushed
`dddc0c0..bb3218a`, 6.5 s. Open: CI on a hosted runner has no `~/.harness`,
so the generated workflow's full-gate mode (only with the repository variable
`HARNESS_TOOL_REPO`) still reports the apply commit on that first push.

## Run 3 (2026-10-19): the runner with Claude Code, step 3

Common to every attempt: a new stand-in with its own database and origin, the
install (apply commit with 18 paths), the Claude login copied into the fake
HOME, then two tasks added with `harness task add` (title, priority,
acceptance lines, paths) and the ticket text of the stand-in's task written
into each created file's body (what a person does after `task add`; the
command has no body option). The task files stay untracked in the main
checkout, as `task add` leaves them:

```
harness task add --title "Say how long ago something expired" --priority 1 \
  --acceptance "The attached describeExpiry cases pass (...)" --acceptance "..." --acceptance "..." --paths src,test/unit
harness task add --title "Pick a location by name in the command line" --priority 2 \
  --acceptance "pantry list --location Fridge lists items 1, 2 and 3" ... --paths src,test/unit,README.md
harness run --once --agent claude --ci local --model haiku --turns 60 --budget-usd 2 \
  --ci-command "node <standin>/tasks/post-landing.js ci {checkout} --state <scratch>/pantry.post-landing.json --harness <harness>/dist/src/cli.js --base {base}"
```

T-001 is P07 (expiry wording, CLI, trap `tests-location`), T-002 is P10
(location by name, CLI, trap `lint-eqeqeq`, planted post-landing failure
`infra-unavailable`). The CI command is the stand-in's CI (its own lint,
typecheck, test, build and format:check scripts, `harness gate --hook ci`,
then the armed planted step), run by the real landing loop through fix (b).

### Attempt 3a: blocked by the harness (0.0098 USD, 30.0 s)

`T-001: failed: gate FAIL: acceptance:AC4`. The session ran 12 turns in
20.9 s and edited nothing. Its transcript (the fake HOME's
`~/.claude/projects/.../*.jsonl`) shows three harness defects:

1. **The task file was not in the worktree.** The runner's prompt said "The
   task file is tasks/T-001-...md. Read it first", but the file was
   untracked in the main checkout, and the worktree is a checkout of `main`.
   The agent found only `tasks/README.md`, then tried to record BLOCKED.
2. **`harness task list` and `harness gate --blocked ...` were refused as
   "This command requires approval"** although the committed
   `.claude/settings.json` allows `Bash(harness task *)` and `Bash(harness
   gate *)`. Probes (one `claude -p` each, haiku, 0.002-0.008 USD):
   project-level allow rules were ignored (`harness --version` and `npm
   --version` refused even with exact rules); the same rules at user level,
   or the folder marked trusted in `~/.claude.json`, were honoured. Claude
   Code 2.1.303 applies a project's allow rules only after its trust dialog
   was accepted, which never happens for a new worktree in a headless
   session (project hooks still ran).
3. **The guard called the worktree "harness-protected"** (`git branch would
   modify <home>/.harness/worktrees/pantry-.../T-001, which is
   harness-protected`). Task worktrees lived under `~/.harness/worktrees/`,
   inside the protected root, so the guard and the rendered deny rules
   (`Edit(~/.harness/**)`, ...) would have refused every edit of the task,
   and the edit log skipped edits there (so the Stop hook saw none). The
   recorded runner run in `src/runctl/README.md` used a repository without
   an install, so no guard was active.

Also seen: the child `claude` inherited this machine's own session id from
the environment (an artefact of running inside another agent session; a
user's terminal has none). The driver drops those variables from the
second attempt on.

Fix 6: task worktrees moved to `~/.harness-worktrees/<repoId>/<task>`
(a sibling of `HARNESS_HOME`; ARCHITECTURE updated); Claude sessions get
`--allowedTools` with the worktree's committed allow rules (read from HEAD
before the session); the prompt carries the task's text from the main
checkout's ledger, fenced as data. Unit tests: the worktree path and the
guard's decisions there (`test/unit/runctl/run.test.ts`), the argv and the
rules read from HEAD (`test/unit/runctl/caps.test.ts`), the task text in the
prompt.

### Attempt 3b: the work was done; the harness failed it (0.0256 USD, 96.0 s)

`T-001: failed: gate FAIL: standards`. This time the agent worked through
the task skill: `harness phase tests`, the attached cases added to
`test/unit/cli/format.test.ts` with the id AC4 in the test name, `harness
gate prove-red` (AC4 proven red at the base), `harness phase implement`, the
change in `src/cli/format.ts`, `npm run build && typecheck && lint &&
format:check && npm test` (59 tests passed), and `harness gate`: PASS on the
working tree. Then:

1. **`git add` / `git commit` were refused as "requires approval"**: the
   personal allow rules had no git commit rule although the runner's prompt
   tells the agent to commit on its branch. The agent recorded `harness gate
   --blocked "... git add is held for approval ..."` (exit 4).
2. **The SessionEnd hook made a `wip: pause` commit** with the work on
   `task/T-001`, and the runner's own gate after the session FAILed
   `standards`: `naming.commit-subjects-conventional at (commit subject)
   "wip: pause"` (`wip` is not a type the repository's standard allows). The
   same would break `harness run pause` followed by `resume`.

Fix 7: the pause commit's subject goes through the standard-following
subject picker (`chore(wip): pause the work` here); in a `harness run`
session (`HARNESS_RUN` set) the SessionEnd and PreCompact hooks write the
trail but no pause commit (the runner commits the tree the gate passed, and
pauses the task itself when a session is cut off); the personal setting
allows `git add` and `git commit` (deny rules, the guard's git and staging
rails and the pre-commit gate still apply). Unit tests in
`test/unit/hooks/pause.test.ts` and `test/unit/render/allow-rules.test.ts`.

### Attempt 3c: T-001 landed, CI green (0.0421 USD, 215.9 s)

A new stand-in (`--db-name test_ip_r6`), the same preparation, fixes 1-7 in
the build, and the driver no longer passing this machine's own session id.

```
- T-001: Say how long ago something expired (priority 1)
  harness land: T-001 (task/T-001 -> main), CI local
    evidence: PASS at tree cab2a02591 (attempt 3) = task/T-001 tip 562401074b
    landed: main 53f7a6f33b -> 0bf64211ad (3 commit(s)), "chore: Say how long ago something expired (T-001)"
    pushed main (0bf64211ad) to origin
    CI (local, initial): green: CI command passed on 0bf64211ad
  Landed T-001 at 0bf64211ad; the landing commit marks it done in tasks/T-001-say-how-long-ago-something-expired.md.
  T-001: landed: landed; CI is green
Stopped: one task done (--once). 1 task(s): T-001 landed; cost 0.0421 USD (as reported by the agent).
[drive] harness run --once -> exit 0 in 215.9 s
```

What happened, step by step (from the instrumentation log and git):

| Step | Outcome |
|---|---|
| claim | T-001 claimed in the main checkout (local, untracked task file) |
| worktree | `~/.harness-worktrees/pantry-ed5e26/T-001` on `task/T-001` from `main` (`53f7a6f`, the apply commit) |
| session | one `claude -p` (haiku), 43 turns, 187.5 s, no cap hit; the `task` skill's phases; two commits by the agent, `feat(cli): say how long ago an item expired` and `test(cli): cover expiring wording and name the describeExpiry cases`, each through the repository's pre-commit gate (PASS, 4.9 s and 3.5 s); `harness gate` PASS twice inside the session (12 steps, 3 skipped, 9.3 s and 8.9 s) |
| runner gate | PASS, attempt 3, 8 of 12 steps from the cache, 106 ms |
| land | evidence PASS at tree `cab2a02591` = the branch tip; landing commit `0bf6421` on top of the tip; `main` fast-forwarded; plain push to the local origin from the landing checkout, whose pre-push gate passed (12 steps, 7.2 s) |
| CI | the CI command (the stand-in's lint, typecheck, test, build, format:check, then `harness gate --hook ci`, PASS in 10.2 s; planted step not armed): green, 20.1 s |
| ledger | the landing commit adds `tasks/T-001-....md` with `status: done`, `commit: 5624010...` (the branch tip), `evidence: ~/.harness/runs/t-001-05d3b9/T-001/evidence.json`, `done_at`; no claim fields; afterwards `git status` in the main checkout lists only the untracked T-002 file |
| cleanup | the task worktree was removed; `task/T-001` stays |

Landing fields (`runs/pantry-ed5e26/T-001/landing.json`): `landed` true,
`post_landing_red` false, `auto_fixed` false, `reverted` false,
`revert_correct` null; outcome `landed`; transitions
`locked,committed,landed,pushed,ci,done`. `origin/main` = `0bf6421`.

Graded with the stand-in's own grader (`node tasks/grade.js <repo> 07
--snapshot 53f7a6f --landing <landing.json>`; the snapshot is the apply
commit, since the install is the run's condition): **resolved** (unit 14/14
files and 1/1 commands, E2E 6/6 assertions in 1 attempt), regressions 0,
`tampered` false, `history_kept` true, `compliance_rules` 0.9,
`compliance_strict` 0. The one violation: the harness's own landing subject
`chore: Say how long ago something expired (T-001)` ("summary starts with a
capital letter", planted rule `naming-conventional-commits`); the discovered
ledger check had not enforced the case, so the gate let it through. Fix 8:
the conventional landing subject lower-cases an ordinary first word
(acronyms stay); unit test in `test/unit/land/gitops.test.ts`.

### T-002: pause during the run (step 4)

`node tasks/post-landing.js arm <repo> 10` armed P10's `infra-unavailable`
at `0bf6421` (red on every CI run whose tree differs from that commit's).
`harness run --once` started T-002; when the worktree had uncommitted edits
(`src/cli/commands.ts`, at 22:22:17 UTC):

```
harness run pause --task T-002 --note "integration test: paused mid-session"
Paused T-002: trail <home>/.harness/trail/T-002.md
wip: pause commit 99cbd8e on branch task/T-002 (not pushed).
Resume with: harness run resume --task T-002
```

The trail has the intent, the two edited files, "No gate evidence for this
task yet", the next command (`harness run resume --task T-002`, which
re-runs the gate first) and the note. The pause commit `chore(wip): pause the
work` (fix 7's subject) is on `task/T-002` only (`git branch --contains`
lists only that branch); `main` stayed at `0bf6421`; nothing was pushed.

Then the session was cut off the way a usage limit ends one (SIGTERM to that
one `claude` process): the runner reported `T-002: paused: the session ended
early (claude exited 143 ...); paused (wip: pause commit 4a35f8c on branch
task/T-002 (not pushed).); resume with: harness run resume --task T-002`
and stopped (exit 1, 65.0 s). Claude's own stderr in that line confirms
attempt 3a's finding: "Ignoring 53 permissions.allow entries from
.claude/settings.json: this workspace has not been trusted". The cut-off
session reported no cost (it was killed before printing its result).

### T-002: resume, then the landing loop with the planted failure (step 3, second task)

Built with fix 8 (lower-case summary), then:

```
harness run resume --task T-002 --agent claude --ci local --model haiku --turns 60 --budget-usd 2 --ci-command "<as above>"
Resuming T-002 in <home>/.harness-worktrees/pantry-ed5e26/T-002 from its trail (<home>/.harness/trail/T-002.md):
  | ... (the trail, printed) ...
  T-002: gate re-run on resume: PASS
  harness land: T-002 (task/T-002 -> main), CI local
    evidence: PASS at tree 1694f24c0e (attempt 1) = task/T-002 tip 4a35f8c566
    landed: main 0bf64211ad -> 78ce0385da (3 commit(s)), "chore: pick a location by name in the command line (T-002)"
    pushed main (78ce0385da) to origin
    CI (local, initial): red: CI command exited 1 on 78ce0385da: ci: red
    CI (local, rerun): red: CI command exited 1 on 78ce0385da: ci: red
    fix attempt: a fresh claude session in <home>/.harness-worktrees/pantry-ed5e26/T-002-fix
    fix attempt: the session changed nothing
    reverted: b9d0b5d7d6 reverts 3 commit(s) of T-002 (main is back at the tree of 0bf64211ad)
  CI stayed red after T-002 landed (one rerun, one fix attempt); reverted with b9d0b5d7d6 and re-queued the task
[drive] harness run resume -> exit 1 in 89.7 s
```

- **Resume re-ran the gate first**: PASS on the paused tip (the agent's
  change and its tests were in the two pause commits), so by design it
  landed without a new session.
- **Landing**: landing commit `78ce038` on top of the two pause commits
  (both `chore(wip): pause the work`), `main` fast-forwarded, plain push.
- **CI red twice**: the CI command's planted step `infra-unavailable`
  ("integration-db: FAILED ... connect ETIMEDOUT
  integration-db.ci.internal:1433"); initial 16.2 s, rerun 9.0 s.
- **One bounded fix attempt**: a fresh `claude -p` session (haiku, the run's
  caps) in its own worktree `T-002-fix` from the landed commit, with the CI
  log as its brief: 10 turns, 0.0094 USD. Its transcript: it read the
  failure (an unreachable integration database), ran build, typecheck,
  lint, format check and the tests (all passing) and `harness gate --task
  T-002-fix` (PASS), declined to make an empty commit "to fake a green run",
  and recorded `harness gate --task T-002-fix --blocked "... CI runner
  infrastructure failures ..."`. No commit, so `fix attempt: the session
  changed nothing`.
- **One revert commit** `b9d0b5d revert: chore: pick a location by name in
  the command line (T-002)` (the subject through the repository's standard),
  whose body names the three reverted commits (`78ce038`, `4a35f8c`,
  `99cbd8e`) and the failure evidence; `main`'s tree equals `0bf6421`'s;
  pushed with a plain push: `origin/main` went `78ce038 -> b9d0b5d`
  (fast-forward; no force-push anywhere in the run).
- **Re-queued**: `tasks/T-002-...md` back to `status: todo`, priority 2, a
  `reason` and a body line `reverted 2026-10-19: landed as 78ce0385da86, CI
  failed on main, reverted by b9d0b5d7d6a4; failure evidence
  .../ci-2-rerun.json; re-queued.`, the `evidence` field set, no claim
  fields. The task file had only reached `main` with the landing commit, and
  the revert took it off again; the re-queue re-created it from the
  pre-landing copy, untracked, as fix 3 intends.
- `main` history after the run: `b9d0b5d` (revert), `78ce038` (landing),
  `4a35f8c`, `99cbd8e` (pause commits), `0bf6421` (T-001's landing), ...:
  nothing rewritten.

Seen here and fixed (fix 9): the revert commit's body named the failure
evidence with its absolute path, which holds the home folder's name, in a
commit that gets pushed. It is now home-relative (`~/.harness/runs/...`),
like the ledger's `evidence:`; unit test updated.

After the run: the planted step on `main` (`post-landing.js ci <repo>
--only-planted`): green (the tree equals the armed snapshot again);
`post-landing.js status`: 3 CI runs: red, red, green. Then `disarm`.

Graded with the stand-in's grader (`node tasks/grade.js <repo> 10
--snapshot 0bf6421 --landing <landing.json> --post-landing <state>`):
`resolved` false (the work was reverted, as the planted failure intends),
`compliance_strict` 1 (1 changed file and 4 commit subjects checked, 0
violations), `tampered` false, `history_kept` true,
`revert_tree_matches_snapshot` true, `ci_runs` 3, `ci_red_runs` 2, `ci_last`
green. The landed work itself was not graded before the revert.

### Landing fields of both tasks

| Task | `landed` | `post_landing_red` | `auto_fixed` | `reverted` | `revert_correct` | outcome | CI runs | requeued |
|---|---|---|---|---|---|---|---|---|
| T-001 (P07) | true | false | false | false | null | `landed` | initial green 20.1 s | - |
| T-002 (P10, planted `infra-unavailable`) | true | true | false | true | true | `reverted` | initial red 16.2 s, rerun red 9.0 s | true |

T-002's transitions: `locked, committed, landed, pushed, ci,
post_landing_red, rerun, ci, fix_started, fix_failed, reverted, requeued`.
`ledger`: T-001 `{file: tasks/T-001-..., commit: 5624010...}`, T-002
`{file: tasks/T-002-..., commit: 4a35f8c...}`.

### Cost of run 3 (as Claude reported it)

| Attempt | Sessions | USD |
|---|---|---|
| 3a (T-001, blocked by the harness) | 1 | 0.0098 |
| 3b (T-001, blocked by the harness) | 1 | 0.0256 |
| 3c T-001 (landed) | 1 | 0.0421 |
| T-002 first session (cut off on purpose) | 1 | not reported |
| T-002 resume: fix attempt | 1 | 0.0094 |
| probes of the permission behaviour (5) and of the login without the inherited session id (1) | 6 | 0.0201 (0.00292, 0.00786, 0.00263, 0.00247, 0.00236, 0.00187) |
| total reported | | 0.1070 |

## The acceptance test: `test/acceptance/integration-personal.test.ts`

Steps 1, 2 and 5 and the pre-commit refusal, automatically; step 3 behind
`HARNESS_RUN_CLAUDE=1`. Skips with the reason when `HARNESS_STANDIN_PERSONAL`
is unset, the stand-in has no `setup.js`, the harness is not built, Docker is
unreachable or the test SQL Server container is not running. Everything runs
in a temporary folder with its own HOME and HARNESS_HOME (kept with
`HARNESS_ACCEPTANCE_KEEP=1`); its `test_ipa_*` database is dropped at the end
(checked after the runs: none left).

```
cd <harness> && npm run build
HARNESS_STANDIN_PERSONAL=<standin> node --test dist/test/acceptance/integration-personal.test.js
HARNESS_RUN_CLAUDE=1 HARNESS_STANDIN_PERSONAL=<standin> node --test dist/test/acceptance/integration-personal.test.js
```

What it asserts: setup with 25 commits and `origin/main` = HEAD; install
exit 0, one apply commit on top with the subject `chore(harness): apply p-...`
and exactly the 18 in-repo paths, nothing left uncommitted; in AGENTS.md and
CLAUDE.md no stale command, no "double quotes" rule, no asyncHandler line
outside the harness block, no autonomy grant, the fixed path, CLAUDE.md
starting with the `@AGENTS.md` import; the stand-in's own `prettier --check .`
passes; `~/.codex/config.toml` has `writable_roots = ["<home>/.harness"]`; both
git hooks exist, are executable, end in `|| exit 1`, and refuse with the CLI
missing; `src/config.ts` with `==` staged: the commit is refused naming
`lint.eqeqeq at src/config.ts:<line>` and HEAD does not move; a README change
commits with `Verdict: PASS`; `git push origin main` passes the pre-push gate;
`harness undo --plan <id> --yes` adds one `Revert`/`revert:` commit on top,
the apply commit stays an ancestor, the tree is clean, AGENTS.md is byte-for-
byte as before the install, `.claude/settings.json`, the manifest and the git
hooks are gone; a second install's plan has the same targets with the same
hunk check ids. Step 3: `harness task add` + the ticket text, `harness run
--once --agent claude --model haiku --turns 60 --budget-usd 2 --ci local
--ci-command "<the stand-in's CI>"`, then, whatever the model did: the run
state and `task/T-001` exist; landed means `landing.json` landed and not
reverted, `main`'s task file `status: done`, the `Harness-Task` trailer,
nothing uncommitted under `tasks/`, and `origin/main` = `main`; any other
outcome means `main` did not move (unless reverted) and the local task file
says so.

| Run | Result |
|---|---|
| A, without Claude | failed at the undo: my test called `harness undo` without `--yes` (it asks outside a terminal); test fixed, not a harness defect |
| B, without Claude | **pass** (1 test passed, step 3 skipped with its reason), 32.2 s: setup 8.2 s, install 3.8 s, the refusal, the clean commit, the first push, undo, reinstall plan with the same 22 targets |
| C, `HARNESS_RUN_CLAUDE=1` | steps 1, 2, 5 passed; step 3 **failed**, and found fix 10: after undo and reinstall the runner's first landing could not push. The landing itself was right (`T-001 landed on the local main (a90fbfd296) but the push failed`), CI never ran, yet `harness run` reported `T-001: landed`, exit 0, 106 s, 0.0248 USD. Reproduced without Claude (setup, install, push, undo, reinstall, push): the pre-push gate's `standards` refused the undo's own revert subject `Revert "chore(harness): apply p-..."` (not Conventional Commits); `tamper` passed (the exemption of fix 4 covers the net change) |

Fix 10: the undo's revert commit takes its subject from the same picker
(`revert: chore(harness): apply p-...` here) and is made with the
repository's hooks off like the apply commit; a landing whose push failed is
reported by the runner as `failed` with land's message, the run exits 1 and
the queue stops (every later landing would push the same range); the
ledger's committed `done` stays. Re-checked without Claude: setup, install,
push, undo, reinstall, push: PASS (8 steps passed, 4 skipped, 2 subjects
checked), pushed. Unit tests in `test/unit/lifecycle/undo.test.ts` and
`test/unit/runctl/run.test.ts`.

| Run | Result |
|---|---|
| D, `HARNESS_RUN_CLAUDE=1`, after fix 10 | failed at my own assertion `/^Revert /` on the undo's subject, which is now `revert: chore(harness): apply p-...` (fix 10 doing its job); test fixed |
| E, `HARNESS_RUN_CLAUDE=1` | **pass: 2 of 2 tests**, 150.5 s. Steps 1, 2, 5 as in B (setup 8.9 s, install 3.8 s, the reinstall's plan with the same 22 targets). Step 3: `harness run` exit 0 in 120 s, `T-001: landed: landed; CI is green`, 0.0232 USD as Claude reported it; one session of 26 turns, 97.7 s; landing subject `chore: say how long ago something expired (T-001)`; `landing.json`: `landed` true, `post_landing_red` false, `auto_fixed` false, `reverted` false, `revert_correct` null, CI initial green 14.5 s; `main`: `chore(harness): apply ...`, `revert: chore(harness): apply ...`, `chore(harness): apply ...` (reinstall), `feat(cli): say how long ago an item expired`, the landing commit; pushed |

## Fixes made by this integration

Each has a unit test. For fixes 1 and 6 the test was run against the unfixed
code (the fix undone in the compiled output) and failed; for the others the
failing run that found the defect is the evidence, and their tests were not
run against the unfixed code.

| # | Found in | Defect | Commit |
|---|---|---|---|
| 1 | run 1, install | the personal CLAUDE.md got the `@AGENTS.md` import but not its listed R04/R25/R29 moves | `c5a863a` propose |
| 2 | run 1, install | the repository's own `prettier --check .` (its CI) failed on 11 harness files | `06799a8` render: `.prettierignore` block |
| 3 | known issues (a), (b) | ledger changes left uncommitted; `--ci local` could not run a repository's CI or the planted step | `8b335e6` land: the task file rides on the landing commit; `--ci-command` / `land.ciCommand`; guard denies the flag from agents |
| 4 | run 2 | the first push after `install --commit` refused by the installed pre-push gate (tamper on the apply commit, its subject) | `037aab2` gate tamper exemption for recorded apply commits; apply subject follows the standard |
| 5 | known issue (c) | Codex sandbox could not write `~/.harness` | `f63b81f` render: `writable_roots` for both settings |
| 6 | attempt 3a | worktrees inside the protected `~/.harness`; project allow rules ignored in untrusted worktrees; task text missing from the worktree | `d3dba54` runner: `~/.harness-worktrees`, `--allowedTools`, task text in the prompt |
| 7 | attempt 3b | no allow rule for `git add`/`git commit`; `wip: pause` subject failed the gate | `b7efadd` personal git allow rules; pause subject; no pause commit at a runner session's end |
| 8 | attempt 3c, grader | landing subject with a capitalised summary | `f71d0f7` land: lower-case conventional summary |
| 9 | T-002 revert | the revert commit's body named the home folder | `fbd809f` land: home-relative evidence |
| 10 | acceptance run C | undo's `Revert "..."` subject refused by the pre-push gate after reinstall; runner called an unpushed landing "landed" | `ebfe6a7` undo subject and hooks; runner reports push failures and stops the queue |

Also changed: the task skill and land's output no longer ask for `harness task
done` after landing, and the intake README says the same; ARCHITECTURE's state
layout (worktrees); the land, runctl, render and gate READMEs; the Codex
self-check page; `docs/PERSONAL-SETUP.md`.

## Not run, and open

- **Codex and Devin**: not installed here. Their rendered files were checked
  for place and shape (the Codex `config.toml` block in runs 2 and 3); whether
  this Codex version honours `writable_roots` for the gate is step 6 of
  `selfcheck/codex.md`.
- **A real auto-fix that lands** (`auto_fixed` true, P05's `release-policy`)
  was not run with Claude; the land unit tests cover that path with a
  scripted session. The one real fix attempt (T-002) correctly declined to
  change anything.
- **The T-002 work before its revert was not graded** (only the reverted end
  state).
- **Hosted CI**: the generated GitHub workflow was not run (no remote);
  with `HARNESS_TOOL_REPO` set its full-gate mode has no `~/.harness` and
  reports the apply commit on the first push after an install.
- **Assess recall**: the planted R30 pair (commit to main / never commit to
  main) is not found; assess's R30 check has no branch-policy topic.
- **Discovery precision**: the discovered commit-subject check did not
  enforce the lower-case summary its own statement names (fix 8 works around
  it for the harness's own subjects; an agent's capitalised subject would
  still pass the gate).
- **Other formatters** (dprint, Biome): only Prettier gets an ignore block.
- **Interactive trust**: a person who opens Claude Code interactively in a
  task worktree still gets the trust dialog; the runner's headless sessions
  do not need it.
- **This machine**: the driver drops the session-id variables this
  environment's own agent session exports; a user's terminal has none. The
  runs used `<harness>/bin` on PATH, as the setup guide says.
