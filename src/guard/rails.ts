/**
 * Canonical safety-rail definitions, exported as data so the guard
 * (src/guard/index.ts, src/guard/db.ts) and the per-agent permission
 * renderer (src/guard/permissions.ts) read one source.
 *
 * Nothing here is setup-specific: paths are patterns, roots are supplied
 * by the caller at run time.
 */
import type { Setting } from '../types';

export type RailId =
  | 'git-history'
  | 'git-hooks-bypass'
  | 'team-push'
  | 'team-gh'
  | 'team-remote'
  | 'secrets'
  | 'db'
  | 'mcp'
  | 'protect'
  | 'nested-agent'
  | 'team-shaped'
  | 'phase-tests'
  | 'staging'
  | 'outbound'
  | 'harness-admin'
  | 'opaque'
  | 'internal';

export interface RailDef {
  id: RailId;
  settings: Setting[] | 'all';
  /** One sentence for humans. */
  summary: string;
}

export const RAILS: RailDef[] = [
  { id: 'git-history', settings: 'all', summary: 'No force-push or history rewrite.' },
  { id: 'git-hooks-bypass', settings: 'all', summary: 'Git hooks are never skipped (--no-verify, core.hooksPath, aliases).' },
  { id: 'team-push', settings: ['team'], summary: 'Team setting: the agent never pushes.' },
  { id: 'team-gh', settings: ['team'], summary: 'Team setting: nothing is posted to GitHub (gh/glab/hub mutations, API writes).' },
  { id: 'team-remote', settings: ['team'], summary: 'Team setting: remotes and push URLs are not changed.' },
  { id: 'secrets', settings: 'all', summary: 'Secret files are never added, read into the transcript, copied or overwritten.' },
  { id: 'db', settings: 'all', summary: 'Database clients only reach servers marked as test.' },
  { id: 'mcp', settings: 'all', summary: 'MCP servers must be allowlisted with their targets.' },
  { id: 'protect', settings: 'all', summary: 'Harness state, agent configuration and the harness package are not written by the agent.' },
  { id: 'nested-agent', settings: 'all', summary: 'Nested agent runs keep hooks and permissions on.' },
  { id: 'team-shaped', settings: ['team'], summary: 'Team setting: no harness-shaped files are written inside team repos.' },
  { id: 'phase-tests', settings: 'all', summary: 'Test and golden files change only in the tests phase.' },
  { id: 'staging', settings: 'all', summary: 'Commits never carry secrets; team commits never carry harness files.' },
  { id: 'outbound', settings: 'all', summary: 'The agent never sends email (git send-email, git imap-send).' },
  { id: 'harness-admin', settings: 'all', summary: 'Harness commands that change rails or agent configuration are run by the user in a terminal, never by the agent.' },
];

// ---------------------------------------------------------------------------
// Harness admin commands (run by the user, never by the agent)
// ---------------------------------------------------------------------------

/** Program names and script paths that mean "the harness CLI". */
export const HARNESS_PROGS = new Set(['harness', 'harness.cmd']);
export const HARNESS_CLI_PATH_RE = /(^|[\\/])(dist[\\/]src[\\/]cli\.js|bin[\\/]harness(\.cmd)?)$/i;

/** Subcommands that are always the user's. */
export const HARNESS_ADMIN_SUBS = new Set(['install', 'apply', 'undo', 'uninstall', 'self-update', 'pr']);
/** Subcommands whose listed second word is the user's (the rest of that subcommand stays allowed). */
export const HARNESS_ADMIN_SECOND: Record<string, Set<string>> = {
  config: new Set(['set', 'unset', 'reset']),
  db: new Set(['mark', 'unmark']),
  // record, probe-mode and probe-hook write self-check evidence the user reads; only the user produces it
  selfcheck: new Set(['probe-files', 'record', 'probe-mode', 'probe-hook']),
  learn: new Set(['review']),
};
/** Subcommand and second word that are the user's only with one of these flags (the read form stays allowed). */
export const HARNESS_ADMIN_SECOND_FLAGS: Record<string, Record<string, string[]>> = {
  selfcheck: { 'probe-log': ['--clear'] },
};
/**
 * Flags that make any harness command an admin command. `--ci-command` names a command the landing
 * runs from inside the harness process, where the guard cannot see it, so only the user passes it.
 */
export const HARNESS_ADMIN_FLAGS = new Set(['--from-install', '--approve', '--reject', '--ci-command']);


// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/** git global options that take a value (so the subcommand can be found). */
export const GIT_GLOBAL_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source']);
export const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '-p', '-P', '--paginate', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--html-path', '--man-path', '--info-path']);

export interface GitDenySpec {
  id: string;
  rail: RailId;
  sub: string[];
  /** Deny whenever the subcommand appears, flags or not. */
  always?: boolean;
  /** Any of these flags (after short-flag expansion, before any `--`) denies. */
  flags?: string[];
  /** Flags that carry a value with `=`. */
  flagPrefixes?: string[];
  /** All flags of one group present together deny (e.g. -d with -f). */
  flagCombos?: string[][];
  /** Positional (non-flag) argument pattern that denies, e.g. +refspec. */
  argRe?: RegExp;
  /** First positional argument in this set denies (git reflog expire). */
  firstArg?: string[];
  settings: Setting[] | 'all';
  reason: string;
  /** argv prefixes for the permission renderers. */
  prefixes: string[][];
}

