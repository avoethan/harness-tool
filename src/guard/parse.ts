/**
 * Shell-command parser for policy decisions (guard library).
 *
 * Good enough for policy, not a shell: it splits a command line into
 * segments on && || ; | & and newlines, respects single and double quotes,
 * backslashes and ANSI-C quoting, finds command substitutions ($(...),
 * backticks, process substitution), strips known wrappers (sudo, timeout,
 * nice, nohup, xargs, env, command, exec, busybox, ...), recognises
 * shell-in-shell and remote wrappers (bash -c, pwsh -Command, cmd /c,
 * docker exec/run, ssh, kubectl exec, npx, npm exec, node -e, python -c,
 * eval, ...) and parses their inner command recursively where it is a plain
 * string. Everything it cannot read is marked `opaque` so the guard can
 * default to deny. Program names are normalised (basename, no .exe,
 * lower-case) so `/usr/bin/git`, `git.exe` and `GIT` all read as `git`.
 *
 * Pure: no I/O, no environment access.
 */

export type Dialect = 'posix' | 'powershell' | 'cmd';

export interface Token {
  /** Dequoted text as the program would receive it ($VAR left literal). */
  text: string;
  /** As written. */
  raw: string;
  /** Any quoting or escaping was present. */
  quoted: boolean;
  /** Contains an expansion the parser cannot resolve ($VAR, $(...), `...`, %VAR%, $env:X). */
  dynamic: boolean;
  /** Bodies of command substitutions found inside this token. */
  subshells: string[];
  /** Started with ~ outside quotes (tilde expansion). */
  tilde: boolean;
}

export interface Redirect {
  /** >, >>, <, <<, <<<, &>, &>>, >&, <&, >| */
  op: string;
  /** File descriptor when written (2>...). */
  fd?: number;
  /** Target token text ('' when the target is a descriptor such as 2>&1). */
  target: string;
  dynamic: boolean;
  /** Heredoc body when op is <<. */
  heredoc?: string;
}

export interface ViaEntry {
  /** Wrapper kind: 'bash -c', 'pwsh -Command', 'cmd /c', 'docker exec', 'docker run', 'ssh', 'kubectl exec', 'eval', ... */
  kind: string;
  /** Container, host or pod when the wrapper has one. */
  target?: string;
}

export interface Segment {
  raw: string;
  dialect: Dialect;
  /** Normalised program name ('' when none or unreadable). */
  prog: string;
  /** Program token as written. */
  progRaw: string;
  /** Dequoted arguments after the program (wrappers removed). */
  args: string[];
  argTokens: Token[];
  /** VAR=value prefixes and `env VAR=value` / `docker -e VAR=value` assignments. */
  env: Record<string, string>;
  /** Env assignments whose value is dynamic. */
  envDynamic: string[];
  /** Wrappers stripped, in order (sudo, timeout, env, npx, ...). */
  wrappers: string[];
  redirects: Redirect[];
  /** Heredoc body fed to stdin, when any. */
  heredoc?: string;
  /** This segment reads stdin from the previous pipeline member. */
  stdinFromPipe: boolean;
  /** This segment pipes into the next one. */
  pipesTo: boolean;
  /** Index of the pipeline this segment belongs to. */
  pipeline: number;
  /** Chain of wrappers that lead here (outermost first). */
  via: ViaEntry[];
  /** Inner command when a shell-in-shell wrapper carried a plain string. */
  inner?: ParsedCommand;
  /** Inline code when the program is an interpreter one-liner (node -e, python -c, ...). */
  innerCode?: string;
  innerLang?: 'js' | 'py' | 'perl' | 'ruby' | 'php' | 'powershell' | 'other';
  /** Command substitutions found in this segment, parsed. */
  subshells: ParsedCommand[];
  /** The parser could not read part of this segment. */
  opaque: boolean;
  opaqueReason?: string;
  /** The program name itself is computed at run time. */
  dynamicProg: boolean;
  /** Any token (program, argument, redirect target) is dynamic. */
  dynamic: boolean;
  /** Arguments come from stdin (xargs without a literal list). */
  argsFromStdin: boolean;
  /** Image reference for docker run/create. */
  dockerImage?: string;
  /** -v/--mount values for docker run/create. */
  dockerMounts?: string[];
  /** When this segment came from a $(...) body: the program of the segment that contains it. */
  parentProg?: string;
  /** Substitution bodies consumed by `env` as an env-file load: env $(cat .env) cmd. */
  envLoadBodies?: string[];
  depth: number;
}

export interface ParsedCommand {
  raw: string;
  dialect: Dialect;
  segments: Segment[];
  /** True when any segment, inner command or subshell is opaque. */
  opaque: boolean;
  /** Hidden Unicode (zero-width, bidi, tags) was present in the raw text. */
  hiddenUnicode: boolean;
  depth: number;
}

export interface ParseOptions {
  dialect?: Dialect;
  depth?: number;
  via?: ViaEntry[];
  /** Program of the segment that contains this command substitution, when parsing a $(...) body. */
  parentProg?: string;
  /** Case-insensitive program names (always on; kept for clarity). */
  windows?: boolean;
}

