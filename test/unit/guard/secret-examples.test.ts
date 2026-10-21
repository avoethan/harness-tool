/**
 * The guard stops reads of env secrets (`.env`, `.env.local`, ...) but lets the agent read and edit the
 * templates (`.env.example`, `.env.sample`, ...) it is told to use instead.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { run, tool, REPO } from './helpers';

const TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.schema', '.env.defaults', '.env.default', '.env.test.example', 'apps/api/.env.example'];
const SECRETS = ['.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.test', '.env.dev', '.env.prod', '.env.ci', '.env.qa', '.env.uat', '.env.stage', '.env.sandbox', '.env.preview', '.env.e2e', '.env.integration', '.env.docker', '.env.prd', '.env.preprod', '.env.secrets', '.env.secret', '.env.backup', '.env.bak', '.env.old', '.env.encrypted', '.env.vault', '.env.staging.bak', '.env.prod.backup', '.env.production.local', 'apps/api/.env', 'apps/api/.env.local'];

for (const setting of ['personal', 'team'] as const) {
  test(`guard (${setting}): the Read tool is allowed on env templates and denied on env secrets`, () => {
    for (const n of TEMPLATES) {
      const r = tool('Read', { file_path: `${REPO}/${n}` }, setting);
      assert.equal(r.decision, 'allow', `Read ${n}: ${r.rail} ${r.reason}`);
    }
    for (const n of SECRETS) {
      const r = tool('Read', { file_path: `${REPO}/${n}` }, setting);
      assert.equal(r.decision, 'deny', `Read ${n}`);
      assert.equal(r.rail, 'secrets', n);
    }
  });

  test(`guard (${setting}): cat of an env template is allowed, cat of an env secret is denied`, () => {
    for (const n of TEMPLATES) {
      const r = run(`cat ${n}`, setting);
      assert.equal(r.decision, 'allow', `cat ${n}: ${r.rail} ${r.reason}`);
    }
    for (const n of SECRETS) {
      const r = run(`cat ${n}`, setting);
      assert.equal(r.decision, 'deny', `cat ${n}`);
      assert.equal(r.rail, 'secrets', n);
    }
  });
}

test('guard: a spelling that is not a template stays denied by the .env prefix check', () => {
  for (const n of ['.env.staging.local', '.env.example.local']) {
    assert.equal(tool('Read', { file_path: `${REPO}/${n}` }).decision, 'deny', n);
  }
});
