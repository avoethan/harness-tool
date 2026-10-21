import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseYaml, parseYamlDocuments, stringifyYaml, stringifyYamlDocuments } from '../../../src/discover/yaml';

test('yaml: mappings, sequences, scalars and comments', () => {
  const v = parseYaml(`
# comment
name: ci   # trailing
on:
  push:
    branches: [main, 'release/*']
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Test
        run: |
          npm run build
          npm test
flag: yes
n: 3
f: 1.5
nothing: ~
empty:
`) as Record<string, any>;
  assert.equal(v.name, 'ci');
  assert.deepEqual(v.on.push.branches, ['main', 'release/*']);
  assert.equal(v.on.pull_request, null);
  assert.equal(v.jobs.check.steps.length, 4);
  assert.equal(v.jobs.check.steps[1].with['node-version'], 20);
  assert.equal(v.jobs.check.steps[2].run, 'npm ci');
  assert.equal(v.jobs.check.steps[3].run, 'npm run build\nnpm test\n');
  assert.equal(v.flag, 'yes');
  assert.equal(v.n, 3);
  assert.equal(v.f, 1.5);
  assert.equal(v.nothing, null);
  assert.equal(v.empty, null);
});

test('yaml: sequence at the same indent as its key, nested items, flow maps', () => {
  const v = parseYaml(`
steps:
- uses: a
- run: b
rule:
  any:
    - kind: binary_expression
      has: { field: operator, regex: '^(==|!=)$' }
    - pattern: foo($A)
list:
  - - x
    - y
  - z
`) as Record<string, any>;
  assert.deepEqual(v.steps, [{ uses: 'a' }, { run: 'b' }]);
  assert.deepEqual(v.rule.any[0], { kind: 'binary_expression', has: { field: 'operator', regex: '^(==|!=)$' } });
  assert.equal(v.rule.any[1].pattern, 'foo($A)');
  assert.deepEqual(v.list, [['x', 'y'], 'z']);
});

test('yaml: quoted scalars, block scalars and folded text', () => {
  const v = parseYaml(`
a: "tab\\tquote\\" end"
b: 'it''s # not a comment'
c: >-
  folded
  text

  para
d: |-
  keep
    indent
e: plain text
  continued here
"quoted key": 1
`) as Record<string, any>;
  assert.equal(v.a, 'tab\tquote" end');
  assert.equal(v.b, "it's # not a comment");
  assert.equal(v.c, 'folded text\npara');
  assert.equal(v.d, 'keep\n  indent');
  assert.equal(v.e, 'plain text continued here');
  assert.equal(v['quoted key'], 1);
});

test('yaml: multi-document streams, anchors and merge keys', () => {
  const docs = parseYamlDocuments(`id: one
x: 1
---
id: two
base: &b { image: mssql, ports: ["1433:1433"] }
svc:
  <<: *b
  name: db
`);
  assert.equal(docs.length, 2);
  const d2 = docs[1] as Record<string, any>;
  assert.equal(d2.svc.image, 'mssql');
  assert.deepEqual(d2.svc.ports, ['1433:1433']);
  assert.equal(d2.svc.name, 'db');
});

test('yaml: writer output parses back to the same value', () => {
  const value = {
    id: 'lint.eqeqeq/strict',
    language: 'TypeScript',
    rule: { any: [{ kind: 'binary_expression', has: { field: 'operator', regex: '^(==|!=)$' } }, { pattern: 'a: b # c' }] },
    message: 'line one\nline "two"',
    empty: [],
    obj: {},
    flags: [true, false, null, 3, 'yes', '-dash', ''],
    nested: [[1, 2], [{ a: 1, b: [] }]],
  };
  const text = stringifyYaml(value);
  assert.deepEqual(parseYaml(text), value);
  const multi = stringifyYamlDocuments([{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(parseYamlDocuments(multi), [{ id: 'a' }, { id: 'b' }]);
});

test('yaml: rejects tabs and unterminated flow collections with a line number', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /line 2/);
  assert.throws(() => parseYaml('a: [1, 2\n'), /unterminated/);
});
