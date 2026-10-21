/**
 * A small YAML reader and writer for the files discovery touches: the probe
 * library, ast-grep test files, CI workflows, docker-compose files and
 * pnpm-workspace.yaml. The tool has no runtime dependencies, so this covers
 * the subset those files use:
 *
 *   block mappings and sequences (including `- key: value` items and
 *   sequences at the same indent as their parent key), flow collections
 *   (`[a, b]`, `{a: 1}`), plain / single-quoted / double-quoted scalars,
 *   block scalars (`|`, `|-`, `>`, `>-`, `|+`), comments, multi-document
 *   files (`---`), anchors (`&a`), aliases (`*a`) and merge keys (`<<`).
 *
 * Not supported (rejected or read as text): complex keys (`? `), tags other
 * than a leading `!!type` (ignored), directives other than `%YAML`.
 * Scalars follow the YAML 1.2 core schema: `yes`/`no`/`on`/`off` stay strings.
 */

export class YamlError extends Error {
  constructor(message: string, public line: number) {
    super(`yaml: line ${line + 1}: ${message}`);
  }
}

interface Line {
  /** index in the document's line array */
  n: number;
  indent: number;
  /** text after the indent, comment not yet stripped */
  text: string;
}

/** Parse every document in a YAML stream. Empty documents are skipped. */
export function parseYamlDocuments(text: string): unknown[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const docs: string[][] = [];
  let cur: string[] = [];
  let started = false;
  for (const l of lines) {
    if (/^---(\s|$)/.test(l)) {
      if (started || cur.some((x) => x.trim() && !x.trim().startsWith('#'))) docs.push(cur);
      cur = [];
      started = true;
      const rest = l.slice(3).trim();
      if (rest && !rest.startsWith('#')) cur.push(rest);
      continue;
    }
    if (/^\.\.\.\s*$/.test(l)) {
      docs.push(cur);
      cur = [];
      continue;
    }
    if (/^%/.test(l) && !started) continue;
    cur.push(l);
  }
  docs.push(cur);
  const out: unknown[] = [];
  for (const d of docs) {
    if (!d.some((x) => x.trim() && !x.trim().startsWith('#'))) continue;
    out.push(new Parser(d).parseDocument());
  }
  return out;
}

/** Parse the first document (or `null` for an empty stream). */
export function parseYaml(text: string): unknown {
  const docs = parseYamlDocuments(text);
  return docs.length ? docs[0] : null;
}

class Parser {
  private i = 0;
  private anchors = new Map<string, unknown>();
  constructor(private raw: string[]) {}

  parseDocument(): unknown {
    const v = this.parseNode(0);
    const next = this.peek();
    if (next) throw new YamlError(`unexpected content '${next.text.slice(0, 40)}'`, next.n);
    return v;
  }

  /** Next non-blank, non-comment line (without consuming). */
  private peek(): Line | null {
    for (let j = this.i; j < this.raw.length; j++) {
      const r = this.raw[j];
      const t = r.trimStart();
      if (!t || t.startsWith('#')) continue;
      if (/^\t/.test(r)) throw new YamlError('tabs are not allowed for indentation', j);
      return { n: j, indent: r.length - t.length, text: t };
    }
    return null;
  }

  private skipTo(l: Line): void {
    this.i = l.n;
  }

  private parseNode(minIndent: number): unknown {
    const l = this.peek();
    if (!l || l.indent < minIndent) return null;
    if (isSeqItem(l.text)) return this.parseSequence(l.indent);
    if (splitKey(l.text)) return this.parseMapping(l.indent);
    // A lone scalar or flow collection, possibly spanning lines.
    this.skipTo(l);
    this.i = l.n + 1;
    return this.parseInlineValue(stripComment(l.text), l, l.indent);
  }

