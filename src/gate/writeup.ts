/**
 * The write-up a full gate run ends with. `harness gate` calls this after the
 * evidence is written (PASS, FAIL or BLOCKED), so the write-up exists whether
 * or not the agent remembers to ask for it. It uses the same module as
 * `harness writeup`; a failure here never changes the gate's exit code.
 */
import type { GateRun } from './index';
import { writeAll, pickTouched } from '../intake/writeups';
import { instrument } from '../lib/log';

export interface GateWriteup {
  /** The path of this repo's write-up, when one was written. */
  path: string | null;
  /** The last line of the gate's output. */
  line: string;
}

/** Null when this kind of run writes no write-up (a partial `--steps` run, or a hook mode). */
export function writeupAfterGate(run: GateRun): GateWriteup | null {
  if (run.partial || run.ctx.mode !== 'task') return null;
  const brief = run.ctx.brief;
  if (!brief) return { path: null, line: 'Write-up: none (this task has no brief, so there is nothing to write up; run `harness intake --from <file>` for a task with a brief)' };
  try {
    const { touched } = pickTouched(brief, run.ctx.root);
    const written = writeAll(brief, run.ctx.config.setting, touched);
    const mine = written.find((w) => w.work.repoId === run.ctx.repoId && w.file) ?? written.find((w) => w.file);
    instrument({ event: 'gate.writeup', repo: run.ctx.repoId, task: run.ctx.taskId, ids: { verdict: run.evidence.verdict }, counts: { written: written.filter((w) => w.file).length } });
    if (!mine?.file) return { path: null, line: 'Write-up: not written (no mapped repository for this task); run `harness writeup`' };
    return { path: mine.file, line: `Write-up: ${mine.file}` };
  } catch (e) {
    return { path: null, line: `Write-up: not written (${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 160)}); run \`harness writeup\`` };
  }
}
