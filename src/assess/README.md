# assess

`harness assess` reads the existing agent setup of a workspace, deterministic
and offline. Pipeline (see `index.ts`): repos and sessions, inventory and load
timing, raw scans (before any parsing), checks, safety inventory, bytes loaded
per agent, line classification, report.

## Load paths (agent documentation as of 2026-10-18)

| | Devin Local | Claude Code | Codex |
|---|---|---|---|
| Always on | `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`, `CLAUDE.md` (workspace root at launch, sub-folders lazily); `.devin/global_rules.md`; `.devin/rules/*.md` with `trigger: always_on`; `~/.config/devin/AGENTS.md`, `~/.devin/global_rules.md`, `~/.devin/rules`, `~/.claude/CLAUDE.md` | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` in the working folder and every ancestor, plus `@` imports; `AGENTS.md` only without a CLAUDE.md in the folder or above; `.claude/rules` without `paths:`; `~/.claude/CLAUDE.md` | `~/.codex/AGENTS(.override).md` (outside the budget); one `AGENTS.override.md` or `AGENTS.md` per folder from the git root down to the working folder, 32 KiB together |
| Lazy | sub-folder rule files, other triggers, skills; imports `.claude/` material and `.cursor/rules` unless `read_config_from` turns it off | sub-folder CLAUDE.md, rules with `paths:`, skills up to the git root, commands, subagents | skills in `.agents/skills` and `~/.agents/skills` |
| Config | `.devin/config(.local).json`, `.devin/hooks.v1.json`, `~/.config/devin/config.json`, MCP files | `.claude/settings(.local).json` at the project root only, `~/.claude/settings*.json`, `.mcp.json`, `~/.claude.json` | `~/.codex/config.toml`, `hooks.json`, `rules/*.rules`; project `.codex/*` only when trusted |
| Limit | none documented; 16 KiB (the cloud figure) used as a yardstick | about 200 lines per file (guidance), 4 MiB cap | 32 KiB over the chain; the crossing file is cut, later files dropped |

Legacy names (`.cursorrules`, `GEMINI.md`, `.github/copilot-instructions.md`,
Cascade rules, workflows and memories) are inventoried and labelled; files no
agent loads are listed under `neverLoaded`.

## Checks

| Id | What | Severity |
|---|---|---|
| R01 | no instruction file at a repo root | info |
| R02 | a test command exists but no instruction file says how to run tests | warn |
| R03 | verification scripts no agent file names, and no documented aggregator | warn |
| R04 | stale command (`npm run X`, `make X` ... not defined) | warn |
| R05 | stale path in a code span | warn |
| R06 | duplicate file or duplicated paragraph across files | warn |
| R07 | AGENTS.md Claude Code will not read, or Codex skips for AGENTS.override.md | warn |
| R08 | AGENTS.md without a CLAUDE.md pointer | info |
| R09 | over a load limit (per agent, see above) | warn |
| R10 | hidden Unicode (any inventoried file; also README/CONTRIBUTING) | high |
| R11 | HTML comment that reads like an instruction | high |
| R12 | injection phrasing (agent files; AI-addressed text in docs) | high |
| R13 | autonomy escalation ("without asking", "merge it yourself" ...) | high |
| R14 | broad permission (`Bash(*)`, bypassPermissions, `approval_policy = "never"` ...) | high |
| R15 | hook command; high when it reaches the network, pipes to a shell or runs package code (scripts it names are read, never run) | info / high |
| R16 | MCP server declared | info |
| R17 | local settings committed to git | warn |
| R18 | skill spec (name, description, folder name, unknown keys) | warn / info |
| R19 | AI contribution policy | info |
| R20 | CI runs an agent on untrusted events | high / info |
| R21 | routine snapshot / expectation rewrite | warn |
| R22 | broken `@` import or link | warn |
| R23 | instruction file that is a symlink | info |
| R24 | agent config that cannot be parsed | warn |
| R25 | instruction a lint rule, test, hook or gate step could enforce | info (drives CONVERT) |
| R26 | derivable content: file maps, structure sections, script lists | warn when 8+ lines, else info (drives TRIM) |
| R27 | polarity ratio (positive directives vs negative constraints) | info |
| R28 | skill shape: weak description, body over 500 lines, model-invocable with side effects | warn |
| R29 | rule that contradicts the resolved Prettier / EditorConfig / ESLint config | warn |
| R30 | two agent files contradict each other | warn |
| R31 | stale fact about an agent feature (small dated table in `checks.ts`) | warn / info |

## Classes

The unit is a paragraph, list item, code fence, table row or front-matter key
(a paragraph written one statement per line is split into lines). Precedence:
QUARANTINE > FIX > safety sentence (KEEP) > SPLIT > CONVERT > TRIM > KEEP.
Lines with R10-R12 hits are QUARANTINE (the file keeps a high finding and its `quarantine` marker; its other lines are classified normally); `underlying` keeps the
class each line would otherwise have. The user's wording is never rewritten;
`text` in the report shows hidden code points as `<U+XXXX>` and redacts
secrets.

## Judgment pass

`--judgment` writes `judgment/<id>/bundle.json` (file paths, line numbers,
escaped one-line quotes, counts; nothing from quarantined files) and
`prompt.md`. The agent may not write in `~/.harness` (the self-protection rail denies its file tools there), so it writes its answer outside every repository and hands it over with `harness judgment submit <id> --from <file>` (or `--from -` on standard input; `src/commands/judgment.ts`), which checks the id names an existing bundle, the size (1 MiB), JSON with `version: 1` and no hidden Unicode, and saves it as `result.json`; the full validation stays with the import. `--import-judgment <id>` accepts only a `result.json` that
matches the schema, carries no hidden Unicode, injection or autonomy phrasing,
and refers to the same `assess.json`; items become findings with provenance
`judgment` (J1 contradiction, J2 unjustified size, J3 verification gap) or
reclassifications. Judgment never sets KEEP and never touches a quarantined
line.
