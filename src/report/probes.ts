/**
 * Probe files for the work-machine self-checks (harness/selfcheck/*.md).
 *
 *   harness selfcheck probe-files --agent devin|codex [--remove]
 *   harness selfcheck probe-mode  --agent devin --stop off|block|slow
 *   harness selfcheck probe-log   --agent devin|codex [--json] [--clear]
 *   harness selfcheck probe-hook  <Event> --agent <agent>     (run by the probe hook entries)
 *
 * What probe-files writes, only at user level (never inside a git work tree):
 *   Devin  <devin home>/AGENTS.md    a marked block appended to the always-on file:
 *                                    MARKER-GLOBAL-PROBE at the top and MARKER-TAIL-PROBE
 *                                    after byte 17,000 (the size probe)
 *          <devin home>/config.json  probe hook entries: SessionStart (prints
 *                                    MARKER-HOOK-START-<nonce> as additionalContext),
 *                                    PreToolUse on every tool (records tool and field
 *                                    names), Stop (off, block three times, or slow)
 *   Codex  <codex home>/hooks.json   probe hook entries: SessionStart and PreToolUse
 *
 * Each write is tracked in ~/.harness/selfcheck/probe-<agent>.json with the
 * hashes before and after and a byte copy of the original. `--remove`
 * restores the original bytes when the file is as the probe left it; when
 * the user changed it since, only the probe block or probe entries are taken
 * out. The harness's own entries, the machine manifest and the integrity
 * manifest are never touched.
 *
 * The probe hook runs harness code only; it records event, tool and field
 * names, booleans and counts (never values, paths or prompt text) to
 * ~/.harness/selfcheck/probe/<agent>-log.jsonl, and fails open.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from '../types';
import { agentHome, packageRoot, toPosix } from '../lib/paths';
import { appendLine, ensureDir, readJsonOr, readTextOr, writeJson, writeTextAtomic } from '../lib/fsx';
import { sha256, sha256File } from '../lib/hash';
import { nearestRepoRoot } from '../lib/git';
import { loadConfig } from '../lib/config';
import type { SelfcheckAgent } from './selfcheck';
import { selfcheckDir } from './selfcheck';

export const PROBE_MARK = ' selfcheck probe-hook ';
export const BLOCK_BEGIN = '<!-- harness-selfcheck-probe:begin';
export const BLOCK_END = '<!-- harness-selfcheck-probe:end -->';
/** The size probe puts MARKER-TAIL-PROBE at or after this byte of the always-on file. */
export const TAIL_OFFSET = 17000;
export const STOP_BLOCKS = 3;
export const SLOW_STOP_MS = 10_000;
export const STOP_TIMEOUT_S = 3;

export type StopMode = 'off' | 'block' | 'slow';

export interface ProbeEntry {
  kind: 'block' | 'hooks';
  path: string;
  /** The file did not exist before the probe. */
  created: boolean;
  beforeSha: string | null;
  afterSha: string;
  /** Byte copy of the original (null when created). */
  backup: string | null;
}

export interface ProbeManifest {
  version: 1;
  agent: SelfcheckAgent;
  createdAt: string;
  nonce: string;
  entries: ProbeEntry[];
}

export interface ProbeResult {
  ok: boolean;
  /** Exit code: 0 ok, 1 failure, 4 refused (a target inside a git repository). */
  code: 0 | 1 | 4;
  lines: string[];
  manifest?: ProbeManifest;
}

export function probeDir(): string {
  return path.join(selfcheckDir(), 'probe');
}
export function probeManifestPath(agent: SelfcheckAgent): string {
  return path.join(selfcheckDir(), `probe-${agent}.json`);
}
function backupDir(agent: SelfcheckAgent): string {
  return path.join(selfcheckDir(), 'backup', agent);
}
export function probeLogPath(agent: string): string {
  return path.join(probeDir(), `${agent}-log.jsonl`);
}
export function stopModePath(agent: string): string {
  return path.join(probeDir(), `${agent}-stop-mode`);
}
function stopCountPath(agent: string): string {
  return path.join(probeDir(), `${agent}-stop-count.json`);
}

export function loadProbeManifest(agent: SelfcheckAgent): ProbeManifest | null {
  const m = readJsonOr<ProbeManifest | null>(probeManifestPath(agent), null);
  return m && m.version === 1 && Array.isArray(m.entries) ? m : null;
}

