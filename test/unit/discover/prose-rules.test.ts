/** K: reassurance, forecast and dangling-referent sentences are not written rules. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isNormative } from '../../../src/discover/prose';

test('K: reassurance, forecast and dangling-referent sentences are not rules', () => {
  // Reassurance.
  assert.ok(!isNormative("Although, don't worry!"));
  assert.ok(!isNormative('Do not worry about the formatting, the formatter fixes it.'));
  // Forecast.
  assert.ok(!isNormative('So, if you propose great ideas, but I do not appropriate them, the idea may not be accepted.'));
  assert.ok(!isNormative('Pull requests that skip the template will be closed, as only the maintainers can reopen them.'));
  assert.ok(!isNormative('Only maintainers are likely to review this quickly.'));
  // A forecast sentence that also carries a real obligation stays a rule.
  assert.ok(isNormative("You may use AI to contribute, but it must never waste a maintainer's time or make their work unpleasant."));
  assert.ok(isNormative('Do not push to the main branch; changes will be reviewed before they merge.'));
  // Dangling referent: the object points at an earlier sentence.
  assert.ok(!isNormative('Developers should install both.'));
  assert.ok(!isNormative('Always use it.'));
  assert.ok(!isNormative('You must do this before every release.'));
  // The referent is in the same sentence, or the object is a noun phrase.
  assert.ok(isNormative('Developers should install `pnpm` and Bun, and always use both.'));
  assert.ok(isNormative('Always use `logger` instead of console, never use it for debug output.'));
  assert.ok(isNormative('Developers should install both tools.'));
  // Ordinary rules are unchanged.
  assert.ok(isNormative('Never edit a migration.'));
  assert.ok(isNormative('Tests must not call the network.'));
});

test('F7: a code span or colon after the referent, and "will be rejected", make a rule', () => {
  assert.ok(isNormative('Always run this before committing: `npm test`.'));
  assert.ok(isNormative('You must do this before every release: `npm run build`.'));
  assert.ok(isNormative('Commits that do not follow the convention will be rejected.'));
  assert.ok(isNormative('Changes without tests will be reverted.'));
  // K rejections stay.
  assert.ok(!isNormative("Don't worry"));
  assert.ok(!isNormative('The idea may not be accepted.'));
  assert.ok(!isNormative('Developers should install both.'));
  assert.ok(!isNormative('Pull requests that skip the template will be closed, as only the maintainers can reopen them.'));
});
