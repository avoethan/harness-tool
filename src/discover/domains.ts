/**
 * Domain gates: a probe about a domain (SQL) counts only in a repository that
 * has the domain. Without the gate, a SQL-text probe fires on any call whose
 * argument looks like a sentence ("select ... from") in a repository with no
 * SQL at all, and the record is a standard about something the project does
 * not do.
 *
 * SQL is present when any package depends on a SQL client or ORM, a `.sql`
 * file exists, or a non-test code file imports a SQL client or holds a SQL
 * statement literal.
 */
import type { WorkspaceInventory } from './inventory';
import { readCached } from './builtins';

export const SQL_CLIENTS = ['mssql', 'tedious', 'pg', 'postgres', 'mysql', 'mysql2', 'mariadb', 'better-sqlite3', 'sqlite3', 'sqlite', 'knex', 'typeorm', 'prisma', '@prisma/client', 'sequelize', 'kysely', 'drizzle-orm', 'slonik', 'oracledb', 'sql.js', '@mikro-orm/core', 'objection', 'bookshelf', 'pg-promise', '@vercel/postgres', '@libsql/client', '@electric-sql/pglite', 'node:sqlite'];

const escapeRe = (s: string): string => s.replace(/[.\\/@+*?()[\]{}|^$-]/g, '\\$&');
const SQL_CLIENT_IMPORT = new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*|import\\s+)['"](?:${SQL_CLIENTS.map(escapeRe).join('|')})(?:/[^'"]*)?['"]`);
const COLUMNS = String.raw`(?:distinct\s+|top\s+\d+\s+)?(?:\*|[\w.[\]"@()*]+(?:\s*,\s*[\w.[\]"@()*]+)*(?:\s+as\s+\w+)?)`;
/** A statement shape, not a sentence: `select <columns> from <table>`, `insert into`, `delete from`, `update <t> set <c> =`. */
const SQL_STATEMENT = new RegExp(String.raw`\b(?:select\s+${COLUMNS}\s+from\s+[\w."[\]]+|insert\s+into\s+[\w."[\]]+|delete\s+from\s+[\w."[\]]+|update\s+[\w."[\]]+\s+set\s+[\w."[\]]+\s*=)`, 'i');

export interface DomainGate {
  domain: 'sql';
  present: boolean;
  /** Why the domain counts as present, or what was checked when it is absent. */
  evidence: string;
}

/** Decide whether the workspace has SQL. Stops at the first piece of evidence. */
export function sqlGate(ws: WorkspaceInventory): DomainGate {
  for (const inv of ws.repos) {
    for (const p of inv.repo.packages) {
      const hit = [...p.deps, ...p.devDeps].find((d) => SQL_CLIENTS.includes(d));
      if (hit) return { domain: 'sql', present: true, evidence: `dependency ${hit}` };
    }
    const sqlFile = inv.files.find((f) => f.kind === 'sql');
    if (sqlFile) return { domain: 'sql', present: true, evidence: `SQL file ${sqlFile.rel}` };
  }
  for (const inv of ws.repos) {
    for (const f of inv.files) {
      if (f.kind !== 'code' || f.isTest || /\.d\.ts$/.test(f.rel)) continue;
      const text = readCached(f.abs);
      if (SQL_CLIENT_IMPORT.test(text)) return { domain: 'sql', present: true, evidence: `SQL client import in ${f.rel}` };
      if (SQL_STATEMENT.test(text)) return { domain: 'sql', present: true, evidence: `SQL statement in ${f.rel}` };
    }
  }
  return { domain: 'sql', present: false, evidence: 'no SQL file, SQL client dependency or import, or SQL statement literal in a non-test file' };
}
