/**
 * `harness install --setting team|personal [--agents devin,claude,codex]
 *                  [--workspace <dir>] [--yes] [--judgment]
 *                  [--db-test <host[,port]>[/<database>]]... [--db-none]
 *                  [--reject <check>:<path>]... [--commit] [--no-exec] [--json]`
 * `harness install --uninstall [uninstall flags]`
 *
 * The user's command (the guard blocks it from agent tool calls; the `setup`
 * skill prepares it in the chat and hands it over). In order:
 *
 *   1. machine config (~/.harness/config.json); the personal setting's
 *      `.harness/config.json` is part of the plan (committed with the repo);
 *   2. discover (the ledger), assess (assess.json); with --judgment, write the
 *      judgment bundles, print the handshake for the driving agent and stop;
 *   3. the test databases: discovered candidates are listed and marked
 *      interactively, or by --db-test flags (required with --yes when there
 *      are candidates; --db-none marks nothing, so every DB command is denied);
 *   4. propose (a plan; --reject leaves changes out), show it, ask (or --yes);
 *   5. apply with the lifecycle (backups, manifest), re-sign integrity;
 *   6. ~/.harness becomes a git repository with no remote;
 *   7. print what was written and the next steps per agent.
 *
 * Idempotent: a second run proposes only differences (often none).
 * Exit 0 ok (also "nothing to change" and "not applied"); 1 failure; 2 usage;
 * 4 the plan was refused by a safety rail of apply.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { ALL_AGENTS, type AgentId, type DbTarget, type HarnessConfig, type RepoRef, type Setting } from '../types';
import { flagBool, flagList, flagStr, flagValues, parseArgv } from '../lib/argv';
import { defaultConfig, loadConfig, saveConfig } from '../lib/config';
import { readTextOr, writeJson, writeTextAtomic } from '../lib/fsx';
import { nearestRepoRoot, rawGit, remotes } from '../lib/git';
import { instrument } from '../lib/log';
import { configPath, harnessHome, packageRoot, toPosix, userHome } from '../lib/paths';
import { askYesNo, isInteractive } from '../lib/prompt';
import { which } from '../lib/exec';
import { runDiscover } from '../discover/index';
import { runAssess } from '../assess/index';
import { writeJudgmentBundle } from '../assess/judgment';
import { outDir as assessOutDir } from './assess';
import { loadCandidates, markTarget, normaliseServer, validateDatabase, validateServer, main as dbMain } from './db';
import { buildPlan, formatPlan, hunkCounts, recordRejections, rejectablePairs, type ProposedPlan } from '../render/propose';
import { savePlan } from '../lifecycle/plans';
import { applyPlan } from '../lifecycle/apply';
import { formatApply } from '../lifecycle/format';
import { resignIntegrity } from '../lifecycle/manifest';
import { parseReject } from './propose';

export const meta: CommandMeta = {
  name: 'install',
  summary: 'Discover, assess, mark databases, propose and apply the harness for a setting',
  usage:
    'harness install --setting team|personal [--agents devin,claude,codex] [--workspace <dir>] [--yes] [--judgment] [--db-test <host[,port]>[/<db>]]... [--db-none] [--reject <check>:<path>]... [--commit] [--no-exec] [--json] | --uninstall [--setting team|personal] [--repo <path>] [--dry-run] [--yes] [--json]',
  examples: [
    'harness install --setting team --agents devin,claude --workspace ~/work',
    'harness install --setting personal --workspace . --yes --db-test localhost,1433/app_test',
    'harness install --uninstall --dry-run',
  ],
};

const BOOLEANS = new Set(['yes', 'y', 'json', 'judgment', 'db-none', 'commit', 'uninstall', 'exec', 'help', 'h', 'dry-run']);

function usage(msg: string): number {
  process.stderr.write(`install: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(userHome(), p.slice(2));
  return p;
}

/** `host[,port][/database]` -> a test target (hostnames only). */
export function parseDbTest(raw: string): { target: DbTarget } | { error: string } {
  const slash = raw.indexOf('/');
  const server = normaliseServer(slash >= 0 ? raw.slice(0, slash) : raw);
  const database = slash >= 0 ? raw.slice(slash + 1) : undefined;
  const bad = validateServer(server) ?? validateDatabase(database);
  if (bad) return { error: `--db-test ${raw}: ${bad}` };
  return { target: { server, database, marked: 'test' } };
}

