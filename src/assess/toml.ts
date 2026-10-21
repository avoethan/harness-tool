/**
 * A minimal TOML reader for the Codex keys assess checks
 * (`approval_policy`, `sandbox_mode`, `[mcp_servers.*]`, `[projects."<path>"]`,
 * `project_doc_max_bytes`, `project_doc_fallback_filenames`).
 *
 * Supported: comments, `[table]` and `[[array.of.tables]]` headers, bare /
 * quoted / dotted keys, basic and literal strings (single- and multi-line),
 * booleans, integers and floats, arrays (multi-line, trailing commas) and
 * inline tables. Nothing more: dates and anything else throw a TomlError with
 * the line number, which the caller reports as "could not parse" (R24).
 */

export class TomlError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export function parseToml(text: string): TomlTable {
  const p = new Parser(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return p.parse();
}

export function tryParseToml(text: string): { ok: true; value: TomlTable } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseToml(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function isObj(v: unknown): v is TomlTable {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

class Parser {
  private i = 0;
  private line = 1;
  private root: TomlTable = {};
  private cur: TomlTable;

  constructor(private s: string) {
    this.cur = this.root;
  }

  parse(): TomlTable {
    for (;;) {
      this.skipWsAndNewlines();
      if (this.i >= this.s.length) break;
      const c = this.s[this.i];
      if (c === '[') this.header();
      else this.keyValue(this.cur);
      this.endOfLine();
    }
    return this.root;
  }

  private err(msg: string): never {
    throw new TomlError(msg, this.line);
  }

  private peek(n = 0): string {
    return this.s[this.i + n] ?? '';
  }

  private skipWs(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.i++;
  }

  private skipComment(): void {
    if (this.peek() === '#') while (this.i < this.s.length && this.peek() !== '\n') this.i++;
  }

  private skipWsAndNewlines(): void {
    for (;;) {
      this.skipWs();
      this.skipComment();
      if (this.peek() === '\r' && this.peek(1) === '\n') this.i++;
      if (this.peek() === '\n') {
        this.i++;
        this.line++;
        continue;
      }
      break;
    }
  }

  private endOfLine(): void {
    this.skipWs();
    this.skipComment();
    if (this.peek() === '\r') this.i++;
    if (this.i >= this.s.length) return;
    if (this.peek() !== '\n') this.err(`unexpected "${this.peek()}" after a value`);
    this.i++;
    this.line++;
  }

  private header(): void {
    const arr = this.peek(1) === '[';
    this.i += arr ? 2 : 1;
    this.skipWs();
    const keys = this.key();
    this.skipWs();
    if (arr) {
      if (this.peek() !== ']' || this.peek(1) !== ']') this.err('expected ]] to close the table header');
      this.i += 2;
    } else {
      if (this.peek() !== ']') this.err('expected ] to close the table header');
      this.i++;
    }
    let t = this.root;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const last = k === keys.length - 1;
      if (last && arr) {
        const existing = t[key];
        if (existing === undefined) t[key] = [];
        else if (!Array.isArray(existing)) this.err(`"${key}" is not an array of tables`);
        const list = t[key] as TomlValue[];
        const fresh: TomlTable = {};
        list.push(fresh);
        t = fresh;
        break;
      }
      let next = t[key];
      if (next === undefined) {
        next = {};
        t[key] = next;
      } else if (Array.isArray(next)) {
        const tail = next[next.length - 1];
        if (!isObj(tail)) this.err(`"${key}" is not a table`);
        next = tail;
      } else if (!isObj(next)) this.err(`"${key}" is already a value`);
      t = next as TomlTable;
    }
    this.cur = t;
  }

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 256));
        if (!m) this.err('expected a key');
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.skipWs();
      if (this.peek() === '.') {
        this.i++;
        continue;
      }
      return parts;
    }
  }

  private keyValue(table: TomlTable): void {
    const keys = this.key();
    this.skipWs();
    if (this.peek() !== '=') this.err('expected = after a key');
    this.i++;
    this.skipWs();
    const value = this.value();
    let t = table;
    for (let k = 0; k < keys.length - 1; k++) {
      const key = keys[k];
      if (t[key] === undefined) t[key] = {};
      if (!isObj(t[key])) this.err(`"${key}" is already a value`);
      t = t[key] as TomlTable;
    }
    const last = keys[keys.length - 1];
    if (last in t) this.err(`duplicate key "${last}"`);
    t[last] = value;
  }

  private value(): TomlValue {
    const c = this.peek();
    if (c === '"') return this.peek(1) === '"' && this.peek(2) === '"' ? this.multiBasic() : this.basicString();
    if (c === "'") return this.peek(1) === "'" && this.peek(2) === "'" ? this.multiLiteral() : this.literalString();
    if (c === '[') return this.array();
    if (c === '{') return this.inlineTable();
    const rest = this.s.slice(this.i, this.i + 64);
    const b = /^(true|false)(?![A-Za-z0-9_-])/.exec(rest);
    if (b) {
      this.i += b[0].length;
      return b[0] === 'true';
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(rest)) this.err('dates are not supported by this reader');
    const n = /^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?(?![A-Za-z0-9_.:-])/.exec(rest);
    if (n) {
      this.i += n[0].length;
      return Number(n[0].replace(/_/g, ''));
    }
    const h = /^0x[0-9A-Fa-f_]+/.exec(rest);
    if (h) {
      this.i += h[0].length;
      return parseInt(h[0].slice(2).replace(/_/g, ''), 16);
    }
    return this.err('unsupported value');
  }

  private basicString(): string {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      if (this.i >= this.s.length || this.peek() === '\n') this.err('unterminated string');
      const c = this.s[this.i++];
      if (c === '"') return out;
      if (c === '\\') out += this.escape();
      else out += c;
    }
  }

  private escape(): string {
    const e = this.s[this.i++];
    switch (e) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = e === 'u' ? 4 : 8;
        const hex = this.s.slice(this.i, this.i + len);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) this.err('bad unicode escape');
        this.i += len;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default:
        return this.err(`bad escape \\${e}`);
    }
  }

  private literalString(): string {
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf('\n', this.i);
    if (end < 0 || (nl >= 0 && nl < end)) this.err('unterminated literal string');
    const v = this.s.slice(this.i, end);
    this.i = end + 1;
    return v;
  }

  private multiBasic(): string {
    this.i += 3;
    if (this.peek() === '\r') this.i++;
    if (this.peek() === '\n') {
      this.i++;
      this.line++;
    }
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.err('unterminated multi-line string');
      if (this.s.startsWith('"""', this.i)) {
        this.i += 3;
        while (this.peek() === '"') {
          out += '"';
          this.i++;
        }
        return out;
      }
      const c = this.s[this.i++];
      if (c === '\n') this.line++;
      if (c === '\\') {
        // line-ending backslash trims the newline and following whitespace
        if (/^[ \t]*\r?\n/.test(this.s.slice(this.i, this.i + 64))) {
          while (/[ \t\r\n]/.test(this.peek())) {
            if (this.peek() === '\n') this.line++;
            this.i++;
          }
          continue;
        }
        out += this.escape();
      } else out += c;
    }
  }

  private multiLiteral(): string {
    this.i += 3;
    if (this.peek() === '\r') this.i++;
    if (this.peek() === '\n') {
      this.i++;
      this.line++;
    }
    const end = this.s.indexOf("'''", this.i);
    if (end < 0) this.err('unterminated multi-line literal string');
    const v = this.s.slice(this.i, end);
    this.line += (v.match(/\n/g) ?? []).length;
    this.i = end + 3;
    return v;
  }

  private array(): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipWsAndNewlines();
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.skipWsAndNewlines();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
      this.err('expected , or ] in an array');
    }
  }

  private inlineTable(): TomlTable {
    this.i++;
    const t: TomlTable = {};
    this.skipWs();
    if (this.peek() === '}') {
      this.i++;
      return t;
    }
    for (;;) {
      this.skipWs();
      this.keyValue(t);
      this.skipWs();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === '}') {
        this.i++;
        return t;
      }
      this.err('expected , or } in an inline table');
    }
  }
}
