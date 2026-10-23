# End-to-end verification (`src/verify/`, `harness verify`)

Passing unit tests are not enough evidence that a change works: 7.8% of
"passing" SWE-bench patches fail the developer's own suite and 29.6% behave
differently from the human fix (R-07, indirect evidence; no study measures
this routine on agent work, so the harness counts artefacts and catches
itself). `harness verify` exercises the real user path against the
running services and a per-run test database and records what happened as
artefacts the gate checks. The shape follows a published verification skill
(Launch / Doctor / Drive / Evidence / Cleanup, a feature map, a maintenance
pass that never edits product code).

## Commands

```
harness verify launch [--services a,b] [--task <id>] [--repo <path>] [--no-db] [--no-migrate] [--db-unreachable] [--json]
harness verify doctor [--json]
harness verify drive "<METHOD> /path" | --method <M> --path </p>
                     [--param k=v]... [--query k=v]... [--header k=v]... [--body @file|<json>] [--as <user>]
                     [--expect-status n] [--expect-json path=value]... [--expect-body <path=value|text>]...
                     [--expect-header "Name=value"|"Name~text"|"Name=*"]...
                     [--repeat n] [--expect-p50-ms n | --expect-p95-ms n | --expect-p99-ms n]
                     [--criterion <id>] [--service <name>] [--no-recipe] [--json]
harness verify db [<recipe>] [--table <t>] [--where col=value]... [--expect-columns a,b]
                  [--expect-rows n|<json>] [--expect col=value]... [--query "<select>"] [--param name=value]...
                  [--criterion <id>] [--json]
harness verify evidence [--json]
harness verify cleanup [--keep-db]
harness verify env [--powershell | --cmd | --posix | --json]
harness verify map build | drift | show [--json]
harness verify maintain [--add-missing | --add <id>,<id>] [--accept <id>,<id> | --accept-all] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | done; every assertion passed |
| 1 | an assertion failed, a service is not ready, or a step failed (the output says which) |
| 2 | usage (unknown route form, missing `--param`, bad flag value) |
| 4 | refused by the database rail (empty or unsigned allowlist, a target not marked test, a target marked read-only for launch, a query outside the run database, a statement that could write to a read-only database) |

The spellings `--method --path --expect-status --expect-body --expect-header
--repeat --expect-p95-ms`, `launch --db-unreachable` and `--table --expect-columns --expect-rows` are the ones
intake writes into a brief's `run:` lines (src/intake/classify.ts).

Every command works on the task the gate would pick: `--task`, else
`~/.harness/runs/<repoId>/current-task`, else `adhoc`.

## Launch

1. **Inventory.** The feature map is re-derived from code (below) and saved.
2. **Services.** `--services`, else the repositories of the brief's units,
   else the current repository; plus every service they `need`, started
   dependencies first. The entry service is the first one named.
3. **Database rail first.** Nothing starts while the allowlist would refuse
   (exit 4 with the marking instruction).
4. **Ports.** A contiguous free range (probed with `net.createServer` on the
   loopback and wildcard addresses) starting at `verify.portBase` (default
   20000), on a stride of 10, reserved in `state/verify-ports.json` so two
   runs never pick the same range; released at cleanup.
5. **Per-run database `test_<runId>`** on the test server, one of:
   - `verify.db.snapshot`: a server-side `.bak` path (RESTORE with MOVE to the
     server's default folders), `db:<source>` (BACKUP ... COPY_ONLY of a
     marked test database, then RESTORE; the copy is removed from the
     container at cleanup), or `clone:<source>` (DBCC CLONEDATABASE, schema
     only);
   - else CREATE DATABASE, then every `.sql` migration of the services that
     share the schema (the started ones plus every service whose
     `.env.example` names the same database), in file-version order
     (`0001_`, `V1_1__`, timestamps; `R__` last; down/undo files out), the
     services ordered so a migration that references another service's
     table runs after it; then the seed: `verify.db.seed`, else `db/seed.sql`,
     `seed.sql`, `scripts/seed.sql` in each repository, else "no seed" is
     said. Migrations added or changed since the base commit are recorded as
     shared-schema changes in every artefact of the run;
   - after a snapshot restore (any of the three snapshot forms), the
     migrations the snapshot does not hold are applied to `test_<runId>`.
     The decision is made object by object, from the restored database
     itself (one read of `INFORMATION_SCHEMA.TABLES`, `INFORMATION_SCHEMA.COLUMNS`
     and `sys.indexes`, and of its migration-history table when it has one):
     each `.sql` migration of the schema services is parsed for what it
     creates (`CREATE TABLE`, `ALTER TABLE ... ADD <column>` / `ADD COLUMN`,
     `CREATE [UNIQUE] INDEX ... ON`). A migration with any of those objects
     missing is applied, whether or not it changed (so an unchanged
     `ALTER TABLE orders ADD status` that the snapshot predates is applied).
     A migration whose objects are all present is reported as "already in the
     snapshot" and not run, even when the file changed since the base commit
     (a changed `CREATE TABLE` the snapshot holds would only fail). A
     migration that creates nothing the harness can detect (data changes,
     drops, alters) is applied only when it changed since the base commit,
     and the launch note says so. A migration whose id or file name is
     recorded in a migration-history table (`__migrations`, `migrations`,
     `schema_migrations`, `_migrations`, `migration_history`,
     `flyway_schema_history`, `__EFMigrationsHistory`, `knex_migrations`) is
     never applied. Applied ones run in the order above, are listed in the
     launch output as "Migrations applied after the snapshot", and are
     recorded in the run record (`db.migrations`, with `afterSnapshot`, and
     `changed` for a change of this work); the ones left out are listed as
     notes ("not applied, ..."). Nothing runs outside `test_<runId>`. A code
     migration (`.js`/`.ts`) is only noted. `--no-migrate`, or
     `verify.db.migrateAfterSnapshot: false`, skips the step (the launch says
     so, and a column added by the work will be missing);
   - or `verify.db.mode: existing` with `verify.db.database` (never dropped).
   With `--db-unreachable` the per-run database is still created and cleaned
   up as usual (unless `--no-db`), but the entry and touched services (the
   ones named with `--services`, or the default) are told that their
   database is at `127.0.0.1,<port>`, one extra loopback port reserved with
   the others and probed free, so nothing listens on it. A service started
   only because another one needs it (role `dependency`) keeps the real run
   database. The launch output and the run record (`unreachableServices`) say
   which services got the dead port. `DB_SERVER` and `DB_PORT` in run.env
   say the same as the entry service. A service that answers with any HTTP
   status (a 503 from its health route, say) counts as ready. The run
   record and every artefact of the run carry `dbUnreachable: true`. Use it
   for a criterion that says the service must keep answering while its
   database is down:
   `harness verify drive --method GET --path <route> --expect-status 503`.
6. **run.env** (`KEY=value`, no secrets by construction): `RUN_ID`,
   `BASE_URL` (entry service), `BASE_URL_<SERVICE>`, `PORT_<SERVICE>`,
   `DB_SERVER`, `DB_PORT`, `DB_NAME`, `DB_USER`, and the upstream URL
   variables the services' `.env.example` declare (`CATALOG_URL=...`).
7. **Start.** Each service runs its own `dev` script (the working tree's
   source), else `start` (`overlay.services.<name>.start` picks another),
   resolved like the gate resolves scripts (tokenised, binary found inside
   the repository, run with the current Node; a shell body goes through the
   package manager), as an argv array, detached, output to
   `logs/<service>.log` in the run folder. The process gets the variables its
   `.env.example` declares mapped to the run (port, DB server/port/name/user,
   upstream URLs; other example values only when they are not secret and not
   a remote URL) and the password from the named variable (process
   environment only, never a file). Readiness: a health route (`/health`,
   `/healthz`, `/ready`, ...) answering 2xx, else the port accepting
   connections, up to `verify.readyTimeoutMs` (90 s).

## Doctor

Checks, in order: the allowlist is non-empty and signed (else exit 4 with the
marking instruction, before anything else); the run's server and database
are marked test and the guard accepts the exact sqlcmd line; migrations are
applied (every table they create exists, no file changed since launch, none
added; the migrations applied after a snapshot are counted); each port is held by this run's process; run.env matches the run and
each service got the run database and its port; each service answers; and
**which database each service is connected to**: a health or ready route that
names it (`{"database": "test_x"}`), else the variable read from the running
process's environment (`/proc/<pid>/environ` on Linux) or the launch record,
reported as **indirect**. For a run launched with `--db-unreachable` doctor
prints "database deliberately unreachable (--db-unreachable)" as a warning
instead of failing, accepts any HTTP answer from a service, and skips the
connected-database check.

## Drive

HTTP through Node's fetch. The route is `"METHOD /path"` (or `--method`
and `--path`); `:param` segments are filled from `--param`, else the
recipe's `params`. Templates in recipes: `{{runId}}`, `{{last.<json path>}}`
(the previous response of this run), `{{env.NAME}}`, `{{base.<service>}}`.
The auth slot (`--as <user>` or the recipe's `auth`) signs in with the
overlay's login recipe for that user; the token or cookie lives in memory
only (the printed curl line uses `$HARNESS_TOKEN`). Assertions: status (all
responses with `--repeat`), response headers (`--expect-header`: `"Name=value"`
exact, `"Name~text"` contains, `"Name=*"` present; the name is
case-insensitive; recorded as an assertion of kind `header`; a secret-named
header such as Authorization, Cookie, Set-Cookie or X-Api-Key can be asserted
present, and its value is never written to the artefact; for any other header
the actual value is recorded only for `content-type`, `content-disposition`,
`content-length`, `content-encoding`, `cache-control`, `etag`, `vary`,
`allow`, `accept-ranges`, `x-request-id`, `x-ratelimit-*`, `retry-after`
and `content-language`, and every other name records `matched` / `not matched`
or `present` / `absent`; a malformed expectation is echoed for its first 20
characters only), JSON paths (`=`, `!=`, `>=`, `<=`, `>`, `<`, `~`
contains, `=*` present), body text, latency percentiles (nearest rank), and the
recipe's database side effects. With no expectation at all the check is
"status below 400". Exit 1 when any assertion fails.

## Db

Only the run database, only through sqlcmd with `-Q`, parameterised with
`sp_executesql` (values never spliced into SQL), identifiers checked and
bracket-quoted. `--table` checks columns, row counts, expected rows (each
must exist) and column values of the rows `--where` selects. `--query` is the
agent's own read: one SELECT (or WITH ... SELECT), no `INTO`, no other
database, no sqlcmd directives, no OPENROWSET and friends (else exit 4);
the last check is the guard's read-only classifier (`src/guard/sqlreadonly.ts`),
the same one the database rail applies to targets marked `read-only`, so a
three-part column name (`dbo.t.col`) is refused too (write `t.col`).
A recipe (`overlay.dbRecipes`) may change data (seed a test user, keyed by
`{{runId}}`) but may not leave the run database. The artefact stores only
the columns an assertion names (50 rows at most).

If the user marks the run database `read-only` after launch (`harness db
mark ... --read-only`), `verify db` still runs, but only reads: `--table` and
`--query` as above, and a recipe only when the classifier proves its SQL
reads; a recipe that changes data is refused with exit 4 and the reason
"<db> is marked read-only: this statement could write (<word>); stop and ask
the user to run it or approve it".

## Artefacts (the gate reads them)

`~/.harness/runs/<repoId>/<taskId>/e2e/<id>.json`:

```json
{ "version": 1, "id": "AC1-http", "kind": "http", "criterion": "AC1",
  "treeHash": "<git write-tree of the working tree>", "trees": { "<repoId>": "<tree>" },
  "createdAt": "...", "pass": true, "runId": "...", "repoId": "...", "taskId": "...",
  "assertions": [{ "kind": "status", "expect": "201", "actual": "201", "pass": true },
                 { "kind": "header", "expect": "content-type contains text/csv", "actual": "text/csv; charset=utf-8", "pass": true },
                 { "kind": "header", "expect": "x-internal-user contains alice", "actual": "matched", "pass": true }],
  "dbUnreachable": true,
  "schemaChanges": [{ "service": "orders-api", "id": "0004_add-x", "file": "...", "sha256": "..." }],
  "command": "curl -sS -X POST http://127.0.0.1:20001/orders ...",
  "route": "POST /orders", "method": "POST", "url": "...", "status": 201, "latencyMs": 42,
  "headers": {}, "droppedHeaders": ["set-cookie"], "requestHeaders": {}, "requestBody": {},
  "body": {}, "bodyBytes": 255, "bodyTruncated": false, "repeat": { "n": 20, "p95": 31 } }
