/**
 * `harness verify` — end-to-end verification against the running services and
 * a per-run test database (DESIGN §2.6). See src/verify/README.md.
 */
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { DEFAULT_BOOLEANS, flagBool, flagList, flagStr, flagValues, parseArgv, type Parsed } from '../lib/argv';
import { readTextOr } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { instrument } from '../lib/log';
import { artefactId, type DbArtefact } from '../verify/artifact';
import { cleanup } from '../verify/cleanup';
import { checkQuery, checkTable, getPath, parseExpectation, type DbOutcome, type Expectation } from '../verify/dbassert';
import { planFromRun, recheckPlan } from '../verify/dbrun';
import { doctor } from '../verify/doctor';
import { CRITERION_RE, criteriaOfTask, drive, matchCriterion, schemaChangesOf, treesOf, writeForRepos, type DriveOptions } from '../verify/drive';
import { evidence, formatEvidence } from '../verify/evidence';
import { buildFeatureMap, loadFeatureMap, saveFeatureMap, type FeatureMap } from '../verify/featuremap';
import { launch } from '../verify/launch';
import { acceptEntries, addMissing, drift, loadOverlay, maintainDiff, saveOverlay } from '../verify/overlay';
import { parseRunEnv, renderCmd, renderPosix, renderPowerShell } from '../verify/runenv';
import { displayCommand } from '../verify/sqlcmd';
import { loadRun, resolveContext, runDirOf, runEnvPath, runFolder, type VerifyContext, type VerifyRun } from '../verify/state';

export const meta: CommandMeta = {
  name: 'verify',
  summary: 'End-to-end verification: launch, doctor, drive, db, evidence, cleanup, env, map, maintain',
  usage: [
    'harness verify launch [--services a,b] [--task <id>] [--repo <path>] [--no-db] [--no-migrate] [--db-unreachable] [--ready-timeout <ms>] [--json]',
    'harness verify doctor [--task <id>] [--json]',
    'harness verify drive "<METHOD> /path" | --method <M> --path </p> [--param k=v]... [--query k=v]... [--header k=v]... [--body @file|<json>] [--as <user>]',
    '                    [--expect-status n] [--expect-json path=value]... [--expect-body <path=value|text>]...',
    '                    [--expect-header "Name=value"|"Name~text"|"Name=*"]...',
    '                    [--repeat n] [--expect-p50-ms|--expect-p95-ms|--expect-p99-ms n] [--timeout <ms>] [--no-recipe] [--criterion <id>] [--service <name>] [--json]',
    'harness verify db [<recipe>] [--table <t>] [--where col=value]... [--expect-columns a,b] [--expect-rows n|<json>]',
    '                  [--expect col=value]... [--query "<select>"] [--param name=value]... [--criterion <id>] [--json]',
    'harness verify evidence [--json]',
    'harness verify cleanup [--keep-db]',
    'harness verify env [--powershell|--cmd|--posix] [--json]',
    'harness verify map build|drift|show [--json]',
    'harness verify maintain [--add-missing | --add <id>[,<id>]] [--accept <id>[,<id>] | --accept-all] [--json]',
  ].join('\n'),
  examples: [
    'harness verify launch --services orders-api',
    'harness verify drive "POST /orders" --expect-status 201 --expect-json order.status=pending',
    'harness verify drive --method GET --path /orders/1 --expect-status 200 --expect-body total',
    'harness verify db --table orders --where id=1 --expect status=pending',
    'harness verify evidence',
    'harness verify cleanup',
  ],
};

const BOOLS = new Set([...DEFAULT_BOOLEANS, 'no-db', 'no-migrate', 'db-unreachable', 'powershell', 'cmd', 'posix', 'add-missing', 'accept-all', 'keep-db', 'no-recipe']);

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : text + '\n');
}

function kv(list: string[], what: string): { ok: true; map: Record<string, string> } | { ok: false; error: string } {
  const map: Record<string, string> = {};
  for (const s of list) {
    const m = /^([^=:]+?)\s*[=:]\s*([\s\S]*)$/.exec(s);
    if (!m) return { ok: false, error: `${what} ${s}: write it as name=value` };
    map[m[1].trim()] = m[2];
  }
  return { ok: true, map };
}

