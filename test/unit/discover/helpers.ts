/** Helpers for discovery tests: temp homes and small synthetic workspaces (never real user content). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../../src/lib/exec';

export interface TempEnv {
  root: string;
  harnessHome: string;
  workspace: string;
  cleanup(): void;
}

export function tempEnv(prefix = 'harness-disc-'): TempEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const userHome = path.join(root, 'home');
  const harnessHome = path.join(userHome, '.harness');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(harnessHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  process.env.HARNESS_HOME = harnessHome;
  process.env.HARNESS_USER_HOME = userHome;
  process.env.HARNESS_NO_INSTRUMENT = '1';
  return { root, harnessHome, workspace, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export function git(dir: string, args: string[]): { code: number | null; stdout: string } {
  const r = run('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    timeoutMs: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, GIT_TERMINAL_PROMPT: '0' },
  });
  return { code: r.code, stdout: r.stdout };
}

/** Create a git repo from files with the given commit subjects (the files land in the first commit). */
export function makeRepo(dir: string, files: Record<string, string>, subjects: string[]): void {
  writeTree(dir, files);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', subjects[0] ?? 'chore: initial']);
  for (const s of subjects.slice(1)) git(dir, ['commit', '-q', '--allow-empty', '-m', s]);
}

const ESLINT = (q: string) => `import js from ${q}@eslint/js${q};
export default [
  js.configs.recommended,
  {
    files: [${q}**/*.ts${q}],
    rules: {
      eqeqeq: [${q}error${q}, ${q}always${q}],
      ${q}no-console${q}: ${q}error${q},
      ${q}@typescript-eslint/explicit-function-return-type${q}: [
        ${q}warn${q},
        { allowExpressions: true },
      ],
    },
  },
  {
    files: [${q}src/lib/logger.ts${q}],
    rules: { ${q}no-console${q}: ${q}off${q} },
  },
];
`;

function module(name: string, q: string, i: number, typed: boolean): string {
  return `import { query } from ${q}../db${q};
import { logger } from ${q}./logger${q};

export interface ${name[0].toUpperCase()}${name.slice(1).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Row {
  id: number;
}

export async function load${i}(id: number)${typed ? ': Promise<unknown[]>' : ''} {
  if (id === ${i}) {
    logger.info(${q}loading${q}, { id });
  }
  return query(${q}SELECT id, name FROM dbo.items WHERE id = @id${q}, { id });
}
`;
}

/**
 * Two repositories that agree on most things and disagree on quote style:
 * alpha (single quotes, Prettier singleQuote true) and beta (double quotes).
 * Both declare eqeqeq (followed) and explicit return types at warn level
 * (followed at about half the sites: a declared-but-not-followed finding).
 */
export function syntheticWorkspace(ws: string): { alpha: string; beta: string } {
  const repos: Array<[string, string]> = [
    ['alpha', "'"],
    ['beta', '"'],
  ];
  const out: Record<string, string> = {};
  for (const [name, q] of repos) {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name, scripts: { build: 'tsc', lint: 'eslint .', test: 'vitest run' }, dependencies: { mssql: '^11.0.0' } }, null, 2) + '\n',
      '.prettierrc.json': JSON.stringify({ singleQuote: q === "'", semi: true }) + '\n',
      'eslint.config.mjs': ESLINT(q),
      'vitest.config.ts': `export default { test: { include: [${q}test/unit/**/*.test.ts${q}] } };\n`,
      '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm run build\n      - run: npm test\n',
      'CONTRIBUTING.md': '# Contributing\n\n## Database\n\nAll database access goes through `src/db.ts`. No other file imports `mssql`.\nName migrations `NNNN_kebab-description.sql` and make them re-runnable: guard DDL with `IF OBJECT_ID` or `IF COL_LENGTH`.\nNever run migrations against a shared database by hand.\n',
      '.env.example': 'DB_SERVER=localhost\nDB_PORT=1433\nDB_NAME=items_test\nDB_USER=sa\nDB_PASSWORD=Very$ecret-Pass1\n',
      'src/db.ts': `import sql from ${q}mssql${q};\nexport async function query(text: string, params: Record<string, unknown> = {}): Promise<unknown[]> {\n  const r = await new sql.Request().query(text);\n  void params;\n  return r.recordset;\n}\n`,
      'src/lib/logger.ts': `export const logger = {\n  info: (message: string, fields: Record<string, unknown> = {}): void => {\n    console.log(JSON.stringify({ message, ...fields }));\n  },\n};\n`,
      'migrations/0001_create-items.sql': "IF OBJECT_ID(N'dbo.items', N'U') IS NULL\nBEGIN\n  CREATE TABLE dbo.items (id INT NOT NULL);\nEND\nGO\n",
      'migrations/0002_add-items-name.sql': "IF COL_LENGTH(N'dbo.items', N'name') IS NULL\nBEGIN\n  ALTER TABLE dbo.items ADD name NVARCHAR(50) NULL;\nEND\nGO\n",
    };
    for (let i = 0; i < 12; i++) {
      const mod = `item-store-${i}`;
      files[`src/lib/${mod}.ts`] = module(mod, q, i, i % 2 === 0);
      files[`test/unit/lib/${mod}.test.ts`] = `import { describe, it, expect } from ${q}vitest${q};\nimport { load${i} } from ${q}../../../src/lib/${mod}${q};\n\ndescribe(${q}${mod}${q}, () => {\n  it(${q}loads${q}, () => {\n    expect(typeof load${i}).toBe(${q}function${q});\n  });\n});\n`;
    }
    const dir = path.join(ws, name);
    makeRepo(dir, files, ['chore: scaffold', 'feat(items): load items', 'fix(items): guard ids', 'docs: contributing', 'test(items): cover loaders', 'refactor(db): pool', 'ci: run tests', 'style: lint fixes', 'feat(items): names', 'chore(deps): bump mssql', 'fix: typo in logger']);
    out[name] = dir;
  }
  return { alpha: out.alpha, beta: out.beta };
}
