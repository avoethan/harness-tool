/**
 * The read-only SQL classifier: one function that says whether a piece of
 * T-SQL (as sqlcmd, osql, Invoke-Sqlcmd or Invoke-DbaQuery would send it)
 * can only read. The database rail (src/guard/db.ts) uses it for targets
 * marked `read-only`, and `harness verify db --query` uses it for the
 * agent's own query (src/verify/sqlcmd.ts, checkSelectOnly).
 *
 * Rules, all of which must hold (anything the rules do not cover is denied):
 *  - Raw text: printable ASCII plus tab, CR and LF only (no Unicode
 *    look-alikes, zero-width or control characters, even inside literals:
 *    a client may convert them to ASCII before the server parses them); no
 *    sqlcmd scripting variable `$(`; no line that starts with a sqlcmd
 *    directive (`:connect`, `:r`, `:setvar`, `:out`, ...) and no `!!`; no
 *    batch separator `GO` that starts a line inside a string or comment.
 *  - Comments (`--`, `/* *\/`; a nested one is denied) are removed and string literals,
 *    `[bracket]` and `"quoted"` identifiers are masked before any word is
 *    read, so a keyword inside them neither hides nor counts; an unclosed
 *    comment, literal or identifier is denied.
 *  - The text splits into statements on `;` and on the word `GO` (`GO <n>`,
 *    which repeats a batch, is denied); there is at least one, and every one
 *    starts with SELECT or WITH.
 *  - No word (case-insensitive, whole word) from READ_ONLY_FORBIDDEN, no
 *    word starting with sp_ or xp_ (also in brackets), no `NEXT VALUE FOR`
 *    (it advances a sequence) and no Service Broker conversation verbs.
 *  - No single `:` (labels and directives), no `{` or `}` (ODBC escapes
 *    such as `{call proc}`), and no four-part name; a
 *    three-part name only when its database part is one of the databases
 *    the caller allows (the marked database).
 *
 * Pure: no I/O.
 */

export interface ReadOnlyVerdict {
  ok: boolean;
  /** The first offending word or construct (short; never the statement text). */
  word?: string;
}

export interface ReadOnlyOptions {
  /** Databases a three-part name may name (case-insensitive); empty: none. */
  databases?: string[];
}

/**
 * Words that write, change state, run other code, reach another server or
 * database, or start a statement T-SQL lets follow a SELECT without a `;`.
 */
export const READ_ONLY_FORBIDDEN: ReadonlySet<string> = new Set([
  // the brief's list
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'DENY',
  'EXEC', 'EXECUTE', 'INTO', 'BACKUP', 'RESTORE', 'DBCC', 'USE', 'KILL', 'SHUTDOWN', 'RECONFIGURE', 'BULK',
  'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OPENXML', 'WAITFOR', 'SET', 'DECLARE',
  // statements that may follow a SELECT without a semicolon, and other writers
  'UPDATETEXT', 'WRITETEXT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'CHECKPOINT', 'PRINT', 'RAISERROR', 'THROW',
  'RECEIVE', 'SEND', 'ENABLE', 'DISABLE', 'REVERT', 'SETUSER', 'IF', 'WHILE', 'GOTO', 'RETURN', 'BREAK',
  'CONTINUE', 'OPEN', 'CLOSE', 'DEALLOCATE', 'ADD', 'DUMP', 'LOAD', 'RENAME',
]);

type TokKind = 'word' | 'bracket' | 'qident' | 'string' | 'number' | 'punct';
interface Tok {
  kind: TokKind;
  /** Word text as written; identifier text without its quotes; punctuation itself. */
  text: string;
}

interface Scan {
  ok: boolean;
  word?: string;
  toks: Tok[];
}

const fail = (word: string): Scan => ({ ok: false, word, toks: [] });