function context(p: Parsed): VerifyContext {
  return resolveContext({ repo: flagStr(p, 'repo'), task: flagStr(p, 'task') });
}

function requireRun(ctx: VerifyContext): { run: VerifyRun } | { code: number; msg: string } {
  if (!ctx.repoId) return { code: 2, msg: 'Run this inside a git repository, or pass --repo <path>.' };
  const run = loadRun(ctx.repoId, ctx.taskId);
  if (!run) return { code: 1, msg: `No verify run for task ${ctx.taskId} in this repository. Start one with \`harness verify launch\`.` };
  if (run.status === 'cleaned') return { code: 1, msg: `Run ${run.runId} was cleaned up. Start a new one with \`harness verify launch\`.` };
  return { run };
}

// ---------------------------------------------------------------------------

async function cmdLaunch(p: Parsed): Promise<number> {
  const ctx = context(p);
  const r = await launch(ctx, { services: flagList(p, 'services'), noDb: flagBool(p, 'no-db'), noMigrate: flagBool(p, 'no-migrate'), dbUnreachable: flagBool(p, 'db-unreachable'), readyTimeoutMs: flagStr(p, 'ready-timeout') ? Number(flagStr(p, 'ready-timeout')) : undefined });
  if (flagBool(p, 'json')) out(JSON.stringify({ code: r.code, run: r.run ?? null, lines: r.lines }, null, 2));
  else (r.code === 0 ? out : r.code === 2 || r.code === 4 ? err : out)(r.lines.join('\n'));
  return r.code;
}

async function cmdDoctor(p: Parsed): Promise<number> {
  const ctx = context(p);
  const run = ctx.repoId ? loadRun(ctx.repoId, ctx.taskId) : null;
  const r = await doctor(ctx, run && run.status !== 'cleaned' ? run : null);
  if (flagBool(p, 'json')) {
    out(JSON.stringify(r, null, 2));
    return r.code;
  }
  for (const c of r.checks) out(`${c.status === 'ok' ? 'ok  ' : c.status === 'fail' ? 'FAIL' : c.status === 'warn' ? 'warn' : 'skip'} ${c.name}: ${c.detail}`);
  if (r.code === 4) err('Refused by the database rail (see the allowlist line above).');
  else out(r.code === 0 ? 'Doctor: the run is ready.' : 'Doctor: fix the FAIL lines, then run doctor again.');
  return r.code;
}

