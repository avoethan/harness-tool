/**
 * The hand-written layer of the feature map: recipes and gotchas keyed by
 * route id (`POST /orders`) and migration id (`0003_add-orders-updated-at`),
 * one file per repository at `~/.harness/featuremap/<repoId>/overlay.json`
 * (the gate's map-drift step reads the same file; see src/gate/README.md).
 *
 *   { "version": 1,
 *     "entries": {
 *       "POST /orders": { "kind": "route", "file": "src/routes/orders.ts", "service": "orders-api",
 *         "fingerprint": "...", "statuses": [201],
 *         "recipe": { "body": {...}, "params": {...}, "auth": "<user>", "expectStatus": 201,
 *                     "expect": { "order.status": "pending" },
 *                     "db": [{ "table": "orders", "where": { "id": "{{last.order.id}}" }, "expect": { "status": "pending" } }] },
 *         "gotchas": ["..."] },
 *       "0003_add-orders-updated-at": { "kind": "migration", "file": "migrations/0003_add-orders-updated-at.sql", "sha256": "..." } },
 *     "users": { "<name>": { "service": "...", "login": { "route": "POST /auth/login", "body": {...}, "tokenPath": "token",
 *                                                         "header": "authorization", "scheme": "Bearer" } } },
 *     "services": { "<name>": { "start": "dev", "health": "/health", "readyTimeoutMs": 60000 } },
 *     "dbRecipes": { "<name>": { "sql": "SELECT id, status FROM dbo.orders WHERE id = @id", "params": { "id": "{{last.order.id}}" },
 *                                "expectRows": 1, "expect": { "status": "pending" } } } }
 *
 * `verify maintain` re-derives the inventory and reports each entry as
 * clean / changed / blocked (and the inventory ids with no entry as
 * missing). It writes only this file, and only when asked (`--add-missing`,
 * `--accept`); it never touches product code.
 */
import * as path from 'node:path';
import { readJsonOr, writeJson } from '../lib/fsx';
import { harnessHome } from '../lib/paths';
import { overlayHasRoute } from '../gate/mapdrift';
import type { FeatureMap, MigrationEntry, RouteEntry } from './featuremap';
import { migrationsOfRepo, routesOfRepo } from './featuremap';
import { legacyOverlayPath, overlayPath } from './state';

export interface RouteRecipe {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: string;
  expectStatus?: number;
  expect?: Record<string, unknown>;
  db?: Array<{ table: string; where?: Record<string, unknown>; expect?: Record<string, unknown>; expectRows?: number }>;
}

export interface OverlayEntry {
  kind?: 'route' | 'migration';
  file?: string;
  service?: string;
  fingerprint?: string;
  statuses?: number[];
  sha256?: string;
  tables?: string[];
  recipe?: RouteRecipe | null;
  gotchas?: string[];
  reviewed?: boolean;
  addedBy?: 'maintain' | 'user';
  /** Why the entry needs no recipe (e.g. internal health route). */
  noRecipeReason?: string;
}

export interface LoginRecipe {
  route: string;
  body?: unknown;
  /** JSON path of the token in the login response (default `token`). */
  tokenPath?: string;
  /** Header the token goes in (default `authorization`). */
  header?: string;
  /** Prefix (default `Bearer`; empty for a raw token). */
  scheme?: string;
  /** Use the response's Set-Cookie instead of a token field. */
  cookie?: boolean;
}

export interface DbRecipe {
  sql: string;
  params?: Record<string, unknown>;
  expectRows?: number;
  expect?: Record<string, unknown>;
  /** Columns to store in the artefact (default: the ones `expect` names). */
  columns?: string[];
}

export interface Overlay {
  version: 1;
  entries: Record<string, OverlayEntry>;
  users?: Record<string, { service?: string; login: LoginRecipe }>;
  services?: Record<string, { start?: string; health?: string; readyTimeoutMs?: number; env?: Record<string, string> }>;
  dbRecipes?: Record<string, DbRecipe>;
}

export function emptyOverlay(): Overlay {
  return { version: 1, entries: {} };
}

