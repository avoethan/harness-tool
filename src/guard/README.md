# Guard library

Pure functions that decide whether a tool call may run. See `index.ts`
(`evaluate`), `parse.ts` (command parser), `rails.ts` (rail data),
`db.ts` (database rail) and `permissions.ts` (per-agent permission rules
rendered from the same rail data).

## Secret files

The secrets rail denies reading or writing key material and env secrets
(`isSecretPath` in `index.ts`: `.env` and every `.env.*` except the template
names in `SECRET_EXAMPLE_RE` (`.env.example`, `.env.sample`, `.env.template`,
`.env.dist`, `.env.schema`, `.env.defaults`, `.env.test.example`), plus the
key and credential files of `SECRET_EXTRA_RE`). The templates hold no secrets
and are what the denial message tells the agent to read instead.

The rendered permission rules (`SECRET_GLOBS` in `rails.ts`, used by
`permissions.ts` for Claude and Devin; Codex gets the `cat .env` prefix rule)
list the concrete secret spellings of `ENV_SECRET_NAMES` (`.env`,
`.env.local`, `.env.*.local`, `.env.development`, `.env.production`,
`.env.staging`, `.env.test`, `.env.dev`, `.env.prod`, `.env.ci`, `.env.qa`,
`.env.uat`, `.env.stage`, `.env.sandbox`, `.env.preview`, `.env.e2e`,
`.env.integration`, `.env.docker`, `.env.prd`, `.env.preprod`, `.env.secrets`,
`.env.secret`, `.env.backup`, `.env.bak`, `.env.old`, `.env.encrypted`,
`.env.vault`, `.env.*.bak`, `.env.*.backup`), never the
`.env.*` glob, which would also deny the templates. A spelling that is not in
the list (`.env.foo`) is not in the first-layer rules but is still stopped
by the hook.