async function cmdDrive(p: Parsed): Promise<number> {
  const ctx = context(p);
  const rr = requireRun(ctx);
  if ('code' in rr) {
    err(rr.msg);
    return rr.code;
  }
  const params = kv(flagValues(p, 'param'), '--param');
  const query = kv(flagValues(p, 'query'), '--query');
  const headers = kv(flagValues(p, 'header'), '--header');
  for (const x of [params, query, headers]) if (!x.ok) {
    err(x.error);
    return 2;
  }
  const num = (k: string): number | undefined => {
    const v = flagStr(p, k);
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const pms: DriveOptions['expectPms'] = {};
  for (const k of ['p50', 'p95', 'p99'] as const) {
    const v = num(`expect-${k}-ms`);
    if (v !== undefined) pms[k] = v;
  }
  const expectStatus = num('expect-status');
  const repeat = num('repeat');
  if ([expectStatus, repeat, ...Object.values(pms)].some((x) => x !== undefined && Number.isNaN(x))) {
    err('--expect-status, --repeat and --expect-pNN-ms take numbers.');
    return 2;
  }
  const routeParts = p.positional.slice(1);
  const o: DriveOptions = {
    method: flagStr(p, 'method'),
    path: flagStr(p, 'path'),
    route: routeParts.length ? routeParts.join(' ') : undefined,
    service: flagStr(p, 'service'),
    body: flagStr(p, 'body'),
    as: flagStr(p, 'as'),
    params: (params as { map: Record<string, string> }).map,
    query: (query as { map: Record<string, string> }).map,
    headers: (headers as { map: Record<string, string> }).map,
    expectStatus,
    expectJson: flagValues(p, 'expect-json'),
    expectBody: flagValues(p, 'expect-body'),
    expectHeader: flagValues(p, 'expect-header'),
    repeat,
    expectPms: pms,
    criterion: flagStr(p, 'criterion'),
    timeoutMs: num('timeout'),
    noRecipe: flagBool(p, 'no-recipe'),
  };
  const r = await drive(ctx, rr.run, o);
  if (flagBool(p, 'json')) out(JSON.stringify({ code: r.code, artefact: r.artefact ?? null, lines: r.lines }, null, 2));
  else (r.code === 2 ? err : out)(r.lines.join('\n'));
  return r.code;
}

async function cmdDb(p: Parsed): Promise<number> {
  const ctx = context(p);
  const rr = requireRun(ctx);
  if ('code' in rr) {
    err(rr.msg);
    return rr.code;
  }
  const run = rr.run;
  if (!run.db) {
    err(`Run ${run.runId} has no database.`);
    return 1;
  }
  const pf = planFromRun(run.db, ctx.vcfg);
  if (!pf.ok || !pf.plan) {
    err(`Cannot reach the run database: ${pf.reason}`);
    return 1;
  }
  const rc = recheckPlan(pf.plan, ctx.config.db);
  if (!rc.ok) {
    err(`Refused: ${rc.reason}`);
    return 4;
  }
  const plan = pf.plan;
  const where = kv(flagValues(p, 'where'), '--where');
  const named = kv(flagValues(p, 'param'), '--param');
  if (!where.ok || !named.ok) {
    err((!where.ok ? where : (named as { error: string })).error);
    return 2;
  }
  const exps: Expectation[] = [];
  for (const s of flagValues(p, 'expect')) {
    const e = parseExpectation(s);
    if (!e) {
      err(`--expect ${s}: write it as column=value (for example status=pending).`);
      return 2;
    }
    exps.push(e);
  }
  let expectRows: number | Array<Record<string, unknown>> | undefined;
  const er = flagStr(p, 'expect-rows');
  if (er !== undefined && er !== '') {
    if (/^\d+$/.test(er)) expectRows = Number(er);
    else {
      try {
        const v = JSON.parse(er) as unknown;
        expectRows = Array.isArray(v) ? (v as Array<Record<string, unknown>>) : v && typeof v === 'object' ? [v as Record<string, unknown>] : undefined;
      } catch {
        expectRows = undefined;
      }
      if (!expectRows) {
        err('--expect-rows takes a count or JSON rows (for example [{"status":"pending"}]).');
        return 2;
      }
    }
  }
  const whereVals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where.map)) {
    try {
      whereVals[k] = JSON.parse(v);
    } catch {
      whereVals[k] = v;
    }
  }
  const table = flagStr(p, 'table');
  const sql = flagStr(p, 'query');
  const recipeName = p.positional[1];
  let outcome: DbOutcome;
  let label: string;
  let commandShown: string;
  const overlay = loadOverlay(run.repoId).overlay;
  if (recipeName) {
    const rec = overlay.dbRecipes?.[recipeName];
    if (!rec) {
      err(`No DB recipe "${recipeName}" under "dbRecipes" in the feature-map overlay.`);
      return 2;
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec.params ?? {})) {
      let val = typeof v === 'string' ? v : JSON.stringify(v);
      val = val.replace(/\{\{\s*runId\s*\}\}/g, run.runId).replace(/\{\{\s*last\.([^}]+?)\s*\}\}/g, (_m, pth: string) => {
        const x = getPath(run.last?.body, pth);
        return x === undefined ? '' : String(x);
      });
      params[k] = val;
    }
    Object.assign(params, named.map);
    const recExp = Object.entries(rec.expect ?? {}).map(([k, v]) => ({ path: k, op: '=' as const, raw: typeof v === 'string' ? v : JSON.stringify(v), value: v }));
    outcome = checkQuery(plan, rec.sql, params, { expectRows: typeof expectRows === 'number' ? expectRows : rec.expectRows, expect: exps.length ? exps : recExp, recipe: true });
    label = recipeName;
    commandShown = `harness verify db ${recipeName}`;
  } else if (sql) {
    outcome = checkQuery(plan, sql, named.map, { expectRows: typeof expectRows === 'number' ? expectRows : undefined, expect: exps });
    label = `query-${sha256(sql).slice(0, 8)}`;
    commandShown = displayCommand(plan.transport, plan.database, plan.login, sql);
  } else if (table) {
    outcome = checkTable(plan, { table, where: Object.keys(whereVals).length ? whereVals : undefined, expectColumns: flagList(p, 'expect-columns'), expectRows, expect: exps });
    label = table.replace(/^dbo\./i, '');
    commandShown = `harness verify db --table ${table}`;
  } else {
    err('Name what to check: --table <t>, --query "<select>", or a recipe name from the overlay.');
    return 2;
  }
  if (outcome.error) {
    err(`Refused or failed: ${outcome.error}`);
    return outcome.error.startsWith('only') || /not allowed|another database|reaches outside/.test(outcome.error) ? 4 : 1;
  }
  const criteria = criteriaOfTask(run.taskId, run.repoId);
  let criterion = flagStr(p, 'criterion');
  if (criterion && !CRITERION_RE.test(criterion)) {
    err(`--criterion ${criterion.slice(0, 40)} is not a criterion id.`);
    return 2;
  }
  if (!criterion && table) criterion = matchCriterion(criteria, 'db', { table });
  const trees = treesOf(run);
  const art: DbArtefact = {
    version: 1,
    id: artefactId('db', criterion, label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')),
    kind: 'db',
    criterion,
    treeHash: trees[run.repoId] ?? '',
    trees,
    createdAt: new Date().toISOString(),
    pass: outcome.ok,
    runId: run.runId,
    repoId: run.repoId,
    taskId: run.taskId,
    assertions: outcome.assertions,
    schemaChanges: schemaChangesOf(run),
    dbUnreachable: run.dbUnreachable || undefined,
    command: commandShown,
    server: run.db.host,
    database: run.db.database,
    table: table ?? undefined,
    recipe: recipeName,
    query: sql ? sql.slice(0, 2000) : undefined,
    params: outcome.params,
    columns: outcome.columns,
    rows: outcome.rows,
    rowCount: outcome.rowCount,
    rowsTruncated: outcome.rowsTruncated,
  };
  const roots: Record<string, string> = { [run.repoId]: run.repoRoot };
  writeForRepos(run, art, [run.repoId], roots);
  instrument({ event: 'verify.db', repo: run.repoId, task: run.taskId, ids: { runId: run.runId, artefact: art.id }, counts: { assertions: art.assertions.length, failed: art.assertions.filter((a) => !a.pass).length, rows: art.rowCount } });
  if (flagBool(p, 'json')) out(JSON.stringify({ code: outcome.ok ? 0 : 1, artefact: art }, null, 2));
  else {
    out(`${run.db.database}: ${table ? `table ${table}` : recipeName ? `recipe ${recipeName}` : 'query'} -> ${art.rowCount} row(s)`);
    if (sql) out(`sqlcmd: ${commandShown}`);
    for (const a of art.assertions) out(`  ${a.pass ? 'ok  ' : 'FAIL'} ${a.kind}: expected ${a.expect}${a.actual !== undefined ? `, got ${a.actual}` : ''}`);
    if (art.schemaChanges) out(`shared-schema changes recorded: ${art.schemaChanges.map((c) => `${c.service}/${c.id}`).join(', ')}`);
    out(`artefact: e2e/${art.id}.json${criterion ? ` (criterion ${criterion})` : ''} ${art.pass ? 'PASS' : 'FAIL'}`);
  }
  return outcome.ok ? 0 : 1;
}

