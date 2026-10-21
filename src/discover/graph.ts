/**
 * Graph scan per repository with the repository's own dependency-cruiser and
 * knip, when they are installed in its node_modules. The harness never
 * installs them; absence is reported. Runs use node + the package's bin
 * script (argv arrays, timeouts) from the repository root.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../lib/exec';
import type { RepoInventory } from './inventory';
import { resolveRepoBin } from './declared';

export interface GraphResult {
  repoId: string;
  tool: 'dependency-cruiser' | 'knip';
  available: boolean;
  ran: boolean;
  counts?: Record<string, number>;
  /** Known violations at discovery time (dependency-cruiser), for a baseline. */
  baseline?: unknown[];
  note: string;
}

function depcruiseBin(repo: string): string | null {
  for (const b of ['depcruise', 'dependency-cruise', 'dependency-cruiser']) {
    const p = resolveRepoBin(repo, 'dependency-cruiser', b);
    if (p) return p;
  }
  return null;
}

export function graphScan(inv: RepoInventory, opts: { exec: boolean; timeoutMs?: number }): GraphResult[] {
  const repo = inv.repo.path;
  const out: GraphResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 180000;
  const srcDirs = [...new Set(inv.files.filter((f) => f.kind === 'code' && !f.isTest).map((f) => f.rel.split('/')[0]))].filter((d) => fs.existsSync(path.join(repo, d)) && fs.statSync(path.join(repo, d)).isDirectory());

  const dc = depcruiseBin(repo);
  if (!dc) out.push({ repoId: inv.repo.id, tool: 'dependency-cruiser', available: false, ran: false, note: 'not installed in the repository (the harness never installs it); boundary rules come from the import probes only' });
  else if (!opts.exec) out.push({ repoId: inv.repo.id, tool: 'dependency-cruiser', available: true, ran: false, note: 'not run (--no-exec)' });
  else {
    const cfg = (inv.configs.dependencyCruiser ?? [])[0];
    const args = [dc, ...(cfg ? ['--config', cfg] : ['--no-config']), '--output-type', 'json', ...(srcDirs.length ? srcDirs : ['.'])];
    const r = run(process.execPath, args, { cwd: repo, timeoutMs, maxBuffer: 256 * 1024 * 1024 });
    try {
      const j = JSON.parse(r.stdout) as { summary?: { violations?: unknown[]; error?: number; warn?: number; info?: number; totalCruised?: number; totalDependenciesCruised?: number } };
      const s = j.summary ?? {};
      out.push({
        repoId: inv.repo.id,
        tool: 'dependency-cruiser',
        available: true,
        ran: true,
        counts: { modules: s.totalCruised ?? 0, dependencies: s.totalDependenciesCruised ?? 0, errors: s.error ?? 0, warnings: s.warn ?? 0, violations: (s.violations ?? []).length },
        baseline: s.violations ?? [],
        note: cfg ? `rules from ${cfg}` : 'no dependency-cruiser config in the repository: module and dependency counts only',
      });
    } catch {
      out.push({ repoId: inv.repo.id, tool: 'dependency-cruiser', available: true, ran: false, note: r.timedOut ? 'timed out' : `did not return JSON (exit ${r.code})` });
    }
  }

  const kn = resolveRepoBin(repo, 'knip', 'knip');
  if (!kn) out.push({ repoId: inv.repo.id, tool: 'knip', available: false, ran: false, note: 'not installed in the repository (the harness never installs it); unused files and exports are not counted' });
  else if (!opts.exec) out.push({ repoId: inv.repo.id, tool: 'knip', available: true, ran: false, note: 'not run (--no-exec)' });
  else {
    const r = run(process.execPath, [kn, '--reporter', 'json', '--no-exit-code'], { cwd: repo, timeoutMs, maxBuffer: 256 * 1024 * 1024 });
    try {
      const j = JSON.parse(r.stdout) as { files?: unknown[]; issues?: Array<Record<string, unknown>> };
      const counts: Record<string, number> = { unusedFiles: (j.files ?? []).length };
      for (const issue of j.issues ?? []) {
        for (const [k, v] of Object.entries(issue)) {
          if (Array.isArray(v)) counts[k] = (counts[k] ?? 0) + v.length;
          else if (v && typeof v === 'object') counts[k] = (counts[k] ?? 0) + Object.keys(v).length;
        }
      }
      out.push({ repoId: inv.repo.id, tool: 'knip', available: true, ran: true, counts, note: 'knip --reporter json' });
    } catch {
      out.push({ repoId: inv.repo.id, tool: 'knip', available: true, ran: false, note: r.timedOut ? 'timed out' : `did not return JSON (exit ${r.code})` });
    }
  }
  return out;
}