interface Out {
  json: boolean;
  lines: string[];
}

function say(o: Out, s: string): void {
  if (o.json) o.lines.push(s);
  else process.stdout.write(s + '\n');
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgv(argv, BOOLEANS);
  if (flagBool(a, 'uninstall')) {
    const rest = argv.filter((x) => x !== '--uninstall');
    const un = require('./uninstall') as { main(argv: string[]): Promise<number> };
    return un.main(rest);
  }
  const json = flagBool(a, 'json');
  const yes = flagBool(a, 'yes') || flagBool(a, 'y');
  const o: Out = { json, lines: [] };
  const cfg0 = loadConfig();

  // --- arguments ------------------------------------------------------------
  const settingRaw = flagStr(a, 'setting') ?? cfg0?.setting;
  if (!settingRaw) return usage('--setting team|personal is required');
  if (settingRaw !== 'team' && settingRaw !== 'personal') return usage('--setting must be team or personal');
  const setting = settingRaw as Setting;
  const agentsRaw = flagList(a, 'agents');
  const agents = (agentsRaw.length ? agentsRaw : setting === 'personal' ? ['claude', 'codex'] : (cfg0?.agents ?? ALL_AGENTS)) as AgentId[];
  const bad = agents.filter((x) => !ALL_AGENTS.includes(x));
  if (bad.length) return usage(`unknown agent ${bad.join(', ')} (use devin, claude, codex)`);
  let workspace = path.resolve(expandHome(flagStr(a, 'workspace') ?? (setting === 'team' ? cfg0?.workspaceRoot : undefined) ?? process.cwd()));
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) return usage(`workspace ${workspace} is not a folder`);
  if (setting === 'personal') {
    const root = nearestRepoRoot(workspace);
    if (!root) return usage(`personal setting: ${workspace} is not inside a git repository (the harness lives in the repo and lands work on main)`);
    workspace = root;
  }
  const dbFlags = flagValues(a, 'db-test');
  const dbTargets: DbTarget[] = [];
  for (const raw of dbFlags) {
    const r = parseDbTest(raw);
    if ('error' in r) return usage(r.error);
    dbTargets.push(r.target);
  }
  const rejects: Array<{ checkId: string; path: string; raw: string }> = [];
  for (const raw of flagValues(a, 'reject')) {
    const r = parseReject(raw);
    if (!r) return usage(`--reject ${raw}: expected <check>:<path>`);
    rejects.push({ ...r, raw });
  }
  if (!yes && !isInteractive()) return usage('install changes your agent configuration: run it in a terminal, or pass --yes (with --db-test <host[,port]> for each test database, or --db-none)');

  // --- 1. machine config ------------------------------------------------------
  let cfg: HarnessConfig;
  if (setting === 'team') {
    cfg = cfg0 ?? defaultConfig();
    cfg.setting = 'team';
    cfg.agents = agents;
    cfg.workspaceRoot = workspace;
  } else {
    cfg = cfg0 ?? defaultConfig({ setting: 'personal', agents, workspaceRoot: workspace });
  }
  saveConfig(cfg);
  say(o, `Config: ${configPath()} (${cfg.setting} setting on this machine${setting === 'personal' ? `; the repository's own .harness/config.json says personal` : ''})`);

  // --- 2. discover and assess -----------------------------------------------
  const judgment = flagBool(a, 'judgment');
  say(o, `Discovering the standards of ${workspace} ...`);
  let disc;
  try {
    disc = await runDiscover({ root: workspace, exec: a.flags.exec !== false, judgment, progress: json ? undefined : (l) => process.stdout.write('  ' + l + '\n') });
  } catch (e) {
    process.stderr.write(`install: discovery failed: ${(e as Error).message}\n`);
    return 1;
  }
  const repos: RepoRef[] = disc.ws.repos.map((r) => ({ id: r.repo.id, path: r.repo.path, name: r.repo.name, packageManager: (r.repo.packageManager ?? 'unknown') as RepoRef['packageManager'], isGit: r.repo.isGit }));
  if (setting === 'team') {
    cfg.repos = repos;
    saveConfig(cfg);
  }
  say(o, `Standards: ${disc.ledger.records.length} in ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} (ledger ${disc.paths?.ledger ?? path.join(harnessHome(), 'ledger', 'ledger.json')}).`);
  say(o, 'Assessing the existing agent setup ...');
  const assessed = runAssess({ workspace, setting, agents, includes: cfg.include });
  const outDir = assessOutDir();
  const assessJson = path.join(outDir, 'assess.json');
  writeJson(assessJson, assessed.report);
  writeTextAtomic(path.join(outDir, 'assess.md'), assessed.markdown);
  const high = assessed.report.findings.filter((f) => f.severity === 'high').length;
  say(o, `Assessment: ${assessed.report.files.length} agent files, ${assessed.report.findings.length} findings (${high} high), ${assessed.report.safetyRules.length} safety rules (kept). Report: ${path.join(outDir, 'assess.md')}`);
  if (judgment) {
    const ab = writeJudgmentBundle(assessed.report, assessed.ctx, assessJson);
    say(o, '');
    say(o, 'Judgment pass (the setup skill drives it in the agent chat):');
    say(o, `  1. The agent follows ${path.join(ab.dir, 'prompt.md')}, writes its answer outside the harness folder, runs harness judgment submit ${ab.id} --from <file>, then: harness assess --import-judgment ${ab.id}`);
    if (disc.judgment?.bundle) say(o, `  2. The agent follows ${path.join(disc.judgment.bundle.dir, 'prompt.md')}; then: harness discover --root "${workspace}" --import-judgment ${disc.judgment.bundle.id}`);
    say(o, '  3. Run this install again without --judgment to finish.');
    if (json) process.stdout.write(JSON.stringify({ stage: 'judgment', assessBundle: ab.id, discoverBundle: disc.judgment?.bundle?.id ?? null, lines: o.lines }, null, 2) + '\n');
    return 0;
  }

  // --- 3. test databases ------------------------------------------------------
  const cands = loadCandidates()?.candidates ?? [];
  if (cands.length) {
    say(o, `Database servers found (hostnames only): ${cands.map((c) => `${c.server}${c.database ? '/' + c.database : ''}`).join(', ')}`);
  } else say(o, 'Database servers found: none.');
  if (dbTargets.length) {
    for (const t of dbTargets) markTarget(cfg, t);
    saveConfig(cfg);
    say(o, `Marked as test: ${dbTargets.map((t) => `${t.server}${t.database ? '/' + t.database : ' (every database)'}`).join(', ')}. Every other database stays denied.`);
  } else if (flagBool(a, 'db-none')) {
    say(o, 'No database marked as test (--db-none): every database command an agent runs is denied.');
  } else if (cands.length) {
    if (yes) return usage('database servers were found: pass --db-test <host[,port]>[/<db>] for each test database, or --db-none to deny every database command');
    const code = await dbMain(['mark']);
    if (code !== 0) return code;
    cfg = loadConfig() ?? cfg;
  }

  // --- 4. propose -------------------------------------------------------------
  let r = buildPlan({ setting, agents, workspaceRoot: workspace, assess: assessed.report, config: cfg });
  if (rejects.length) {
    const rec = recordRejections(r.plan, rejects);
    if (rec.unmatched.length) {
      process.stderr.write(`install: ${rec.unmatched.map((u) => `--reject ${u}`).join(', ')} matches no change. Changes in this plan:\n${rejectablePairs(r.plan).map((x) => '  ' + x).join('\n')}\n`);
      return 1;
    }
    r = buildPlan({ setting, agents, workspaceRoot: workspace, assess: assessed.report, config: cfg, planId: r.plan.id });
  }
  const plan: ProposedPlan = r.plan;
  const planFile = savePlan(plan);
  say(o, '');
  if (!plan.targets.length) {
    say(o, `Nothing to change: the harness is already in place (plan ${plan.id} has no targets).`);
    finish(o, setting, agents, workspace, null);
    if (json) process.stdout.write(JSON.stringify({ plan: plan.id, file: planFile, targets: 0, applied: false, lines: o.lines }, null, 2) + '\n');
    return 0;
  }
  if (!json) process.stdout.write(formatPlan(plan, { file: planFile, diffs: !yes }));
  else o.lines.push(`Plan ${plan.id}: ${plan.targets.length} file(s); ${JSON.stringify(hunkCounts(plan))}`);
  if (!yes) {
    const ok = await askYesNo('Apply this plan now? (every file is backed up first; `harness undo` restores them)');
    if (!ok) {
      say(o, `Nothing applied. The plan is saved; apply it later with: harness apply --plan ${plan.id}`);
      return 0;
    }
  }

  // --- 5. apply -------------------------------------------------------------
  const res = await applyPlan(plan, { commit: setting === 'personal' && flagBool(a, 'commit'), repoRoot: setting === 'personal' ? workspace : undefined, workspaceRoot: setting === 'team' ? workspace : undefined });
  if (!json) process.stdout.write(formatApply(res) + '\n');
  resignIntegrity('install');
  if (!res.ok) {
    process.stderr.write(`install: the plan was not applied as a whole (${res.refused.length} refused); see above. Nothing else was changed.\n`);
    if (json) process.stdout.write(JSON.stringify({ plan: plan.id, applied: false, result: res }, null, 2) + '\n');
    return res.refused.length ? 4 : 1;
  }
  if (json) for (const w of res.written) o.lines.push(`${w.action} ${w.path}`);

  // --- 6. private state repository -------------------------------------------
  initStateRepo(o);

  // --- 7. next steps ----------------------------------------------------------
  finish(o, setting, agents, workspace, plan.id);
  instrument({ event: 'install', ids: { plan: plan.id, setting }, counts: { written: res.written.length, agents: agents.length, dbTest: cfg.db.allowlist.filter((t) => t.marked === 'test').length } });
  if (json) process.stdout.write(JSON.stringify({ plan: plan.id, file: planFile, targets: plan.targets.length, applied: true, written: res.written.map((w) => w.path), lines: o.lines }, null, 2) + '\n');
  return 0;
}