  private parseSequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || !isSeqItem(l.text)) break;
      const afterDash = l.text.slice(1);
      const pad = afterDash.length - afterDash.trimStart().length;
      const content = afterDash.trimStart();
      const contentIndent = indent + 1 + pad;
      if (!content || content.startsWith('#')) {
        this.i = l.n + 1;
        const nx = this.peek();
        out.push(nx && nx.indent > indent ? this.parseNode(nx.indent) : null);
        continue;
      }
      if (isSeqItem(content) || splitKey(content)) {
        // Re-read this line as if the content started at its own column.
        this.raw[l.n] = ' '.repeat(contentIndent) + content;
        this.i = l.n;
        out.push(isSeqItem(content) ? this.parseSequence(contentIndent) : this.parseMapping(contentIndent));
        continue;
      }
      this.i = l.n + 1;
      out.push(this.parseInlineValue(stripComment(content), l, indent + 1));
    }
    return out;
  }

  private parseMapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent) break;
      if (isSeqItem(l.text)) break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError(`expected 'key: value', got '${l.text.slice(0, 40)}'`, l.n);
      this.i = l.n + 1;
      const rest = stripComment(kv.rest).trim();
      let value: unknown;
      let anchor: string | undefined;
      let restV = rest;
      const am = /^&([^\s]+)\s*(.*)$/.exec(restV);
      if (am) {
        anchor = am[1];
        restV = am[2];
      }
      restV = restV.replace(/^!!?[\w/:.-]+\s*/, '');
      if (!restV) {
        const nx = this.peek();
        if (nx && nx.indent > indent) value = this.parseNode(nx.indent);
        else if (nx && nx.indent === indent && isSeqItem(nx.text)) value = this.parseSequence(indent);
        else value = null;
      } else {
        value = this.parseInlineValue(restV, l, indent + 1, kv.rest);
      }
      if (anchor) this.anchors.set(anchor, value);
      if (kv.key === '<<' && value && typeof value === 'object') {
        const merges = Array.isArray(value) ? value : [value];
        for (const m of merges) {
          if (m && typeof m === 'object' && !Array.isArray(m)) {
            for (const [mk, mv] of Object.entries(m as Record<string, unknown>)) if (!(mk in out)) out[mk] = mv;
          }
        }
        continue;
      }
      out[kv.key] = value;
    }
    return out;
  }

  /**
   * A value that starts on line `l`. `text` is the value text with the
   * comment stripped; `rawRest` keeps the comment for block-scalar headers.
   */
  private parseInlineValue(text: string, l: Line, childIndent: number, rawRest?: string): unknown {
    const t = text.trim();
    if (/^[|>]/.test(t)) return this.parseBlockScalar(t, l, childIndent);
    if (t.startsWith('*')) {
      const name = t.slice(1).trim();
      if (!this.anchors.has(name)) throw new YamlError(`unknown alias *${name}`, l.n);
      return this.anchors.get(name);
    }
    if (t.startsWith('[') || t.startsWith('{')) {
      let buf = t;
      while (!flowBalanced(buf)) {
        if (this.i >= this.raw.length) throw new YamlError('unterminated flow collection', l.n);
        buf += ' ' + stripComment(this.raw[this.i].trim());
        this.i++;
      }
      const fp = new FlowParser(buf, l.n);
      const v = fp.parseValue();
      fp.end();
      return v;
    }
    if (t.startsWith('"')) {
      let buf = rawRest !== undefined ? rawRest.trim() : t;
      while (!doubleQuoteClosed(buf)) {
        if (this.i >= this.raw.length) throw new YamlError('unterminated double-quoted string', l.n);
        const nxt = this.raw[this.i].trim();
        buf += nxt === '' ? '\n' : ' ' + nxt;
        this.i++;
      }
      const end = closingDoubleQuote(buf);
      return unescapeDouble(buf.slice(1, end));
    }
    if (t.startsWith("'")) {
      let buf = rawRest !== undefined ? rawRest.trim() : t;
      while (!singleQuoteClosed(buf)) {
        if (this.i >= this.raw.length) throw new YamlError('unterminated single-quoted string', l.n);
        const nxt = this.raw[this.i].trim();
        buf += nxt === '' ? '\n' : ' ' + nxt;
        this.i++;
      }
      const end = closingSingleQuote(buf);
      return buf.slice(1, end).replace(/''/g, "'");
    }
    // Plain scalar; continuation lines are more indented and are not keys or items.
    let s = t;
    for (;;) {
      const nx = this.peek();
      if (!nx || nx.indent < childIndent || nx.indent <= l.indent) break;
      if (splitKey(nx.text) || isSeqItem(nx.text)) break;
      s += ' ' + stripComment(nx.text).trim();
      this.i = nx.n + 1;
    }
    return plainScalar(s);
  }

  private parseBlockScalar(header: string, l: Line, childIndent: number): string {
    const m = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(header);
    if (!m) throw new YamlError(`bad block scalar header '${header}'`, l.n);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    const explicit = m[3] ? Number(m[3]) : 0;
    const body: string[] = [];
    let blockIndent = explicit ? l.indent + explicit : -1;
    while (this.i < this.raw.length) {
      const r = this.raw[this.i];
      if (r.trim() === '') {
        body.push('');
        this.i++;
        continue;
      }
      const ind = r.length - r.trimStart().length;
      if (blockIndent < 0) {
        if (ind < childIndent && ind <= l.indent) break;
        blockIndent = ind;
      }
      if (ind < blockIndent) break;
      body.push(r.slice(blockIndent));
      this.i++;
    }
    // Trailing blank lines belong to chomping.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text: string;
    if (folded) {
      text = '';
      for (let k = 0; k < body.length; k++) {
        const cur = body[k];
        const prev = body[k - 1];
        if (k === 0) text = cur;
        else if (cur === '') text += '\n';
        else if (prev === '') text += cur;
        else if (/^\s/.test(cur) || /^\s/.test(prev)) text += '\n' + cur;
        else text += ' ' + cur;
      }
    } else text = body.join('\n');
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return body.length ? text + '\n' : '';
  }
}