const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Hidden Unicode (same classes as src/lib/unicode, kept local so the parser
// stays dependency-free)
// ---------------------------------------------------------------------------

const HIDDEN_RE = new RegExp("[\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u00AD\\u180E\\u061C]|[\\u{E0000}-\\u{E007F}]", "u");

export function hasHiddenUnicode(s: string): boolean {
  return HIDDEN_RE.test(s);
}

// ---------------------------------------------------------------------------
// Program-name normalisation
// ---------------------------------------------------------------------------

const EXE_RE = /\.(exe|cmd|bat|com)$/i;

/** basename, no .exe/.cmd/.bat, lower-case; "" for empty or whitespace-bearing names. */
export function normalizeProg(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (s === '.' || s === 'source') return s;
  // PowerShell call operator and cmd alias-bypass prefix.
  s = s.replace(/^[&.]\s*/, '').replace(/^\\(?=[A-Za-z])/, '');
  // Strip a trailing path separator, then take the basename on / and \.
  s = s.replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  s = parts[parts.length - 1] ?? s;
  s = s.replace(EXE_RE, '');
  if (/\s/.test(s)) return '';
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface RawTok {
  kind: 'word' | 'op' | 'redir' | 'nl';
  text: string;
  raw: string;
  quoted: boolean;
  /** Real quote characters were present (not just backslash escapes). */
  quoteChars?: boolean;
  dynamic: boolean;
  subshells: string[];
  tilde: boolean;
  fd?: number;
  /** for heredoc redirects */
  heredoc?: string;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r';
}

/** Find the index of the closing delimiter for a nested construct starting after `open` at `i`. */
function findClose(s: string, i: number, open: string, close: string, dialect: Dialect): number {
  let depth = 1;
  let j = i;
  let q: string | null = null;
  const esc = dialect === 'powershell' ? '`' : dialect === 'cmd' ? '^' : '\\';
  while (j < s.length) {
    const c = s[j];
    if (q) {
      if (c === esc && q === '"' && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (c === q) q = null;
      j++;
      continue;
    }
    if (c === esc && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (c === '"' || (c === "'" && dialect !== 'cmd')) {
      q = c;
      j++;
      continue;
    }
    if (s.startsWith(open, j) && open !== close) depth++;
    else if (c === close[0] && s.startsWith(close, j)) {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

function decodeAnsiC(body: string): string {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|.)/g, (_m, g: string) => {
    const c = g[0];
    if (c === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    if (c === 'u' || c === 'U') return String.fromCodePoint(parseInt(g.slice(1), 16));
    if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(g, 8));
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', "'": "'", '"': '"' };
    return map[c] ?? g;
  });
}

/**
 * Tokenise one command string. Returns words, operators, redirects and
 * newline markers in order. Heredoc bodies are attached to their redirect.
 */
export function tokenize(s: string, dialect: Dialect = 'posix'): RawTok[] {
  const out: RawTok[] = [];
  const n = s.length;
  let i = 0;
  const pendingHeredocs: { tok: RawTok; delim: string; strip: boolean }[] = [];
  const esc = dialect === 'powershell' ? '`' : dialect === 'cmd' ? '^' : '\\';

  const consumeHeredocs = () => {
    // i is just past a newline; read bodies for each pending heredoc in order.
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift()!;
      const lines: string[] = [];
      let found = false;
      while (i < n) {
        let eol = s.indexOf('\n', i);
        if (eol < 0) eol = n;
        let line = s.slice(i, eol);
        i = eol + 1;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp.replace(/\r$/, '') === h.delim) {
          found = true;
          break;
        }
        if (h.strip) line = line.replace(/^\t+/, '');
        lines.push(line);
      }
      h.tok.heredoc = lines.join('\n');
      if (!found) i = n;
    }
  };

  while (i < n) {
    const c = s[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === esc && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      // line continuation (\-newline, PowerShell `-newline, cmd ^-newline)
      i += s[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (c === '\n') {
      out.push({ kind: 'nl', text: '\n', raw: '\n', quoted: false, dynamic: false, subshells: [], tilde: false });
      i++;
      if (pendingHeredocs.length) consumeHeredocs();
      continue;
    }
    // Comments
    if (dialect !== 'cmd' && c === '#' && (out.length === 0 || out[out.length - 1].kind !== 'word' || /\s/.test(s[i - 1] ?? ' '))) {
      if (dialect === 'powershell' && s[i + 1] === '>') {
        // stray close of a block comment; skip
        i += 2;
        continue;
      }
      let eol = s.indexOf('\n', i);
      if (eol < 0) eol = n;
      i = eol;
      continue;
    }
    if (dialect === 'powershell' && c === '<' && s[i + 1] === '#') {
      const end = s.indexOf('#>', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (dialect === 'cmd' && /^(rem\b|::)/i.test(s.slice(i)) && (out.length === 0 || out[out.length - 1].kind !== 'word')) {
      let eol = s.indexOf('\n', i);
      if (eol < 0) eol = n;
      i = eol;
      continue;
    }

    // Operators
    const two = s.slice(i, i + 2);
    const three = s.slice(i, i + 3);
    if (dialect === 'posix' || dialect === 'powershell' || dialect === 'cmd') {
      if (two === '&&' || two === '||') {
        out.push(op(two));
        i += 2;
        continue;
      }
      if (dialect === 'posix' && two === '|&') {
        out.push(op('|&'));
        i += 2;
        continue;
      }
      if (dialect === 'posix' && two === ';;') {
        out.push(op(';'));
        i += 2;
        continue;
      }
      if (c === '|') {
        out.push(op('|'));
        i++;
        continue;
      }
      if (c === ';' && dialect !== 'cmd') {
        out.push(op(';'));
        i++;
        continue;
      }
      if (c === '&' && two !== '&>') {
        if (dialect === 'powershell') {
          // call operator at segment start, background operator otherwise; both are separators for policy
          const prev = out[out.length - 1];
          if (!prev || prev.kind !== 'word') {
            // call operator: skip it, the next word is the program
            i++;
            continue;
          }
        }
        out.push(op('&'));
        i++;
        continue;
      }
      if (c === '(' || c === ')') {
        out.push(op(c));
        i++;
        continue;
      }
    }

    // Process substitution <(...) / >(...) is a word that carries a subshell, not a redirect.
    if (dialect === 'posix' && (two === '<(' || two === '>(')) {
      const w = readWord();
      if (w) out.push(w);
      else i++;
      continue;
    }
    // Redirects (with optional fd prefix)
    const redirM = /^(\d*)(>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(s.slice(i, i + 4));
    const ampRedir = two === '&>' ? (three === '&>>' ? '&>>' : '&>') : null;
    const psStar = dialect === 'powershell' && (three === '*>>' ? '*>>' : two === '*>' ? '*>' : null);
    if (ampRedir || psStar || (redirM && (redirM[1] === '' || (i === 0 || isSpace(s[i - 1]) || /[^\w]/.test(s[i - 1]))))) {
      let opText: string;
      let fd: number | undefined;
      if (ampRedir) {
        opText = ampRedir;
        i += ampRedir.length;
      } else if (psStar) {
        opText = psStar;
        i += psStar.length;
      } else {
        fd = redirM![1] ? parseInt(redirM![1], 10) : undefined;
        opText = redirM![2];
        i += redirM![0].length;
      }
      const tok: RawTok = { kind: 'redir', text: opText, raw: opText, quoted: false, dynamic: false, subshells: [], tilde: false, fd };
      // Target word (may be absent for 2>&1)
      while (i < n && isSpace(s[i])) i++;
      if (opText === '>&' || opText === '<&') {
        // next token is a descriptor or '-' or a file
        const w = readWord();
        if (w) {
          tok.text = opText;
          if (/^\d+$/.test(w.text) || w.text === '-') tok.raw = opText + w.text;
          else {
            out.push(tok);
            out.push(w);
            continue;
          }
        }
        out.push(tok);
        continue;
      }
      if (opText === '<<' || opText === '<<-') {
        const w = readWord();
        const delim = w ? w.text : '';
        pendingHeredocs.push({ tok, delim, strip: opText === '<<-' });
        tok.heredoc = '';
        out.push(tok);
        continue;
      }
      out.push(tok);
      const w = readWord();
      if (w) {
        // store the target as a separate word tagged by position: merge into redir token
        tok.raw = opText + ' ' + w.raw;
        (tok as RawTok & { target?: RawTok }).target = w;
      }
      continue;
    }

    const w = readWord();
    if (w) out.push(w);
    else i++;
  }
  if (pendingHeredocs.length) consumeHeredocs();
  return out;

  function op(t: string): RawTok {
    return { kind: 'op', text: t, raw: t, quoted: false, dynamic: false, subshells: [], tilde: false };
  }

  function readWord(): RawTok | null {
    const start = i;
    let text = '';
    let quoted = false;
    let quoteChars = false;
    let dynamic = false;
    const subshells: string[] = [];
    let tilde = false;
    let any = false;
    if (dialect === 'powershell' && (s.startsWith('@"', i) || s.startsWith("@'", i))) {
      // here-string: @" ... "@ (closing marker at line start)
      const q = s[i + 1];
      const endMark = '\n' + q + '@';
      const end = s.indexOf(endMark, i + 2);
      const body = s.slice(i + 2, end < 0 ? n : end).replace(/^\r?\n/, '');
      i = end < 0 ? n : end + endMark.length;
      return { kind: 'word', text: body, raw: s.slice(start, i), quoted: true, dynamic: q === '"' && /\$/.test(body), subshells: [], tilde: false };
    }
    if (dialect === 'powershell' && s.startsWith('--%', i)) {
      // stop-parsing token: the rest of the line is passed verbatim (cmd-style %VAR% expands)
      let eol = s.indexOf('\n', i);
      if (eol < 0) eol = n;
      const rest = s.slice(i + 3, eol).trim();
      i = eol;
      return { kind: 'word', text: rest, raw: s.slice(start, i), quoted: false, dynamic: /%[^%\s]+%/.test(rest), subshells: [], tilde: false };
    }
    while (i < n) {
      const c = s[i];
      if (isSpace(c) || c === '\n') break;
      if (dialect === 'cmd') {
        if (c === '&' || c === '|' || c === '<' || c === '>' || c === '(' || c === ')') break;
      } else {
        if (dialect === 'powershell' && c === '(' && text !== '' && !isSpace(s[i - 1] ?? ' ')) {
          // A method call or constructor: [IO.File]::WriteAllText('a','b') and $c.Open() are one word.
          const close = findClose(s, i + 1, '(', ')', dialect);
          const body = s.slice(i + 1, close < 0 ? n : close);
          text += '(' + body + ')';
          if (/\$/.test(body)) dynamic = true;
          i = close < 0 ? n : close + 1;
          continue;
        }
        if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') break;
        if ((c === '<' || c === '>') && !(dialect === 'posix' && (s[i + 1] === '(' ))) {
          if (dialect === 'posix' && /^\d+$/.test(text) && !quoted) {
            // fd prefix of a redirect: give it back
            i = start;
            return null;
          }
          break;
        }
      }
      any = true;
      // Quotes
      if (c === "'" && dialect !== 'cmd') {
        quoteChars = true;
        const end = s.indexOf("'", i + 1);
        if (dialect === 'powershell') {
          // '' inside single quotes is an escaped quote
          let j = i + 1;
          let body = '';
          while (j < n) {
            if (s[j] === "'" && s[j + 1] === "'") {
              body += "'";
              j += 2;
              continue;
            }
            if (s[j] === "'") break;
            body += s[j++];
          }
          text += body;
          i = j + 1;
        } else {
          text += s.slice(i + 1, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        }
        quoted = true;
        continue;
      }
      if (c === '"') {
        quoted = true;
        quoteChars = true;
        i++;
        while (i < n && s[i] !== '"') {
          const d = s[i];
          if (d === esc && i + 1 < n && dialect !== 'cmd') {
            const nx = s[i + 1];
            if (dialect === 'posix') {
              if (nx === '$' || nx === '`' || nx === '"' || nx === '\\' || nx === '\n') {
                if (nx !== '\n') text += nx;
                i += 2;
                continue;
              }
              text += d;
              i++;
              continue;
            }
            // powershell backtick escapes
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
            text += map[nx] ?? nx;
            i += 2;
            continue;
          }
          if (dialect === 'powershell' && d === '"' ) break;
          if (dialect === 'powershell' && d === "'" ) {
            text += d;
            i++;
            continue;
          }
          const sub = readExpansion(true);
          if (sub !== null) {
            text += sub.text;
            if (sub.dynamic) dynamic = true;
            if (sub.body !== undefined) subshells.push(sub.body);
            continue;
          }
          text += d;
          i++;
        }
        i++; // closing quote
        continue;
      }
      if (dialect === 'posix' && c === '$' && s[i + 1] === "'") {
        // ANSI-C quoting
        const end = findAnsiEnd(i + 2);
        text += decodeAnsiC(s.slice(i + 2, end));
        i = end + 1;
        quoted = true;
        continue;
      }
      if (c === esc && i + 1 < n) {
        quoted = true;
        if (s[i + 1] === '\n') {
          i += 2; // line continuation
          continue;
        }
        if (dialect === 'powershell') {
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0' };
          text += map[s[i + 1]] ?? s[i + 1];
        } else text += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '~' && text === '' && !quoted) tilde = true;
      const sub = readExpansion(false);
      if (sub !== null) {
        text += sub.text;
        if (sub.dynamic) dynamic = true;
        if (sub.body !== undefined) subshells.push(sub.body);
        continue;
      }
      text += c;
      i++;
    }
    if (!any) return null;
    return { kind: 'word', text, raw: s.slice(start, i), quoted, quoteChars, dynamic, subshells, tilde };
  }

  function findAnsiEnd(from: number): number {
    let j = from;
    while (j < n) {
      if (s[j] === '\\') {
        j += 2;
        continue;
      }
      if (s[j] === "'") return j;
      j++;
    }
    return n;
  }

  /**
   * At position i, read an expansion construct if one starts here.
   * Returns {text, dynamic, body?} or null when none. Advances i.
   */
  function readExpansion(_inDouble: boolean): { text: string; dynamic: boolean; body?: string } | null {
    const c = s[i];
    if (dialect === 'cmd') {
      if ((c === '%' || c === '!') && i + 1 < n) {
        const end = s.indexOf(c, i + 1);
        if (end > i + 1 && !/\s/.test(s.slice(i + 1, end))) {
          const t = s.slice(i, end + 1);
          i = end + 1;
          return { text: t, dynamic: true };
        }
      }
      return null;
    }
    if (c === '$') {
      if (s[i + 1] === '(') {
        // $(...) command substitution (posix) or subexpression (powershell): both dynamic
        const close = findClose(s, i + 2, '(', ')', dialect);
        const end = close < 0 ? n : close;
        const body = s.slice(i + 2, end);
        const t = s.slice(i, close < 0 ? n : close + 1);
        i = close < 0 ? n : close + 1;
        return { text: t, dynamic: true, body };
      }
      if (s[i + 1] === '{') {
        const close = findClose(s, i + 2, '{', '}', dialect);
        const t = s.slice(i, close < 0 ? n : close + 1);
        i = close < 0 ? n : close + 1;
        return { text: t, dynamic: true };
      }
      const m = /^\$(env:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9-])/.exec(s.slice(i, i + 80));
      if (m) {
        i += m[0].length;
        return { text: m[0], dynamic: true };
      }
      return null;
    }
    if (dialect === 'posix' && c === '`') {
      let j = i + 1;
      while (j < n && s[j] !== '`') {
        if (s[j] === '\\') j++;
        j++;
      }
      const body = s.slice(i + 1, j);
      const t = s.slice(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      return { text: t, dynamic: true, body };
    }
    if (dialect === 'posix' && (c === '<' || c === '>') && s[i + 1] === '(') {
      const close = findClose(s, i + 2, '(', ')', dialect);
      const body = s.slice(i + 2, close < 0 ? n : close);
      const t = s.slice(i, close < 0 ? n : close + 1);
      i = close < 0 ? n : close + 1;
      return { text: t, dynamic: true, body };
    }
    if (dialect === 'powershell' && c === '{' ) {
      const close = findClose(s, i + 1, '{', '}', dialect);
      const body = s.slice(i + 1, close < 0 ? n : close);
      const t = s.slice(i, close < 0 ? n : close + 1);
      i = close < 0 ? n : close + 1;
      return { text: t, dynamic: true, body };
    }
    if (dialect === 'powershell' && c === '@' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      const open = s[i + 1];
      const closeCh = open === '(' ? ')' : '}';
      const close = findClose(s, i + 2, open, closeCh, dialect);
      const body = s.slice(i + 2, close < 0 ? n : close);
      const t = s.slice(i, close < 0 ? n : close + 1);
      i = close < 0 ? n : close + 1;
      return { text: t, dynamic: true, body: open === '(' ? body : undefined };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Segment building
// ---------------------------------------------------------------------------

interface SegCtx {
  dialect: Dialect;
  depth: number;
  via: ViaEntry[];
  parentProg?: string;
}

function tokenToPublic(t: RawTok): Token {
  return { text: t.text, raw: t.raw, quoted: t.quoted, dynamic: t.dynamic, subshells: t.subshells, tilde: t.tilde };
}

function emptySegment(raw: string, ctx: SegCtx): Segment {
  return {
    raw,
    parentProg: ctx.parentProg,
    dialect: ctx.dialect,
    prog: '',
    progRaw: '',
    args: [],
    argTokens: [],
    env: {},
    envDynamic: [],
    wrappers: [],
    redirects: [],
    stdinFromPipe: false,
    pipesTo: false,
    pipeline: 0,
    via: ctx.via,
    subshells: [],
    opaque: false,
    dynamicProg: false,
    dynamic: false,
    argsFromStdin: false,
    depth: ctx.depth,
  };
}

const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/** Options that take a value, per wrapper. */
const SUDO_VALUE_OPTS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout']);
const TIMEOUT_VALUE_OPTS = new Set(['-k', '-s', '--kill-after', '--signal']);
const NICE_VALUE_OPTS = new Set(['-n', '--adjustment']);
const XARGS_VALUE_OPTS = new Set(['-n', '-P', '-L', '-l', '-s', '-d', '-a', '-E', '-I', '-i', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--arg-file', '--eof', '--replace', '--process-slot-var']);
const ENV_VALUE_OPTS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '--default-signal', '--ignore-signal', '--block-signal']);
const TIME_VALUE_OPTS = new Set(['-o', '-f', '--output', '--format']);
const STDBUF_VALUE_OPTS = new Set(['-i', '-o', '-e', '--input', '--output', '--error']);
const IONICE_VALUE_OPTS = new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid']);
const STRACE_VALUE_OPTS = new Set(['-o', '-e', '-s', '-p', '-E', '-u', '-P', '-a', '-O', '-S', '-I', '-X']);
const TASKSET_VALUE_OPTS = new Set(['-c', '--cpu-list', '-p']);
const CHRT_VALUE_OPTS = new Set(['-p']);
const WATCH_VALUE_OPTS = new Set(['-n', '--interval', '-d', '--differences']);
const FLOCK_VALUE_OPTS = new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code', '-c', '--command']);
const SSH_VALUE_OPTS = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w']);
const KUBECTL_VALUE_OPTS = new Set(['-n', '--namespace', '-c', '--container', '--context', '--kubeconfig', '-f', '--filename', '--pod-running-timeout', '--cluster', '--user', '-s', '--server', '--token', '--as', '--as-group', '--request-timeout', '--cache-dir', '--certificate-authority', '--client-certificate', '--client-key', '--tls-server-name', '-v', '--v', '--image', '--restart', '--overrides', '--pod', '--env', '--labels', '-l', '--port', '--limits', '--requests', '--serviceaccount', '--annotations']);
const NPX_VALUE_OPTS = new Set(['-p', '--package', '-c', '--call', '--shell', '-n', '--node-arg', '--node-options', '--loglevel', '--cache', '--userconfig', '--registry', '--workspace', '-w']);
const DOCKER_GLOBAL_VALUE_OPTS = new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);
const DOCKER_FLAG_OPTS = new Set([
  '-i', '-t', '-d', '-it', '-ti', '-dit', '-itd', '-id', '-di', '-td', '-dt', '--interactive', '--tty', '--detach', '--privileged', '--rm', '--init', '--no-healthcheck', '--read-only', '-P', '--publish-all', '--sig-proxy', '--oom-kill-disable', '-q', '--quiet', '--help', '--no-deps', '--service-ports', '--use-aliases', '--build', '--no-build', '--pull', '--force-recreate', '-T', '--no-TTY', '--wait', '--remove-orphans',
]);
const DOCKER_VALUE_OPTS = new Set([
  '-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys', '-v', '--volume', '--mount', '-p', '--publish', '--name', '--network', '--net', '--entrypoint', '-h', '--hostname', '-l', '--label', '--label-file', '-m', '--memory', '--memory-swap', '--memory-reservation', '--cpus', '--cpu-shares', '--cpuset-cpus', '--restart', '--platform', '--add-host', '--dns', '--dns-search', '--dns-option', '--log-driver', '--log-opt', '--health-cmd', '--health-interval', '--health-retries', '--health-timeout', '--health-start-period', '--cap-add', '--cap-drop', '--device', '--expose', '--ip', '--ip6', '--link', '--security-opt', '--shm-size', '--stop-signal', '--stop-timeout', '--sysctl', '--tmpfs', '--ulimit', '--userns', '--uts', '--pid', '--ipc', '--cgroup-parent', '--cidfile', '--domainname', '--gpus', '--group-add', '--isolation', '--kernel-memory', '--mac-address', '--oom-score-adj', '--pids-limit', '--runtime', '--storage-opt', '--volume-driver', '--volumes-from', '--annotation', '--blkio-weight', '--cgroupns', '--device-cgroup-rule', '--device-read-bps', '--device-write-bps', '--network-alias', '--index', '--project-name', '--project-directory', '--file', '-f', '--profile', '--env-file', '--ansi', '--parallel', '--progress',
]);
const SU_VALUE_OPTS = new Set(['-c', '--command', '-s', '--shell', '-g', '--group', '-G', '--supp-group', '-u', '--user']);
const SCRIPT_VALUE_OPTS = new Set(['-c', '--command', '-E', '--echo', '-o', '--output-limit', '-T', '--log-timing', '-I', '--log-in', '-O', '--log-out', '-B', '--log-io', '-m', '--logging-format']);
const NODE_VALUE_OPTS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '-C', '--conditions', '--env-file', '--env-file-if-exists', '--title', '--stack-size', '--max-old-space-size', '--icu-data-dir', '--openssl-config', '--report-dir', '--report-directory', '--report-filename', '--report-signal', '--secure-heap', '--heapsnapshot-signal', '--inspect-port', '--diagnostic-dir', '--redirect-warnings', '--tls-cipher-list', '--tls-keylog', '--unhandled-rejections', '--watch-path', '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-concurrency', '--experimental-default-type', '--disable-warning', '-i', '--interactive']);
const PY_VALUE_OPTS = new Set(['-m', '-W', '-X', '-Q', '--check-hash-based-pycs']);
const UV_VALUE_OPTS = new Set(['--with', '--with-requirements', '--with-editable', '-p', '--python', '--extra', '--group', '--env-file', '--project', '--directory', '--package', '--index', '--default-index', '--find-links', '--config-file', '--cache-dir', '--isolated', '--exclude-newer', '--only-group', '--no-group', '--all-extras', '--locked', '--frozen', '--no-sync', '--active', '--module', '--script', '--gui-script', '--color', '--verbose', '--quiet', '--native-tls', '--offline']);

/** A command-substitution body that only reads an env file: `cat .env`, `grep -v '^#' .env | xargs`. */
const DOTENV_BODY_RE = /^\s*(cat|grep|egrep|sed|awk|cut|tr|sort|xargs|dotenv|envsubst|<)\b[^;&$`]*(^|[\s/'"])\.env(\.[\w.-]+)?(?=[\s'"|)]|$)[^;&$`]*$/;

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'yash', 'tcsh', 'csh', 'rbash']);
const POWERSHELLS = new Set(['pwsh', 'powershell', 'pwsh-preview']);
const INTERP_NODE = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node', 'ts-node-esm', 'babel-node']);
const INTERP_PY = new Set(['python', 'python2', 'python3', 'py', 'pypy', 'pypy3', 'ipython', 'python3.8', 'python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13', 'python3.14']);

function splitShort(flag: string): string[] {
  // "-euc" -> ["-e","-u","-c"]
  if (!/^-[A-Za-z]{2,}$/.test(flag)) return [flag];
  return flag.slice(1).split('').map((c) => '-' + c);
}

/** Parse a command string into segments. */
export function parseCommand(cmd: string, opts: ParseOptions = {}): ParsedCommand {
  const dialect = opts.dialect ?? 'posix';
  const depth = opts.depth ?? 0;
  const via = opts.via ?? [];
  const parsed: ParsedCommand = { raw: cmd, dialect, segments: [], opaque: false, hiddenUnicode: hasHiddenUnicode(cmd), depth };
  if (depth > MAX_DEPTH) {
    const seg = emptySegment(cmd, { dialect, depth, via });
    seg.opaque = true;
    seg.opaqueReason = 'nesting too deep';
    parsed.segments.push(seg);
    parsed.opaque = true;
    return parsed;
  }
  let toks: RawTok[];
  try {
    toks = tokenize(cmd, dialect);
  } catch {
    const seg = emptySegment(cmd, { dialect, depth, via });
    seg.opaque = true;
    seg.opaqueReason = 'tokenizer error';
    parsed.segments.push(seg);
    parsed.opaque = true;
    return parsed;
  }
  const ctx: SegCtx = { dialect, depth, via, parentProg: opts.parentProg };
  parsed.segments = segmentsFromTokens(toks, ctx);
  parsed.opaque = parsed.segments.some((s) => segmentOpaque(s));
  return parsed;
}

function segmentOpaque(s: Segment): boolean {
  if (s.opaque) return true;
  if (s.inner && s.inner.opaque) return true;
  if (s.subshells.some((p) => p.opaque)) return true;
  return false;
}

function segmentsFromTokens(toks: RawTok[], ctx: SegCtx): Segment[] {
  const out: Segment[] = [];
  let cur: RawTok[] = [];
  let pipeline = 0;
  let prevOp = '';
  const flush = (nextOp: string) => {
    if (cur.length) {
      const seg = buildSegment(cur, ctx, prevOp === '|' || prevOp === '|&');
      seg.pipeline = pipeline;
      seg.pipesTo = nextOp === '|' || nextOp === '|&';
      out.push(seg);
    }
    cur = [];
    if (nextOp !== '|' && nextOp !== '|&') pipeline++;
    prevOp = nextOp;
  };
  for (const t of toks) {
    if (t.kind === 'op') {
      if (t.text === '(' || t.text === ')') {
        flush(';');
        continue;
      }
      flush(t.text);
      continue;
    }
    if (t.kind === 'nl') {
      flush('\n');
      continue;
    }
    // stand-alone braces are grouping, not words
    if (t.kind === 'word' && !t.quoted && (t.text === '{' || t.text === '}')) {
      if (t.text === '}') flush(';');
      continue;
    }
    cur.push(t);
  }
  flush('');
  return out;
}

function rawOf(toks: RawTok[]): string {
  return toks.map((t) => t.raw).join(' ');
}

/** Build a segment from word/redirect tokens (no operators). */
function buildSegment(toks: RawTok[], ctx: SegCtx, stdinFromPipe = false): Segment {
  const seg = emptySegment(rawOf(toks), ctx);
  seg.stdinFromPipe = stdinFromPipe;
  const words: RawTok[] = [];
  for (const t of toks) {
    if (t.kind === 'redir') {
      const target = (t as RawTok & { target?: RawTok }).target;
      const r: Redirect = { op: t.text, fd: t.fd, target: target ? target.text : '', dynamic: !!target?.dynamic };
      if (t.heredoc !== undefined) {
        r.heredoc = t.heredoc;
        seg.heredoc = (seg.heredoc ?? '') + t.heredoc;
      }
      if (r.dynamic) seg.dynamic = true;
      seg.redirects.push(r);
      continue;
    }
    words.push(t);
  }
  for (const w of words) if (w.dynamic) seg.dynamic = true;
  applyWords(seg, words, ctx);
  // Command substitutions are parsed after the program is known so their segments can see it.
  const bodies: string[] = [];
  for (const t of toks) {
    if (t.kind === 'redir') {
      const target = (t as RawTok & { target?: RawTok }).target;
      if (target) bodies.push(...target.subshells);
    } else bodies.push(...t.subshells);
  }
  for (const b of bodies) {
    // Already parsed as (part of) the inner command: script blocks, bash -c "x $(y)".
    if (seg.inner && (seg.inner.raw === b || seg.inner.raw.includes('$(' + b + ')') || seg.inner.raw.includes('`' + b + '`'))) continue;
    const parentProg = seg.envLoadBodies?.includes(b) ? 'env' : seg.prog || seg.wrappers[0] || '';
    seg.subshells.push(parseCommand(b, { dialect: ctx.dialect, depth: ctx.depth + 1, via: ctx.via, parentProg }));
  }
  return seg;
}

/** Consume leading VAR=value words into seg.env. */
function takeEnvAssignments(seg: Segment, words: RawTok[]): RawTok[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const m = ENV_ASSIGN_RE.exec(w.text);
    // Only an unquoted name= prefix is an assignment ("A=b" fully quoted is a word).
    if (m && !w.raw.startsWith('"') && !w.raw.startsWith("'")) {
      seg.env[m[1]] = m[2];
      if (w.dynamic) seg.envDynamic.push(m[1]);
      i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

/**
 * Core of the parser: strips wrappers from the front of `words`, sets the
 * program and arguments, and recurses into shell-in-shell wrappers.
 */
function applyWords(seg: Segment, wordsIn: RawTok[], ctx: SegCtx): void {
  let words = wordsIn;
  let guard = 0;
  for (;;) {
    if (guard++ > 32) {
      seg.opaque = true;
      seg.opaqueReason = 'too many wrappers';
      return;
    }
    words = takeEnvAssignments(seg, words);
    if (!words.length) {
      seg.prog = '';
      return;
    }
    const first = words[0];
    if (ctx.dialect === 'powershell' && first.text.startsWith('{') && first.subshells.length) {
      // `& { ... }` / `{ ... }` script block run directly: inspect the block.
      seg.prog = 'scriptblock';
      seg.progRaw = first.raw;
      seg.args = words.slice(1).map((w) => w.text);
      seg.argTokens = words.slice(1).map(tokenToPublic);
      setInner(seg, first.subshells[0], 'scriptblock', ctx, 'powershell');
      return;
    }
    if (ctx.dialect === 'powershell') {
      const t = first.text;
      // `$name = <command>`: the right-hand side is what runs ($x = git push -f).
      if (/^\$(env:|script:|global:|local:)?[A-Za-z_][A-Za-z0-9_]*$/.test(t) && words[1] && /^(=|\+=|-=|\*=|\/=|%=|\?\?=)$/.test(words[1].text) && !words[1].quoted) {
        seg.wrappers.push('assignment');
        words = words.slice(2);
        if (!words.length) {
          seg.prog = '';
          return;
        }
        continue;
      }
      // Expression statements run no program by name: a member access on a variable
      // ($c.Open()), a type expression ([IO.File]::WriteAllText(...)), a literal or a
      // hashtable. The text-based rails (writes, secrets, SQL client code) still scan them;
      // Process.Start and script-block creation run programs, so they stay opaque.
      const expression = /^\$[A-Za-z_][A-Za-z0-9_:]*[.[]/.test(t) || t.startsWith('[') || t.startsWith('@(') || t.startsWith('@{') || /^-?\d/.test(t) || (!!first.quoteChars && !first.dynamic && words.length === 1);
      if (expression) {
        seg.prog = '';
        seg.progRaw = first.raw;
        seg.args = words.slice(1).map((w) => w.text);
        seg.argTokens = words.slice(1).map(tokenToPublic);
        if (/\[(System\.)?Diagnostics\.Process\]\s*::\s*Start|\.Start\s*\(|\[(System\.)?Management\.Automation\.PowerShell\]::Create|\.Invoke\s*\(|\[ScriptBlock\]::Create|\.AddScript\s*\(|\.AddCommand\s*\(/i.test(words.map((w) => w.text).join(' '))) {
          seg.opaque = true;
          seg.opaqueReason = 'program name is computed at run time';
          seg.dynamicProg = true;
        }
        return;
      }
    }
    if (first.dynamic && (first.subshells.length || /^[$%!`]/.test(first.text) || /\$\(|`|\$\{|\$[A-Za-z_]/.test(first.text))) {
      // Program computed at run time.
      seg.prog = '';
      seg.progRaw = first.raw;
      seg.dynamicProg = true;
      seg.opaque = true;
      seg.opaqueReason = 'program name is computed at run time';
      seg.args = words.slice(1).map((w) => w.text);
      seg.argTokens = words.slice(1).map(tokenToPublic);
      return;
    }
    const prog = normalizeProg(first.text);
    if (!prog) {
      seg.prog = '';
      seg.progRaw = first.raw;
      seg.opaque = true;
      seg.opaqueReason = 'unreadable program name';
      seg.args = words.slice(1).map((w) => w.text);
      seg.argTokens = words.slice(1).map(tokenToPublic);
      return;
    }
    let rest = words.slice(1);

    // --- plain wrappers ----------------------------------------------------
    const wrap = stripWrapper(prog, rest, seg, ctx);
    if (wrap) {
      seg.wrappers.push(wrap.name);
      if (wrap.innerString !== undefined) {
        setInner(seg, wrap.innerString, wrap.name, ctx, wrap.dialect ?? ctx.dialect, wrap.target);
        seg.prog = prog;
        seg.progRaw = first.raw;
        seg.args = rest.map((w) => w.text);
        seg.argTokens = rest.map(tokenToPublic);
        return;
      }
      if (wrap.opaque) {
        seg.prog = prog;
        seg.progRaw = first.raw;
        seg.args = rest.map((w) => w.text);
        seg.argTokens = rest.map(tokenToPublic);
        seg.opaque = true;
        seg.opaqueReason = wrap.opaque;
        return;
      }
      words = wrap.rest;
      if (wrap.via) seg.via = [...seg.via, wrap.via];
      continue;
    }

    // --- shells and interpreters -------------------------------------------
    seg.prog = prog;
    seg.progRaw = first.raw;
    seg.args = rest.map((w) => w.text);
    seg.argTokens = rest.map(tokenToPublic);
    if (/^git-[a-z][a-z-]*$/.test(prog)) {
      // old dashed form: git-push -> git push
      seg.prog = 'git';
      seg.args = [prog.slice(4), ...seg.args];
      seg.argTokens = [{ text: prog.slice(4), raw: prog, quoted: false, dynamic: false, subshells: [], tilde: false }, ...seg.argTokens];
    }
    if (SHELLS.has(prog)) {
      handleShell(seg, rest, ctx);
      return;
    }
    if (POWERSHELLS.has(prog)) {
      handlePowerShell(seg, rest, ctx);
      return;
    }
    if (prog === 'cmd') {
      handleCmd(seg, rest, ctx);
      return;
    }
    if (prog === 'eval') {
      const str = rest.map((w) => w.text).join(' ');
      if (rest.some((w) => w.dynamic && w.subshells.length === 0 && /^\$/.test(w.text))) {
        seg.opaque = true;
        seg.opaqueReason = 'eval of a variable';
      }
      setInner(seg, str, 'eval', ctx, ctx.dialect);
      return;
    }
    if (prog === 'invoke-expression' || prog === 'iex') {
      if (/^-c(ommand)?$/i.test(rest[0]?.text ?? '')) rest = rest.slice(1);
      if (!rest.length) {
        if (seg.stdinFromPipe || seg.heredoc !== undefined) {
          seg.opaque = true;
          seg.opaqueReason = 'Invoke-Expression reads from stdin';
        }
        return;
      }
      const str = rest.map((w) => w.text).join(' ');
      if (rest.some((w) => w.dynamic)) {
        seg.opaque = true;
        seg.opaqueReason = 'Invoke-Expression of a variable';
      }
      setInner(seg, str, 'Invoke-Expression', ctx, 'powershell');
      return;
    }
    if (INTERP_NODE.has(prog)) {
      handleInterpreter(seg, rest, ctx, 'js');
      return;
    }
    if (INTERP_PY.has(prog)) {
      handleInterpreter(seg, rest, ctx, 'py');
      return;
    }
    if (prog === 'perl' || prog === 'ruby' || prog === 'php' || prog === 'rscript' || prog === 'lua') {
      handleInterpreter(seg, rest, ctx, prog === 'perl' ? 'perl' : prog === 'ruby' ? 'ruby' : prog === 'php' ? 'php' : 'other');
      return;
    }
    if (prog === 'find') {
      handleFind(seg, rest, ctx);
      return;
    }
    if (prog === 'tmux') {
      handleTmux(seg, rest, ctx);
      return;
    }
    if (prog === 'start-process' || prog === 'saps' || prog === 'start') {
      handleStartProcess(seg, rest, ctx);
      return;
    }
    if (prog === 'invoke-command' || prog === 'icm' || prog === 'start-job' || prog === 'sajb') {
      handleInvokeCommand(seg, rest, ctx);
      return;
    }
    if (prog === 'ssh' || prog === 'slogin') {
      handleSsh(seg, rest, ctx);
      return;
    }
    if (prog === 'docker' || prog === 'podman' || prog === 'nerdctl' || prog === 'docker-compose' || prog === 'docker-compose-v1') {
      const r = handleDocker(seg, rest, ctx, prog);
      if (r === 'continue') {
        words = seg.argTokens.map((t) => ({ kind: 'word', text: t.text, raw: t.raw, quoted: t.quoted, dynamic: t.dynamic, subshells: t.subshells, tilde: t.tilde })) as RawTok[];
        seg.wrappers.push(prog === 'docker-compose' ? 'docker compose' : prog);
        continue;
      }
      return;
    }
    if (prog === 'kubectl' || prog === 'oc') {
      const r = handleKubectl(seg, rest, ctx, prog);
      if (r === 'continue') {
        words = seg.argTokens.map((t) => ({ kind: 'word', text: t.text, raw: t.raw, quoted: t.quoted, dynamic: t.dynamic, subshells: t.subshells, tilde: t.tilde })) as RawTok[];
        seg.wrappers.push(prog + ' exec');
        continue;
      }
      return;
    }
    return;
  }
}

interface WrapResult {
  name: string;
  rest: RawTok[];
  via?: ViaEntry;
  innerString?: string;
  dialect?: Dialect;
  target?: string;
  opaque?: string;
}

function skipOpts(rest: RawTok[], valueOpts: Set<string>, flagRe?: RegExp): { i: number; opts: RawTok[] } {
  let i = 0;
  const opts: RawTok[] = [];
  while (i < rest.length) {
    const t = rest[i].text;
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    opts.push(rest[i]);
    const eq = t.indexOf('=');
    const name = eq > 0 && t.startsWith('--') ? t.slice(0, eq) : t;
    if (valueOpts.has(name) && !(eq > 0 && t.startsWith('--'))) {
      // short option with attached value (-n5) does not consume
      if (/^-[A-Za-z]/.test(t) && t.length > 2 && !t.startsWith('--')) {
        i++;
        continue;
      }
      if (i + 1 < rest.length) opts.push(rest[i + 1]);
      i += 2;
      continue;
    }
    if (flagRe && !flagRe.test(t)) {
      // unknown option
    }
    i++;
  }
  return { i, opts };
}

/** Returns a WrapResult when `prog` is a plain wrapper (the real command follows). */
function stripWrapper(prog: string, rest: RawTok[], seg: Segment, ctx: SegCtx): WrapResult | null {
  switch (prog) {
    case 'sudo':
    case 'doas': {
      let i = 0;
      let shellString: RawTok | null = null;
      let shellMode = false;
      while (i < rest.length) {
        const t = rest[i].text;
        if (t === '--') {
          i++;
          break;
        }
        if (ENV_ASSIGN_RE.test(t) && !rest[i].quoted) {
          const m = ENV_ASSIGN_RE.exec(t)!;
          seg.env[m[1]] = m[2];
          i++;
          continue;
        }
        if (!t.startsWith('-')) break;
        if (SUDO_VALUE_OPTS.has(t)) {
          i += 2;
          continue;
        }
        if (t === '-s' || t === '--shell' || t === '-i' || t === '--login') shellMode = true;
        i++;
      }
      const after = rest.slice(i);
      if (shellMode && after.length) {
        // sudo -s "string" runs through the shell
        shellString = after[0];
        return { name: prog, rest: [], innerString: after.map((w) => w.text).join(' '), dialect: 'posix', target: undefined, ...(shellString ? {} : {}) };
      }
      return { name: prog, rest: after };
    }
    case 'timeout': {
      const { i } = skipOpts(rest, TIMEOUT_VALUE_OPTS);
      // duration positional
      const after = rest.slice(i);
      if (!after.length) return { name: prog, rest: [] };
      return { name: prog, rest: after.slice(1) };
    }
    case 'nice': {
      let i = 0;
      while (i < rest.length && rest[i].text.startsWith('-')) {
        const t = rest[i].text;
        if (NICE_VALUE_OPTS.has(t)) i += 2;
        else i++;
      }
      return { name: prog, rest: rest.slice(i) };
    }
    case 'nohup':
    case 'exec':
    case 'builtin':
    case 'nocorrect':
    case 'noglob':
    case 'chronic':
    case 'setsid':
    case 'unbuffer':
    case 'daemonize':
    case 'caffeinate': {
      let i = 0;
      while (i < rest.length && rest[i].text.startsWith('-') && rest[i].text !== '--') {
        const t = rest[i].text;
        if (prog === 'caffeinate' && (t === '-t' || t === '-w')) i += 2;
        else if (prog === 'exec' && t === '-a') i += 2;
        else i++;
      }
      if (i < rest.length && rest[i].text === '--') i++;
      if (prog === 'exec' && i < rest.length && /^-c$/.test(rest[i - 1]?.text ?? '')) {
        /* exec -c clears env */
      }
      return { name: prog, rest: rest.slice(i) };
    }
    case 'command': {
      let i = 0;
      while (i < rest.length && rest[i].text.startsWith('-')) {
        if (rest[i].text === '-v' || rest[i].text === '-V') return null; // lookup, not execution
        i++;
      }
      return { name: prog, rest: rest.slice(i) };
    }
    case 'time': {
      const { i } = skipOpts(rest, TIME_VALUE_OPTS);
      return { name: prog, rest: rest.slice(i) };
    }
    case 'stdbuf': {
      const { i } = skipOpts(rest, STDBUF_VALUE_OPTS);
      return { name: prog, rest: rest.slice(i) };
    }
    case 'ionice': {
      const { i } = skipOpts(rest, IONICE_VALUE_OPTS);
      return { name: prog, rest: rest.slice(i) };
    }
    case 'strace':
    case 'ltrace': {
      const { i } = skipOpts(rest, STRACE_VALUE_OPTS);
      return { name: prog, rest: rest.slice(i) };
    }
    case 'taskset': {
      const { i } = skipOpts(rest, TASKSET_VALUE_OPTS);
      const after = rest.slice(i);
      // taskset MASK cmd (when no -c given) : first positional is the mask
      if (after.length && !rest.slice(0, i).some((t) => t.text === '-c' || t.text === '--cpu-list')) return { name: prog, rest: after.slice(1) };
      return { name: prog, rest: after };
    }
    case 'chrt': {
      const { i } = skipOpts(rest, CHRT_VALUE_OPTS);
      const after = rest.slice(i);
      return { name: prog, rest: after.length ? after.slice(1) : after };
    }
    case 'chroot': {
      const { i } = skipOpts(rest, new Set(['--userspec', '--groups']));
      const after = rest.slice(i);
      return { name: prog, rest: after.slice(1) };
    }
    case 'unshare':
    case 'nsenter':
    case 'firejail':
    case 'bwrap': {
      const { i } = skipOpts(rest, new Set(['-t', '--target', '-w', '--wd', '-S', '--setuid', '-G', '--setgid', '--bind', '--ro-bind', '--dev-bind', '--symlink', '--chdir', '--profile', '--name', '--netns', '--private', '--whitelist', '--read-only', '--map-user', '--map-group', '--kill-child', '--mount-proc', '-r']));
      return { name: prog, rest: rest.slice(i) };
    }
    case 'busybox': {
      return { name: prog, rest };
    }
    case 'env': {
      let i = 0;
      while (i < rest.length) {
        const t = rest[i].text;
        if (t === '--') {
          i++;
          break;
        }
        if (t === '-S' || t === '--split-string' || t.startsWith('--split-string=')) {
          const str = t.includes('=') ? t.slice(t.indexOf('=') + 1) : rest[i + 1]?.text ?? '';
          const after = rest.slice(t.includes('=') ? i + 1 : i + 2).map((w) => w.text).join(' ');
          return { name: prog, rest: [], innerString: (str + ' ' + after).trim(), dialect: 'posix' };
        }
        if (t.startsWith('-') && t !== '-') {
          if (ENV_VALUE_OPTS.has(t)) i += 2;
          else i++;
          continue;
        }
        const m = ENV_ASSIGN_RE.exec(t);
        if (m && !rest[i].quoted) {
          seg.env[m[1]] = m[2];
          if (rest[i].dynamic) seg.envDynamic.push(m[1]);
          i++;
          continue;
        }
        // env $(cat .env) cmd / env $(grep -v '^#' .env | xargs) cmd: assignments loaded from an
        // env file. Any other substitution here could be the program name, so it stays opaque.
        if (rest[i].dynamic && rest[i].subshells.length && rest[i].subshells.every((b) => DOTENV_BODY_RE.test(b))) {
          seg.envLoadBodies = [...(seg.envLoadBodies ?? []), ...rest[i].subshells];
          i++;
          continue;
        }
        break;
      }
      return { name: prog, rest: rest.slice(i) };
    }
    case 'xargs': {
      let i = 0;
      while (i < rest.length) {
        const t = rest[i].text;
        if (t === '--') {
          i++;
          break;
        }
        if (!t.startsWith('-')) break;
        const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
        if (XARGS_VALUE_OPTS.has(name) && !t.includes('=') && !/^-[IiLlnPsdaE].+/.test(t)) i += 2;
        else i++;
      }
      seg.argsFromStdin = true;
      const after = rest.slice(i);
      if (!after.length) return { name: prog, rest: [{ kind: 'word', text: 'echo', raw: 'echo', quoted: false, dynamic: false, subshells: [], tilde: false }] };
      return { name: prog, rest: after };
    }
    case 'watch': {
      const { i } = skipOpts(rest, WATCH_VALUE_OPTS);
      const str = rest.slice(i).map((w) => w.text).join(' ');
      return { name: prog, rest: [], innerString: str, dialect: 'posix' };
    }
    case 'flock': {
      let i = 0;
      let cmdStr: string | null = null;
      while (i < rest.length) {
        const t = rest[i].text;
        if (!t.startsWith('-')) break;
        if (t === '-c' || t === '--command') {
          cmdStr = rest[i + 1]?.text ?? '';
          i += 2;
          continue;
        }
        if (FLOCK_VALUE_OPTS.has(t)) i += 2;
        else i++;
      }
      const after = rest.slice(i);
      if (cmdStr !== null) return { name: prog, rest: [], innerString: cmdStr, dialect: 'posix' };
      // flock FILE cmd...
      return { name: prog, rest: after.slice(1) };
    }
    case 'su':
    case 'runuser': {
      let i = 0;
      let cmdStr: string | null = null;
      while (i < rest.length) {
        const t = rest[i].text;
        if (t === '--') {
          i++;
          break;
        }
        if (t === '-c' || t === '--command' || t.startsWith('--command=')) {
          cmdStr = t.includes('=') ? t.slice(t.indexOf('=') + 1) : rest[i + 1]?.text ?? '';
          i += t.includes('=') ? 1 : 2;
          continue;
        }
        if (t === '-' || t === '-l' || t === '--login' || t === '-p' || t === '-m' || t === '--preserve-environment' || t === '-f') {
          i++;
          continue;
        }
        if (t.startsWith('-')) {
          if (SU_VALUE_OPTS.has(t)) i += 2;
          else i++;
          continue;
        }
        // user name
        i++;
      }
      if (cmdStr !== null) return { name: prog, rest: [], innerString: cmdStr, dialect: 'posix' };
      const after = rest.slice(i);
      if (after.length) return { name: prog, rest: after };
      return { name: prog, rest: [] };
    }
    case 'script': {
      let i = 0;
      while (i < rest.length && rest[i].text.startsWith('-')) {
        const t = rest[i].text;
        const parts = t.startsWith('--') ? [t] : splitShort(t);
        if (parts.includes('-c') || t === '--command') return { name: prog, rest: [], innerString: rest[i + 1]?.text ?? '', dialect: 'posix' };
        if (t.startsWith('--command=')) return { name: prog, rest: [], innerString: t.slice(10), dialect: 'posix' };
        if (SCRIPT_VALUE_OPTS.has(t) || parts.some((x) => SCRIPT_VALUE_OPTS.has(x))) i += 2;
        else i++;
      }
      return null; // plain `script file` records a session; not a wrapper
    }
    case 'nix-shell': {
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i].text;
        if (t === '--run' || t === '--command') return { name: prog, rest: [], innerString: rest[i + 1]?.text ?? '', dialect: 'posix' };
      }
      return null;
    }
    case 'nix': {
      // nix develop -c cmd... / nix shell ... -c cmd... / nix run
      const idx = rest.findIndex((t) => t.text === '-c' || t.text === '--command');
      if (idx >= 0) return { name: 'nix ' + (rest[0]?.text ?? ''), rest: rest.slice(idx + 1) };
      return null;
    }
    case 'npx':
    case 'pnpx':
    case 'bunx': {
      let i = 0;
      while (i < rest.length) {
        const t = rest[i].text;
        if (t === '--') {
          i++;
          break;
        }
        if (!t.startsWith('-')) break;
        if (t === '-c' || t === '--call') return { name: prog, rest: [], innerString: rest[i + 1]?.text ?? '', dialect: 'posix' };
        if (t.startsWith('--call=')) return { name: prog, rest: [], innerString: t.slice(7), dialect: 'posix' };
        const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
        if (NPX_VALUE_OPTS.has(name) && !t.includes('=')) i += 2;
        else i++;
      }
      const after = rest.slice(i);
      if (!after.length) return { name: prog, rest: [] };
      const pkg = packageToProg(after[0].text);
      return { name: prog, rest: [{ ...after[0], text: pkg, raw: after[0].raw }, ...after.slice(1)] };
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const sub = rest[0]?.text;
      if (!sub) return null;
      if ((prog === 'npm' && (sub === 'exec' || sub === 'x')) || (prog === 'pnpm' && (sub === 'exec' || sub === 'dlx')) || (prog === 'yarn' && (sub === 'exec' || sub === 'dlx')) || (prog === 'bun' && sub === 'x')) {
        let i = 1;
        while (i < rest.length) {
          const t = rest[i].text;
          if (t === '--') {
            i++;
            break;
          }
          if (!t.startsWith('-')) break;
          if (t === '-c' || t === '--call') return { name: `${prog} ${sub}`, rest: [], innerString: rest[i + 1]?.text ?? '', dialect: 'posix' };
          if (t.startsWith('--call=')) return { name: `${prog} ${sub}`, rest: [], innerString: t.slice(7), dialect: 'posix' };
          const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
          if (NPX_VALUE_OPTS.has(name) && !t.includes('=')) i += 2;
          else i++;
        }
        const after = rest.slice(i);
        if (!after.length) return { name: `${prog} ${sub}`, rest: [] };
        const pkg = packageToProg(after[0].text);
        return { name: `${prog} ${sub}`, rest: [{ ...after[0], text: pkg }, ...after.slice(1)] };
      }
      return null;
    }
    case 'uv': {
      if (rest[0]?.text === 'run' || rest[0]?.text === 'tool' ) {
        const start = rest[0].text === 'tool' ? 2 : 1;
        const { i } = skipOpts(rest.slice(start), UV_VALUE_OPTS);
        return { name: 'uv run', rest: rest.slice(start + i) };
      }
      return null;
    }
    case 'uvx':
    case 'pipx': {
      const start = prog === 'pipx' ? (rest[0]?.text === 'run' ? 1 : -1) : 0;
      if (start < 0) return null;
      const { i } = skipOpts(rest.slice(start), new Set(['--python', '-p', '--spec', '--with', '--from', '--index-url', '--pip-args']));
      return { name: prog, rest: rest.slice(start + i) };
    }
    case 'poetry':
    case 'pipenv':
    case 'hatch':
    case 'pdm': {
      if (rest[0]?.text === 'run') {
        const { i } = skipOpts(rest.slice(1), new Set(['-s', '--script', '-e', '--env']));
        return { name: `${prog} run`, rest: rest.slice(1 + i) };
      }
      return null;
    }
    case 'conda':
    case 'mamba':
    case 'micromamba': {
      if (rest[0]?.text === 'run') {
        const { i } = skipOpts(rest.slice(1), new Set(['-n', '--name', '-p', '--prefix', '--cwd']));
        return { name: `${prog} run`, rest: rest.slice(1 + i) };
      }
      return null;
    }
    case 'dotenv':
    case 'dotenvx': {
      // dotenv -e .env -- cmd ; dotenvx run -- cmd
      const idx = rest.findIndex((t) => t.text === '--');
      if (idx >= 0) return { name: prog, rest: rest.slice(idx + 1) };
      return null;
    }
    case 'cross-env':
    case 'env-cmd': {
      let i = 0;
      while (i < rest.length) {
        const t = rest[i].text;
        const m = ENV_ASSIGN_RE.exec(t);
        if (m && !rest[i].quoted) {
          seg.env[m[1]] = m[2];
          i++;
          continue;
        }
        if (t.startsWith('-')) {
          if (t === '-f' || t === '--file' || t === '-e' || t === '--environments') i += 2;
          else i++;
          continue;
        }
        break;
      }
      return { name: prog, rest: rest.slice(i) };
    }
    case 'screen': {
      const { i } = skipOpts(rest, new Set(['-S', '-s', '-c', '-e', '-h', '-p', '-t', '-T', '-d', '-r', '-R', '-x', '-X']));
      // screen -dm cmd...; screen -S name cmd...
      return { name: prog, rest: rest.slice(i) };
    }
    case 'call': {
      if (ctx.dialect === 'cmd') return { name: prog, rest };
      return null;
    }
    case 'cmd' :
      return null;
    default:
      return null;
  }
}

/** "@scope/name@1.2.3" -> "name"; known agent packages map to their CLI names. */
export function packageToProg(spec: string): string {
  let s = spec.trim();
  const known: Record<string, string> = {
    '@anthropic-ai/claude-code': 'claude',
    '@openai/codex': 'codex',
    '@cognition/devin': 'devin',
    '@cognition-ai/devin': 'devin',
    'claude-code': 'claude',
    // This package's own name, so `npx agent-harness <admin cmd>` resolves to the harness CLI.
    'agent-harness': 'harness',
  };
  const noVer = s.startsWith('@') ? s.replace(/(@[^@/]+\/[^@]+)@.*$/, '$1') : s.replace(/@.*$/, '');
  if (known[noVer]) return known[noVer];
  s = noVer;
  if (s.startsWith('@')) s = s.slice(s.indexOf('/') + 1);
  return normalizeProg(s) || s.toLowerCase();
}

function setInner(seg: Segment, str: string, kind: string, ctx: SegCtx, dialect: Dialect, target?: string): void {
  const via: ViaEntry[] = [...seg.via, { kind, target }];
  seg.via = via;
  seg.inner = parseCommand(str, { dialect, depth: ctx.depth + 1, via });
}

function handleShell(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  let i = 0;
  let cIdx = -1;
  let readStdin = false;
  const valueOpts = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
  while (i < rest.length) {
    const t = rest[i].text;
    if (t === '--') {
      i++;
      break;
    }
    if (t === '-s') {
      readStdin = true;
      i++;
      continue;
    }
    if (valueOpts.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith('--')) {
      i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) {
      const parts = splitShort(t);
      if (parts.includes('-c')) {
        cIdx = i + 1;
        i++;
        break;
      }
      if (parts.includes('-s')) readStdin = true;
      // -o/-O at the end of a cluster take the option name as the next word (-euo pipefail)
      if (parts[parts.length - 1] === '-o' || parts[parts.length - 1] === '-O') i += 2;
      else i++;
      continue;
    }
    if (t.startsWith('+')) {
      if (t === '+o' || t === '+O') i += 2;
      else i++;
      continue;
    }
    break;
  }
  const name = seg.prog + ' -c';
  if (cIdx >= 0) {
    const tok = rest[cIdx];
    if (!tok) {
      seg.opaque = true;
      seg.opaqueReason = 'shell -c without a command string';
      return;
    }
    setInner(seg, tok.text, name, ctx, seg.prog === 'fish' ? 'posix' : 'posix');
    return;
  }
  const after = rest.slice(i);
  if (after.length && after[0].text !== '-') {
    // bash script.sh args: running a file; not opaque, no inner
    return;
  }
  if (seg.heredoc !== undefined) {
    setInner(seg, seg.heredoc, seg.prog + ' <<heredoc', ctx, 'posix');
    return;
  }
  if (readStdin || seg.stdinFromPipe || after.length) {
    seg.opaque = true;
    seg.opaqueReason = 'shell reads its script from stdin';
    return;
  }
  // bare interactive shell: nothing to inspect
}

const PS_FLAG_TABLE: Array<[string, 'command' | 'encoded' | 'file' | 'value' | 'flag' | 'stdin']> = [
  ['command', 'command'],
  ['c', 'command'],
  ['encodedcommand', 'encoded'],
  ['e', 'encoded'],
  ['ec', 'encoded'],
  ['enc', 'encoded'],
  ['file', 'file'],
  ['f', 'file'],
  ['executionpolicy', 'value'],
  ['ep', 'value'],
  ['ex', 'value'],
  ['windowstyle', 'value'],
  ['w', 'value'],
  ['version', 'value'],
  ['v', 'value'],
  ['inputformat', 'value'],
  ['inp', 'value'],
  ['if', 'value'],
  ['outputformat', 'value'],
  ['o', 'value'],
  ['of', 'value'],
  ['configurationname', 'value'],
  ['config', 'value'],
  ['workingdirectory', 'value'],
  ['wd', 'value'],
  ['settingsfile', 'value'],
  ['custompipename', 'value'],
  ['encodedarguments', 'value'],
  ['ea', 'value'],
  ['encodeda', 'value'],
  ['psconsolefile', 'value'],
  ['noprofile', 'flag'],
  ['nop', 'flag'],
  ['noninteractive', 'flag'],
  ['noni', 'flag'],
  ['nologo', 'flag'],
  ['noexit', 'flag'],
  ['noe', 'flag'],
  ['sta', 'flag'],
  ['mta', 'flag'],
  ['login', 'flag'],
  ['l', 'flag'],
  ['sshservermode', 'flag'],
  ['interactive', 'flag'],
  ['i', 'flag'],
  ['help', 'flag'],
  ['h', 'flag'],
  ['?', 'flag'],
  ['noprofileloadtime', 'flag'],
];

function psFlagKind(flag: string): 'command' | 'encoded' | 'file' | 'value' | 'flag' | 'stdin' | null {
  const name = flag.replace(/^[-/]+/, '').toLowerCase();
  if (!name) return null;
  for (const [full, kind] of PS_FLAG_TABLE) if (full === name) return kind;
  // prefix match against long names (PowerShell accepts unambiguous prefixes)
  const matches = PS_FLAG_TABLE.filter(([full]) => full.length > 2 && full.startsWith(name));
  const kinds = new Set(matches.map(([, k]) => k));
  if (kinds.size === 1) return matches[0][1];
  if (name.startsWith('c')) return 'command';
  if (name.startsWith('e')) return 'encoded';
  return 'flag';
}

export function decodeEncodedCommand(b64: string): string | null {
  try {
    const clean = b64.replace(/\s+/g, '');
    // Strict base64: the right alphabet, a length that is a multiple of 4, and UTF-16LE text.
    if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
    const buf = Buffer.from(clean, 'base64');
    if (!buf.length || buf.length % 2 !== 0) return null;
    const text = buf.toString('utf16le');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function handlePowerShell(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  let i = 0;
  while (i < rest.length) {
    const t = rest[i].text;
    if (!/^[-/]/.test(t) || t === '-' ) break;
    const kind = psFlagKind(t);
    if (kind === 'command') {
      const after = rest.slice(i + 1);
      if (!after.length) {
        seg.opaque = true;
        seg.opaqueReason = '-Command without a command string';
        return;
      }
      if (after[0].text === '-') {
        if (seg.heredoc !== undefined) {
          setInner(seg, seg.heredoc, 'pwsh -Command', ctx, 'powershell');
          return;
        }
        seg.opaque = true;
        seg.opaqueReason = 'PowerShell reads its command from stdin';
        return;
      }
      // -Command takes the remainder of the line, joined with spaces.
      const str = after.map(windowsWordText).join(' ');
      setInner(seg, str, 'pwsh -Command', ctx, 'powershell');
      return;
    }
    if (kind === 'encoded') {
      const b64 = rest[i + 1]?.text ?? '';
      const decoded = decodeEncodedCommand(b64);
      if (decoded === null || /[\u0000-\u0008]/.test(decoded)) {
        seg.opaque = true;
        seg.opaqueReason = 'undecodable -EncodedCommand';
        return;
      }
      setInner(seg, decoded, 'pwsh -EncodedCommand', ctx, 'powershell');
      return;
    }
    if (kind === 'file') {
      // running a script file; nothing to inspect inside
      return;
    }
    if (kind === 'value') {
      i += 2;
      continue;
    }
    i++;
  }
  const after = rest.slice(i);
  if (!after.length) {
    if (seg.heredoc !== undefined) setInner(seg, seg.heredoc, 'pwsh <<heredoc', ctx, 'powershell');
    else if (seg.stdinFromPipe) {
      seg.opaque = true;
      seg.opaqueReason = 'PowerShell reads its command from stdin';
    }
    return;
  }
  if (after[0].text === '-') {
    if (seg.heredoc !== undefined) setInner(seg, seg.heredoc, 'pwsh -Command', ctx, 'powershell');
    else {
      seg.opaque = true;
      seg.opaqueReason = 'PowerShell reads its command from stdin';
    }
    return;
  }
  // A bare argument is a script file on pwsh and a command on powershell.exe; inspect it as a command.
  setInner(seg, after.map(windowsWordText).join(' '), 'pwsh -Command', ctx, 'powershell');
}

/**
 * Text of a word handed to a Windows shell: unquoted words keep their
 * backslashes (cmd and PowerShell do not treat \ as an escape), quoted words
 * use the dequoted text.
 */
function windowsWordText(w: RawTok): string {
  return w.quoteChars ? w.text : w.raw;
}

function handleCmd(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  let i = 0;
  while (i < rest.length) {
    const t = rest[i].text.toLowerCase();
    if (t === '/c' || t === '/k' || t === '-c' || t === '/r') {
      const after = rest.slice(i + 1);
      const str = after.map(windowsWordText).join(' ');
      setInner(seg, str, 'cmd /c', ctx, 'cmd');
      return;
    }
    if (/^\/[dsqaux]$/.test(t) || /^\/[evt]:/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  if (seg.heredoc !== undefined || seg.stdinFromPipe) {
    seg.opaque = true;
    seg.opaqueReason = 'cmd reads its commands from stdin';
  }
}

function handleInterpreter(seg: Segment, rest: RawTok[], ctx: SegCtx, lang: Segment['innerLang']): void {
  let i = 0;
  const valueOpts = lang === 'js' ? NODE_VALUE_OPTS : lang === 'py' ? PY_VALUE_OPTS : new Set<string>();
  while (i < rest.length) {
    const t = rest[i].text;
    if (t === '--') {
      i++;
      break;
    }
    if (t === '-') {
      // code from stdin
      if (seg.heredoc !== undefined) {
        seg.innerCode = seg.heredoc;
        seg.innerLang = lang;
      } else if (seg.stdinFromPipe) {
        seg.opaque = true;
        seg.opaqueReason = 'interpreter reads code from stdin';
      }
      return;
    }
    if (!t.startsWith('-')) break;
    // eval forms
    if (lang === 'js' && (t === '-e' || t === '--eval' || t === '-p' || t === '--print' || t === 'eval')) {
      seg.innerCode = rest[i + 1]?.text ?? '';
      seg.innerLang = lang;
      if (rest[i + 1]?.dynamic && !rest[i + 1]?.subshells.length && /^\$/.test(rest[i + 1].text)) {
        seg.opaque = true;
        seg.opaqueReason = 'code string is a variable';
      }
      return;
    }
    if (lang === 'js' && (t.startsWith('--eval=') || t.startsWith('--print='))) {
      seg.innerCode = t.slice(t.indexOf('=') + 1);
      seg.innerLang = lang;
      return;
    }
    if (lang === 'py') {
      const parts = t.startsWith('--') ? [t] : splitShort(t);
      if (parts.includes('-c')) {
        // -c takes the next argument (or the rest of a combined flag like -c'code' is unusual; treat next)
        seg.innerCode = rest[i + 1]?.text ?? '';
        seg.innerLang = lang;
        if (rest[i + 1]?.dynamic && /^\$/.test(rest[i + 1].text)) {
          seg.opaque = true;
          seg.opaqueReason = 'code string is a variable';
        }
        return;
      }
      if (parts.includes('-m') && t === '-m') {
        const mod = rest[i + 1]?.text ?? '';
        seg.wrappers.push('python -m');
        seg.prog = normalizeProg(mod.replace(/_/g, '-')) || mod.toLowerCase();
        seg.args = rest.slice(i + 2).map((w) => w.text);
        seg.argTokens = rest.slice(i + 2).map(tokenToPublic);
        return;
      }
    }
    if ((lang === 'perl' || lang === 'ruby' || lang === 'php' || lang === 'other') && (t === '-e' || t === '-E' || t === '-r' || (lang === 'perl' && /^-[a-zA-Z]*[eE]$/.test(t)))) {
      seg.innerCode = rest[i + 1]?.text ?? '';
      seg.innerLang = lang;
      return;
    }
    if (lang === 'js' && t === 'eval' ) {
      seg.innerCode = rest[i + 1]?.text ?? '';
      seg.innerLang = lang;
      return;
    }
    const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
    if (valueOpts.has(name) && !t.includes('=')) i += 2;
    else i++;
  }
  // deno eval / bun -e handled above; `deno eval "code"` positional
  if (lang === 'js' && seg.prog === 'deno' && rest[i]?.text === 'eval') {
    seg.innerCode = rest[i + 1]?.text ?? '';
    seg.innerLang = 'js';
    return;
  }
  if (!rest.slice(i).length) {
    if (seg.heredoc !== undefined) {
      seg.innerCode = seg.heredoc;
      seg.innerLang = lang;
    } else if (seg.stdinFromPipe) {
      seg.opaque = true;
      seg.opaqueReason = 'interpreter reads code from stdin';
    }
  }
  // interpreter script.ext args: running a file; nothing to inspect
}

function handleFind(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].text;
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      const inner: RawTok[] = [];
      let j = i + 1;
      while (j < rest.length && rest[j].text !== ';' && rest[j].text !== '+' && rest[j].text !== '\\;') {
        const w = rest[j];
        inner.push(w.text === '{}' ? { ...w, dynamic: true } : w);
        j++;
      }
      const innerStr = inner.map((w) => (/[\s"'$`\\]/.test(w.text) ? "'" + w.text.replace(/'/g, "'\\''") + "'" : w.text)).join(' ');
      const via: ViaEntry[] = [...seg.via, { kind: 'find -exec' }];
      seg.via = via;
      seg.inner = parseCommand(innerStr, { dialect: 'posix', depth: ctx.depth + 1, via });
      // {} placeholders are dynamic paths
      for (const s of seg.inner.segments) if (s.args.includes('{}')) s.dynamic = true;
      return;
    }
  }
}

function handleTmux(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  const sub = rest[0]?.text;
  if (!sub) return;
  const stringCmds = new Set(['send-keys', 'send', 'new-session', 'new', 'run-shell', 'run', 'split-window', 'splitw', 'new-window', 'neww', 'respawn-pane', 'respawn-window', 'if-shell', 'if', 'pipe-pane', 'pipep', 'display-popup', 'popup']);
  if (!stringCmds.has(sub)) return;
  const strs = rest.slice(1).filter((w) => !w.text.startsWith('-') && w.text !== 'Enter' && w.text !== 'C-m').map((w) => w.text);
  const combined = strs.join(' ');
  if (!combined.trim()) return;
  setInner(seg, combined, 'tmux ' + sub, ctx, 'posix');
}

function handleStartProcess(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  if (ctx.dialect === 'cmd' || seg.prog === 'start') {
    // cmd: start ["title"] [/b /wait /d dir /min /max /i] cmd args
    let i = 0;
    if (ctx.dialect !== 'cmd' && seg.prog === 'start' && ctx.dialect === 'posix') return;
    if (rest[i]?.raw.startsWith('"')) i++;
    while (i < rest.length && /^\//.test(rest[i].text)) {
      if (/^\/d$/i.test(rest[i].text)) i += 2;
      else i++;
    }
    const after = rest.slice(i);
    if (!after.length) return;
    const str = after.map((w) => w.text).join(' ');
    setInner(seg, str, 'start', ctx, 'cmd');
    return;
  }
  // PowerShell Start-Process [-FilePath] prog [-ArgumentList "args"]
  let file = '';
  let args = '';
  let i = 0;
  const positional: RawTok[] = [];
  // 'push','-f' is a PowerShell array literal: one token whose raw text holds the pieces.
  const arrayText = (w: RawTok | undefined): string => {
    if (!w) return '';
    if (/['"]\s*,\s*['"]/.test(w.raw)) return w.raw.split(/['"]\s*,\s*['"]/).map((x) => x.replace(/^['"]|['"]$/g, '')).join(' ');
    return w.text;
  };
  while (i < rest.length) {
    const t = rest[i].text;
    const lower = t.toLowerCase();
    if (/^-filepath/.test(lower) || /^-fi/.test(lower)) {
      file = t.includes(':') ? t.slice(t.indexOf(':') + 1) : rest[i + 1]?.text ?? '';
      i += t.includes(':') ? 1 : 2;
      continue;
    }
    if (/^-argumentlist/.test(lower) || /^-a/.test(lower) ) {
      args = t.includes(':') ? arrayText({ ...rest[i], raw: t.slice(t.indexOf(':') + 1), text: t.slice(t.indexOf(':') + 1) }) : arrayText(rest[i + 1]);
      i += t.includes(':') ? 1 : 2;
      continue;
    }
    if (t.startsWith('-')) {
      // -Wait, -NoNewWindow, -WorkingDirectory x, -Verb x, -WindowStyle x, -Credential x, -RedirectStandardOutput x
      if (/^-(workingdirectory|wd|verb|windowstyle|credential|redirectstandard(output|error|input)|environment|loaduserprofile)/.test(lower)) i += 2;
      else i++;
      continue;
    }
    positional.push(rest[i]);
    i++;
  }
  if (!file) file = positional[0]?.text ?? '';
  if (!args && positional.length > 1) args = positional.slice(1).map(arrayText).join(' ');
  if (!file) return;
  setInner(seg, (file + ' ' + args).trim(), 'Start-Process', ctx, 'powershell');
}

function handleInvokeCommand(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  let block: string | null = null;
  let computer: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const lower = t.text.toLowerCase();
    if (/^-scriptblock/.test(lower) || /^-sb/.test(lower) || /^-command/.test(lower)) {
      const v = rest[i + 1];
      if (v) block = v.subshells[0] ?? v.text.replace(/^\{|\}$/g, '');
      continue;
    }
    if (/^-computername/.test(lower) || /^-cn$/.test(lower) || /^-hostname/.test(lower)) {
      computer = rest[i + 1]?.text;
      continue;
    }
    if (/^-filepath/.test(lower)) {
      seg.opaque = true;
      seg.opaqueReason = 'Invoke-Command runs a script file';
    }
    if (block === null && t.subshells.length && t.text.startsWith('{')) block = t.subshells[0];
  }
  if (block !== null) setInner(seg, block, seg.prog === 'invoke-command' || seg.prog === 'icm' ? 'Invoke-Command' : 'Start-Job', ctx, 'powershell', computer);
}

function handleSsh(seg: Segment, rest: RawTok[], ctx: SegCtx): void {
  let i = 0;
  while (i < rest.length) {
    const t = rest[i].text;
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-')) break;
    if (SSH_VALUE_OPTS.has(t)) {
      i += 2;
      continue;
    }
    // -oOption=value or -p22 attached forms
    i++;
  }
  const host = rest[i]?.text ?? '';
  const after = rest.slice(i + 1);
  if (!host) return;
  const hostOnly = host.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  seg.args = rest.map((w) => w.text);
  if (!after.length) return; // interactive login, nothing to inspect
  const str = after.map((w) => w.text).join(' ');
  if (after.some((w) => w.dynamic && w.subshells.length === 0 && /^\$/.test(w.text) && after.length === 1)) {
    seg.opaque = true;
    seg.opaqueReason = 'remote command is a variable';
  }
  setInner(seg, str, 'ssh', ctx, 'posix', hostOnly);
}

function handleDocker(seg: Segment, rest: RawTok[], ctx: SegCtx, prog: string): 'done' | 'continue' {
  let i = 0;
  // global options
  while (i < rest.length && rest[i].text.startsWith('-')) {
    const t = rest[i].text;
    if (DOCKER_GLOBAL_VALUE_OPTS.has(t)) i += 2;
    else i++;
  }
  let sub = rest[i]?.text ?? '';
  i++;
  if (prog === 'docker-compose') {
    sub = 'compose ' + sub;
  } else if (sub === 'compose' || sub === 'container') {
    // docker compose [opts] exec|run ; docker container exec|run
    while (i < rest.length && rest[i].text.startsWith('-')) {
      const t = rest[i].text;
      if (DOCKER_VALUE_OPTS.has(t) || DOCKER_GLOBAL_VALUE_OPTS.has(t)) i += 2;
      else i++;
    }
    sub = sub + ' ' + (rest[i]?.text ?? '');
    i++;
  }
  const kind = sub.endsWith('exec') ? 'exec' : sub.endsWith('run') ? 'run' : sub.endsWith('create') ? 'create' : null;
  if (!kind) return 'done';
  let unknown = false;
  let entrypoint: string | null = null;
  const innerEnv: Record<string, string> = {};
  let name: string | undefined;
  const mounts: string[] = [];
  while (i < rest.length) {
    const t = rest[i].text;
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-')) break;
    const eq = t.indexOf('=');
    const optName = eq > 0 ? t.slice(0, eq) : t;
    const inlineVal = eq > 0 ? t.slice(eq + 1) : undefined;
    const takeVal = (): string => {
      if (inlineVal !== undefined) {
        i++;
        return inlineVal;
      }
      const v = rest[i + 1]?.text ?? '';
      i += 2;
      return v;
    };
    if (optName === '-e' || optName === '--env') {
      const v = takeVal();
      const m = ENV_ASSIGN_RE.exec(v);
      if (m) innerEnv[m[1]] = m[2];
      continue;
    }
    if (optName === '--entrypoint') {
      entrypoint = takeVal();
      continue;
    }
    if (optName === '--name') {
      name = takeVal();
      continue;
    }
    if (optName === '-v' || optName === '--volume' || optName === '--mount') {
      mounts.push(takeVal());
      continue;
    }
    if (DOCKER_FLAG_OPTS.has(optName)) {
      i++;
      continue;
    }
    if (DOCKER_VALUE_OPTS.has(optName)) {
      takeVal();
      continue;
    }
    // combined short flags like -itu
    if (/^-[a-zA-Z]{2,}$/.test(t) && t.split('').slice(1).every((c) => 'itdqPT'.includes(c))) {
      i++;
      continue;
    }
    unknown = true;
    if (inlineVal === undefined && rest[i + 1] && !rest[i + 1].text.startsWith('-')) i += 2;
    else i++;
  }
  const target = rest[i]?.text ?? '';
  const cmdToks = rest.slice(i + 1);
  seg.via = [...seg.via, { kind: prog === 'podman' ? 'podman ' + kind : 'docker ' + kind, target: kind === 'exec' ? target : name ?? target }];
  Object.assign(seg.env, innerEnv);
  if (unknown) {
    seg.opaque = true;
    seg.opaqueReason = 'unknown docker option';
  }
  seg.args = rest.map((w) => w.text);
  seg.argTokens = rest.map(tokenToPublic);
  (seg as Segment & { dockerImage?: string; dockerMounts?: string[] }).dockerImage = kind === 'run' || kind === 'create' ? target : undefined;
  (seg as Segment & { dockerMounts?: string[] }).dockerMounts = mounts;
  if (entrypoint) {
    const ep: RawTok = { kind: 'word', text: entrypoint, raw: entrypoint, quoted: false, dynamic: false, subshells: [], tilde: false };
    seg.argTokens = [tokenToPublic(ep), ...cmdToks.map(tokenToPublic)];
    return 'continue';
  }
  if (!cmdToks.length) {
    // docker run IMAGE with the image's default command
    seg.argTokens = [];
    return 'done';
  }
  seg.argTokens = cmdToks.map(tokenToPublic);
  return 'continue';
}

function handleKubectl(seg: Segment, rest: RawTok[], ctx: SegCtx, prog: string): 'done' | 'continue' {
  let i = 0;
  while (i < rest.length && rest[i].text.startsWith('-')) {
    const t = rest[i].text;
    if (KUBECTL_VALUE_OPTS.has(t)) i += 2;
    else i++;
  }
  const sub = rest[i]?.text;
  if (sub !== 'exec' && sub !== 'run' && sub !== 'debug') return 'done';
  i++;
  let pod = '';
  const cmdToks: RawTok[] = [];
  let seenDashDash = false;
  while (i < rest.length) {
    const t = rest[i].text;
    if (seenDashDash) {
      cmdToks.push(rest[i]);
      i++;
      continue;
    }
    if (t === '--') {
      seenDashDash = true;
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (KUBECTL_VALUE_OPTS.has(name) && !t.includes('=')) i += 2;
      else i++;
      continue;
    }
    if (!pod) pod = t;
    else cmdToks.push(rest[i]);
    i++;
  }
  seg.via = [...seg.via, { kind: `${prog} ${sub}`, target: pod.replace(/^(pod|deploy|deployment|svc|service|sts|statefulset|ds|daemonset|job|rs)\//, '') }];
  seg.args = rest.map((w) => w.text);
  seg.argTokens = cmdToks.map(tokenToPublic);
  if (!cmdToks.length) return 'done';
  return 'continue';
}

// ---------------------------------------------------------------------------
// Helpers for consumers
// ---------------------------------------------------------------------------

/** Every segment, depth-first: the segment itself, then its subshells, then its inner command. */
export function allSegments(p: ParsedCommand): Segment[] {
  const out: Segment[] = [];
  const walk = (pc: ParsedCommand) => {
    for (const s of pc.segments) {
      out.push(s);
      for (const sub of s.subshells) walk(sub);
      if (s.inner) walk(s.inner);
    }
  };
  walk(p);
  return out;
}

/** All raw text reachable from a segment (its own text, heredoc, inline code, inner commands). */
export function segmentText(s: Segment): string {
  const parts: string[] = [s.raw];
  if (s.heredoc) parts.push(s.heredoc);
  if (s.innerCode) parts.push(s.innerCode);
  if (s.inner) parts.push(s.inner.raw);
  for (const sub of s.subshells) parts.push(sub.raw);
  return parts.join('\n');
}

/** Flag tokens expanded: "-fu" -> ["-f","-u"] for single-dash clusters; long options unchanged. */
export function expandShortFlags(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (/^-[A-Za-z]{2,}$/.test(a)) out.push(...a.slice(1).split('').map((c) => '-' + c));
    else out.push(a);
  }
  return out;
}
