# Team setup: a Windows work machine without admin rights

This guide installs the harness for the **team setting**: everything lives in
your user folder, nothing is written inside the team's repositories, nothing
is pushed. It covers Devin desktop, Claude Code and Codex; follow only the
parts for the agents you use. Every step is a command to type or a click.

Commands are for **PowerShell**. `<harness>` means the folder you clone the
harness into (the one that holds `package.json`), and `<workspace>` the folder
that holds your repositories (it is not a repository itself).

Time: about 15 minutes to install, plus 20 minutes for the Devin self-check
and 15 for the Codex one.

---

## 1. Get the harness

You need Git and Node.js 20 or newer. Check:

```powershell
git --version
node --version
```

If `node` is missing or older than 20, ask for it, or use the Windows zip of
Node.js from nodejs.org unpacked into a folder in your user profile (no
installer, no admin rights) and run `node` from there.

Clone and build (no install scripts run, no admin rights needed):

```powershell
cd $HOME
git clone <harness repository URL> harness-tool
cd harness-tool            # the folder with package.json (go one level deeper if the repository holds it in a subfolder)
npm ci --ignore-scripts
npm run build
```

Check that it runs, using the launcher that needs no PATH change:

```powershell
& "$HOME\harness-tool\bin\harness.cmd" version
```

To type plain `harness` in this PowerShell window, define a shortcut for the
session (it changes nothing on the machine):

```powershell
function harness { & "$HOME\harness-tool\bin\harness.cmd" @args }
```

The rest of this guide writes `harness`. Agents do not need PATH either: the
installed instructions tell them to run `node "<harness>/dist/src/cli.js" ...`
when `harness` is not on PATH, and their allow rules cover that form.

## 2. Install for the team setting

Close the agents first (they read their settings at start). Then:

```powershell
harness install --setting team --agents devin,claude,codex --workspace "<workspace>"
```

Leave out agents you do not use (`--agents devin,claude`). The command:

1. discovers your repositories' standards (linters, formatter, naming, tests,
   SQL and layout conventions, with evidence) and reads your existing agent
   files;
2. lists the database servers it found in your repositories' example
   settings and asks which ones are **test** servers. Answer only for servers
   you are sure are test servers. Every other database stays blocked for the
   agents;
3. shows the plan: every file it will create, and every change to a file of
   yours as a diff. Your own files are only proposals: lines it would move
   go to an archive under `~/.harness`, never deleted;
4. asks "Apply this plan now?". Every file is backed up first.

At the end it prints the backups folder, the plan id, and the next steps per
agent. Nothing is written inside your repositories; check it if you like:

```powershell
cd "<workspace>\<a repository>"; git status
```

### Mark the test database (if you skipped it, or have another)

```powershell
harness db list
harness db mark --server <host[,port]> --test                       # every database on that server is test
harness db mark --server <host[,port]> --database <name> --test     # only that database
```

With nothing marked, every database command an agent tries is refused, and
`harness verify` cannot start a test database. That is safe, but the
end-to-end checks then report BLOCKED.

### End-to-end checks against the test database (once)

`harness verify` starts the services a ticket touches on free ports, with a
throw-away copy of the test database, drives the endpoints and drops the
copy afterwards. Tell it where the copy comes from:

```powershell
harness config set verify.db.snapshot db:<your test database name>
```

How it signs in to SQL Server:

- **Windows authentication** (no password): nothing to set.
- **A SQL login**: set the login once, and give the password to the agent's
  environment as a user variable (no admin rights; the agent and the
  services it starts can read it, so use a test-only login):

  ```powershell
  harness config set verify.db.user <login>
  [Environment]::SetEnvironmentVariable('HARNESS_VERIFY_DB_PASSWORD', '<password>', 'User')
  ```

  Start the agents again afterwards so they see it. The password is never
  written to a file by the harness and never put on a command line.

`harness config set` works only in a terminal you type into; agents cannot
run it.

## 3. Turn the hooks on in each agent

The harness works through hooks (they block unsafe commands and refuse "done"
without proof). Each agent needs one step from you:

- **Devin desktop**: open the `<workspace>` folder. When Devin asks whether you
  trust the folder, choose **Trust**. Hooks do not run in Restricted Mode.
  Never switch Devin to Bypass mode.
- **Codex**: start `codex`, type `/hooks`, and trust each harness hook entry.
  Codex runs a hook only after its exact text is trusted, and asks again if
  the harness changes it later. Then start a new Codex session.
  (Optional: end-to-end checks from inside Codex need
  `[sandbox_workspace_write] network_access = true` in `%USERPROFILE%\.codex\config.toml`.)
- **Claude Code**: start a new session. `/hooks` lists the harness hooks.

## 4. Self-checks

First the install itself:

```powershell
harness doctor
```

Expect `0 failures`, hooks registered for each of your agents, your marked
test server, and "integrity manifest matches". Warnings about scanners that
your repositories do not have (for example dependency-cruiser) are fine; the
line says what each would add.

Then a quick rail check in each agent: ask it, in its chat,

```
Run git push --force in this repository.
```

It must be refused with a message from the harness. Run `harness doctor`
again: it now shows that agent's heartbeat.

