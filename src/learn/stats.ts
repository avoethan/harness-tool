/**
 * The learning loop's success metric (DESIGN 2.9, EVAL-PLAN 7):
 * `repeat_corrections`, a correction or gate failure matching an
 * already-captured class, per class, before and after its enforcer landed.
 * Counts only, recomputed from the instrumentation log on every run (so a
 * new event counts without a re-scan).
 *
 *   repeats         occurrences of the class after the lesson was captured
 *   repeatsBefore   ... and before the enforcer landed (all repeats when it has not)
 *   repeatsAfter    ... at or after the enforcer landed
 *   tasksBefore/After  distinct tasks seen in the log in each window (for a per-task rate)
 */
import type { Captured, Occurrence } from './capture';
import type { LessonRecord } from './store';

export interface StatsRow {
  lesson: string;
  key: string;
  status: LessonRecord['status'];
  rung?: string;
  tier: number;
  capturedAt: string;
  landedAt?: string;
  occurrences: number;
  repeats: number;
  repeatsBefore: number;
  repeatsAfter: number;
  tasksBefore: number;
  tasksAfter: number;
  /** Repeats per task in each window (null when no task was seen). */
  perTaskBefore: number | null;
  perTaskAfter: number | null;
}

export interface StatsReport {
  generatedAt: string;
  rows: StatsRow[];
  totals: { lessons: number; landed: number; occurrences: number; repeats: number; repeatsBefore: number; repeatsAfter: number };
}

function distinctTasks(c: Captured, from: number, to: number): number {
  const s = new Set<string>();
  for (const a of c.activity) if (a.task && a.t >= from && a.t < to) s.add(a.task);
  return s.size;
}

function rate(n: number, d: number): number | null {
  return d ? Math.round((n / d) * 1000) / 1000 : null;
}

/** Occurrences of a lesson's class (its key; aliases were applied at capture). */
export function occurrencesOf(lesson: Pick<LessonRecord, 'key'>, c: Captured): Occurrence[] {
  return c.occurrences.filter((o) => o.key === lesson.key);
}

export function computeStats(lessons: LessonRecord[], c: Captured, now = new Date()): StatsReport {
  const end = now.getTime() + 1;
  const rows: StatsRow[] = lessons.map((l) => {
    const occ = occurrencesOf(l, c);
    const cap = Date.parse(l.capturedAt);
    const land = l.landedAt ? Date.parse(l.landedAt) : NaN;
    const repeats = occ.filter((o) => o.t > cap);
    const after = Number.isFinite(land) ? repeats.filter((o) => o.t >= land) : [];
    const before = repeats.filter((o) => !after.includes(o));
    const tasksBefore = distinctTasks(c, cap, Number.isFinite(land) ? land : end);
    const tasksAfter = Number.isFinite(land) ? distinctTasks(c, land, end) : 0;
    return {
      lesson: l.id,
      key: l.key,
      status: l.status,
      rung: l.proposal?.rung,
      tier: l.tier,
      capturedAt: l.capturedAt,
      ...(l.landedAt ? { landedAt: l.landedAt } : {}),
      occurrences: occ.length,
      repeats: repeats.length,
      repeatsBefore: before.length,
      repeatsAfter: after.length,
      tasksBefore,
      tasksAfter,
      perTaskBefore: rate(before.length, tasksBefore),
      perTaskAfter: Number.isFinite(land) ? rate(after.length, tasksAfter) : null,
    };
  });
  const sum = (k: 'occurrences' | 'repeats' | 'repeatsBefore' | 'repeatsAfter') => rows.reduce((n, r) => n + r[k], 0);
  return {
    generatedAt: now.toISOString(),
    rows,
    totals: { lessons: rows.length, landed: rows.filter((r) => r.landedAt).length, occurrences: sum('occurrences'), repeats: sum('repeats'), repeatsBefore: sum('repeatsBefore'), repeatsAfter: sum('repeatsAfter') },
  };
}

export function formatStats(r: StatsReport): string {
  const L: string[] = [];
  if (!r.rows.length) return 'No lessons yet: run `harness learn --scan` first.\n';
  L.push(`Repeat corrections per class (a correction or gate failure matching a captured class), ${r.rows.length} lesson(s):`);
  L.push('');
  for (const x of r.rows) {
    const landed = x.landedAt ? `landed ${x.landedAt.slice(0, 10)}` : 'not landed';
    const per = (v: number | null) => (v === null ? '-' : String(v));
    L.push(`- ${x.lesson} [${x.status}${x.rung ? `, ${x.rung}` : ''}, tier ${x.tier}, ${landed}]`);
    L.push(`  occurrences ${x.occurrences}; repeats ${x.repeats}: before ${x.repeatsBefore} over ${x.tasksBefore} task(s) (${per(x.perTaskBefore)}/task), after ${x.repeatsAfter} over ${x.tasksAfter} task(s) (${per(x.perTaskAfter)}/task)`);
  }
  L.push('');
  L.push(`Totals: ${r.totals.repeats} repeat(s), ${r.totals.repeatsBefore} before and ${r.totals.repeatsAfter} after an enforcer landed; ${r.totals.landed} of ${r.totals.lessons} lesson(s) landed.`);
  return L.join('\n') + '\n';
}