function isSeqItem(t: string): boolean {
  return t === '-' || t.startsWith('- ') || t.startsWith('-\t');
}

/** Split `key: rest` at the first mapping colon outside quotes and brackets. */
function splitKey(t: string): { key: string; rest: string } | null {
  if (t.startsWith('#')) return null;
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    const end = q === '"' ? closingDoubleQuote(t) : closingSingleQuote(t);
    if (end < 0) return null;
    const after = t.slice(end + 1);
    const m = /^\s*:(\s|$)/.exec(after);
    if (!m) return null;
    const keyRaw = t.slice(1, end);
    return { key: q === '"' ? unescapeDouble(keyRaw) : keyRaw.replace(/''/g, "'"), rest: after.slice(m[0].length) };
  }
  if (/^[[{|>&*!%@`]/.test(t)) return null;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === '#' && k > 0 && /\s/.test(t[k - 1])) return null;
    if (c === ':' && (k + 1 === t.length || t[k + 1] === ' ' || t[k + 1] === '\t')) {
      const key = t.slice(0, k).trim();
      if (!key) return null;
      return { key, rest: t.slice(k + 1) };
    }
  }
  return null;
}

/** Remove a trailing ` # comment` outside quotes and flow brackets. */
export function stripComment(t: string): string {
  let inS = false;
  let inD = false;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (inD) {
      if (c === '\\') k++;
      else if (c === '"') inD = false;
      continue;
    }
    if (inS) {
      if (c === "'") {
        if (t[k + 1] === "'") k++;
        else inS = false;
      }
      continue;
    }
    if (c === '"' && (k === 0 || /[\s[{,:]/.test(t[k - 1]))) inD = true;
    else if (c === "'" && (k === 0 || /[\s[{,:]/.test(t[k - 1]))) inS = true;
    else if (c === '#' && (k === 0 || /\s/.test(t[k - 1]))) return t.slice(0, k).trimEnd();
  }
  return t;
}

function closingDoubleQuote(s: string): number {
  for (let k = 1; k < s.length; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '"') return k;
  }
  return -1;
}
function doubleQuoteClosed(s: string): boolean {
  return closingDoubleQuote(s) > 0;
}
function closingSingleQuote(s: string): number {
  for (let k = 1; k < s.length; k++) {
    if (s[k] === "'") {
      if (s[k + 1] === "'") k++;
      else return k;
    }
  }
  return -1;
}
function singleQuoteClosed(s: string): boolean {
  return closingSingleQuote(s) > 0;
}

function unescapeDouble(s: string): string {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++k];
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '0':
        out += '\0';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case ' ':
        out += ' ';
        break;
      case 'x':
        out += String.fromCharCode(parseInt(s.slice(k + 1, k + 3), 16));
        k += 2;
        break;
      case 'u':
        out += String.fromCharCode(parseInt(s.slice(k + 1, k + 5), 16));
        k += 4;
        break;
      case 'U':
        out += String.fromCodePoint(parseInt(s.slice(k + 1, k + 9), 16));
        k += 8;
        break;
      default:
        out += n ?? '';
    }
  }
  return out;
}

function flowBalanced(s: string): boolean {
  let depth = 0;
  let inS = false;
  let inD = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inD) {
      if (c === '\\') k++;
      else if (c === '"') inD = false;
      continue;
    }
    if (inS) {
      if (c === "'") {
        if (s[k + 1] === "'") k++;
        else inS = false;
      }
      continue;
    }
    if (c === '"') inD = true;
    else if (c === "'") inS = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

export function plainScalar(s: string): unknown {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[-+]?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : t;
  }
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === '.inf' || t === '.Inf') return Infinity;
  if (t === '-.inf') return -Infinity;
  if (t === '.nan' || t === '.NaN') return NaN;
  return t;
}

class FlowParser {
  private k = 0;
  constructor(private s: string, private line: number) {}

  end(): void {
    this.ws();
    if (this.k < this.s.length) throw new YamlError(`unexpected '${this.s.slice(this.k, this.k + 20)}' after flow collection`, this.line);
  }

  private ws(): void {
    while (this.k < this.s.length && /\s/.test(this.s[this.k])) this.k++;
  }

  parseValue(): unknown {
    this.ws();
    const c = this.s[this.k];
    if (c === '[') return this.parseSeq();
    if (c === '{') return this.parseMap();
    if (c === '"') {
      const rest = this.s.slice(this.k);
      const end = closingDoubleQuote(rest);
      if (end < 0) throw new YamlError('unterminated string in flow collection', this.line);
      this.k += end + 1;
      return unescapeDouble(rest.slice(1, end));
    }
    if (c === "'") {
      const rest = this.s.slice(this.k);
      const end = closingSingleQuote(rest);
      if (end < 0) throw new YamlError('unterminated string in flow collection', this.line);
      this.k += end + 1;
      return rest.slice(1, end).replace(/''/g, "'");
    }
    const start = this.k;
    while (this.k < this.s.length) {
      const ch = this.s[this.k];
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (ch === ':' && /[\s,\]}]/.test(this.s[this.k + 1] ?? ' ')) break;
      this.k++;
    }
    return plainScalar(this.s.slice(start, this.k));
  }

  private parseSeq(): unknown[] {
    this.k++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.k] === ']') {
        this.k++;
        return out;
      }
      const startK = this.k;
      const v = this.parseValue();
      this.ws();
      if (this.s[this.k] === ':') {
        // single-pair mapping inside a sequence: [a: 1]
        this.k++;
        const val = this.parseValue();
        out.push({ [String(v)]: val });
      } else out.push(v);
      this.ws();
      if (this.s[this.k] === ',') this.k++;
      else if (this.s[this.k] !== ']') {
        if (this.k === startK) throw new YamlError('bad flow sequence', this.line);
        throw new YamlError(`expected ',' or ']' in flow sequence near '${this.s.slice(this.k, this.k + 20)}'`, this.line);
      }
    }
  }

  private parseMap(): Record<string, unknown> {
    this.k++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.k] === '}') {
        this.k++;
        return out;
      }
      const key = this.parseValue();
      this.ws();
      let val: unknown = null;
      if (this.s[this.k] === ':') {
        this.k++;
        this.ws();
        if (this.s[this.k] === ',' || this.s[this.k] === '}') val = null;
        else val = this.parseValue();
      }
      out[String(key)] = val;
      this.ws();
      if (this.s[this.k] === ',') this.k++;
      else if (this.s[this.k] !== '}') throw new YamlError(`expected ',' or '}' in flow mapping near '${this.s.slice(this.k, this.k + 20)}'`, this.line);
    }
  }
}