async function cmdEvidence(p: Parsed): Promise<number> {
  const ctx = context(p);
  if (!ctx.repoId || !ctx.repoRoot) {
    err('Run this inside a git repository, or pass --repo <path>.');
    return 2;
  }
  const dir = runFolder(ctx.repoId, ctx.taskId);
  const r = evidence(dir, ctx.repoRoot);
  if (flagBool(p, 'json')) out(JSON.stringify(r, null, 2));
  else out(formatEvidence(r).join('\n'));
  return 0;
}

async function cmdCleanup(p: Parsed): Promise<number> {
  const ctx = context(p);
  const rr = requireRun(ctx);
  if ('code' in rr) {
    err(rr.msg);
    return rr.code;
  }
  const r = await cleanup(ctx, rr.run, { keepDb: flagBool(p, 'keep-db') });
  out(r.lines.join('\n'));
  return r.code;
}

async function cmdEnv(p: Parsed): Promise<number> {
  const ctx = context(p);
  const rr = requireRun(ctx);
  if ('code' in rr) {
    err(rr.msg);
    return rr.code;
  }
  const text = readTextOr(runEnvPath(runDirOf(rr.run)), null);
  if (text === null) {
    err('run.env is missing; launch again.');
    return 1;
  }
  const vars = parseRunEnv(text);
  if (flagBool(p, 'json')) out(JSON.stringify(vars, null, 2));
  else if (flagBool(p, 'powershell')) out(renderPowerShell(vars));
  else if (flagBool(p, 'cmd')) out(renderCmd(vars));
  else if (flagBool(p, 'posix')) out(renderPosix(vars));
  else {
    out(renderPosix(vars, [`run ${rr.run.runId}: POSIX shells: set -a; . "${runEnvPath(runDirOf(rr.run))}"; set +a`]));
    out('# PowerShell:');
    out(renderPowerShell(vars).trimEnd());
    if (rr.run.db?.passwordEnv || rr.run.db?.user) out(`# The database password is not here: it stays in ${rr.run.db?.passwordEnv ?? 'your environment'} (sqlcmd reads SQLCMDPASSWORD).`);
  }
  return 0;
}

