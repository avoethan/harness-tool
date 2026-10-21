/**
 * Precision/recall self-test: assess the `selftest` fixture and compare with
 * its frozen, hand-written expected.json (line classes and planted defects).
 * Both numbers must be >= 0.8; the test prints the measured values.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, assess, sandbox } from './helpers';
import type { AssessReport } from '../../../src/types';

interface Expected {
  lines: Record<string, Record<string, string>>;
  findings: Array<{ check: string; file: string }>;
}

/** Map a report path to the expected.json key: workspace-relative, or ~/ for the fake home. */
function keyOf(r: AssessReport, abs: string, ws: string, home: string): string {
  const relWs = path.relative(ws, abs);
  if (!relWs.startsWith('..')) return relWs.split(path.sep).join('/');
  return '~/' + path.relative(home, abs).split(path.sep).join('/');
}

export function score(r: AssessReport, exp: Expected, ws: string, home: string) {
  // classes
  const predicted = new Map<string, string>();
  for (const c of r.classifications) predicted.set(`${keyOf(r, c.file, ws, home)}:${c.line}`, c.cls);
  const expectedNonKeep = new Map<string, string>();
  for (const [file, lines] of Object.entries(exp.lines)) for (const [n, cls] of Object.entries(lines)) expectedNonKeep.set(`${file}:${n}`, cls);
  const scoredFiles = new Set(Object.keys(exp.lines));
  let tp = 0;
  let predPos = 0;
  for (const [k, cls] of predicted) {
    if (!scoredFiles.has(k.slice(0, k.lastIndexOf(':')))) continue;
    if (cls === 'KEEP') continue;
    predPos++;
    if (expectedNonKeep.get(k) === cls) tp++;
  }
  const classPrecision = predPos ? tp / predPos : 1;
  const classRecall = expectedNonKeep.size ? tp / expectedNonKeep.size : 1;
  // findings by (check, file)
  const pairs = new Set<string>();
  for (const f of r.findings) {
    if (f.severity === 'info' && f.check !== 'R25' && f.check !== 'R26') continue;
    pairs.add(`${f.check}|${keyOf(r, f.file, ws, home)}`);
  }
  const expectedPairs = new Set(exp.findings.map((f) => `${f.check}|${f.file}`));
  const hit = [...pairs].filter((p) => expectedPairs.has(p));
  const findPrecision = pairs.size ? hit.length / pairs.size : 1;
  const findRecall = expectedPairs.size ? [...expectedPairs].filter((p) => pairs.has(p)).length / expectedPairs.size : 1;
  return {
    classPrecision,
    classRecall,
    findPrecision,
    findRecall,
    extraPairs: [...pairs].filter((p) => !expectedPairs.has(p)),
    missedPairs: [...expectedPairs].filter((p) => !pairs.has(p)),
    classMisses: [...expectedNonKeep].filter(([k, cls]) => predicted.get(k) !== cls).map(([k, cls]) => `${k} expected ${cls} got ${predicted.get(k) ?? 'none'}`),
    classExtras: [...predicted].filter(([k, cls]) => cls !== 'KEEP' && scoredFiles.has(k.slice(0, k.lastIndexOf(':'))) && expectedNonKeep.get(k) !== cls).map(([k, cls]) => `${k} got ${cls} expected ${expectedNonKeep.get(k) ?? 'KEEP'}`),
  };
}

test('self-test: precision and recall of classes and findings are both >= 0.8', () => {
  const sb = sandbox({ fixture: 'selftest', home: 'selftest-home' });
  try {
    const exp = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'selftest', 'expected.json'), 'utf8')) as Expected;
    const { report } = assess(sb, { setting: 'personal' });
    const s = score(report, exp, sb.ws, sb.home);
    const f = (x: number) => x.toFixed(3);
    process.stdout.write(`# assess self-test: classes precision ${f(s.classPrecision)} recall ${f(s.classRecall)}; findings precision ${f(s.findPrecision)} recall ${f(s.findRecall)}\n`);
    if (s.extraPairs.length) process.stdout.write(`# findings not in expected.json: ${s.extraPairs.join(', ')}\n`);
    if (s.missedPairs.length) process.stdout.write(`# expected findings missed: ${s.missedPairs.join(', ')}\n`);
    if (s.classMisses.length) process.stdout.write(`# class misses: ${s.classMisses.join('; ')}\n`);
    if (s.classExtras.length) process.stdout.write(`# class extras: ${s.classExtras.join('; ')}\n`);
    assert.ok(s.classPrecision >= 0.8, `class precision ${s.classPrecision}`);
    assert.ok(s.classRecall >= 0.8, `class recall ${s.classRecall}`);
    assert.ok(s.findPrecision >= 0.8, `finding precision ${s.findPrecision}`);
    assert.ok(s.findRecall >= 0.8, `finding recall ${s.findRecall}`);
  } finally {
    sb.cleanup();
  }
});