export const GIT_DENY: GitDenySpec[] = [
  {
    id: 'git.push.force',
    rail: 'git-history',
    sub: ['push'],
    flags: ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--prune'],
    flagPrefixes: ['--force-with-lease=', '--force-if-includes='],
    // +ref forces one ref; :ref (an empty source) deletes the remote ref, the same as --delete
    argRe: /^[+:]./,
    settings: 'all',
    reason: 'Force-pushing rewrites shared history; push a new commit on top instead (plain git push, no --force, -f, +ref, :ref, --delete or --mirror).',
    prefixes: [
      ['git', 'push', '--force'],
      ['git', 'push', '-f'],
      ['git', 'push', '--force-with-lease'],
      ['git', 'push', '--force-if-includes'],
      ['git', 'push', '--mirror'],
      ['git', 'push', '--delete'],
      ['git', 'push', '-d'],
      ['git', 'push', '--prune'],
    ],
  },
  {
    id: 'git.reset.hard',
    rail: 'git-history',
    sub: ['reset'],
    flags: ['--hard', '--merge', '--keep'],
    settings: 'all',
    reason: 'git reset --hard discards commits and working-tree changes; use git stash, git restore <file> or a new commit instead.',
    prefixes: [['git', 'reset', '--hard'], ['git', 'reset', '--merge'], ['git', 'reset', '--keep']],
  },
  {
    id: 'git.rebase',
    rail: 'git-history',
    sub: ['rebase'],
    always: true,
    settings: 'all',
    reason: 'git rebase rewrites history; merge the target branch in (git merge) instead.',
    prefixes: [['git', 'rebase']],
  },
  {
    id: 'git.pull.rebase',
    rail: 'git-history',
    sub: ['pull'],
    flags: ['--rebase', '-r', '--autostash'],
    flagPrefixes: ['--rebase='],
    settings: 'all',
    reason: 'git pull --rebase rewrites local history; use git pull --ff-only or git merge instead.',
    prefixes: [['git', 'pull', '--rebase'], ['git', 'pull', '-r']],
  },
  {
    id: 'git.filter-branch',
    rail: 'git-history',
    sub: ['filter-branch', 'filter-repo', 'replace'],
    always: true,
    settings: 'all',
    reason: 'History rewriting tools are not allowed; leave history as it is and ask the user if a rewrite is really needed.',
    prefixes: [['git', 'filter-branch'], ['git', 'filter-repo'], ['git', 'replace']],
  },
  {
    id: 'git.commit.amend',
    rail: 'git-history',
    sub: ['commit'],
    flags: ['--amend'],
    settings: 'all',
    reason: 'git commit --amend rewrites the last commit; make a new commit instead.',
    prefixes: [['git', 'commit', '--amend']],
  },
  {
    id: 'git.branch.force-delete',
    rail: 'git-history',
    sub: ['branch'],
    flags: ['-D', '-M'],
    flagCombos: [
      ['-d', '-f'],
      ['--delete', '--force'],
      ['--delete', '-f'],
      ['-d', '--force'],
      ['-m', '-f'],
      ['--move', '--force'],
      ['-c', '-f'],
      ['--copy', '--force'],
    ],
    settings: 'all',
    reason: 'Force-deleting or force-moving a branch loses commits; use git branch -d (safe delete) or ask the user.',
    prefixes: [['git', 'branch', '-D'], ['git', 'branch', '-M'], ['git', 'branch', '--delete', '--force']],
  },
  {
    id: 'git.add.force',
    rail: 'git-history',
    sub: ['add'],
    flags: ['-f', '--force'],
    settings: 'all',
    reason: 'git add --force stages ignored files (often secrets or build output); remove the ignore rule on purpose or leave the file out.',
    prefixes: [['git', 'add', '-f'], ['git', 'add', '--force']],
  },
  {
    id: 'git.update-ref.delete',
    rail: 'git-history',
    sub: ['update-ref'],
    flags: ['-d', '--delete'],
    settings: 'all',
    reason: 'Deleting refs directly loses history; use git branch -d or git tag -d for the ref you mean.',
    prefixes: [['git', 'update-ref', '-d']],
  },
  {
    id: 'git.reflog.expire',
    rail: 'git-history',
    sub: ['reflog'],
    firstArg: ['expire', 'delete'],
    settings: 'all',
    reason: 'Expiring the reflog makes lost commits unrecoverable; leave the reflog alone.',
    prefixes: [['git', 'reflog', 'expire'], ['git', 'reflog', 'delete']],
  },
  {
    id: 'git.gc.prune',
    rail: 'git-history',
    sub: ['gc'],
    flagPrefixes: ['--prune='],
    flags: ['--prune'],
    settings: 'all',
    reason: 'Pruning unreachable objects makes lost commits unrecoverable; run git gc without --prune, or leave garbage collection to git.',
    prefixes: [['git', 'gc', '--prune']],
  },
  {
    id: 'git.prune',
    rail: 'git-history',
    sub: ['prune'],
    always: true,
    settings: 'all',
    reason: 'git prune deletes unreachable objects, which makes lost commits unrecoverable; leave pruning to the user.',
    prefixes: [['git', 'prune']],
  },
  {
    id: 'git.tag.force',
    rail: 'git-history',
    sub: ['tag'],
    flags: ['-f', '--force'],
    settings: 'all',
    reason: 'Moving a tag with --force rewrites what others fetched; create a new tag name instead.',
    prefixes: [['git', 'tag', '-f'], ['git', 'tag', '--force']],
  },
  {
    id: 'git.checkout.force-branch',
    rail: 'git-history',
    sub: ['checkout', 'switch'],
    flags: ['-B', '-C', '--force-create'],
    settings: 'all',
    reason: 'Resetting an existing branch with -B/-C loses its commits; create a new branch name (-b/-c) instead.',
    prefixes: [['git', 'checkout', '-B'], ['git', 'switch', '-C'], ['git', 'switch', '--force-create']],
  },
  {
    id: 'git.stash.drop',
    rail: 'git-history',
    sub: ['stash'],
    firstArg: ['drop', 'clear'],
    settings: 'all',
    reason: 'Dropping stashes loses work; leave stashes for the user to clear.',
    prefixes: [['git', 'stash', 'drop'], ['git', 'stash', 'clear']],
  },
  {
    id: 'git.no-verify',
    rail: 'git-hooks-bypass',
    sub: ['commit', 'push', 'merge', 'am', 'rebase', 'cherry-pick', 'revert'],
    flags: ['--no-verify', '-n'],
    settings: 'all',
    reason: 'Git hooks are part of the harness and are never skipped; run the command without --no-verify and fix what the hook reports.',
    prefixes: [['git', 'commit', '--no-verify'], ['git', 'commit', '-n'], ['git', 'push', '--no-verify'], ['git', 'merge', '--no-verify']],
  },
  {
    id: 'git.send-email',
    rail: 'outbound',
    sub: ['send-email', 'imap-send'],
    always: true,
    settings: 'all',
    reason: 'The agent never sends email; hand the patch to the user instead.',
    prefixes: [['git', 'send-email']],
  },
  {
    id: 'git.push.team',
    rail: 'team-push',
    sub: ['push'],
    always: true,
    settings: ['team'],
    reason: 'In the team setting the agent never pushes; finish with `harness writeup` and the user pushes and opens the pull request.',
    prefixes: [['git', 'push']],
  },
  {
    id: 'git.svn-p4.team',
    rail: 'team-push',
    sub: ['svn', 'p4'],
    firstArg: ['dcommit', 'submit', 'commit'],
    settings: ['team'],
    reason: 'In the team setting the agent never publishes commits; hand the change to the user.',
    prefixes: [['git', 'svn', 'dcommit'], ['git', 'p4', 'submit']],
  },
  {
    id: 'git.remote.team',
    rail: 'team-remote',
    sub: ['remote'],
    firstArg: ['add', 'set-url', 'rename', 'remove', 'rm', 'set-head', 'set-branches'],
    settings: ['team'],
    reason: 'In the team setting remotes are not changed by the agent; leave remotes as they are and tell the user what is needed.',
    prefixes: [['git', 'remote', 'add'], ['git', 'remote', 'set-url'], ['git', 'remote', 'rename'], ['git', 'remote', 'remove'], ['git', 'remote', 'rm']],
  },
];

/** git config keys the agent may not set (matched against the key, case-insensitive). */
export const GIT_CONFIG_DENY: Array<{ id: string; rail: RailId; re: RegExp; settings: Setting[] | 'all'; reason: string }> = [
  { id: 'git.config.hookspath', rail: 'git-hooks-bypass', re: /^core\.hookspath$/i, settings: 'all', reason: 'core.hooksPath would bypass the git hooks the harness installs; leave the hook path alone.' },
  { id: 'git.config.alias', rail: 'git-hooks-bypass', re: /^alias\./i, settings: 'all', reason: 'Git aliases can hide forbidden commands from the guard; run the full git command instead of defining an alias.' },
  { id: 'git.config.rebase', rail: 'git-history', re: /^(pull\.rebase|branch\..*\.rebase|rebase\.autostash|rebase\.updaterefs)$/i, settings: 'all', reason: 'Enabling rebase by configuration rewrites history on pull; keep pull.rebase unset or false.' },
  { id: 'git.config.pushurl', rail: 'team-remote', re: /^(remote\..*\.(pushurl|url)|url\..*\.(pushinsteadof|insteadof)|push\.|credential\.)/i, settings: ['team'], reason: 'In the team setting push URLs, remote URLs and credential helpers are not changed by the agent.' },
  { id: 'git.config.edit', rail: 'git-hooks-bypass', re: /^--(edit|e)$/i, settings: 'all', reason: 'Editing git config in an editor cannot be checked by the guard; set single keys explicitly or leave the config alone.' },
];

/** Values of `pull.rebase` that are safe. */
export const GIT_REBASE_FALSE = new Set(['false', '0', 'no', 'off']);

