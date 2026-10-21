# The learning loop (`src/learn/`, `harness learn`)

A lesson is done when something fails without it. The loop turns mistakes
that come back into enforcers, proves each enforcer on the original mistake,
and asks the user only for what changes the agents' context. The loop itself
is a bet (DESIGN 2.9); the instrumentation measures it with
`repeat_corrections`.

## Commands

```
harness learn --scan [--since <date>] [--token-cap <n>] [--json]
harness learn --import-judgment <id> [--json]
harness learn prove <lesson> [--fixture <file>] [--repo <path>] [--json]
harness learn review [--approve <id>]... [--reject <id>]... [--expire <id>]... [--renew <id>]... [--json]
harness learn gc [--json]
harness learn stats [--json]
harness learn list [--json]
harness learn show <lesson>
```

`scan` and `import-judgment` are also accepted as the first word
(`harness learn scan`). `review` is the user's: the guard blocks
`harness learn review` (and any `--approve`/`--reject`) from agent tool calls,
and the `learn` skill hands the command over.

| Exit | Meaning |
|---|---|
| 0 | ok (prove: proven) |
| 1 | prove: not proven; review: a decision was refused (budget, not proven, not pending); import: every item rejected or the file is unusable |
| 2 | usage |
| 4 | review: refused by a rail (a change in a team repository) |

## Capture (free, hook-only)

`harness learn` reads `~/.harness/logs/events.jsonl` and nothing else: no
prompt text, no transcripts (there are none in the log). Only whitelisted
fields of each line are copied (`ts`, `event`, `sessionId`, `repo`, `task`,
`agent`, `class`, `ids.{step,kind,rules,rail,mode,ci,outcome,ticket,verdict}`),
so even a hand-edited line cannot bring text into a lesson.

| Event | Written by | Class key |
|---|---|---|
| `gate.fail` with `ids.rules` | `harness gate` (standards step) | `rule:<record id>`, one per rule |
| `gate.fail` without rules | `harness gate` (other steps) | `step:<kind>` (`acceptance:AC1` is `step:acceptance`) |
| `correction` | the UserPromptSubmit hook (`class`: style, test, scope, verify, safety, other) | the classes of a `gate.fail` in the same session within the previous 4 hours (the user is steering about what the gate said), else `correction:<class>` |
| `land.post_landing_red` | `harness land` | `land:post-landing-red` |
| `land.reverted` | `harness land` | a follow-up of an earlier red landing of the same task, else `land:reverted` |
| `guard.deny` | the PreToolUse guard | not a class; marks its session, so a class with an occurrence in it touched a rail |

Counting rules (chosen; the signal that would move them is the repeat rate
per class):

- One occurrence per class per task for gate failures: later failing attempts
  in the same task are follow-ups (the gate doing its job), not repeats.
- Every correction counts (each is a steering message).
- A class becomes a lesson at 2 occurrences, or at 1 when it touched a safety
  rail (a `safety` correction, the `tamper` or `secrets` step, a `safety.*`
  rule, or a session where the guard denied a command).
- A learned rule firing at the gate counts for the lesson that wrote it
  (`aliases` on the record).

## Lesson records

`~/.harness/lessons/<id>.json`, one per class; the id is derived from the
class key, so re-scans update the same record. A superset of `Lesson`
(src/types.ts): `key`, `kind`, `description` (built from the key only),
`occurrences`, `sources` (event ids `e-<12 hex>`, never text), `counts` by
event, `followUps`, `repos`, `touchedRail`, `proposal` (the enforcer plan),
`enforcer` (`rung`, `ref`, `provenOn`, `fires`), `proof`, `tier` and
`tierReason`, `needsJudgment`, `reason` (why it stays where it is),
`landedAt`, `reviewBy` (prose), `decided`, `plan`, `promote`, `aliases`, and
`history` (every status change, appended). Records are never summarised,
merged or deleted (R-32); gc only lists.

Status: `captured` -> `proposed` -> `proven` -> `approved`, or `rejected`,
`expired`.

## The enforcer ladder (`ladder.ts`)

Highest rung that can express the mistake, from what the harness knows:

