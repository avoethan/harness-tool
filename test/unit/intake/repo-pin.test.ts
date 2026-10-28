import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBrief, reassemble } from '../../../src/intake/brief';
import { repoIdFor } from '../../../src/lib/config';
import { tempHome, type TempHome } from '../lifecycle/helpers';

let h: TempHome;
before(() => {
  h = tempHome('harness-repo-pin-');
});
after(() => h.cleanup());

function repo(name: string): string {
  const p = path.join(h.workspace, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, scripts: { test: 'node --test' } }));
  return p;
}

const TICKET = 'Title: Show low stock on the dashboard\nAcceptance Criteria:\n1. GET /inventory/low returns the items below their threshold.\n2. The dashboard lists them.\n';

test('an explicit --repo wins over the guesses and survives a rebuild; without it the guess stands', () => {
  const inv = repo('inventory-service');
  const web = repo('web-dashboard');
  const config = { repos: [{ id: repoIdFor(inv), name: 'inventory-service', path: inv }, { id: repoIdFor(web), name: 'web-dashboard', path: web }] } as never;
  // the guess: "inventory" in the route matches the inventory-service repository
  const guessed = buildBrief(TICKET, { config, defaultRepoPath: web });
  assert.deepEqual(guessed.repoMap.byCriterion.AC1, [repoIdFor(inv)]);
  // the user names the repository: every criterion goes there
  const pinned = buildBrief(TICKET, { config, defaultRepoPath: web, repoPinned: true });
  for (const id of ['AC1', 'AC2']) assert.deepEqual(pinned.repoMap.byCriterion[id], [repoIdFor(web)], id);
  assert.equal(pinned.pinnedRepo, web);
  // answering a question rebuilds the brief from its own file, without --repo: the pin holds
  const again = reassemble(pinned, { config });
  assert.deepEqual(again.repoMap.byCriterion.AC1, [repoIdFor(web)]);
});

test('with --repo, a criterion that names another repository by name still goes there', () => {
  const inv = repo('inventory-service');
  const web = repo('web-dashboard');
  const config = { repos: [{ id: repoIdFor(inv), name: 'inventory-service', path: inv }, { id: repoIdFor(web), name: 'web-dashboard', path: web }] } as never;
  const t = 'Title: Low stock\nAcceptance Criteria:\n1. In inventory-service, GET /inventory/low returns the items below threshold.\n2. The dashboard lists them.\n';
  const b = buildBrief(t, { config, defaultRepoPath: web, repoPinned: true });
  assert.deepEqual(b.repoMap.byCriterion.AC1, [repoIdFor(inv)]);
  assert.deepEqual(b.repoMap.byCriterion.AC2, [repoIdFor(web)]);
});
