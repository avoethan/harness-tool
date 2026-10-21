/**
 * Per-agent permission rules rendered from rails.ts. These are the cheap
 * first layer (spelling-bound); the PreToolUse guard is the real rail.
 *
 * Dialects:
 *   Claude Code  permissions.deny / allow: `Bash(git push --force *)`,
 *                `Edit(//abs/path/**)`, `Read(**\/.env)` (absolute paths start with //).
 *   Devin        config.json permissions: `Exec(git push --force)` (prefix, complete words),
 *                `Write(/abs/path/**)`, `Read(glob)`; deny / ask / allow lists.
 *   Codex        .rules lines: prefix_rule(pattern=["git","push","--force"], decision="forbidden").
 */
import type { Setting } from '../types';
import { GIT_DENY, HARNESS_SHAPED_GLOBS, RAILS, SECRET_GLOBS, TEST_GLOBS, type RailId } from './rails';

export interface AgentRules {
  claude: { deny: string[]; allow: string[] };
  devin: { deny: string[]; ask: string[]; allow: string[] };
  codex: { rules: string[] };
}

export interface PermissionOptions {
  setting: Setting;
  /** Absolute roots to protect (harness home, agent homes, package root, ~/.claude.json). */
  protectedRoots: string[];
  /** Exact verification commands to allow (argv prefixes), e.g. [['npm','test'], ['harness','gate']]. */
  verificationAllow?: string[][];
  /** Absolute path of the runs directory the agent may read. */
  runsDir?: string;
  /** Absolute path of the inbox folder the agent may read and write (pasted tickets for intake). */
  inboxDir?: string;
  /** Whether the test-phase rule should be rendered as a permission (default false: phases are dynamic, the hook handles them). */
  renderTestPhase?: boolean;
}

export type RulesByRail = Record<RailId, { claude: string[]; devin: string[]; codex: string[] }>;

const NON_GIT_PREFIXES: Partial<Record<RailId, string[][]>> = {
  'team-gh': [
    ['gh', 'pr', 'create'], ['gh', 'pr', 'merge'], ['gh', 'pr', 'close'], ['gh', 'pr', 'edit'], ['gh', 'pr', 'review'], ['gh', 'pr', 'comment'], ['gh', 'pr', 'ready'],
    ['gh', 'issue', 'create'], ['gh', 'issue', 'comment'], ['gh', 'issue', 'edit'], ['gh', 'issue', 'close'], ['gh', 'issue', 'delete'],
    ['gh', 'release', 'create'], ['gh', 'release', 'delete'], ['gh', 'release', 'upload'],
    ['gh', 'repo', 'create'], ['gh', 'repo', 'delete'], ['gh', 'repo', 'fork'], ['gh', 'repo', 'edit'], ['gh', 'repo', 'archive'],
    ['gh', 'api', '-X'], ['gh', 'api', '--method'], ['gh', 'api', '-f'], ['gh', 'api', '-F'], ['gh', 'api', '--input'],
    ['gh', 'auth', 'token'],
    ['glab', 'mr', 'create'], ['glab', 'mr', 'merge'], ['glab', 'issue', 'create'],
  ],
  'nested-agent': [
    ['claude', '--dangerously-skip-permissions'], ['claude', '--permission-mode', 'bypassPermissions'], ['claude', '--settings'], ['claude', '--bare'], ['claude', '--setting-sources'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'], ['codex', '--yolo'], ['codex', '--dangerously-bypass-hook-trust'], ['codex', '--ignore-user-config'], ['codex', '--ignore-rules'], ['codex', '--sandbox', 'danger-full-access'],
    ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox'], ['codex', 'exec', '--yolo'], ['codex', 'exec', '--sandbox', 'danger-full-access'],
    ['devin', '--mode', 'bypass'],
  ],
  db: [
    ['sqlcmd'], ['osql'], ['bcp'], ['mssql-cli'], ['sqlpackage'], ['psql'], ['mysql'], ['mongosh'], ['redis-cli'],
  ],
  mcp: [],
  secrets: [
    ['cat', '.env'], ['type', '.env'], ['Get-Content', '.env'], ['git', 'add', '.env'], ['git', 'add', '-f'], ['git', 'add', '--force'],
  ],
  protect: [
    ['claude', 'config'], ['claude', 'plugin', 'install'], ['claude', 'mcp', 'add'],
  ],
  'harness-admin': [
    ['harness', 'install'],
    ['harness', 'apply'],
    ['harness', 'undo'],
    ['harness', 'uninstall'],
    ['harness', 'self-update'],
    ['harness', 'pr'],
    ['harness', 'jira'],
    ['harness', 'config', 'set'],
    ['harness', 'db', 'mark'],
    ['harness', 'db', 'unmark'],
    ['harness', 'learn', 'review'],
    ['harness', 'selfcheck', 'probe-files'],
    ['harness', 'selfcheck', 'record'],
    ['harness', 'selfcheck', 'probe-mode'],
    ['harness', 'selfcheck', 'probe-hook'],
    ['harness', 'selfcheck', 'probe-log', '--clear'],
  ],
  opaque: [],
  internal: [],
  staging: [],
};

function claudeBash(prefix: string[]): string[] {
  const p = prefix.join(' ');
  return [`Bash(${p})`, `Bash(${p} *)`];
}

function devinExec(prefix: string[]): string {
  return `Exec(${prefix.join(' ')})`;
}

/**
 * One word of an allow-rule command as an agent types it: a path (it holds a
 * slash, a backslash or a space) in double quotes, as the CLI note prints
 * `node "<path>"`. Probe 2026-10-19 (Claude Code 2.1.303, haiku): the quoted
 * rule allowed `node "<path>" version`; the unquoted rule did not.
 */
export function typedWord(w: string): string {
  return /[\s\\/]/.test(w) ? `"${w.replace(/\\/g, '/')}"` : w;
}

function codexRule(prefix: string[], justification: string): string {
  const pat = prefix.map((w) => JSON.stringify(w)).join(', ');
  return `prefix_rule(pattern=[${pat}], decision="forbidden", justification=${JSON.stringify(justification)})`;
}

/** Claude path rule: absolute paths get the documented `//` prefix; relative globs stay as written. */
function claudePath(p: string): string {
  const s = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('/')) return '//' + s.replace(/^\/+/, '');
  return s;
}

function devinPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function buildPermissionsByRail(opts: PermissionOptions): RulesByRail {
  const out = {} as RulesByRail;
  for (const r of RAILS) out[r.id] = { claude: [], devin: [], codex: [] };
  for (const id of ['opaque', 'internal'] as RailId[]) out[id] = { claude: [], devin: [], codex: [] };
  const applies = (settings: Setting[] | 'all') => settings === 'all' || settings.includes(opts.setting);

  // git rails from GIT_DENY
  for (const spec of GIT_DENY) {
    if (!applies(spec.settings)) continue;
    const bucket = out[spec.rail];
    for (const prefix of spec.prefixes) {
      bucket.claude.push(...claudeBash(prefix));
      bucket.devin.push(devinExec(prefix));
      bucket.codex.push(codexRule(prefix, spec.reason));
    }
  }
  // config keys (spelling-bound prefixes)
  const hooksBypass = out['git-hooks-bypass'];
  for (const prefix of [['git', 'config', 'core.hooksPath'], ['git', 'config', '--global', 'core.hooksPath'], ['git', 'config', '--local', 'core.hooksPath'], ['git', 'config', 'alias.'], ['git', 'config', '--global', 'alias.'], ['git', 'config', '--edit'], ['git', 'config', '-e']]) {
    hooksBypass.claude.push(`Bash(${prefix.join(' ')}*)`);
    hooksBypass.devin.push(devinExec(prefix));
    hooksBypass.codex.push(codexRule(prefix, 'git hooks and aliases are managed by the harness'));
  }
  if (opts.setting === 'team') {
    const remote = out['team-remote'];
    for (const prefix of [['git', 'config', 'remote.'], ['git', 'config', '--global', 'url.']]) {
      remote.claude.push(`Bash(${prefix.join(' ')}*)`);
      remote.devin.push(devinExec(prefix));
      remote.codex.push(codexRule(prefix, 'remotes and push URLs are not changed in the team setting'));
    }
  }
  // non-git prefix rails
  for (const [id, prefixes] of Object.entries(NON_GIT_PREFIXES) as Array<[RailId, string[][]]>) {
    const rail = RAILS.find((r) => r.id === id);
    if (rail && !applies(rail.settings)) continue;
    const bucket = out[id];
    for (const prefix of prefixes) {
      bucket.claude.push(...claudeBash(prefix));
      bucket.devin.push(devinExec(prefix));
      bucket.codex.push(codexRule(prefix, rail?.summary ?? id));
    }
  }
  // db: every client needs the hook; the permission layer makes them ask on Devin (allow rules come from verification commands)
  // secrets: path rules
  const secrets = out.secrets;
  for (const g of SECRET_GLOBS) {
    secrets.claude.push(`Read(${claudePath(g)})`, `Edit(${claudePath(g)})`, `Write(${claudePath(g)})`);
    secrets.devin.push(`Read(${devinPath(g)})`, `Write(${devinPath(g)})`);
  }
  secrets.codex.push(codexRule(['cat', '.env'], 'secret files are never read into the transcript'));
  // protect: absolute path rules
  const protect = out.protect;
  for (const root of opts.protectedRoots) {
    const isFile = /\.[A-Za-z0-9]+$/.test(root) && !/[\\/]$/.test(root) && /\.json$/.test(root);
    const glob = isFile ? root : root.replace(/[\\/]+$/, '') + '/**';
    protect.claude.push(`Edit(${claudePath(glob)})`, `Write(${claudePath(glob)})`, `MultiEdit(${claudePath(glob)})`, `NotebookEdit(${claudePath(glob)})`);
    protect.devin.push(`Write(${devinPath(glob)})`);
    const n = root.replace(/\\/g, '/');
    protect.claude.push(`Bash(rm -rf ${n}*)`, `Bash(rm -r ${n}*)`);
    protect.devin.push(devinExec(['rm', '-rf', n]), devinExec(['rm', '-r', n]));
    protect.codex.push(codexRule(['rm', '-rf', n], 'harness state and agent configuration are protected'), codexRule(['rm', '-r', n], 'harness state and agent configuration are protected'));
  }
  // mcp: deny every MCP tool by default (the hook allows listed servers by matching the full name)
  const mcp = out.mcp;
  mcp.claude.push('mcp__*');
  mcp.devin.push('mcp__*');
  mcp.codex.push(codexRule(['mcp__'], 'MCP servers must be allowlisted with their targets'));
  // team-shaped
  if (opts.setting === 'team') {
    const shaped = out['team-shaped'];
    for (const g of HARNESS_SHAPED_GLOBS) {
      shaped.claude.push(`Edit(${g})`, `Write(${g})`);
      shaped.devin.push(`Write(${g})`);
    }
    for (const prefix of [['git', 'add', 'AGENTS.md'], ['git', 'add', 'CLAUDE.md'], ['git', 'add', '.claude'], ['git', 'add', '.codex'], ['git', 'add', '.devin'], ['git', 'add', '.agents'], ['git', 'add', '.harness'], ['git', 'add', '.github/workflows']]) {
      shaped.claude.push(`Bash(${prefix.join(' ')}*)`);
      shaped.devin.push(devinExec(prefix));
      shaped.codex.push(codexRule(prefix, 'nothing of the harness goes into a team repository'));
    }
  }
  // phase-tests: rendered only on request (the hook knows the phase; a static deny would block the tests phase)
  const phase = out['phase-tests'];
  if (opts.renderTestPhase) {
    for (const g of TEST_GLOBS) {
      phase.claude.push(`Edit(${g})`, `Write(${g})`);
      phase.devin.push(`Write(${g})`);
    }
  }
  phase.codex.push(codexRule(['harness', 'phase'], 'phase changes are logged; the hook enforces the test-file rule'));
  phase.claude.push('Bash(harness phase *)');
  phase.devin.push(devinExec(['harness', 'phase']));
  // staging: the hook does the work; permissions can only name the obvious spellings
  const staging = out.staging;
  for (const prefix of [['git', 'commit', '-a'], ['git', 'commit', '--all'], ['git', 'commit', '-am'], ['git', 'add', '-A'], ['git', 'add', '--all'], ['git', 'add', '.']]) {
    staging.claude.push(`Bash(${prefix.join(' ')}*)`);
    staging.devin.push(devinExec(prefix));
    staging.codex.push(codexRule(prefix, 'staging is checked by the harness hook'));
  }
  // db: on Devin an ask rule for each client keeps a human in the loop; the hook still decides
  const db = out.db;
  db.claude.push('Bash(sqlcmd -D *)', 'Bash(sqlcmd -i *)', 'Bash(psql -f *)', 'Bash(mysql --login-path*)');
  db.devin.push(devinExec(['sqlcmd', '-D']), devinExec(['sqlcmd', '-i']), devinExec(['psql', '-f']));
  db.codex.push(codexRule(['sqlcmd', '-D'], 'DSNs cannot be checked against the test allowlist'), codexRule(['sqlcmd', '-i'], 'script files cannot be checked against the test allowlist'));
  return out;
}

