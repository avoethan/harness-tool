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

Clone (or download the zip of `main` from the repository page and unpack it into your user profile) and build; no install scripts run, no admin rights needed:

(Windows "Extract All" can nest the files one folder deeper, `harness-tool-main\harness-tool-main\…`; `npm ci` then reports a missing `package-lock.json`. Move the inner folder up so `package.json` sits directly in the folder you build in.)

```powershell
cd $HOME
git clone <harness repository URL> harness-tool
cd harness-tool            # the folder with package.json (go one level deeper if the repository holds it in a subfolder)
npm.cmd ci --ignore-scripts
npm.cmd run build
```

Use `npm.cmd`, not `npm`: on machines where PowerShell scripts are disabled
("running scripts is disabled on this system"), the `npm` wrapper is a
PowerShell script and is refused, while `npm.cmd` is not. Nothing else in this
guide runs a PowerShell script: the harness launcher is `harness.cmd` and the
hooks call `node` directly. Later updates use `npm.cmd run build` too.

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

### Optional: read tickets straight from Jira

So that the agent can be given a ticket key instead of pasted text, tell the
harness where your Jira is and how to sign in (once, in a terminal):

```powershell
harness config set jira.baseUrl https://yourcompany.atlassian.net
harness config set jira.acceptanceField customfield_10042   # only if criteria live in their own field
```

Then give the harness your token, in your own terminal (agents cannot run it):

```powershell
harness jira token set --email you@yourcompany.com   # Jira Cloud: your Atlassian account email
harness jira token set                               # Jira Data Center: no email, a personal access token
harness jira token status
```

It asks for the token without showing it as you type or paste. Create it under
your Atlassian account's security settings (Cloud: "API tokens"), or under your
Jira profile on Data Center ("Personal Access Tokens"). The harness keeps it in
`~\.harness\secrets\jira.json`, which the guard treats as a secret: Devin,
Claude and Codex can neither read nor change it, and it is not in the
environment that every agent command inherits. The harness calls only the host
you set, never follows a redirect, and never prints or logs the token. Try it:
`harness intake --jira SHOP-102`.

If it answers `self-signed certificate in certificate chain` (or `unable to get
local issuer certificate`), your company network re-signs HTTPS with its own
root certificate. Windows trusts that certificate; Node trusts it only if it
can read the Windows store, which needs Node 22.15 or later (`node --version`).
The harness then trusts it on its own. On an older Node, export the company
root and point Node at it:

1. Run `certmgr.msc`. Under Trusted Root Certification Authorities > Certificates,
   find your company's root: the one that issued the certificate your browser
   shows for the Jira site (click the lock icon > certificate > Certification path,
   top entry).
2. Right-click it > All Tasks > Export, choose "Base-64 encoded X.509 (.CER)", and
   save it as `%USERPROFILE%\company-root.cer`.
3. `[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', "$HOME\company-root.cer", 'User')`,
   then open a new terminal.

Never turn certificate checks off (`NODE_TLS_REJECT_UNAUTHORIZED=0`): that would
also accept anyone pretending to be your Jira.

The token has the permissions of your Jira account. To read tickets and post the
write-up as a comment you need browse and comment permission in the project; to
create follow-up tickets, create permission.

(Older setups used the environment variables `HARNESS_JIRA_TOKEN` and
`HARNESS_JIRA_EMAIL`; they still work and take precedence. If you set them, move
the token with `harness jira token set --from-env` and then delete both
variables under "Edit environment variables for your account".)

The guard also blocks any agent command that names `HARNESS_JIRA_TOKEN`,
`SQLCMDPASSWORD`, a GitHub token or the Devin credentials. That covers
`echo $env:...`, `%...%`, `process.env.`, `os.environ` and
`[Environment]::GetEnvironmentVariable`. While one of those is set, it also
blocks commands that print the whole environment (`env`, `set`,
`Get-ChildItem env:`). Programs that read their own variable are not affected:
sqlcmd still reads `SQLCMDPASSWORD`.

Epics are Jira issues too: `harness intake --jira EPIC-1` reads the epic's own
summary and description, which is usually too broad for one ticket. To work
through an epic's stories one at a time, point the saved search at its children
and use `--jira-next`:

```powershell
harness config set jira.filter "parent = EPIC-1 AND status = 'Ready for dev' ORDER BY rank"         # Jira Cloud
harness config set jira.filter "'Epic Link' = EPIC-1 AND status = 'Ready for dev' ORDER BY rank"    # Jira Data Center
```

Optional, to take the next ticket from a saved search instead of naming it:

```powershell
harness config set jira.filter "project = SHOP AND status = 'Ready for dev' ORDER BY priority DESC"
harness intake --jira-next
```

Optional, to write back to Jira (you run these; the agent cannot): after the
pull request is open, `harness jira comment --dry-run` shows the comment (the
verification table, the gate verdict and the pull request link), and
`harness jira comment` posts it to the ticket. `harness jira create --from blocked`
(or `--from feedback`) prints a draft follow-up ticket and sends nothing until you add
`--yes`; set the defaults once with `harness config set jira.project SHOP` and
`harness config set jira.followupType Task`. The Jira account behind the token
needs permission to comment and to create issues in that project.

