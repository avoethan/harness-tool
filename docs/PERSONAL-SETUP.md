# Personal setup (your own repository, free mode)

In the personal setting the harness lives in your repository. It writes its
agent instructions, skills, settings and a small task ledger into the
repository, adds git hooks and a CI workflow, and lands finished work on
`main` itself. Every step that touches `main` is undoable, and nothing ever
rewrites history.

This page covers installing it, adding tasks, running the queue, what lands
and when it is reverted, pausing, and undoing it all. It assumes one git
repository with a `main` (or `master`) branch, Node 20 or newer, and Claude
Code or Codex on your PATH.

## 1. Get the harness

```sh
git clone <the harness repository> ~/tools/agent-harness
cd ~/tools/agent-harness/harness
npm ci --ignore-scripts
npm run build
```

Put `~/tools/agent-harness/harness/bin` on your PATH so that `harness` works in
any folder (agents run `harness gate` and similar commands by that name).
`harness doctor` checks the setup.

## 2. Install it into your repository

From your repository's folder, in a terminal (not from an agent: the guard
refuses `install`, `undo` and `uninstall` from an agent's tool call):

```sh
harness install --setting personal --workspace .
```

The command reads your code and history to find the standards you actually
follow (with evidence), reads your existing agent files (`AGENTS.md`,
`CLAUDE.md`, ...), asks which database servers are test servers, and shows
a plan: every file it will create or change, with a reason per change.
Nothing is written until you approve. In a script, or once you trust the
plan:

```sh
harness install --setting personal --workspace . --yes --db-test localhost,1433 --commit
```

- `--db-test host[,port][/db]` marks a database server (or one database) as
  a test target. Agents may run database commands only against marked
  targets; `--db-none` denies every database command.
