# Integration run: team setting on the team stand-in

Recorded commands and outcomes of the end-to-end integration of the team
setting: install for Devin, Claude Code and Codex on the team stand-in, one
ticket driven by Claude Code headless, and the undo / reinstall / uninstall
round trip. Every number below comes from a run recorded here; paths are
shortened to `<scratch>` (a temporary folder) and `<harness>` (this folder).

Machine: Linux, Node v22.22.0, Docker 29.8.2 with the SQL Server 2022
container `harness-standin-mssql`, Claude Code 2.1.303. Codex and Devin
desktop are not installed here: their files are checked for place and shape
only; their loading is covered by the self-check pages in `selfcheck/`.

Isolation for every harness command below: `HOME`, `USERPROFILE` and
`HARNESS_USER_HOME` point at `<scratch>/rough-harness-home` (the fake HOME
the stand-in setup writes), `HARNESS_HOME` at `<scratch>/rough-harness-home/.harness`,
`XDG_CONFIG_HOME` at `<scratch>/rough-harness-home/.config`, `GIT_CONFIG_NOSYSTEM=1`.
The only credential copied into the fake HOME is the Claude login (three keys
of `~/.claude.json`, the way `test/behaviour/claude-runner.ts` does it).

## Run 1 (2026-10-19), before any fix

### Step 1: the stand-in workspace with its database

```
node <team stand-in>/setup.js <scratch>/shop --db-name shop_it1
```

Outcome (17.4 s): three repositories created (catalog-api 17 commits,
orders-api 18, fulfillment 18), `npm ci` in each (315 / 315 / 318 packages),
database `shop_it1` created through the running container, 7 migrations
applied, seed applied (6 products, 4 orders, 5 order items, 1 shipment),
rough harness written: `<scratch>/rough-harness-home/.claude/CLAUDE.md`, two
skills (`ship-it`, `sqlHelper`), and `<scratch>/shop/AGENTS.md`. A distinct
database name was used because other runs share the container.

Before the install: a hash snapshot of the fake HOME (9 paths) and of the
workspace without `node_modules` (954 paths, `.git` folders included).

### Step 2: the real install

```
harness install --setting team --agents devin,claude,codex \
  --workspace <scratch>/shop --yes --db-test localhost,1433
```

Outcome: exit 0 in 15.8 s. Discovery: 36 standards in 3 repositories
(ast-grep probes 1450 / 1759 / 2057 matches). Assessment: 5 agent files,
32 findings (3 high), 7 safety rules kept. Database candidates found:
`localhost,1433/shop_test`; marked test: `localhost,1433` (every database).
Plan `p-20261019-183747-b042`: 22 files (4 of the user's files changed as
proposals, 14 created, 3 settings files merged, 1 rules file created).

Checks after the install:

