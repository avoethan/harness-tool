import * as path from 'node:path';
import { appendLine } from './fsx';
import { logsDir } from './paths';
import type { InstrumentationEvent } from '../types';

/**
 * Instrumentation log: one JSON line per event, carrying names, ids and
 * counts only. Never pass prompt text, tool output or file content here.
 */
export function instrument(ev: Omit<InstrumentationEvent, 'ts'>): void {
  if (process.env.HARNESS_NO_INSTRUMENT) return;
  const rec: InstrumentationEvent = { ts: new Date().toISOString(), ...ev };
  const r = rec as unknown as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 200) r[k] = v.slice(0, 200);
  }
  try {
    appendLine(path.join(logsDir(), 'events.jsonl'), JSON.stringify(rec));
  } catch {
    /* logging must never break the caller */
  }
}

let quiet = false;
export function setQuiet(q: boolean): void {
  quiet = q;
}

export function info(msg: string): void {
  if (!quiet) process.stdout.write(msg + '\n');
}

export function warn(msg: string): void {
  process.stderr.write('warning: ' + msg + '\n');
}

export function fail(msg: string, code = 1): never {
  process.stderr.write('error: ' + msg + '\n');
  process.exit(code);
}
