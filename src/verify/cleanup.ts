/**
 * `harness verify cleanup`: stop the run's services, drop `test_<runId>`,
 * release the ports, keep the evidence (e2e/ artefacts, logs, run record).
 */
import * as path from 'node:path';
import { which, run as exec } from '../lib/exec';
import { instrument } from '../lib/log';
import { removeFile } from '../lib/fsx';
import { dropRunDb, planFromRun, recheckPlan } from './dbrun';
import { releasePorts } from './ports';
import { stopService } from './services';
import { pointerPath, saveRun, type VerifyContext, type VerifyRun } from './state';

export interface CleanupResult {
  code: number;
  lines: string[];
}

export async function cleanup(ctx: VerifyContext, run: VerifyRun, o: { keepDb?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CleanupResult> {
  const lines: string[] = [];
  let code = 0;
  for (const s of [...run.services].reverse()) {
    if (!s.pid) continue;
    const r = await stopService(s.pid, s.command);
    if (r === 'stopped') lines.push(`stopped ${s.name} (pid ${s.pid})`);
    else if (r === 'not-running') lines.push(`${s.name} was not running`);
    else {
      lines.push(`${s.name}: pid ${s.pid} is not the process this run started (or would not stop); left alone`);
      code = 1;
    }
  }
  if (run.db && !o.keepDb && !run.db.dropped && run.db.created === false) {
    // The launch failed before the database existed (or found someone else's of the same name): nothing of this run to drop.
    lines.push(`database ${run.db.database} was never created by this run; nothing to drop`);
  } else if (run.db && !o.keepDb && !run.db.dropped) {
    const pf = planFromRun(run.db, ctx.vcfg);
    if (!pf.ok || !pf.plan) {
      lines.push(`database ${run.db.database} not dropped: ${pf.reason}`);
      code = 1;
    } else {
      const rc = recheckPlan(pf.plan, ctx.config.db);
      if (!rc.ok) {
        lines.push(`database ${run.db.database} not dropped: ${rc.reason}`);
        code = 4;
      } else {
        const d = dropRunDb(pf.plan, o.env);
        if (!d.ok) {
          lines.push(`database ${run.db.database} not dropped: ${d.error}`);
          code = 1;
        } else {
          if (d.skipped) lines.push(d.skipped);
          else lines.push(`dropped ${run.db.database}`);
          if (pf.plan.mode === 'per-run') run.db.dropped = true;
          if (run.db.backupFile && run.db.transport === 'docker' && run.db.container) {
            const docker = which('docker');
            if (docker && /harness_test_[a-z0-9]+\.bak$/.test(run.db.backupFile)) {
              const r = exec(docker, ['exec', run.db.container, 'rm', '-f', run.db.backupFile], { timeoutMs: 20000 });
              lines.push(r.code === 0 ? `removed the snapshot copy ${path.basename(run.db.backupFile)} from the container` : `could not remove ${run.db.backupFile} from the container`);
            }
          } else if (run.db.backupFile) lines.push(`the snapshot copy ${run.db.backupFile} stays on the server; remove it there`);
        }
      }
    }
  }
  releasePorts(run.runId);
  for (const rid of new Set(run.services.map((s) => s.repoId))) {
    if (rid === run.repoId) continue;
    try {
      removeFile(pointerPath(rid, run.taskId));
    } catch {
      /* invalid id */
    }
  }
  run.status = 'cleaned';
  saveRun(run);
  instrument({ event: 'verify.cleanup', repo: run.repoId, task: run.taskId, ids: { runId: run.runId }, counts: { services: run.services.length, dropped: run.db?.dropped ? 1 : 0 } });
  lines.push('Evidence kept: the e2e/ artefacts, logs and the run record stay in the run folder.');
  return { code, lines };
}
