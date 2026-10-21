/**
 * Capture: read the instrumentation log (~/.harness/logs/events.jsonl) and
 * turn the mistake events into occurrences of mistake classes. The log holds
 * names, ids and counts only; this module copies only whitelisted fields,
 * so nothing else in a line (even a hand-edited one) reaches a lesson.
 *
 * Sources (DESIGN 2.9, 2.12):
 *   correction              {class}                  UserPromptSubmit hook
 *   gate.fail               {ids.step, ids.rules}    harness gate
 *   land.post_landing_red   {repo, task}             harness land
 *   land.reverted           {repo, task}             harness land
 *   guard.deny              {ids.rail}               PreToolUse guard (marks the session as rail-touching)
 *
 * Grouping rules (chosen; see README):
 *   - gate.fail: one class per rule id in ids.rules, else one per step kind;
 *     only the first failure of a class per (repo, task) is an occurrence,
 *     later attempts in the same task are follow-ups (the gate doing its job);
 *   - correction: when the same session had a gate failure in the previous
 *     LINK_WINDOW_MS, the correction counts for that failure's classes (the
 *     user is steering about what the gate reported); else `correction:<class>`;
 *   - land.reverted after a land.post_landing_red of the same (repo, task) is a
 *     follow-up of that occurrence, not a new one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstrumentationEvent } from '../types';
import { logsDir } from '../lib/paths';
import { sha256 } from '../lib/hash';
import { classKey, keyTouchesRail, stepKind } from './classes';

export const MISTAKE_EVENTS = new Set(['correction', 'gate.fail', 'land.post_landing_red', 'land.reverted']);
export const LINK_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface LogEvent {
  /** `e-<12 hex>`: hash of the line (a duplicate line gets `#n`). Never text. */
  id: string;
  ts: string;
  t: number;
  event: string;
  sessionId?: string;
  repo?: string;
  task?: string;
  agent?: string;
  cls?: string;
  ids: Record<string, string>;
}

export interface Occurrence {
  key: string;
  eventId: string;
  ts: string;
  t: number;
  event: string;
  sessionId?: string;
  repo?: string;
  task?: string;
  /** Linked to an earlier gate failure in the same session (corrections only). */
  linkedTo?: string;
  rail: boolean;
}

export interface Captured {
  occurrences: Occurrence[];
  /** Repeated failures of a class already counted in the same task, and reverts after a red landing. */
  followUps: Array<{ key: string; eventId: string; t: number }>;
  /** Mistake events read (after --since). */
  events: number;
  /** Lines that were not JSON or had no event/ts. */
  malformed: number;
  /** Every distinct task and session seen in the log, by time (for per-task rates). */
  activity: Array<{ t: number; task?: string; sessionId?: string }>;
}

export function eventsPath(): string {
  return path.join(logsDir(), 'events.jsonl');
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.length ? v.slice(0, max) : undefined;
}

/** Parse the log text into events (whitelisted fields only). */
export function parseEvents(text: string, opts: { since?: Date } = {}): { events: LogEvent[]; malformed: number } {
  const events: LogEvent[] = [];
  const seen = new Map<string, number>();
  let malformed = 0;
  const since = opts.since ? opts.since.getTime() : -Infinity;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: Partial<InstrumentationEvent> & Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const ev = str(raw?.event, 80);
    const ts = str(raw?.ts, 40);
    const t = ts ? Date.parse(ts) : NaN;
    if (!ev || !ts || !Number.isFinite(t)) {
      malformed++;
      continue;
    }
    if (t < since) continue;
    const h = sha256(line).slice(0, 12);
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    const ids: Record<string, string> = {};
    if (raw.ids && typeof raw.ids === 'object') {
      for (const k of ['step', 'kind', 'rules', 'rail', 'mode', 'ci', 'outcome', 'ticket', 'verdict']) {
        const v = str((raw.ids as Record<string, unknown>)[k]);
        if (v) ids[k] = v;
      }
    }
    events.push({
      id: n ? `e-${h}#${n}` : `e-${h}`,
      ts,
      t,
      event: ev,
      sessionId: str(raw.sessionId, 120),
      repo: str(raw.repo, 120),
      task: str(raw.task, 120),
      agent: str(raw.agent, 20),
      cls: str(raw.class, 40),
      ids,
    });
  }
  events.sort((a, b) => a.t - b.t);
  return { events, malformed };
}

export function readEvents(file = eventsPath(), opts: { since?: Date } = {}): { events: LogEvent[]; malformed: number } {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { events: [], malformed: 0 };
  }
  return parseEvents(text, opts);
}

/** Class keys of a gate.fail event. */
export function gateFailKeys(ev: Pick<LogEvent, 'ids'>, aliases?: Map<string, string>): string[] {
  const rules = (ev.ids.rules ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => /^[a-z][\w.-]*\.[\w.-]+$/.test(r));
  const keys = rules.length ? rules.map((r) => classKey('rule', r)) : [classKey('step', stepKind(ev.ids.kind ?? ev.ids.step ?? 'unknown'))];
  return [...new Set(keys.map((k) => aliases?.get(k) ?? k))];
}

