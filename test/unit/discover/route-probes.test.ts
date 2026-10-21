/** H: route probes skip test files, example folders, docs, JSDoc and Markdown fences. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { runDiscover } from '../../../src/discover/index';
import { findAstGrep } from '../../../src/discover/astgrep';
import { which } from '../../../src/lib/exec';
import { makeRepo, tempEnv, writeTree } from './helpers';

const ROUTES = (names: string[]): string => `import { Router } from 'express'\nconst app = Router()\n${names.map((n) => `app.get('${n}', (req, res) => res.send('ok'))`).join('\n')}\nexport default app\n`;

test('H: route probes do not count routes in test files, example folders, docs or JSDoc', async (t) => {
  if (!which('git') || !findAstGrep()) {
    t.skip('git or ast-grep is not available');
    return;
  }
  const env = tempEnv();
  try {
    const dir = path.join(env.workspace, 'router');
    makeRepo(
      dir,
      {
        'package.json': '{"name":"router"}\n',
        'src/routes.ts': ROUTES(Array.from({ length: 12 }, (_, i) => `/order-items-${i}`)) + "/**\n * @example\n * app.get('/camelCaseInDoc', handler)\n */\nexport const x = 1\n",
        'src/routes.test.ts': ROUTES(['/testRoute', '/otherRoute']),
        'test/routes.ts': ROUTES(['/inTestFolder']),
        'runtime-tests/bun/index.test.tsx': ROUTES(['/streamHello']),
        'examples/basic/app.ts': ROUTES(['/exampleRoute']),
        'docs/guide.ts': ROUTES(['/docRoute']),
        'README.md': "```ts\napp.get('/markdownRoute', h)\n```\n",
      },
      ['chore: init'],
    );
    const res = await runDiscover({ root: dir, exec: false, write: false });
    const sites = (probe: string): Array<{ file: string }> => {
      const out: Array<{ file: string }> = [];
      for (const r of res.ledger.records.filter((x) => x.id.startsWith(probe))) out.push(...r.evidence.examples);
      return out;
    };
    const route = res.ledger.records.find((r) => r.id.startsWith('api.route-path-case'));
    assert.ok(route, `route record: ${res.ledger.records.map((r) => r.id).join(', ')}`);
    assert.equal(route!.evidence.sites, 12, 'only the twelve routes of src/routes.ts');
    assert.ok(route!.id.endsWith('kebab'));
    assert.ok(sites('api.route-path-case').every((e) => e.file === 'src/routes.ts'));
  } finally {
    env.cleanup();
  }
});