/** git subcommands that write to the repository (used for the protected-root check). */
export const GIT_MUTATING_SUBS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'fetch', 'gc', 'init', 'merge', 'mv', 'notes', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'submodule', 'switch', 'tag', 'update-index', 'update-ref', 'worktree', 'write-tree', 'read-tree', 'symbolic-ref', 'pack-refs', 'prune', 'reflog', 'repack', 'replace', 'branch', 'remote', 'sparse-checkout', 'maintenance', 'lfs',
]);

/** git env vars that redirect where git writes. */
export const GIT_ENV_PATHS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

// ---------------------------------------------------------------------------
// GitHub / GitLab CLIs (team setting)
// ---------------------------------------------------------------------------

/** gh invocations that are read-only: `<cmd> <sub>` pairs; `<cmd>` alone allows every sub. */
export const GH_READONLY: string[] = [
  'auth status',
  'pr list', 'pr view', 'pr status', 'pr diff', 'pr checks', 'pr checkout',
  'issue list', 'issue view', 'issue status',
  'repo view', 'repo list', 'repo clone',
  'release list', 'release view', 'release download',
  'run list', 'run view', 'run watch', 'run download',
  'workflow list', 'workflow view',
  'search',
  'label list',
  'gist list', 'gist view',
  'config get', 'config list',
  'cache list',
  'variable list',
  'secret list',
  'ssh-key list',
  'ruleset list', 'ruleset view',
  'project list', 'project view',
  'extension list',
  'status',
  'browse',
  'version', '--version', 'help', '--help',
  'api',
];

/** gh api flags that make a request a mutation. */
export const GH_API_MUTATING_FLAGS = new Set(['-f', '--field', '-F', '--raw-field', '--input', '--method', '-X']);

export const GLAB_READONLY: string[] = [
  'auth status',
  'mr list', 'mr view', 'mr diff', 'mr checkout',
  'issue list', 'issue view',
  'repo view', 'repo list', 'repo clone',
  'ci list', 'ci view', 'ci status', 'ci trace',
  'release list', 'release view',
  'variable list', 'label list',
  'version', '--version', 'help', '--help',
  'api',
];

export const HUB_READONLY: string[] = ['browse', 'compare', 'ci-status', 'version', '--version', 'help'];

/** Hosts where an HTTP mutation counts as posting to the team's code host. */
export const CODE_HOST_RE = /(^|[./@])(api\.)?(github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com|githubusercontent\.com)(:\d+)?([/?#]|$)/i;

/** curl / wget / PowerShell flags that make an HTTP request a mutation. */
export const HTTP_MUTATING_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '-F', '--form', '--form-string', '--json', '-T', '--upload-file', '--post-data', '--post-file', '--method', '--body', '-infile', '--patch', '--put', '--delete']);

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Files that are examples or templates, never secrets. */
export const SECRET_EXAMPLE_RE = /(^|[\\/])\.env\.(example|sample|template|dist|schema|defaults?|test\.example)$/i;

/** Auth and token files beyond src/lib/redact's list. */
export const SECRET_EXTRA_RE = /(^|[\\/])(\.claude\.json|auth\.json|\.git-credentials|\.docker[\\/]config\.json|\.kube[\\/]config|token(s)?\.json|\.htpasswd|\.boto|\.s3cfg|\.pgpass|\.my\.cnf|\.aws[\\/]credentials|\.azure[\\/]accessTokens\.json|\.config[\\/]gh[\\/]hosts\.yml|\.config[\\/]devin[\\/]auth[^\\/]*|known_hosts\.old|.*\.ovpn|.*\.keystore|.*\.asc|.*\.gpg|.*\.ppk)$/i;

/** Programs that may take a secret-file path without exposing its contents. */
export const SECRET_SAFE_PROGS = new Set([
  'ls', 'll', 'dir', 'stat', 'test', '[', '[[', 'file', 'wc', 'du', 'find', 'basename', 'dirname', 'realpath', 'readlink', 'chmod', 'chown', 'chgrp', 'echo', 'printf', 'shasum', 'sha256sum', 'sha1sum', 'md5sum', 'cksum', 'b2sum', 'gitleaks', 'trufflehog', 'detect-secrets', 'git-secrets', 'ggshield', 'dotenv', 'dotenvx', 'env-cmd', 'source', '.', 'export', 'set', 'declare', 'typeset', 'local', 'readonly', 'test-path', 'get-item', 'get-childitem', 'gci', 'gi', 'ls', 'exists', 'ssh', 'ssh-add', 'ssh-keygen', 'ssh-agent', 'kubectl', 'helm', 'terraform', 'ansible', 'ansible-playbook', 'docker', 'podman', 'scp', 'rsync', 'npm', 'pnpm', 'yarn', 'pip', 'node', 'python', 'python3', 'direnv', 'mise', 'asdf', 'nvm', 'make', 'just', 'task', 'cargo', 'go', 'dotnet', 'java', 'mvn', 'gradle',
]);
// Note: ssh/scp/rsync/docker/kubectl with a key file are normal uses (ssh -i key); the copy
// rule below still catches `scp secret host:` and `cp secret dest` by position.

/** Parents of a $(...) that only load a secret file into the environment. */
export const SECRET_LOAD_PARENTS = new Set(['export', 'env', 'set', 'declare', 'typeset', 'local', 'readonly', 'source', '.', 'dotenv', 'dotenvx', 'env-cmd', 'eval']);

/** Programs that copy their arguments somewhere (secret source denied by position). */
export const COPY_PROGS = new Set(['cp', 'copy', 'copy-item', 'ci', 'cpi', 'scp', 'rsync', 'mv', 'move', 'move-item', 'mi', 'robocopy', 'xcopy', 'install', 'dd', 'tar', 'zip', '7z', 'gzip', 'bzip2', 'xz', 'zstd', 'compress-archive', 'base64', 'uuencode', 'curl', 'wget', 'http', 'https', 'xh', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'nc', 'ncat', 'netcat', 'socat', 'mail', 'mailx', 'sendmail', 'mutt', 'aws', 'az', 'gcloud', 'gsutil', 'rclone', 'ftp', 'sftp', 'lftp', 'git']);

/** `curl -d @file`, `-F x=@file`, `--data-binary @file`, `-T file`, `--upload-file file`. */
export const CURL_FILE_ARG_RE = /^(?:[^=]*=)?@(.+)$/;

// ---------------------------------------------------------------------------
// Database clients
// ---------------------------------------------------------------------------

export type DbKind = 'mssql' | 'pg' | 'mysql' | 'mongo' | 'redis' | 'sqlpackage' | 'migration' | 'dbatools';

export interface DbClientSpec {
  kind: DbKind;
  /** Flags whose value is the server (short attached forms allowed: -Sfoo). */
  serverFlags: string[];
  /** Flags whose value is the database. */
  dbFlags: string[];
  /** Flags whose value is an inline query/command. */
  queryFlags: string[];
  /** Flags that take a query but leave the client interactive afterwards (sqlcmd -q). */
  interactiveFlags?: string[];
  /** Flags whose value is a script file (always denied). */
  scriptFlags: string[];
  /** Flags that turn the server flag into a DSN name (always denied). */
  dsnFlags: string[];
  /** Flags whose value is a whole connection string. */
  connFlags: string[];
  /** Flags whose value is a config alias (always denied). */
  aliasFlags: string[];
  /** Flags that take a value and are otherwise irrelevant. */
  valueFlags: string[];
  /** Flags whose value is a file the client writes. */
  outFlags: string[];
  /** Env var names read for the server / database. */
  envServer: string[];
  envDb: string[];
  /** Without a server the client connects locally. */
  defaultLocal: boolean;
  /** The first positional argument is the database or a URI. */
  positionalDb?: boolean;
  /** PowerShell cmdlet: -Param value or -Param:value, prefix-matched. */
  cmdlet?: boolean;
  /** Only these first arguments make it a DB command (migration tools). */
  subcommands?: RegExp;
}