function freshMap(ctx: VerifyContext): FeatureMap {
  const map = buildFeatureMap({ workspaceRoot: ctx.workspaceRoot, extraRepos: ctx.config.repos.map((r) => r.path), migrationsOverride: ctx.vcfg.db?.migrations });
  if (ctx.repoId) saveFeatureMap(ctx.repoId, map);
  return map;
}

async function cmdMap(p: Parsed): Promise<number> {
  const ctx = context(p);
  if (!ctx.repoId) {
    err('Run this inside a git repository, or pass --repo <path>.');
    return 2;
  }
  const sub = p.positional[1] ?? 'show';
  const json = flagBool(p, 'json');
  if (sub === 'build' || sub === 'show') {
    const map = sub === 'build' ? freshMap(ctx) : loadFeatureMap(ctx.repoId) ?? freshMap(ctx);
    if (json) {
      out(JSON.stringify(map, null, 2));
      return 0;
    }
    out(`Feature map of ${ctx.workspaceRoot}: ${map.services.length} service(s), ${map.routes.length} route(s), ${map.migrations.length} migration(s), ${map.tables.length} table(s)`);
    for (const s of map.services) {
      out(`  ${s.name}${s.health ? ` (health ${s.health})` : ''}${Object.keys(s.needs).length ? ` needs ${Object.entries(s.needs).map(([v, n]) => `${n} via ${v}`).join(', ')}` : ''}`);
      for (const r of map.routes.filter((x) => x.service === s.name)) out(`    ${r.id.padEnd(36)} ${r.file}:${r.line}  [${r.statuses.join(',')}]`);
      for (const m of map.migrations.filter((x) => x.service === s.name)) out(`    migration ${m.id}${m.tables.length ? ` (${m.tables.join(', ')})` : ''}`);
    }
    for (const n of map.notes) out(`Note: ${n}`);
    return 0;
  }
  if (sub === 'drift') {
    const map = freshMap(ctx);
    const ov = loadOverlay(ctx.repoId);
    const d = drift(map, ctx.repoId, ov.overlay, ov.exists);
    if (json) out(JSON.stringify(d, null, 2));
    else if (!d.routes.length && !d.migrations.length) out(`No drift: every route and migration of this repository has an overlay entry (${ov.file}).`);
    else {
      out(`${d.routes.length} route(s) and ${d.migrations.length} migration(s) have no feature-map overlay entry:`);
      for (const x of d.details) out(`  ${x}`);
      out('Add them with `harness verify maintain --add-missing`, then write their recipes.');
    }
    return d.routes.length || d.migrations.length ? 1 : 0;
  }
  err(`Unknown map subcommand ${sub}: use build, drift or show.`);
  return 2;
}