| Check | Result |
| --- | --- |
| Always-on files where each agent loads them (RESEARCH 7.4) | Devin `~/.config/devin/AGENTS.md` (51 harness lines, 4081 bytes), Claude `~/.claude/CLAUDE.md` (marker block of 30 lines after the user's text; 4052 bytes), Codex `~/.codex/AGENTS.md` (52 lines, 4092 bytes) |
| Skills | Claude `~/.claude/skills/{task,learn,setup}/SKILL.md`; Devin and Codex share `~/.agents/skills/{task,learn,setup}/SKILL.md` |
| Scoped rules | Devin `~/.devin/rules/<repo>.md`, Claude `~/.claude/rules/<repo>.md` (3 repos each) |
| Hooks | Devin `~/.config/devin/config.json` `hooks`; Claude `~/.claude/settings.json` `hooks`; Codex `~/.codex/hooks.json` |
| Permission rules | Devin `config.json` `permissions`; Claude `settings.json` `permissions` (31 allow, 405 deny); Codex `~/.codex/rules/harness.rules` |
| Nothing written inside the three repos | `git status --porcelain --ignored` in each: only `node_modules/` (ignored, from setup). Workspace hash diff before/after: 1 difference in 954 paths, the parent-folder `AGENTS.md` (the user's own file, outside every repo, a proposal of the plan) |
| Manifest lists every file | 22 manifest entries; the fake HOME diff shows 21 changed or added files, plus the workspace `AGENTS.md`: all 22 in the manifest, none missing |
| `harness doctor` | 11 ok, 5 warnings, 0 failures: hooks registered for Devin (7 events), Claude Code (9 events), Codex (6 events); `db-allowlist localhost,1433=test`; integrity manifest matches; state folder is a git repository with no remote. Warnings: dependency-cruiser and knip absent in the three repos, semgrep absent, no Codex heartbeat yet (Codex not run here) |
| Integrity manifest | `~/.harness/integrity.json` holds the SHA-256 of 28 protected files (hook entry, hook and guard modules, config, manifest), written at install; doctor verified it |
| `harness status` | "team setting; agents devin, claude, codex", workspace with 3 repos, 36 standards (26 blocking), 1 database marked test, integrity ok, 0 tasks, self-checks devin 0/16 and codex 0/10 recorded; next step: the Devin self-check |

## Run 2 (2026-10-19, after the session restart)

The scratch folder of run 1 was gone, so steps 1 and 2 were repeated as the
base for step 3 (same commands, a new database name).

### Steps 1 and 2 again

```
node <team stand-in>/setup.js <scratch>/shop --db-name shop_it2      # 20.5 s
harness install --setting team --agents devin,claude,codex \
  --workspace <scratch>/shop --yes --db-test localhost,1433
```

Same outcome as run 1: 3 repositories (17 / 18 / 18 commits), `npm ci`
315 / 315 / 318 packages, 7 migrations and the seed applied to `shop_it2`;
install exit 0, 36 standards in 3 repositories, assessment 5 agent files /
32 findings (3 high) / 7 safety rules kept, plan of 22 files. The Claude
login (3 keys of `~/.claude.json`) was copied into the fake HOME before the
install. The installed Claude settings hold 85 allow rules (the repos'
verification commands, every task-time `harness` subcommand in both the bare
and the quoted `node "<cli.js>"` form, read access to `~/.harness/runs/**`),
413 deny rules and 9 hook events (PreToolUse twice: the rail matcher and `*`).

### Step 3, run A: T02 (SHOP-102, low-stock endpoint) with Claude Code, before the fixes below

```
cd <scratch>/shop/catalog-api
claude -p "<prompt>" --model claude-sonnet-5-5 --max-turns 60 --max-budget-usd 2 \
  --permission-mode default --allowedTools Edit Write MultiEdit \
  --output-format stream-json --verbose
```

`HOME`, `HARNESS_HOME` and `XDG_CONFIG_HOME` as above; the host's extra
directories and skill sync variables unset. `harness` is not on PATH (the
agent must use the `node "<cli.js>"` form the CLI note prints). Edit, Write
and MultiEdit are allowed on the command line to stand in for the user
clicking "allow" on file edits (headless has nobody to click; the install
writes no allow rule for them, by design). The prompt: the ticket text of
`tasks/02-low-stock/ticket.md` after one paragraph: "Work it through with the
task skill, phase by phase, using the harness commands the skill names (...).
Do not commit and do not push. When you are done, show me the write-up."

Result: exit 0 in 128 s wall (`duration_ms` 128188), **48 turns, $0.507**,
`subtype` success. What happened, in order:

| Phase | Observed |
| --- | --- |
| Skill | `task` skill launched first (SessionStart and UserPromptSubmit hooks injected the session facts and catalog-api's standards) |
| Intake | 1. `cat > $TMPDIR/ticket.txt <<'EOF' ...`: **denied by the guard** (rail `opaque`: a variable redirect target). 2. `node "<cli.js>" intake --from - <<'EOF' ...`: **refused by Claude Code's own permission check** ("A variable in this command can't be checked before it runs": the ticket holds backticks). 3. `... intake --from - < <file>`: refused the same way. 4. The agent wrote the ticket with the Write tool to its scratch folder and ran `... intake --from "<file>"`: brief `t-948e04f635` written. The skill's `--from -` instruction does not work under Claude Code's permission checks (fixed below) |
| Brief | AC1, AC2 `unit 0.55`; AC3 `untestable` with a blocking question; AC4 `api` read as `POST /:id -> 201, body "low-stock"`. The endpoint `GET /products/low-stock` is named only in the description, so no criterion was checked against it (fixed below, known issue (c)) |
| Tests phase | `phase tests`, tests written for AC1 and AC2 (2 test files), PostToolUse injected lint feedback twice (unused import, prettier; 3 more repeats suppressed), `gate prove-red`: AC1 and AC2 **proven red** at the base commit |
| Implement | `phase implement`, route and service changed; `npm run format` and `npx prettier --write` refused (no allow rule; headless); the agent fixed formatting by hand, went back to `phase tests` once for a test file (entry 2), proved red again, `npm test` 37 passed |
| Verify | `verify launch` **refused (exit 4)**: "sqlcmd would connect to harness-standin-mssql/test_<run>, which is not marked as a test database". The install marked `localhost,1433`; verify reached SQL Server through `docker exec` into the container that publishes 1433, and the rail judged the container name (fixed below). No artefact |
| Gate | attempt 1: **FAIL**, 13 steps, 9 passed (tamper, secrets, standards 36 records, lint, typecheck 1.6 s, build 1.3 s, tests:base 37 passed, acceptance:AC1, acceptance:AC2), 1 failed (`e2e:AC4`: no artefact), 3 skipped (map-drift, coverage, affected). Attempt 2: `gate --blocked "<reason>"` → **BLOCKED** (exit 4) |
| Stop hook | `stop.pass` once (the BLOCKED record lets the agent stop); it never had to block |
| Write-up | written with the criterion table (4 rows, each "not linked to a gate step (gate BLOCKED)"), assumptions, feedback, and next steps that said `git push -u origin main` although the work was uncommitted on main (fixed below) |
| Guard | 45 allow, 1 deny (`opaque`); no rail was touched otherwise; nothing pushed, nothing committed |
| Trap | the planted rule of T02 (`layout-async-handler`) was kept: the new route is wrapped in `asyncHandler` (the gate's standards step passed) |

Permission refusals by Claude Code (no allow rule; default mode): 6 (the
three intake attempts above, `npm run format`, `npx prettier --write`, and a
compound `npm run format | tail; git status`).

### Fixes made from run A (each with a unit test; commits on this branch)

1. **verify vs the install's database mark** (`src/verify/sqlcmd.ts`,
   `dbrun.ts`): with the docker transport, a `localhost,<port>` entry marked
   test now covers the harness's own `sqlcmd` through the container that
   publishes that port; the agent's own commands are still judged as typed.
   Tests: `test/unit/verify/rail.test.ts` (7 cases, and `planDb` replaying
   this run: `localhost,1433` marked, container publishing 1433).
2. **verify login** (`src/verify/launch.ts`): without `verify.db.user` the
   harness's `sqlcmd` used integrated auth while the services used `DB_USER`
   from `.env.example`; it now uses that same login (noted at launch). Live:
   after fixes 1 and 2, `verify launch` started catalog-api on a per-run
   database on `localhost,1433` with login `sa` (2.9 s). Test:
   `test/unit/verify/featuremap.test.ts` (`exampleDbUser`).
3. **`config set verify.*`** (`src/commands/config.ts`): verify's messages
   told the user to run `harness config set verify.db.server ...`, but
   `verify` was not a settable key. Now settable from a terminal, validated
   (`passwordEnv` accepts a variable name only, never a password). Test:
   `test/unit/commands/config.test.ts`.
4. **verify cleanup** (`src/verify/cleanup.ts`): a run whose launch failed
   before its database existed tried to drop it and exited 1; now "never
   created by this run; nothing to drop". Test: `rail.test.ts`.
5. **intake** (`src/intake/classify.ts`, `brief.ts`; known issue (c)): see
   the section below.
6. **write-up** (`src/intake/writeup.ts`): on the default branch the next
   steps say to move the change to its own branch first and never suggest
   pushing main. Test: `test/unit/intake/writeup.test.ts`.
7. **task skill and the pasted-ticket reminder** (`templates/skills/task/SKILL.md`,
   `src/hooks/capture.ts`): save the ticket to a file outside the repository
   with the file tool and run `harness intake --from <file>`; never pipe it
   through the shell. The smaller side was the text: `--from -` stays for
   people at a terminal. Snapshot regenerated (the team task skill's hash
   only). Tests: `render.test.ts`, `userpromptsubmit.test.ts`.

### Known issue (c): intake on T02, T04, T10

Every ticket of both stand-ins (12 team + 12 personal, 98 criteria) was run
through `harness intake --from <ticket> --json` before and after the change; 47 of the 98 lines changed.
Changes on the three named tickets:

| Ticket | Before | After |
| --- | --- | --- |
| T02 AC1-AC4 | unit, unit, untestable, `POST /:id` 201 | api: `GET /products/low-stock` 200; `?threshold=20` 200; `?threshold=0` 400; `GET /products/low-stock` 200 |
| T04 AC1 | untestable (endpoint only in the description) | api: `GET /health/ready` 200, body `size`, `available` |
| T04 AC2 | unit | api: `GET /health/ready` 503 (the negated "no 500" is not taken) |
| T10 AC1 | db: `verify db --table README` | unit (a document check) |
| T10 AC2 | untestable | unit ("all tests pass") |

Other changes the comparison showed (each read against its criterion): quoted
routes, queries and method names are no longer expected bodies (18 checks
lost 20 bogus `--expect-body "GET /..."` flags; 0 remain); T01 AC3/AC4, T06 AC1/AC2, T12
AC1-AC3, P02 AC4, P03 AC3, P04 AC1-AC4, P09 AC1/AC3/AC4, P11 AC5 went from
untestable/unit/`<route>` to api checks against the endpoint their ticket
names; T03 now uses `GET /orders/:id/export.csv` (a method route may end like
a file); T07 AC2 uses `PATCH /shipments/:id/notes` (the method it names);
T01 AC4 ("never appear") no longer expects the excluded product in the body;
P03 AC2 and P11 AC3 read "answers 201/400" as statuses. Unchanged
limitations: route patterns (`/:id`, `<id>`) stay in the `run:` line for the
agent to fill; quoted JSON bodies are matched literally.

### Step 3, run B: the same ticket after fixes 1-7

Fresh workspace (`setup.js ... --db-name shop_it3`), fresh install (plan of 22
files, 15.6 s), then the user's one-time verify setting from a terminal:
`harness config set verify.db.snapshot db:shop_it3` (the per-run database is
restored from the team's seeded test database). The password variable
`HARNESS_VERIFY_DB_PASSWORD` was set in the agent's environment, as the user
would before starting the agent. Dry check before the agent ran: `verify
launch` (2.9 s, restored from a copy-only backup of `shop_it3`), one `verify
drive` (200 in 88.7 ms, PASS), `verify cleanup` (database dropped, backup copy
removed from the container).

Result: exit 0, 37 s, **13 turns, $0.153**. Intake now worked first time:
ticket saved with the Write tool, `intake --from <file>`, a brief of four api
checks against `GET /products/low-stock` and no question. Then the agent typed
the CLI path **without quotes** (`node /…/cli.js intake lint`, `… phase
tests`); the allow rules held only the quoted spelling, so Claude Code asked
for approval (refused headless) and the agent **stopped at phase 1** and said
why. Fix 8 below.

### Fix 8: both spellings of the node form (`src/guard/permissions.ts`)

The team allow rules now carry `node "<cli.js>" <sub>` and, when the path has
no spaces, `node <cli.js> <sub>` (Claude and Devin; Codex rules are argv
prefixes). Probe with Claude Code (haiku, 2 turns each, isolated HOME):
bare rule + bare command → ran, 0 denials ($0.0070); quoted rule only + bare
command → "This command requires approval", 1 denial ($0.0017). Test:
`test/unit/render/allow-rules.test.ts`. Snapshot regenerated (the team Claude
settings and Devin config hashes only).

### Step 3, run C: the same ticket after fix 8

Fresh workspace (`shop_it4`), fresh install (22 files, 15.8 s), the same
verify setting and password variable.

Result: exit 0, 183 s wall (`duration_ms` 181453), **42 turns, $0.434**,
**gate PASS**. In order:

| Phase | Observed |
| --- | --- |
| Hooks at start | SessionStart injected the session facts; UserPromptSubmit injected catalog-api's standards |
| Intake | ticket saved with the Write tool outside the repository; `node "<cli.js>" intake --from <file>`: brief of 4 api checks, no question; `intake lint`: "every criterion has a red-first check or an open question" |
| Tests phase | `phase tests` (entry 1); route and service tests written (2 test files); PostToolUse injected lint feedback once (unused variable); `gate prove-red` → exit 2 "the brief has no unit-kind acceptance checks" (fix 9); the agent ran the new tests with `npx vitest run` and saw them fail |
| Implement | `phase implement`; service and route changed; build, typecheck, lint, format:check and `npm test` all run |
| Verify | `verify launch` 2.5 s (snapshot of `shop_it4`, login `sa`); `verify doctor` ok; `verify drive` for each criterion, but **without `--criterion`**, so the artefacts were not linked (AC1 and AC4 share a route) |
| Gate attempt 1 | **FAIL**: 15 steps, 7 passed, 4 failed (`e2e:AC1`-`AC4`: no linked artefact), 4 skipped. The gate's hint repeated the brief's `run:` line, which had no `--criterion` either (fix 9) |
| Recovery | the agent read `verify drive --help`, relaunched (2.8 s), drove the four checks with `--criterion ACn` (and stronger `--expect-json products.0.id=3` / `products.1.id=2` of its own), `verify cleanup` |
| Gate attempt 2 | **PASS**: 15 steps, 11 passed (tamper, secrets, e2e:AC1-AC4, standards, lint, typecheck, build, tests:base 37 passed), 0 failed, 4 skipped (map-drift: no overlay, see fix 10; acceptance: no unit-kind checks; coverage: none configured; affected: single package); 6 results from the cache |
| Write-up | criterion table: 4 rows, each PASS with its artefact `e2e/ACn-http.json`; next steps "move the change to its own branch ... `git switch -c shop-102-low-stock-endpoint`" (fix 6 at work) |
| Stop hook | `stop.pass` once (fresh PASS evidence); it never had to block |
| Guard | 39 allow, 1 deny (rail `opaque`: `cd … || cd …` with a computed part); nothing pushed or committed (`git status`: 4 modified files) |
| Claude Code refusals | 3: the guarded compound above, `intake lint; echo exit=$?` ("A variable in this command can't be checked"), `curl` (no allow rule) |
| Trap | `layout-async-handler` kept (the new route is wrapped) |

Independent check with the stand-in's hidden grader (`node
tasks/grade.js <scratch>/shop 02`, which copies the repositories and grades
the uncommitted result): **resolved** (hidden unit tests 8/8 files incl. the
FAIL_TO_PASS route test with 11 tests, typecheck; E2E 5/5 assertions incl.
"default threshold lists 3" and "threshold 20 lists 3 then 2"),
**compliance 1** (0 violations in 4 changed files), **not tampered**, 9.7 s.

### Fixes 9 and 10 (from run C)

9. **`--criterion` in the brief's run lines and prove-red with only e2e
   checks** (`src/intake/classify.ts`, `src/gate/tests.ts`,
   `src/commands/gate.ts`, task skill): every `verify drive` / `verify db`
   line intake writes ends with `--criterion <id>`, so the artefact is linked
   even when two criteria share a route; `gate prove-red` on a brief with no
   unit checks exits 0 and says the e2e checks are red until verify records
   artefacts (it exited 2 as a usage error). Tests:
   `test/unit/intake/classify.test.ts`, `commands.test.ts`,
   `test/unit/gate/tests.test.ts`. Snapshot regenerated (task skill, both
   settings).
10. **map-drift skip message** (`src/gate/mapdrift.ts`): it said "`harness
    verify` builds it", but launch never writes the overlay the step reads; it
    now names `harness verify maintain --add-missing`. Test:
    `test/unit/gate/steps.test.ts`.

Not re-run after fixes 9 and 10: a fourth Claude run (the acceptance test's
`HARNESS_RUN_CLAUDE=1` case below repeats the ticket with tight caps).

## Steps 4 and 5: the acceptance test (`integration-team.test.ts`)

The round trip is automated in the acceptance test (steps 1, 2 and 4; step 3
behind `HARNESS_RUN_CLAUDE=1`), so the recorded numbers come from its runs.

```
HARNESS_STANDIN_TEAM=<team stand-in> node --test dist/test/acceptance/integration-team.test.js
```

Run 1 of the test (no Claude, no `npm ci`): **3 passed, 1 skipped** (the
Claude step, with the reason printed), 12.2 s.

| Step | Recorded |
| --- | --- |
| 1 | setup 4434 ms, database `test_it524419`, without `npm ci`; the three repositories clean |
| 2 | install 1624 ms, 22 files; placement ok for the three agents (always-on files at most 4096 bytes, skills, scoped rules, hook and permission files, both spellings of the `node <cli.js>` allow rule); workspace: only `AGENTS.md` (the parent folder's) changed, every repository `git status` clean; fake HOME: 18 files added, 3 changed, all in the manifest (22 entries, 0 missing); doctor 11 ok, 5 warnings, 0 failures; integrity manifest 28 entries; `status` reads "team setting", agents devin, claude, codex |
| 4 | second install: **no-op plan** (0 targets); `undo --plan <id> --yes`: 22 files in the record, 4 restored from their backups with equal SHA-256, the 18 created ones removed; fake HOME (outside `~/.harness`) and workspace **equal to the snapshots taken before the install**; install again: 22 files; once more: no-op; `uninstall --yes`: fake HOME and workspace equal to the snapshots again, every repository clean |

The test's database was dropped at the end (afterwards: 0 databases named
`test_it%` on the server).

Run 2 of the test with `HARNESS_RUN_CLAUDE=1` (= run D of the ticket; with
`npm ci`): steps 1, 2 and 4 passed (setup 20.3 s, install 16.6 s; no-op
install 13.9 s, re-install 13.7 s, uninstall 0.1 s; same placement, manifest
and doctor results). Step 3: `claude-sonnet-5-5`, exit 0, 102 s, **53 turns,
$0.378**, gate verdicts: **PASS** (attempt 1), 1 guard deny, `stop.pass` 1,
`stop.block` 0, 7 Claude Code refusals. The events show fixes 9 and 10 at
work: the brief's run lines end with `--criterion ACn`; `gate prove-red`
ran with 0 unit checks and did not stop the agent; every drive was linked
(`AC1-http` … `AC4-http`; one of the agent's own extra JSON expectations
failed once and was driven again); the gate passed on its first run. The
test itself then **failed on its own bug**: it trimmed the whole `git status
--porcelain` output, so the first line lost its status column and `src/…`
read as `rc/…`. Fixed (trim trailing whitespace only).

## Known issues (d) and (e)

(d) **A second install from another clone** (`src/lifecycle/owned.ts`,
`apply.ts`, `render/propose.ts`): before the union into a settings file, an
array element the manifest records as harness-added that names a harness
entry point (`dist/src/hook.js` or `dist/src/cli.js`) and is not in the new
fragment is dropped, so the new copy's hook entries and allow rules replace
the old ones; the user's own entries (even one naming a `hook.js` of its own)
are never touched, and propose's preview shows the same result. The new
lifecycle test (`test/unit/lifecycle/reinstall.test.ts`) also found that
uninstall undid an already-undone plan a second time (its manifest release
then skipped the first install's undo and left clone A's entry); undo now
marks the plan record (`undoneAt`) and uninstall skips marked records. Test:
install from clone A over a user's settings, install from clone B (3 entries
replaced, user entries kept, a shared rule kept once), same clone again (no
change), undo B (the bytes after A), re-apply, uninstall (the user's original
bytes).

(e) **The stand-in's `splitArgs`** (`<team stand-in>/standards/lib.js`):
the personal stand-in's fix ported; fixture `valid.comparison-comma.ts` red
before (20/21 expectations, 1 false violation) and green after (21/21);
untouched workspace 10/10 with zero violations; T02's and T01's naive fixes
still caught; T02's reference fix passes all ten checkers.

## Skill and command consistency

`test/unit/render/skill-commands.test.ts` reads every `harness …` command
the task, learn and setup skills name (57 lines) and checks that the command
exists and that its subcommand and every flag it uses appear in that
command's usage: all 57 consistent after the skill edits above (it also
fails on a made-up command, subcommand or flag). The behaviour of the task
skill's commands was exercised by runs A-D.

Also changed on the way (with tests): without a password variable, verify
keeps integrated (Windows) authentication instead of the example login
(`defaultLogin`, `test/unit/verify/featuremap.test.ts`).

Run 3 of the test with `HARNESS_RUN_CLAUDE=1` (= run E of the ticket, after
the parsing fix): **5 passed, 0 failed, 0 skipped**, exit 0. Setup 18.7 s
(with `npm ci`, database `test_itc1502d`), install 15.9 s (22 files),
placement / manifest (22, 0 missing) / doctor (11 ok, 5 warnings, 0
failures) / integrity (28) as before; round trip: no-op 14.9 s, undo (22
files, 4 hash-equal restores, 18 removed), re-install 22 files 14.0 s,
uninstall 0.1 s, fake HOME and workspace equal to their snapshots. Step 3:
`claude-sonnet-5-5`, exit 0, 138 s, **39 turns, $0.341**, gate verdicts:
**PASS**, 1 guard deny, `stop.pass` 1, `stop.block` 0, 6 Claude Code
refusals; a brief was written, nothing committed, only `src/` and `test/`
files changed in catalog-api, orders-api and fulfillment untouched.

## Step 3 summary: the Claude-driven ticket (T02, `claude-sonnet-5-5`)

| Run | Harness state | Turns | Cost | Wall | Outcome |
| --- | --- | --- | --- | --- | --- |
| A | before the fixes | 48 | $0.507 | 128 s | BLOCKED: `verify launch` refused by the database rail (glue bug: container vs `localhost,1433`); write-up with the table, no artefacts |
| B | fixes 1-7 | 13 | $0.153 | 37 s | stopped at phase 1: the agent typed the CLI path unquoted, the allow rules held only the quoted spelling (fix 8) |
| C | fixes 1-8 | 42 | $0.434 | 183 s | gate PASS on attempt 2 (attempt 1 FAIL: artefacts not linked, fix 9); hidden grader: resolved, compliance 1, not tampered |
| D | fixes 1-10 (acceptance test) | 53 | $0.378 | 102 s | gate PASS on attempt 1; the test failed on its own parsing bug |
| E | fixes 1-10 (acceptance test) | 39 | $0.341 | 138 s | gate PASS; acceptance test 5/5 |

Total spent on the five runs: $1.813 (plus $0.009 for the two allow-rule
probes). The Stop hook never had to block in these runs (each ended on a
fresh PASS or a recorded BLOCKED); its blocking is covered by
`test/behaviour/stop-gate.test.ts` and the safety suite. PostToolUse
injected lint feedback in runs A and C; no edit broke a ledger standard, so
no standard was injected (`ledgerHits` 0 in runs A-C; B made no edit; the instrumentation of D and E was not inspected for this). The guard denied one
command per run (rail `opaque`: a command whose program or redirect target is
computed at run time).

Not tested here: Devin desktop and Codex (not installed on this machine;
their files were checked for place and shape, their loading is what the
self-check pages confirm on the work machine); Windows (the launcher
`bin\harness.cmd` and the guide's PowerShell steps were not run).
