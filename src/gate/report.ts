/**
 * The plain-language report the gate prints: each step, its result and
 * time, the reasons for anything that failed or was skipped, the verdict,
 * and what to do next.
 */
import type { EvidenceFile, GateStep } from '../types';
import { EMPTY_TREE } from './context';
import { STEP_HELP, prefixOf } from './steps';

export interface ReportInput {
  evidence: EvidenceFile;
  repoName: string;
  mode: string;
  baseSource: string;
  cap: number;
  evidencePath: string | null;
  partial: string[] | null;
  warnings: string[];
}

function label(s: GateStep): string {
  if (s.status === 'cached') return 'PASS';
  if (s.status === 'pass') return 'PASS';
  if (s.status === 'fail') return 'FAIL';
  return 'skip';
}

function ms(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;
}

export function renderReport(r: ReportInput): string {
  const ev = r.evidence;
  const L: string[] = [];
  const base = ev.baseSha === EMPTY_TREE ? 'the empty tree' : ev.baseSha.slice(0, 10);
  L.push(`harness gate: ${r.repoName}, task ${ev.task}${r.mode !== 'task' ? ` (${r.mode} hook mode)` : ''}`);
  L.push(`Base ${base} (${r.baseSource}); tree ${ev.treeHash.slice(0, 10)}; attempt ${ev.attempt}${r.mode === 'task' ? ` (attempt cap ${r.cap})` : ''}${ev.phase ? `; phase ${ev.phase}` : ''}`);
  L.push('');
  const width = Math.max(10, ...ev.steps.map((s) => s.name.length));
  for (const s of ev.steps) {
    const time = s.cache === 'hit' ? 'cached' : s.status === 'skip' && !s.durationMs ? '' : ms(s.durationMs);
    const first = s.reasons?.[0] ?? '';
    const inline = s.status === 'fail' ? '' : first;
    L.push(`  ${label(s).padEnd(4)}  ${s.name.padEnd(width)}  ${time.padEnd(7)}  ${inline}`.trimEnd());
    const rest = s.status === 'fail' ? s.reasons ?? [] : (s.reasons ?? []).slice(1);
    for (const why of rest) L.push(`        ${' '.repeat(width)}           - ${why}`);
  }
  L.push('');
  if (r.warnings.length) {
    for (const w of r.warnings) L.push(`Note: ${w}`);
    L.push('');
  }
  const failed = ev.steps.filter((s) => s.status === 'fail');
  const skipped = ev.steps.filter((s) => s.status === 'skip');
  const cached = ev.steps.filter((s) => s.cache === 'hit');
  const counts = `${ev.steps.length} step(s): ${ev.steps.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped${cached.length ? `; ${cached.length} result(s) from the cache` : ''}`;
  if (r.partial) {
    L.push(`Partial run (--steps ${r.partial.join(',')}): ${counts}. No verdict is recorded for a partial run; run \`harness gate\` for the verdict.`);
  } else if (ev.verdict === 'PASS') {
    L.push(`Verdict: PASS. ${counts}.`);
    L.push(skipped.length ? 'Skipped steps are listed above with the reason; the write-up shows them.' : 'Every step ran and passed.');
  } else if (ev.verdict === 'BLOCKED') {
    L.push(`Verdict: BLOCKED. ${ev.reasons[0] ?? ''}`);
    L.push('BLOCKED is a legitimate outcome: the write-up reports it with the reason. Never weaken tests or checks to get a PASS.');
  } else {
    L.push(`Verdict: FAIL. ${counts}.`);
    const other = ev.reasons.filter((x) => !failed.some((s) => x.startsWith(`${s.name}:`)));
    for (const x of other) L.push(`  - ${x}`);
  }
  if (!r.partial && ev.verdict === 'FAIL') {
    L.push('');
    L.push('What to do next:');
    const seen = new Set<string>();
    for (const s of failed) {
      const k = prefixOf(s.name);
      if (seen.has(k)) continue;
      seen.add(k);
      L.push(`  - ${k}: ${STEP_HELP[k] ?? 'Fix what the step lists.'}`);
    }
    if (ev.cap_reached) L.push('  - The attempt cap was reached for this task: PASS can no longer be reported. Leave the work for a person to review, or record `harness gate --blocked "<reason>"`.');
    L.push('  Then run `harness gate` again (unchanged steps come from the cache). If the work cannot pass, run `harness gate --blocked "<reason>"`.');
  }
  if (r.evidencePath) L.push('', `Evidence: ${r.evidencePath}`);
  return L.join('\n') + '\n';
}
