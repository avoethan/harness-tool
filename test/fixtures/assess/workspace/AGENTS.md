# Workspace notes for coding agents

Two services live in this folder: billing-api and inventory-api. Both are
small Express apps that share one local test database.

## Working rules

- Run `npm run verify` in the service you touched; it runs lint and the tests.
- Do not run the full test suite locally; CI runs it on every push.
- Keep commit subjects in the Conventional Commits form the history uses.
- Never run migrations against production; only the local test database is allowed.
- Invoice handlers live in
  `billing-api/src/handlers/invoices.js`.
- Cascade reads this file before every task, so keep it current.

## Layout (reference)

```
billing-api/
  src/app.js
  src/routes/invoices.js
  test/app.test.js
inventory-api/
  src/index.js
  src/stock.js
  test/stock.test.js
```

Scripts in every service: build, lint, test, typecheck.