/** The command a probe hook entry runs: harness's own CLI, absolute, forward slashes. */
export function probeCommand(event: string, agent: AgentId, root: string = packageRoot()): string {
  return `node "${toPosix(path.join(root, 'dist', 'src', 'cli.js'))}"${PROBE_MARK}${event} --agent ${agent}`;
}

interface ProbeHookSpec {
  event: string;
  matcher?: string;
  timeout: number;
}

export function probeHookSpecs(agent: SelfcheckAgent): ProbeHookSpec[] {
  if (agent === 'devin') {
    return [
      { event: 'SessionStart', matcher: '', timeout: 10 },
      { event: 'PreToolUse', matcher: '.*', timeout: 10 },
      { event: 'Stop', matcher: '', timeout: STOP_TIMEOUT_S },
    ];
  }
  return [
    { event: 'SessionStart', timeout: 10 },
    { event: 'PreToolUse', matcher: '.*', timeout: 10 },
  ];
}

/** The always-on probe block: global marker, filler to push the tail marker past TAIL_OFFSET, tail marker. */
export function probeBlock(existingBytes: number, agent: SelfcheckAgent): string {
  const head = [
    '',
    `${BLOCK_BEGIN} (temporary; \`harness selfcheck probe-files --agent ${agent} --remove\` takes it out) -->`,
    'MARKER-GLOBAL-PROBE: this line comes from the user-level always-on file. When the user asks which markers you see, list every line of your instructions and context that starts with MARKER-, verbatim, and nothing else.',
  ].join('\n');
  const lines: string[] = [];
  let size = existingBytes + Buffer.byteLength(head + '\n');
  let n = 0;
  while (size < TAIL_OFFSET) {
    const l = `Probe filler ${String(++n).padStart(4, '0')}: this line only pads the file for the size probe and carries no instruction.`;
    lines.push(l);
    size += Buffer.byteLength(l + '\n');
  }
  return [head, ...lines, `MARKER-TAIL-PROBE: this line starts after byte ${TAIL_OFFSET.toLocaleString('en-US')} of the file.`, BLOCK_END, ''].join('\n');
}

function stripBlock(text: string): string {
  const b = text.indexOf(BLOCK_BEGIN);
  if (b < 0) return text;
  const e = text.indexOf(BLOCK_END, b);
  if (e < 0) return text;
  let start = b;
  if (start > 0 && text[start - 1] === '\n') start--;
  let end = e + BLOCK_END.length;
  if (text[end] === '\n') end++;
  return text.slice(0, start) + (start > 0 && !text.slice(0, start).endsWith('\n') && end < text.length ? '\n' : '') + text.slice(end);
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> };

function isProbeGroup(g: HookGroup): boolean {
  return Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(PROBE_MARK));
}

function addProbeHooks(doc: Record<string, unknown>, agent: SelfcheckAgent): Record<string, unknown> {
  const hooks = (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : (doc.hooks = {})) as Record<string, HookGroup[]>;
  for (const s of probeHookSpecs(agent)) {
    const list = Array.isArray(hooks[s.event]) ? hooks[s.event] : (hooks[s.event] = []);
    const entry = { type: 'command', command: probeCommand(s.event, agent), timeout: s.timeout };
    list.push(s.matcher !== undefined ? { matcher: s.matcher, hooks: [entry] } : { hooks: [entry] });
  }
  return doc;
}

