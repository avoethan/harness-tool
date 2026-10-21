/**
 * `harness verify evidence`: the artefacts of the task's run folder and
 * whether each still proves the current tree (fresh) or an older one
 * (stale). The gate applies the same rule: only a fresh artefact that does
 * not record a failure counts.
 */
import { readArtefacts, currentTree, type ListedArtefact } from './artifact';

export interface EvidenceRow extends ListedArtefact {
  fresh: boolean;
}

export interface EvidenceReport {
  tree: string;
  rows: EvidenceRow[];
  fresh: number;
  stale: number;
  failed: number;
}

export function evidence(runDir: string, repoRoot: string, tree = currentTree(repoRoot)): EvidenceReport {
  const rows = readArtefacts(runDir).map((a) => ({ ...a, fresh: !!tree && a.treeHash === tree }));
  return { tree, rows, fresh: rows.filter((r) => r.fresh).length, stale: rows.filter((r) => !r.fresh).length, failed: rows.filter((r) => r.pass === false).length };
}

export function formatEvidence(r: EvidenceReport): string[] {
  const lines: string[] = [];
  if (!r.rows.length) {
    lines.push('No artefacts yet. Run the brief\'s `harness verify drive` / `harness verify db` lines.');
    return lines;
  }
  lines.push(`Current tree ${r.tree.slice(0, 12) || '(unknown)'}: ${r.fresh} fresh, ${r.stale} stale, ${r.failed} recording a failure`);
  for (const a of r.rows) {
    const state = a.fresh ? 'fresh' : 'stale';
    const verdict = a.pass === false ? 'FAIL' : a.pass === true ? 'pass' : 'no verdict';
    lines.push(`  ${state.padEnd(5)} ${verdict.padEnd(10)} ${a.rel}${a.criterion ? ` [${a.criterion}]` : ''}  ${a.summary}  (${a.createdAt || 'no time'})`);
  }
  if (r.stale) lines.push('Stale artefacts prove an older tree: run their commands again before the gate.');
  return lines;
}