### Mark the test database (if you skipped it, or have another)

```powershell
harness db list
harness db mark --server <host[,port]> --test                            # every database on that server is test
harness db mark --server <host[,port]> --database <name> --test          # only that database
harness db mark --server <host[,port]> --database <name> --read-only     # the agent may read it, never change it
harness db mark --server <host[,port]> --database <name> --not-test      # the agent may not touch it at all
```

Three marks, one per entry:

- **test**: the agent may read and write (create tables, seed rows, run
  migrations). Use it for a throw-away or per-developer database.
- **read-only**: the agent may run inline `SELECT` statements only
  (`sqlcmd -S <server> -d <name> -Q "SELECT ..."`, `Invoke-Sqlcmd -Query`).
  Anything else against it (an `INSERT`, `UPDATE`, `EXEC`, `SET`,
  `DECLARE`, a script file, piped input, another database's three-part
  name) is refused, and the agent is told to stop and ask you. Use it for
  a shared database the team reads, such as a reporting or reference copy.
- **not-test**: every database command against it is refused, reads too.

The shared-server case: one SQL Server holds both a team database the agent
may only read and a test database it may change. Mark the server test and
the shared database read-only; the database entry wins over the server
entry:

```powershell
harness db mark --server sql-shared,1433 --test
harness db mark --server sql-shared,1433 --database reporting --read-only
```

On such a server the agent's commands against the test databases must
stay inside them: a three-part name of another database, `USE`, dynamic
SQL (`EXEC('...')`, `sp_executesql`), `sp_MSforeachdb` and similar
system procedures are refused, and so is a command that names no database
(`-d`), because the login's default database could be the read-only one.
Mark the server under one name only (not both its host name and its IP).

`harness verify` never creates, restores, copies from or seeds a read-only
database. With `verify.db.mode existing` (the services run against a
database as it is, instead of a per-run copy), that database must be marked
test; a read-only one is refused with exit 4. To read a read-only database
in an end-to-end check, use `harness verify db --query "SELECT ..."` against
a run on a test server.

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

It should be refused. The agent may refuse on its own (its instructions forbid
force-pushes), so run `harness doctor` again to see whether the hooks reach
the harness: a line `hooks-seen-<agent>` reports the last hook event from that
agent and when the guard last checked one of its tool calls. A warning there
after you used the agent means its hooks are not firing; for Devin, check
that the folder is trusted (hooks do not run in Restricted Mode).

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

### Your own local files in repositories

Keep your notes, investigations and drafts inside a repository if you like.
When the ticket starts (`harness intake`), the harness records which files
already had local changes, with a hash of each and no content, and the gate,
its secret scan and the write-up leave them out as long as they stay as they
were. `harness intake show` and the gate print only how many were left out;
`harness gate --json` lists them for you.

- A file you had changed before that changes again during the ticket is
  checked again, and the write-up marks it "changed during the ticket (you
  had local changes in it before)".
- If you edit your notes on purpose mid-ticket, record them again yourself,
  in a terminal in that repository: `harness task snapshot` (add
  `--task <id>` when the repository's current task is another one). The
  agent cannot run it: an agent re-recording after its own edits would hide
  them, so the harness blocks it for every agent.
- Files an agent edited in the last 12 hours, and files changed after the
  ticket started, are never recorded automatically; they stay part of the
  change until you run `harness task snapshot`.
- Commit nothing of yours on the task branch: a recorded file that is
  committed is part of the change again.

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

### See what changed in your agent files

```powershell
harness changes                     # both lists below
harness changes --diff              # with the lines added and removed
harness changes --path .devin       # only paths containing this text
harness changes record              # make now the starting point (you run it; agents cannot)
```

- **What the harness changed.** Every file an install or `self-update`
  added, changed or removed, from the records kept with the backups, and how
  each stands now: as the harness left it, edited since, deleted since, or back
  to your original. Under each file, **why**: every change the install made
  to it, with the line it came from, a **better because** line saying what
  that kind of change gains (a stale command corrected, a file map the agent
  can read itself trimmed, an autonomy grant set aside), and where text that
  was taken out is kept (`~\.harness\archive` or, for review,
  `~\.harness\quarantine`). `--diff` shows your original against the file
  now. The harness never deletes a file you wrote.
- **Your agent files since the record.** Every instruction, skill, rule,
  workflow and agent settings file (`AGENTS.md`, `.devin/...` and the rest,
  the same files `harness assess` reads) added, changed or removed since the
  record, whoever did it: you, an agent, or the harness. Each one says
  whether the harness made it; for a change it did not make there is no
  recorded reason, only the diff. Install takes the
  first record. On an install from before 0.7.0, run `harness changes record`
  once. Run it again when the changes are as you want them. It keeps a copy
  of each text file up to 1 MB under `~\.harness\agentfiles`, outside every
  repository.

Files inside a git repository also show in `git status` and `git diff`.
Your workspace `AGENTS.md` and `.devin` folder are not in git, so
`harness changes` is how you see those.

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
