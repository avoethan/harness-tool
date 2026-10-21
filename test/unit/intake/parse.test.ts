import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTicket, splitSentences, detectFormat, LOW_CONFIDENCE } from '../../../src/intake/parse';
import { sha256 } from '../../../src/lib/hash';

const texts = (t: string) => parseTicket(t).criteria.map((c) => c.text);

test('format 1: Jira wiki markup with h2 sections, # list, *bold* and a {code} block', () => {
  const t = [
    'h1. SHOP-142 Add order total',
    'h2. Description',
    'Customers want to see the *order total* on the order page.',
    '{code:json}',
    '{ "total": 12.5 }',
    '# not a criterion inside code',
    '{code}',
    'h2. Acceptance Criteria',
    '# GET {{/orders/:id}} returns the *total*',
    '# The total is stored in the orders.total column',
    '## rounded to 2 decimals',
    'h2. Notes',
    '* see the pricing service',
  ].join('\n');
  const p = parseTicket(t);
  assert.equal(p.format, 'jira');
  assert.equal(p.title, 'SHOP-142 Add order total');
  assert.deepEqual(texts(t), ['GET `/orders/:id` returns the total', 'The total is stored in the orders.total column; rounded to 2 decimals']);
  assert.match(p.description, /order total/);
  assert.match(p.description, /\{code:json\}/);
  assert.match(p.description, /Notes:/);
  assert.equal(p.codeBlocks, 1);
  assert.equal(p.inferred, false);
});

