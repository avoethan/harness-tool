import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compileAstRules, loadProbeLibrary, parseProbeFile, selfTest, splitRuleId, validateProbe } from '../../../src/discover/probes';
import { findAstGrep } from '../../../src/discover/astgrep';

const lib = loadProbeLibrary();

test('probe library: loads without errors, 50-100 probes, every family represented', () => {
  assert.deepEqual(lib.errors, []);
  assert.ok(lib.probes.length >= 50 && lib.probes.length <= 100, `probes: ${lib.probes.length}`);
  const fams = new Set(lib.probes.map((p) => p.family));
  for (const f of ['lint', 'format', 'naming', 'layout', 'sql', 'tests', 'errors', 'logging', 'api', 'async', 'imports', 'validation', 'types']) assert.ok(fams.has(f as never), `family ${f} missing`);
  const ids = lib.probes.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate probe ids');
  for (const p of lib.probes) {
    assert.match(p.id, /^[a-z]+\.[a-z0-9-]+$/);
    assert.ok(p.site && p.conforming && p.title, `${p.id}: site/conforming/title`);
    assert.ok(p.check?.type, `${p.id}: check`);
  }
});

test('probe library: every regex and ast-grep variant has sg-test cases, and they all pass', (t) => {
  const bin = findAstGrep();
  const r = selfTest(lib, bin);
  assert.deepEqual(r.missingTests, [], 'variants without tests');
  assert.equal(r.regex.failed, 0, r.regex.failures.join('\n'));
  assert.ok(r.regex.cases > 50);
  if (!bin) {
    t.diagnostic('ast-grep not found: ast-grep probe tests not run');
    return;
  }
  assert.ok(r.astGrep.ran, r.astGrep.reason);
  assert.equal(r.astGrep.failed, 0, r.astGrep.failures.join('\n'));
  assert.ok(r.astGrep.passed >= 80, `ast-grep rules tested: ${r.astGrep.passed}`);
});

test('probe file parsing: ast-grep documents and regex probes; validation catches missing fields', () => {
  const ast = parseProbeFile(
    `id: lint.demo/good
language: TypeScript
rule: { kind: binary_expression, regex: '===' }
metadata:
  harness: { probe: lint.demo, family: lint, title: Demo, site: a comparison, conforming: strict, check: { type: ast-grep }, variant: good, statement: Use ===., fixText: Write ===. }
---
id: lint.demo/bad
language: TypeScript
rule: { kind: binary_expression, regex: '==[^=]' }
metadata: { harness: { probe: lint.demo, variant: bad } }
`,
    'lint/demo.yml',
  );
  assert.equal(ast.id, 'lint.demo');
  assert.equal(ast.engine, 'ast-grep');
  assert.deepEqual(ast.variants.map((v) => v.name), ['good', 'bad']);
  assert.deepEqual(validateProbe(ast), []);
  const rules = compileAstRules(ast);
  assert.equal(rules.length, 4, 'TypeScript and Tsx per variant');
  assert.equal(rules[1].id, 'lint.demo/good@tsx');
  assert.deepEqual(splitRuleId('lint.demo/good@tsx'), { probe: 'lint.demo', variant: 'good' });
  const rx = parseProbeFile(`id: naming.demo\nengine: filename\nfamily: naming\ntitle: T\nsite: s\nconforming: c\ncheck: { type: regex }\nvariants:\n  - { name: a, pattern: '^a', statement: A., fixText: Fix. }\n  - { name: b, pattern: '^b' }\n`, 'naming/demo.yml');
  assert.deepEqual(validateProbe(rx), []);
  const broken = parseProbeFile(`id: bad\nengine: filename\nfamily: nope\ntitle: T\nsite: s\nconforming: c\nvariants:\n  - { name: a, pattern: '(' }\n`, 'x.yml');
  const errs = validateProbe(broken);
  assert.ok(errs.some((e) => /family/.test(e)));
  assert.ok(errs.some((e) => /does not compile/.test(e)));
  assert.ok(errs.some((e) => /at least two variants/.test(e)));
});