// ---------------------------------------------------------------------------
// Writer: block style, strings JSON-quoted unless plainly safe. JSON-quoted
// strings are valid YAML double-quoted scalars, so the output round-trips.
// ---------------------------------------------------------------------------

const SAFE_PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);

function scalarOut(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? '.inf' : v < 0 ? '-.inf' : '.nan';
  const s = String(v);
  if (SAFE_PLAIN.test(s) && !RESERVED.has(s.toLowerCase())) return s;
  return JSON.stringify(s);
}

function keyOut(k: string): string {
  return SAFE_PLAIN.test(k) && !RESERVED.has(k.toLowerCase()) ? k : JSON.stringify(k);
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== 'object';
}

function emit(v: unknown, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) {
      out.push(pad + '[]');
      return;
    }
    for (const item of v) {
      if (isScalar(item)) out.push(`${pad}- ${scalarOut(item)}`);
      else if (Array.isArray(item)) {
        if (!item.length) out.push(`${pad}- []`);
        else {
          out.push(`${pad}-`);
          emit(item, indent + 2, out);
        }
      } else {
        const entries = Object.entries(item as Record<string, unknown>).filter(([, x]) => x !== undefined);
        if (!entries.length) {
          out.push(`${pad}- {}`);
          continue;
        }
        const sub: string[] = [];
        emitMap(entries, indent + 2, sub);
        sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
        out.push(...sub);
      }
    }
    return;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) {
      out.push(pad + '{}');
      return;
    }
    emitMap(entries, indent, out);
    return;
  }
  out.push(pad + scalarOut(v));
}

function emitMap(entries: Array<[string, unknown]>, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [k, val] of entries) {
    if (isScalar(val)) out.push(`${pad}${keyOut(k)}: ${scalarOut(val)}`);
    else if (Array.isArray(val) && !val.length) out.push(`${pad}${keyOut(k)}: []`);
    else if (!Array.isArray(val) && !Object.keys(val as object).length) out.push(`${pad}${keyOut(k)}: {}`);
    else {
      out.push(`${pad}${keyOut(k)}:`);
      emit(val, Array.isArray(val) ? indent + 2 : indent + 2, out);
    }
  }
}

/** Serialize a JSON-compatible value as block YAML. */
export function stringifyYaml(value: unknown): string {
  const out: string[] = [];
  emit(value, 0, out);
  return out.join('\n') + '\n';
}

/** Serialize several documents separated by `---`. */
export function stringifyYamlDocuments(values: unknown[]): string {
  return values.map((v) => stringifyYaml(v)).join('---\n');
}
