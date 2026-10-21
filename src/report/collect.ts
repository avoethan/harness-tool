/**
 * Read the harness state the report and `harness status` count. Every file
 * comes from HARNESS_HOME (default ~/.harness); nothing here reads a
 * repository, and nothing is written.
 *
 *   config.json                      setting, agents, workspace, repos, DB allowlist
 *   ledger/ledger.json               standards (tier, family, check mode and type)
 *   ledger/checks/index.json + specs the checks discovery generated
 *   assess/assess.json               findings and line classifications
 *   briefs/<id>.json                 tasks (criteria, questions asked)
 *   runs/<repoId>/<task>/            evidence.json, cap.json, e2e/*.json, phase.json, writeup.md
 *   logs/events.jsonl                instrumentation (names, ids, counts)
 *   lessons/<id>.json                learning-loop records
 *   proposals/<repoId>/<n>-*.md      team proposals
 *   worklog.csv                      the user's work log (optional)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AssessReport, EvidenceFile, HarnessConfig, InstrumentationEvent, Ledger, Lesson } from '../types';
import { harnessHome, ledgerPath, logsDir, runsDir } from '../lib/paths';
import { readJsonOr, readTextOr } from '../lib/fsx';
import { loadConfig } from '../lib/config';
import { listBriefs, type BriefFile } from '../intake/brief';
import { readWorklog, type Worklog } from './worklog';

export interface RunRecord {
  /** Repo id (folder under runs/). */
  repo: string;
  /** Task id (folder under runs/<repo>/). */
  task: string;
  evidence: EvidenceFile | null;
  /** cap.json: the attempt cap released the agent before any gate run. */
  capFile: boolean;
  /** E2E artefact files written by verify. */
  e2eFiles: number;
  writeup: boolean;
  phase?: string;
}

export interface CheckIndexEntry {
  id: string;
  ref?: string;
  type?: string;
  mode?: string;
}

export interface HarnessState {
  home: string;
  config: HarnessConfig | null;
  ledger: Ledger | null;
  /** ledger/checks/index.json records, when discovery wrote it. */
  checkIndex: CheckIndexEntry[] | null;
  /** Check spec files in ledger/checks (index.json not counted). */
  checkSpecs: number;
  assess: AssessReport | null;
  briefs: BriefFile[];
  runs: RunRecord[];
  events: InstrumentationEvent[];
  /** Lines of events.jsonl that did not parse. */
  badEventLines: number;
  lessons: Lesson[];
  /** Team proposal write-ups under proposals/. */
  proposals: number;
  worklog: Worklog | null;
  /** current-task pointer per repo id. */
  currentTasks: Record<string, string>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function readEvents(file: string = path.join(logsDir(), 'events.jsonl')): { events: InstrumentationEvent[]; bad: number } {
  const text = readTextOr(file, null);
  if (text === null) return { events: [], bad: 0 };
  const events: InstrumentationEvent[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as InstrumentationEvent;
      if (ev && typeof ev.event === 'string' && typeof ev.ts === 'string') events.push(ev);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

export function readRuns(): { runs: RunRecord[]; currentTasks: Record<string, string> } {
  const runs: RunRecord[] = [];
  const currentTasks: Record<string, string> = {};
  for (const r of listDir(runsDir())) {
    if (!r.isDirectory() || !ID_RE.test(r.name)) continue;
    const repoDir = path.join(runsDir(), r.name);
    const cur = (readTextOr(path.join(repoDir, 'current-task'), '') ?? '').trim();
    if (cur && ID_RE.test(cur)) currentTasks[r.name] = cur;
    for (const t of listDir(repoDir)) {
      if (!t.isDirectory() || !ID_RE.test(t.name)) continue;
      const dir = path.join(repoDir, t.name);
      const evidence = readJsonOr<EvidenceFile | null>(path.join(dir, 'evidence.json'), null);
      const phase = readJsonOr<{ phase?: string } | null>(path.join(dir, 'phase.json'), null);
      runs.push({
        repo: r.name,
        task: t.name,
        evidence: evidence && evidence.version === 1 && typeof evidence.verdict === 'string' ? evidence : null,
        capFile: fs.existsSync(path.join(dir, 'cap.json')),
        e2eFiles: listDir(path.join(dir, 'e2e')).filter((e) => e.isFile() && e.name.endsWith('.json')).length,
        writeup: fs.existsSync(path.join(dir, 'writeup.md')),
        phase: typeof phase?.phase === 'string' ? phase.phase : undefined,
      });
    }
  }
  return { runs, currentTasks };
}

export function readLessons(): Lesson[] {
  const dir = path.join(harnessHome(), 'lessons');
  const out: Lesson[] = [];
  for (const f of listDir(dir)) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const l = readJsonOr<Lesson | null>(path.join(dir, f.name), null);
    if (l && typeof l.status === 'string') out.push(l);
  }
  return out;
}

export function countProposals(): number {
  const dir = path.join(harnessHome(), 'proposals');
  let n = 0;
  for (const r of listDir(dir)) {
    if (!r.isDirectory()) continue;
    n += listDir(path.join(dir, r.name)).filter((f) => f.isFile() && /^\d+-.*\.md$/.test(f.name)).length;
  }
  return n;
}

export function readCheckIndex(): { index: CheckIndexEntry[] | null; specs: number } {
  const dir = path.join(path.dirname(ledgerPath()), 'checks');
  const idx = readJsonOr<{ records?: CheckIndexEntry[] } | null>(path.join(dir, 'index.json'), null);
  const specs = listDir(dir).filter((f) => f.isFile() && f.name.endsWith('.json') && f.name !== 'index.json').length;
  return { index: idx && Array.isArray(idx.records) ? idx.records : null, specs };
}

/** Everything the report counts, read once. */
export function collectState(opts: { worklog?: string } = {}): HarnessState {
  const ledger = readJsonOr<Ledger | null>(ledgerPath(), null);
  const assess = readJsonOr<AssessReport | null>(path.join(harnessHome(), 'assess', 'assess.json'), null);
  const { index, specs } = readCheckIndex();
  const { events, bad } = readEvents();
  const { runs, currentTasks } = readRuns();
  return {
    home: harnessHome(),
    config: loadConfig(),
    ledger: ledger && Array.isArray(ledger.records) ? ledger : null,
    checkIndex: index,
    checkSpecs: specs,
    assess: assess && Array.isArray(assess.findings) ? assess : null,
    briefs: listBriefs(),
    runs,
    events,
    badEventLines: bad,
    lessons: readLessons(),
    proposals: countProposals(),
    worklog: readWorklog(opts.worklog),
    currentTasks,
  };
}