- `--agents claude,codex` (the default for this setting) picks the agents.
- `--commit` puts everything the install wrote inside the repository into
  one commit, `chore(harness): apply <plan>` (the subject follows your
  repository's commit style when the harness found one).

What you get in the repository (all committed):

| Path | What it is |
|---|---|
| `AGENTS.md` | the always-on instructions: a block the harness owns, your own text kept. Stale commands and paths in your text are corrected; rules now enforced by a check move to an archive under `~/.harness/archive/`; anything that grants an agent more autonomy than the rails allow is removed to `~/.harness/quarantine/`. |
| `CLAUDE.md` | an `@AGENTS.md` import at the top (Claude Code reads `AGENTS.md` only through it), with the same corrections to your text |
| `.claude/`, `.codex/`, `.agents/skills/` | settings, hooks, permission rules, the `task`, `learn` and `setup` skills, advisory rules per folder |
| `.harness/config.json`, `.harness/manifest.json` | the repository's setting and what the harness owns (used by undo) |
| `tasks/README.md` | how the task ledger works |
| `.github/workflows/harness-gate.yml` | CI running the gate's verification steps |
| `.gitignore`, `.prettierignore` | a marked block each (the second only when the repository uses Prettier, so its format check leaves the harness's files alone) |

Outside the repository: git hooks `pre-commit` and `pre-push` in your
clone's `.git/hooks` (they hold this machine's path to the harness, so they
are not committed), the harness state in `~/.harness` (a private git
repository with no remote), and for Codex an entry in `~/.codex/config.toml`
(the project trusted, and `~/.harness` in `[sandbox_workspace_write]
writable_roots` so the gate can write its evidence from inside Codex's
sandbox).

The git hooks run `harness gate` and **fail closed**: a commit whose staged
change breaks one of your standards is refused with the rule named and how
to fix it; if the harness is missing or Node cannot start, the commit or
push is refused too. Your first `git push` after the install goes through
the pre-push gate like any other (the install commit is recognised as the
harness's own).

Start a new Claude Code session in the repository so the settings load
(`/hooks` lists the harness hooks). Codex: run `/hooks` once and trust the
harness hooks.

## 3. Add tasks

The queue is `tasks/`, one Markdown file per task:

```sh
harness task add --title "Say how long ago something expired" --priority 1 \
  --acceptance "pantry list shows (expired 3d ago) for items past their date" \
  --paths src,test/unit
```

Then open the file it created (`tasks/T-001-....md`) and describe the task
below the front matter, as you would in a ticket: examples, the cases that
must pass, what must not change. Lower priority numbers run first;
`--depends-on T-001` orders tasks; `paths` keeps two tasks that run at the
same time from touching the same files. `harness task list` and
`harness task validate` show and check the ledger. You do not need to
commit task files: claims, failures and re-queues are local state, and the
landing commit adds the task file as `done` when its work lands.

## 4. Run the queue

```sh
harness run --once --agent claude                  # one task
harness run --agent claude --max-tasks 3           # up to three, one after the other
harness run --agent codex --ci local --budget-usd 2
```

For each task the runner:

1. claims the most urgent ready task;
2. creates a worktree on branch `task/<id>` from `main` under
   `~/.harness-worktrees/<repo>/<id>` (your own checkout is not touched;
   dependencies are linked, not installed);
3. starts a fresh headless session (`claude -p` or `codex exec`) with the
   `task` skill and the task's text, and with caps: turns (default 80),
   wall time (25 minutes a session, 60 a task), and a cost cap when you give
   `--budget-usd` (flags only lower the configured caps). A cap ends the
   task as failed with the cap named; it is never retried;
4. runs `harness gate` on the result: tamper check, secrets, your standards,
   lint, typecheck, build, your tests, the task's own acceptance tests
   (written first and proven to fail before the change), and an end-to-end
   check where the task needs one;
5. on PASS, lands it (below); otherwise marks the task `failed` or `blocked`
   with the reason.

The agent never asks you a question during a run. When something needs a
person (a rail, an irreversible step, the same failure three times, work
outside the task's paths) it records BLOCKED with one sentence, and the task
waits for you.

## 5. What lands, and when it is reverted

`harness land` (the runner calls it; you can run it on a task branch too) is
the only way onto `main`:

1. It takes a lock (one landing at a time), checks that the gate's PASS is
   for exactly the branch's last commit, and merges `main` into the branch
   if `main` moved (a new merge commit, never a rebase), re-running the gate
   steps the merge could have changed.
2. It adds one landing commit with the write-up as its message and the task
   file marked `done` (status, the commit that landed, the evidence path),
   fast-forwards `main`, and pushes with a plain `git push` (never forced)
   from a separate checkout, so your pre-push hook checks exactly what is
   pushed.
3. It waits for CI: `--ci local` (the default) runs the gate in CI mode on
   the landed commit; `--ci github` reads the commit's check runs (read-only,
   needs `GITHUB_TOKEN`); `--ci none` skips it. To run your own CI steps
   locally instead, name a command: `--ci-command "npm run ci"`, or put
   `"land": {"ciCommand": ["npm", "run", "ci"]}` in `.harness/config.json`.
   It runs in the landed checkout with `CI=true`; exit 0 is green.
   `{checkout}`, `{sha}` and `{base}` in it are filled in. No shell features
   (pipes, `&&`): put several steps in a script.
4. If CI is red: one rerun (a flake is recorded and the work stays). Still
   red: one fix attempt by a fresh headless session with the CI failure as
   its brief, landed only through the same gate and CI. Still red, or no
   fix: **one revert commit** of the task's commits and the fix together,
   pushed normally, and the task goes back to `todo` with a note and the
   failure evidence. History is never rewritten; the reverted commits stay
   in the log.

Every landing writes `~/.harness/runs/<repo>/<task>/landing.json` with
`landed`, `post_landing_red`, `auto_fixed`, `reverted` and `revert_correct`
(the tree after the revert equals `main` before the landing), plus each
step it went through.

## 5a. Open the pull request

`harness land` merges into your `main`. When you would rather review a
pull request first (or `main` is protected), push the task branch yourself,
then open the pull request:

```sh
git push -u origin task/T-002
harness pr open --task T-002 --dry-run     # show the request, send nothing
harness pr open --task T-002               # add --draft or --base <branch> if needed
```

It uses the write-up `harness gate` produced as the description and the
task's title as the title, prints the pull request address and saves it in
`~/.harness/runs/<repo>/<task>/pr.json`. It needs `GITHUB_TOKEN` or
`GH_TOKEN` (or a signed-in `gh`) with permission to write pull requests. It
refuses when the branch is not on `origin` at the same commit (it tells you
the `git push` to run), when there is no write-up, and in the team setting
(exit 4). If a pull request for the branch is already open it prints that
one and creates nothing. Only you can run it: the guard denies
`harness pr` to every agent, and the command is the only place the harness
posts to GitHub. See `src/pr/README.md`.

## 6. Pause and resume

```sh
harness run pause --task T-002 --note "stopping for today"
harness run resume --task T-002 --agent claude
```

`pause` writes a trail (`~/.harness/trail/<id>.md`: what was done, the last
gate result, the next command) and a pause commit on the task branch, never
on `main` and never pushed. `resume` reads the trail, re-runs the gate first
(nothing earlier is trusted), and either lands right away or starts a fresh
session with the trail and the gate's report. A session cut off by a usage
limit is paused the same way.

## 7. Undo, uninstall

```sh
harness undo --plan <plan id>      # the id the install printed; --yes outside a terminal
harness uninstall --setting personal --repo .
```

`undo` reverts the install commit with `git revert` (a new commit; nothing
is rewritten), restores every file from its backup, and removes the settings
entries and git hooks the harness added. A file you edited after the
install is kept, and the command says where its backup is. Running
`harness install` again proposes the same plan. `uninstall` removes
everything the harness owns. Task worktrees left by failed tasks are in
`~/.harness-worktrees/`; their branches stay in your repository until you
delete them.

## Good to know

- Claude Code applies a project's permission rules only in folders you
  trusted. The runner passes your repository's committed allow rules to each
  headless session itself, so new worktrees need no trust prompt.
- The gate reads its own configuration from the base commit, never from the
  working tree, so a change cannot loosen the check that judges it.
- `harness status` shows where the install and the tasks stand and the next
  thing to do; `harness report` writes a summary with counts only, no code.
