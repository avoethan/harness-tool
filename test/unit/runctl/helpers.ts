/** Helpers for runner tests: a personal repo with a small task ledger. */
import * as path from 'node:path';
import { repoIdFor } from '../../../src/lib/config';
import { gitRepo, hermeticGit, ledgerTaskText, sha, tempHome, type TempHome } from '../land/helpers';

export interface RunnerRepo {
  home: TempHome;
  root: string;
  repoId: string;
  main0: string;
}

/** A personal repo with two ledger tasks (T-001 priority 1, T-002 priority 2). */
export function runnerRepo(prefix = 'harness-run-', extra: Record<string, string> = {}): RunnerRepo {
  const home = tempHome(prefix);
  hermeticGit(home);
  const root = gitRepo(path.join(home.workspace, 'repo'), {
    'README.md': '# demo\n',
    'src/a.js': 'exports.a = 1;\n',
    'src/b.js': 'exports.b = 2;\n',
    '.harness/config.json': JSON.stringify({ setting: 'personal', agents: ['claude', 'codex'] }, null, 2) + '\n',
    'tasks/T-001-a.md': ledgerTaskText('T-001', 'Make a 42', { priority: 1, paths: ['src/a.js'] }),
    'tasks/T-002-b.md': ledgerTaskText('T-002', 'Make b 43', { priority: 2, paths: ['src/b.js'] }),
    ...extra,
  });
  return { home, root, repoId: repoIdFor(root), main0: sha(root, 'HEAD') };
}