function removeProbeHooks(doc: Record<string, unknown>): Record<string, unknown> {
  const hooks = doc.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return doc;
  for (const [ev, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((g) => !isProbeGroup(g));
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (!Object.keys(hooks).length) delete doc.hooks;
  return doc;
}

/** Strict JSON only: a file with comments would lose them on rewrite, so it is refused. */
function readStrictJson(file: string): { ok: true; doc: Record<string, unknown> | null } | { ok: false; why: string } {
  const text = readTextOr(file, null);
  if (text === null) return { ok: true, doc: null };
  if (!text.trim()) return { ok: true, doc: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, why: 'is not a JSON object' };
    return { ok: true, doc: v as Record<string, unknown> };
  } catch {
    return { ok: false, why: 'is not plain JSON (comments or trailing commas); the probe would lose them on rewrite' };
  }
}

function targets(agent: SelfcheckAgent): Array<{ kind: ProbeEntry['kind']; path: string }> {
  const home = agentHome(agent);
  if (agent === 'devin') return [{ kind: 'block', path: path.join(home, 'AGENTS.md') }, { kind: 'hooks', path: path.join(home, 'config.json') }];
  return [{ kind: 'hooks', path: path.join(home, 'hooks.json') }];
}

function atomicCopy(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  const tmp = `${dst}.harness-tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

function newNonce(): string {
  return sha256(`${Date.now()}-${process.pid}-${Math.random()}`).slice(0, 6).toUpperCase();
}

/** Write the probe files for one agent. */
export function writeProbes(agent: SelfcheckAgent, now: Date = new Date()): ProbeResult {
  const existing = loadProbeManifest(agent);
  if (existing) {
    return { ok: true, code: 0, manifest: existing, lines: [`The ${agent} probe files are already in place (written ${existing.createdAt}); the SessionStart marker is MARKER-HOOK-START-${existing.nonce}. Remove them with: harness selfcheck probe-files --agent ${agent} --remove`] };
  }
  const plan: Array<{ entry: ProbeEntry; content: string; original: string | null }> = [];
  for (const t of targets(agent)) {
    const repo = nearestRepoRoot(path.dirname(t.path));
    if (repo) return { ok: false, code: 4, lines: [`Refused: ${t.path} lies inside a git repository (${repo}); the probe writes only user-level files outside any repository. Nothing was written.`] };
    const original = readTextOr(t.path, null);
    let content: string;
    if (t.kind === 'block') {
      const base = original ?? '';
      if (base.includes(BLOCK_BEGIN)) return { ok: false, code: 1, lines: [`${t.path} already holds a probe block but no probe manifest exists; take the block out by hand (from "${BLOCK_BEGIN}" to "${BLOCK_END}"), then run this again. Nothing was written.`] };
      content = (base && !base.endsWith('\n') ? base + '\n' : base) + probeBlock(Buffer.byteLength(base && !base.endsWith('\n') ? base + '\n' : base), agent);
    } else {
      const r = readStrictJson(t.path);
      if (!r.ok) {
        const fragment = JSON.stringify(addProbeHooks({}, agent), null, 2);
        return { ok: false, code: 1, lines: [`${t.path} ${r.why}. Nothing was written. To run the hook probes, add these entries by hand and remove them afterwards:`, fragment] };
      }
      content = JSON.stringify(addProbeHooks(r.doc ?? {}, agent), null, 2) + '\n';
    }
    plan.push({
      entry: { kind: t.kind, path: t.path, created: original === null, beforeSha: original === null ? null : sha256File(t.path), afterSha: sha256(content), backup: null },
      content,
      original,
    });
  }
  // Backups first, then the manifest, then the files: a crash leaves a manifest --remove can act on.
  plan.forEach((p, i) => {
    if (p.original !== null) {
      const b = path.join(backupDir(agent), `${i + 1}-${path.basename(p.entry.path)}`);
      atomicCopy(p.entry.path, b);
      p.entry.backup = b;
    }
  });
  const manifest: ProbeManifest = { version: 1, agent, createdAt: now.toISOString(), nonce: newNonce(), entries: plan.map((p) => p.entry) };
  writeJson(probeManifestPath(agent), manifest);
  const lines: string[] = [];
  for (const p of plan) {
    writeTextAtomic(p.entry.path, p.content);
    lines.push(`${p.entry.created ? 'created' : 'changed'} ${p.entry.path} (${p.entry.kind === 'block' ? 'marker block with the size probe' : `probe hooks: ${probeHookSpecs(agent).map((s) => s.event).join(', ')}`})`);
  }
  ensureDir(probeDir());
  if (agent === 'devin') writeTextAtomic(stopModePath(agent), 'off\n');
  lines.push(`SessionStart marker for this probe: MARKER-HOOK-START-${manifest.nonce}`);
  lines.push(`Remove everything with: harness selfcheck probe-files --agent ${agent} --remove`);
  return { ok: true, code: 0, lines, manifest };
}

/** Remove the probe files for one agent (manifest-tracked). */
export function removeProbes(agent: SelfcheckAgent): ProbeResult {
  const m = loadProbeManifest(agent);
  if (!m) return { ok: true, code: 0, lines: [`No ${agent} probe files are recorded; nothing to remove.`] };
  const lines: string[] = [];
  let ok = true;
  for (const e of [...m.entries].reverse()) {
    const cur = sha256File(e.path);
    if (cur === null) {
      lines.push(`${e.path}: already gone`);
      continue;
    }
    if (cur === e.beforeSha) {
      lines.push(`${e.path}: unchanged by the probe (nothing to do)`);
      continue;
    }
    if (cur === e.afterSha) {
      if (e.created) fs.rmSync(e.path, { force: true });
      else if (e.backup && fs.existsSync(e.backup)) atomicCopy(e.backup, e.path);
      else {
        ok = false;
        lines.push(`${e.path}: the backup copy is missing; take the probe part out by hand`);
        continue;
      }
      lines.push(`${e.path}: ${e.created ? 'removed (the probe created it)' : 'restored byte for byte'}`);
      continue;
    }
    // Changed since the probe wrote it: take out only the probe part.
    const text = readTextOr(e.path, '') ?? '';
    if (e.kind === 'block') {
      const next = stripBlock(text);
      if (next === text) lines.push(`${e.path}: changed since the probe and no probe block found; left as it is`);
      else {
        writeTextAtomic(e.path, next);
        lines.push(`${e.path}: changed since the probe; only the probe block was taken out`);
      }
    } else {
      const r = readStrictJson(e.path);
      if (!r.ok || !r.doc) {
        ok = false;
        lines.push(`${e.path}: changed since the probe and ${r.ok ? 'empty' : r.why}; remove the entries whose command contains "${PROBE_MARK.trim()}" by hand`);
        continue;
      }
      writeTextAtomic(e.path, JSON.stringify(removeProbeHooks(r.doc), null, 2) + '\n');
      lines.push(`${e.path}: changed since the probe; only the probe hook entries were taken out`);
    }
  }
  if (ok) {
    fs.rmSync(backupDir(agent), { recursive: true, force: true });
    try {
      fs.rmdirSync(path.dirname(backupDir(agent)));
    } catch {
      /* another agent's backups are still there */
    }
    fs.rmSync(probeManifestPath(agent), { force: true });
    fs.rmSync(stopModePath(agent), { force: true });
    fs.rmSync(stopCountPath(agent), { force: true });
    lines.push(`The ${agent} probe manifest is cleared. The probe log stays at ${probeLogPath(agent)} until \`harness selfcheck probe-log --agent ${agent} --clear\`.`);
  } else lines.push('The probe manifest is kept so you can run --remove again after fixing the files above.');
  return { ok, code: ok ? 0 : 1, lines };
}

