/**
 * Rot control (DESIGN 2.9): `harness learn gc` lists, it never deletes or
 * rewrites a lesson record (raw records are kept, R-32).
 *
 *   expiring   approved prose lessons past their review date: renew or expire them
 *              (`harness learn review --renew <id>` / `--expire <id>`, the user's)
 *   promote    approved prose lessons whose class came back at least twice
 *              after they landed: marked for a code check (the next scan puts
 *              them in a judgment bundle with only code rungs)
 *   unfired    approved code checks that never fired in six months: review them
 *   budget     learned instruction lines against the cap
 */
import type { Captured } from './capture';
import { isProse, type LessonRecord } from './store';
import { occurrencesOf } from './stats';
import { LEARNED_LINE_CAP } from './tiers';

export const PROMOTE_AFTER = 2;
export const UNFIRED_DAYS = 182;

export interface GcReport {
  generatedAt: string;
  records: number;
  expiring: Array<{ lesson: string; rung: string; reviewBy: string; daysOver: number }>;
  promote: Array<{ lesson: string; rung: string; repeatsAfter: number }>;
  unfired: Array<{ lesson: string; ref: string; landedAt: string; days: number }>;
  fires: Record<string, number>;
  budget: { learnedLines: number; cap: number };
}

const DAY = 86_400_000;

/** Gate failures of a lesson's class since its enforcer landed (the enforcer firing). */
export function firesSince(l: LessonRecord, c: Captured): number {
  const land = l.landedAt ? Date.parse(l.landedAt) : NaN;
  if (!Number.isFinite(land)) return 0;
  return occurrencesOf(l, c).filter((o) => o.event === 'gate.fail' && o.t >= land).length;
}

export function gcReport(lessons: LessonRecord[], c: Captured, now = new Date()): GcReport {
  const t = now.getTime();
  const out: GcReport = { generatedAt: now.toISOString(), records: lessons.length, expiring: [], promote: [], unfired: [], fires: {}, budget: { learnedLines: 0, cap: LEARNED_LINE_CAP } };
  for (const l of lessons) {
    if (l.status !== 'approved' || !l.proposal) continue;
    const rung = l.proposal.rung;
    if (isProse(l)) {
      if (rung === 'instruction') out.budget.learnedLines++;
      if (l.reviewBy && Date.parse(l.reviewBy) < t) out.expiring.push({ lesson: l.id, rung, reviewBy: l.reviewBy, daysOver: Math.floor((t - Date.parse(l.reviewBy)) / DAY) });
      const land = l.landedAt ? Date.parse(l.landedAt) : NaN;
      const after = Number.isFinite(land) ? occurrencesOf(l, c).filter((o) => o.t >= land).length : 0;
      if (after >= PROMOTE_AFTER) out.promote.push({ lesson: l.id, rung, repeatsAfter: after });
      continue;
    }
    if (l.proposal.source === 'rail') continue;
    const fires = firesSince(l, c);
    out.fires[l.id] = fires;
    const land = l.landedAt ? Date.parse(l.landedAt) : NaN;
    if (Number.isFinite(land) && t - land >= UNFIRED_DAYS * DAY && fires === 0) out.unfired.push({ lesson: l.id, ref: l.proposal.ref, landedAt: l.landedAt!, days: Math.floor((t - land) / DAY) });
  }
  return out;
}

export function formatGc(r: GcReport): string {
  const L: string[] = [`Lesson records: ${r.records} (kept as written; gc never deletes or summarises them).`];
  L.push('', `Prose past its review date (${r.expiring.length}):`);
  for (const e of r.expiring) L.push(`- ${e.lesson} (${e.rung}, review by ${e.reviewBy}, ${e.daysOver} day(s) over): renew or expire with \`harness learn review --renew ${e.lesson}\` or \`--expire ${e.lesson}\` (run it yourself)`);
  if (!r.expiring.length) L.push('- none');
  L.push('', `Prose that came back ${PROMOTE_AFTER}+ times after it landed, now marked for a code check (${r.promote.length}):`);
  for (const p of r.promote) L.push(`- ${p.lesson} (${p.rung}, ${p.repeatsAfter} repeat(s) after landing): the next \`harness learn --scan\` asks the judgment pass for a rule or a regression test`);
  if (!r.promote.length) L.push('- none');
  L.push('', `Code checks that never fired in ${UNFIRED_DAYS} days (${r.unfired.length}):`);
  for (const u of r.unfired) L.push(`- ${u.lesson} (${u.ref}, landed ${u.landedAt.slice(0, 10)}, ${u.days} days, 0 fires): keep it if it is free, else \`harness learn review --expire ${u.lesson}\``);
  if (!r.unfired.length) L.push('- none');
  L.push('', `Learned instruction lines: ${r.budget.learnedLines} of ${r.budget.cap} (always-on files hold at most 60 harness-owned lines).`);
  return L.join('\n') + '\n';
}