async function cmdMaintain(p: Parsed): Promise<number> {
  const ctx = context(p);
  if (!ctx.repoId) {
    err('Run this inside a git repository, or pass --repo <path>.');
    return 2;
  }
  const map = freshMap(ctx);
  const ov = loadOverlay(ctx.repoId);
  const o = ov.overlay;
  let changedFile = false;
  const added = flagBool(p, 'add-missing') ? addMissing(map, ctx.repoId, o) : flagList(p, 'add').length ? addMissing(map, ctx.repoId, o, flagList(p, 'add')) : [];
  if (added.length) changedFile = true;
  const accepted = flagBool(p, 'accept-all') ? acceptEntries(map, ctx.repoId, o, 'all') : flagList(p, 'accept').length ? acceptEntries(map, ctx.repoId, o, flagList(p, 'accept')) : [];
  if (accepted.length) changedFile = true;
  let file = ov.file;
  if (changedFile) file = saveOverlay(ctx.repoId, o);
  const items = maintainDiff(map, ctx.repoId, o);
  const counts = { clean: 0, changed: 0, blocked: 0, missing: 0 };
  for (const i of items) counts[i.outcome]++;
  instrument({ event: 'verify.maintain', repo: ctx.repoId, counts: { ...counts, added: added.length, accepted: accepted.length } });
  if (flagBool(p, 'json')) {
    out(JSON.stringify({ overlay: file, added, accepted, counts, items }, null, 2));
    return counts.blocked || counts.changed ? 1 : 0;
  }
  out(`Feature-map maintenance for ${path.basename(ctx.repoRoot ?? ctx.repoId)} (overlay ${file}${ov.exists || changedFile ? '' : ', not created yet'}); product code is never touched.`);
  if (added.length) out(`Added ${added.length} skeleton entr${added.length === 1 ? 'y' : 'ies'} (no recipe yet): ${added.join(', ')}`);
  if (accepted.length) out(`Recorded the current inventory for: ${accepted.join(', ')}`);
  for (const i of items) out(`  ${i.outcome.padEnd(7)} ${i.id}${i.reasons.length ? `  - ${i.reasons.join('; ')}` : ''}`);
  out(`clean ${counts.clean}, changed ${counts.changed}, blocked ${counts.blocked}, missing ${counts.missing}`);
  if (counts.missing) out('Missing entries: `harness verify maintain --add-missing`, then write a recipe for each.');
  if (counts.changed) out('Changed entries: review the recipe, then `harness verify maintain --accept <id>`.');
  return counts.blocked || counts.changed ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, BOOLS);
  const sub = p.positional[0];
  try {
    switch (sub) {
      case 'launch':
        return await cmdLaunch(p);
      case 'doctor':
        return await cmdDoctor(p);
      case 'drive':
        return await cmdDrive(p);
      case 'db':
        return await cmdDb(p);
      case 'evidence':
        return await cmdEvidence(p);
      case 'cleanup':
        return await cmdCleanup(p);
      case 'env':
        return await cmdEnv(p);
      case 'map':
        return await cmdMap(p);
      case 'maintain':
        return await cmdMaintain(p);
      default:
        err(`usage:\n${meta.usage}`);
        return 2;
    }
  } catch (e) {
    err(`harness verify ${sub}: ${(e as Error).message}`);
    return 1;
  }
}
