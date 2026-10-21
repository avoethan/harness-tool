/** Helpers for gate tests: temp repos built in the test, briefs and phase records. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Criterion } from '../../../src/types';
import type { BriefFile } from '../../../src/intake/brief';
import { saveBrief, setCurrentTask } from '../../../src/intake/brief';
import { repoIdFor } from '../../../src/lib/config';
import { git, gitRepo } from '../lifecycle/helpers';

export { git, gitRepo, tempHome, type TempHome } from '../lifecycle/helpers';

export function put(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function commitAll(root: string, msg = 'change'): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']).stdout.trim();
}

export const NODE_TEST_PKG = JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }, null, 2) + '\n';

/** A small repo whose suite runs with node's own test runner. */
export function demoRepo(dir: string, extra: Record<string, string> = {}): string {
  return gitRepo(dir, {
    'package.json': NODE_TEST_PKG,
    'src/add.js': 'exports.add = (a, b) => a + b;\n',
    'test/add.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add');\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\n",
    ...extra,
  });
}

/** Write a minimal brief for a repo and make it the current task. */
export function writeBrief(root: string, id: string, criteria: Criterion[], extra: Partial<BriefFile> & { allowedPaths?: string[] } = {}): BriefFile {
  const repoId = repoIdFor(root);
  const now = new Date().toISOString();
  const b = {
    version: 1,
    id,
    ticketHash: 'x'.repeat(64),
    title: 'Test task',
    description: '',
    criteria,
    units: [{ id: 'U1', title: 'unit', repo: repoId, paths: [], dependsOn: [], criteria: criteria.map((c) => c.id) }],
    repos: [repoId],
    questions: [],
    assumptions: [],
    createdAt: now,
    source: 'ticket',
    format: 'plain',
    inferred: false,
    codeBlocks: 0,
    hiddenRemoved: 0,
    criteriaMeta: {},
    questionDetails: [],
    queued: [],
    markers: [],
    observations: [],
    clarifications: [],
    dropped: [],
    repoMap: { ticket: [repoId], byCriterion: {}, repos: {} },
    landingOrder: [repoId],
    unitEstimates: {},
    baseShas: { [repoId]: git(root, ['rev-parse', 'HEAD']).stdout.trim() },
    lint: [],
    updatedAt: now,
    ...extra,
  } as unknown as BriefFile;
  saveBrief(b);
  setCurrentTask(repoId, id);
  return b;
}
