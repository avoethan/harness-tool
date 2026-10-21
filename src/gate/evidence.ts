/**
 * The evidence file the gate writes and the Stop hook reads:
 * ~/.harness/runs/<repoId>/<task>/evidence.json (EvidenceFile in src/types.ts).
 *
 * The Stop hook reads verdict, treeHash, reasons, attempt and cap_reached.
 * It sets `cap_reached` itself (or writes cap.json beside this file when the
 * gate never ran); the gate carries that marker over to every later run and
 * then refuses to report PASS for the task.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvidenceFile, GateStep, Verdict, E2EArtifactRef } from '../types';
import { readJsonOr, writeJson } from '../lib/fsx';

export function evidencePath(runDir: string): string {
  return path.join(runDir, 'evidence.json');
}

export function capPath(runDir: string): string {
  return path.join(runDir, 'cap.json');
}

/** The previous evidence of the task, when there is one shaped like evidence. */
export function readPrevious(runDir: string): EvidenceFile | null {
  const e = readJsonOr<Partial<EvidenceFile> | null>(evidencePath(runDir), null);
  if (!e || typeof e !== 'object' || e.version !== 1) return null;
  return {
    version: 1,
    repo: String(e.repo ?? ''),
    task: String(e.task ?? ''),
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined,
    verdict: e.verdict === 'PASS' || e.verdict === 'BLOCKED' ? e.verdict : 'FAIL',
    reasons: Array.isArray(e.reasons) ? e.reasons.map(String) : [],
    treeHash: typeof e.treeHash === 'string' ? e.treeHash : '',
    baseSha: typeof e.baseSha === 'string' ? e.baseSha : '',
    steps: Array.isArray(e.steps) ? (e.steps as GateStep[]) : [],
    attempt: typeof e.attempt === 'number' && Number.isFinite(e.attempt) ? e.attempt : 0,
    startedAt: String(e.startedAt ?? ''),
    finishedAt: String(e.finishedAt ?? ''),
    e2e: Array.isArray(e.e2e) ? (e.e2e as E2EArtifactRef[]) : [],
    phase: e.phase === 'implement' || e.phase === 'tests' ? e.phase : undefined,
    cap_reached: e.cap_reached === true ? true : undefined,
    cap_reached_at: typeof e.cap_reached_at === 'string' ? e.cap_reached_at : undefined,
  };
}

/** Whether the Stop hook marked the task as released by the attempt cap (in the evidence or in cap.json). */
export function capMarker(runDir: string, prev: EvidenceFile | null): { capped: boolean; at?: string } {
  if (prev?.cap_reached) return { capped: true, at: prev.cap_reached_at };
  const c = readJsonOr<{ cap_reached?: unknown; cap_reached_at?: unknown } | null>(capPath(runDir), null);
  if (c && c.cap_reached === true) return { capped: true, at: typeof c.cap_reached_at === 'string' ? c.cap_reached_at : undefined };
  return { capped: false };
}

export interface EvidenceInput {
  repo: string;
  task: string;
  sessionId?: string;
  verdict: Verdict;
  reasons: string[];
  treeHash: string;
  baseSha: string;
  steps: GateStep[];
  attempt: number;
  startedAt: string;
  finishedAt: string;
  e2e: E2EArtifactRef[];
  phase?: 'implement' | 'tests';
  cap?: { capped: boolean; at?: string };
}

export function buildEvidence(i: EvidenceInput): EvidenceFile {
  const ev: EvidenceFile = {
    version: 1,
    repo: i.repo,
    task: i.task,
    ...(i.sessionId ? { sessionId: i.sessionId } : {}),
    verdict: i.verdict,
    reasons: i.reasons,
    treeHash: i.treeHash,
    baseSha: i.baseSha,
    steps: i.steps,
    attempt: i.attempt,
    startedAt: i.startedAt,
    finishedAt: i.finishedAt,
    e2e: i.e2e,
    ...(i.phase ? { phase: i.phase } : {}),
  };
  if (i.cap?.capped) {
    ev.cap_reached = true;
    if (i.cap.at) ev.cap_reached_at = i.cap.at;
  }
  return ev;
}

export function writeEvidence(runDir: string, ev: EvidenceFile): string {
  fs.mkdirSync(runDir, { recursive: true });
  const p = evidencePath(runDir);
  writeJson(p, ev);
  return p;
}