Then the step-by-step self-check pages. They confirm, on your machine, the
agent behaviours the harness relies on (each step says what to do, what to
expect, and the command that records your result):

- Devin desktop: `<harness>\selfcheck\devin-desktop.md` (16 steps, about 20 minutes)
- Codex: `<harness>\selfcheck\codex.md` (10 steps, about 15 minutes)

Record each step as you go, for example:

```powershell
harness selfcheck record --agent devin --step 4 --result "pass: saw both markers"
```

`harness selfcheck` shows what you have recorded so far. Claude Code needs no
self-check page.

## 5. Drive a ticket

In the agent's chat, in the repository the ticket is about, paste the ticket
with one line in front:

```
Here is a ticket. Work it through with the task skill. Do not push.

<the ticket: title, description, acceptance criteria>
```

What happens, phase by phase (the agent runs the commands; you watch and
answer):

1. **Intake.** The agent saves the ticket to a file in the harness inbox
   folder (`~/.harness-inbox/`, outside every repository; the install
   pre-approves its file tool there) and runs `harness intake --from <file>`. The brief splits the ticket into
   numbered criteria (AC1, AC2, ...), each with a planned check: a unit test,
   or an end-to-end call (`harness verify drive ... --criterion AC1`), or a
   database check. If something is unclear, the agent shows you the
   questions with options and a recommended answer; reply in one message
   ("Q1: B").
2. **Tests first.** It writes the failing checks and proves them red at the
   commit it started from (`harness gate prove-red`). Test files can only
   change in this phase.
3. **Implement.** It changes the product code. After each edit the hooks may
   point out a lint error or a broken team standard; it fixes it.
4. **Verify.** It starts the services with a throw-away test database and
   records one artefact per end-to-end check, then cleans up.
5. **Gate.** `harness gate` runs the checks cheapest first (tampering,
   secrets, build, typecheck, lint, your standards, the tests, the end-to-end
   artefacts). The agent can only finish on PASS, or with an honest
   BLOCKED and the reason (for example: a database it needs is not marked
   test). If it tries to stop without either, the harness sends it back.
6. **Write-up.** The gate writes the text for your pull request itself and
   prints its path on the last line (`Write-up: <path>`); the agent reads it
   back to you. `harness writeup` rebuilds it on request.

A task run with the harness costs about 2× the agent money of a plain run,
because of the extra turns for intake, the tests phase, the live check and the
gate.

The agent never pushes and never opens a pull request; both are blocked in
the team setting. You review, commit on a branch, push and open the pull
request yourself.

## 6. What the write-up looks like

```
# SHOP-102: Low-stock endpoint

## Why            the ticket's description
## What changed   one line per file (+added -removed)
## Scope          which criteria this change covers; anything waiting for an answer
## Tradeoffs      choices the agent made between options
## Blast radius   repositories, routes, tables touched
## Verification
Gate: PASS at tree 9817e0ace66e, attempt 2.
| Criterion | Check | Result | Artifact |
|---|---|---|---|
| AC1 Default call returns ... | e2e-http: GET /products/low-stock -> 200 | PASS | e2e/AC1-http.json |
| AC3 `threshold=0` ... answers 400 | e2e-http: GET /products/low-stock?threshold=0 -> 400 | PASS | e2e/AC3-http.json |
## Assumptions    what was taken without asking
## Feedback wanted what the reviewer should look at
## Branch and next steps
1. Move the change to its own branch and commit it there: `git switch -c shop-102-low-stock-endpoint` ...
2. Push that branch ...
3. Open a pull request with this text as the description, and request review.
```

Rows come from the gate's evidence, never from the agent's own words. A row
that says "gate not run" or "not linked" means the claim is not proven.

## 7. Undo

```powershell
harness undo             # restores every file the last install changed, from its backups
harness undo --plan <id> # a specific install (the id is printed at install time)
harness uninstall        # removes everything the harness added, for every install
```

Your own entries in agent settings files are never removed; backups stay
under `~/.harness\backups` until you delete them.

## 8. What to send back

After the self-checks and a few tickets:

```powershell
harness report --md --out "$HOME\harness-report.md"
harness report --check-scrub
harness doctor
```

Send:

1. **`harness-report.md`**. It holds counts only: standards per tier and
   family, checks generated, assessment findings, one row per ticket keyed by
   a hash (criteria, gate verdict and runs, checks run, checks that failed
   and were then fixed, end-to-end artefacts, standards flagged, questions
   asked, repeated corrections, steering messages, outcome, whether the
   attempt cap was reached), the learning loop, and which self-check steps
   matched or differed. No code, no file contents, no ticket text, no
   repository or file names.
2. **The line `harness report --check-scrub` prints**: it checks the report
   against the words of your workspace and starts with `scrub: ok.` when
   none of them appears in it.
3. **The summary line of `harness doctor`** (`N ok, N warnings, N failures`)
   and the names of any failing checks.
4. **The self-check results**: they are in the report (step ids, matched or
   differed). If a step differed, add one sentence in your own words about
   what you saw, without code or names.

Read the report before you send it; it is plain Markdown.
