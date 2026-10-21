/**
 * `harness task` — the personal task ledger (tasks/*.md in the repo).
 *
 *   harness task add --title "<text>" [--priority <n>] [--acceptance "<text>"]... [--paths a,b] [--depends-on <id>]
 *   harness task list [--status <s>] [--json]
 *   harness task next [--stale-minutes <n>] [--json]      exit 1 when no task is ready
 *   harness task claim <id> [--by <name>] [--stale-minutes <n>] [--json]
 *   harness task done <id> --commit <sha> [--evidence <path>]
 *   harness task fail <id> --reason "<text>"
 *   harness task release <id>
 *   harness task import --from-json <file>
 *   harness task validate
 *
 * All take `--repo <path>` (default: the git root of the working directory).
 * In the team setting, the subcommands that write (add, claim, done, fail,
 * release, import) refuse a configured team repo with exit 4: nothing is
 * written inside a team repo.
 * `claim` also writes a brief for the task (same pipeline as a pasted
 * ticket) and makes it the repo's current task, so `harness phase`,
 * `harness gate` and `harness writeup` work the same in both settings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import type { Parsed } from '../lib/argv';
import { flagBool, flagList, flagStr, parseArgv } from '../lib/argv';
import { repoIdFor, resolveConfig } from '../lib/config';
import { isGitRepo, nearestRepoRoot, rawGit } from '../lib/git';
import { instrument } from '../lib/log';
import { subPath } from '../lib/paths';
import { buildBrief, saveBrief, setCurrentTask, ticketTextForTask } from '../intake/brief';
import {
  addTask,
  claimTask,
  DEFAULT_STALE_MINUTES,
  doneTask,
  failTask,
  importTasks,
  LedgerError,
  nextTask,
  readLedger,
  releaseTask,
  STATUSES,
  validateLedger,
  type LedgerTask,
} from '../intake/ledger';

export const meta: CommandMeta = {
  name: 'task',
  summary: 'Personal task ledger: next, claim, done, fail, list',
  usage:
    'harness task add --title <t> [--priority n] [--acceptance <a>]... [--paths a,b] [--depends-on id] | list [--status s] | next [--stale-minutes n] | claim <id> [--by name] [--stale-minutes n] | done <id> --commit <sha> [--evidence path] | fail <id> --reason <r> | release <id> | import --from-json <file> | validate  [--repo path] [--json]',
  examples: ['harness task add --title "Add CSV export" --priority 1 --acceptance "GET /export returns 200 with text/csv" --paths src/export', 'harness task next --json', 'harness task claim T-003 --by claude', 'harness task done T-003 --commit 1a2b3c4'],
};

const MUTATING = new Set(['add', 'claim', 'done', 'fail', 'release', 'import']);

/** The configured team repo (or team workspace) that contains `root`, when the effective setting is team. */
function teamRepoFor(root: string): string | null {
  const r = resolveConfig(root);
  if (r.source === 'default' || r.config.setting !== 'team') return null;
  const hit = r.config.repos.find((x) => x && typeof x.path === 'string' && subPath(x.path, root));
  if (hit) return hit.name || hit.path;
  if (r.config.workspaceRoot && r.config.repos.length && subPath(r.config.workspaceRoot, root)) return root;
  return null;
}

