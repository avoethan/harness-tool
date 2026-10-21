/**
 * Database assertions against the run database only (`verify db`, and the
 * side-effect checks of an HTTP recipe). Every query is parameterised
 * (sp_executesql), names are plain identifiers quoted with brackets, the
 * agent's own `--query` must be one read-only SELECT, and the artefact keeps
 * only the columns an assertion names.
 */
import type { Assertion } from './artifact';
import { keepColumns, safeActual } from './artifact';
import { checkRecipeSql, checkSelectOnly, nLiteral, parameterised, quoteIdent, runSql, validIdent, type SqlParam } from './sqlcmd';
import type { DbPlan } from './dbrun';

export type Op = '=' | '!=' | '>=' | '<=' | '>' | '<' | '~';

export interface Expectation {
  path: string;
  op: Op;
  /** The expected value as given (text). */
  raw: string;
  value: unknown;
}

const EXPECT_RE = /^\s*([^=!<>~\s][^=!<>~]*?)\s*(==|=|!=|>=|<=|>|<|~)\s*([\s\S]*)$/;
const PATH_RE = /^\$?\.?[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$0-9][\w$-]*|\[\d+\])*$/;

/** `order.status=pending`, `total_cents>=100`, `name~Kettle`, `id=*` (present). */
export function parseExpectation(s: string): Expectation | null {
  const m = EXPECT_RE.exec(s);
  if (!m) return null;
  const p = m[1].trim();
  if (!PATH_RE.test(p)) return null;
  const op = (m[2] === '==' ? '=' : m[2]) as Op;
  const raw = m[3].trim();
  return { path: p.replace(/^\$\.?/, ''), op, raw, value: parseLiteral(raw) };
}

export function parseLiteral(raw: string): unknown {
  if (raw === '*') return '*';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Value at a JSON path (`a.b[0].c`); undefined when absent. */
export function getPath(obj: unknown, p: string): unknown {
  if (!p) return obj;
  const parts = p
    .replace(/^\$\.?/, '')
    .split(/\.|\[(\d+)\]/)
    .filter((x) => x !== undefined && x !== '');
  let cur: unknown = obj;
  for (const k of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)];
    else if (typeof cur === 'object') {
      const o = cur as Record<string, unknown>;
      if (k in o) cur = o[k];
      else {
        const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
        cur = hit ? o[hit] : undefined;
      }
    } else return undefined;
  }
  return cur;
}

function looseEqual(actual: unknown, expected: unknown): boolean {
  if (expected === '*') return actual !== undefined && actual !== null;
  if (actual === expected) return true;
  if (actual === undefined) return false;
  if (typeof expected === 'object' || typeof actual === 'object') return JSON.stringify(actual) === JSON.stringify(expected);
  if (typeof actual === 'boolean' && (expected === 1 || expected === 0)) return actual === (expected === 1);
  if (typeof expected === 'boolean' && (actual === 1 || actual === 0)) return expected === (actual === 1);
  return String(actual) === String(expected);
}

