/**
 * A record of the agent files (instructions, skills, rules, workflows, agent
 * settings) as they are at one moment, kept under the harness home, so the
 * user can see later what was added, changed or removed since, whoever made
 * the change: the user, an agent, or the harness. The same inventory as
 * `harness assess`. Recording is the user's: an agent re-recording after its
 * own edits would hide them (the guard denies `harness changes record`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, Setting } from '../types';
import { runAssess } from '../assess';
import { ensureDir, readJsonOr, writeJson } from '../lib/fsx';
import { harnessHome } from '../lib/paths';
import { sha256File } from '../lib/hash';
import { unifiedDiff } from '../discover/diff';

/** Text files larger than this are recorded by hash only (no copy, so no line diff). */
const MAX_COPY_BYTES = 1024 * 1024;

export interface AgentFileEntry {
  path: string;
  display: string;
  kind: string;
  sha: string;
  bytes: number;
  /** File name of the copy inside the record folder; absent for binary or large files. */
  copy?: string;
}

export interface AgentFilesRecord {
  version: 1;
  recordedAt: string;
  workspace: string;
  /** What recorded it: `user` (harness changes record) or `install`. */
  by: 'user' | 'install';
  files: AgentFileEntry[];
}

export type AgentFileChange =
  | { change: 'added'; path: string; display: string; kind: string }
  | { change: 'changed'; path: string; display: string; kind: string; copy?: string }
  | { change: 'removed'; path: string; display: string; kind: string; copy?: string };

export function agentFilesDir(): string {
  return path.join(harnessHome(), 'agentfiles');
}

function recordPath(): string {
  return path.join(agentFilesDir(), 'record.json');
}

export function loadAgentFilesRecord(): AgentFilesRecord | null {
  const r = readJsonOr<AgentFilesRecord | null>(recordPath(), null);
  return r && r.version === 1 && Array.isArray(r.files) ? r : null;
}

export interface InventoryOptions {
  workspace: string;
  setting: Setting;
  agents: AgentId[];
  includes?: string[];
}

function inventory(o: InventoryOptions): Array<{ abs: string; display: string; kind: string; sha: string; bytes: number; text: string | null }> {
  const { ctx } = runAssess({ workspace: o.workspace, setting: o.setting, agents: o.agents, includes: o.includes });
  // assess labels workflows by the Cascade name they came from; here they are just workflows
  const kindOf = (f: (typeof ctx.files)[number]): string => (/workflow/i.test(f.label ?? '') ? 'workflow' : f.kind);
  return ctx.files.map((f) => ({ abs: path.resolve(f.abs), display: f.display, kind: kindOf(f), sha: f.sha256, bytes: f.bytes, text: f.binary ? null : f.text }));
}

/** Record the agent files as they are now, replacing the previous record. */
export function recordAgentFiles(o: InventoryOptions & { by: AgentFilesRecord['by']; now?: Date }): AgentFilesRecord {
  const dir = agentFilesDir();
  const copies = path.join(dir, 'copies');
  fs.rmSync(copies, { recursive: true, force: true });
  ensureDir(copies);
  const files: AgentFileEntry[] = [];
  for (const f of inventory(o)) {
    const e: AgentFileEntry = { path: f.abs, display: f.display, kind: f.kind, sha: f.sha, bytes: f.bytes };
    if (f.text !== null && f.bytes <= MAX_COPY_BYTES) {
      e.copy = `${f.sha.slice(0, 16)}-${files.length}.txt`;
      fs.writeFileSync(path.join(copies, e.copy), f.text);
    }
    files.push(e);
  }
  const rec: AgentFilesRecord = { version: 1, recordedAt: (o.now ?? new Date()).toISOString(), workspace: path.resolve(o.workspace), by: o.by, files };
  writeJson(recordPath(), rec);
  return rec;
}

/** What differs between the record and the agent files now. */
export function agentFileChanges(rec: AgentFilesRecord, o: InventoryOptions): AgentFileChange[] {
  const now = inventory(o);
  const was = new Map(rec.files.map((f) => [f.path, f]));
  const out: AgentFileChange[] = [];
  const seen = new Set<string>();
  for (const f of now) {
    seen.add(f.abs);
    const old = was.get(f.abs);
    if (!old) out.push({ change: 'added', path: f.abs, display: f.display, kind: f.kind });
    else if (old.sha !== f.sha) out.push({ change: 'changed', path: f.abs, display: f.display, kind: f.kind, copy: old.copy });
  }
  for (const old of rec.files) {
    if (seen.has(old.path)) continue;
    // the inventory may skip a file it could not read; only a file that is gone is removed
    if (sha256File(old.path) !== null) continue;
    out.push({ change: 'removed', path: old.path, display: old.display, kind: old.kind, copy: old.copy });
  }
  return out.sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
}

function readCopy(copy: string | undefined): string | null {
  if (!copy) return null;
  try {
    return fs.readFileSync(path.join(agentFilesDir(), 'copies', copy), 'utf8');
  } catch {
    return null;
  }
}

/** The diff from the recorded copy to the file now; '' when there is no copy to compare. */
export function agentFileDiff(c: AgentFileChange): string {
  if (c.change === 'added') {
    try {
      const b = fs.readFileSync(c.path);
      return b.includes(0) || b.length > MAX_COPY_BYTES ? '' : unifiedDiff(c.display, null, b.toString('utf8'));
    } catch {
      return '';
    }
  }
  const before = readCopy(c.copy);
  if (before === null) return '';
  if (c.change === 'removed') return unifiedDiff(c.display, before, '');
  try {
    return unifiedDiff(c.display, before, fs.readFileSync(c.path, 'utf8'));
  } catch {
    return '';
  }
}

export function formatAgentFileChanges(rec: AgentFilesRecord | null, changes: AgentFileChange[], opts: { diff?: boolean; harnessAsLeft?: Set<string> } = {}): string {
  if (!rec) return 'Agent files: not recorded yet. Run `harness changes record` to record them as they are now; later runs of `harness changes` then list every instruction, skill, rule or workflow file added, changed or removed since, by anyone.\n';
  const lines = [`Agent files since the record of ${rec.recordedAt} (${rec.by === 'install' ? 'taken by install' : 'taken by you'}; ${rec.files.length} file${rec.files.length === 1 ? '' : 's'} then), by anyone:`];
  if (!changes.length) lines.push('  none added, changed or removed.');
  for (const c of changes) {
    lines.push(`  ${c.change.padEnd(8)} ${c.display}  (${c.kind})`);
    const byHarness = opts.harnessAsLeft?.has(path.resolve(c.path));
    lines.push(byHarness ? '    by: the harness (its reasons are listed above)' : '    by: not the harness (you or an agent); no reason is recorded, the diff shows what changed');
    if (opts.diff) {
      const d = agentFileDiff(c);
      if (d) lines.push(...d.trimEnd().split('\n').map((l) => `    ${l}`));
      else if (c.change !== 'added') lines.push('    (no copy recorded: binary or larger than 1 MB)');
    }
  }
  if (changes.length) lines.push('When the changes are as you want them, `harness changes record` makes now the new starting point.');
  return lines.join('\n') + '\n';
}