/** Repeated string flags without comma splitting (acceptance text may hold commas). */
function rawList(p: Parsed, k: string): string[] {
  const v = p.flags[k];
  if (v === undefined || typeof v === 'boolean') return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

function summary(t: LedgerTask): string {
  const lines = [`${t.id}  ${t.title}  (priority ${t.priority}, ${t.status})`];
  if (t.paths.length) lines.push(`  paths: ${t.paths.join(', ')}`);
  else lines.push('  paths: (none declared: treated as the whole repo)');
  if (t.depends_on.length) lines.push(`  depends on: ${t.depends_on.join(', ')}`);
  if (t.acceptance.length) {
    lines.push('  acceptance:');
    for (const a of t.acceptance) lines.push(`    - ${a}`);
  } else lines.push('  acceptance: (none; add some so the gate has checks)');
  if (t.claimed_by) lines.push(`  claimed by ${t.claimed_by} at ${t.claimed_at}`);
  if (t.commit) lines.push(`  commit: ${t.commit}`);
  if (t.reason) lines.push(`  reason: ${t.reason}`);
  return lines.join('\n');
}

function publicFields(t: LedgerTask): Omit<LedgerTask, 'body'> & { file?: string } {
  const { body: _b, ...rest } = t;
  void _b;
  return rest;
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv);
  const sub = p.positional[0];
  const json = flagBool(p, 'json');
  const repoFlag = flagStr(p, 'repo');
  const root = repoFlag ? path.resolve(repoFlag) : (nearestRepoRoot(process.cwd()) ?? process.cwd());
  const staleRaw = flagStr(p, 'stale-minutes');
  const staleMinutes = staleRaw !== undefined ? Number(staleRaw) : DEFAULT_STALE_MINUTES;
  if (!Number.isFinite(staleMinutes) || staleMinutes < 0) {
    process.stderr.write('--stale-minutes takes a number of minutes\n');
    return 2;
  }
  const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
  // Safety rail: the ledger lives in the repo, and the team setting never writes inside a team repo.
  if (sub && MUTATING.has(sub)) {
    const team = teamRepoFor(root);
    if (team) {
      process.stderr.write(`Refused: ${team} is a team repository (team setting); the task ledger would write tasks/ inside it. Use \`harness intake\` for team work.\n`);
      return 4;
    }
  }
  const log = (event: string, ids: Record<string, string> = {}, counts: Record<string, number> = {}) => instrument({ event, repo: repoIdFor(root), ids, counts });

  try {
    switch (sub) {
      case 'add': {
        const title = flagStr(p, 'title');
        if (!title) {
          process.stderr.write('usage: harness task add --title "<text>" [--priority n] [--acceptance "<text>"]... [--paths a,b] [--depends-on id]\n');
          return 2;
        }
        const prRaw = flagStr(p, 'priority');
        const priority = prRaw === undefined ? undefined : Number(prRaw);
        if (priority !== undefined && !Number.isFinite(priority)) {
          process.stderr.write('--priority takes a number (lower is more urgent)\n');
          return 2;
        }
        const t = addTask(root, { title, ...(priority !== undefined ? { priority } : {}), acceptance: rawList(p, 'acceptance'), paths: flagList(p, 'paths'), dependsOn: flagList(p, 'depends-on') });
        log('task.add', { task: t.id }, { acceptance: t.acceptance.length, paths: t.paths.length });
        out(json ? JSON.stringify(publicFields(t), null, 2) : `Added ${t.id}: ${path.relative(root, t.file!)}\n${summary(t)}`);
        return 0;
      }
      case 'list': {
        const { tasks, problems } = readLedger(root);
        const st = flagStr(p, 'status');
        if (st && !STATUSES.includes(st as never)) {
          process.stderr.write(`--status is one of ${STATUSES.join(', ')}\n`);
          return 2;
        }
        const shown = st ? tasks.filter((t) => t.status === st) : tasks;
        if (json) out(JSON.stringify(shown.map(publicFields), null, 2));
        else if (!shown.length) out(tasks.length ? `No ${st} tasks.` : 'No tasks yet. Add one: harness task add --title "<text>"');
        else for (const t of shown) out(`${t.id.padEnd(8)} ${t.status.padEnd(8)} p${t.priority}  ${t.title}${t.depends_on.length ? `  (after ${t.depends_on.join(', ')})` : ''}`);
        if (problems.length && !json) process.stderr.write(`${problems.length} problem(s); run: harness task validate\n`);
        return 0;
      }
      case 'next': {
        const { tasks } = readLedger(root);
        const r = nextTask(tasks, { staleMinutes });
        log('task.next', r.task ? { task: r.task.id } : {}, { candidates: tasks.length, skipped: r.skipped.length, found: r.task ? 1 : 0 });
        if (json) {
          out(JSON.stringify(r.task ? { ...publicFields(r.task), skipped: r.skipped } : { task: null, skipped: r.skipped }, null, 2));
          return r.task ? 0 : 1;
        }
        if (!r.task) {
          out('No task is ready.');
          for (const s of r.skipped) out(`  ${s.id}: ${s.reason}`);
          return 1;
        }
        out(`${summary(r.task)}\nClaim it: harness task claim ${r.task.id}`);
        return 0;
      }
      case 'claim': {
        const id = p.positional[1];
        if (!id) {
          process.stderr.write('usage: harness task claim <id> [--by <name>]\n');
          return 2;
        }
        const by = flagStr(p, 'by') ?? process.env.HARNESS_AGENT ?? 'agent';
        const r = claimTask(root, id, by, { staleMinutes });
        if (!r.ok) {
          log('task.claim.refused', { task: id });
          process.stderr.write(`Refused: ${r.reason}\n`);
          return 1;
        }
        const resolved = resolveConfig(root);
        const brief = buildBrief(ticketTextForTask(r.task), { config: resolved.config, defaultRepoPath: root, id: r.task.id, source: 'ledger' });
        saveBrief(brief);
        setCurrentTask(repoIdFor(root), r.task.id);
        log('task.claim', { task: id }, { reclaimed: r.reclaimed ? 1 : 0, criteria: brief.criteria.length });
        if (json) out(JSON.stringify({ ...publicFields(r.task), brief: brief.id, lint: brief.lint }, null, 2));
        else {
          out(`Claimed ${id}${r.reclaimed ? ' (the earlier claim was stale)' : ''}; it is now the current task for this repo.\n${summary(r.task)}`);
          if (brief.lint.length) out(`Brief notes: ${brief.lint.join('; ')}`);
          out('Next: harness phase tests (write the failing checks), then harness phase implement.');
        }
        return 0;
      }
      case 'done': {
        const id = p.positional[1];
        const commit = flagStr(p, 'commit');
        if (!id || !commit) {
          process.stderr.write('usage: harness task done <id> --commit <sha> [--evidence <path>]\n');
          return 2;
        }
        if (/^[0-9a-f]{7,40}$/i.test(commit) && isGitRepo(root)) {
          const c = rawGit(root, ['cat-file', '-e', `${commit}^{commit}`], 5000);
          if (c.code !== 0) {
            process.stderr.write(`Commit ${commit} is not in this repository; pass the sha of the task's commit.\n`);
            return 1;
          }
        }
        const t = doneTask(root, id, commit, flagStr(p, 'evidence'));
        log('task.done', { task: id });
        out(json ? JSON.stringify(publicFields(t), null, 2) : `Done ${id} at ${t.commit}.`);
        return 0;
      }
      case 'fail': {
        const id = p.positional[1];
        const reason = flagStr(p, 'reason');
        if (!id || !reason) {
          process.stderr.write('usage: harness task fail <id> --reason "<text>"\n');
          return 2;
        }
        const t = failTask(root, id, reason);
        log('task.fail', { task: id });
        out(json ? JSON.stringify(publicFields(t), null, 2) : `Marked ${id} failed: ${t.reason}`);
        return 0;
      }
      case 'release': {
        const id = p.positional[1];
        if (!id) {
          process.stderr.write('usage: harness task release <id>\n');
          return 2;
        }
        releaseTask(root, id);
        log('task.release', { task: id });
        out(`Released ${id}; it is todo again.`);
        return 0;
      }
      case 'import': {
        const file = flagStr(p, 'from-json');
        if (!file) {
          process.stderr.write('usage: harness task import --from-json <file>   (a JSON array of {title, body, acceptance, labels})\n');
          return 2;
        }
        let items: unknown;
        try {
          items = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          process.stderr.write(`Cannot read ${file} as JSON: ${(e as Error).message.slice(0, 120)}\n`);
          return 2;
        }
        const r = importTasks(root, items);
        log('task.import', {}, { created: r.created.length, skipped: r.skipped.length });
        if (json) out(JSON.stringify({ created: r.created.map(publicFields), skipped: r.skipped }, null, 2));
        else {
          out(`Imported ${r.created.length} task(s)${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`);
          for (const t of r.created) out(`  ${t.id}  ${t.title}`);
          for (const s of r.skipped) out(`  skipped "${s.title}": ${s.reason}`);
        }
        return 0;
      }
      case 'validate': {
        const problems = validateLedger(root);
        const { tasks } = readLedger(root);
        log('task.validate', {}, { tasks: tasks.length, problems: problems.length });
        if (json) out(JSON.stringify({ tasks: tasks.length, problems }, null, 2));
        else if (problems.length) out(`Task ledger: ${problems.length} problem(s)\n${problems.map((x) => `  - ${x}`).join('\n')}`);
        else out(`Task ledger ok: ${tasks.length} task(s), no problems.`);
        return problems.length ? 1 : 0;
      }
      default:
        process.stderr.write(`usage: ${meta.usage}\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof LedgerError || /locked by another process/.test((e as Error).message)) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    throw e;
  }
}
