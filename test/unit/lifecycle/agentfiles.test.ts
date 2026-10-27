import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentFileChanges, agentFileDiff, formatAgentFileChanges, loadAgentFilesRecord, recordAgentFiles } from '../../../src/lifecycle/agentfiles';
import { tempHome, write, type TempHome } from './helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-agentfiles-');
});
after(() => h.cleanup());

test('the agent-files record lists instructions, skills and workflows added, changed or removed since, with line diffs', () => {
  const ws = h.workspace;
  const opts = { workspace: ws, setting: 'team' as const, agents: ['devin' as const] };
  write(path.join(ws, 'AGENTS.md'), '# Team\nuse pnpm\n');
  write(path.join(ws, '.devin', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: deploy it\n---\nsteps\n');
  write(path.join(ws, '.devin', 'workflows', 'release.md'), 'release steps\n');
  write(path.join(ws, 'notes.md'), 'not an agent file\n');
  assert.equal(formatAgentFileChanges(null, []).includes('not recorded yet'), true);

  const rec = recordAgentFiles({ ...opts, by: 'user' });
  const names = rec.files.map((f) => f.display).sort();
  assert.ok(names.some((n) => n.endsWith('AGENTS.md')), names.join(','));
  assert.ok(names.some((n) => n.endsWith('deploy/SKILL.md')), names.join(','));
  assert.ok(names.some((n) => n.endsWith('workflows/release.md')), names.join(','));
  assert.ok(!names.some((n) => n.endsWith('notes.md')), 'only agent files are recorded');
  assert.equal(agentFileChanges(rec, opts).length, 0);

  fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Team\nuse npm\n');
  fs.rmSync(path.join(ws, '.devin', 'workflows', 'release.md'));
  write(path.join(ws, '.devin', 'skills', 'new', 'SKILL.md'), '---\nname: new\ndescription: new one\n---\nx\n');
  const loaded = loadAgentFilesRecord()!;
  const ch = agentFileChanges(loaded, opts);
  const byKind = (k: string) => ch.filter((c) => c.change === k).map((c) => path.basename(path.dirname(c.path)) + '/' + path.basename(c.path));
  assert.deepEqual(byKind('changed').map((x) => x.split('/')[1]), ['AGENTS.md']);
  assert.deepEqual(byKind('removed'), ['workflows/release.md']);
  assert.deepEqual(byKind('added'), ['new/SKILL.md']);
  const d = agentFileDiff(ch.find((c) => c.change === 'changed')!);
  assert.match(d, /-use pnpm/);
  assert.match(d, /\+use npm/);
  assert.match(agentFileDiff(ch.find((c) => c.change === 'removed')!), /-release steps/);
  const text = formatAgentFileChanges(loaded, ch, { diff: true });
  assert.match(text, /taken by you/);
  assert.match(text, /by: not the harness \(you or an agent\)/);
  assert.match(text, /removed .*release\.md/);

  // recording again makes now the starting point
  const again = recordAgentFiles({ ...opts, by: 'user' });
  assert.equal(agentFileChanges(again, opts).length, 0);
});
