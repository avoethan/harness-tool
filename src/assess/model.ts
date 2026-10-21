/**
 * Module-private types for `harness assess`. Shared output types live in
 * src/types.ts (AssessReport and friends); these describe the working set.
 */
import type { AgentId, AssessFinding, AssessLevel, Classification, LoadWhen, SafetyRule, Setting } from '../types';

export type FileKind =
  | 'instructions'
  | 'rule'
  | 'skill'
  | 'command'
  | 'subagent'
  | 'hook-config'
  | 'permissions'
  | 'settings'
  | 'mcp'
  | 'codex-rules'
  | 'legacy'
  | 'other';

/** Kinds whose lines are classified (prose an agent reads). */
export const PROSE_KINDS = new Set<FileKind>(['instructions', 'rule', 'skill', 'command', 'subagent', 'legacy']);

export interface AgentLoad {
  when: LoadWhen;
  note: string;
}

export interface InvFile {
  /** Absolute path as found (may be a symlink). */
  abs: string;
  /** `~/...`, workspace-relative, or absolute. */
  display: string;
  level: AssessLevel;
  /** Repository the file lives in (absolute), or null for user-level and parent-folder files. */
  repoRoot: string | null;
  kind: FileKind;
  label?: string;
  loads: Record<AgentId, AgentLoad>;
  limit: string;
  bytes: number;
  lines: number;
  sha256: string;
  /** Decoded text (UTF-8). */
  text: string;
  /** True when the bytes are not valid UTF-8 (binary or another encoding). */
  binary: boolean;
  /** Absolute target when the path is a symlink. */
  symlinkTo?: string;
  quarantine?: { checks: string[]; lines: number[] };
}

/** A working folder an agent may start a session in. */
export interface Session {
  cwd: string;
  /** Git root of the cwd, or null. */
  gitRoot: string | null;
  /** The opened workspace folder (Devin's workspace root). */
  isWorkspaceRoot: boolean;
}

export interface RepoInfo {
  root: string;
  name: string;
  isGit: boolean;
  /** Script names per package.json folder (absolute folder -> names). */
  scripts: Map<string, Set<string>>;
  makeTargets: Set<string> | null;
  justRecipes: Set<string> | null;
  prettier: PrettierInfo | null;
  eslint: EslintInfo | null;
  editorconfig: { file: string; indentStyle?: 'tab' | 'space'; indentSize?: number } | null;
  workflows: WorkflowInfo[];
  gitHooks: Array<{ abs: string; source: string; text: string }>;
  /** Files that could not be parsed (display paths with a reason). */
  unparsed: string[];
}

export interface PrettierInfo {
  file: string;
  useTabs: boolean;
  semi: boolean;
  singleQuote: boolean;
  tabWidth: number;
  printWidth: number;
  trailingComma: string;
  /** Options the file sets explicitly (the rest are Prettier's defaults). */
  explicit: Set<string>;
}

export interface EslintInfo {
  file: string;
  /** rule name -> 'off' | 'warn' | 'error' */
  rules: Map<string, string>;
}

export interface WorkflowInfo {
  file: string;
  triggers: Set<string>;
  jobs: Array<{ id: string; name: string; line: number }>;
  text: string;
}

export interface AssessContext {
  workspace: string;
  setting: Setting;
  agents: AgentId[];
  userHome: string;
  includes: string[];
  /** The workspace itself is a git repository (personal setting shape). */
  workspaceIsRepo: boolean;
  repos: RepoInfo[];
  sessions: Session[];
  files: InvFile[];
  findings: AssessFinding[];
  safety: SafetyRule[];
  notes: string[];
  /** Devin's read_config_from toggles as resolved (default true). */
  devinImports: { claude: boolean; cursor: boolean };
  /** Codex project trust per absolute folder (from ~/.codex/config.toml). */
  codexTrusted: Set<string>;
  codexBudget: number;
  codexFallbackNames: string[];
  /** `@path` imports found in CLAUDE.md-family files and Cursor rules. */
  imports: ImportRef[];
  /** Line-level verdicts from the checks; classify.ts turns them into unit classes. */
  marks: Mark[];
}

export interface Mark {
  file: InvFile;
  line: number;
  cls: Classification;
  check: string;
  reason: string;
  /** R25: only part of the unit is checkable (the unit becomes SPLIT). */
  partial?: boolean;
}

export interface ImportRef {
  from: InvFile;
  line: number;
  /** The text after `@`. */
  target: string;
  /** Resolved absolute path. */
  abs: string;
  exists: boolean;
}

/** A per-line verdict before it is turned into LineClassification records. */
export interface LineVerdict {
  cls: Classification;
  reason: string;
  check?: string;
}

export const CLASS_RANK: Record<Classification, number> = {
  QUARANTINE: 6,
  FIX: 5,
  SPLIT: 4,
  CONVERT: 3,
  TRIM: 2,
  KEEP: 1,
};