/** Flat per-agent lists for the renderer. */
export function buildPermissions(opts: PermissionOptions): AgentRules {
  const by = buildPermissionsByRail(opts);
  const claudeDeny = new Set<string>();
  const devinDeny = new Set<string>();
  const devinAsk = new Set<string>();
  const codexRules = new Set<string>();
  for (const [id, r] of Object.entries(by) as Array<[RailId, RulesByRail[RailId]]>) {
    const askOnDevin = id === 'db' || id === 'staging' || id === 'phase-tests';
    for (const x of r.claude) if (!(id === 'staging' || id === 'phase-tests')) claudeDeny.add(x);
    for (const x of r.devin) (askOnDevin ? devinAsk : devinDeny).add(x);
    for (const x of r.codex) if (!(id === 'staging' || id === 'phase-tests')) codexRules.add(x);
  }
  // Devin: the DB clients ask (the hook denies non-test targets); plain prefixes
  for (const prefix of NON_GIT_PREFIXES.db ?? []) devinAsk.add(devinExec(prefix));
  const claudeAllow: string[] = [];
  const devinAllow: string[] = [];
  for (const v of opts.verificationAllow ?? []) {
    // Claude matches the command as typed: a path word is quoted the way the CLI note prints it,
    // and agents also type it bare (integration run 2026-10-19: `node /…/cli.js phase tests` needed
    // approval under the quoted rule only), so a path without spaces gets the bare spelling as well.
    const typed = v.map(typedWord).join(' ');
    claudeAllow.push(`Bash(${typed} *)`, `Bash(${typed})`);
    devinAllow.push(`Exec(${typed})`);
    const bare = v.map((w) => w.replace(/\\/g, '/')).join(' ');
    if (bare !== typed && !v.some((w) => /\s/.test(w))) {
      claudeAllow.push(`Bash(${bare} *)`, `Bash(${bare})`);
      devinAllow.push(`Exec(${bare})`);
    }
    codexRules.add(`prefix_rule(pattern=[${v.map((w) => JSON.stringify(w)).join(', ')}], decision="allow", justification="verification command the harness runs unattended")`);
  }
  if (opts.runsDir) {
    claudeAllow.push(`Read(${claudePath(opts.runsDir.replace(/[\\/]+$/, '') + '/**')})`);
    devinAllow.push(`Read(${devinPath(opts.runsDir.replace(/[\\/]+$/, '') + '/**')})`);
  }
  if (opts.inboxDir) {
    // the pasted-ticket inbox: the file tools may read and write there without a prompt
    const g = opts.inboxDir.replace(/[\\/]+$/, '') + '/**';
    claudeAllow.push(`Read(${claudePath(g)})`, `Edit(${claudePath(g)})`, `Write(${claudePath(g)})`);
    devinAllow.push(`Read(${devinPath(g)})`, `Write(${devinPath(g)})`);
  }
  return {
    claude: { deny: [...claudeDeny], allow: claudeAllow },
    devin: { deny: [...devinDeny], ask: [...devinAsk], allow: devinAllow },
    codex: { rules: [...codexRules] },
  };
}

/** The .rules file body for Codex. */
export function codexRulesFile(opts: PermissionOptions): string {
  const r = buildPermissions(opts);
  return ['# Generated by harness; the PreToolUse hook is the real rail, these prefixes are the first layer.', ...r.codex.rules].join('\n') + '\n';
}