/** Read a repository's overlay (the gate's location first, then the older one). */
export function loadOverlay(repoId: string): { overlay: Overlay; exists: boolean; file: string } {
  const p = overlayPath(repoId);
  for (const f of [p, legacyOverlayPath(repoId)]) {
    const raw = readJsonOr<Partial<Overlay> | null>(f, null);
    if (raw && typeof raw === 'object') {
      const entries: Record<string, OverlayEntry> = {};
      const take = (v: unknown, kind?: 'route' | 'migration') => {
        if (Array.isArray(v)) {
          for (const e of v) if (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') entries[(e as { id: string }).id] = { kind, ...(e as OverlayEntry) };
        } else if (v && typeof v === 'object') for (const [id, e] of Object.entries(v as Record<string, OverlayEntry>)) entries[id] = { kind, ...(e && typeof e === 'object' ? e : {}) };
      };
      take(raw.entries);
      take((raw as Record<string, unknown>).routes, 'route');
      take((raw as Record<string, unknown>).migrations, 'migration');
      return { overlay: { ...(raw as Overlay), version: 1, entries }, exists: true, file: f };
    }
  }
  return { overlay: emptyOverlay(), exists: false, file: p };
}

export function saveOverlay(repoId: string, o: Overlay): string {
  const p = overlayPath(repoId);
  const out: Overlay = { ...o, version: 1, entries: Object.fromEntries(Object.entries(o.entries).sort(([a], [b]) => a.localeCompare(b))) };
  delete (out as unknown as Record<string, unknown>).routes;
  delete (out as unknown as Record<string, unknown>).migrations;
  writeJson(p, out);
  return p;
}

export function featureMapDirOf(repoId: string): string {
  return path.join(harnessHome(), 'featuremap', repoId);
}

// ---------------------------------------------------------------------------
// Drift and maintain
// ---------------------------------------------------------------------------

function entryList(o: Overlay): Array<{ id: string; file?: string }> {
  return Object.entries(o.entries).map(([id, e]) => ({ id, file: e.file }));
}

/** Whether an inventory route has an overlay entry (exact id, else the gate's matching rule). */
export function routeCovered(o: Overlay, r: RouteEntry): boolean {
  if (o.entries[r.id]) return true;
  return overlayHasRoute(entryList(o), { method: r.method, path: r.localPath, file: r.file }) || overlayHasRoute(entryList(o), { method: r.method, path: r.path, file: r.file });
}

export interface DriftReport {
  repoId: string;
  routes: string[];
  migrations: string[];
  /** Same ids with their files, for people. */
  details: string[];
  overlayExists: boolean;
}

/** Route and migration ids of a repository with no overlay entry. */
export function drift(map: FeatureMap, repoId: string, o: Overlay, exists = true): DriftReport {
  const routes: string[] = [];
  const migrations: string[] = [];
  const details: string[] = [];
  for (const r of routesOfRepo(map, repoId)) {
    if (routeCovered(o, r)) continue;
    if (!routes.includes(r.id)) {
      routes.push(r.id);
      details.push(`${r.id} (${r.file}:${r.line})`);
    }
  }
  for (const m of migrationsOfRepo(map, repoId)) {
    if (o.entries[m.id]) continue;
    migrations.push(m.id);
    details.push(`migration ${m.id} (${m.file})`);
  }
  return { repoId, routes, migrations, details, overlayExists: exists };
}

export type MaintainOutcome = 'clean' | 'changed' | 'blocked' | 'missing';

export interface MaintainItem {
  id: string;
  kind: 'route' | 'migration' | 'unknown';
  outcome: MaintainOutcome;
  reasons: string[];
}

function findInventoryRoute(map: FeatureMap, repoId: string, id: string, e: OverlayEntry): RouteEntry | null {
  const routes = routesOfRepo(map, repoId);
  const exact = routes.find((r) => r.id === id);
  if (exact) return exact;
  return routes.find((r) => overlayHasRoute([{ id, file: e.file }], { method: r.method, path: r.localPath, file: r.file })) ?? null;
}

/** Compare every overlay entry with the freshly derived inventory. */
export function maintainDiff(map: FeatureMap, repoId: string, o: Overlay): MaintainItem[] {
  const items: MaintainItem[] = [];
  const migs = new Map<string, MigrationEntry>(migrationsOfRepo(map, repoId).map((m) => [m.id, m]));
  const services = new Set(map.services.map((s) => s.name));
  for (const [id, e] of Object.entries(o.entries).sort(([a], [b]) => a.localeCompare(b))) {
    const isRoute = /^[A-Za-z]+\s+\S+$/.test(id) && e.kind !== 'migration';
    if (isRoute) {
      const r = findInventoryRoute(map, repoId, id, e);
      const reasons: string[] = [];
      if (!r) {
        items.push({ id, kind: 'route', outcome: 'blocked', reasons: [`no registration of ${id} is found in the code any more${e.file ? ` (was in ${e.file})` : ''}; remove the entry or point it at the new route`] });
        continue;
      }
      if (e.recipe?.auth && !o.users?.[e.recipe.auth]) {
        items.push({ id, kind: 'route', outcome: 'blocked', reasons: [`the recipe signs in as "${e.recipe.auth}", which has no login recipe under "users"`] });
        continue;
      }
      if (e.service && !services.has(e.service)) {
        items.push({ id, kind: 'route', outcome: 'blocked', reasons: [`the service ${e.service} is not in the workspace any more`] });
        continue;
      }
      if (e.file && e.file !== r.file) reasons.push(`handler moved: ${e.file} -> ${r.file}`);
      if (e.fingerprint && e.fingerprint !== r.fingerprint) {
        const before = (e.statuses ?? []).join(',');
        const now = r.statuses.join(',');
        if (before !== now) reasons.push(`status codes in the handler changed: ${before || '?'} -> ${now}`);
        else if (!reasons.length) reasons.push('the registration changed (path, method or file)');
      }
      const exp = e.recipe?.expectStatus;
      if (exp !== undefined && !r.statuses.includes(exp)) reasons.push(`the recipe expects ${exp}, which the handler no longer shows (${r.statuses.join(',')})`);
      if (!e.fingerprint && !reasons.length) {
        items.push({ id, kind: 'route', outcome: 'clean', reasons: ['no fingerprint recorded yet (`harness verify maintain --accept <id>` records it)'] });
        continue;
      }
      items.push({ id, kind: 'route', outcome: reasons.length ? 'changed' : 'clean', reasons });
      continue;
    }
    const m = migs.get(id);
    if (!m) {
      items.push({ id, kind: e.kind === 'migration' ? 'migration' : 'unknown', outcome: 'blocked', reasons: [`no migration or route with id ${id} exists in this repository`] });
      continue;
    }
    if (e.sha256 && e.sha256 !== m.sha256) items.push({ id, kind: 'migration', outcome: 'changed', reasons: [`${m.file} changed since the entry was reviewed`] });
    else items.push({ id, kind: 'migration', outcome: 'clean', reasons: e.sha256 ? [] : ['no hash recorded yet'] });
  }
  const d = drift(map, repoId, o);
  for (const id of d.routes) items.push({ id, kind: 'route', outcome: 'missing', reasons: ['no overlay entry (the gate fails map-drift for it when a change touches it)'] });
  for (const id of d.migrations) items.push({ id, kind: 'migration', outcome: 'missing', reasons: ['no overlay entry'] });
  return items;
}

/** Skeleton entries for inventory ids with no entry (no recipe: a person writes it). */
export function addMissing(map: FeatureMap, repoId: string, o: Overlay, only?: string[]): string[] {
  const added: string[] = [];
  const d = drift(map, repoId, o);
  for (const r of routesOfRepo(map, repoId)) {
    if (!d.routes.includes(r.id) || (only && !only.includes(r.id)) || o.entries[r.id]) continue;
    o.entries[r.id] = { kind: 'route', file: r.file, service: r.service, fingerprint: r.fingerprint, statuses: r.statuses, recipe: null, reviewed: false, addedBy: 'maintain' };
    added.push(r.id);
  }
  for (const m of migrationsOfRepo(map, repoId)) {
    if (!d.migrations.includes(m.id) || (only && !only.includes(m.id)) || o.entries[m.id]) continue;
    o.entries[m.id] = { kind: 'migration', file: m.file, service: m.service, sha256: m.sha256, tables: m.tables, reviewed: false, addedBy: 'maintain' };
    added.push(m.id);
  }
  return added;
}

/** Record the current inventory facts on reviewed entries (after a person checked a `changed` one). */
export function acceptEntries(map: FeatureMap, repoId: string, o: Overlay, ids: string[] | 'all'): string[] {
  const done: string[] = [];
  const migs = new Map(migrationsOfRepo(map, repoId).map((m) => [m.id, m]));
  for (const [id, e] of Object.entries(o.entries)) {
    if (ids !== 'all' && !ids.includes(id)) continue;
    const r = findInventoryRoute(map, repoId, id, e);
    if (r) {
      e.kind = 'route';
      e.file = r.file;
      e.service = r.service;
      e.fingerprint = r.fingerprint;
      e.statuses = r.statuses;
      e.reviewed = true;
      done.push(id);
      continue;
    }
    const m = migs.get(id);
    if (m) {
      e.kind = 'migration';
      e.file = m.file;
      e.sha256 = m.sha256;
      e.tables = m.tables;
      e.reviewed = true;
      done.push(id);
    }
  }
  return done;
}