export function setStopMode(agent: SelfcheckAgent, mode: StopMode): void {
  ensureDir(probeDir());
  writeTextAtomic(stopModePath(agent), mode + '\n');
  fs.rmSync(stopCountPath(agent), { force: true });
}

export function getStopMode(agent: string): StopMode {
  const t = (readTextOr(stopModePath(agent), '') ?? '').trim();
  return t === 'block' || t === 'slow' ? t : 'off';
}

// ---------------------------------------------------------------------------
// The probe hook (names, booleans and counts only)
// ---------------------------------------------------------------------------

export interface ProbeRecord {
  ts: string;
  event: string;
  agent: string;
  inputKeys: string[];
  tool?: string;
  fields?: string[];
  stopHookActive?: boolean | 'absent';
  stop?: 'allow' | 'block' | 'release' | 'slow-start' | 'slow-end';
  n?: number;
  ms?: number;
  projectDir?: { set: boolean; sameAsCwd?: boolean; isGit?: boolean; isWorkspaceRoot?: boolean };
  cwdField?: boolean;
  cwdIsGit?: boolean;
  /** Names of the agent's own environment variables (DEVIN_* or CODEX_*) the hook saw; names only. */
  envNames?: string[];
}

const NAME_RE = /^[A-Za-z0-9_.:@$-]{1,64}$/;

function names(xs: unknown[]): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === 'string' && NAME_RE.test(x)))].sort().slice(0, 40);
}

function record(agent: string, rec: Omit<ProbeRecord, 'ts' | 'agent'>): void {
  try {
    appendLine(probeLogPath(agent), JSON.stringify({ ts: new Date().toISOString(), agent, ...rec }));
  } catch {
    /* the probe never breaks the agent */
  }
}

function sameDir(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
}

export interface ProbeHookOutput {
  code: 0 | 2;
  stdout?: string;
  stderr?: string;
}

