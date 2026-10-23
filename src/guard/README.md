# Guard library

Pure functions that decide whether a tool call may run. See `index.ts`
(`evaluate`), `parse.ts` (command parser), `rails.ts` (rail data),
`db.ts` (database rail) and `permissions.ts` (per-agent permission rules
rendered from the same rail data).

## Database rail (`db.ts`)

Every database command the agent runs resolves to targets (server flags,
connection strings, URLs, environment variables, the container or host of a
wrapper). Each target takes the mark of its allowlist entry (`harness db
mark`); a database entry beats a server-wide one, the strictest mark wins
among entries of the same scope, and a target without a database also takes
the database-scoped read-only or not-test marks of its server (the login's
default database may be one of them).

| Targets of the command | Decision |
|---|---|
| none marked, list empty, or list unsigned (`markedHash` does not match) | deny |
| a script file (`-i`, `<`, `:r`), an interactive session, an unresolved target (DSN, alias, variable), a flag swallowed as another flag's value, `xargs` arguments, two different database names (`-d a -d b`, `Initial Catalog=a;Database=b`), a database name with spaces, quotes, brackets or dots | deny (whatever the marks) |
| any target `not-test` or unmarked | deny the whole command |
| every target `test` | allow; on a server that also holds read-only or not-test databases, or for a database-scoped test entry, only SQL that stays inside the target database (below) |
| every target `test` or `read-only`, at least one `read-only` | allow only inline SQL that the read-only classifier proves reads; else deny: "<db> is marked read-only: this statement could write (<word>); stop and ask the user to run it or approve it" |

The shared-server rule (`sharedServerWord`): a test target whose server
also holds read-only or not-test databases, or that a database-scoped test
entry matches, gets SQL that must stay inside the target database. Denied:
no SQL text to read (bcp), SQL from a variable, inline driver code or a
dacpac (`node -e` with `mssql`, `sqlpackage`), a three- or four-part name of
another database, the protected database's name as a name or a whole word in
a literal, `EXEC(...)`/`EXEC @var`, `sp_`/`xp_` procedures other than a short
list of reading ones (`sp_help`, `sp_columns`, ...), `DBCC`, `ASSEMBLY`,
`EXTERNAL`, `SEND`, `DIALOG`, `SHUTDOWN`, non-ASCII text and `$(`. A
command that only sets a connection variable for the app or a migration
tool is judged by its target alone (the guard cannot read repository code).

### Read-only databases

`sqlreadonly.ts` holds the one read-only classifier; the database rail and
`harness verify db --query` both call it. The SQL must be inline: `-Q` of
`sqlcmd`, `osql`, `isql`, `mssql-cli`, or `-Query` of `Invoke-Sqlcmd` and
`Invoke-DbaQuery` (also a PowerShell here-string, or a bash `<<<`
here-string). Denied on a read-only target: script files, heredocs, piped
input, any other client (bcp, sqlpackage, psql, mysql, driver one-liners,
app commands with a connection variable), SQL from a variable or command
substitution, an unquoted glob or brace the shell may expand, an extra
argument, an unknown flag, `-c` (another batch terminator), `-z`/`-Z` (a
new password), `-CommandType`, `SQLCMDINI`, and on Windows an argument with
an embedded double quote or a trailing backslash (PowerShell and cmd may
split it).

The classifier itself: printable ASCII only, no `$(` (a sqlcmd variable), no
line that starts with a sqlcmd directive (`:connect`, `:r`, `:setvar`,
`:out`, ...) and no `!!`, no `GO` starting a line inside a string or comment;
comments removed (a nested one is denied) and strings, `[bracket]` and
`"quoted"` names masked; statements split on `;` and `GO` (`GO <n>` is
denied), each one starting with `SELECT` or `WITH`; no write, control-flow
or other-code word anywhere (`INSERT`, `UPDATE`, `DELETE`, `MERGE`,
`TRUNCATE`, `CREATE`, `ALTER`, `DROP`, `GRANT`, `REVOKE`, `DENY`, `EXEC`,
`EXECUTE`, `INTO`, `BACKUP`, `RESTORE`, `DBCC`, `USE`, `KILL`, `SHUTDOWN`,
`RECONFIGURE`, `BULK`, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`,
`OPENXML`, `WAITFOR`, `SET`, `DECLARE`, and the statements T-SQL lets follow
a `SELECT` without a `;`: `BEGIN`, `COMMIT`, `PRINT`, `RAISERROR`,
`RECEIVE`, `SEND`, `IF`, `WHILE`, ... see `READ_ONLY_FORBIDDEN`), no
`sp_`/`xp_` name, no `NEXT VALUE FOR`, no ODBC escape `{call ...}`, no
label, no four-part name, and a three-part name only of the marked
database. The deny reason names the offending word, never the statement.

What it cannot see: a function already on the server that does more than
read when a `SELECT` calls it (a scalar function calling an extended
procedure, a CLR function with external access); state set outside the
command line in a shell that persists between commands (a `SQLCMDINI` or
`SQLCMDSERVER` exported by a sourced file, a PowerShell
`$PSDefaultParameterValues` entry, an alias or a `sqlcmd` earlier on
`PATH`); and code the agent wrote and runs itself. Mark a database that
must never be touched not-test.

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

