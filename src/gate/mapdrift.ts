/**
 * Step 7: feature-map drift. When the change touches route or migration
 * files and the feature-map overlay has no entry for an id they define,
 * FAIL with the exact ids; skip with a reason when there is no feature map.
 *
 * Interface with `harness verify` (the verify component owns the files; the
 * gate only reads them):
 *
 *   ~/.harness/featuremap/<repoId>/overlay.json
 *     { "version": 1,
 *       "entries": { "<id>": { "file"?: "<repo-relative path>", ... } } }
 *   Route ids are "<METHOD> <path>" (`GET /orders/:id`); migration ids are the
 *   migration file name without its extension (`0003_add-orders-total`).
 *   `routes` / `migrations` maps or arrays of `{ id }` are read as well.
 *
 * Ids come from the changed files themselves: every route registration
 * (`router.get('/x', ...)`, `app.post(...)`, `@app.get("/x")`) in a changed
 * route file, and every added or changed migration file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateContext } from './context';
import { isTestFile } from './context';
import { readJsonOr } from '../lib/fsx';
import { harnessHome } from '../lib/paths';
import { sha256 } from '../lib/hash';
import { entriesDigest } from './cache';
import { capReasons, fail, pass, skip, type StepDef, type StepOutcome } from './steps';

export function featureMapDir(repoId: string): string {
  return path.join(harnessHome(), 'featuremap', repoId);
}

export function overlayPath(repoId: string): string {
  return path.join(featureMapDir(repoId), 'overlay.json');
}

const ROUTE_RE = /(?:^|[^\w$.])(?:@?[A-Za-z_$][\w$]*\.)?(?:app|router|[A-Za-z_$][\w$]*Router|routes?|server|api)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`]+)\2/gi;
const MIGRATION_RE = /(^|\/)(?:migrations?|db\/migrate)\/[^/]+\.(?:sql|[cm]?[jt]s|py|rb)$/i;

export interface RouteId {
  method: string;
  path: string;
  file: string;
}

export function normalizeRoutePath(p: string): string {
  let out = p.trim().replace(/\{[^}]+\}|<[^>]+>|:[A-Za-z_][\w]*\??/g, ':param');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out || '/';
}

/** Route registrations in a source text. */
export function routesIn(text: string, file: string): RouteId[] {
  const out: RouteId[] = [];
  for (const m of text.matchAll(ROUTE_RE)) out.push({ method: m[1].toUpperCase(), path: m[3], file });
  return out;
}

export function isMigrationFile(rel: string): boolean {
  return MIGRATION_RE.test(rel.replace(/\\/g, '/'));
}

/** A route file: a source file that registers routes. */
export function isRouteFile(rel: string, text: string | null): boolean {
  if (!/\.(?:[cm]?[jt]sx?|py)$/i.test(rel) || /(^|\/)node_modules\//.test(rel) || isTestFile(rel)) return false;
  return !!text && routesIn(text, rel).length > 0;
}

export function migrationId(rel: string): string {
  return path.posix.basename(rel.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
}

interface OverlayEntry {
  id: string;
  file?: string;
}

/** Entries of an overlay file in any of the accepted shapes; null when there is none. */
export function readOverlay(repoId: string, file = overlayPath(repoId)): OverlayEntry[] | null {
  const raw = readJsonOr<Record<string, unknown> | null>(file, null);
  if (!raw || typeof raw !== 'object') return null;
  const out: OverlayEntry[] = [];
  const take = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const e of v) if (e && typeof e === 'object' && typeof (e as OverlayEntry).id === 'string') out.push({ id: (e as OverlayEntry).id, file: (e as OverlayEntry).file });
    } else if (v && typeof v === 'object') {
      for (const [id, e] of Object.entries(v as Record<string, unknown>)) out.push({ id, file: e && typeof e === 'object' && typeof (e as OverlayEntry).file === 'string' ? (e as OverlayEntry).file : undefined });
    }
  };
  take(raw.entries);
  take(raw.routes);
  take(raw.migrations);
  return out;
}

function splitRouteId(id: string): { method: string; path: string } | null {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(id);
  return m ? { method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]) } : null;
}

/** Whether the overlay covers a route (method and path; the overlay path may carry the router's mount prefix). */
export function overlayHasRoute(entries: OverlayEntry[], r: RouteId): boolean {
  const want = normalizeRoutePath(r.path);
  return entries.some((e) => {
    const s = splitRouteId(e.id);
    if (!s || (s.method !== r.method && s.method !== 'ALL')) return false;
    if (e.file && e.file.replace(/\\/g, '/') !== r.file) return false;
    return s.path === want || (want !== '/' && s.path.endsWith(want)) || (want === '/' && !!e.file);
  });
}

export interface DriftResult {
  routes: RouteId[];
  migrations: string[];
  missing: string[];
}

export function driftFor(ctx: Pick<GateContext, 'diff' | 'nowText'>, entries: OverlayEntry[]): DriftResult {
  const routes: RouteId[] = [];
  const migrations: string[] = [];
  for (const d of ctx.diff) {
    if (d.status === 'D') continue;
    if (isMigrationFile(d.path)) {
      migrations.push(migrationId(d.path));
      continue;
    }
    const text = ctx.nowText(d.path);
    if (text && isRouteFile(d.path, text)) routes.push(...routesIn(text, d.path));
  }
  const ids = new Set(entries.map((e) => e.id));
  const missing: string[] = [];
  for (const r of routes) if (!overlayHasRoute(entries, r)) missing.push(`${r.method} ${r.path} (${r.file})`);
  for (const m of migrations) if (!ids.has(m)) missing.push(`migration ${m}`);
  return { routes, migrations, missing: [...new Set(missing)] };
}

export function runMapDrift(ctx: GateContext): StepOutcome {
  const touches = ctx.diff.some((d) => d.status !== 'D' && (isMigrationFile(d.path) || isRouteFile(d.path, ctx.nowText(d.path))));
  if (!touches) return pass('no route or migration files changed');
  const entries = readOverlay(ctx.repoId);
  if (!entries) return skip('no feature map yet for this repository (no overlay: `harness verify maintain --add-missing` writes its skeleton entries; `verify launch` does not); route and migration changes were not checked against it');
  const r = driftFor(ctx, entries);
  if (r.missing.length) return fail(capReasons(r.missing.map((m) => `no feature-map entry for ${m}`)));
  return pass(`${r.routes.length} route(s) and ${r.migrations.length} migration(s) in changed files all have feature-map entries`);
}

export const mapDriftStep: StepDef = {
  name: 'map-drift',
  design: 7,
  group: 'map-drift',
  cacheFail: true,
  inputs: (ctx) => {
    const changed = new Set(ctx.changedPresent());
    let stamp = 'none';
    try {
      const st = fs.statSync(overlayPath(ctx.repoId));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      /* none */
    }
    return [entriesDigest(ctx.entries, (p) => changed.has(p)), sha256(stamp)];
  },
  run: runMapDrift,
};