/** The probe hook body. `env` is the hook's environment. */
export async function probeHook(event: string, agent: string, stdin: string, env: NodeJS.ProcessEnv = process.env): Promise<ProbeHookOutput> {
  let input: Record<string, unknown> = {};
  try {
    const v = JSON.parse(stdin.slice(0, 1_000_000) || '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown>;
  } catch {
    /* not JSON: record the event with no keys */
  }
  const inputKeys = names(Object.keys(input));
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    const ti = input.tool_input;
    record(agent, {
      event,
      inputKeys,
      tool: typeof input.tool_name === 'string' && NAME_RE.test(input.tool_name) ? input.tool_name : typeof input.tool_name === 'string' ? '(unusual name)' : undefined,
      fields: ti && typeof ti === 'object' && !Array.isArray(ti) ? names(Object.keys(ti)) : [],
    });
    return { code: 0 };
  }
  if (event === 'SessionStart') {
    const pd = env.DEVIN_PROJECT_DIR;
    const ws = loadConfig()?.workspaceRoot;
    const manifest = readJsonOr<ProbeManifest | null>(path.join(selfcheckDir(), `probe-${agent}.json`), null);
    record(agent, {
      event,
      inputKeys,
      projectDir: pd === undefined ? { set: false } : { set: true, sameAsCwd: sameDir(pd, cwd), isGit: nearestRepoRoot(pd) !== null, isWorkspaceRoot: ws ? sameDir(pd, ws) : undefined },
      cwdField: typeof input.cwd === 'string',
      cwdIsGit: nearestRepoRoot(cwd) !== null,
      envNames: names(Object.keys(env).filter((k) => k.startsWith(agent === 'codex' ? 'CODEX_' : 'DEVIN_'))),
    });
    const marker = `MARKER-HOOK-START-${manifest?.nonce ?? 'NONCE'}: this line comes from the harness self-check SessionStart probe hook.`;
    return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: marker } }) };
  }
  if (event === 'Stop') {
    const active = typeof input.stop_hook_active === 'boolean' ? input.stop_hook_active : 'absent';
    const mode = getStopMode(agent);
    if (mode === 'block') {
      const cp = stopCountPath(agent);
      const prev = readJsonOr<{ count: number; at: string } | null>(cp, null);
      const fresh = prev && Date.now() - Date.parse(prev.at) < 10 * 60_000 ? prev.count : 0;
      if (fresh < STOP_BLOCKS) {
        const n = fresh + 1;
        writeJson(cp, { count: n, at: new Date().toISOString() });
        record(agent, { event, inputKeys, stopHookActive: active, stop: 'block', n });
        const reason = `MARKER-STOP-PROBE ${n} of ${STOP_BLOCKS}: reply with the single word CONTINUE-${n}, then finish again.`;
        return { code: 2, stdout: JSON.stringify({ decision: 'block', reason }), stderr: reason };
      }
      fs.rmSync(cp, { force: true });
      record(agent, { event, inputKeys, stopHookActive: active, stop: 'release', n: STOP_BLOCKS });
      return { code: 0 };
    }
    if (mode === 'slow') {
      const t0 = Date.now();
      record(agent, { event, inputKeys, stopHookActive: active, stop: 'slow-start' });
      await new Promise((r) => setTimeout(r, Number(env.HARNESS_PROBE_SLOW_MS) > 0 ? Number(env.HARNESS_PROBE_SLOW_MS) : SLOW_STOP_MS));
      record(agent, { event, inputKeys, stop: 'slow-end', ms: Date.now() - t0 });
      return { code: 0 };
    }
    record(agent, { event, inputKeys, stopHookActive: active, stop: 'allow' });
    return { code: 0 };
  }
  record(agent, { event, inputKeys });
  return { code: 0 };
}

// ---------------------------------------------------------------------------
// Reading the probe log
// ---------------------------------------------------------------------------

export interface ProbeSummary {
  records: number;
  sessionStarts: number;
  projectDir: { set: number; notSet: number; sameAsCwd: number; isGit: number; isWorkspaceRoot: number };
  cwdIsGit: number;
  cwdField: number;
  /** tool name -> field names seen in tool_input */
  tools: Record<string, string[]>;
  stop: { allow: number; blocks: number; maxRun: number; releases: number; stopHookActive: string[]; slowStarts: number; slowEnds: number };
  envNames: string[];
}

