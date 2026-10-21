# render: the harness each agent gets, and the plan that installs it

`renderHarness(ctx)` (`index.ts`) renders every file of the harness for one
setting and set of agents from one source: the standards ledger, the
discovery inventory, the machine config and the templates in
`templates/skills/`. `buildPlan()` (`propose.ts`) turns that, plus the
assessment of the user's own files, into a `Plan` for `harness apply`.
Nothing here writes agent files; only the lifecycle does.

## Files per agent

| | Devin Local | Claude Code | Codex |
|---|---|---|---|
| Always-on, team | `~/.config/devin/AGENTS.md` (`%APPDATA%\devin\` on Windows) | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` |
| Always-on, personal | `AGENTS.md` | `CLAUDE.md` = `@AGENTS.md` import block | `AGENTS.md` |
| Skills, team | `~/.agents/skills/<name>/SKILL.md` (Windows: `%APPDATA%\devin\skills\`) | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |
| Skills, personal | `.agents/skills/` | `.claude/skills/` (a copy) | `.agents/skills/` |
| Scoped rules (advisory) | `~/.devin/rules/<repo>.md`, `trigger: glob` | `~/.claude/rules/<repo>.md`, `paths:` | personal only: nested `AGENTS.md` |
| Hooks | `config.json` `hooks` (team) / `.devin/config.json` | `settings.json` `hooks` | `hooks.json` (never `config.toml [hooks]`) |
| Permissions | `permissions` deny/ask/allow | `permissions` deny/allow(/ask) | `rules/harness.rules` prefix rules |
| Settings edits | team: `attribution: false`; `read_config_from.claude: false` when Claude is also targeted | team: `attribution` commit/PR texts empty | `~/.codex/config.toml`: both settings, the harness folder in `[sandbox_workspace_write] writable_roots` (the gate writes its evidence there from inside the sandbox; merged into the user's own table when there is one); personal, `[projects."<repo>"] trust_level = "trusted"` |

Personal setting extras (`personal.ts`): `.harness/config.json` (setting and
agents, no machine paths), `tasks/README.md` (only when absent), git hooks
`pre-commit` and `pre-push` plus `.cmd` shims in the clone's hooks folder
(they run `node "<abs>/dist/src/cli.js" gate --hook ...` and fail closed; they
hold this machine's path, so they live in `.git/hooks` and are never
committed), `.github/workflows/harness-gate.yml` (the gate's verification
steps; the full gate when the repository variable `HARNESS_TOOL_REPO` names
the tool), a `.gitignore` block, and, when the repository uses Prettier, a
`.prettierignore` block naming every file the harness writes there (plus
`/.harness/` and `/tasks/`): Prettier would rewrite them by the repository's
own settings (front-matter quotes, table padding, short JSON arrays), so the
repository's own `prettier --check .` would fail right after the install and
on every landing. Never `.windsurfrules`, `.cursorrules` or other
tool-specific files.

## The always-on file (`alwayson.ts`)

The harness owns only the marker block (`<!-- harness:begin ... -->` to
`<!-- harness:end -->`); the user's text in the same file stays. Content, in
the order it is dropped when space runs out (last first): the repo index
(one line per repo; the SessionStart hook prints the full index anyway),
the standards rows of the rule table, extra command lines. What always
stays: the work rule ("use the `task` skill; done = `harness gate` PASS;
evidence from commands"), the CLI line, four negative constraints, one
command line, the test databases, the rails (as a table, or one compact line
when space is tight), and the pointers to the skills and scoped rules.

Limits, enforced in code: at most 60 harness-owned lines (markers included)
and 4096 bytes for the whole file. The budget is 4096 minus the user's own
text. When the user's text alone leaves too little room, the floors stay and
the plan says the file is over the limit because of the user's text (it is
never cut or rewritten).

## Hooks (`hooks.ts`)

`node "<packageRoot>/dist/src/hook.js" <Event> --agent <agent>`: absolute,
forward slashes, quoted, byte-stable for a given install path. Timeouts:
PreToolUse 20 s, PostToolUse 25 s, Stop/SubagentStop/TaskCompleted 5 s,
others 10 s (Codex SessionEnd 3 s, its maximum). Matchers: Claude
`Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch` plus `*` (every tool,
so MCP calls and reads reach the guard); Codex
`Bash|Edit|Write|MultiEdit|apply_patch` plus `.*` (Codex matchers are regular
expressions); Devin `^(exec|edit|write|read|mcp__.*)$` before and
`^(exec|edit|write)$` after a tool. Events: Claude PreToolUse, PostToolUse,
Stop, SubagentStop, TaskCompleted, SessionStart, UserPromptSubmit,
PreCompact, SessionEnd; Codex PreToolUse, PostToolUse, Stop, SessionStart,
UserPromptSubmit, SessionEnd; Devin PreToolUse, PostToolUse, Stop,
SessionStart, UserPromptSubmit, PostCompaction, SessionEnd. Two entries that
match the same call run once (the dispatcher dedupes).

## Permissions (`permissions.ts`)

Built from `src/guard/permissions.ts` (the guard's rail data), with the
protected roots (harness state, every agent config folder, `~/.devin`,
`~/.agents`, the harness package, `~/.claude.json`, and in the personal
setting the repo's `.claude`, `.codex`, `.devin`, `.agents`, `.harness`),
the exact verification commands from the inventory plus the task-time
`harness` commands as allow rules, and reads of `~/.harness/runs/**`. In the
personal setting Claude path rules are written without machine paths
(`~/...`, or repo-relative). The user's own deny/ask rules found by assess are
kept where they are and translated into every targeted agent's dialect.

## The plan (`propose.ts`, `userfiles.ts`)

Per classified line of the user's files (only files within reach: personal,
inside the repo; team, user-level files, the workspace folder and `--include`
folders; never an ancestor folder's file, never a tracked team file):

| Class | What the plan does |
|---|---|
| KEEP | nothing |
| CONVERT | matched to the ledger record that enforces it (by the statement and the record id); the line moves to `~/.harness/archive/` and the always-on file names the check. Without a match it stays (advisory hunk). |
| TRIM | moves to the archive |
| FIX | the corrected fact in place where one can be derived (a stale command becomes the commands every repo has; a stale path the only file of that name; a skill name in kebab-case; a missing or weak description from the skill's own first sentence); otherwise the line moves to the archive with the fact in the reason. Contradictions between files (R30) stay for the user to pick. Front matter is never archived. |
| SPLIT | moves to the task skill's `references/house-notes.md` |
| QUARANTINE | removed and written, escaped, to `~/.harness/quarantine/` with its finding; never rendered anywhere. In a file assess quarantined as a whole, only the lines with the hit (and their paragraph) are quarantined; the clean lines are handled by their own class, and nothing of the file is copied into a rendered file. |

Every target carries a unified diff (hidden code points shown as `<U+XXXX>`)
and hunks `{checkId, reason, provenance, contentHash}`. Owner: `generated`
when the harness creates the file or the manifest says it wrote it and the
file is untouched; otherwise `user` (a proposal on the user's file). Settings
files are `merge-json` unions. Before the union, an array element the
manifest records as harness-added that names a harness entry point
(`dist/src/hook.js`, `dist/src/cli.js`) and is not in the new fragment is
dropped: an install from another copy of the harness replaces the earlier
copy's hook entries and allow rules instead of adding a second set; the
user's own entries are never touched (`src/lifecycle/owned.ts`; apply and
the preview here do the same). The safety inventory is listed in the notes,
each rule with the rail that now enforces it (or "kept as written" when none
does), and attached to a settings target as `safety` hunks.

Rejections (`harness propose --approve <id> --reject <check>:<path>`) are
stored as `(checkId, path, contentHash)` in `~/.harness/plans/rejections.json`
and never proposed again while the content is the same.

The harness never learns from its own output: ledger records whose only file
evidence is a file the harness wrote, safety rules that are the harness's own
permission rules, and lines inside its marker blocks are left out. With
`archive/moved.json` remembering what earlier proposals moved, a second run
on an installed machine proposes nothing.

## Commands

`harness propose`, `harness install`, `harness self-update` and
`harness reviews` are in `src/commands/`. Install, apply, undo, uninstall,
self-update, `db mark` and anything with `--approve`/`--reject` are the
user's: the guard blocks them from agent tool calls; the `setup` skill
prepares them in the chat and hands the command over.
