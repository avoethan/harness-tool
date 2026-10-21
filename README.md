# harness

`harness` sets up a working environment (a "harness") around coding agents:
Devin desktop, Claude Code and Codex. It reads your code and the agent setup
you already have, works out the standards your code really follows (with
evidence), and then configures the agents so that they:

- follow those standards without being reminded;
- prove their work before they call it done: tests, types, lint, build, and
  end-to-end checks against a running service and a test database;
- need you only rarely;
- turn each repeated mistake into a check, so they get more reliable over time.

Everything it changes is backed up first and can be undone in one step.

**Contents:** [The two settings](#the-two-settings) ·
[Requirements](#requirements) · [Install](#install) ·
[Quick start: team](#quick-start-team-setting) ·
[Quick start: personal](#quick-start-personal-setting) ·
[Safety rails](#safety-rails) · [Everyday use](#everyday-use) ·
[Updates, undo, uninstall](#updates-undo-and-uninstall) ·
[The report](#reading-the-report) · [Self-checks](#self-checks) ·
[Troubleshooting](#troubleshooting) · [Agent status](#status-of-each-agent) ·
[How it works](#how-it-works) · [Developing](#developing-the-harness) ·
[More documentation](#more-documentation)

## The two settings

You pick one setting per install. Both use the same tool.

| | Team | Personal |
|---|---|---|
| For | repositories you share with a team | a repository that is yours |
| Where the harness lives | only in your user folder (`~/.harness` and the agents' user-level settings) | in the repository itself (`AGENTS.md`, `.claude/`, `.codex/`, `.agents/skills/`, `.harness/`, `tasks/`) plus git hooks and a CI workflow |
| Written inside the repositories | nothing, ever | the harness files above, committed |
| Work starts from | a ticket you paste into the chat | a task in the repository's `tasks/` folder |
| Work ends with | a PR write-up you paste yourself; the agent may commit on a local branch but may not push or open a PR | `harness land`: merged to main once every check passes, then CI; a failure after landing is fixed or reverted automatically |
| Agents | Devin desktop first; Claude Code and Codex if you use them there | Claude Code and Codex (Devin optional) |

## Requirements

Required:

- **Node.js 20 or newer** (`node --version`). No admin rights needed: the
  Windows zip from nodejs.org, unpacked into your user folder, works.
- **Git** (`git --version`).
- At least one agent: **Devin desktop**, **Claude Code** or **Codex**.

Optional (each one that is missing is reported by `harness doctor`, never
silently skipped):

- **ast-grep**, for the syntax-based standards probes. It comes with
  `npm ci` as an optional npm dependency with ready-made binaries for
  Windows, macOS and Linux; without it the probes fall back to ESLint only.
- **Your repositories' own linters**: ESLint, Prettier, dependency-cruiser,
  knip, a SQL linter. The harness never installs them; it uses the copies in
  each repository's `node_modules` when they are there.
- **Semgrep** (Python), for taint checks. Skipped and reported when absent.
- **A test database** for end-to-end checks: Docker with a SQL Server
  container, or a SQL Server you mark as a test server. Without one, every
  database command stays denied (that is the safety rail) and the end-to-end
  checks say so.

## Install

The harness installs from a git clone. It needs no admin rights and runs no
install scripts, and the build changes nothing outside its own folder. Its
state goes to `~/.harness`; agent settings change only when you run
`harness install` (or `apply`) and approve the plan.

### Windows (no admin rights)

In PowerShell:

```powershell
cd $HOME
git clone <harness repository URL> harness-tool
cd harness-tool          # the folder that holds package.json
npm ci --ignore-scripts
npm run build
& "$HOME\harness-tool\bin\harness.cmd" version
```

To type plain `harness`, either define a shortcut for the current PowerShell
window (it changes nothing on the machine):

```powershell
function harness { & "$HOME\harness-tool\bin\harness.cmd" @args }
```

or add the `bin` folder to **your user** PATH once (no admin rights; open a
new terminal afterwards):

```powershell
$bin = "$HOME\harness-tool\bin"
$parts = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ })
if ($parts -notcontains $bin) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')
}
```

The agents do not need PATH: when `harness` is not found, the instructions
the harness installs tell them to run `node "<harness folder>/dist/src/cli.js" ...`,
and their allow rules cover that form.

### macOS and Linux

```sh
git clone <harness repository URL> ~/harness-tool
cd ~/harness-tool
npm ci --ignore-scripts
npm run build
./bin/harness version
ln -s ~/harness-tool/bin/harness ~/.local/bin/harness    # optional, if ~/.local/bin is on your PATH
```

Then run `harness doctor`: before an install it reports the missing config,
hooks and allowlist as warnings, which is expected.

## Quick start: team setting

The full walk-through, with every click for Devin, Claude Code and Codex on
a Windows work machine and what to send back afterwards, is
[docs/TEAM-SETUP.md](docs/TEAM-SETUP.md). In short:

1. **Close the agents** (they read their settings at start).
2. **Install**, in your own terminal, pointing at the folder that holds your
   repositories:

   ```sh
   harness install --setting team --agents devin,claude,codex --workspace ~/work
   ```

   It discovers the standards, reads your current agent setup, lists the
   database servers it found and asks which are **test** databases, shows the
   plan (each file, what changes, why, the diff) and asks before applying it
   with backups. Leave out agents you do not use. In an agent's chat, the
   `setup` skill can do the reading and explaining first and then hand you
   this command.
3. **Turn the hooks on** in each agent: Devin, open the workspace and trust
   the folder (never use Bypass mode); Claude Code, start a new session;
   Codex, run `/hooks` and trust the harness entries.
4. **Check**: `harness doctor` (everything `ok`, or a warning you understand)
   and `harness status`.
5. **Run the self-checks** for Devin and Codex ([Self-checks](#self-checks)).
6. **Work**: paste a ticket into the agent's chat and ask it to work on it
   (the `task` skill takes over). At the end the agent shows the PR
   write-up; you review the branch, push and open the PR yourself.

## Quick start: personal setting

The full walk-through is [docs/PERSONAL-SETUP.md](docs/PERSONAL-SETUP.md).
In short, from inside your repository:

1. **Install** (agents default to Claude Code and Codex):

   ```sh
   harness install --setting personal --workspace . --commit
   ```

   Add `--db-test localhost,1433/app_test` to mark a test database without
   being asked, or `--db-none` to deny every database command. `--commit`
   commits the harness files in one commit.
2. **Add tasks**: `harness task add --title "Add CSV export" --acceptance "GET /export returns 200 with text/csv"`
   (or write them in `tasks/` yourself).
3. **Run the queue**: `harness run --once --agent claude` takes the next
   task, gives it to a fresh headless session in its own worktree, runs the
   done-gate and lands it on main when it passes. Without `--once` it keeps
   going until the queue is empty (or `--max-tasks` is reached). A task that
   hits a cap (turns, minutes, budget) fails and is not retried.
4. **Watch**: `harness status` shows each task's phase, attempts and last
   verdict. `harness run pause` stops safely; `harness run resume --task <id>`
   continues.

## Safety rails

These defaults cannot be turned off by the agent. The hooks deny the action
before it happens, the git hooks and the gate check again, and the agents'
own permission rules repeat them where the agent supports it.

| Rail | What it means |
|---|---|
| Test databases only | Database clients, connection strings, scripts and MCP database tools may reach only the servers and databases you marked with `harness db mark ... --test`. Nothing marked means every database command is denied. A hand-edited allowlist is refused until it is marked again. |
| No secrets in commits or logs | Secret files (`.env`, keys) are never added, read into the chat, copied or overwritten; commits are scanned; the harness's own evidence and logs are redacted as they are written. |
| No force-push or history rewrite | `push --force` in every spelling, pushes that delete or mirror, `rebase` (and `pull --rebase`), `commit --amend`, `reset --hard`, `filter-repo` and `filter-branch`, and skipping git hooks (`--no-verify`, `core.hooksPath`): denied. |
| Team: nothing of the harness in team repositories | The harness writes nothing inside a team repository; harness-shaped files are refused before they are written, staged or committed; the agent does not push, open PRs, or change remotes. |
| The rails protect themselves | Agents cannot write the harness state, their own settings or the harness package; the hooks check their own integrity and fail closed when it changed; admin commands are yours only ([docs/COMMANDS.md](docs/COMMANDS.md#the-admin-rail)). |
| The gate cannot be gamed | Deleted, skipped or weakened tests, and edits to protected config, fail the gate; the Stop hook stops an endless loop with an attempt cap. |
| Personal: revert on failure | A change that turns main red after landing gets one fix attempt through the same gate; otherwise it is reverted and the task goes back to the queue. |

What each rail is tested against, how, and the recorded results:
[SAFETY.md](SAFETY.md).

## Everyday use

Every command, who runs it and what it writes is in
[docs/COMMANDS.md](docs/COMMANDS.md); `harness help <command>` prints the
exact syntax. The ones you will use:

```sh
harness status                  # where things stand and the next thing to do
harness doctor                  # check the install
harness db mark --server localhost,1433 --database shop_test --test   # mark a test database
harness db list                 # what is marked
harness learn review            # approve or reject lessons the agents learned
harness report --md             # the summary report (counts only)
harness digest                  # one page per ticket: gate, rails, tests phase, landing (names and counts)
harness config get              # current settings; `config set <key> <value>` changes one
```

The agents run the task-time commands themselves: `harness intake` (turn the
ticket into a brief), `harness phase tests|implement`, `harness gate` (the
done-gate), `harness verify` (end-to-end checks), `harness writeup`, and in
the personal setting `harness land`.

**What it costs.** A task run with the harness costs about 2× the agent
money of the same task run plainly, because of the extra turns for intake,
the tests phase, the live check and the gate. What you get for it is a
change with proof and a write-up.

## Updates, undo and uninstall

**Update the harness:**

```sh
cd ~/harness-tool
git pull
npm ci --ignore-scripts
npm run build
harness self-update --dry-run    # what would change
harness self-update --yes
```

`self-update` replaces only the generated files that are still exactly as
the harness wrote them, shows a diff for files you edited (and keeps them),
adds new settings entries without removing any, and re-signs the integrity
check so the hooks trust the new build. Re-running `harness install` with the
same setting also works: it proposes only differences.

**Undo the last change:** `harness undo --dry-run`, then `harness undo --yes`.
Files are restored from their backups by content hash; a file you edited
since is kept and listed, and only the settings entries the harness added are
removed. `harness undo --plan <id> --yes` undoes a specific plan.

**Uninstall:** `harness uninstall --dry-run`, then `harness uninstall --yes`
(personal: add `--repo .`). It removes everything the manifest says the
harness owns. Backups are kept in `~/.harness/backups/`. Delete
`~/.harness` and the `harness-tool` folder afterwards if you want nothing
left.

## Reading the report

`harness report --md` prints a summary you can share: **counts only**, no
code, no names, no paths, no ticket text. Before it prints or writes
anything it is checked against every repository name, path segment,
identifier and ticket word of your workspace, and refused if any appears
(`harness report --check-scrub` runs that check on its own).

| Section | What it tells you |
|---|---|
| Standards by tier | how strongly each discovered standard is backed: declared in a config or CI, counted in most of the code, from reviews, or seen once |
| Standards by family | what they are about (lint, format, types, naming, layout, SQL, tests, ...) |
| Checks generated | runnable checks, by what a failure does: **block** stops the work, **warn** reports it, **judgment** asks a person |
| Assessment findings and line classes | what the harness found in your existing agent files, and what it decided for each line (keep, convert to a check, trim, fix, split, quarantine) |
| Team proposals | changes written for the team's own review process; never applied |
| Tasks | one row per ticket (by hash): criteria, checks run, checks that failed and were fixed, the gate verdict, end-to-end evidence files, standards flagged, clarifications asked, repeated corrections, steering messages, rework rounds, outcome |
| Learning loop | lessons captured, proven, approved, expired |
| Self-checks | which self-check steps you recorded, and which matched |

`--json` gives the same data for a machine, `--since <date>` limits the
period, `--out <file>` writes it to a file. `harness report row --task <id>
--append` adds a pre-filled row to your work log (`~/.harness/worklog.csv`)
for you to complete.

## Self-checks

Some agent behaviours can only be confirmed on the machine where the agent
runs (whether a hook can block, what it receives, how a slow Stop hook is
treated). After installing for Devin desktop or Codex, follow the
step-by-step pages and record each result:

| Agent | Page | Time |
|---|---|---|
| Devin desktop | [selfcheck/devin-desktop.md](selfcheck/devin-desktop.md) | about 20 minutes |
| Codex | [selfcheck/codex.md](selfcheck/codex.md) | about 15 minutes |

```sh
harness selfcheck probe-files --agent devin     # temporary probe files at user level
harness selfcheck record --agent devin --step 4 --result "pass: saw both markers"
harness selfcheck                               # every step and what you recorded
harness selfcheck probe-files --agent devin --remove
```

Results stay on your machine (`~/.harness/selfcheck/`); the report carries
only the step names and whether each matched. Details:
[selfcheck/README.md](selfcheck/README.md).

## Troubleshooting

Start with `harness doctor`. Every line is `ok`, `warn` or `fail`, and every
`warn` or `fail` has a `fix:` line saying what to do.

| You see | What to do |
|---|---|
| `built: fail` or exit code 3 | run `npm run build` in the harness folder |
| `integrity: fail`, and every agent tool call is denied | the hook files or the config changed after they were signed (an edit, or a `git pull` and build without `self-update`). In your own terminal: `npm run build` in the harness folder, then `harness self-update --yes` (or re-run `harness install`), which re-signs them |
| `db-allowlist: warn` (empty) | expected until you mark a test database: `harness db mark --server <host[,port]> --database <name> --test` |
| `db-allowlist: fail` (hash mismatch) | the allowlist was edited by hand; mark the entries again with `harness db mark` |
| `hooks:<agent>: warn` | the hooks are not registered for that agent: re-run `harness install` with that agent in `--agents` |
| `codex-hooks-trusted: warn` | open Codex, run `/hooks`, trust the harness entries, start a new session |
| `scanner:...: warn` | an optional tool is missing; the checks that need it are skipped and reported |
| `state-repo: warn` | `harness doctor --fix` makes `~/.harness` a git repository with no remote (your undo trail) |
| An agent says "only the user runs it, in a terminal" | it hit the admin rail; run the command it quotes (after "ask the user to run:") yourself, in your own terminal |
| `harness` is not found | use `bin\harness.cmd` (Windows) or `bin/harness` with its full path, or add `bin` to your PATH ([Install](#install)) |

`harness status` shows the next thing to do; `harness doctor --json` gives
the same checks for a script (it contains your local paths, so read it
before sharing it).

## Status of each agent

Version 0.1.0. What was tested where the harness was built, and what only
your machine can confirm:

| Agent | Tested here | You confirm |
|---|---|---|
| Claude Code | behaviour-tested: real headless `claude -p` sessions drive the hooks, the Stop gate, the install and the safety rails (test suites `test/behaviour`, `test/safety`, and the runner acceptance test) | nothing extra; `harness doctor` after install |
| Codex | built from Codex's documentation and source; no Codex login was available, so no Codex session ran here. The safety suite feeds Codex-shaped hook payloads (including commands as argument arrays) to the hook process | the Codex self-check ([selfcheck/codex.md](selfcheck/codex.md)): hook trust, blocking, the Stop hook (on Codex a Stop block only re-prompts), the sandbox |
| Devin desktop | built from Devin's documentation; Devin cannot run here, so no Devin session ran. The safety suite feeds hook payloads in Devin's documented format to the hook process | the Devin self-check ([selfcheck/devin-desktop.md](selfcheck/devin-desktop.md)): hook blocking, the field names hooks receive, Stop-hook timing and repeated blocks, Restricted and Bypass modes |
| Others (Cursor, Copilot, Gemini) | not supported in this version | — |

The recorded results of the safety suite are in [SAFETY.md](SAFETY.md); the
acceptance tests and what they need are in
[test/acceptance/README.md](test/acceptance/README.md) (in the source
repository).

## How it works

- **Discover** (`harness discover`): reads every config by its documented
  name and runs its probe library over the code (63 probes in this version:
  ast-grep for syntax, patterns for names, folders, SQL migrations and commit
  subjects; `harness discover --self-test` runs the probes' own cases), then ranks each
  convention by its evidence. A rule a config declares but the code does not
  follow is reported as a finding, never as a standard; repositories that
  disagree each get their own scoped record. Details:
  [src/discover/README.md](src/discover/README.md).
- **Assess** (`harness assess`): reads your existing agent files (instructions,
  rules, skills, hooks, permissions, MCP) at user, workspace and repository
  level and classifies every line. Files with hidden Unicode or
  injection-like text are quarantined. Details:
  [src/assess/README.md](src/assess/README.md).
- **Propose and apply** (`harness propose`, `harness apply`): renders the
  harness for each agent (always-on instructions within the agent's size
  limits, skills, hooks, permission rules) as a plan with a diff and a reason
  per change, then applies it with backups and a manifest. Details:
  [src/render/README.md](src/render/README.md).
- **The done-gate** (`harness gate`): cheapest checks first: a tamper diff
  against the base commit, a secret scan, end-to-end evidence freshness, the
  discovered standards on the changed files, lint, typecheck and build with
  the repository's own tools, the tests that existed before, the ticket's
  acceptance checks (each proven to fail before the change), changed-line
  coverage. Results are cached per step, so a re-run repeats only what
  changed. Details: [src/gate/README.md](src/gate/README.md).
- **End-to-end checks** (`harness verify`): starts the touched services on
  free ports against a per-run copy of a marked test database, drives real
  requests and queries, and stores redacted evidence tied to the code it ran
  on. Details: [src/verify/README.md](src/verify/README.md).
- **Intake and write-up** (`harness intake`, `harness writeup`): a pasted
  ticket becomes a brief with numbered criteria, a check for each, and the
  questions worth asking; the write-up links each criterion to its evidence.
  Details: [src/intake/README.md](src/intake/README.md).
- **Landing and the queue** (personal: `harness land`, `harness run`): main
  moves only to a tree the gate passed; CI is watched; a red main gets one fix
  attempt, then a revert. Details: [src/land/README.md](src/land/README.md),
  [src/runctl/README.md](src/runctl/README.md).
- **Learning** (`harness learn`): mistakes are logged as names and counts (no
  text); a mistake that repeats becomes a lesson with an enforcer, and the
  enforcer must be proven to catch the original mistake. Checks in the private
  harness folder are added at once; anything that changes what the agents
  read waits for your review. Details: [src/learn/README.md](src/learn/README.md).
- **Hooks and the guard**: one hook entry point serves all three agents; the
  guard parses each command and applies the rails. Details:
  [src/hooks/README.md](src/hooks/README.md),
  [src/guard/README.md](src/guard/README.md).

## Developing the harness

```sh
npm ci --ignore-scripts
npm run build
npm run test:quick         # unit tests: fast, no network, no Docker, no agent runs
npm run test:acceptance    # end to end over fixtures; skips (with the reason) what it cannot reach
npm run test:safety        # the safety rails (SAFETY.md)
npm run test:behaviour     # real headless agent sessions (needs Claude Code; costs model usage)
npm test                   # build, then every suite
node scripts/check-public.js   # the publish check
```

`HARNESS_SKIP_CLAUDE=1` and `HARNESS_SAFETY_BEHAVIOUR=0` keep the
acceptance, safety and behaviour suites from starting agent sessions.
[ARCHITECTURE.md](ARCHITECTURE.md) is the contract between the components;
[docs/PUBLISHING.md](docs/PUBLISHING.md) is how the tool is published;
[CHANGELOG.md](CHANGELOG.md) lists the versions.

## More documentation

| Page | For |
|---|---|
| [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md) | installing the team setting on a Windows work machine, step by step, and what to send back |
| [docs/PERSONAL-SETUP.md](docs/PERSONAL-SETUP.md) | installing the personal setting in your own repository |
| [docs/COMMANDS.md](docs/COMMANDS.md) | every command, its flags, who runs it, what it writes |
| [SAFETY.md](SAFETY.md) | the safety rails, their tests and recorded results |
| [selfcheck/README.md](selfcheck/README.md) | the work-machine self-checks |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | publishing the tool on its own |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the pieces fit, for contributors |

## Status

Version 0.1, the first complete build: every command in `harness help` is built and
covered by tests. Claude Code was behaviour-tested on this machine; Devin desktop and
Codex were checked against their documentation and need the self-checks on your
machine. `SAFETY.md` lists the safety tests (`test/safety/`), how they run, their
recorded results and what they do not cover.

## License

MIT. See [LICENSE](LICENSE).
