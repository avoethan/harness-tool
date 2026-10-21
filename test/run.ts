/**
 * Runs one suite of the built tests: `node dist/test/run.js <unit|acceptance|behaviour|safety|all> [node --test flags]`.
 *
 * `node --test` expands glob patterns only from Node 21, and the harness
 * supports Node 20, so the suite's files are listed here and passed to
 * `node --test` as paths. Files run one at a time (the suites drive real git
 * repositories and temp homes); `--test-concurrency=1` needs Node 20.10, so
 * an older Node gets one `node --test` process per file instead.
 *
 * Exit code: the test runner's (0 when every test passed or skipped); 1 when
 * the suite has no built files (run `npm run build` first); 2 usage.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SUITES = ['unit', 'acceptance', 'behaviour', 'safety'] as const;

/** Every *.test.js below dir, sorted by path, so runs are repeatable. */
export function testFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.test.js')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Whether this Node accepts --test-concurrency (20.10 and later). */
export function hasTestConcurrency(version: string = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 10);
}

function main(argv: string[]): number {
  const [suite, ...extra] = argv;
  const suites = suite === 'all' ? [...SUITES] : SUITES.filter((s) => s === suite);
  if (!suites.length) {
    process.stderr.write(`usage: node dist/test/run.js <${SUITES.join('|')}|all> [node --test flags]\n`);
    return 2;
  }
  const files = suites.flatMap((s) => testFiles(path.join(__dirname, s)));
  if (!files.length) {
    process.stderr.write(`no built tests for ${suites.join(', ')} under ${__dirname}: run \`npm run build\` first\n`);
    return 1;
  }
  // Two hours is far above any suite; it only stops a hung run.
  const opts = { stdio: 'inherit' as const, timeout: 2 * 60 * 60 * 1000 };
  if (hasTestConcurrency()) {
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...extra, ...files], opts);
    return r.status ?? 1;
  }
  let code = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--test', ...extra, f], opts);
    if (r.status !== 0) code = r.status ?? 1;
  }
  return code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
