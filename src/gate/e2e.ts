/**
 * Step 8: a fresh end-to-end artefact per api/db acceptance check (R-07:
 * passing unit tests are not enough evidence of behaviour).
 *
 * Interface with `harness verify` (it writes the files; the gate reads):
 *
 *   ~/.harness/runs/<repoId>/<task>/e2e/<criterionId>-http.json   (verify drive)
 *   ~/.harness/runs/<repoId>/<task>/e2e/<criterionId>-db.json     (verify db)
 *     { "version": 1, "id": "AC1-http", "kind": "http" | "db" | "browser",
 *       "criterion"?: "AC1", "treeHash": "<git write-tree when it ran>",
 *       "createdAt": "<ISO time>", "pass": true | false, ... }
 *
 * An artefact counts for a criterion when its id (or file name) is
 * `<criterionId>-http` / `<criterionId>-db`, its treeHash equals the tree the
 * gate checks, and it does not record a failure (`pass: false` or `ok: false`).
 * One step per api/db criterion (`e2e:<id>`); skipped only when the brief
 * has no api or db checks for this repository.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion, E2EArtifactRef } from '../types';
import type { GateContext } from './context';
import { readJsonOr } from '../lib/fsx';
import { sha256 } from '../lib/hash';
import { fail, pass, skip, type StepDef, type StepOutcome } from './steps';

export interface E2EArtefact {
  id: string;
  kind: 'http' | 'db' | 'browser';
  /** Path relative to the run folder (`e2e/AC1-http.json`). */
  rel: string;
  treeHash: string;
  createdAt: string;
  passed: boolean | null;
  criterion?: string;
  /** The run was launched with `--db-unreachable`. */
  dbUnreachable?: boolean;
}

export function e2eDir(runDir: string): string {
  return path.join(runDir, 'e2e');
}

/** Every artefact under the run folder's e2e/ (JSON files with an id or a usable file name). */
export function listArtefacts(runDir: string): E2EArtefact[] {
  const dir = e2eDir(runDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: E2EArtefact[] = [];
  for (const n of names) {
    const j = readJsonOr<Record<string, unknown> | null>(path.join(dir, n), null);
    if (!j || typeof j !== 'object') continue;
    const id = typeof j.id === 'string' && j.id ? j.id : n.slice(0, -5);
    const kindRaw = typeof j.kind === 'string' ? j.kind : /-db$/.test(id) ? 'db' : /-browser$/.test(id) ? 'browser' : 'http';
    const kind = kindRaw === 'db' || kindRaw === 'browser' ? kindRaw : 'http';
    const passed = j.pass === false || j.ok === false || j.passed === false ? false : j.pass === true || j.ok === true || j.passed === true ? true : null;
    out.push({
      id,
      kind,
      rel: `e2e/${n}`,
      treeHash: typeof j.treeHash === 'string' ? j.treeHash : '',
      createdAt: typeof j.createdAt === 'string' ? j.createdAt : '',
      passed,
      criterion: typeof j.criterion === 'string' ? j.criterion : undefined,
      ...(j.dbUnreachable === true ? { dbUnreachable: true } : {}),
    });
  }
  return out;
}

/** The artefact kind a criterion needs, or null when it needs none. */
export function neededKind(c: Criterion): 'http' | 'db' | null {
  if (c.check?.kind === 'e2e-http' || (!c.check && c.kind === 'api')) return 'http';
  if (c.check?.kind === 'e2e-db' || (!c.check && c.kind === 'db')) return 'db';
  return null;
}

export function e2eCriteria(ctx: Pick<GateContext, 'criteria'>): Array<{ c: Criterion; kind: 'http' | 'db' }> {
  return ctx.criteria.map((c) => ({ c, kind: neededKind(c) })).filter((x): x is { c: Criterion; kind: 'http' | 'db' } => !!x.kind);
}

export function e2eOutcome(ctx: Pick<GateContext, 'runDir' | 'tree'>, c: Criterion, kind: 'http' | 'db', arts = listArtefacts(ctx.runDir)): StepOutcome {
  const want = `${c.id}-${kind}`;
  const named = arts.filter((a) => a.id === want || a.rel === `e2e/${want}.json` || (a.criterion === c.id && a.kind === kind));
  // a check that launches with `--db-unreachable` is only met by an artefact of such a launch
  const needsDown = /--db-unreachable\b/.test(c.check?.command ?? '');
  const mine = needsDown ? named.filter((a) => a.dbUnreachable === true) : named;
  const run = c.check?.command ? ` Run: ${c.check.command}` : '';
  if (needsDown && named.length && !mine.length) return fail([`${c.id}: the ${want} artefact is not from a \`--db-unreachable\` launch; this check needs an artefact from a \`--db-unreachable\` launch.${run}`]);
  if (!mine.length) return fail([`${c.id}: no ${kind === 'http' ? 'HTTP' : 'database'} artefact (${want}) for this check.${run}`]);
  const fresh = mine.filter((a) => a.treeHash === ctx.tree);
  if (!fresh.length) return fail([`${c.id}: the ${want} artefact is from an older tree (${mine[0].treeHash.slice(0, 10) || 'no tree hash'}), not the current one (${ctx.tree.slice(0, 10)}); run it again.${run}`]);
  const good = fresh.filter((a) => a.passed !== false);
  if (!good.length) return fail([`${c.id}: the ${want} artefact on the current tree records a failed check; fix the behaviour and run it again.${run}`]);
  return pass(`${good[0].rel} on the current tree${good[0].passed === null ? ' (no pass/fail field; the write-up shows it for review)' : ''}`);
}

function artefactsDigest(runDir: string): string {
  const parts: string[] = [];
  for (const a of listArtefacts(runDir)) {
    try {
      const st = fs.statSync(path.join(runDir, a.rel));
      parts.push(`${a.rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* gone */
    }
  }
  return sha256(parts.join('\n'));
}

export function e2eSteps(ctx: GateContext): StepDef[] {
  const list = e2eCriteria(ctx);
  if (!list.length) {
    const why = ctx.brief ? 'the brief has no api or db checks for this repository' : 'no brief for this task, so no api or db checks';
    return [{ name: 'e2e', design: 8, group: 'e2e', cacheFail: false, inputs: () => null, run: () => skip(why) }];
  }
  return list.map(({ c, kind }) => ({
    name: `e2e:${c.id}`,
    design: 8,
    group: 'e2e',
    cacheFail: true,
    inputs: (x: GateContext) => [x.tree, artefactsDigest(x.runDir), JSON.stringify(c.check ?? null)],
    run: (x: GateContext) => e2eOutcome(x, c, kind),
  }));
}

/** Evidence references for every artefact in the run folder. */
export function artefactRefs(runDir: string): E2EArtifactRef[] {
  return listArtefacts(runDir).map((a) => ({ id: a.id, kind: a.kind, path: a.rel, treeHash: a.treeHash, createdAt: a.createdAt }));
}