test('format 2: Markdown headings, bullets and a fenced code block that must not become criteria', () => {
  const t = [
    '# Export orders as CSV',
    '',
    '## Description',
    'Support wants a CSV export.',
    '',
    '```bash',
    '- curl /orders/export',
    '1. not an item',
    '```',
    '',
    '## Acceptance Criteria',
    '- GET /orders/export returns 200 with `text/csv`',
    '- The file has one row per order',
    '',
  ].join('\n');
  const p = parseTicket(t);
  assert.equal(p.format, 'markdown');
  assert.equal(p.title, 'Export orders as CSV');
  assert.deepEqual(texts(t), ['GET /orders/export returns 200 with `text/csv`', 'The file has one row per order']);
  assert.match(p.description, /```bash/);
  assert.match(p.description, /1\. not an item/);
});

test('format 3: prose only, must/should sentences become low-confidence criteria', () => {
  const t = 'Refund emails\n\nWhen a refund is issued the customer must receive an email. The email should include the refund amount, e.g. 12.50 EUR. We talked about this last week.';
  const p = parseTicket(t);
  assert.equal(p.title, 'Refund emails');
  assert.equal(p.inferred, true);
  assert.deepEqual(
    p.criteria.map((c) => c.text),
    ['When a refund is issued the customer must receive an email.', 'The email should include the refund amount, e.g. 12.50 EUR.'],
  );
  assert.ok(p.criteria.every((c) => c.source === 'prose' && c.confidence < LOW_CONFIDENCE));
});

test('format 4: Given/When/Then scenarios with Scenario names', () => {
  const t = [
    'Title: Discount codes',
    'Acceptance Criteria:',
    'Scenario: valid code',
    'Given a cart with total 100',
    'And a valid code SAVE10',
    'When the user applies the code',
    'Then the total is 90',
    '',
    'Scenario: expired code',
    'Given an expired code',
    'When the user applies it',
    'Then the API returns 422',
  ].join('\n');
  const p = parseTicket(t);
  assert.equal(p.title, 'Discount codes');
  assert.deepEqual(texts(t), [
    'valid code: Given a cart with total 100, and a valid code SAVE10, when the user applies the code, then the total is 90',
    'expired code: Given an expired code, when the user applies it, then the API returns 422',
  ]);
  assert.ok(p.criteria.every((c) => c.source === 'gwt'));
});

test('format 5: Markdown checkboxes, checked and unchecked, with no AC heading', () => {
  const t = 'Archive old carts\n\nCarts older than 30 days are archived nightly.\n\n- [ ] carts older than 30 days move to carts_archive\n- [x] the job logs a count of archived carts\n[ ] the job is idempotent\n';
  const p = parseTicket(t);
  assert.deepEqual(texts(t), ['carts older than 30 days move to carts_archive', 'the job logs a count of archived carts', 'the job is idempotent']);
  assert.ok(p.criteria.every((c) => c.source === 'checkbox'));
  assert.match(p.description, /archived nightly/);
});

test('format 6: mixed AC1:/AC2: labels with bold and a description', () => {
  const t = 'Summary: Order history paging\nBackground: The history page loads every order at once.\n\n**AC1:** GET /orders?page=2 returns the second page\nAC 2 - page size defaults to 20\n*AC3*: the response has a `next` link\n';
  const p = parseTicket(t);
  assert.equal(p.title, 'Order history paging');
  assert.deepEqual(
    p.criteria.map((c) => [c.label, c.text]),
    [
      ['AC1', 'GET /orders?page=2 returns the second page'],
      ['AC2', 'page size defaults to 20'],
      ['AC3', 'the response has a `next` link'],
    ],
  );
  assert.equal(p.description, 'The history page loads every order at once.');
});

test('format 7: no description, title line and a short "AC:" heading', () => {
  const t = 'Add order total\nAC:\n1. GET /orders/:id returns total\n2. total stored in orders.total column\n';
  const p = parseTicket(t);
  assert.equal(p.title, 'Add order total');
  assert.equal(p.description, '');
  assert.deepEqual(texts(t), ['GET /orders/:id returns total', 'total stored in orders.total column']);
  assert.deepEqual(
    p.criteria.map((c) => c.label),
    ['1', '2'],
  );
});

test('format 8: the acceptance example from the brief (Title: label and numbered list)', () => {
  const t = 'Title: Add order total\nAcceptance Criteria:\n1. GET /orders/:id returns total\n2. total stored in orders.total column\n';
  const p = parseTicket(t);
  assert.equal(p.title, 'Add order total');
  assert.deepEqual(texts(t), ['GET /orders/:id returns total', 'total stored in orders.total column']);
  assert.equal(p.hash, sha256(t));
});

test('format 9: repo paths and service names stay verbatim in criteria', () => {
  const t = '## Fix rounding in orders-api\n### Acceptance criteria\n* `services/orders-api/src/total.ts` rounds half up\n* catalog-api keeps its prices unchanged\n';
  const p = parseTicket(t);
  assert.equal(p.title, 'Fix rounding in orders-api');
  assert.deepEqual(texts(t), ['`services/orders-api/src/total.ts` rounds half up', 'catalog-api keeps its prices unchanged']);
});

test('format 10: Jira {noformat} and Markdown ~~~ blocks inside the criteria section are kept out of criteria', () => {
  const t = [
    'h2. Acceptance Criteria',
    '# POST /orders returns 201 with this body:',
    '{noformat}',
    '# total: 10',
    '* currency: EUR',
    '{noformat}',
    '# The order id is returned',
    '~~~',
    '- not this',
    '~~~',
  ].join('\n');
  const p = parseTicket(t);
  assert.deepEqual(texts(t), ['POST /orders returns 201 with this body:', 'The order id is returned']);
  assert.match(p.description, /Code from the acceptance criteria/);
  assert.match(p.description, /currency: EUR/);
  assert.equal(p.codeBlocks, 2);
});

test('format 11: bold Markdown labels, nested sub-bullets and continuation lines', () => {
  const t = [
    '**Title:** Invoice PDF',
    '**Description:** Customers download invoices.',
    '',
    '**Acceptance Criteria:**',
    '1. The invoice endpoint returns:',
    '   - status 200',
    '   - a PDF body',
    '2. The PDF shows the VAT number',
    '   of the seller',
  ].join('\n');
  const p = parseTicket(t);
  assert.equal(p.title, 'Invoice PDF');
  assert.equal(p.description, 'Customers download invoices.');
  assert.deepEqual(texts(t), ['The invoice endpoint returns: status 200; a PDF body', 'The PDF shows the VAT number of the seller']);
});

test('format 12: numbered with parens and letters, CRLF line endings, Definition of Done heading', () => {
  const t = 'Bulk price update\r\n\r\nDefinition of Done\r\n1) prices update in one transaction\r\n(2) a failed row rolls back all rows\r\na. the audit table records the user\r\n';
  const p = parseTicket(t);
  assert.equal(p.title, 'Bulk price update');
  assert.deepEqual(texts(t), ['prices update in one transaction', 'a failed row rolls back all rows', 'the audit table records the user']);
});

test('format 13: plain lines under an AC heading, an intro line that prefixes items, and Jira metadata dropped', () => {
  const t = [
    'Summary',
    'Low stock alert',
    'Priority: High',
    'Assignee: someone',
    'Acceptance criteria',
    'The alert is sent when stock falls below 5. It is sent once per day.',
    '',
    'The alert email must:',
    '- name the product',
    '- link to the product page',
  ].join('\n');
  const p = parseTicket(t);
  assert.equal(p.title, 'Low stock alert');
  assert.deepEqual(texts(t), [
    'The alert is sent when stock falls below 5.',
    'It is sent once per day.',
    'The alert email must: name the product',
    'The alert email must: link to the product page',
  ]);
  assert.doesNotMatch(p.description, /someone|Priority/);
});

test('format 14: bug ticket with Steps to reproduce and Expected result, no AC section', () => {
  const t = 'Cart total wrong after removing an item\n\nSteps to reproduce:\n1. add two items\n2. remove one\n\nExpected result:\n- the cart total equals the remaining item price\n\nActual result:\n- the total is unchanged\n';
  const p = parseTicket(t);
  assert.deepEqual(texts(t), ['the cart total equals the remaining item price']);
  assert.equal(p.criteria[0].source, 'expected');
  assert.match(p.description, /Steps to reproduce:/);
  assert.match(p.description, /add two items/);
});

test('format 15: Markdown table of criteria', () => {
  const t = '# Shipping fees\n## Acceptance Criteria\n| # | Criterion |\n|---|---|\n| 1 | orders under 50 EUR pay 4.90 shipping |\n| 2 | orders of 50 EUR or more ship free |\n';
  const p = parseTicket(t);
  assert.deepEqual(
    p.criteria.map((c) => [c.label, c.text]),
    [
      ['1', 'orders under 50 EUR pay 4.90 shipping'],
      ['2', 'orders of 50 EUR or more ship free'],
    ],
  );
});

test('a ticket with only a list and no AC heading reads the list as low-confidence criteria', () => {
  const p = parseTicket('Clean up order statuses\n\n- remove the legacy PENDING_OLD status\n- map it to PENDING in the API\n');
  assert.equal(p.inferred, true);
  assert.equal(p.criteria.length, 2);
  assert.ok(p.criteria.every((c) => c.confidence < LOW_CONFIDENCE));
});

test('hidden Unicode is removed and counted; the hash is of the text as given', () => {
  const raw = 'Title: A​ B\nAC:\n- GET /a returns 200‮\n';
  const p = parseTicket(raw);
  assert.equal(p.hiddenRemoved, 2);
  assert.equal(p.title, 'A B');
  assert.equal(p.hash, sha256(raw));
});

test('empty and whitespace-only tickets give no criteria and a placeholder title', () => {
  const p = parseTicket('   \n\n');
  assert.equal(p.criteria.length, 0);
  assert.equal(p.title, 'Untitled ticket');
});

test('splitSentences keeps abbreviations, decimals and paths together', () => {
  assert.deepEqual(splitSentences('Totals use 12.50 EUR, e.g. for /orders/1. Then stop. Done!'), ['Totals use 12.50 EUR, e.g. for /orders/1.', 'Then stop.', 'Done!']);
});

test('detectFormat', () => {
  assert.equal(detectFormat('h2. Hi'), 'jira');
  assert.equal(detectFormat('# one\n# two'), 'jira');
  assert.equal(detectFormat('## Hi\ntext'), 'markdown');
  assert.equal(detectFormat('just text'), 'plain');
});

test('format 16: a pasted Jira page whose first line is only the key joins the key and the next line as the title', () => {
  const t = 'SHOP-142\nAdd order total\nDescription\nCustomers want totals.\nAcceptance Criteria\n- GET /orders/:id returns total\n';
  const p = parseTicket(t);
  assert.equal(p.title, 'SHOP-142 Add order total');
  assert.equal(p.description, 'Customers want totals.');
  assert.deepEqual(texts(t), ['GET /orders/:id returns total']);
});
