/**
 * Where plans live and how a `--plan <id|path>` argument is resolved.
 *
 *   ~/.harness/plans/<planId>.json      (ARCHITECTURE §5)
 *
 * `propose` writes plans here; `apply` reads them. A path argument that points
 * at an existing file is read as a plan directly, so a plan can also be handed
 * over as a file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../types';
import { isFile, readJsonOr, writeJson } from '../lib/fsx';
import { harnessHome } from '../lib/paths';

export function plansDir(): string {
  return path.join(harnessHome(), 'plans');
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_') || 'x';
}

export function planFilePath(planId: string): string {
  return path.join(plansDir(), `${safeId(planId)}.json`);
}

export function savePlan(plan: Plan): string {
  const p = planFilePath(plan.id);
  writeJson(p, plan);
  return p;
}

function isPlan(v: unknown): v is Plan {
  const p = v as Plan;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && Array.isArray(p.targets) && (p.setting === 'team' || p.setting === 'personal');
}

/** Plan ids on disk, newest first by createdAt. */
export function listPlans(): Array<{ id: string; createdAt: string; setting: Plan['setting']; file: string }> {
  const out: Array<{ id: string; createdAt: string; setting: Plan['setting']; file: string }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(plansDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  for (const n of names) {
    const file = path.join(plansDir(), n);
    const p = readJsonOr<unknown>(file, null);
    if (isPlan(p)) out.push({ id: p.id, createdAt: p.createdAt ?? '', setting: p.setting, file });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * Resolve `--plan`: an existing file path wins, then `plans/<id>.json`.
 * When nothing is given and exactly one plan exists, that one is used.
 */
export function loadPlanRef(ref?: string): { ok: true; plan: Plan; file: string } | { ok: false; error: string } {
  if (ref) {
    const candidates = [path.resolve(ref), planFilePath(ref)];
    for (const c of candidates) {
      if (!isFile(c)) continue;
      const v = readJsonOr<unknown>(c, null);
      if (!isPlan(v)) return { ok: false, error: `${c} is not a plan file (expected id, setting and targets)` };
      return { ok: true, plan: v, file: c };
    }
    return { ok: false, error: `no plan "${ref}": not a file, and ${planFilePath(ref)} does not exist` };
  }
  const all = listPlans();
  if (all.length === 1) return loadPlanRef(all[0].file);
  if (!all.length) return { ok: false, error: `no plans in ${plansDir()}; run \`harness propose\` first, or pass --plan <path>` };
  return { ok: false, error: `several plans exist; pass --plan <id>: ${all.map((p) => p.id).join(', ')}` };
}