```

A db artefact has `server` (host only), `database`, `table` / `recipe` /
`query`, `params` (redacted), `columns`, `rows`, `rowCount`.

- **Id**: `<criterionId>-http` / `<criterionId>-db` with `--criterion`, or
  when exactly one criterion of the task's brief has a `run:` line for the
  same method and route pattern (or table); else the route or table slug.
  The gate's step `e2e:<id>` counts an artefact whose `treeHash` equals the
  tree it checks and whose `pass` is not false.
- **Tree hash**: `git write-tree` through a temporary index (the hash the
  gate and the Stop hook compute). In cross-repo mode the artefact is written
  into the run folder of the driven service's repository and of the run's
  owner, each with that repository's tree; `trees` holds all of them.
- **Redaction by construction**: `Authorization`, `Cookie`, `Set-Cookie`,
  `X-Api-Key` (and other secret-named headers) are dropped and listed by
  name; secret-named body fields become `[DROPPED]`; secret-shaped values are
  masked; bodies are capped at 16 KB; a final secret scan runs over the
  serialised artefact before it is written.

`harness verify evidence` lists each artefact as fresh (its tree is the
current tree) or stale, with its verdict.

## Feature map

**Inventory** (generated, `~/.harness/runs/<repoId>/feature-map.json`,
re-derived on every launch and by `verify map build`): services (packages
with a start/dev script in the workspace), routes (Express, Koa-router,
Fastify, NestJS registrations found with regular expressions: method, full
path with the router's mount prefix resolved across files through imports,
handler file:line, status codes seen in the handler), migrations (ordered,
with the tables they create or alter and the tables they reference), tables,
and `needs` per service (an env variable such as `CATALOG_URL` that names
another service, else whose example URL uses another service's example
port). Only `.env.example` and its siblings are read, never `.env`.

**Overlay** (hand-written, `~/.harness/featuremap/<repoId>/overlay.json`,
the file the gate's map-drift step reads): entries keyed by route id
(`POST /orders`) and migration id (`0003_add-orders-updated-at`), each with
`file` (repository-relative), and for routes a `recipe` (body, params, query,
headers, auth, expectStatus, expect, db side effects) and `gotchas`; plus
`users` (login recipes), `services` (start script, health route, timeout,
extra env) and `dbRecipes`.

- `verify map drift` lists the route and migration ids of this repository
  with no overlay entry (exit 1 when there are any).
- `verify maintain` re-derives the inventory and reports each entry as
  **clean**, **changed** (handler moved, status codes changed, the recipe
  expects a status the handler no longer shows, a migration file changed),
  **blocked** (the route or migration is gone, the recipe signs in as a user
  with no login recipe, the service left the workspace) or **missing** (no
  entry). `--add-missing` writes skeleton entries (no recipe; a person writes
  it), `--accept` records the current facts after a person reviewed a
  changed entry. It writes only the overlay, never product code.

## The database rail on the harness's own access

The agent's own database commands go through the guard (src/guard/db.ts).
`harness verify` holds itself to the same rail:

- an empty or unsigned allowlist refuses every database step (exit 4, with
  the `harness db mark` instruction);
- before every sqlcmd call, the exact command line (the docker or local
  form, with a harmless query in place of the real one) is parsed by the
  guard and must resolve to targets marked `test`; in docker mode that is
  the container name (`localhost` inside it means the container);
- the server the services connect to must be marked test directly, or be
  the published port of the marked container on a local address;
- per-run databases need a server-wide test entry (an entry scoped to one
  database does not cover `test_<runId>`); a snapshot source must be marked
  test too; cleanup drops only `test_<runId>` of the run;
- a target marked `read-only` is never created on, restored into, copied
  from or seeded: `launch` refuses (exit 4, naming the mark) a snapshot
  source or an `existing`-mode database marked read-only, and a per-run
  database on a server marked read-only as a whole (its `master` is
  read-only too). A test server that also holds a read-only database stays
  usable for per-run databases;
- the password is read from the variable `verify.db.passwordEnv` names
  (else `HARNESS_VERIFY_DB_PASSWORD`, `SQLCMDPASSWORD`, `DB_PASSWORD`,
  `MSSQL_SA_PASSWORD`) and passed to sqlcmd as `SQLCMDPASSWORD` in its
  environment, never on a command line or in a file; sqlcmd runs with `-x`
  so scripts cannot read it through variable substitution;
- migration and seed scripts are refused when they carry sqlcmd directives
  (`:r`, `:connect`, `!!`), reach outside the run database (`USE other`,
  three-part names) or use server-level features (xp_cmdshell, OPENROWSET,
  linked servers, BACKUP/RESTORE, CREATE/DROP DATABASE).

## Configuration (`verify` in the machine config; nothing here widens the rail)

| Key | Default |
|---|---|
| `db.server` | the marked container's published 1433 port (`localhost,<port>`), else the only server-wide test entry |
| `db.user` | none (integrated auth, `-E`) |
| `db.passwordEnv` | first set of `HARNESS_VERIFY_DB_PASSWORD`, `SQLCMDPASSWORD`, `DB_PASSWORD`, `MSSQL_SA_PASSWORD` |
| `db.sqlcmd` | `auto`: sqlcmd on PATH, else a running SQL Server container |
| `db.sqlcmdPath`, `db.container`, `db.containerSqlcmd` | PATH; the only SQL Server container (or the one publishing the server's port); `/opt/mssql-tools18/bin/sqlcmd` |
| `db.mode`, `db.database` | `per-run` |
| `db.snapshot` | none (`<.bak path>`, `db:<source>`, `clone:<source>`) |
| `db.seed`, `db.migrations` | conventions above |
| `db.migrateAfterSnapshot` | `true`: apply the migrations a restored snapshot lacks (`false`, or `--no-migrate`, skips) |
| `portBase`, `readyTimeoutMs` | 20000, 90000 |

## Files

```
~/.harness/runs/<repoId>/<taskId>/verify.json     the run record (services, pids, ports, database, notes; no secrets)
~/.harness/runs/<repoId>/<taskId>/run.env         the run's variables (no secrets)
~/.harness/runs/<repoId>/<taskId>/logs/<svc>.log  service output
~/.harness/runs/<repoId>/<taskId>/e2e/<id>.json   artefacts
~/.harness/runs/<otherRepoId>/<taskId>/verify-run.json  pointer to the owning run (cross-repo)
~/.harness/runs/<repoId>/feature-map.json         the generated inventory
~/.harness/featuremap/<repoId>/overlay.json       the hand-written overlay (read by the gate)
~/.harness/state/verify-ports.json                port reservations of live runs
```

Nothing is written inside a repository. The instrumentation log gets
`verify.launch|doctor|drive|db|cleanup|maintain` events with ids and counts
only.

## A recorded run (team stand-in, 2026-10-19)

`test/acceptance/verify-e2e.test.ts` against the stand-in workspace and a
SQL Server 2022 container: launch of catalog-api and orders-api with a
per-run database built from 7 migrations and the stand-in seed took 3943 ms
inside the command (4035 ms wall); doctor passed 11 checks and reported both
services on the run database (indirect: their health route says only "up",
so the name came from the process environment); the cross-service
`POST /orders` recipe (orders-api calls catalog-api) passed with the order
row and the stock change asserted in the shared schema; a GET and a
`verify db` row assertion passed; a query on `master` was refused (exit 4);
a deliberately wrong `--expect-status` exited 1; 4 artefacts, all fresh, and
the gate's own reader passed `e2e:AC1`, `e2e:AC2`, `e2e:AC3`; the map found
the 15 routes the stand-in lists; cleanup dropped the database (sqlcmd count
0) and freed both ports.

## Limits

- Routes are found with regular expressions, not a parser: dynamic paths
  (`router.get(PATHS.x, ...)`), routers mounted through variables built at
  run time, and frameworks other than Express, Koa-router, Fastify and NestJS
  are not found. A router file imported under two prefixes yields both ids.
- Status codes are what the handler's text shows (`.status(201)`,
  `notFound(...)`), not what it returns at run time.
- SQL Server only (sqlcmd). Code migrations (`.js`/`.ts`) are listed but not
  applied, with or without a snapshot: run the repository's own migration
  command against `DB_NAME` from `harness verify env`.
- Readiness and the connected-database check need the service to answer
  HTTP; a worker without a port is started but only checked by its port.
- The browser kind (`e2e/<id>-browser.json`) is read by the gate but not
  produced here yet.
- On Codex, a started service is reachable only with
  `[sandbox_workspace_write] network_access = true` (the default sandbox cuts
  loopback); the installer tells the user to set it and does not set it
  itself.
