/** Unit tests for the check helpers (pure functions) behind R04, R05, R25, R29-R31, safety and config parsing. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { actionClaim, checkableRule, commandRefs, pathCandidate, pathLikeLine, STALE_FACTS, styleClaims } from '../../../src/assess/checks';
import { codexPrefixRules, safetyTopic } from '../../../src/assess/safety';
import { hookCommands } from '../../../src/assess/configchecks';
import { parseWorkflow } from '../../../src/assess/project';
import { SKILL_NAME_RE } from '../../../src/assess/skills';
import { kindOfPath } from '../../../src/assess/inventory';

test('R04 command references: explicit run forms anywhere, bare forms only in code', () => {
  const names = (line: string, fence = false) => commandRefs(line, fence).map((c) => `${c.tool}:${c.name}`);
  assert.deepEqual(names('Run npm run verify, then npm test.'), ['script:verify', 'script:test']);
  assert.deepEqual(names('Use pnpm lint to check.'), [], 'bare pnpm X in prose is not a command');
  assert.deepEqual(names('Use `pnpm lint` and `pnpm install`.'), ['script:lint'], 'builtins are skipped');
  assert.deepEqual(names('make sure it builds'), []);
  assert.deepEqual(names('`make build` or `just fmt`'), ['make:build', 'just:fmt']);
  assert.deepEqual(names('yarn test:unit --watch', true), ['script:test:unit']);
  assert.deepEqual(names('npm run <script>'), []);
});

test('R05 path candidates: repo-relative paths only', () => {
  assert.deepEqual(pathCandidate('src/app.ts'), { path: 'src/app.ts', maybe: false });
  assert.equal(pathCandidate('src/app.ts:12')?.path, 'src/app.ts');
  assert.equal(pathCandidate('docs/')?.maybe, false);
  assert.equal(pathCandidate('owner/repo')?.maybe, true, 'two segments without an extension need their first folder to exist');
  for (const t of ['https://x.example/a', '~/notes/a.md', '/etc/hosts', '@scope/pkg', 'a b/c', 'src/*.ts', '$HOME/x', 'npm run x', 'src/.env.local']) assert.equal(pathCandidate(t), null, t);
  assert.equal(pathCandidate('v1/2')?.maybe, true, 'checked only when the first folder exists');
});

test('R25 instruction-as-check: checkable directives and their enforcers', () => {
  for (const s of [
    'Use === and !==, never == or !=.',
    'File names are kebab-case.',
    'Every new module under src/ gets a unit test under test/.',
    'Keep commit subjects in the Conventional Commits form.',
    'Always wrap Express route handlers in asyncHandler.',
    'Never build SQL with string concatenation.',
    'Run the linter before you push.',
    'Do not edit files under generated/ or package-lock.json.',
    'Functions stay under 40 lines.',
  ])
    assert.ok(checkableRule(s), s);
  for (const s of ['Prefer small commits with one logical change each.', 'Explain what you changed in plain words.', 'The integration tests need Docker running.', 'Ask before adding a new dependency.', 'Is the test flaky?']) assert.equal(checkableRule(s), null, s);
});

test('R29/R30 style claims', () => {
  const v = (s: string) => styleClaims(s).map((c) => `${c.topic}=${c.value}`);
  assert.deepEqual(v('Use tabs for indentation, never spaces.'), ['indent-style=tab']);
  assert.deepEqual(v('Never use tabs; indent with 2 spaces.'), ['indent-style=space', 'indent-size=2']);
  assert.deepEqual(v('No semicolons.'), ['semi=false']);
  assert.deepEqual(v('Always use semicolons at the end of statements.'), ['semi=true']);
  assert.deepEqual(v('Use single quotes for strings.'), ['quotes=single']);
  assert.deepEqual(v('Use === and !==, never == or !=.'), ['eqeqeq=strict']);
  assert.deepEqual(v('Loose equality (`==`) is fine.'), ['eqeqeq=loose']);
  assert.deepEqual(v('Use pnpm, not npm.'), ['package-manager=pnpm']);
  assert.deepEqual(v('Run npm test before you push.'), []);
});

test('R30 action claims: the same action with opposite polarity, qualifiers kept apart', () => {
  const a = actionClaim('Run the full test suite with `npm test` before every commit.');
  const b = actionClaim('Do not run the full test suite locally; CI runs it.');
  assert.equal(a?.topic, 'do:run:full test suite');
  assert.equal(a?.value, '+');
  assert.equal(b?.topic, 'do:run:full test suite@local');
  assert.equal(b?.value, '-');
  assert.equal(actionClaim('Run migrations against the test database.')?.topic, 'do:run:migrations@test database');
  assert.equal(actionClaim('Keep it short.'), null);
});

test('R31 stale facts: Cascade as an agent, not SQL ON DELETE CASCADE', () => {
  const hit = (s: string) => STALE_FACTS.some((f) => f.re.test(s) && !(f.unless && f.unless.test(s)));
  assert.ok(hit('Cascade reads this file before every task.'));
  assert.ok(hit('Claude Code does not support hooks.'));
  assert.ok(hit('Rules are limited to 12,000 characters.'));
  assert.ok(hit('Run codex exec --full-auto.'));
  assert.equal(hit('FOREIGN KEY ... ON DELETE CASCADE'), false);
  assert.equal(hit('Cascade (the legacy agent) was removed.'), false);
});

test('safety topics: never/always sentences about production, secrets, history, protected branches', () => {
  for (const s of ['Never run migrations against production.', 'Never commit secrets or .env files.', 'Never force-push shared branches.', 'Never push to main.', 'Only use the test database.', 'Do not deploy on Fridays.', 'Never use --no-verify.']) assert.ok(safetyTopic(s), s);
  for (const s of ['Use tabs for indentation, never spaces.', 'Database access goes through query.js; never build SQL by hand.', 'Run the tests.', 'Prefer small commits.']) assert.equal(safetyTopic(s), null, s);
});

test('Codex prefix rules, hook commands, CI workflow triggers and jobs', () => {
  const rules = codexPrefixRules('prefix_rule(\n  pattern = ["git", "push", "--force"],\n  decision = "forbidden",\n)\nprefix_rule(pattern=["rm"], decision="prompt")');
  assert.deepEqual(
    rules.map((r) => [r.line, r.pattern.join(' '), r.decision]),
    [
      [1, 'git push --force', 'forbidden'],
      [5, 'rm', 'prompt'],
    ],
  );
  const claude = hookCommands({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node a.js' }] }], Stop: [{ hooks: [{ type: 'command', command: 'b' }] }] } });
  assert.deepEqual(
    claude.map((h) => `${h.event}:${h.command}`),
    ['PreToolUse:node a.js', 'Stop:b'],
  );
  const cursor = hookCommands({ version: 1, hooks: { beforeShellExecution: [{ command: './check.sh' }] } });
  assert.equal(cursor[0].event, 'beforeShellExecution');
  const wf = parseWorkflow('name: x\non:\n  issue_comment:\n    types: [created]\n  push:\njobs:\n  test:\n    name: unit tests\n    runs-on: x\n  build:\n    runs-on: y\n', 'ci.yml');
  assert.deepEqual([...wf.triggers].sort(), ['issue_comment', 'push']);
  assert.deepEqual(
    wf.jobs.map((j) => j.name),
    ['unit tests', 'build'],
  );
  assert.deepEqual([...parseWorkflow('on: [push, pull_request_target]\n', 'x').triggers], ['push', 'pull_request_target']);
});

test('skill names and agent-file kinds by path', () => {
  assert.ok(SKILL_NAME_RE.test('db-helper'));
  for (const n of ['SQL Helper', 'lintFixer', 'a--b', '-a', 'snake_case']) assert.equal(SKILL_NAME_RE.test(n), false, n);
  const k = (p: string) => kindOfPath(p)?.kind ?? null;
  assert.equal(k('AGENTS.md'), 'instructions');
  assert.equal(k('pkg/CLAUDE.local.md'), 'instructions');
  assert.equal(k('.claude/CLAUDE.md'), 'instructions');
  assert.equal(k('.devin/rules/a.md'), 'rule');
  assert.equal(k('.cursor/rules/a.mdc'), 'rule');
  assert.equal(k('.claude/skills/x/SKILL.md'), 'skill');
  assert.equal(k('.agents/skills/x/SKILL.md'), 'skill');
  assert.equal(k('.cursorrules'), 'legacy');
  assert.equal(k('GEMINI.md'), 'legacy');
  assert.equal(k('.github/copilot-instructions.md'), 'legacy');
  assert.equal(k('.windsurfrules'), 'instructions');
  assert.equal(k('.claude/settings.local.json'), 'settings');
  assert.equal(k('.codex/config.toml'), 'settings');
  assert.equal(k('.codex/rules/x.rules'), 'codex-rules');
  assert.equal(k('.devin/hooks.v1.json'), 'hook-config');
  assert.equal(k('.mcp.json'), 'mcp');
  assert.equal(k('.vscode/mcp.json'), 'mcp');
  assert.equal(k('src/index.ts'), null);
  assert.equal(k('README.md'), null);
});

test('derivable lines: paths and tree drawings', () => {
  assert.ok(pathLikeLine('  src/app.js  src/server.js'));
  assert.ok(pathLikeLine('├── routes/'));
  assert.ok(pathLikeLine('packages/core/src/{config,db}.ts'));
  assert.equal(pathLikeLine('Run the tests before you push.'), false);
});