export const DB_CLIENTS: Record<string, DbClientSpec> = {
  sqlcmd: { kind: 'mssql', serverFlags: ['-S', '--server'], dbFlags: ['-d', '--database-name'], queryFlags: ['-Q', '--query'], interactiveFlags: ['-q'], scriptFlags: ['-i', '--input-file'], dsnFlags: ['-D'], connFlags: [], aliasFlags: [], valueFlags: ['-U', '-P', '-H', '-v', '-l', '-t', '-h', '-s', '-w', '-a', '-c', '-m', '-y', '-Y', '-z', '-Z', '-f', '-k', '-M', '-N', '-F', '-C', '--authentication-method', '--driver-logging-level', '--format', '--application-intent', '--encrypt-connection'], outFlags: ['-o', '--output-file'], envServer: ['SQLCMDSERVER'], envDb: ['SQLCMDDBNAME'], defaultLocal: true },
  osql: { kind: 'mssql', serverFlags: ['-S'], dbFlags: ['-d'], queryFlags: ['-Q'], interactiveFlags: ['-q'], scriptFlags: ['-i'], dsnFlags: ['-D'], connFlags: [], aliasFlags: [], valueFlags: ['-U', '-P', '-H', '-v', '-l', '-t', '-h', '-s', '-w', '-a', '-c', '-m'], outFlags: ['-o'], envServer: ['SQLCMDSERVER', 'OSQLSERVER'], envDb: [], defaultLocal: true },
  isql: { kind: 'mssql', serverFlags: ['-S'], dbFlags: ['-d'], queryFlags: ['-Q'], interactiveFlags: ['-q'], scriptFlags: ['-i'], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '-P', '-H', '-v', '-b', '-w', '-x', '-c'], outFlags: ['-o'], envServer: [], envDb: [], defaultLocal: false },
  bcp: { kind: 'mssql', serverFlags: ['-S'], dbFlags: ['-d'], queryFlags: [], scriptFlags: [], dsnFlags: ['-D'], connFlags: [], aliasFlags: [], valueFlags: ['-U', '-P', '-f', '-e', '-F', '-L', '-b', '-t', '-r', '-m', '-i', '-o', '-a', '-C', '-E', '-h', '-x'], outFlags: [], envServer: [], envDb: [], defaultLocal: true },
  'mssql-cli': { kind: 'mssql', serverFlags: ['-S', '--server'], dbFlags: ['-d', '--database'], queryFlags: ['-Q', '--query'], scriptFlags: ['-i', '--input_file'], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '-P', '-o', '--output_file', '--mssqlclirc', '--row-limit', '--auth-type', '--encrypt'], outFlags: ['-o', '--output_file'], envServer: ['MSSQL_CLI_SERVER'], envDb: ['MSSQL_CLI_DATABASE'], defaultLocal: true },
  sqlpackage: { kind: 'sqlpackage', serverFlags: ['/SourceServerName', '/ssn', '/TargetServerName', '/tsn'], dbFlags: ['/SourceDatabaseName', '/sdn', '/TargetDatabaseName', '/tdn'], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['/SourceConnectionString', '/scs', '/TargetConnectionString', '/tcs'], aliasFlags: [], valueFlags: [], outFlags: [], envServer: [], envDb: [], defaultLocal: false },
  tsql: { kind: 'mssql', serverFlags: ['-H'], dbFlags: ['-D'], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: ['-S', '-I'], valueFlags: ['-U', '-P', '-p', '-o', '-t', '-r', '-a', '-L', '-C'], outFlags: [], envServer: ['TDSHOST'], envDb: [], defaultLocal: false },
  bsqldb: { kind: 'mssql', serverFlags: ['-H'], dbFlags: ['-D'], queryFlags: [], scriptFlags: ['-i'], dsnFlags: [], connFlags: [], aliasFlags: ['-S', '-I'], valueFlags: ['-U', '-P', '-p', '-o', '-e', '-t', '-r', '-R'], outFlags: ['-o'], envServer: [], envDb: [], defaultLocal: false },
  fisql: { kind: 'mssql', serverFlags: ['-S'], dbFlags: ['-D'], queryFlags: [], scriptFlags: ['-i'], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '-P', '-J', '-o'], outFlags: ['-o'], envServer: [], envDb: [], defaultLocal: false },
  'invoke-sqlcmd': { kind: 'mssql', cmdlet: true, serverFlags: ['-ServerInstance'], dbFlags: ['-Database'], queryFlags: ['-Query'], scriptFlags: ['-InputFile'], dsnFlags: [], connFlags: ['-ConnectionString'], aliasFlags: [], valueFlags: ['-Username', '-Password', '-Credential', '-QueryTimeout', '-ConnectionTimeout', '-Variable', '-Hostname', '-ApplicationName', '-ApplicationIntent', '-MaxCharLength', '-MaxBinaryLength', '-OutputAs', '-As', '-Encrypt', '-ErrorLevel', '-SeverityLevel', '-AccessToken', '-StatisticsVariable', '-ErrorAction', '-WarningAction', '-InformationAction', '-ErrorVariable', '-OutVariable', '-OutBuffer', '-PipelineVariable', '-ProgressAction'], outFlags: [], envServer: [], envDb: [], defaultLocal: true },
  'invoke-dbaquery': { kind: 'dbatools', cmdlet: true, serverFlags: ['-SqlInstance'], dbFlags: ['-Database'], queryFlags: ['-Query'], scriptFlags: ['-File'], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-SqlCredential', '-QueryTimeout', '-As', '-SqlParameter', '-CommandType', '-ErrorAction'], outFlags: [], envServer: [], envDb: [], defaultLocal: false },
  psql: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: ['-d', '--dbname'], queryFlags: ['-c', '--command'], scriptFlags: ['-f', '--file'], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '-v', '--set', '--variable', '-F', '--field-separator', '-R', '--record-separator', '-T', '--table-attr', '-P', '--pset', '-L', '--log-file'], outFlags: ['-o', '--output', '-L', '--log-file'], envServer: ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true, positionalDb: true },
  pgcli: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: ['-d', '--dbname'], queryFlags: [], scriptFlags: [], dsnFlags: ['-D', '--dsn'], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-u', '--user', '-p', '--port', '--pgclirc', '--row-limit', '--prompt'], outFlags: [], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true, positionalDb: true },
  pg_dump: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: ['-d', '--dbname'], queryFlags: ['--schema', '-n', '-t', '--table'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '-F', '--format', '-f', '--file', '-j', '--jobs', '-Z', '--compress', '-N', '-T'], outFlags: ['-f', '--file'], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true, positionalDb: true },
  pg_dumpall: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: ['-l', '--database'], queryFlags: ['--roles-only', '-r', '--globals-only', '-g'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '-f', '--file'], outFlags: ['-f', '--file'], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true },
  pg_restore: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: ['-d', '--dbname'], queryFlags: ['-l', '--list'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '-F', '--format', '-f', '--file', '-j', '--jobs', '-n', '-t', '-N', '-T', '-L'], outFlags: ['-f', '--file'], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true },
  createdb: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '-O', '--owner', '-T', '--template', '-E', '--encoding', '-l', '--locale', '--maintenance-db'], outFlags: [], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true, positionalDb: true },
  dropdb: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '--maintenance-db'], outFlags: [], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true, positionalDb: true },
  vacuumdb: { kind: 'pg', serverFlags: ['-h', '--host'], dbFlags: ['-d', '--dbname'], queryFlags: ['-t', '--table'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-U', '--username', '-p', '--port', '-j', '--jobs', '--maintenance-db'], outFlags: [], envServer: ['PGHOST', 'PGSERVICE'], envDb: ['PGDATABASE'], defaultLocal: true, positionalDb: true },
  mysql: { kind: 'mysql', serverFlags: ['-h', '--host'], dbFlags: ['-D', '--database'], queryFlags: ['-e', '--execute'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: ['--login-path', '--defaults-file', '--defaults-extra-file', '--defaults-group-suffix'], valueFlags: ['-u', '--user', '-P', '--port', '-S', '--socket', '--protocol', '--ssl-mode', '--default-character-set', '--init-command', '--connect-timeout', '--max-allowed-packet', '--net-buffer-length', '--select-limit', '--max-join-size', '--pager', '--tee', '--prompt', '--delimiter', '--local-infile', '--bind-address'], outFlags: ['--tee'], envServer: ['MYSQL_HOST'], envDb: [], defaultLocal: true, positionalDb: true },
  mariadb: { kind: 'mysql', serverFlags: ['-h', '--host'], dbFlags: ['-D', '--database'], queryFlags: ['-e', '--execute'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: ['--login-path', '--defaults-file', '--defaults-extra-file'], valueFlags: ['-u', '--user', '-P', '--port', '-S', '--socket', '--protocol', '--ssl-mode', '--default-character-set', '--init-command', '--pager', '--tee', '--prompt', '--delimiter'], outFlags: ['--tee'], envServer: ['MYSQL_HOST'], envDb: [], defaultLocal: true, positionalDb: true },
  mysqldump: { kind: 'mysql', serverFlags: ['-h', '--host'], dbFlags: ['-B', '--databases'], queryFlags: ['--all-databases', '-A', '--tables'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: ['--login-path', '--defaults-file', '--defaults-extra-file'], valueFlags: ['-u', '--user', '-P', '--port', '-S', '--socket', '--protocol', '-r', '--result-file', '--where', '-w', '--ignore-table', '--tab', '-T', '--default-character-set', '--max-allowed-packet'], outFlags: ['-r', '--result-file', '--tab', '-T'], envServer: ['MYSQL_HOST'], envDb: [], defaultLocal: true, positionalDb: true },
  mysqladmin: { kind: 'mysql', serverFlags: ['-h', '--host'], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: ['--login-path', '--defaults-file', '--defaults-extra-file'], valueFlags: ['-u', '--user', '-P', '--port', '-S', '--socket', '--protocol', '-i', '--sleep', '-c', '--count'], outFlags: [], envServer: ['MYSQL_HOST'], envDb: [], defaultLocal: true },
  mycli: { kind: 'mysql', serverFlags: ['-h', '--host'], dbFlags: ['-D', '--database'], queryFlags: ['-e', '--execute'], scriptFlags: [], dsnFlags: ['--dsn'], connFlags: [], aliasFlags: ['--login-path', '--defaults-file'], valueFlags: ['-u', '--user', '-P', '--port', '-S', '--socket', '--myclirc', '--prompt', '--ssl-mode', '--charset'], outFlags: [], envServer: ['MYSQL_HOST'], envDb: [], defaultLocal: true, positionalDb: true },
  mongosh: { kind: 'mongo', serverFlags: ['--host'], dbFlags: [], queryFlags: ['--eval'], scriptFlags: ['-f', '--file'], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['--port', '-u', '--username', '-p', '--password', '--authenticationDatabase', '--authenticationMechanism', '--tlsCAFile', '--tlsCertificateKeyFile', '--apiVersion', '--retryWrites'], outFlags: [], envServer: [], envDb: [], defaultLocal: true, positionalDb: true },
  mongo: { kind: 'mongo', serverFlags: ['--host'], dbFlags: [], queryFlags: ['--eval'], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['--port', '-u', '--username', '-p', '--password', '--authenticationDatabase'], outFlags: [], envServer: [], envDb: [], defaultLocal: true, positionalDb: true },
  'redis-cli': { kind: 'redis', serverFlags: ['-h'], dbFlags: ['-n'], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['-u'], aliasFlags: [], valueFlags: ['-p', '-a', '--user', '--pass', '-s', '-r', '-i', '--cacert', '--cert', '--key', '-x', '-c', '--cluster'], outFlags: [], envServer: ['REDISCLI_HOST'], envDb: [], defaultLocal: true },
  prisma: { kind: 'migration', subcommands: /^(migrate|db|studio|introspect)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--url'], aliasFlags: [], valueFlags: ['--schema', '--name', '--config'], outFlags: [], envServer: ['DATABASE_URL'], envDb: [], defaultLocal: false },
  knex: { kind: 'migration', subcommands: /^(migrate:(latest|rollback|up|down|currentVersion|list|status|unlock)|seed:run)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--connection'], aliasFlags: ['--knexfile', '--env'], valueFlags: ['--cwd', '--client'], outFlags: [], envServer: ['DATABASE_URL', 'DB_HOST'], envDb: ['DB_NAME'], defaultLocal: false },
  sequelize: { kind: 'migration', subcommands: /^db:/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--url'], aliasFlags: ['--config', '--env'], valueFlags: ['--migrations-path', '--seeders-path', '--models-path'], outFlags: [], envServer: ['DATABASE_URL', 'DB_HOST'], envDb: ['DB_NAME'], defaultLocal: false },
  'sequelize-cli': { kind: 'migration', subcommands: /^db:/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--url'], aliasFlags: ['--config', '--env'], valueFlags: [], outFlags: [], envServer: ['DATABASE_URL', 'DB_HOST'], envDb: ['DB_NAME'], defaultLocal: false },
  typeorm: { kind: 'migration', subcommands: /^(migration:(run|revert)|schema:(sync|drop)|query)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: ['-d', '--dataSource', '-c', '--connection'], valueFlags: [], outFlags: [], envServer: ['DATABASE_URL', 'DB_HOST', 'TYPEORM_HOST', 'TYPEORM_URL'], envDb: ['TYPEORM_DATABASE'], defaultLocal: false },
  flyway: { kind: 'migration', subcommands: /^(migrate|clean|repair|undo|baseline|validate|info)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['-url'], aliasFlags: ['-configFiles'], valueFlags: ['-user', '-password', '-schemas', '-locations'], outFlags: [], envServer: ['FLYWAY_URL'], envDb: [], defaultLocal: false },
  liquibase: { kind: 'migration', subcommands: /^(update|updateSQL|rollback|rollbackCount|drop-all|dropAll|changelog-sync|changelogSync|tag|status|validate|diff|generate-changelog)$/i, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--url'], aliasFlags: ['--defaultsFile', '--defaults-file'], valueFlags: ['--username', '--password', '--changelog-file', '--changeLogFile'], outFlags: [], envServer: ['LIQUIBASE_COMMAND_URL'], envDb: [], defaultLocal: false },
  alembic: { kind: 'migration', subcommands: /^(upgrade|downgrade|stamp|current|revision|merge)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['-x'], aliasFlags: ['-c', '--config', '-n', '--name'], valueFlags: [], outFlags: [], envServer: ['DATABASE_URL', 'SQLALCHEMY_DATABASE_URI', 'ALEMBIC_URL'], envDb: [], defaultLocal: false },
  dbmate: { kind: 'migration', subcommands: /^(up|down|migrate|rollback|drop|create|dump|load|status|wait)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['-u', '--url'], aliasFlags: ['-e', '--env', '--env-file'], valueFlags: ['-d', '--migrations-dir', '-s', '--schema-file'], outFlags: [], envServer: ['DATABASE_URL'], envDb: [], defaultLocal: false },
  goose: { kind: 'migration', subcommands: /^(up|up-by-one|up-to|down|down-to|redo|reset|status|version|fix)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: [], aliasFlags: [], valueFlags: ['-dir', '-table'], outFlags: [], envServer: ['GOOSE_DBSTRING', 'DATABASE_URL'], envDb: [], defaultLocal: false },
  migrate: { kind: 'migration', subcommands: /^(up|down|drop|force|goto|version)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['-database', '--database'], aliasFlags: [], valueFlags: ['-path', '--path', '-source', '--source'], outFlags: [], envServer: ['DATABASE_URL'], envDb: [], defaultLocal: false },
  sqitch: { kind: 'migration', subcommands: /^(deploy|revert|verify|rebase|checkout|status|log)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--target', '-t'], aliasFlags: [], valueFlags: [], outFlags: [], envServer: ['SQITCH_TARGET'], envDb: [], defaultLocal: false },
  'dotnet-ef': { kind: 'migration', subcommands: /^(database|migrations)$/, serverFlags: [], dbFlags: [], queryFlags: [], scriptFlags: [], dsnFlags: [], connFlags: ['--connection'], aliasFlags: [], valueFlags: ['--project', '--startup-project', '--context', '--configuration', '--framework', '--runtime'], outFlags: [], envServer: ['ConnectionStrings__DefaultConnection', 'DATABASE_URL'], envDb: [], defaultLocal: false },
};

/** PowerShell cmdlet families treated as DB clients by name pattern. */
export const DB_CMDLET_RE = /^(invoke-sqlcmd2?|[a-z]+-dba[a-z]+|invoke-sqlquery|new-sqlconnection)$/i;

/** Module / package names whose import makes a one-liner a DB command. */
export const DB_MODULES_JS = new Set(['mssql', 'tedious', 'msnodesqlv8', 'pg', 'pg-promise', 'postgres', 'pg-native', 'mysql', 'mysql2', 'mariadb', 'oracledb', 'knex', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'mongodb', 'mongoose', 'ioredis', 'redis', 'odbc', 'drizzle-orm', 'kysely', 'slonik', 'better-sqlite3', 'mikro-orm', '@mikro-orm/core', 'objection', 'bookshelf', 'node-sql-server', 'tds']);
export const DB_MODULES_PY = new Set(['pyodbc', 'pymssql', 'psycopg', 'psycopg2', 'asyncpg', 'pymysql', 'mysql.connector', 'mysql', 'MySQLdb', 'sqlalchemy', 'pymongo', 'motor', 'redis', 'aioodbc', 'turbodbc', 'cx_Oracle', 'oracledb', 'databases', 'peewee', 'django.db', 'pony', 'tortoise', 'aiomysql', 'aiopg', 'pypyodbc', 'ctds', '_mssql']);
export const DB_KEYWORDS_PS = /\b(SqlConnection|SqlClient|SqlCommand|SqlDataAdapter|Npgsql|MySqlConnection|MySql\.Data|OracleConnection|OdbcConnection|OleDbConnection|SqlBulkCopy)\b/;

/** Any command text mentioning one of these is a DB command even when the parse is opaque. */
export const DB_KEYWORD_RE = /\b(sqlcmd|osql|bcp|invoke-sqlcmd|invoke-dbaquery|mssql-cli|sqlpackage|tsql|bsqldb|fisql|psql|pg_dump|pg_restore|pg_dumpall|pgcli|mysql|mysqldump|mysqladmin|mycli|mariadb|mongosh|redis-cli|sqlconnection|sqlclient|npgsql|pyodbc|pymssql|psycopg2?|tedious|msnodesqlv8|SQLCMDSERVER|DATABASE_URL|Initial Catalog|Data Source|jdbc:|mssql:\/\/|sqlserver:\/\/|postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/)\b/i;

/** Env var names that carry a DB target (checked on assignments in the command). */
export const DB_ENV_NAME_RE = /^(SQLCMD(SERVER|DBNAME|USER|PASSWORD|INI)|SQLCMD_CONNECTION_STRING|.*CONNECTION.*|.*CONN_?STR.*|DB_CONN|SQL_CONN.*|DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|DB_DSN|MSSQL_(HOST|SERVER|SERVERNAME|INSTANCE|DB|DATABASE|URL|URI|DSN|CONN\w*)|SQLSERVER_(HOST|SERVER|DB|DATABASE|URL|URI|CONN\w*)|PG(HOST|HOSTADDR|PORT|DATABASE|SERVICE|SERVICEFILE|USER|PASSWORD|PASSFILE|OPTIONS)|MYSQL_(HOST|TCP_PORT|UNIX_PORT|PWD|DATABASE)|MONGO(DB)?_(URI|URL|HOST)|REDIS_(URL|HOST)|REDISCLI_(HOST|URL)|TDSHOST|TYPEORM_(HOST|URL|DATABASE|CONNECTION)|SQLALCHEMY_DATABASE_URI|FLYWAY_URL|GOOSE_DBSTRING|LIQUIBASE_COMMAND_URL|ALEMBIC_URL|SQITCH_TARGET|DB_(HOST|SERVER|NAME|PORT|USER|PASSWORD|PASS|DATABASE))$/i;

/** Env names that hold credentials or tuning, never a server: their values are not targets. */
export const DB_CREDENTIAL_ENV_RE = /(PASS(WORD)?|PASSWD|PWD|SECRET|TOKEN|AUTH|USER(NAME)?|UID|KEY|CERT|OPTIONS|PASSFILE|EULA|PID|PORT|COLLATION|AGENT_ENABLED|MEMORY_LIMIT_MB|LCID)$/i;

/** Local-server spellings that all mean "this machine" (or "this container"). */
export const DB_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '.', '(local)', 'local', '0.0.0.0', 'host.docker.internal', '(localdb)\\mssqllocaldb', 'localhost.localdomain']);

/** Docker images that run a database server. */
export const DB_IMAGE_RE = /(mssql|sql-?server|azure-sql-edge|postgres|postgis|timescale|mysql|mariadb|percona|mongo|redis|valkey|cockroach|yugabyte|oracle|db2|clickhouse|cassandra|scylla|elasticsearch|opensearch|neo4j|couch|mariadb|edgedb|surrealdb|influxdb|questdb|dynamodb-local)/i;
/** Images that only carry a client (sqlcmd, psql) and run no server. */
export const DB_CLIENT_IMAGE_RE = /(tools|cli|client|sqlcmd|psql|migrat|flyway|liquibase|sqlpackage)/i;

// ---------------------------------------------------------------------------
// Self-protection (harness state and agent configuration)
// ---------------------------------------------------------------------------

/** Programs that write to their path arguments (dest = all non-flag args unless noted). */
export const WRITE_ALL_ARGS_PROGS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'del', 'erase', 'rd', 'remove-item', 'ri', 'rmdir', 'mkdir', 'md', 'new-item', 'ni', 'touch', 'chmod', 'chown', 'chgrp', 'chattr', 'attrib', 'icacls', 'takeown', 'setfacl', 'ln', 'link', 'mklink', 'tee', 'install', 'patch', 'ed', 'ex', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'pico', 'xattr', 'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'out-file', 'export-csv', 'export-clixml', 'set-itemproperty', 'sp', 'remove-itemproperty', 'rp', 'new-itemproperty', 'clear-item', 'cli', 'rename-item', 'rni', 'ren', 'rename', 'move-item', 'mi', 'move', 'mv', 'copy-item', 'ci', 'cpi', 'copy', 'cp', 'rsync', 'scp', 'robocopy', 'xcopy', 'dd', 'split', 'csplit', 'gzip', 'gunzip', 'bzip2', 'xz', 'zstd', 'unzip', 'tar', 'zip', '7z', '7za', 'expand-archive', 'compress-archive', 'curl', 'wget', 'git', 'sed', 'perl', 'ruby', 'python', 'python3', 'node', 'sqlite3', 'crontab', 'ssh-keygen', 'gpg', 'openssl', 'certutil', 'reg', 'setx', 'cat', 'echo', 'printf', 'head', 'tail', 'sort', 'awk', 'cut', 'tr', 'jq', 'yq', 'envsubst',
]);
// The guard decides per program which arguments are destinations; the set above only
// says "look at this program". Readers (cat/echo/...) matter only through redirects.

/** Programs whose path arguments are destroyed/moved: ancestors of a protected root also deny. */
export const DESTRUCTIVE_PROGS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'mi', 'rename', 'ren', 'rename-item', 'rni', 'chmod', 'chown', 'chgrp', 'chattr', 'attrib', 'icacls', 'takeown', 'setfacl', 'truncate', 'robocopy', 'rsync']);

/** Options (per program) whose value is a written path. */
export const WRITE_VALUE_OPTS: Record<string, string[]> = {
  curl: ['-o', '--output', '--output-dir', '-D', '--dump-header', '--trace', '--trace-ascii', '--cookie-jar', '-c', '--etag-save', '--stderr', '--libcurl', '--create-dirs'],
  wget: ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output', '--save-cookies', '--warc-file'],
  tar: ['-C', '--directory', '-f', '--file', '--one-top-level'],
  unzip: ['-d'],
  '7z': ['-o'],
  '7za': ['-o'],
  zip: [],
  patch: ['-d', '--directory', '-o', '--output', '-i'],
  sed: ['-i'],
  tee: ['-a'],
  install: ['-t', '--target-directory', '-D'],
  cp: ['-t', '--target-directory'],
  mv: ['-t', '--target-directory'],
  ln: ['-t', '--target-directory'],
  rsync: ['--log-file', '--temp-dir', '-T', '--partial-dir', '--backup-dir'],
  git: ['-C', '--git-dir', '--work-tree', '--directory', '--separate-git-dir', '--template', '-f', '--file', '--output', '-o'],
  node: ['--report-dir', '--report-directory', '--diagnostic-dir', '--redirect-warnings', '--test-reporter-destination', '--cpu-prof-dir', '--heap-prof-dir', '--tls-keylog'],
  python: ['-m'],
  python3: ['-m'],
  'set-content': ['-Path', '-LiteralPath', '-FilePath'],
  'add-content': ['-Path', '-LiteralPath', '-FilePath'],
  'clear-content': ['-Path', '-LiteralPath'],
  'out-file': ['-FilePath', '-Path', '-LiteralPath'],
  'new-item': ['-Path', '-LiteralPath', '-Name', '-Target', '-Value'],
  'remove-item': ['-Path', '-LiteralPath', '-Include'],
  'copy-item': ['-Destination', '-Path', '-LiteralPath'],
  'move-item': ['-Destination', '-Path', '-LiteralPath'],
  'rename-item': ['-Path', '-LiteralPath', '-NewName'],
  'set-itemproperty': ['-Path', '-LiteralPath'],
  'remove-itemproperty': ['-Path', '-LiteralPath'],
  'new-itemproperty': ['-Path', '-LiteralPath'],
  'export-csv': ['-Path', '-LiteralPath'],
  'export-clixml': ['-Path', '-LiteralPath'],
  'expand-archive': ['-DestinationPath'],
  'compress-archive': ['-DestinationPath'],
  'invoke-webrequest': ['-OutFile'],
  'invoke-restmethod': ['-OutFile'],
  iwr: ['-OutFile'],
  irm: ['-OutFile'],
  dd: ['of='],
  sqlcmd: ['-o', '--output-file'],
  psql: ['-o', '--output', '-L', '--log-file'],
  mysql: ['--tee'],
  pip: ['-t', '--target', '--prefix', '--root', '-r', '--log'],
  pip3: ['-t', '--target', '--prefix', '--root', '--log'],
  npm: ['--prefix', '--cache', '--userconfig', '--globalconfig'],
  pnpm: ['--dir', '-C', '--store-dir'],
  yarn: ['--cwd', '--cache-folder'],
  code: ['--user-data-dir', '--extensions-dir'],
  cargo: ['--target-dir', '--root'],
  go: ['-o'],
  dotnet: ['-o', '--output'],
  make: ['-C', '--directory'],
  cmake: ['-B', '--build', '--install-prefix'],
  rustup: ['--prefix'],
  openssl: ['-out', '-keyout'],
  'ssh-keygen': ['-f'],
  gpg: ['-o', '--output', '--homedir'],
  certutil: ['-decode', '-encode'],
};

/** Readers whose output is harmless unless redirected (so an arg inside a protected root does not deny). */
export const READ_ONLY_PROGS = new Set(['cat', 'echo', 'printf', 'head', 'tail', 'sort', 'awk', 'cut', 'tr', 'jq', 'yq', 'envsubst', 'less', 'more', 'bat', 'grep', 'rg', 'egrep', 'fgrep', 'ag', 'wc', 'ls', 'stat', 'file', 'find', 'tree', 'du', 'df', 'diff', 'cmp', 'md5sum', 'sha256sum', 'shasum', 'strings', 'xxd', 'hexdump', 'od', 'get-content', 'gc', 'type', 'get-item', 'get-childitem', 'gci', 'dir', 'test-path', 'select-string', 'sls', 'get-itemproperty', 'gp', 'measure-object', 'compare-object', 'node', 'python', 'python3', 'harness', 'sqlite3', 'git', 'ssh-keygen', 'gpg', 'openssl', 'certutil', 'crontab', 'reg', 'setx', 'perl', 'ruby']);

/** Fragments that make an unresolvable (dynamic) path token look like a protected target. */
export const PROTECTED_SHAPE_RE = /(\.claude(\.json)?|\.codex|\.harness|\.devin|\.agents|[\\/]devin[\\/]|settings(\.local)?\.json|hooks\.json|config\.toml|rules[\\/].*\.rules|integrity\.json|manifest\.json|hook\.js|managed-settings|\.config[\\/]devin)/i;

/** Code patterns that mean "writes a file" in node/python/perl/ruby/PowerShell one-liners. */
export const CODE_WRITE_RE = /(?:\b|(?=\[))(writeFile(Sync)?|appendFile(Sync)?|createWriteStream|rm(Sync)?\s*\(|rmdir(Sync)?|unlink(Sync)?|rename(Sync)?|mkdir(Sync)?|truncate(Sync)?|chmod(Sync)?|chown(Sync)?|copyFile(Sync)?|cp(Sync)?\s*\(|symlink(Sync)?|outputFile|writeJson|open\s*\((?:[^()]|\([^()]*\))*,\s*['"](w|a|x|r\+|wb|ab|w\+|a\+|wt|at)['"]|open\s*\([^)]*,\s*['"]\s*>>?|open\s*\([A-Za-z_$]+\s*,\s*['"]\s*[>+]|os\.(remove|unlink|rename|replace|rmdir|removedirs|makedirs|mkdir|chmod|chown|truncate|symlink|link)|shutil\.(rmtree|move|copy\w*)|write_text|write_bytes|\.unlink\(|\.rmdir\(|\.touch\(|\.rename\(|\.replace\(|\.write\(|Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Export-Csv|Export-Clixml|\[(System\.)?IO\.(File|Directory)\]::(Write|Append|Delete|Move|Copy|Create|Replace|Open|SetAttributes)|File\.(write|open|delete|unlink|rename|copy)|FileUtils\.|Dir\.(mkdir|rmdir|delete)|IO\.write|\bunlink\b|\brmtree\b|fwrite|file_put_contents|\bsc\s|\bni\s|\bri\s|\bdel\s|\brm\s)/i;

// ---------------------------------------------------------------------------
// Nested agent bypass
// ---------------------------------------------------------------------------

export const NESTED_AGENTS = new Set(['claude', 'codex', 'devin', 'claude-code']);

export const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--dangerously-disable-sandbox',
  '--yolo',
  '--ignore-user-config',
  '--ignore-rules',
  '--settings',
  '--bare',
  '--setting-sources',
  '--bypass',
  '--no-hooks',
  '--disable-hooks',
  '--skip-hooks',
  '--no-sandbox',
  '--full-access',
  '--allow-all',
]);

/** Flag prefixes (the `--flag=value` spelling and every `--dangerously-*`). */
export const BYPASS_FLAG_PREFIXES = ['--dangerously-', '--settings=', '--setting-sources=', '--permission-mode=bypass', '--sandbox=danger', '--mode=bypass', '-s=danger'];

/** `--flag value` pairs that bypass. */
export const BYPASS_VALUE_PAIRS: Array<{ flag: string; valueRe: RegExp }> = [
  { flag: '--permission-mode', valueRe: /^bypass/i },
  { flag: '--sandbox', valueRe: /^danger/i },
  { flag: '-s', valueRe: /^danger/i },
  { flag: '--mode', valueRe: /^bypass/i },
  { flag: '-c', valueRe: /^(sandbox_mode\s*=\s*["']?danger|approval_policy\s*=\s*["']?never.*danger|sandbox\s*=\s*["']?danger|hooks|disable_?all_?hooks|disableAllHooks)/i },
  { flag: '--config', valueRe: /^(sandbox_mode\s*=\s*["']?danger|sandbox\s*=\s*["']?danger|hooks|disable_?all_?hooks|disableAllHooks)/i },
];

/** Env assignments on a nested agent run that would change its guard behaviour. */
export const BYPASS_ENV_RE = /(HOOK|PERMISSION|BYPASS|SANDBOX|APPROVAL|SETTINGS|DISABLE|RESTRICT|TRUST)/i;

/** Nested agent subcommands that edit the agent's own configuration. */
export const AGENT_CONFIG_SUBS: Array<{ agent: string; re: RegExp }> = [
  { agent: 'claude', re: /^(config|plugin|mcp)$/ },
  { agent: 'codex', re: /^(mcp)$/ },
  { agent: 'devin', re: /^(config|plugins?|mcp)$/ },
];
export const AGENT_CONFIG_READ_SUBS = new Set(['list', 'get', 'ls', 'show']);

// ---------------------------------------------------------------------------
// Harness-shaped in-tree paths (team setting)
// ---------------------------------------------------------------------------

export const HARNESS_SHAPED_FILE_RE = /(^|[\\/])(AGENTS?(\.[^\\/]+)?\.md|CLAUDE(\.[^\\/]+)?\.md|GEMINI\.md|\.windsurfrules|\.cursorrules|\.clinerules|\.mcp\.json|copilot-instructions\.md)$/i;
export const HARNESS_SHAPED_DIR_RE = /(^|[\\/])(\.claude|\.codex|\.devin|\.agents|\.harness|\.cursor|\.windsurf|\.codeium|\.gemini|\.aider[^\\/]*)([\\/]|$)/i;
export const WORKFLOW_RE = /(^|[\\/])\.github[\\/]workflows[\\/][^\\/]+$/i;

/** Globs the renderer emits for harness-shaped paths. */
export const HARNESS_SHAPED_GLOBS = ['AGENTS.md', 'AGENTS.*.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.*.md', '.claude/**', '.codex/**', '.devin/**', '.agents/**', '.harness/**', '.github/workflows/**', '.mcp.json'];

// ---------------------------------------------------------------------------
// Test and golden files (write phase)
// ---------------------------------------------------------------------------

export const TEST_PATH_RES: RegExp[] = [
  /(^|[\\/])(test|tests|__tests__|__snapshots__|__fixtures__|__mocks__|golden|testdata|spec|specs|cypress|e2e|integration-tests?|acceptance-tests?)([\\/]|$)/i,
  /\.(test|spec|e2e|e2e-spec|integration|int|snap|golden|stories\.snap)\.[^\\/]+$/i,
  /\.(snap|golden)$/i,
  /(^|[\\/])test_[^\\/]+\.py$/i,
  /_(test|spec)\.(py|go|rb|rs|ex|exs|php|java|kt|scala|cs|swift)$/i,
  /(^|[\\/])(conftest\.py|pytest\.ini|\.coveragerc|codecov\.ya?ml|\.nycrc(\.[^\\/]+)?|jest\.setup\.[^\\/]+|setupTests\.[^\\/]+)$/i,
  /(^|[\\/])(jest|vitest|vitest\.workspace|playwright|cypress|karma\.conf|mocha|ava|jasmine|web-test-runner|wdio)\.config\.[^\\/]+$/i,
  /(^|[\\/])\.mocharc(\.[^\\/]+)?$/i,
  /Tests?\.(cs|java|kt|swift|m)$/,
];

/** Globs the renderer emits for the test-phase rule. */
export const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__snapshots__/**', '**/*.snap', 'test/**', 'tests/**', '**/__fixtures__/**', '**/golden/**'];

export const ENV_SECRET_NAMES = ['.env', '.env.local', '.env.*.local', '.env.development', '.env.production', '.env.staging', '.env.test', '.env.dev', '.env.prod', '.env.ci', '.env.qa', '.env.uat', '.env.stage', '.env.sandbox', '.env.preview', '.env.e2e', '.env.integration', '.env.docker', '.env.prd', '.env.preprod', '.env.secrets', '.env.secret', '.env.backup', '.env.bak', '.env.old', '.env.encrypted', '.env.vault', '.env.*.bak', '.env.*.backup'];

/**
 * Secret-file globs the renderer emits. Env files are listed by their concrete secret spellings, never as
 * `.env.*`: that glob would also deny `.env.example`, `.env.sample` and the other templates (SECRET_EXAMPLE_RE),
 * which hold no secrets and which the agent is told to read instead. The guard's own check (`isSecretPath`) keeps
 * the `.env` prefix test with the template exemption, so a spelling not listed here is still stopped by the hook.
 */
export const SECRET_GLOBS = [...ENV_SECRET_NAMES, ...ENV_SECRET_NAMES.map((n) => `**/${n}`), '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.kdbx', '**/id_rsa', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials', '**/credentials.json', '**/secrets.json', '**/secrets.yml', '**/secrets.yaml', '**/secret.json', '**/.git-credentials', '**/auth.json'];

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const COMMAND_TOOL_RE = /^(bash|exec|shell|run_command|run_terminal_cmd|execute_command|terminal|shell_command|run_shell_command|powershell|cmd|execute|command|run)$/i;
export const WRITE_TOOL_RE = /^(edit|write|multiedit|notebookedit|apply_patch|create_file|write_file|write_to_file|replace|replace_file_content|multi_replace|str_replace_editor|str_replace_based_edit_tool|insert|delete_file|create|save|move_file|rename_file|edit_file|propose_code|codebase_edit|fast_apply|edit_notebook|notebook_edit)$/i;
export const READ_TOOL_RE = /^(read|view|view_file|read_file|cat|grep|search_file|file_search|read_url_content|view_code_item|open_file|get_file_contents|read_many_files|notebook_read|notebookread)$/i;
export const MCP_TOOL_RE = /^mcp__([^_].*?)__(.+)$/;
