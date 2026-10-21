# Codex self-check

This check confirms, on your own machine, the Codex behaviours the harness
relies on: which instruction files Codex loads and in what order, that it
lists the harness skills, that the harness hooks are trusted and can block,
how the Stop hook re-prompts, how hook trust reacts to a changed hook, what
the sandbox does to `git commit`, and which flags switch the rails off. It
takes about 15 minutes.

Run it once after `harness install --setting team --agents codex`, and again
after a Codex update.

## Before you start

- The Codex CLI is installed and signed in, and `harness doctor` runs in a
  terminal (if `harness` is not on your PATH, use
  `node "<harness folder>/dist/src/cli.js"` wherever this page says `harness`).
- Every step runs in a **scratch repository** outside your workspace, with no
  remote, so nothing can leave your machine and nothing touches your real
  repositories:

  ```sh
  mkdir ~/harness-scratch && cd ~/harness-scratch
  git init -q && echo scratch > README.md
  printf '# Scratch repository rules\n\nThis file exists for the harness self-check.\n' > AGENTS.md
  git add README.md AGENTS.md && git commit -qm scratch
  ```

  On Windows (PowerShell): `mkdir ~\harness-scratch; cd ~\harness-scratch; git init -q; "scratch" > README.md; "# Scratch repository rules" > AGENTS.md; git add README.md AGENTS.md; git commit -qm scratch`

- The install added the harness folder to `[sandbox_workspace_write]
  writable_roots` in `~/.codex/config.toml` (in the harness's marked block,
  or merged into your own `[sandbox_workspace_write]` table), because
  `harness gate`, which the agent runs inside Codex's workspace-write sandbox,
  writes its evidence there. Check the line is there before step 6.
- Step 7 adds two probe hooks to `~/.codex/hooks.json`; step 10 takes them
  out again. Nothing else is written outside `~/.harness`.
- Some commands below pass `-a never` (never ask for approval). If your Codex
  rejects that flag after `exec`, run the command without it.

**Recording results.** After each step, record what you saw. Start the text
with `pass` when it matches **Expect**, or `fail` when it does not:

```sh
harness selfcheck record --agent codex --step 2 --result "pass: harness file first, scratch file second"
```

Your words stay on this machine (`~/.harness/selfcheck/codex.json`). The
harness report only says which steps you confirmed and which differed.
`harness selfcheck --agent codex` shows the list and what you have recorded.

---

### Step 1 · Codex version and doctor (`version`)

**Do:** Run `codex --version`. If your Codex has a `codex doctor` command,
run it too. Then run `harness doctor`.

**Expect:** Codex 0.163.0 or later; `codex doctor` (when present) shows the
configuration and sign-in as fine; `harness doctor` has a `hooks:codex` line
marked `ok` listing PostToolUse, PreToolUse, SessionEnd, SessionStart, Stop
and UserPromptSubmit.

**If different:** An older Codex: update it first; hook and trust behaviour
changed across versions. `hooks:codex` warns or fails: run the install again
(`harness install --setting team --agents codex`).

**Record:** `harness selfcheck record --agent codex --step 1 --result "pass: codex <version>, hooks registered"`

### Step 2 · Instruction chain (`instruction-chain`)

**Do:** In `~/harness-scratch`, run:

```sh
codex exec --sandbox read-only -a never "List every instruction source you loaded, in order, quoting the first heading of each."
```

**Expect:** `~/.codex/AGENTS.md` first, quoting the harness heading "How work
is done here (harness)", then the scratch repository's `AGENTS.md` ("Scratch
repository rules").

**If different:** The harness file is missing: Codex is not reading
`~/.codex/AGENTS.md` (check whether `CODEX_HOME` points elsewhere). A
different order: record it; repository files that come later can override the
harness's rules in the model's eyes, while the hooks still enforce them.

**Record:** `harness selfcheck record --agent codex --step 2 --result "pass: harness file first, scratch second"`

### Step 3 · The harness skills are listed (`skills`)

**Do:** In `~/harness-scratch`, run:

```sh
codex exec --sandbox read-only -a never "Which skills are available? Give names and file paths."
```

Then start `codex` (the interactive screen), type `$task`, and check that it
offers the `task` skill. Quit with `/quit` or Ctrl+C.

**Expect:** `setup`, `task` and `learn`, each with a path under
`~/.agents/skills/`; `$task` offers the task skill.

**If different:** The skills are missing or listed from another folder:
record the paths Codex names. Without the `task` skill the agent does not get
the harness's step-by-step commands; the hooks and the gate still work.

**Record:** `harness selfcheck record --agent codex --step 3 --result "pass: setup, task, learn from ~/.agents/skills"`

### Step 4 · The harness hooks are trusted (`hooks-trusted`)

**Do:** In `~/harness-scratch`, start `codex`, type `/hooks`, and trust the
harness entries (their commands start with `node "` and end with
`--agent codex`). Quit, start `codex` again, say "hello", and quit. Then run
`harness doctor`.

**Expect:** A line `codex-hooks-trusted` marked `ok`: "Codex ran the harness
SessionStart hook at <time>, so its hooks are trusted".

**If different:** It still warns: Codex skips hooks it has not trusted, so
none of the rails or the done-gate run in Codex. Open `/hooks` again and check
that every harness entry is trusted.

**Record:** `harness selfcheck record --agent codex --step 4 --result "pass: heartbeat seen"`

### Step 5 · A PreToolUse block from the harness guard (`pretooluse-block`)

**Do:** In `~/harness-scratch`, start `codex` and send:

> Run exactly this command: git push --force

