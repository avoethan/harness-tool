/**
 * Shared contracts for the harness. Every module imports from here.
 * Add a type here only when two or more modules share it; module-private
 * types stay in the module. Keep this file dependency-free.
 */

export type Setting = 'team' | 'personal';
export type AgentId = 'devin' | 'claude' | 'codex';
export const ALL_AGENTS: AgentId[] = ['devin', 'claude', 'codex'];

/** Hook events the harness handles. Names follow the agents' own spelling. */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStop'
  | 'TaskCompleted'
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreCompact'
  | 'PostCompaction'
  | 'ConfigChange';

// ---------------------------------------------------------------------------
// Configuration (~/.harness/config.json)
// ---------------------------------------------------------------------------

export interface HarnessConfig {
  version: 1;
  setting: Setting;
  agents: AgentId[];
  /** Absolute. Team: the parent folder holding the repos. Personal: the repo itself. */
  workspaceRoot: string;
  repos: RepoRef[];
  db: DbConfig;
  /** MCP servers the agent may call, each with the targets it may reach. Everything else is denied. */
  mcp: { allowedServers: Record<string, string[]> };
  caps: Caps;
  /** Extra folders holding instruction files or skills (assess --include). */
  include: string[];
  reviews: { source: 'github-api' | 'pasted' | 'none' };
  /** `harness verify` settings (optional; every DB identity it names is still checked against `db.allowlist`). */
  verify?: VerifyConfig;
  /** Done-gate settings (optional; see src/gate/README.md). */
  gate?: GateConfig;
  /** Landing settings (optional, personal setting; see src/land/README.md). */
  land?: LandConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * Settings for `harness land` (personal setting). Read from the machine config and the repository's
 * `.harness/config.json` as it was on main before the landing, so a task cannot change how its own
 * landing is checked.
 */
export interface LandConfig {
  /**
   * The local CI command (`--ci local`): an argv array or one command line without shell features.
   * Runs in the landing checkout at the landed commit with CI=true; exit 0 is green. `{checkout}`,
   * `{sha}` and `{base}` are replaced by the checkout folder, the landed commit and main before the
   * landing. Without it the local CI is `harness gate --hook ci`.
   */
  ciCommand?: string[] | string;
}

/**
 * Settings for `harness verify`. Nothing here can widen the DB rail: the
 * server, the container and the source database of a snapshot must each
 * match an allowlist entry marked `test`. Never holds a password: only the
 * name of the environment variable that carries one.
 */
export interface VerifyConfig {
  db?: {
    /** `host[,port]` the services connect to (and a local sqlcmd uses). Default: the only server-wide test entry. */
    server?: string;
    user?: string;
    /** Name of the environment variable holding the password (never the password itself). */
    passwordEnv?: string;
    /** How sqlcmd is reached. `auto`: PATH first, then a running SQL Server container. */
    sqlcmd?: 'auto' | 'local' | 'docker';
    /** Absolute path of a local sqlcmd (default: found on PATH). */
    sqlcmdPath?: string;
    /** Container that runs SQL Server (docker mode). Default: the only running container of a SQL Server image. */
    container?: string;
    /** sqlcmd inside the container (default /opt/mssql-tools18/bin/sqlcmd). */
    containerSqlcmd?: string;
    /** `per-run` (default): create `test_<runId>` and drop it at cleanup. `existing`: use `database` as is (it must be marked test). */
    mode?: 'per-run' | 'existing';
    database?: string;
    /** Restore the run database from a snapshot: a server-side `.bak` path, or `db:<source database>` (copied with backup/restore or `clone:` for DBCC CLONEDATABASE). */
    snapshot?: string;
    /** Seed script (absolute, or relative to the entry repository). Default: `db/seed.sql`, `seed.sql`, `scripts/seed.sql`. */
    seed?: string;
    /** Migrations folder relative to each repository. Default: the conventional folders. */
    migrations?: string;
    /** Apply the migrations a snapshot does not hold (added or changed since the base commit, or whose tables are missing). Default true. */
    migrateAfterSnapshot?: boolean;
  };
  /** First port of the range the allocator probes (default 20000). */
  portBase?: number;
  /** How long a service may take to answer after start (default 90000). */
  readyTimeoutMs?: number;
}

export interface RepoRef {
  /** Stable id derived from the path (slug), never the user's wording. */
  id: string;
  path: string;
  name: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  isGit: boolean;
}

export interface DbConfig {
  allowlist: DbTarget[];
  markedAt?: string;
  /** sha256 of the allowlist as marked; the guard refuses to run when it does not match. */
  markedHash?: string;
}

export interface DbTarget {
  /** Hostname or host,port exactly as a client would be given it (case-insensitive). */
  server: string;
  /** Optional database name; absent means every database on that server is allowed. */
  database?: string;
  marked: 'test' | 'not-test';
}

export interface GateConfig {
  /** Per-step timeout in milliseconds, keyed by step name (`build`, `typecheck`, `lint`, `tests`, `acceptance`, `coverage`, `affected`). */
  timeoutsMs?: Record<string, number>;
  /** Protected paths (CI, hooks, lint config, ...) the gate lets this repository change (globs or folders). */
  allowedPaths?: string[];
}

export interface Caps {
  turns: number;
  unitMinutes: number;
  ticketMinutes: number;
  gateAttempts: number;
  budgetUsd?: number;
}

export const DEFAULT_CAPS: Caps = { turns: 80, unitMinutes: 25, ticketMinutes: 60, gateAttempts: 8 };

// ---------------------------------------------------------------------------
// Standards ledger (discover output)
// ---------------------------------------------------------------------------

export type Tier = 'declared' | 'counted-strong' | 'counted-majority' | 'review-derived' | 'single-source';

export type CheckType =
  | 'config'
  | 'eslint'
  | 'ast-grep'
  | 'semgrep'
  | 'dependency-cruiser'
  | 'knip'
  | 'sql-lint'
  | 'regex'
  | 'commitlint'
  | 'judgment';

export type CheckMode = 'block' | 'warn' | 'judgment';

export type StandardFamily =
  | 'lint'
  | 'format'
  | 'types'
  | 'naming'
  | 'layout'
  | 'sql'
  | 'tests'
  | 'errors'
  | 'logging'
  | 'api'
  | 'async'
  | 'imports'
  | 'validation'
  | 'commits'
  | 'ci'
  | 'safety'
  | 'other';

export interface LedgerRecord {
  /** Stable: `<family>.<slug>`; the same id across runs when the statement is the same. */
  id: string;
  /** One sentence, as a careful colleague would state the rule. */
  statement: string;
  family: StandardFamily;
  /** Repo ids the rule holds for; `['*']` for the whole workspace. Optional path globs narrow it. */
  scope: { repos: string[]; paths?: string[] };
  tier: Tier;
  /** 0..1 */
  confidence: number;
  evidence: Evidence;
  check: { type: CheckType; mode: CheckMode; ref?: string; fixText?: string };
  conflicts: Conflict[];
  provenance: Provenance[];
  history: { firstSeen: string; lastCounted: string; disputes: number };
}

export interface Evidence {
  /** Sites examined (for counted tiers) */
  sites: number;
  conforming: number;
  packages: number;
  examples: Example[];
  /** Free-form source refs, e.g. `eslint:.eslintrc.cjs`, `ci:.github/workflows/ci.yml#L12`. */
  sources: string[];
}

export interface Example {
  file: string;
  line: number;
  snippet?: string;
  conforms: boolean;
}

export interface Conflict {
  /** Narrowest unit where the alternative holds (repo id or path). */
  scope: string;
  statement: string;
  counts: { a: number; b: number };
}

export interface Provenance {
  kind: 'config' | 'ci' | 'hook' | 'doc' | 'agent-file' | 'count' | 'history' | 'review' | 'judgment';
  ref: string;
  quote?: string;
}

export interface ScannerStatus {
  name: string;
  available: boolean;
  version?: string;
  note?: string;
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface Ledger {
  version: 1;
  generatedAt: string;
  workspaceRoot: string;
  records: LedgerRecord[];
  skipped: SkippedItem[];
  scanners: ScannerStatus[];
}

// ---------------------------------------------------------------------------
// Assessment (assess output)
// ---------------------------------------------------------------------------

export type Classification = 'KEEP' | 'CONVERT' | 'TRIM' | 'FIX' | 'SPLIT' | 'QUARANTINE';

export interface AssessFinding {
  /** Check id such as `R10`. */
  check: string;
  severity: 'high' | 'warn' | 'info';
  file: string;
  line?: number;
  message: string;
  agent?: AgentId;
  evidence?: string;
  /** `judgment` when the finding came from an imported judgment result; absent or `deterministic` otherwise. */
  provenance?: 'deterministic' | 'judgment';
}

export interface LineClassification {
  file: string;
  line: number;
  text: string;
  cls: Classification;
  reason: string;
  check?: string;
  /** First line of the paragraph / list item / code fence the line belongs to (the unit that was classified). */
  unitStart?: number;
  /** When the whole file is quarantined: the class the line would have had otherwise. */
  underlying?: Classification;
  provenance?: 'deterministic' | 'judgment';
}

export type AssessLevel = 'user' | 'workspace' | 'repo' | 'ancestor' | 'include';
export type LoadWhen = 'launch' | 'lazy' | 'never';

export interface AssessedFile {
  path: string;
  /** e.g. `instructions`, `rule`, `skill`, `hook-config`, `permissions`, `mcp`, `other`. */
  kind: string;
  bytes: number;
  lines: number;
  loadedBy: AgentId[];
  sha256: string;
  /** Where the file sits. */
  level?: AssessLevel;
  /** Short path for people: `~/...` or workspace-relative. */
  display?: string;
  /** Per agent: when it loads the file and why. */
  loads?: Partial<Record<AgentId, { when: LoadWhen; note: string }>>;
  /** The size limit that applies, in words. */
  limit?: string;
  /** e.g. `legacy (Cursor)`, `imported by Devin from .claude/`. */
  label?: string;
  /** Set when hidden Unicode or injection patterns were found: the whole file is QUARANTINE. */
  quarantine?: { checks: string[]; lines: number[] };
}

export interface SafetyRule {
  source: string;
  kind: 'deny-rule' | 'ask-rule' | 'git-hook' | 'ci-required' | 'never-sentence';
  text: string;
  /** Line in `source` when the rule came from a text file. */
  line?: number;
  /** Where it was promoted to (hook/permission/gate step), once apply ran. */
  promoted?: string;
}

/** One session an agent may start (one working folder) and what it loads at launch. */
export interface AssessLoadSession {
  cwd: string;
  bytes: number;
  lines: number;
  files: string[];
  /** Files over the agent's limit. */
  overLimit: string[];
  /** Codex: the file cut at the budget, and the files dropped after it. */
  truncated?: string;
  dropped?: string[];
}

export interface AssessLoadDetail {
  limit?: number;
  limitNote: string;
  sessions: AssessLoadSession[];
  /** Devin: everything it would load once every sub-repo was touched (launch + lazy rule files). */
  effective?: { bytes: number; lines: number; files: string[] };
}

export interface AssessReport {
  version: 1;
  generatedAt: string;
  files: AssessedFile[];
  findings: AssessFinding[];
  classifications: LineClassification[];
  safetyRules: SafetyRule[];
  loaded: Partial<Record<AgentId, { bytes: number; lines: number; files: string[]; limit?: number }>>;
  neverLoaded: string[];
  workspaceRoot?: string;
  setting?: Setting;
  agents?: AgentId[];
  loadDetail?: Partial<Record<AgentId, AssessLoadDetail>>;
  /** Formats or scanners that could not be read, and things that cannot be known offline. */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Plans, manifest, backups (propose / apply / undo / uninstall)
// ---------------------------------------------------------------------------

export interface Plan {
  id: string;
  createdAt: string;
  setting: Setting;
  agents: AgentId[];
  /**
   * Personal setting: the repository the plan targets (absolute). The manifest
   * lives at `<repoRoot>/.harness/manifest.json` and the apply commit is made
   * there. When absent, apply derives it from the nearest git root of the
   * first target. Team setting: ignored.
   */
  repoRoot?: string;
  targets: PlanTarget[];
  notes: string[];
  rejections: Rejection[];
}

export interface PlanTarget {
  /** Absolute path. */
  path: string;
  owner: 'user' | 'generated';
  action: 'create' | 'modify' | 'delete' | 'merge-json';
  /** sha256 of the current content when the plan was written; apply refuses if it changed. */
  beforeSha: string | null;
  /** Full content after apply (for create/modify) or the JSON fragment to union in (merge-json). */
  after?: string;
  /** Unified diff for human reading. */
  diff?: string;
  /**
   * Team setting only: the path lies inside a team repository and must be
   * added to that repository's `.git/info/exclude` before the write. Apply
   * proves the exclusion with `git check-ignore -v` before and after.
   */
  exclude?: boolean;
  /** File mode for create/modify (POSIX), e.g. 0o755 for a git hook git must be able to run. */
  mode?: number;
  hunks: Hunk[];
}

export interface Hunk {
  checkId: string;
  reason: string;
  provenance: string;
  /** sha256 of the content this hunk proposes; rejections are keyed by (checkId, path, contentHash). */
  contentHash?: string;
}

export interface Rejection {
  checkId: string;
  path: string;
  contentHash: string;
  rejectedAt: string;
}

export interface Manifest {
  version: 1;
  harnessVersion: string;
  planId?: string;
  appliedAt?: string;
  files: ManifestFile[];
  settingsEdits: SettingsEdit[];
  /** Folders apply created (absolute, deepest first); uninstall removes them when empty. */
  createdDirs?: string[];
}

export interface ManifestFile {
  path: string;
  owner: 'user' | 'generated';
  beforeSha: string | null;
  afterSha: string;
  /** Backup copy path, or null when the file did not exist before. */
  backup: string | null;
}

export interface SettingsEdit {
  path: string;
  /** Dotted JSON path. */
  key: string;
  before: unknown;
  after: unknown;
}

// ---------------------------------------------------------------------------
// Gate and evidence
// ---------------------------------------------------------------------------

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';

export interface GateStep {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'cached';
  durationMs: number;
  reasons?: string[];
  cacheKey?: string;
  /** Whether the result came from the gate cache (`hit`), was computed (`miss`) or is never cached (`off`). */
  cache?: 'hit' | 'miss' | 'off';
}

export interface E2EArtifactRef {
  id: string;
  kind: 'http' | 'db' | 'browser';
  path: string;
  treeHash: string;
  createdAt: string;
}

export interface EvidenceFile {
  version: 1;
  repo: string;
  task: string;
  sessionId?: string;
  verdict: Verdict;
  reasons: string[];
  /** `git write-tree` of the working tree when the verdict was written. */
  treeHash: string;
  baseSha: string;
  steps: GateStep[];
  attempt: number;
  startedAt: string;
  finishedAt: string;
  e2e: E2EArtifactRef[];
  phase?: 'implement' | 'tests';
  /**
   * Written by the Stop hook when the per-session gate-attempt cap was reached
   * for this task (the agent was let go without a fresh PASS). The write-up
   * must not cite PASS for a capped task.
   */
  cap_reached?: boolean;
  cap_reached_at?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt?: string;
  stop_hook_active?: boolean;
  cwd?: string;
  transcript_path?: string;
  source?: string;
  [k: string]: unknown;
}

/** What a hook handler returns; the dispatcher turns it into exit code + stdout JSON. */
export interface HookResult {
  /** 0 = allow / continue; 2 = block (PreToolUse deny, Stop block, UserPromptSubmit block). */
  exitCode: 0 | 2;
  /** JSON object written to stdout (agent-specific shape built by the dispatcher). */
  stdout?: Record<string, unknown>;
  /** Shown to the agent on exit 2; also logged. */
  stderr?: string;
  /** Text injected as additionalContext (SessionStart, UserPromptSubmit, PostToolUse). */
  additionalContext?: string;
}

// ---------------------------------------------------------------------------
// Intake and tasks
// ---------------------------------------------------------------------------

export type CriterionKind = 'unit' | 'api' | 'db' | 'ui-artifact' | 'nonfunctional' | 'untestable';

export interface CheckSpec {
  kind: 'unit' | 'e2e-http' | 'e2e-db' | 'manual' | 'gate';
  description: string;
  command?: string;
  /** Proven red at the base commit before code. */
  redFirst?: boolean;
  /**
   * A check that must keep passing (characterisation, "no behaviour change", "existing tests still pass",
   * documentation-only, "README documents ..."). It is not red-first: `harness gate prove-red` expects it
   * green at the base commit, and the gate's acceptance step only needs the test to exist and pass now.
   */
  greenAtBase?: boolean;
  /** Why the check is green at the base commit; shown in the write-up as "green-at-base: <reason>". */
  greenAtBaseReason?: string;
  /** `gate` checks: gate step names that must have passed in this run (`lint`, `typecheck`, `build`, `tests:base`, `coverage`, `affected`, `standards`, `secrets`, `tamper`). */
  gateSteps?: string[];
  /** `gate` checks: repo-relative paths or folders; the change may touch nothing outside them. */
  scopePaths?: string[];
  /** `gate` checks: the brief's base commit stays an ancestor of HEAD (no rebase, no force-push, no rewrite). */
  keepsHistory?: boolean;
  /** Written by `harness gate prove-red`: the run at the base commit that proved (or failed to prove) the check red. */
  redProof?: RedProof;
}

export interface RedProof {
  baseSha: string;
  at: string;
  /** red: failed at the base commit (good); green: passed there; missing: no test carries the criterion id; error: could not run. */
  result: 'red' | 'green' | 'missing' | 'error';
  /** Test files (repo-relative) copied into the base checkout. */
  files: string[];
  exitCode: number | null;
}

export interface Criterion {
  id: string;
  text: string;
  kind: CriterionKind;
  /** EARS-form rewrite when the original was not testable as written. */
  ears?: string;
  check?: CheckSpec;
  question?: string;
  assumption?: string;
}

export interface Unit {
  id: string;
  title: string;
  repo: string;
  paths: string[];
  dependsOn: string[];
  criteria: string[];
}

export interface Brief {
  id: string;
  /** sha256 of the ticket text; ticket text itself is never stored in logs. */
  ticketHash: string;
  title: string;
  description: string;
  criteria: Criterion[];
  units: Unit[];
  repos: string[];
  questions: string[];
  assumptions: string[];
  createdAt: string;
}

export type TaskStatus = 'todo' | 'claimed' | 'done' | 'failed' | 'reverted' | 'blocked';

export interface TaskRecord {
  id: string;
  title: string;
  priority: number;
  status: TaskStatus;
  depends_on: string[];
  paths: string[];
  acceptance: string[];
  evidence?: string;
  claimed_at?: string;
  claimed_by?: string;
  commit?: string;
  /** Markdown body after the front matter. */
  body: string;
  /** File the record was read from. */
  file?: string;
}

// ---------------------------------------------------------------------------
// Instrumentation (event names, ids and counts only; never text)
// ---------------------------------------------------------------------------

export interface InstrumentationEvent {
  ts: string;
  event: string;
  sessionId?: string;
  repo?: string;
  task?: string;
  agent?: AgentId;
  /** Mistake class slug on `correction` events (style|test|scope|verify|safety|other); never text. */
  class?: string;
  counts?: Record<string, number>;
  ids?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Learning loop
// ---------------------------------------------------------------------------

export type EnforcerRung = 'types' | 'lint' | 'test' | 'hook' | 'ci' | 'skill' | 'instruction';

export interface Enforcer {
  rung: EnforcerRung;
  ref: string;
  provenOn?: string;
  fires: number;
}

export interface Lesson {
  id: string;
  /** Mistake class, a short slug. */
  class: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  /** Event ids, never text. */
  sources: string[];
  enforcer?: Enforcer;
  status: 'captured' | 'proposed' | 'proven' | 'approved' | 'expired' | 'rejected';
  tier: 0 | 1 | 2;
  reviewBy?: string;
}

// ---------------------------------------------------------------------------
// Report (counts only)
// ---------------------------------------------------------------------------

export interface TaskReportRow {
  ticketHash: string;
  criteria: number;
  checksRun: number;
  checksFailedThenFixed: number;
  gateVerdict: Verdict | 'none';
  verificationEvidence: number;
  standardsFlagged: number;
  clarificationsAsked: number;
  repeatCorrections: number;
  steeringMessages: number;
  reworkRounds?: number;
  outcome: string;
  /** Full gate runs recorded for the task (gate.verdict events in the period). */
  gateRuns?: number;
  /** The per-session gate-attempt cap released the agent without a fresh PASS. */
  capReached?: boolean;
}

export interface Report {
  version: 1;
  generatedAt: string;
  harnessVersion: string;
  standards: { byTier: Record<string, number>; byFamily: Record<string, number> };
  checks: { generated: number; byMode: Record<string, number>; byType?: Record<string, number> };
  assessment: { findingsByCheck: Record<string, number>; classifications: Record<string, number> };
  teamProposals: number;
  tasks: TaskReportRow[];
  learning: { captured: number; proven: number; approved: number; expired: number };
  /** The dates the report covers (first and last dated record it counted) and the `--since` filter. */
  period?: { since?: string; from?: string; to?: string };
  /** Caps that stopped work: tasks the gate-attempt cap released, Stop hooks that let an agent go at the cap. */
  caps?: { tasksAtGateCap: number; stopReleasesAtCap: number };
  /** Per agent: the self-check steps the user ran on the work machine (`harness selfcheck record`); step ids only. */
  selfcheck?: Partial<Record<AgentId, SelfcheckSummary>>;
  /** Rows of the user's work log the report read (`~/.harness/worklog.csv`). */
  worklogRows?: number;
}

export interface SelfcheckSummary {
  steps: number;
  recorded: number;
  /** Step ids whose recorded result matched the expected one. */
  confirmed: string[];
  /** Step ids whose recorded result differed from the expected one. */
  different: string[];
}
