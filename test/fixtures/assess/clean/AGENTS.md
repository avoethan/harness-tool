# Agent notes

Run `npm run check` before you finish; it runs lint, the type check and the tests.
Run one test file with `npx vitest run test/cart.test.js`.
The integration tests need Docker running and take about two minutes.

## Boundaries

- Never commit secrets or `.env` files.
- Never push directly to main; open a pull request.
- Ask before adding a new dependency.

## Where things are

Pricing rules live in `src/pricing.js`; the cart totals depend on them, so
change both together and add a case to `test/cart.test.js`.