/**
 * Group mistake events into occurrences of classes. `aliases` maps a class key
 * to the lesson key it counts for (a learned rule firing at the gate).
 */
export function captureOccurrences(events: LogEvent[], opts: { aliases?: Map<string, string>; linkWindowMs?: number } = {}): Captured {
  const window = opts.linkWindowMs ?? LINK_WINDOW_MS;
  const aliases = opts.aliases;
  const occurrences: Occurrence[] = [];
  const followUps: Captured['followUps'] = [];
  const activity: Captured['activity'] = [];
  const perTask = new Set<string>();
  const lastFail = new Map<string, { t: number; keys: string[]; id: string }>();
  const red = new Set<string>();
  const railSessions = new Set<string>();
  let count = 0;
  const alias = (k: string) => aliases?.get(k) ?? k;
  for (const ev of events) {
    if (ev.task || ev.sessionId) activity.push({ t: ev.t, task: ev.task ? `${ev.repo ?? ''}/${ev.task}` : undefined, sessionId: ev.sessionId });
    if (ev.event === 'guard.deny' && ev.sessionId) railSessions.add(ev.sessionId);
    if (!MISTAKE_EVENTS.has(ev.event)) continue;
    count++;
    const base = { eventId: ev.id, ts: ev.ts, t: ev.t, event: ev.event, sessionId: ev.sessionId, repo: ev.repo, task: ev.task };
    if (ev.event === 'gate.fail') {
      const keys = gateFailKeys(ev, aliases);
      for (const key of keys) {
        const tk = `${key}|${ev.repo ?? ''}|${ev.task ?? ev.sessionId ?? ev.id}`;
        if (perTask.has(tk)) {
          followUps.push({ key, eventId: ev.id, t: ev.t });
          continue;
        }
        perTask.add(tk);
        occurrences.push({ ...base, key, rail: keyTouchesRail(key) });
      }
      if (ev.sessionId) lastFail.set(ev.sessionId, { t: ev.t, keys, id: ev.id });
      continue;
    }
    if (ev.event === 'correction') {
      const cls = /^[a-z]{2,20}$/.test(ev.cls ?? '') ? ev.cls! : 'other';
      const prev = ev.sessionId ? lastFail.get(ev.sessionId) : undefined;
      if (prev && ev.t - prev.t <= window && ev.t >= prev.t) {
        for (const key of prev.keys) occurrences.push({ ...base, key, linkedTo: prev.id, rail: keyTouchesRail(key) || cls === 'safety' });
      } else {
        const key = alias(classKey('correction', cls));
        occurrences.push({ ...base, key, rail: keyTouchesRail(key) });
      }
      continue;
    }
    if (ev.event === 'land.post_landing_red') {
      red.add(`${ev.repo ?? ''}|${ev.task ?? ''}`);
      const key = alias(classKey('land', 'post-landing-red'));
      occurrences.push({ ...base, key, rail: false });
      continue;
    }
    if (ev.event === 'land.reverted') {
      const rk = `${ev.repo ?? ''}|${ev.task ?? ''}`;
      if (red.has(rk)) {
        followUps.push({ key: alias(classKey('land', 'post-landing-red')), eventId: ev.id, t: ev.t });
        continue;
      }
      occurrences.push({ ...base, key: alias(classKey('land', 'reverted')), rail: false });
    }
  }
  // A class touched a rail when any of its occurrences came from a session where the guard denied something.
  for (const o of occurrences) if (o.sessionId && railSessions.has(o.sessionId)) o.rail = true;
  return { occurrences, followUps, events: count, malformed: 0, activity };
}

export interface ClassGroup {
  key: string;
  occurrences: Occurrence[];
  followUps: number;
  rail: boolean;
  firstSeen: string;
  lastSeen: string;
  repos: string[];
  counts: Record<string, number>;
}

/** Occurrences grouped by class key, in first-seen order. */
export function groupByClass(c: Captured): ClassGroup[] {
  const by = new Map<string, ClassGroup>();
  for (const o of c.occurrences) {
    let g = by.get(o.key);
    if (!g) {
      g = { key: o.key, occurrences: [], followUps: 0, rail: false, firstSeen: o.ts, lastSeen: o.ts, repos: [], counts: {} };
      by.set(o.key, g);
    }
    g.occurrences.push(o);
    g.rail = g.rail || o.rail;
    g.lastSeen = o.ts;
    if (o.repo && !g.repos.includes(o.repo)) g.repos.push(o.repo);
    g.counts[o.event] = (g.counts[o.event] ?? 0) + 1;
  }
  for (const f of c.followUps) {
    const g = by.get(f.key);
    if (g) g.followUps++;
  }
  return [...by.values()];
}

/** A class becomes a lesson at >= 2 occurrences, or at 1 when it touched a safety rail (DESIGN 2.9). */
export const MIN_OCCURRENCES = 2;

export function isActive(g: Pick<ClassGroup, 'occurrences' | 'rail'>): boolean {
  return g.occurrences.length >= MIN_OCCURRENCES || (g.rail && g.occurrences.length >= 1);
}
