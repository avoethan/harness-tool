# Self-checks for the work machine

Some agent behaviours the harness depends on can only be confirmed on the
machine where the agent runs: whether a hook can block, what a hook receives,
how a slow or repeated Stop hook is treated, whether the rails hold in a
permissive mode. These pages walk you through confirming them, step by step,
against the harness you installed.

| Agent | Page | Time | Steps |
|---|---|---|---|
| Devin desktop (Devin Local) | [devin-desktop.md](devin-desktop.md) | about 20 minutes | 16 |
| Codex CLI | [codex.md](codex.md) | about 15 minutes | 10 |

Claude Code needs no self-check: its hook behaviour was tested where the
harness was built.

## When to run them

After `harness install --setting team` (or `--setting personal`) for that
agent, and again after the agent updates.

## How each step reads

- **Do:** the exact command to run in a terminal, or the exact message to
  send in the agent's chat.
- **Expect:** what you should see.
- **If different:** what a different result means, and what to do about it.
- **Record:** the command that stores your result.

## Recording results

```sh
harness selfcheck record --agent devin --step 4 --result "pass: saw both markers"
harness selfcheck record --agent codex --step 7 --result "fail: the changed hook ran without a review"
```

Start the result with `pass` (it matched **Expect**) or `fail` (it did not);
anything else is kept as a note. You can also say it outright with
`--outcome expected|different|noted`. Results are stored in
`~/.harness/selfcheck/<agent>.json` and stay on your machine. The harness
report (`harness report`) carries only the step names and whether each one
matched; never your words.

`harness selfcheck` lists every step with what you recorded so far, and
`harness status` reminds you of a self-check you have not finished.

## Probe files

A few steps need temporary probe files. `harness selfcheck probe-files
--agent devin` (or `--agent codex`) writes them, and `--remove` takes them out
again:

- They go only to your user-level agent folder, never inside a repository.
  When that folder sits inside a git repository (a dotfiles repository, for
  example) the command refuses and writes nothing.
- Every write is recorded in `~/.harness/selfcheck/probe-<agent>.json` with a
  copy of the file as it was. `--remove` puts the original back byte for byte;
  if you edited the file in the meantime it takes out only the probe part.
- The probe hooks run the harness's own code
  (`harness selfcheck probe-hook`). They record event, tool and field names,
  yes/no facts and counts in `~/.harness/selfcheck/probe/<agent>-log.jsonl`,
  never values, paths or what you type. `harness selfcheck probe-log --agent
  <agent>` summarises the log; `--clear` deletes it.
- The Devin Stop probe has three modes, set with
  `harness selfcheck probe-mode --agent devin --stop off|block|slow`: `off`
  lets every stop through, `block` blocks three stops in a row, `slow` sleeps
  10 seconds against its 3-second timeout.

The agent itself is not allowed to run `harness selfcheck probe-files`; it is
yours to run in a terminal.
