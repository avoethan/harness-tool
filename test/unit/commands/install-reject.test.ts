/** `--reject` accepts a path relative to the workspace, or starting with `~`, as well as the full path the plan prints. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRejectPath } from '../../../src/commands/install';

const ws = path.join(os.tmpdir(), 'ws-project');

test('a workspace-relative --reject path resolves inside the workspace', () => {
  assert.equal(resolveRejectPath('.devin/workflows/loop.md', ws), path.join(ws, '.devin', 'workflows', 'loop.md'));
});

test('a full --reject path is kept as given', () => {
  const full = path.join(ws, 'AGENTS.md');
  assert.equal(resolveRejectPath(full, ws), full);
});

test('a --reject path starting with ~ resolves under the home folder', () => {
  assert.equal(resolveRejectPath('~/.config/devin/config.json', ws), path.join(os.homedir(), '.config', 'devin', 'config.json'));
});
