/**
 * The repos a write-up covers and the write-up files for one brief. Shared by
 * `harness writeup` (on request) and `harness gate` (automatically, after a
 * full run). One write-up per touched repo, each saved as
 * runs/<repoId>/<taskId>/writeup.md.
 */
import * as path from 'node:path';
import type { Setting } from '../types';
import { repoIdFor } from '../lib/config';
import { writeTextAtomic } from '../lib/fsx';
import { runDir, type BriefFile } from './brief';
import { UNMAPPED } from './units';
import { gatherRepoWork, renderWriteup, type RepoWork } from './writeup';

export interface Candidate {
  id: string;
  name: string;
  path?: string;
}

/** Candidate repos: the brief's mapped repos, plus the repo we run from; the touched ones, in landing order. */
export function pickTouched(brief: BriefFile, root: string | null | undefined): { cands: Candidate[]; touched: RepoWork[] } {
  const cands: Candidate[] = [];
  for (const r of brief.repos) {
    const info = brief.repoMap.repos[r];
    cands.push({ id: info ? repoIdFor(info.path) : r, name: info?.name ?? r, ...(info ? { path: info.path } : {}) });
  }
  if (root && !cands.some((c) => c.path && path.resolve(c.path) === path.resolve(root))) {
    const id = repoIdFor(root);
    if (!cands.some((c) => c.id === id)) cands.push({ id, name: path.basename(root), path: root });
  }
  if (!cands.length) cands.push({ id: UNMAPPED, name: 'unmapped repo' });

  const all: RepoWork[] = cands.map((c) => gatherRepoWork(brief, c.id, c.name, c.path));
  let touched = all.filter((w) => w.changes.length || w.evidence);
  if (!touched.length) touched = all.filter((w) => brief.repos.includes(w.repoId)).length ? all.filter((w) => brief.repos.includes(w.repoId)) : all.slice(0, 1);
  const order = (w: RepoWork) => {
    const i = brief.landingOrder.indexOf(w.repoId);
    return i < 0 ? 1e6 : i;
  };
  touched.sort((a, b) => order(a) - order(b));
  return { cands, touched };
}

/** Write the write-up of every touched repo to its run folder. Returns the texts and the files (null for an unmapped repo). */
export function writeAll(brief: BriefFile, setting: Setting, touched: RepoWork[]): Array<{ work: RepoWork; text: string; file: string | null }> {
  const out: Array<{ work: RepoWork; text: string; file: string | null }> = [];
  for (const w of touched) {
    const text = renderWriteup({ brief, setting, repos: touched }, w);
    let file: string | null = null;
    if (w.repoId !== UNMAPPED) {
      file = path.join(runDir(w.repoId, brief.id), 'writeup.md');
      writeTextAtomic(file, text);
    }
    out.push({ work: w, text, file });
  }
  return out;
}