/** Tokenise T-SQL: comments dropped, literals and quoted identifiers kept as single tokens. */
export function tokenizeTsql(sql: string): Scan {
  const toks: Tok[] = [];
  /** Ranges [start, end) of strings and comments, for the GO-inside-a-literal check. */
  const masked: Array<[number, number]> = [];
  const s = sql;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      const start = i;
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      masked.push([start, i]);
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      // T-SQL block comments nest.
      const start = i;
      let depth = 0;
      while (i < n) {
        if (s[i] === '/' && s[i + 1] === '*') {
          depth++;
          // Nested comments are T-SQL, but a client or tool that does not nest would read the rest as code.
          if (depth > 1) return fail('a nested comment');
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      if (depth !== 0) return fail('an unclosed comment');
      masked.push([start, i]);
      continue;
    }
    if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      const start = i;
      let j = i + 1;
      let body = '';
      let closed = false;
      while (j < n) {
        if (s[j] === close) {
          if (s[j + 1] === close) {
            body += close;
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        body += s[j++];
      }
      if (!closed) return fail(c === "'" ? 'an unclosed string' : 'an unclosed quoted name');
      i = j + 1;
      masked.push([start, i]);
      toks.push({ kind: c === "'" ? 'string' : c === '"' ? 'qident' : 'bracket', text: body });
      continue;
    }
    if (/[A-Za-z_@#]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_@#$]/.test(s[j])) j++;
      toks.push({ kind: 'word', text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      // As T-SQL reads a number: 0x<hex>, or digits[.digits][e[+-]digits]. Letters right after it start a
      // new word (T-SQL reads `SELECT 1DELETE FROM t` as SELECT 1 followed by DELETE).
      const m = /^0[xX][0-9A-Fa-f]*|^[0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]*)?/.exec(s.slice(i));
      const len = Math.max(1, m ? m[0].length : 1);
      // A number run into a word (`1DELETE`, `1EXEC`, `0x00INSERT`): where the server splits it is not certain.
      if (/[A-Za-z_@#$]/.test(s[i + len] ?? '')) return fail('a number run into a word');
      toks.push({ kind: 'number', text: s.slice(i, i + len) });
      i += len;
      continue;
    }
    toks.push({ kind: 'punct', text: c });
    i++;
  }
  // GO that starts a line inside a literal or comment: sqlcmd splits batches by line, not by T-SQL syntax.
  const lineRe = /(^|[\r\n])([ \t]*)go(?![A-Za-z0-9_@#$])/gi;
  for (const m of s.matchAll(lineRe)) {
    const pos = (m.index ?? 0) + m[1].length + m[2].length;
    if (masked.some(([a, b]) => pos > a && pos < b)) return fail('GO inside a string or comment');
  }
  return { ok: true, toks };
}

const isIdent = (t: Tok | undefined): boolean => !!t && (t.kind === 'word' || t.kind === 'bracket' || t.kind === 'qident');
const isPunct = (t: Tok | undefined, p: string): boolean => !!t && t.kind === 'punct' && t.text === p;
const upper = (t: Tok | undefined): string => (t && t.kind === 'word' ? t.text.toUpperCase() : '');

/** A short, safe label for a word (letters, digits and _ only; at most 30 characters). */
function label(w: string): string {
  const clean = w.replace(/[^A-Za-z0-9_@#$]/g, '').slice(0, 30);
  return clean || 'a name';
}

/** Raw-text checks (applied to everything, literals and comments included). */
function rawCheck(sql: string): string | null {
  const bad = /[^\t\r\n\x20-\x7e]/.exec(sql);
  if (bad) return 'a non-ASCII or control character';
  if (sql.includes('$(')) return '$( (a sqlcmd variable)';
  const dir = /(^|[\r\n])[ \t]*(:[ \t]*[A-Za-z!]+|!!)/.exec(sql);
  if (dir) return dir[2].replace(/[ \t]/g, '').slice(0, 20);
  if (sql.includes('!!')) return '!! (a shell command)';
  return null;
}

/** Multi-part names: every chain of identifiers joined by dots, with its part count and first part. */
function nameChains(toks: Tok[]): Array<{ parts: number; first: Tok; firstIndex: number }> {
  const out: Array<{ parts: number; first: Tok; firstIndex: number }> = [];
  for (let k = 0; k < toks.length; k++) {
    if (!isIdent(toks[k]) || isPunct(toks[k - 1], '.')) continue;
    let parts = 1;
    let j = k + 1;
    while (isPunct(toks[j], '.')) {
      parts++;
      j++;
      if (isIdent(toks[j])) j++;
    }
    if (parts > 1) out.push({ parts, first: toks[k], firstIndex: k });
    k = j - 1;
  }
  return out;
}

/** Can this T-SQL text only read? See the module comment for the rules. */
export function classifyReadOnlySql(sql: string, opts: ReadOnlyOptions = {}): ReadOnlyVerdict {
  const raw = rawCheck(sql);
  if (raw) return { ok: false, word: raw };
  const scan = tokenizeTsql(sql);
  if (!scan.ok) return { ok: false, word: scan.word };
  const toks = scan.toks;

  // Statements: split on ; and the word GO.
  const statements: Tok[][] = [];
  let cur: Tok[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (isPunct(t, ';')) {
      if (cur.length) statements.push(cur);
      cur = [];
      continue;
    }
    if (upper(t) === 'GO') {
      if (toks[k + 1]?.kind === 'number') return { ok: false, word: 'GO <count> (repeats a batch)' };
      if (cur.length) statements.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) statements.push(cur);
  if (!statements.length) return { ok: false, word: 'no statement' };
  for (const st of statements) {
    const first = upper(st[0]);
    if (first !== 'SELECT' && first !== 'WITH') return { ok: false, word: st[0].kind === 'word' ? label(st[0].text).toUpperCase() : 'a statement that does not start with SELECT' };
  }

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === 'word') {
      const w = t.text.toUpperCase();
      if (READ_ONLY_FORBIDDEN.has(w)) return { ok: false, word: w };
      if (/^(SP|XP)_/.test(w)) return { ok: false, word: label(t.text) };
      if (w === 'NEXT' && upper(toks[k + 1]) === 'VALUE') return { ok: false, word: 'NEXT VALUE FOR' };
      if ((w === 'END' || w === 'GET' || w === 'MOVE') && upper(toks[k + 1]) === 'CONVERSATION') return { ok: false, word: `${w} CONVERSATION` };
    } else if ((t.kind === 'bracket' || t.kind === 'qident') && /^\s*(sp|xp)_/i.test(t.text)) return { ok: false, word: label(t.text) };
    else if (isPunct(t, '{') || isPunct(t, '}')) return { ok: false, word: '{ } (an ODBC escape such as {call ...})' };
    else if (isPunct(t, ':')) {
      if (isPunct(toks[k + 1], ':')) {
        k++;
        continue;
      }
      return { ok: false, word: ': (a label or sqlcmd directive)' };
    }
  }

  const allowed = new Set((opts.databases ?? []).map((d) => d.toLowerCase()));
  for (const ch of nameChains(toks)) {
    if (ch.parts >= 4) return { ok: false, word: 'a four-part name (a linked server)' };
    if (ch.parts === 3) {
      const db = ch.first.text.trim().toLowerCase();
      if (!allowed.has(db)) return { ok: false, word: `a three-part name in another database (${label(ch.first.text)})` };
    }
  }
  return { ok: true };
}