/** ~/.harness as a private git repository with no remote (DESIGN 2.10). */
export function initStateRepo(o: Out): void {
  const hh = harnessHome();
  if (!fs.existsSync(path.join(hh, '.git'))) {
    const r = rawGit(hh, ['init', '-q'], 15000);
    if (r.code !== 0) {
      say(o, `Note: could not make ${hh} a git repository (${r.stderr.trim() || 'git failed'}); state still works without it.`);
      return;
    }
    const gi = path.join(hh, '.gitignore');
    if (readTextOr(gi, null) === null) writeTextAtomic(gi, ['# harness: volatile state stays out of the history', 'state/', 'cache/', 'locks/', ''].join('\n'));
    say(o, `${hh} is now a private git repository with no remote.`);
  }
  const rem = remotes(hh);
  if (rem.length) say(o, `WARNING: ${hh} has a git remote (${rem.join(', ')}); the harness state is private. Remove it: git -C "${hh}" remote remove <name>`);
}

function finish(o: Out, setting: Setting, agents: AgentId[], workspace: string, planId: string | null): void {
  say(o, '');
  say(o, 'Next steps:');
  if (agents.includes('claude')) say(o, '  Claude Code: start a new session so the settings load; `/hooks` lists the harness hooks.');
  if (agents.includes('codex')) {
    say(o, '  Codex: start codex, run `/hooks` and trust the harness hooks (Codex runs a hook only after its exact text is trusted).' + (setting === 'personal' ? ' The project is marked trusted in ~/.codex/config.toml.' : ''));
    say(o, '  Codex: the install adds the harness folder to `[sandbox_workspace_write] writable_roots` in ~/.codex/config.toml (a note above says when you must add it yourself), so `harness gate` can write its evidence inside the sandbox. End-to-end checks against a local service also need `network_access = true` in that table (set it yourself if you want it).');
  }
  if (agents.includes('devin')) say(o, '  Devin: open the workspace and trust the folder (hooks do not run in Restricted Mode); never use Bypass mode.');
  if (!which('harness')) say(o, `  PATH: agents run \`harness\`; add ${toPosix(path.join(packageRoot(), 'bin'))} to your PATH (or link it), or they use node "${toPosix(path.join(packageRoot(), 'dist', 'src', 'cli.js'))}".`);
  if (setting === 'personal') say(o, `  CI: the workflow runs the verification steps; set the repository variable HARNESS_TOOL_REPO (owner/name of the harness tool) to run the full gate in CI.`);
  say(o, '  Self-check: run `harness doctor`; then ask each agent to run `git push --force` (it must be refused) and run `harness doctor` again to see its heartbeat.');
  if (planId) say(o, `  Undo: \`harness undo --plan ${planId}\` restores every file; \`harness uninstall\` removes everything the harness owns.`);
  say(o, `  Workspace: ${workspace}`);
}
