/**
 * Types private to discovery (shared contracts live in src/types.ts).
 */
import type { CheckType, Example, StandardFamily } from '../types';

export type ProbeEngine = 'ast-grep' | 'filename' | 'path' | 'content' | 'subjects' | 'builtin';

/** One alternative a site can follow. Sites may match several variants (file-name case). */
export interface ProbeVariant {
  name: string;
  /** ast-grep: the rule id of this variant's document. */
  ruleId?: string;
  /** ast-grep: the full rule document (id, language, rule, constraints, ...). */
  rule?: Record<string, unknown>;
  /** Regex engines: the pattern the target must match to follow this variant. */
  pattern?: string;
  flags?: string;
  /** Statement template for a ledger record built from this variant ({NAME} placeholders). */
  statement?: string;
  fixText?: string;
  /** Prose that corroborates this variant (case-insensitive regexes over sentences). */
  prose?: string[];
  /** The community default: a record is emitted for it only when a config declares it. */
  isDefault?: boolean;
}

export interface DeclaredBy {
  /** ESLint rule names; the record is declared when one is on in the repo's config. */
  eslint?: string[];
  /** Prettier option -> variant per value, e.g. { singleQuote: { true: 'single', false: 'double', default: 'double' } }. */
  prettier?: Record<string, Record<string, string>>;
  /** Biome option path -> variant per value. */
  biome?: Record<string, Record<string, string>>;
  /** EditorConfig key -> variant per value. */
  editorconfig?: Record<string, Record<string, string>>;
  /** Test-runner include globs declare the test placement. */
  testRunner?: boolean;
  /** commitlint preset -> variant (e.g. { conventional: conventional }). */
  commitlint?: Record<string, string>;
}

export interface ProbeSpec {
  /** `<family>.<slug>`; also the ledger record id stem. */
  id: string;
  family: StandardFamily;
  engine: ProbeEngine;
  /** Source file of the probe, relative to the probe library root. */
  file: string;
  title: string;
  /** What counts as a site. */
  site: string;
  /** What counts as conforming. */
  conforming: string;
  /** Include globs relative to the repository root (default: every scanned file of the engine's kind). */
  files?: string[];
  exclude?: string[];
  /** fixed: only variants with a statement can become a standard; either: the dominant one can. */
  polarity: 'fixed' | 'either';
  /** Variants overlap (file-name case): a record needs discriminating sites. */
  overlapping?: boolean;
  /** Hygiene probes never become standards; violations become findings. */
  hygiene?: boolean;
  /** Informational probes feed the report and the judgment bundle only. */
  record?: boolean;
  /** Formatter-owned option: folded into the formatter record when a formatter config exists. */
  formatterOwned?: boolean;
  declaredBy?: DeclaredBy;
  /** What the record compiles to (the runnable check is always generated from the probe). */
  check: { type: CheckType; ref?: string };
  /** ast-grep metavariable whose dominant captured text fills `{NAME}` in statements. */
  capture?: string;
  /** builtin engine: implementation name and parameters. */
  builtin?: string;
  params?: Record<string, unknown>;
  variants: ProbeVariant[];
  /** Source of the probe: the library, or a judgment result id. */
  origin?: string;
}

/** sg-test style cases for one rule id / variant. */
export interface ProbeTestCase {
  id: string;
  valid: string[];
  invalid: string[];
}

export interface ScannedFile {
  /** Absolute path. */
  abs: string;
  /** Relative to its repository root, forward slashes. */
  rel: string;
  repoId: string;
  /** Package id (`<repoId>` or `<repoId>:<package dir>`). */
  pkg: string;
  bytes: number;
  kind: 'code' | 'sql' | 'other';
  isTest: boolean;
}

export interface RepoInfo {
  id: string;
  name: string;
  path: string;
  /** Relative to the workspace root, forward slashes ('.' for the root itself). */
  relPath: string;
  isGit: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  packages: PackageInfo[];
}

export interface PackageInfo {
  id: string;
  repoId: string;
  name: string;
  /** Relative to the repo root ('' for the root package). */
  dir: string;
  scripts: Record<string, string>;
  deps: string[];
  devDeps: string[];
}

/** Count of one site for one probe. */
export interface SiteHit {
  probe: string;
  file: ScannedFile;
  line: number;
  /** Stable key for the site within the file (byte range or line). */
  key: string;
  variants: string[];
  snippet?: string;
  captures?: Record<string, string>;
}

export interface VariantTally {
  sites: number;
  byVariant: Record<string, number>;
  /** Sites matching exactly one variant, per variant (for overlapping variants). */
  discriminating: Record<string, number>;
  packages: Set<string>;
  examples: Record<string, Example[]>;
  captures: Record<string, Record<string, number>>;
}

export interface ProbeTally {
  probe: ProbeSpec;
  total: VariantTally;
  perRepo: Map<string, VariantTally>;
  perPackage: Map<string, VariantTally>;
}

export interface Thresholds {
  scale: 'full' | 'small';
  sourceFiles: number;
  strong: { conformance: number; sites: number; packages: number };
  majority: { conformance: number; sites: number };
  corroborated: { conformance: number; sites: number };
  declaredFollowed: number;
  discriminating: { min: number; share: number };
  rule: string;
}

export interface ProseSentence {
  repoId: string | null;
  file: string;
  line: number;
  text: string;
  kind: 'doc' | 'agent-file';
}

export interface DeclaredSetting {
  repoId: string;
  source: string;
  tool: 'eslint' | 'prettier' | 'biome' | 'editorconfig' | 'tsconfig' | 'test-runner' | 'ci' | 'commitlint' | 'hook';
  key: string;
  value: unknown;
  /** ESLint: 'error' | 'warn' | 'off'. */
  severity?: 'error' | 'warn' | 'off';
  /** How it was read: the repo's own binary, or the config text. */
  via: 'resolved' | 'static';
  explicit: boolean;
  /** ESLint overrides: the file globs the setting is limited to. */
  files?: string[];
  /** 1-based line in the source file, when known. */
  line?: number;
  /** Package directory the setting belongs to ('' = the repository root). */
  pkgDir?: string;
}

export interface EffectiveConfigRun {
  repoId: string;
  tool: 'eslint' | 'tsc';
  file: string;
  ok: boolean;
  note: string;
}

export interface DiscoverFinding {
  kind:
    | 'declared-but-not-followed'
    | 'conflict'
    | 'hygiene'
    | 'scanner-absent'
    | 'probes-skipped'
    | 'judgment-unproven'
    | 'judgment-rejected'
    | 'prose-unproven'
    | 'effective-config'
    | 'mixed';
  id: string;
  message: string;
  scope: string[];
  counts?: { sites: number; conforming: number; ratio: number };
  sources?: string[];
  examples?: Example[];
  proposal?: string;
}