**Expect:** "Command blocked by PreToolUse hook: ..." with the harness's
reason ("In the team setting the agent never pushes; ..." or "Force-pushing
rewrites shared history; ..."). No push is attempted.

**If different:** The command ran (it fails harmlessly: no remote). The hooks
are not active; go back to step 4.

**Record:** `harness selfcheck record --agent codex --step 5 --result "pass: blocked with the harness reason"`

### Step 6 · The Stop hook re-prompts once for the done-gate (`stop-reprompt`)

**Do:** In the same `codex` session, send:

> Add the line "second line" to README.md, then finish.

**Expect:** When the agent finishes, Codex runs exactly one more pass with
the harness's reason ("harness: this work is not verified yet, so stopping is
blocked. Run `harness gate` ..."). The agent runs `harness gate`, which
passes in a scratch repository, and stops.

**If different:** No extra pass: the Stop hook is not active (step 4) or its
output was not accepted; record it. More than one extra pass in the same
turn: record the number. If `harness gate` fails with a permission error
writing under `~/.harness`, the workspace-write sandbox blocks the harness's
evidence folder: check that `~/.codex/config.toml` lists the harness folder
under `[sandbox_workspace_write] writable_roots` (the install adds it; run
`harness install` again if it is missing) and record what you saw, including
whether your Codex version reads `writable_roots`.

**Record:** `harness selfcheck record --agent codex --step 6 --result "pass: one extra pass, gate ran, stopped"`

### Step 7 · A changed hook is skipped until trusted again (`trust-gating`)

**Do:**

1. Run `harness selfcheck probe-files --agent codex`. It adds two probe hooks
   (SessionStart and PreToolUse) to `~/.codex/hooks.json`; they run the
   harness's own code and record only event, tool and field names.
2. In `~/harness-scratch`, start `codex`, type `/hooks`, trust the two new
   entries (their commands contain `selfcheck probe-hook`), say "hello", and
   quit. Run `harness selfcheck probe-log --agent codex`: it should say
   "SessionStart probe ran 1 time(s)".
3. Open `~/.codex/hooks.json` in an editor. In the SessionStart probe entry,
   add one space after `SessionStart` in the command (so it reads
   `SessionStart  --agent codex`). Save.
4. Start `codex` again, say "hello", quit, and run
   `harness selfcheck probe-log --agent codex`.
5. Run `codex exec --dangerously-bypass-hook-trust --sandbox read-only -a never "Say hello."`
   and then `harness selfcheck probe-log --agent codex` once more.

**Expect:** At step 4, Codex warns at start-up that hooks need review, and the
probe log still says 1 time. At step 5 the count goes up by one: the bypass
flag runs hooks that are not trusted.

**If different:** The changed hook ran without a review: Codex does not tie
trust to the exact hook text in your version; record it (the harness's hook
commands never change between updates, so this matters only for edits). The
bypass flag did not run it: record that too.

**Record:** `harness selfcheck record --agent codex --step 7 --result "pass: skipped until reviewed; bypass flag ran it"`

### Step 8 · git commit inside the workspace-write sandbox (`sandbox-commit`)

**Do:** In `~/harness-scratch`, run:

```sh
codex exec --sandbox workspace-write -a never "Run: git commit --allow-empty -m sandbox-test"
```

then `git log --oneline -1`.

**Expect:** The commit fails (the sandbox keeps `.git` read-only, and in
`exec` mode Codex cannot ask you to approve it); `git log` still shows the
"scratch" commit.

**If different:** The commit went through: `.git` is writable from the
sandbox in your setup. In the team setting the harness guard and your git
hooks still apply; record it. (To let Codex commit in its sandbox on purpose,
put `prefix_rule(pattern=["git","commit"], decision="allow")` in a rules file
of your own, for example `~/.codex/rules/user.rules`; `harness.rules` belongs
to the harness.)

**Record:** `harness selfcheck record --agent codex --step 8 --result "pass: commit refused in the sandbox"`

### Step 9 · Flags that switch the rails off (`disable-list`)

The harness cannot stop a person from starting Codex with flags that skip
user configuration. This step confirms which ones do, so you know what to
avoid.

**Do:** In `~/harness-scratch`, run:

```sh
codex exec --ignore-user-config --sandbox workspace-write -a never "Run exactly this command: git push --force"
```

**Expect:** The push is **not** blocked by a hook (it fails harmlessly: no
remote). This confirms that `--ignore-user-config` switches the harness off,
as do `--ignore-rules` (for the `.rules` prefixes) and
`--dangerously-bypass-hook-trust` (step 7). Never start Codex with them for
real work; the harness warns when a prompt mentions them.

**If different:** The push was blocked: in your version the flag does not
skip user hooks. Good news; record it.

**Record:** `harness selfcheck record --agent codex --step 9 --result "pass: not blocked with --ignore-user-config"`

### Step 10 · Remove the probes (`cleanup`)

**Do:** Run `harness selfcheck probe-files --agent codex --remove`, then
`harness doctor`. Start `codex`, open `/hooks`, and check that no
`selfcheck probe-hook` entry is left. Delete the scratch repository:
`rm -rf ~/harness-scratch` (PowerShell:
`Remove-Item -Recurse -Force ~\harness-scratch`).

**Expect:** "only the probe hook entries were taken out" (you edited the file
in step 7) or "restored byte for byte", no probe entry in `/hooks`, and
`harness doctor` ends with `0 failures`.

**If different:** Follow the printed instruction; the probe record is kept
until the removal succeeds, so you can run `--remove` again.

**Record:** `harness selfcheck record --agent codex --step 10 --result "pass: probes removed, doctor clean"`

---

When you are done, `harness selfcheck --agent codex` shows every step, and
`harness report` lists which behaviours you confirmed and which differed.
