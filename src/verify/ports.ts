/**
 * Port allocation for a verify run: a contiguous range of free ports, probed
 * with `net.createServer` on the loopback address, and reserved in
 * `~/.harness/state/verify-ports.json` so two runs launched at the same time
 * never pick the same range. Reservations of runs that were cleaned up (or
 * whose record is gone) are released on the next allocation.
 */
import * as net from 'node:net';
import * as path from 'node:path';
import { readJsonOr, writeJson } from '../lib/fsx';
import { runsDir } from '../lib/paths';
import { portsPath, validId } from './state';

export interface PortReservation {
  runId: string;
  repoId: string;
  taskId: string;
  ports: number[];
  at: string;
}

export interface PortsFile {
  version: 1;
  reservations: PortReservation[];
}

/** Whether a TCP port can be bound on the given host right now. */
export function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Free on IPv4 loopback and on the wildcard address (a service may bind either). */
export async function portFree(port: number): Promise<boolean> {
  if (!(await probePort(port, '127.0.0.1'))) return false;
  return probePort(port, '0.0.0.0');
}

export function readPorts(file = portsPath()): PortsFile {
  const f = readJsonOr<PortsFile | null>(file, null);
  if (!f || f.version !== 1 || !Array.isArray(f.reservations)) return { version: 1, reservations: [] };
  return f;
}

/** A reservation is live while its run record exists and is not cleaned. */
export function reservationLive(r: PortReservation): boolean {
  if (!validId(r.repoId) || !validId(r.taskId)) return false;
  const rec = readJsonOr<{ runId?: string; status?: string } | null>(path.join(runsDir(), r.repoId, r.taskId, 'verify.json'), null);
  if (!rec) {
    // A launch in progress writes its record within seconds; keep young reservations.
    return Date.now() - Date.parse(r.at) < 5 * 60_000;
  }
  return rec.runId === r.runId && rec.status !== 'cleaned' && rec.status !== 'stopped';
}

export interface AllocateOptions {
  count: number;
  base?: number;
  /** Highest port considered (inclusive). */
  max?: number;
  /** Ports never handed out (reserved by others), in addition to the reservations file. */
  exclude?: Iterable<number>;
  /** Override the probe (tests). */
  probe?: (port: number) => Promise<boolean>;
  /** Stride between candidate range starts (default: count rounded up to 10). */
  stride?: number;
}

/**
 * Find `count` consecutive free ports at or above `base`. Ranges start on a
 * stride boundary so the ranges of parallel runs do not interleave.
 */
export async function findFreeRange(opts: AllocateOptions): Promise<number[] | null> {
  const count = Math.max(1, Math.floor(opts.count));
  const base = opts.base ?? 20000;
  const max = Math.min(opts.max ?? 65000, 65535);
  const stride = opts.stride ?? Math.max(10, Math.ceil(count / 10) * 10);
  const probe = opts.probe ?? portFree;
  const exclude = new Set(opts.exclude ?? []);
  for (let start = base; start + count - 1 <= max; start += stride) {
    const range: number[] = [];
    let ok = true;
    for (let p = start; p < start + count; p++) {
      if (exclude.has(p) || !(await probe(p))) {
        ok = false;
        break;
      }
      range.push(p);
    }
    if (ok) return range;
  }
  return null;
}

/** Allocate and reserve a range for a run (prunes dead reservations first). */
export async function allocatePorts(run: { runId: string; repoId: string; taskId: string }, opts: AllocateOptions, file = portsPath()): Promise<number[] | null> {
  const f = readPorts(file);
  f.reservations = f.reservations.filter((r) => r.runId !== run.runId && reservationLive(r));
  const taken = new Set<number>(opts.exclude ?? []);
  for (const r of f.reservations) for (const p of r.ports) taken.add(p);
  const range = await findFreeRange({ ...opts, exclude: taken });
  if (!range) return null;
  f.reservations.push({ runId: run.runId, repoId: run.repoId, taskId: run.taskId, ports: range, at: new Date().toISOString() });
  writeJson(file, f);
  return range;
}

/** Release a run's reservation. */
export function releasePorts(runId: string, file = portsPath()): void {
  const f = readPorts(file);
  const before = f.reservations.length;
  f.reservations = f.reservations.filter((r) => r.runId !== runId);
  if (f.reservations.length !== before) writeJson(file, f);
}