export function compare(actual: unknown, e: Pick<Expectation, 'op' | 'value'>): boolean {
  switch (e.op) {
    case '=':
      return looseEqual(actual, e.value);
    case '!=':
      return !looseEqual(actual, e.value);
    case '~':
      return actual !== undefined && actual !== null && String(typeof actual === 'object' ? JSON.stringify(actual) : actual).includes(String(e.value));
    default: {
      const a = Number(actual);
      const b = Number(e.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return e.op === '>=' ? a >= b : e.op === '<=' ? a <= b : e.op === '>' ? a > b : a < b;
    }
  }
}

export function assertPath(obj: unknown, e: Expectation, kind = 'json'): Assertion {
  const actual = getPath(obj, e.path);
  const pass = compare(actual, e);
  return { kind, expect: `${e.path}${e.op}${e.raw}`, actual: safeActual(e.path, actual), pass };
}

// ---------------------------------------------------------------------------
// Table assertions
// ---------------------------------------------------------------------------

export interface TableCheck {
  table: string;
  where?: Record<string, unknown>;
  expectColumns?: string[];
  /** A count, or rows (objects) that must each exist. */
  expectRows?: number | Array<Record<string, unknown>>;
  expect?: Expectation[];
}

export interface DbOutcome {
  ok: boolean;
  error?: string;
  assertions: Assertion[];
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  rowsTruncated: boolean;
  query?: string;
  params?: Record<string, string>;
}

function splitTable(t: string): { schema?: string; name: string } {
  const parts = t.replace(/[[\]]/g, '').split('.');
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { name: parts[0] };
}

function sqlValue(v: unknown): SqlParam {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

function whereClause(where: Record<string, unknown> | undefined, params: SqlParam[]): string {
  const parts: string[] = [];
  for (const [c, v] of Object.entries(where ?? {})) {
    if (!validIdent(c)) throw new Error(`not a plain column name: ${JSON.stringify(c.slice(0, 40))}`);
    if (v === null) parts.push(`${quoteIdent(c)} IS NULL`);
    else {
      params.push(sqlValue(v));
      parts.push(`${quoteIdent(c)} = @p${params.length - 1}`);
    }
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function rowsOf(plan: Pick<DbPlan, 'transport' | 'database' | 'login'>, select: string, params: SqlParam[], env?: NodeJS.ProcessEnv): { ok: boolean; rows: Array<Record<string, unknown>>; error?: string } {
  // FOR JSON on the inner statement; sp_executesql runs it with typed parameters.
  const r = runSql(plan.transport, plan.database, plan.login, { query: `SET NOCOUNT ON; ${parameterised(`${select} FOR JSON PATH, INCLUDE_NULL_VALUES`, params)}`, env });
  if (!r.ok) return { ok: false, rows: [], error: r.error };
  const text = r.stdout
    .split(/\r?\n/)
    .join('')
    .trim();
  if (!text) return { ok: true, rows: [] };
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? { ok: true, rows: v as Array<Record<string, unknown>> } : { ok: false, rows: [], error: 'unexpected result shape' };
  } catch {
    return { ok: false, rows: [], error: 'could not read the result as JSON' };
  }
}

/** Assertions on one table of the run database. */
export function checkTable(plan: Pick<DbPlan, 'transport' | 'database' | 'login'>, c: TableCheck, env?: NodeJS.ProcessEnv): DbOutcome {
  const out: DbOutcome = { ok: true, assertions: [], columns: [], rows: [], rowCount: 0, rowsTruncated: false };
  let tq: string;
  try {
    tq = quoteIdent(c.table);
  } catch (e) {
    return { ...out, ok: false, error: (e as Error).message };
  }
  const { schema, name } = splitTable(c.table);
  // Columns of the table.
  const colParams: SqlParam[] = [name];
  let colSql = 'SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @p0';
  if (schema) {
    colParams.push(schema);
    colSql += ' AND TABLE_SCHEMA = @p1';
  }
  const cols = rowsOf(plan, colSql, colParams, env);
  if (!cols.ok) return { ...out, ok: false, error: cols.error };
  const present = cols.rows.map((r) => String(r.c));
  if (!present.length) {
    out.assertions.push({ kind: 'table', expect: `table ${c.table} exists`, actual: 'absent', pass: false });
    out.ok = false;
    return out;
  }
  const has = (col: string) => present.some((p) => p.toLowerCase() === col.toLowerCase());
  for (const col of c.expectColumns ?? []) out.assertions.push({ kind: 'columns', expect: `column ${col}`, actual: has(col) ? 'present' : 'absent', pass: has(col) });

  // Which columns the artefact may keep: only the asserted ones.
  const asserted = new Set<string>();
  for (const col of c.expectColumns ?? []) if (has(col)) asserted.add(col);
  for (const k of Object.keys(c.where ?? {})) asserted.add(k);
  for (const e of c.expect ?? []) asserted.add(e.path.split(/[.[]/)[0]);
  if (Array.isArray(c.expectRows)) for (const r of c.expectRows) for (const k of Object.keys(r)) asserted.add(k);
  for (const a of asserted) if (!validIdent(a)) return { ...out, ok: false, error: `not a plain column name: ${JSON.stringify(a.slice(0, 40))}` };
  const unknown = [...asserted].filter((a) => !has(a));
  for (const u of unknown) if (!(c.expectColumns ?? []).includes(u)) out.assertions.push({ kind: 'columns', expect: `column ${u}`, actual: 'absent', pass: false });
  out.columns = [...asserted].filter(has);

  const params: SqlParam[] = [];
  let where = '';
  try {
    where = whereClause(c.where, params);
  } catch (e) {
    return { ...out, ok: false, error: (e as Error).message };
  }
  const cnt = rowsOf(plan, `SELECT COUNT_BIG(*) AS n FROM ${tq}${where}`, params, env);
  if (!cnt.ok) return { ...out, ok: false, error: cnt.error };
  out.rowCount = Number(cnt.rows[0]?.n ?? 0);
  const needRows = (c.expect?.length ?? 0) > 0 || Object.keys(c.where ?? {}).length > 0;
  if (needRows && out.columns.length) {
    const sel = rowsOf(plan, `SELECT TOP (51) ${out.columns.map((x) => quoteIdent(x)).join(', ')} FROM ${tq}${where}`, params, env);
    if (!sel.ok) return { ...out, ok: false, error: sel.error };
    const kept = keepColumns(sel.rows, out.columns);
    out.rows = kept.rows;
    out.rowsTruncated = kept.truncated || out.rowCount > kept.rows.length;
    for (const e of c.expect ?? []) {
      if (!sel.rows.length) {
        out.assertions.push({ kind: 'value', expect: `${e.path}${e.op}${e.raw}`, actual: 'no rows', pass: false });
        continue;
      }
      const bad = sel.rows.find((r) => !compare(getPath(r, e.path), e));
      out.assertions.push({ kind: 'value', expect: `${e.path}${e.op}${e.raw} (every selected row)`, actual: safeActual(e.path, getPath(bad ?? sel.rows[0], e.path)), pass: !bad });
    }
  }
  if (typeof c.expectRows === 'number') out.assertions.push({ kind: 'rows', expect: `${c.expectRows} row(s)${where ? ' matching' : ''}`, actual: String(out.rowCount), pass: out.rowCount === c.expectRows });
  else if (Array.isArray(c.expectRows)) {
    for (const want of c.expectRows) {
      const p2: SqlParam[] = [];
      let w2 = '';
      try {
        w2 = whereClause({ ...(c.where ?? {}), ...want }, p2);
      } catch (e) {
        return { ...out, ok: false, error: (e as Error).message };
      }
      const r = rowsOf(plan, `SELECT COUNT_BIG(*) AS n FROM ${tq}${w2}`, p2, env);
      if (!r.ok) return { ...out, ok: false, error: r.error };
      const n = Number(r.rows[0]?.n ?? 0);
      out.assertions.push({ kind: 'rows', expect: `a row with ${Object.entries(want).map(([k, v]) => `${k}=${safeActual(k, v)}`).join(', ')}`, actual: `${n} matching`, pass: n >= 1 });
    }
  }
  if (!out.assertions.length) out.assertions.push({ kind: 'table', expect: `table ${c.table} exists`, actual: 'present', pass: true });
  out.ok = out.assertions.every((a) => a.pass);
  return out;
}

/** An agent-supplied read-only query (`--query`), with named parameters (@name). */
export function checkQuery(plan: Pick<DbPlan, 'transport' | 'database' | 'login'>, sql: string, named: Record<string, string>, o: { expectRows?: number; expect?: Expectation[]; recipe?: boolean }, env?: NodeJS.ProcessEnv): DbOutcome {
  const out: DbOutcome = { ok: true, assertions: [], columns: [], rows: [], rowCount: 0, rowsTruncated: false, query: sql };
  const bad = o.recipe ? checkRecipeSql(sql, plan.database) : checkSelectOnly(sql, plan.database);
  if (bad) return { ...out, ok: false, error: bad };
  const isRead = /^\s*(select|with)\b/i.test(sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, ''));
  const names = Object.keys(named);
  for (const n of names) if (!validIdent(n)) return { ...out, ok: false, error: `not a plain parameter name: ${JSON.stringify(n.slice(0, 40))}` };
  const values = names.map((n) => sqlValue(parseLiteral(named[n])));
  // Named parameters through sp_executesql: @name declared from the value's type.
  const decl = names.map((n, i) => `@${n} ${typeof values[i] === 'number' ? (Number.isInteger(values[i]) ? 'bigint' : 'float') : typeof values[i] === 'boolean' ? 'bit' : 'nvarchar(max)'}`).join(', ');
  const assigns = names.map((n, i) => `@${n} = ${values[i] === null ? 'NULL' : typeof values[i] === 'number' ? String(values[i]) : typeof values[i] === 'boolean' ? (values[i] ? '1' : '0') : nLiteral(String(values[i]))}`).join(', ');
  const stmt = isRead ? `${sql.trim().replace(/;\s*$/, '')} FOR JSON PATH, INCLUDE_NULL_VALUES` : `${sql.trim().replace(/;\s*$/, '')}; SELECT @@ROWCOUNT AS affected FOR JSON PATH`;
  const q = names.length ? `SET NOCOUNT ON; EXEC sp_executesql ${nLiteral(stmt)}, ${nLiteral(decl)}, ${assigns}` : `SET NOCOUNT ON; ${stmt}`;
  const r = runSql(plan.transport, plan.database, plan.login, { query: q, env });
  if (!r.ok) return { ...out, ok: false, error: r.error };
  let rows: Array<Record<string, unknown>> = [];
  const text = r.stdout.split(/\r?\n/).join('').trim();
  if (text) {
    try {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) rows = v as Array<Record<string, unknown>>;
    } catch {
      return { ...out, ok: false, error: 'could not read the result as JSON' };
    }
  }
  out.params = Object.fromEntries(names.map((n) => [n, safeActual(n, named[n]) ?? '[DROPPED]']));
  if (!isRead) {
    const affected = Number(rows[0]?.affected ?? 0);
    out.rowCount = affected;
    if (o.expectRows !== undefined) out.assertions.push({ kind: 'rows', expect: `${o.expectRows} row(s) affected`, actual: String(affected), pass: affected === o.expectRows });
    else out.assertions.push({ kind: 'statement', expect: 'runs without error', actual: `${affected} row(s) affected`, pass: true });
    out.ok = out.assertions.every((a) => a.pass);
    return out;
  }
  out.rowCount = rows.length;
  const asserted = [...new Set((o.expect ?? []).map((e) => e.path.split(/[.[]/)[0]))];
  out.columns = asserted;
  const kept = keepColumns(rows, asserted);
  out.rows = asserted.length ? kept.rows : [];
  out.rowsTruncated = kept.truncated;
  if (o.expectRows !== undefined) out.assertions.push({ kind: 'rows', expect: `${o.expectRows} row(s)`, actual: String(rows.length), pass: rows.length === o.expectRows });
  for (const e of o.expect ?? []) {
    if (!rows.length) {
      out.assertions.push({ kind: 'value', expect: `${e.path}${e.op}${e.raw}`, actual: 'no rows', pass: false });
      continue;
    }
    const bad2 = rows.find((row) => !compare(getPath(row, e.path), e));
    out.assertions.push({ kind: 'value', expect: `${e.path}${e.op}${e.raw} (every row)`, actual: safeActual(e.path, getPath(bad2 ?? rows[0], e.path)), pass: !bad2 });
  }
  if (!out.assertions.length) out.assertions.push({ kind: 'query', expect: 'runs without error', actual: `${rows.length} row(s)`, pass: true });
  out.ok = out.assertions.every((a) => a.pass);
  return out;
}