export function readProbeLog(agent: string): ProbeRecord[] {
  const text = readTextOr(probeLogPath(agent), '') ?? '';
  const out: ProbeRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ProbeRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function summariseProbeLog(recs: ProbeRecord[]): ProbeSummary {
  const s: ProbeSummary = {
    records: recs.length,
    sessionStarts: 0,
    projectDir: { set: 0, notSet: 0, sameAsCwd: 0, isGit: 0, isWorkspaceRoot: 0 },
    cwdIsGit: 0,
    cwdField: 0,
    tools: {},
    stop: { allow: 0, blocks: 0, maxRun: 0, releases: 0, stopHookActive: [], slowStarts: 0, slowEnds: 0 },
    envNames: [],
  };
  const env = new Set<string>();
  const active = new Set<string>();
  let run = 0;
  for (const r of recs) {
    if (r.event === 'SessionStart') {
      s.sessionStarts++;
      if (r.projectDir?.set) {
        s.projectDir.set++;
        if (r.projectDir.sameAsCwd) s.projectDir.sameAsCwd++;
        if (r.projectDir.isGit) s.projectDir.isGit++;
        if (r.projectDir.isWorkspaceRoot) s.projectDir.isWorkspaceRoot++;
      } else s.projectDir.notSet++;
      if (r.cwdIsGit) s.cwdIsGit++;
      if (r.cwdField) s.cwdField++;
      for (const n of r.envNames ?? []) env.add(n);
    } else if (r.event === 'PreToolUse' && r.tool) {
      const set = new Set(s.tools[r.tool] ?? []);
      for (const f of r.fields ?? []) set.add(f);
      s.tools[r.tool] = [...set].sort();
    } else if (r.event === 'Stop') {
      if (r.stopHookActive !== undefined) active.add(String(r.stopHookActive));
      if (r.stop === 'block') {
        s.stop.blocks++;
        run = r.n ?? run + 1;
        s.stop.maxRun = Math.max(s.stop.maxRun, run);
      } else if (r.stop === 'release') {
        s.stop.releases++;
        run = 0;
      } else if (r.stop === 'allow') {
        s.stop.allow++;
        run = 0;
      } else if (r.stop === 'slow-start') s.stop.slowStarts++;
      else if (r.stop === 'slow-end') s.stop.slowEnds++;
    }
  }
  s.stop.stopHookActive = [...active].sort();
  s.envNames = [...env].sort();
  return s;
}

export function formatProbeSummary(agent: string, s: ProbeSummary): string {
  const L: string[] = [`Probe log for ${agent}: ${s.records} record(s).`];
  if (!s.records) {
    L.push('  Nothing recorded yet: the probe hooks have not run (start a new session after `harness selfcheck probe-files`; Codex needs the probe hooks trusted with /hooks).');
    return L.join('\n') + '\n';
  }
  const yes = (n: number, of: number) => (of === 0 ? 'n/a' : n === of ? 'yes' : n === 0 ? 'no' : `${n} of ${of}`);
  L.push(`  SessionStart probe ran ${s.sessionStarts} time(s).`);
  if (s.sessionStarts) {
    if (agent === 'devin') {
      const pd = s.projectDir;
      L.push(`  DEVIN_PROJECT_DIR set: ${yes(pd.set, s.sessionStarts)}${pd.set ? `; equals the hook's working folder: ${yes(pd.sameAsCwd, pd.set)}; a git repository: ${yes(pd.isGit, pd.set)}; the workspace root in the harness config: ${yes(pd.isWorkspaceRoot, pd.set)}` : ''}.`);
    }
    L.push(`  The hook input carries a cwd field: ${yes(s.cwdField, s.sessionStarts)}; the working folder is inside a git repository: ${yes(s.cwdIsGit, s.sessionStarts)}.`);
    if (s.envNames.length) L.push(`  Agent environment variables seen (names): ${s.envNames.join(', ')}.`);
  }
  const tools = Object.entries(s.tools);
  L.push(tools.length ? `  tool_input field names per tool: ${tools.map(([t, f]) => `${t}: ${f.join(', ') || '(none)'}`).join('; ')}.` : '  No PreToolUse probe record yet.');
  const st = s.stop;
  if (st.blocks || st.releases || st.allow || st.slowStarts) {
    L.push(`  Stop probe: ${st.allow} plain stop(s); ${st.blocks} block(s) delivered, longest run ${st.maxRun} in a row, ${st.releases} release(s) after ${STOP_BLOCKS}; stop_hook_active seen as: ${st.stopHookActive.join(', ') || 'n/a'}.`);
    if (st.slowStarts) {
      const cut = st.slowStarts - st.slowEnds;
      L.push(`  Slow Stop probe (${SLOW_STOP_MS / 1000} s against a ${STOP_TIMEOUT_S} s timeout): started ${st.slowStarts}, finished ${st.slowEnds}${cut > 0 ? ` -> ${cut} cut off: the agent enforces the hook timeout` : ' -> never cut off: the agent waited past the timeout'}.`);
    }
  }
  return L.join('\n') + '\n';
}

export function clearProbeLog(agent: string): void {
  fs.rmSync(probeLogPath(agent), { force: true });
  fs.rmSync(stopCountPath(agent), { force: true });
}