| Class | Proposal | Tier |
|---|---|---|
| touched a rail | `hook` (`rail`): rails are the guard and the permission rules | 2, never automatic |
| `rule:<id>`, the ledger check blocks already | `lint`, `ledger:<id>`, existing: recorded and proven, nothing written | 0 |
| `rule:<id>`, the ledger check only warns (ast-grep, regex, built-in, commit subjects) | `lint`, `learned/<id>.json`: the same check promoted to block mode | 0 |
| `rule:<id>`, the repository's ESLint rule blocks already | `lint`, `eslint:<rule>`, existing | 0 |
| `rule:<id>`, an ESLint warning, a config or judgment record, or a rule gone from the ledger | judgment: write an ast-grep or regex rule whose message names the fix | 0 once written and proven |
| `step:typecheck` / `step:lint` / other steps | `types` / `lint` / `ci` (`gate:<step>`), existing: the gate step is the enforcer | 0 |
| `correction:<class>` | judgment: name the convention and the rung (suggested: style lint, test and verify test, scope skill, other instruction) | by the rung |
| `land:*` | judgment: name the regression test committed with the fix, and the two commits | 0 (it is in the repository already) |
| a prose lesson gc marked for promotion | judgment with code rungs only (lint, test) | 0 |

Judgment results may propose `lint` (an ast-grep or regex rule with `valid`
and `invalid` samples; id `<family>.learned-<slug>`; never `safety`),
`test`, `skill` (<= 600 characters) or `instruction` (one line of 10-200
characters that starts with Never / Do not / Don't / Avoid / No). Rails,
hooks, types and CI never come from the judgment pass.

## The judgment pass (`judgment.ts`)

`--scan` writes `~/.harness/judgment/lj<date>-<hex>/bundle.json` and
`prompt.md` for the lessons that need code or a judgment (at most 20 per
bundle; one pending bundle per lesson). The bundle holds lesson ids, class
keys, rule ids, the ledger record's statement and fix text (escaped), step
names, file paths and lines from the failing task's gate evidence (when a
later run has not replaced it; `..` and odd characters dropped), and counts.
The prompt states the token cap per item (`--token-cap`, default 4000; over
it the agent answers `not-a-lesson` with `token cap`), the ladder, and the
result shape. The agent may not write in `~/.harness` (the self-protection rail denies its file tools there), so it writes its answer outside every repository and hands it over with `harness judgment submit <id> --from <file>` (or `--from -` on standard input; `src/commands/judgment.ts`), which checks the id names an existing bundle, the size (1 MiB), JSON with `version: 1` and no hidden Unicode, and saves it as `result.json`; the full validation stays with the import. `--import-judgment <id>`
refuses the whole file on hidden Unicode, and each item on: a lesson not in
the bundle or already decided, a rung outside the item's rungs, a rule that
does not compile or fails its own samples (ast-grep through `ast-grep test`),
a rule without at least one correct sample it must leave alone (a match-all
rule would block every change at the gate), a regular expression with a
nested quantifier (the gate runs it in process over whole files),
a statement or fix text outside 10-300 / 1-300 characters, injection phrasing
(`scanInjection`), a test whose commits are not in order or whose files are
not committed at the fix, an instruction line that is not a negative
constraint.

## Proof (`prove.ts`)

| Enforcer | Proof | Sample of the mistake |
|---|---|---|
| ast-grep rule | `ast-grep test`: each invalid sample must be reported by a rule (else "Missing"), no valid sample may be | `--fixture <file>`, else the judgment's samples, else the probe library's own invalid cases |
| regex rule | the violating pattern matches every invalid sample and no valid one | same |
| ESLint rule | the repository's own ESLint (`--format json --stdin --stdin-filename`) reports the rule on the invalid samples only | `--fixture` or the judgment's samples; `--repo <path>` names the repository |
| regression test | red on the commit before the fix (the test files from the fix laid over it in a temporary `git worktree`), green on the fix; the repository's `test` script at the fix commit, the test files as arguments; nothing installed, `node_modules` linked | the two commits |
| gate step, or a check without a runnable sample | the class's `gate.fail` events: the step or rule failed on the original mistake when it happened (cited by event id) | the log |
| skill text, instruction line | unprovable by the harness (it would need agent runs with and without the text); the lesson stays proposed with that reason and the review shows it | - |

The proof records `result`, `method`, `detail`, `fixtureSource` and counts.
A proof that fails keeps the lesson `proposed` with the reason.

## Approval tiers (`tiers.ts`)

- **Tier 0**, automatic and logged: a proven lesson whose enforcer is a check
  in the private harness folder, or an enforcer that already exists. `prove`
  approves it at once: a learned check is written to
  `~/.harness/ledger/checks/learned/<id>.json` (+ `<id>.yml` for ast-grep,
  with the statement as the message and the fix as the note) and its record
  to `~/.harness/ledger/learned.json`. Nothing in any agent configuration
  changes and nothing is re-signed.
