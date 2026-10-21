# Hook runtime

One Node entry point (`dist/src/hook.js <Event>`) serves Devin Local, Claude
Code and Codex. `src/hook.ts` parses stdin, detects the agent, checks
integrity, dedupes double registrations, applies the timeout and renders the
`HookResult` in each agent's JSON. The modules here decide what to do. The
PreToolUse guard is documented in `../guard/README.md`.

Every handler is wrapped: an internal error in a non-blocking event becomes
exit 0 with a one-line stderr note and a `hook.error` event. The Stop-like
events fail closed, but count the failures against the attempt cap so a
persistent fault cannot loop an agent forever. Hooks never run repo or agent
code, apart from the repo's own linters on one edited file, and never write
prompt text, tool output or file content to any log.

## Events

| Event | Module | What it does | Blocks? |
|---|---|---|---|
| PostToolUse | `PostToolUse.ts` | edit log; file-scoped Prettier/ESLint/SQL lint on the edited file; ledger file checks; one note per (session, repo, rule) with the standard's statement and fix; staging warning after `git add` / `commit -a` | never |
| Stop, SubagentStop, TaskCompleted | `evidence.ts` | evidence check (below) | yes, exit 2 |
| SessionStart | `SessionStart.ts` | open trail for the workspace (<= 40 lines), repo index, DB allowlist summary, integrity status; records the session; writes `state/heartbeat-<agent>.json` | never |
| UserPromptSubmit | `UserPromptSubmit.ts` | standards for repos named in the prompt (once per session and repo); correction capture (class + ticket hash, never text); pasted-ticket reminder for `harness intake --from <file>` (the ticket saved to a file, never piped through the shell); warnings for `/mode bypass`, `/handoff`, disabling hooks | never |
| PreCompact, PostCompaction, SessionEnd | `pause.ts` | trail `trail/<taskId>.md`; personal setting: `wip: pause` commit off main; SessionEnd closes the session | never |
| ConfigChange (Claude) | `ConfigChange.ts` | instruments the change; warns when a harness-owned file changed (integrity is re-signed only through `harness config`) | never |

## Stop: the evidence check (`evidence.ts`)

Never runs tests. Budget 1.5 s (the dispatcher kills it at 1.8 s).

1. Edit log empty (no edits inside a git repo this session): exit 0.
2. For every repo in the edit log, the task is `runs/<repoId>/current-task`,
   else the task with the newest `evidence.json` under `runs/<repoId>/`.
3. Verdict PASS or BLOCKED and `treeHash` equal to `git write-tree` of the
   working tree now: that repo passes. All repos pass: exit 0.
4. The per-session attempt counter for (session, repo, task) has reached
   `caps.gateAttempts` (default 8): `cap_reached: true` is written into the
   evidence file (or `cap.json` beside it when the gate never ran), so the
   write-up cannot cite PASS, and the agent may stop.
5. The tree hash and the evidence are the same as at this repo's last block:
   exit 0. A state is never blocked twice; blocking again would give the
   agent no new information and only loop (Devin documents no cap).
6. Otherwise: bump the counter and block with "Run `harness gate`", the
   exact command per repo (`harness gate --repo "<root>"`, since Codex only
   re-prompts with the reason) and the evidence's failure list.

The tree hash is cached in `cache/<repoId>/stop-tree.json`, keyed by the
edited files' mtimes and sizes, the git index and HEAD, the evidence file,
and the session's shell-call count, with a 2-minute TTL.

Agent semantics: Claude Code holds the turn on a block (its own cap: 8
consecutive continuations); Devin Local holds it with no documented cap;
Codex feeds the reason back as a new prompt.

## The edit log (`editlog.ts`)

Session state `state/<sessionId>.json`, `edits[]` of `{path, repo, ts}`:

- file tools: `Edit`, `Write`, `MultiEdit`, `NotebookEdit` (Claude, Codex),
  `edit`, `write` (Devin), and any tool the guard classes as a write tool.
  Path fields: `file_path`, `path`, `filePath`, `notebook_path` and similar,
  plus `tool_response.filePath`;
- `apply_patch` bodies wherever they appear (tool input or a shell heredoc);
- shell commands that visibly write: redirects, `tee`, `sed -i`, `perl -i`,
  `cp`/`mv`/`rm`/`touch`/`truncate`, git sub-commands that rewrite the work
  tree, formatter `--write`/`--fix` runs, package installs.

Not logged: paths outside any git repo, under `.git/`, or in the harness
state. Writes the parser cannot see (a script run from the shell that writes
files) are not logged.

## File-scoped lint (`lint.ts`)

The repo's own binaries only (`node_modules/<pkg>` `bin`, else
`node_modules/.bin/<name>`, from the file's folder up to the repo root;
`sqlfluff` from PATH), argv arrays, 18 s in total, nothing installed.
Prettier runs only when the repo has a Prettier config; ESLint only with an
ESLint config; `.sql` goes to tsqllint, else sqlfluff with a `.sqlfluff`
config. A lint config that is untracked or has uncommitted changes is never
run (it could be agent-authored JavaScript executed outside the agent's
sandbox), and neither is an edited lint config; the note says so. A missing
tool is reported once per session as absent.

## Ledger checks (`standards.ts`)

The hook calls `runLedgerChecks` from `src/discover/checks.ts` when that
module exports it:

```ts
type RunLedgerChecks = (opts: {
  repoRoot: string; repoId: string;
  files: string[];            // absolute; exactly one from this hook
  records: LedgerRecord[];    // already filtered to the repo and path
  timeoutMs: number; scope: 'file';
}) => Promise<LedgerCheckFinding[]> | LedgerCheckFinding[];
interface LedgerCheckFinding { ruleId: string; file: string; line?: number; message?: string }
```

Without it, lint findings are still mapped to ledger records: ESLint rule
ids to `check.type: 'eslint'` records whose `check.ref` names the rule, SQL
linter codes to `sql-lint` records, Prettier to `format` records.

## Registration notes for the renderer

- PostToolUse needs the edit tools and the shell tool (the staging check and
  shell-write detection read Bash/exec calls). Claude matcher:
  `Edit|Write|MultiEdit|NotebookEdit|Bash`; Codex: its shell and
  `apply_patch` tools; Devin: `edit|write|exec`.
- Stop: timeout of at least 2 s. SessionStart, UserPromptSubmit,
  PreCompact/PostCompaction/SessionEnd: 20 s. PostToolUse: 25 s (lint).

## State written

`state/<sessionId>.json` (edits, injected rule ids, attempts, stop marks,
recent lint-note rule ids and paths, prompt sha256, status),
`state/heartbeat-<agent>.json`, `cache/<repoId>/stop-tree.json`,
`trail/<taskId>.md`, `runs/<repoId>/<taskId>/evidence.json` (`cap_reached`
only) or `cap.json`, and `logs/events.jsonl` (names, ids, counts).

## Instrumentation events

`post.tool`, `stop.{no-edits,pass,cap,unchanged,block,error}`,
`session.start`, `prompt.submit`, `correction` (`class`, `ids.ticket`),
`pause.trail`, `session.end`, `config.change`, `hook.error`.
