import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { acquireLandLock, landLockPath, readHolder, staleReason } from '../../../src/land/lock';
import { tempHome } from './helpers';

test('lock: the first landing takes it, a second fails fast with --no-wait, release frees it', async () => {
  const h = tempHome('harness-lock-');
  try {
    const a = await acquireLandLock('repo-1', { task: 'T-1' });
    assert.ok(a.ok);
    const held = readHolder(landLockPath('repo-1'));
    assert.equal(held?.pid, process.pid);
    assert.equal(held?.task, 'T-1');
    const b = await acquireLandLock('repo-1', { task: 'T-2', wait: false });
    assert.equal(b.ok, false);
    if (!b.ok) assert.match(b.reason, /another landing holds the lock.*T-1/);
    // Another repository has its own lock.
    const other = await acquireLandLock('repo-2', { task: 'T-9', wait: false });
    assert.ok(other.ok);
    if (other.ok) other.release();
    if (a.ok) a.release();
    assert.equal(fs.existsSync(landLockPath('repo-1')), false);
    const c = await acquireLandLock('repo-1', { task: 'T-2', wait: false });
    assert.ok(c.ok);
    if (c.ok) c.release();
  } finally {
    h.cleanup();
  }
});

test('lock: a waiter gets the lock once the holder releases it', async () => {
  const h = tempHome('harness-lock-');
  try {
    const a = await acquireLandLock('r', { task: 'T-1' });
    assert.ok(a.ok);
    let sleeps = 0;
    const b = await acquireLandLock('r', {
      task: 'T-2',
      waitMs: 60_000,
      pollMs: 10,
      sleep: async () => {
        sleeps++;
        if (sleeps === 2 && a.ok) a.release();
      },
    });
    assert.ok(b.ok, 'the waiter took the lock');
    assert.equal(sleeps, 2);
    if (b.ok) b.release();
  } finally {
    h.cleanup();
  }
});

test('lock: a waiter gives up after its wait limit', async () => {
  const h = tempHome('harness-lock-');
  try {
    const a = await acquireLandLock('r', { task: 'T-1' });
    let t = 1_000_000;
    const b = await acquireLandLock('r', { task: 'T-2', waitMs: 5000, pollMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) });
    assert.equal(b.ok, false);
    if (!b.ok) assert.match(b.reason, /waited 5 s/);
    if (a.ok) a.release();
  } finally {
    h.cleanup();
  }
});

test('lock: stale after an hour, or when the holder process is gone, and taken over', async () => {
  const h = tempHome('harness-lock-');
  try {
    const p = landLockPath('r');
    fs.mkdirSync(require('node:path').dirname(p), { recursive: true });
    // Held two hours ago by a live process (ours): stale by age.
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(Date.now() - 2 * 3600_000).toISOString(), task: 'OLD' }));
    const a = await acquireLandLock('r', { task: 'T-1', wait: false });
    assert.ok(a.ok);
    if (a.ok) {
      assert.equal(a.tookOverStale?.task, 'OLD');
      a.release();
    }
    // Fresh, but the process is gone on this host.
    fs.writeFileSync(p, JSON.stringify({ pid: 999_999_999, host: os.hostname(), at: new Date().toISOString(), task: 'DEAD' }));
    const b = await acquireLandLock('r', { task: 'T-2', wait: false, alive: () => false });
    assert.ok(b.ok);
    if (b.ok) b.release();
    // Fresh and alive: not stale.
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), task: 'LIVE' }));
    const c = await acquireLandLock('r', { task: 'T-3', wait: false });
    assert.equal(c.ok, false);
    fs.unlinkSync(p);
  } finally {
    h.cleanup();
  }
});

test('lock: staleReason rules', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const alive = () => true;
  assert.equal(staleReason({ pid: 1, host: 'elsewhere', at: '2026-01-01T11:30:00Z', task: 't' }, { now, staleMs: 3600_000, alive }), null);
  assert.match(staleReason({ pid: 1, host: 'elsewhere', at: '2026-01-01T10:00:00Z', task: 't' }, { now, staleMs: 3600_000, alive }) ?? '', /longer than 60 minutes/);
  // A process on another host is never judged by pid.
  assert.equal(staleReason({ pid: 1, host: 'elsewhere', at: '2026-01-01T11:59:00Z', task: 't' }, { now, staleMs: 3600_000, alive: () => false }), null);
  assert.match(staleReason({ pid: 1, host: os.hostname(), at: '2026-01-01T11:59:00Z', task: 't' }, { now, staleMs: 3600_000, alive: () => false }) ?? '', /gone/);
  assert.match(staleReason({ pid: 1, host: 'h', at: 'garbage', task: 't' }, { now, staleMs: 3600_000, alive }) ?? '', /no valid time/);
  assert.equal(staleReason(null, { now, staleMs: 3600_000, alive, mtimeMs: now - 1000 }), null);
  assert.match(staleReason(null, { now, staleMs: 3600_000, alive, mtimeMs: now - 10_000 }) ?? '', /unreadable/);
});
