/**
 * Env-file templates (`.env.example` and the other SECRET_EXAMPLE_RE names) hold no secrets and are what the
 * agent is told to read instead of `.env`. No agent's rendered rules may deny them; `.env`, `.env.local` and the
 * other real secret spellings stay denied.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { AgentId, Setting } from '../../../src/types';
import { renderHarness } from '../../../src/render/index';
import { SECRET_EXAMPLE_RE, SECRET_GLOBS, ENV_SECRET_NAMES } from '../../../src/guard/rails';
import { buildPermissions } from '../../../src/guard/permissions';
import { permissionOptions } from '../../../src/render/permissions';
import { globToRegExp } from '../../../src/discover/glob';
import { context } from './helpers';

const TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.schema', '.env.defaults', '.env.default', '.env.test.example', 'config/.env.example', 'apps/api/.env.sample'];
const SECRETS = ['.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.test', '.env.dev', '.env.prod', '.env.ci', '.env.production.local', '.env.test.local', '.env.qa', '.env.uat', '.env.stage', '.env.sandbox', '.env.preview', '.env.e2e', '.env.integration', '.env.docker', '.env.prd', '.env.preprod', '.env.secrets', '.env.secret', '.env.backup', '.env.bak', '.env.old', '.env.encrypted', '.env.vault', '.env.staging.bak', '.env.prod.backup', 'config/.env', 'apps/api/.env.local', 'apps/api/.env.production'];
const SETTINGS: Setting[] = ['team', 'personal'];

test('the template names are exactly the ones SECRET_EXAMPLE_RE exempts', () => {
  for (const n of TEMPLATES) assert.ok(SECRET_EXAMPLE_RE.test(n), n);
  for (const n of SECRETS) assert.ok(!SECRET_EXAMPLE_RE.test(n), n);
});

test('the secret globs list concrete env spellings, never the .env.* glob', () => {
  assert.ok(!SECRET_GLOBS.some((g) => /\.env\.\*$/.test(g)), 'no .env.* glob');
  for (const n of ENV_SECRET_NAMES) assert.ok(SECRET_GLOBS.includes(n) && SECRET_GLOBS.includes(`**/${n}`), n);
  for (const n of ['.env.local', '.env.*.local', '.env.development', '.env.production', '.env.staging', '.env.test', '.env.dev', '.env.prod', '.env.ci', '.env.qa', '.env.uat', '.env.stage', '.env.sandbox', '.env.preview', '.env.e2e', '.env.integration', '.env.docker', '.env.prd', '.env.preprod', '.env.secrets', '.env.secret', '.env.backup', '.env.bak', '.env.old', '.env.encrypted', '.env.vault', '.env.*.bak', '.env.*.backup']) assert.ok(ENV_SECRET_NAMES.includes(n), n);
});

/** A path rule `Read(<glob>)` as the rendered file holds it matches a repository-relative path. */
function pathRuleMatches(rule: string, tool: string, rel: string): boolean {
  const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(rule);
  return !!m && globToRegExp(m[1]).test(rel);
}

/** Codex prefix rules forbid a command whose leading words equal the pattern. */
function codexForbids(rules: string[], argv: string[]): boolean {
  return rules.some((r) => {
    const m = /^prefix_rule\(pattern=\[(.*?)\], decision="forbidden"/.exec(r);
    if (!m) return false;
    const pat = JSON.parse(`[${m[1]}]`) as string[];
    return pat.length <= argv.length && pat.every((w, i) => argv[i] === w);
  });
}

function renderedRules(setting: Setting, agent: AgentId): string[] {
  const ctx = context(setting, [agent]);
  const r = renderHarness(ctx);
  const out: string[] = [];
  for (const f of r.files) {
    const p = f.path.split(path.sep).join('/');
    const mine = agent === 'claude' ? /\/\.claude\/settings(\.local)?\.json$|\/\.claude\/settings/.test(p) : agent === 'devin' ? /devin\/.*\.json$|\.devin\/.*\.json$/.test(p) : /\.rules$/.test(p);
    if (!mine) continue;
    for (const m of f.content.matchAll(/"((?:Read|Edit|Write|MultiEdit|NotebookEdit|Exec|Bash)\([^"]*\))"/g)) out.push(m[1]);
    for (const m of f.content.matchAll(/^prefix_rule\(.*\)$/gm)) out.push(m[0]);
  }
  return out;
}

for (const setting of SETTINGS) {
  for (const agent of ['claude', 'devin', 'codex'] as AgentId[]) {
    test(`rendered ${agent} rules (${setting}): env templates can be read, real env files stay denied`, () => {
      const rules = renderedRules(setting, agent);
      if (agent === 'codex') {
        assert.ok(rules.some((r) => r.includes('"cat", ".env"')), 'the codex rules file holds the cat .env prefix');
        assert.ok(codexForbids(rules, ['cat', '.env']), 'cat .env is forbidden');
        for (const n of TEMPLATES) assert.ok(!codexForbids(rules, ['cat', n]), `cat ${n} is not forbidden`);
        return;
      }
      assert.ok(rules.some((r) => r.startsWith('Read(')), `${agent} rules were found in the rendered files`);
      assert.ok(rules.includes('Read(**/.env)') || rules.some((r) => r.startsWith('Read(') && r.endsWith('.env)')), 'the .env read deny is rendered');
      for (const n of SECRETS) assert.ok(rules.some((r) => pathRuleMatches(r, 'Read', n)), `Read of ${n} is denied (${agent}, ${setting})`);
      for (const n of TEMPLATES) {
        for (const tool of ['Read', 'Edit', 'Write']) assert.ok(!rules.some((r) => pathRuleMatches(r, tool, n)), `${tool} of ${n} must not be denied (${agent}, ${setting}); matched by ${rules.filter((r) => pathRuleMatches(r, tool, n)).join(', ')}`);
      }
    });
  }
}

test('buildPermissions for all three agents agrees with the rendered files', () => {
  const ctx = context('team', ['claude', 'devin', 'codex']);
  const p = buildPermissions(permissionOptions(ctx, []));
  for (const n of TEMPLATES) {
    assert.ok(!p.claude.deny.some((r) => pathRuleMatches(r, 'Read', n)), `claude ${n}`);
    assert.ok(!p.devin.deny.some((r) => pathRuleMatches(r, 'Read', n)), `devin ${n}`);
    assert.ok(!codexForbids(p.codex.rules, ['cat', n]), `codex ${n}`);
  }
  for (const n of SECRETS) {
    assert.ok(p.claude.deny.some((r) => pathRuleMatches(r, 'Read', n)), `claude ${n}`);
    assert.ok(p.devin.deny.some((r) => pathRuleMatches(r, 'Read', n)), `devin ${n}`);
  }
});
