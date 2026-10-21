# Writing to Jira (`src/jira/`, `harness jira`)

Reading a ticket is `harness intake --jira <KEY>` or `--jira-next` (see `src/intake/README.md`).
These two commands are the only places the harness writes to Jira, so only the user runs them:
the guard's admin rail denies `harness jira` to every agent (with or without `--dry-run` or `--yes`),
and the rendered rules of all three agents carry a deny prefix for it.

## Commands

```
harness jira comment [--task <id>] [--repo <path>] [--key <KEY>] [--pr <url>] [--dry-run] [--json]
harness jira create  [--task <id>] [--repo <path>] [--key <KEY>] [--from blocked|feedback|"<text>"] [--one]
                     [--project <KEY>] [--type <name>] [--pr <url>] [--yes] [--dry-run] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | done, or a draft/dry run that sent nothing |
| 1 | refused or failed: no write-up, no gate evidence, the gate is not BLOCKED (`--from blocked`), Jira answered an error, a redirect was refused |
| 2 | usage: no subcommand, no task, no ticket key (pass `--key`), no `--from`, no project, a bad key or `--pr`, Jira or its token not set up |

Task and repository are found as for `harness pr open` (`--task`, else `task/<id>` checked out, else the
current task). The run folder is `~/.harness/runs/<repo>/<task>/`.

### `comment`

Builds the comment from the task's `writeup.md`: a heading, the write-up's `Gate:` line (the verdict),
the Verification table as a Jira wiki table (`||Criterion||Check||Result||`; the Artifact column and
local paths are left out), `Pull request: <url>` when known (`--pr`, else `pr.json` from
`harness pr open`), and the last line "Posted by the harness from the write-up; details in the pull
request". Pipes become `/`, brackets and braces are escaped, secret-shaped text is redacted and hidden
characters removed. `POST /rest/api/2/issue/<KEY>/comment`.

The key is the one stored in the brief when the ticket was read with `--jira`/`--jira-next`
(`jiraKey`); otherwise `--key` is required (exit 2). No write-up: exit 1. `--dry-run` prints the
comment and sends nothing; it needs neither the token nor a reachable Jira.

### `create`

Drafts a follow-up ticket and prints it. It sends only with `--yes` (and never with `--dry-run`);
without `--yes` it says "Nothing was sent. Add --yes ..." and exits 0.

- `--from blocked`: the gate's BLOCKED reason from `evidence.json` (exit 1 when the verdict is not BLOCKED).
- `--from feedback`: the write-up's "Feedback wanted" items, one ticket per item (more than 10: use `--one`), or one ticket listing them with `--one`.
- `--from "<text>"`: your text.

Summary: `<KEY> follow-up: ` plus the first sentence cut at 120 characters (`Follow-up: ` when the source
key is unknown). Description: the full text plus "Opened from <KEY> by the harness; see <PR link when known>".
`POST /rest/api/2/issue` with `fields.project`, `summary`, `description`, `issuetype`; then, when the
source key is known, `POST /rest/api/2/issueLink` with type "Relates" (a failed link is reported, not fatal).

## Settings (machine config only, set by you in a terminal)

`jira.baseUrl`, `jira.emailEnv`, `jira.tokenEnv` as for reading, plus `jira.filter` (the queue, for
`--jira-next`), `jira.project` (default project key for `create`) and `jira.followupType` (default
issue type, "Task"). The token is read from the environment only; it is never stored, printed or logged.

## Safety

- Only the configured Jira host is called (https only; a request to any other host is refused in code,
  and a redirect is never followed). The same HTTP layer as the read path, with a POST beside the GET
  (`setHttpPost` in `src/commands/reviews.ts`), is what the tests replace.
- Every error message goes through `redactText`; a Jira error body is summarised (its error messages)
  and redacted, never echoed raw.
- No file the harness writes holds the token.