- **Tier 1**, the user's batched review: skill text and instruction lines
  (and, personal setting only, test or CI changes in the repository, which the
  judgment pass cannot produce today). `review --approve` records the decision
  (`reviewBy` 60 days for an always-loaded line, 90 for skill text) and builds
  a plan through `harness propose` (the renderer reads approved prose lessons:
  instruction lines go into the always-on file's Never list with their review
  date, skill text into the task skill's `references/lessons.md`); it prints
  `harness apply --plan <id>`.
- **Tier 2**, never automatic: rails, hooks and permissions, type changes.
  An explicit approval is recorded, and the harness writes nothing for it.
  Anything in a team repository is refused (exit 4) and routed to the team's
  own process (`harness propose --for-team <repo>`).

**Line budget.** An instruction line is refused when the rendered always-on
block (every always-on file of the configured setting and agents) would be
over 60 harness-owned lines, or when learned lines would exceed 10 (chosen,
no evidence; R-22 found 0-50 rules stable); the refusal names the oldest
learned lines to expire first.

## How learned checks reach the gate (`learned.ts`)

Discovery rewrites `ledger.json` and the top level of `ledger/checks/` on
every run, so learned checks live beside them. `withLearned(ledger)` merges
`learned.json` into the ledger that the gate's standards step and the hooks
load: a record that promotes a discovered one (same id, `overrides`) replaces
it in block mode; any other learned record is added; a learned record never
replaces a `safety` record and never shadows a record it does not promote.
`loadSpec` in `src/discover/checks.ts` resolves `learned/<file>.json`
references inside the checks folder. The standards step's cache key includes
a stamp of the learned files.

## Rot control (`gc.ts`)

`harness learn gc` lists, it never deletes or rewrites: approved prose past
its review date (renew or expire with `harness learn review --renew|--expire
<id>`, the user's); approved prose whose class came back 2+ times after it
landed (marked `promote`; the next scan asks the judgment pass for a rule or
a regression test, which replaces the prose once proven); approved code
checks that never fired in 182 days (review them); the learned-line count
against the cap. It also updates each enforcer's fire count (gate failures of
its class since it landed).

## Metrics (`stats.ts`)

`repeat_corrections` per class: an occurrence (a correction or gate failure
of the class) after the lesson was captured. Split at `landedAt` into before
and after the enforcer landed, with the number of distinct tasks seen in the
log in each window and the rate per task. Counts only; recomputed from the
log on every run, so a new event counts without a re-scan.

## Files

```
~/.harness/logs/events.jsonl                     input (never written by learn, except its own learn.* events)
~/.harness/lessons/<id>.json                     lesson records
~/.harness/judgment/lj<date>-<hex>/              bundle.json, prompt.md, result.json (the agent's answer, saved by `harness judgment submit`)
~/.harness/ledger/learned.json                   {version: 1, records: LearnedRecord[]}
~/.harness/ledger/checks/learned/<id>.json|.yml  learned check specs
~/.harness/plans/<planId>.json                   the plan a tier-1 approval builds (harness propose)
```

Instrumentation (names, ids, counts): `learn.scan`, `learn.prove`,
`learn.approve`, `learn.reject`, `learn.expire`, `learn.import-judgment`,
`learn.gc`, `learn.stats`. These are never read back as mistakes.

## A recorded run

`test/acceptance/learn-protocol.test.ts` (2026-10-19): a
ledger with the probe library's `logging.logger-not-console` standard in
warn mode; one scripted `gate.fail` naming it and two scripted corrections in
the same session; `--scan` made one lesson with 3 occurrences, a `lint`
enforcer, tier 0; `prove --fixture` with the original mistake passed
`ast-grep test` and wrote the learned check; a fed `gate.fail` and a real
`harness gate --steps standards` run on the repository with the mistake
(exit 1, the learned rule at `src/orders.ts:4`, in block mode) gave
`learn stats`: 5 occurrences, 2 repeats, 0 before and 2 after the enforcer
landed. Wall time 1.2 s.

## Limits

- The log has no text, so a correction that no gate failure explains needs
  the judgment pass to name what it was about; the agent has to work from
  file paths and counts, or from the code it can read.
- The gate's evidence for a task is replaced by its next run, so the file
  paths in a bundle are often gone by the weekly scan.
- Prose (skill text, instruction lines) is not proven; the review shows that.
- The PostToolUse hook loads the merged ledger, but whether its ledger
  checks run at edit time depends on the hook's runner interface (see the
  hooks README); the gate's standards step does run learned checks.
- The agent never writes `result.json` itself: the rail denies its file tools in
  `~/.harness`, so the answer arrives through `harness judgment submit` (an
  allow-listed task-time command), the same for all three judgment passes.
