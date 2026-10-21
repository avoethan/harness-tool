/**
 * Size gate (team intake, fourth step): split a ticket into units sized for a
 * short horizon and put dependent units in sequence.
 *
 * - A unit touches one repo. Criteria are grouped by repo, then by area: the
 *   directory cluster of a path the criterion names, else the resource of its
 *   route, else its table, else `general`.
 * - Each criterion has an estimated file count (named paths, else a small
 *   number by kind, test file included). A unit stays at or under
 *   `maxFiles` (default 5); a larger area is split.
 * - Order: database work before the API and code that read it, API before
 *   UI; within a layer, the ticket's order. A unit depends on an earlier unit
 *   that shares its resource (route segment or table, singular/plural
 *   folded; across repos only the next layer down), on the other repo's
 *   part of a criterion that spans repos, or, for a unit in another repo that
 *   names no resource at all, on the layer below it (sequence when unsure).
 * - The landing order lists repos by their first unit.
 *
 * Pure: no I/O.
 */
import type { CriterionKind, Unit } from '../types';
import type { CriterionFacts } from './classify';

export const DEFAULT_MAX_FILES = 5;

export interface UnitInput {
  id: string;
  kind: CriterionKind;
  /** Repo ids; empty means not mapped yet. */
  repos: string[];
  facts: Pick<CriterionFacts, 'paths' | 'routes' | 'tables'>;
}

export interface UnitPlan {
  units: Unit[];
  /** Repo ids in the order their changes should land. */
  landingOrder: string[];
  /** Estimated files per unit id. */
  estimates: Record<string, number>;
}

export const UNMAPPED = 'unmapped';

const BASE_FILES: Record<CriterionKind, number> = { unit: 2, api: 3, db: 2, 'ui-artifact': 3, nonfunctional: 2, untestable: 2 };
const LAYER: Record<CriterionKind, number> = { db: 0, api: 1, unit: 1, nonfunctional: 2, 'ui-artifact': 2, untestable: 2 };

function fold(s: string): string {
  return s.toLowerCase().replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
}

function resources(f: UnitInput['facts']): string[] {
  const out = new Set<string>();
  for (const r of f.routes) {
    const seg = r.path.split(/[/?]/).filter((s) => s && !/^(api|v\d+|:\w+|\{\w+\})$/i.test(s))[0];
    if (seg) out.add(fold(seg));
  }
  for (const t of f.tables) out.add(fold(t));
  return [...out];
}

function areaOf(f: UnitInput['facts'], repoName: string): string {
  const p = f.paths[0];
  if (p) {
    let segs = p.split('/').filter(Boolean);
    const idx = segs.findIndex((s) => s.toLowerCase() === repoName.toLowerCase());
    if (idx >= 0) segs = segs.slice(idx + 1);
    const dirs = segs.length > 1 ? segs.slice(0, -1) : segs;
    return dirs.slice(0, 2).join('/') || 'general';
  }
  for (const r of f.routes) {
    const seg = r.path.split(/[/?]/).filter((s) => s && !/^(api|v\d+|:\w+|\{\w+\})$/i.test(s))[0];
    if (seg) return seg.toLowerCase();
  }
  return f.tables[0]?.toLowerCase() ?? 'general';
}

interface Item {
  id: string;
  kind: CriterionKind;
  repo: string;
  area: string;
  files: number;
  paths: string[];
  res: string[];
  layer: number;
  order: number;
}

/** Split criteria into units and order them. `repoNames` maps repo id -> display name. */
export function planUnits(inputs: UnitInput[], repoNames: Record<string, string> = {}, opts: { maxFiles?: number } = {}): UnitPlan {
  const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_FILES);
  const items: Item[] = [];
  inputs.forEach((c, order) => {
    const repos = c.repos.length ? c.repos : [UNMAPPED];
    for (const repo of repos) {
      const name = repoNames[repo] ?? repo;
      items.push({
        id: c.id,
        kind: c.kind,
        repo,
        area: areaOf(c.facts, name),
        files: Math.max(c.facts.paths.length + (c.facts.paths.length ? 1 : 0), BASE_FILES[c.kind]),
        paths: c.facts.paths,
        res: resources(c.facts),
        layer: LAYER[c.kind],
        order,
      });
    }
  });

  // Group by repo + area, keeping first-seen order.
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const k = `${it.repo}\u0001${it.area}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }

  interface Draft {
    repo: string;
    area: string;
    items: Item[];
    files: number;
  }
  const drafts: Draft[] = [];
  for (const list of groups.values()) {
    // Pack in layer order so a split keeps the database part first.
    const sorted = [...list].sort((a, b) => a.layer - b.layer || a.order - b.order);
    let cur: Draft | null = null;
    for (const it of sorted) {
      if (!cur || cur.files + it.files > maxFiles) {
        cur = { repo: it.repo, area: it.area, items: [], files: 0 };
        drafts.push(cur);
      }
      cur.items.push(it);
      cur.files += it.files;
    }
  }

  const layerOf = (d: Draft) => Math.min(...d.items.map((i) => i.layer));
  const firstOrder = (d: Draft) => Math.min(...d.items.map((i) => i.order));
  const repoRank = new Map<string, number>();
  for (const it of items) if (!repoRank.has(it.repo)) repoRank.set(it.repo, repoRank.size);
  drafts.sort((a, b) => layerOf(a) - layerOf(b) || firstOrder(a) - firstOrder(b) || (repoRank.get(a.repo)! - repoRank.get(b.repo)!));

  const units: Unit[] = [];
  const estimates: Record<string, number> = {};
  drafts.forEach((d, i) => {
    const id = `U${i + 1}`;
    const criteria = [...new Set(d.items.map((x) => x.id))];
    const name = repoNames[d.repo] ?? d.repo;
    const deps = new Set<string>();
    for (let j = 0; j < i; j++) {
      const e = drafts[j];
      const eid = `U${j + 1}`;
      // A lower-layer item that shares a resource; across repos only the next layer down counts
      // (a UI calls the API, the API reads the shared table).
      const sharesLower = d.items.some((di) =>
        e.items.some((ei) => ei.layer < di.layer && (e.repo === d.repo || di.layer - ei.layer === 1) && ei.res.some((r) => di.res.includes(r))),
      );
      const crossPart = e.repo !== d.repo && e.items.some((x) => criteria.includes(x.id));
      // A consumer in another repo that names no resource at all waits for the layer below it (sequence when unsure).
      const unknownConsumer = e.repo !== d.repo && d.items.every((di) => di.res.length === 0) && d.items.some((di) => e.items.some((ei) => di.layer - ei.layer === 1));
      if (sharesLower || unknownConsumer || (crossPart && layerOf(e) <= layerOf(d))) deps.add(eid);
    }
    units.push({
      id,
      title: `${name}: ${d.area} (${criteria.join(', ')})`,
      repo: d.repo,
      paths: [...new Set(d.items.flatMap((x) => x.paths))],
      dependsOn: [...deps],
      criteria,
    });
    estimates[id] = d.files;
  });

  const landingOrder: string[] = [];
  for (const u of units) if (!landingOrder.includes(u.repo)) landingOrder.push(u.repo);
  return { units, landingOrder, estimates };
}
