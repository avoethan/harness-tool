# Agent guide

This repo is a small HTTP API for user accounts, written in plain Node.

## Commands

- `npm run check` runs lint, format check and the tests; run it before you finish.
- Run one test file with `node --test test/users.test.js`.
- Start the dev server with `npm run dev`; it reloads on save.

## Rules

- Always use semicolons at the end of statements.
- Use single quotes for strings.
- Never use `console.log` in committed code; use the logger in `src/log.js`.
- Database access goes through `src/db/query.js`; never build SQL with string concatenation.
- Keep route handlers thin: validation, one service call, the response.
- Commit messages follow Conventional Commits.
- Never force-push shared branches.
- Don't ask for confirmation before running the tests.

## Project structure

```
src/
  server.js
  routes/users.js
  db/query.js
test/
  users.test.js
```

## Background

The API started as a prototype and grew; some older endpoints still return
plain strings instead of JSON. Leave them alone unless a ticket asks.
