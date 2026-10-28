/**
 * Criterion classification (team intake, second step).
 *
 * Per criterion, deterministic keyword and shape rules give:
 * - facts: routes, status codes, tables, columns, measures, body facts, paths;
 * - a kind (unit / api / db / ui-artifact / nonfunctional / untestable) with a
 *   confidence;
 * - an EARS rewrite ("When <trigger>, the <system> shall <response>" /
 *   "While <state>, …" / "If <condition>, then …") for criteria that are not
 *   testable as written, naming the fact the ticket does not give;
 * - the repos it maps to (configured repo names, package names, paths);
 * - a check spec (unit test command, `harness verify drive`, `harness verify
 *   db`, or a manual artifact), always red-first;
 * - unclear points, which the ambiguity gate turns into observations,
 *   assumptions or questions.
 *
 * Only `repoInfos` and `mapRepos` (path existence) touch the file system; the
 * rest is pure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckSpec, CriterionKind, HarnessConfig } from '../types';
import { readJsonOr, readTextOr } from '../lib/fsx';
import { repoIdFor } from '../lib/config';
import { slug } from '../lib/paths';
import { gateSpec, type TicketText } from './gatecheck';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface Route {
  method?: string;
  path: string;
}

export interface Measure {
  value: number;
  unit: string;
  op: '<' | '<=' | '>' | '>=' | '=';
  /** e.g. p95, latency, throughput, memory; empty when the text names none. */
  metric: string;
  raw: string;
}

export interface CriterionFacts {
  routes: Route[];
  /** Quoted command-line invocations (`pantry list --json`, `npm run format`): a bare first word with a sub-command or flags, never an HTTP method, route, path or JSON. */
  commands: string[];
  statuses: number[];
  /** Statuses read from words ("not found" -> 404), used when no number is given. */
  statusWords: number[];
  tables: string[];
  /** `table.column` when the table is known, else `column`. */
  columns: string[];
  rowCount?: number;
  measures: Measure[];
  bodyFacts: string[];
  quoted: string[];
  paths: string[];
  vague: string[];
  trigger?: { type: 'when' | 'while' | 'if'; text: string; rest: string };
  gwt: boolean;
}

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|md|py|cs|java|go|rb|php|yml|yaml|html|css|scss|txt|csv|xml|sh|ps1|toml|lock)$/i;
const NOT_TABLE = new Set([
  'the', 'a', 'an', 'new', 'same', 'this', 'that', 'each', 'every', 'one', 'its', 'their', 'our', 'your', 'any', 'existing', 'database', 'db', 'sql', 'data', 'lookup', 'join', 'temp', 'following', 'whole', 'right', 'left',
  // verbs that follow "table" in a sentence ("the audit table records the user")
  'records', 'stores', 'has', 'holds', 'contains', 'keeps', 'shows', 'lists', 'gets', 'is', 'are', 'should', 'must', 'will', 'includes', 'tracks', 'logs', 'gains', 'needs', 'can', 'does', 'with', 'and', 'or', 'of', 'for', 'in', 'to',
  // a table in a document, not in the database ("the README table lists ...")
  'readme', 'markdown', 'md', 'html', 'doc', 'docs', 'documentation', 'wiki', 'changelog', 'comparison', 'summary', 'truth', 'routing', 'environment', 'variable', 'variables',
]);
/** UPPER_SNAKE names are environment variables or constants, never database columns. */
const ENV_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
/** A criterion saying something must be absent from the response. */
const NEGATED_BODY = /\b(never|no longer|excluded|absent|omitted|hidden)\b|\b(not|n't)\s+(appear|contain|include|list|show|return)/i;
const NOT_COLUMN = new Set(['the', 'a', 'an', 'new', 'same', 'this', 'that', 'each', 'every', 'one', 'its', 'key', 'value', 'data', 'following', 'whole', 'extra', 'sort', 'order', 'nullable', 'required', 'computed', 'primary', 'is', 'are', 'has', 'holds', 'stores', 'must', 'should', 'will', 'can', 'with', 'and', 'or', 'of', 'for', 'in', 'to']);

const VAGUE: Array<[RegExp, string]> = [
  [/\buser[- ]friendly\b/i, 'user-friendly'],
  [/\bintuitive(ly)?\b/i, 'intuitive'],
  [/\b(fast|faster|quick|quickly|speedy|snappy)\b/i, 'fast'],
  [/\bslow(ly)?\b/i, 'slow'],
  [/\beas(y|ily|ier)\b/i, 'easy'],
  [/\bsimple\b/i, 'simple'],
  [/\bclean(er)?\b/i, 'clean'],
  [/\brobust(ly)?\b/i, 'robust'],
  [/\bnice(ly)?\b/i, 'nice'],
  [/\bbetter\b/i, 'better'],
  [/\bimprov(e|ed|es|ing)\b/i, 'improved'],
  [/\bappropriate(ly)?\b/i, 'appropriate'],
  [/\bas expected\b/i, 'as expected'],
  [/\bproperly\b/i, 'properly'],
  [/\bcorrectly\b/i, 'correctly'],
  [/\bseamless(ly)?\b/i, 'seamless'],
  [/\befficient(ly)?\b/i, 'efficient'],
  [/\breasonabl(e|y)\b/i, 'reasonable'],
  [/\bwork(s)? well\b/i, 'works well'],
  [/\bgraceful(ly)?\b/i, 'gracefully'],
  [/\boptimal(ly)?\b|\boptimi[sz]ed\b/i, 'optimal'],
  [/\bscalable\b/i, 'scalable'],
  [/\bresponsive\b/i, 'responsive'],
  [/\bmodern\b/i, 'modern'],
  [/\bsecure(ly)?\b/i, 'secure'],
  [/\b(good|great)\b/i, 'good'],
];

const STATUS_WORDS: Array<[RegExp, number]> = [
  [/\bnot found\b/i, 404],
  [/\bforbidden\b|\bnot (allowed|permitted)\b/i, 403],
  [/\bunauthori[sz]ed\b|\bnot (signed|logged) in\b/i, 401],
  [/\bbad request\b|\binvalid (input|request|payload|body|data|parameters?)\b|\bvalidation error\b/i, 400],
  [/\bconflict\b|\bduplicate\b|\balready exists\b/i, 409],
  [/\bunprocessable\b/i, 422],
  [/\bno content\b/i, 204],
  [/\btoo many requests\b|\brate[- ]limited\b/i, 429],
];

/** Every leading-slash token that is not a file path is a route. */
function findRoutes(text: string): Route[] {
  const out: Route[] = [];
  const seen = new Set<string>();
  const add = (method: string | undefined, p: string) => {
    let r = p.replace(/[.,;:)\]'"`]+$/, '');
    // A path after a method is a route even when it ends like a file (`GET /orders/:id/export.csv`).
    if (!r || r === '/' || (!method && FILE_EXT.test(r)) || /^\/\//.test(r)) return;
    if (/^\/(?:[a-z]:|home|usr|tmp|etc|var|users)\b/i.test(r)) return;
    r = r.replace(/\/+$/, '') || '/';
    const k = `${method ?? ''} ${r}`;
    if (seen.has(k) || (!method && [...seen].some((s) => s.endsWith(` ${r}`)))) return;
    seen.add(k);
    out.push(method ? { method: method.toUpperCase(), path: r } : { path: r });
  };
  const withMethod = new RegExp(`\\b(${METHODS})\\s+[\`'"]?(\\/[^\\s,;)'"\`]*)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = withMethod.exec(text))) add(m[1], m[2]);
  const bare = /(^|[\s(`'"])(\/[A-Za-z0-9_{}:.\-]+(?:\/[A-Za-z0-9_{}:.\-]*)*(?:\?[^\s`'")]*)?)/g;
  while ((m = bare.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 1), m.index + m[1].length);
    if (/[A-Za-z0-9_.-]$/.test(before.trim()) && m[1] === '') continue;
    add(undefined, m[2]);
  }
  return out;
}

function findPaths(text: string): string[] {
  const out = new Set<string>();
  const re = /(^|[\s(`'"])((?:\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.\-*]+)+\/?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[2].replace(/[.,;:)]+$/, '').replace(/^\.\//, '');
    if (/^(https?|ftp):/i.test(p) || /^\d/.test(p) || /^(and|or)\//i.test(p)) continue;
    // a media type (`text/csv`, `application/json`) is not a path
    if (/^(text|application|image|audio|video|multipart|font)\/[\w.+-]+$/i.test(p)) continue;
    if (!/[A-Za-z]/.test(p)) continue;
    out.add(p);
  }
  return [...out];
}

const MEASURE_UNITS: Array<[RegExp, string]> = [
  [/^(ms|msec|milliseconds?)$/i, 'ms'],
  [/^(s|sec|secs|seconds?)$/i, 's'],
  [/^(min|mins|minutes?)$/i, 'min'],
  [/^(%|percent)$/i, '%'],
  [/^(rps|req\/s|requests? per second|requests?\/s)$/i, 'rps'],
  [/^(rpm|requests? per minute)$/i, 'rpm'],
  [/^(kb|mb|gb)$/i, ''],
  [/^(concurrent users|users)$/i, 'users'],
];

function findMeasures(text: string): Measure[] {
  const out: Measure[] = [];
  const re = /(<=|>=|<|>|≤|≥|under|below|less than|at most|within|no more than|faster than|not exceed(?:ing)?|over|above|more than|at least|exceeds?|up to|of)?\s*(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds?|seconds?|secs?|s|minutes?|mins?|min|%|percent|rps|req\/s|requests? per second|requests?\/s|rpm|requests? per minute|kb|mb|gb|concurrent users)(?![A-Za-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = (m[1] ?? '').toLowerCase();
    let unit = m[3].toLowerCase();
    for (const [r, u] of MEASURE_UNITS) if (r.test(unit)) unit = u || unit;
    let op: Measure['op'] = '=';
    if (['<', 'under', 'below', 'less than', 'faster than'].includes(word)) op = '<';
    else if (['<=', '≤', 'at most', 'within', 'no more than', 'not exceed', 'not exceeding', 'up to'].includes(word)) op = '<=';
    else if (['>', 'over', 'above', 'more than', 'exceeds', 'exceed'].includes(word)) op = '>';
    else if (['>=', '≥', 'at least'].includes(word)) op = '>=';
    const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).toLowerCase();
    const metric = /\bp(50|75|90|95|99)\b/.exec(around)?.[0] ?? /\b(median|average|mean|latency|response time|throughput|memory|cpu|error rate|uptime|availability|load time|page load)\b/.exec(around)?.[0] ?? '';
    // Plain counts in seconds/minutes for business rules ("30 days") are not here; days are not a unit above.
    out.push({ value: Number(m[2]), unit, op, metric, raw: m[0].trim() });
  }
  return out;
}

function findTablesAndColumns(text: string): { tables: string[]; columns: string[] } {
  const tables = new Set<string>();
  const columns = new Set<string>();
  const ident = '[`\'"\\[]?([A-Za-z_][A-Za-z0-9_]*)[`\'"\\]]?';
  let m: RegExpExecArray | null;
  const dotted = /(?<![\w/.-])[`'"[]?([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)[`'"\]]?(?![\w(/-])/g;
  const dbContext = /\b(column|table|stored|persist(ed|s)?|saved|written|inserted|row|rows|database|db|schema|migration|field)\b/i.test(text);
  while ((m = dotted.exec(text))) {
    const [, t, c] = m;
    if (FILE_EXT.test(`.${c}`) || /^\d/.test(t)) continue;
    if (!dbContext) continue;
    if (/^(e|i|etc|vs|dbo)$/i.test(t) && !/^dbo$/i.test(t)) continue;
    if (/^dbo$/i.test(t)) {
      tables.add(c);
      continue;
    }
    tables.add(t);
    columns.add(`${t}.${c}`);
  }
  const reTableBefore = new RegExp(`\\btable\\s+${ident}`, 'gi');
  while ((m = reTableBefore.exec(text))) if (!NOT_TABLE.has(m[1].toLowerCase())) tables.add(m[1]);
  const reTableAfter = new RegExp(`${ident}\\s+table\\b`, 'gi');
  while ((m = reTableAfter.exec(text))) if (!NOT_TABLE.has(m[1].toLowerCase())) tables.add(m[1]);
  const reColBefore = new RegExp(`\\bcolumns?\\s+${ident}`, 'gi');
  while ((m = reColBefore.exec(text))) if (!NOT_COLUMN.has(m[1].toLowerCase()) && !ENV_NAME.test(m[1])) columns.add(m[1]);
  const reColAfter = new RegExp(`${ident}\\s+columns?\\b`, 'gi');
  while ((m = reColAfter.exec(text))) {
    const c = m[1];
    if (NOT_COLUMN.has(c.toLowerCase()) || ENV_NAME.test(c) || [...columns].some((x) => x.endsWith(`.${c}`))) continue;
    columns.add(c);
  }
  // `orders.total column` was added both as `orders.total` and `total`; keep the qualified one.
  for (const c of [...columns]) if (!c.includes('.') && [...columns].some((x) => x.endsWith(`.${c}`))) columns.delete(c);
  return { tables: [...tables], columns: [...columns] };
}

const NUM_WORDS: Record<string, number> = { no: 0, zero: 0, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function findRowCount(text: string): number | undefined {
  const m = /\b(\d+|no|zero|one|a|two|three|four|five|six|seven|eight|nine|ten)\s+(?:new\s+)?rows?\b(?!\s+per\b)/i.exec(text);
  if (!m) return undefined;
  const v = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1].toLowerCase()];
  return Number.isFinite(v) ? v : undefined;
}

const BODY_STOP = new Set(['the', 'a', 'an', 'its', 'their', 'all', 'with', 'and', 'or', 'of', 'to', 'in', 'for', 'when', 'if', 'status', 'http', 'code', 'response', 'body', 'json', 'list', 'error', 'ok', 'it', 'them', 'this', 'that', 'be', 'is', 'are', 'only', 'same', 'new']);

function findBodyFacts(text: string, quoted: string[]): string[] {
  const out = new Set<string>();
  // A quoted route (`GET /x`, `/x`), query (`?a=1`) or parameter (`a=1`) names the request, not the response body.
  const requestish = new RegExp(`^(?:(?:${METHODS})\\s+)?\\/|^\\?|^[\\w.-]+=\\S*$|^(?:${METHODS})$`, 'i');
  for (const q of quoted) if (!requestish.test(q)) out.add(q);
  const re = /\b(?:returns?|responds? with|response (?:contains|includes|has)|body (?:contains|includes|has)|includes?|contains?|with (?:a|the)? ?(?:field|property|key))\s+((?:the\s+|a\s+|an\s+)?[A-Za-z_][\w.]*(?:\s*(?:,|and)\s*(?:the\s+)?[A-Za-z_][\w.]*){0,4})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const w of m[1].split(/\s*(?:,|\band\b)\s*/)) {
      const word = w.replace(/^(the|a|an)\s+/i, '').trim();
      if (!word || BODY_STOP.has(word.toLowerCase()) || /^\d+$/.test(word) || /^[A-Z]{3,}$/.test(word)) continue;
      if (/^(GET|POST|PUT|PATCH|DELETE)$/i.test(word)) continue;
      out.add(word);
    }
  }
  return [...out];
}

const CLI_FIRST_WORD = /^[a-z][\w.-]*$/;
// English words that start a phrase, never a program (`not found`, `no rows`, `status code`)
const CLI_STOP = new Set(['not', 'no', 'the', 'a', 'an', 'is', 'are', 'be', 'was', 'with', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'as', 'at', 'by', 'from', 'if', 'when', 'then', 'else', 'this', 'that', 'it', 'all', 'any', 'each', 'same', 'new', 'only', 'status', 'error', 'ok', 'true', 'false', 'null', 'empty', 'returns', 'return', 'bad', 'internal', 'unknown', 'invalid', 'missing', 'one', 'two', 'per', 'low', 'high', 'expiring', 'expired', 'items', 'item', 'total', 'totals', 'rows', 'row']);
const CLI_ARG = /^(?:--?[\w-]+(?:=\S+)?|[A-Za-z0-9][\w:./-]*|<[^>]+>|\.{3}|"[^"]*"|'[^']*')$/;

/** Quoted strings that read as a command line: `pantry list --json`, `npm run format`, `node dist/cli.js add ...`. */
export function findCommands(quoted: string[]): string[] {
  const out: string[] = [];
  for (const q of quoted) {
    const words = q.trim().split(/\s+/);
    if (words.length < 2) continue;
    const [first, ...rest] = words;
    if (!CLI_FIRST_WORD.test(first) || CLI_STOP.has(first.toLowerCase()) || new RegExp(`^(?:${METHODS})$`, 'i').test(first)) continue;
    if (/^[\[{(]/.test(q) || /[?&]\w+=/.test(q) || rest.some((w) => !CLI_ARG.test(w) && !/^[\w-]+$/.test(w))) continue;
    // a sub-command or a flag makes it a command; two plain English words (`not found`) do not
    if (!rest.some((w) => w.startsWith('-')) && !(rest.length >= 1 && /^[a-z][\w:-]*$/.test(rest[0]) && !CLI_STOP.has(rest[0].toLowerCase()))) continue;
    if (!out.includes(q.trim())) out.push(q.trim());
  }
  return out;
}

function findQuoted(text: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`|"([^"]+)"|“([^”]+)”|'([^'\s][^']*[^'\s])'(?![a-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push((m[1] ?? m[2] ?? m[3] ?? m[4]).trim());
  return out.filter(Boolean);
}

function findTrigger(text: string): CriterionFacts['trigger'] {
  const t = text.trim().replace(/[.;]$/, '');
  let m = /^(?:when|whenever|after|once|on|upon)\s+(.+?),\s*(?:then\s+)?(.+)$/i.exec(t);
  if (m) return { type: 'when', text: m[1], rest: m[2] };
  m = /^(?:while|during)\s+(.+?),\s*(.+)$/i.exec(t);
  if (m) return { type: 'while', text: m[1], rest: m[2] };
  m = /^(?:if|in case|unless)\s+(.+?),\s*(?:then\s+)?(.+)$/i.exec(t);
  if (m) return { type: 'if', text: /^unless/i.test(t) ? `not (${m[1]})` : m[1], rest: m[2] };
  m = /^(.+?)\s+(?:when|whenever|after|once)\s+(.+)$/i.exec(t);
  if (m && m[1].split(/\s+/).length >= 2) return { type: 'when', text: m[2], rest: m[1] };
  m = /^(.+?)\s+(?:if)\s+(.+)$/i.exec(t);
  if (m && m[1].split(/\s+/).length >= 2) return { type: 'if', text: m[2], rest: m[1] };
  return undefined;
}

export function extractFacts(text: string): CriterionFacts {
  const quoted = findQuoted(text);
  const routes = findRoutes(text);
  const statuses = new Set<number>();
  let m: RegExpExecArray | null;
  const st = /\b(?:status(?:\s+code)?|http|returns?|responds?(?:\s+with)?|respond with|answers?(?:\s+with)?|gets?|code|with)\s*:?\s*([1-5]\d\d)\b/gi;
  while ((m = st.exec(text))) statuses.add(Number(m[1]));
  const st2 = /\b([1-5]\d\d)\s+(OK|Created|Accepted|No Content|Bad Request|Unauthori[sz]ed|Forbidden|Not Found|Conflict|Unprocessable|Too Many)/gi;
  while ((m = st2.exec(text))) statuses.add(Number(m[1]));
  const statusWords = STATUS_WORDS.filter(([r]) => r.test(text)).map(([, c]) => c);
  const { tables, columns } = findTablesAndColumns(text);
  const vague = VAGUE.filter(([r]) => r.test(text)).map(([, w]) => w);
  return {
    routes,
    commands: findCommands(quoted),
    statuses: [...statuses],
    statusWords,
    tables,
    columns,
    rowCount: findRowCount(text),
    measures: findMeasures(text),
    // "never appears", "is excluded": the quoted words must be absent, which a body check cannot express; keep none.
    bodyFacts: NEGATED_BODY.test(text) ? [] : findBodyFacts(text, quoted),
    quoted,
    paths: findPaths(text).filter((p) => !routes.some((r) => r.path === p || `/${p}` === r.path)),
    vague,
    trigger: findTrigger(text),
    gwt: /^(?:[^:]{0,80}:\s*)?given\b/i.test(text.trim()) && /\bthen\b/i.test(text),
  };
}

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

export interface KindResult {
  kind: CriterionKind;
  confidence: number;
  /** Rule names that fired, for the brief's "why" column. */
  reasons: string[];
  /** Not testable as written: needs an EARS rewrite and maybe a fact. */
  needsRewrite: boolean;
}

const RX = {
  // `json` and `rest` only as words, never as a flag or an extension (`--json`, `.json`, `--rest`): a flag names a command-line option, not an API
  apiWords: /\b(endpoint|api|http|request|response|payload|header|query (param|parameter|string)|(?<![-.])json|(?<![-.])rest|graphql|webhook)\b/i,
  apiVerbs: /\b(returns?|responds?|status|request(s|ed)?|response|calls?|accepts?|rejects?)\b/i,
  dbStrong: /\b(stored|persist(ed|s)?|saved|written|inserted|recorded|kept)\b[^.]*\b(database|db|table|column|row|rows)\b|\b(database|db)\b[^.]*\b(stores?|holds?|has|contains?|keeps?)\b/i,
  dbWords: /\b(migration|schema|index(es)?|foreign key|constraint|stored procedure|primary key|nullable|unique constraint|sqlcmd)\b/i,
  dbSql: /\b(select\s+.+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i,
  dbWeak: /\b(stored|persist(ed|s)?|saved to|rows?|records?)\b/i,
  uiNouns: /\b(page|screen|button|modal|dialog|tooltip|form|tab|menu|banner|toast|icon|ui|layout|view|dashboard|pdf|chart|placeholder|dropdown|checkbox|link|sidebar|header bar|navbar|popup|spinner|table view|grid)\b/i,
  uiVerbs: /\b(shows?|shown|displays?|displayed|visible|hidden|renders?|rendered|appears?|sees?|click(s|ed)?|tap(s|ped)?|highlight(ed|s)?|disabled|enabled|greyed|scroll(s|ed)?)\b/i,
  uiUserSees: /\buser (sees|can see|is shown)\b/i,
  nfMetric: /\b(latency|response time|performance|throughput|p50|p75|p90|p95|p99|load time|page load|memory|cpu|uptime|availability|concurrent|scal(e|ability)|under load|load test|benchmark)\b/i,
  nfSecurity: /\b(encrypt(ed|ion)?|tls|https only|xss|csrf|sql injection|owasp|rate[- ]limit(ed|ing)?|pci|gdpr|wcag|a11y|accessib(le|ility)|screen reader)\b/i,
  unitWords: /\b(function|method|class|module|helper|util(ity)?|calculat(e|es|ed|ion)|comput(e|es|ed)|validat(e|es|ed|ion)|pars(e|es|ed|ing)|format(s|ted)?|convert(s|ed)?|round(s|ed|ing)?|sum(s|med)?|throws?|exception|regex|sort(s|ed)?|dedupe|normali[sz]e)\b/i,
  outcome: /\b(returns?|equals?|is set|are set|becomes?|rejects?|accepts?|includes?|contains?|creates?|updates?|deletes?|removes?|sends?|emits?|logs?|records?|fails?|succeeds?|stays?|remains?|unchanged|idempotent|once|unique|defaults? to|is (?:\d|true|false|null|empty))\b/i,
  verbish: /\b(is|are|be|has|have|can|must|should|shall|will|does|do|gets?|moves?|maps?|keeps?|links?|names?|goes|go|loads?|runs?)\b/i,
  // a document the change must make true ("the README table lists X, Y"): a test or script reads the file
  docs: /\b(readme|changelog|contributing|docs?|documentation)\b|\b[\w-]+\.md\b/i,
  docVerbs: /\b(lists?|documents?|describes?|mentions?|explains?|names?|section|table|match(es|ing)?)\b/i,
  suitePasses: /\b(all|existing|the)\s+(unit\s+|existing\s+)?tests\s+(still\s+)?pass\b/i,
};

// ---------------------------------------------------------------------------
// Criteria that need no red-first proof, and shapes that decide the kind outright
// ---------------------------------------------------------------------------

const GREEN_AT_BASE: Array<[RegExp, string]> = [
  [
    /\bcharacteri[sz](?:ation|e[sd]?|ing)\b|\bpins?\s+(?:down\s+)?(?:the\s+)?(?:current|existing)\s+behaviou?r/i,
    'characterisation: it records what the code does today, so it passes before the change and must keep passing',
  ],
  [
    /\bno\s+(?:behaviou?ral\s+|functional\s+|visible\s+)?change(?:s)?\s+(?:in|to|of)\s+(?:the\s+)?(?:existing\s+)?(?:behaviou?r|output|results?)\b|\bno\s+(?:behaviou?r(?:al)?|functional)\s+change(?:s)?\b|\b(?:behaviou?r|output|results?)\s+(?:(?:is|are|remains?|stays?)\s+)*(?:unchanged|the\s+same\s+as\s+before)\b|\bwithout\s+(?:changing|any\s+change\s+(?:in|to))\s+(?:the\s+)?(?:existing\s+)?(?:behaviou?r|output)\b|\bbehaviou?r[- ]preserving\b|\bpure\s+refactor(?:ing)?\b/i,
    'no behaviour change: the behaviour is the same before and after, so the test passes at the base commit and must keep passing',
  ],
  [
    /\b(?:all\s+|the\s+)?(?:existing|current|old)\s+(?:(?:unit|integration|e2e)\s+)?tests?\s+(?:(?:still|continue\s+to|keep|must|should|will)\s+)*(?:pass(?:es|ing)?|stay\s+green|are\s+green)\b|\b(?:existing|current|whole|full|entire)\s+(?:test\s+)?suite\s+(?:(?:still|must|should|will)\s+)*(?:passes|stays\s+green|is\s+green)\b|\b(?:all|the)\s+(?:unit\s+)?tests\s+(?:still\s+)?pass\b/i,
    'existing tests: they pass today and must still pass after the change',
  ],
  [
    /\bdocumentation[- ]only\b|\bdocs[- ]only\b|\bno\s+code\s+changes?\b|\bonly\s+(?:the\s+)?(?:docs?|documentation|readme|comments?)\s+(?:is|are|will\s+be)?\s*(?:change[sd]?|updated?|touched)\b/i,
    'documentation-only change: no code behaviour changes, so the test passes before and after',
  ],
];

/** Why a criterion is green at the base commit by its wording alone (characterisation, no behaviour change, ...); undefined when it is not. */
export function greenAtBaseByWording(text: string): string | undefined {
  for (const [re, why] of GREEN_AT_BASE) if (re.test(text)) return why;
  return undefined;
}

/** A criterion about the code's structure, not its behaviour: never `db` or `api`, even when it names a table, column or route. */
const CODE_STRUCTURE =
  /\bpure\s+(?:helpers?|functions?)\b|\b(?:a|an|the|new|shared|small)\s+helpers?\s+(?:functions?|methods?|modules?|class(?:es)?)\b|\bhelpers?\s+with\s+unit\s+tests\b|\bextract(?:ed|ing|s)?\s+(?:\w+\s+){0,3}?(?:in)?to\s+(?:a|an|the|its|one|their|new)?\s*(?:\w+\s+){0,2}?(?:module|function|helper|class|file|package|library|component|method)\b|\bno\s+duplicat(?:ed|ion)\b|\b(?:logic|code)\s+is\s+(?:not\s+)?duplicated\b|\bshared\s+in\s+(?:one|a\s+single)\s+place\b|\b(?:lives?|defined|implemented|kept)\s+in\s+(?:one|a\s+single)\s+(?:place|module|file)\b|\bsingle\s+source\s+of\s+truth\b/i;

/** A document the change must make true ("the README documents ...", "CHANGELOG.md lists ..."): a test reads the file. */
export function isDocCriterion(text: string): boolean {
  return RX.docs.test(text) && RX.docVerbs.test(text);
}

const CLI_FLAG = /(?<![\w./=-])(--[a-z][\w-]*|-[a-zA-Z])(?![\w-])/g;
const CLI_EXIT = /\bexit(?:s|ed|ing)?\s+(?:with\s+)?(?:code\s+|status\s+)?(?:non-?zero|zero|\d+)\b|\bnon-?zero\s+(?:exit|status)|\bexit\s+(?:code|status)\b|\breturns?\s+(?:exit\s+)?(?:code|status)\s+\d/i;
const CLI_OUTPUT =
  /\b(?:prints?|outputs?|writes?|emits?|shows?)\b[^.]{0,60}\b(?:stdout|stderr|standard\s+(?:output|error)|the\s+(?:console|terminal))\b|\b(?:prints?|outputs?)\s+(?:a|an|the|one|each)\s+(?:table|list|line|lines|message|summary|usage|help|version|report|json|csv|row|rows)\b/i;

/** What a criterion says about a command-line tool: the flags it names, an exit code, printed output. */
export function cliSignals(text: string): { flags: string[]; exit: boolean; output: boolean } {
  const flags = [...new Set([...text.matchAll(CLI_FLAG)].map((m) => m[1]))];
  return { flags, exit: CLI_EXIT.test(text), output: CLI_OUTPUT.test(text) };
}

const DB_DOWN = /\b(?:database|db|sql\s*server)\b[^.]{0,60}?\b(?:(?:is|are|being|goes|went|has\s+gone|was)\s+)?(?:down|unreachable|unavailable|offline|not\s+reachable|cannot\s+be\s+reached|can't\s+be\s+reached|connection\s+refused|not\s+running)\b|\b(?:without|no|lost|loses|losing)\s+(?:a\s+|the\s+)?(?:database|db)(?:\s+connection)?\b(?!\s+(?:rows?|records?|tables?|columns?|entr(?:y|ies)|migrations?))/i;
/** The service must answer, not just exist or retry: a verb of answering, serving or running. */
const DB_DOWN_SERVICE = /\b(?:returns?|responds?|responding|answers?|answering|repl(?:y|ies|ying)|serves?|serving|runs?|running|works?|working|starts?|stays?\s+up|health)\b/i;
/** The sentence also talks about the database being up: it describes both states, so wording alone does not decide the kind. */
const DB_UP = /\bavailable\b|\b(?:database|db)\s+(?:is|are)\s+up\b/i;

/** A criterion saying the service must still answer while its database is down. */
export function dbDownCriterion(text: string): boolean {
  return DB_DOWN.test(text) && DB_DOWN_SERVICE.test(text);
}

/** The status a db-down criterion expects: the one in the clause after the down wording, else a 5xx anywhere in it, else the first status it names, else 503. */
export function dbDownStatus(text: string): { status: number; named: boolean } {
  const m = DB_DOWN.exec(text);
  const after = m ? text.slice(m.index + m[0].length) : '';
  const status = httpStatusIn(after) ?? httpStatusIn(text, (n) => n >= 500) ?? httpStatusIn(text);
  return { status: status ?? 503, named: status !== undefined };
}

export interface HeaderFact {
  name: string;
  /** The value the ticket gives (`text/csv`), when it gives one. */
  value?: string;
}

const HEADER_NAME = /(?<![\w/-])(Content-(?:Type|Disposition|Length|Encoding|Language)|Cache-Control|Access-Control-[A-Za-z-]+|Retry-After|Last-Modified|Set-Cookie|WWW-Authenticate|ETag|X-[A-Za-z][A-Za-z0-9-]*)(?![\w-])/gi;
const HEADER_VALUE_STOP = new Set(['a', 'an', 'the', 'set', 'present', 'included', 'missing', 'returned', 'sent', 'correct', 'there', 'not', 'also', 'always', 'and', 'or', 'to', 'header', 'headers', 'names', 'name', 'with', 'for', 'on', 'in', 'of']);
const HEADER_VALUE_WORDS = new Set(['attachment', 'inline', 'no-store', 'no-cache', 'public', 'private', 'nosniff', 'deny', 'sameorigin']);

/** Response headers a criterion names, with the value the ticket quotes (`Content-Type: text/csv`). */
export function findHeaders(text: string): HeaderFact[] {
  const out: HeaderFact[] = [];
  for (const m of text.matchAll(HEADER_NAME)) {
    const name = m[1];
    // `X-...` is a header only when written `X-Request-Id` and the sentence says "header"; `x-ray`, `X-axis` are not
    if (/^x-/i.test(name) && (!/^X-[A-Z]/.test(name) || !/\bheaders?\b/i.test(text))) continue;
    if (out.some((h) => h.name.toLowerCase() === name.toLowerCase())) continue;
    const rest = text.slice((m.index ?? 0) + name.length);
    let value: string | undefined;
    const sep = /^\s*(?:header\s*)?(?:(:|=)|\b(?:is|of|set\s+to|equals?|should\s+be|must\s+be)\b)\s*[`"']?([A-Za-z0-9][\w.+*/-]*)/i.exec(rest);
    if (sep) {
      const tok = sep[2];
      const strong = sep[1] !== undefined;
      if (!HEADER_VALUE_STOP.has(tok.toLowerCase()) && (strong || tok.includes('/') || HEADER_VALUE_WORDS.has(tok.toLowerCase()))) value = tok.replace(/[.,;]+$/, '');
    }
    out.push({ name, ...(value ? { value } : {}) });
  }
  return out;
}

/** `--expect-header` argument for one header: contains the quoted value, else present. */
export function expectHeaderArg(h: HeaderFact): string {
  return `--expect-header ${JSON.stringify(h.value ? `${h.name}~${h.value}` : `${h.name}=*`)}`;
}

const HTTP_OUTCOME = /\b(?:returns?|responds?|answers?|replies|rejects?|accepts?)\b/i;
const NEW_BEHAVIOUR = /\b(?:adds?|added|stores?|stored|returns?|creates?|created|rejects?|inserts?|inserted|persists?|saves?|saved|deletes?|updates?)\b/i;

function earlyKind(text: string, facts: CriterionFacts, ticket?: TicketText): KindResult | undefined {
  const hit = (kind: CriterionKind, confidence: number, reason: string): KindResult => ({ kind, confidence, reasons: [reason], needsRewrite: false });
  if (dbDownCriterion(text) && !DB_UP.test(text)) return hit('api', 0.9, 'db-down: the service answers while its database is unreachable');
  // the gate proves it itself (checks pass, nothing else changes, history kept): checkFor builds a `gate` check
  if (!facts.routes.length && !facts.statuses.length && gateSpec(text, facts, ticket)) return hit('unit', 0.9, 'proved by the gate');
  // an HTTP outcome (a status code, or a route that returns or answers) or a database fact is scored below, not decided by wording
  const http = facts.statuses.length > 0 || (facts.routes.length > 0 && HTTP_OUTCOME.test(text));
  const data = facts.tables.length > 0 || facts.columns.length > 0;
  if (!http && !data) {
    const gab = greenAtBaseByWording(text);
    if (gab) return hit('unit', 0.9, `green-at-base: ${gab.split(':')[0]}`);
  }
  if (!http && !(data && NEW_BEHAVIOUR.test(text)) && CODE_STRUCTURE.test(text)) return hit('unit', 0.9, 'code structure');
  if (!http && isDocCriterion(text)) return hit('unit', 0.9, 'document check');
  const cli = cliSignals(text);
  if (!facts.routes.length && (cli.flags.length || cli.exit || cli.output)) return hit('unit', 0.88, `command line: ${cli.flags.length ? 'flag' : cli.exit ? 'exit code' : 'printed output'}`);
  return undefined;
}

export function classifyKind(text: string, facts: CriterionFacts = extractFacts(text), ticket?: TicketText): KindResult {
  const early = earlyKind(text, facts, ticket);
  if (early) return early;
  const scores: Record<Exclude<CriterionKind, 'untestable'>, number> = { api: 0, db: 0, nonfunctional: 0, 'ui-artifact': 0, unit: 0 };
  const reasons: Record<string, string[]> = { api: [], db: [], nonfunctional: [], 'ui-artifact': [], unit: [] };
  const bump = (k: keyof typeof scores, v: number, why: string) => {
    if (v > scores[k]) scores[k] = v;
    reasons[k].push(why);
  };
  const methodRoute = facts.routes.some((r) => r.method);
  if (methodRoute) bump('api', 0.95, 'method+route');
  else if (facts.routes.length && (RX.apiVerbs.test(text) || RX.apiWords.test(text))) bump('api', 0.85, 'route+response');
  else if (facts.routes.length) bump('api', 0.6, 'route');
  if (findHeaders(text).length) bump('api', 0.8, 'response header');
  if (facts.statuses.length && RX.apiWords.test(text)) bump('api', 0.8, 'status+api');
  else if (RX.apiWords.test(text)) bump('api', 0.65, 'api-words');

  if (facts.columns.length || facts.tables.length) bump('db', 0.9, 'table/column');
  if (RX.dbStrong.test(text)) bump('db', 0.85, 'stored-in-db');
  if (RX.dbSql.test(text)) bump('db', 0.85, 'sql');
  if (RX.dbWords.test(text)) bump('db', 0.8, 'db-words');
  else if (RX.dbWeak.test(text)) bump('db', 0.5, 'db-weak');

  const timed = facts.measures.some((m) => ['ms', 's', 'min', '%', 'rps', 'rpm', 'users'].includes(m.unit) || m.metric);
  if (timed && (RX.nfMetric.test(text) || facts.measures.some((m) => m.metric))) bump('nonfunctional', 0.96, 'measure+metric');
  else if (timed && facts.measures.some((m) => m.unit === 'ms')) bump('nonfunctional', 0.85, 'measure-ms');
  if (RX.nfMetric.test(text)) bump('nonfunctional', 0.75, 'metric-words');
  if (RX.nfSecurity.test(text)) bump('nonfunctional', 0.7, 'security/accessibility');

  if (RX.uiUserSees.test(text)) bump('ui-artifact', 0.85, 'user-sees');
  if (RX.uiNouns.test(text) && RX.uiVerbs.test(text)) bump('ui-artifact', 0.85, 'ui-noun+verb');
  else if (RX.uiNouns.test(text)) bump('ui-artifact', 0.55, 'ui-noun');

  // a quoted command line (`pantry list --json`): a test runs the command and checks its output; beats API words
  // that only describe the output shape, never a real method+route
  if (facts.commands.length) bump('unit', 0.85, 'cli-command');
  if (RX.unitWords.test(text)) bump('unit', 0.75, 'unit-words');
  if (RX.outcome.test(text)) bump('unit', 0.55, 'outcome-verb');
  if (facts.gwt) bump('unit', 0.6, 'given-when-then');
  if (RX.docs.test(text) && RX.docVerbs.test(text)) bump('unit', 0.7, 'document check');
  if (RX.suitePasses.test(text)) bump('unit', 0.6, 'suite passes');

  const order: Array<keyof typeof scores> = ['api', 'db', 'nonfunctional', 'ui-artifact', 'unit'];
  let best: keyof typeof scores = 'unit';
  let bestScore = -1;
  for (const k of order) {
    if (scores[k] > bestScore) {
      best = k;
      bestScore = scores[k];
    }
  }
  const concrete = facts.statuses.length + facts.quoted.length + facts.measures.length + facts.columns.length + facts.routes.length > 0;
  if (facts.vague.length && bestScore < 0.7 && !concrete && !facts.gwt) {
    return { kind: 'untestable', confidence: 0.7, reasons: [`vague: ${facts.vague.join(', ')}`], needsRewrite: true };
  }
  if (bestScore < 0.5) {
    if (RX.verbish.test(text) && text.split(/\s+/).length >= 3) return { kind: 'unit', confidence: 0.45, reasons: ['default: behaviour sentence'], needsRewrite: false };
    return { kind: 'untestable', confidence: 0.5, reasons: ['no observable outcome'], needsRewrite: true };
  }
  const needsRewrite = (best === 'nonfunctional' && !facts.measures.length && !RX.nfSecurity.test(text)) || (facts.vague.length > 0 && !concrete && !facts.gwt && bestScore < 0.85);
  return { kind: best, confidence: Math.round(bestScore * 100) / 100, reasons: reasons[best], needsRewrite };
}

// ---------------------------------------------------------------------------
// The ticket's endpoint (named in the title or description, not in a criterion)
// ---------------------------------------------------------------------------

export interface TicketEndpoint {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Query parameter names the ticket gives (`?threshold=<n>` -> threshold). */
  params: string[];
}

const HTTP_CODES = new Set([200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 412, 415, 422, 429, 500, 501, 502, 503, 504]);

/**
 * The `METHOD /path` endpoints of the title, then of the description, in
 * order: the first is the endpoint the ticket is about; a criterion that
 * names another one's method (`PATCH` stores the text) is checked against that one.
 */
export function ticketEndpoints(title: string, description: string): TicketEndpoint[] {
  const out: TicketEndpoint[] = [];
  for (const t of [title, description]) {
    for (const r of findRoutes(t ?? '')) {
      if (!r.method) continue;
      const [p, qs] = r.path.split('?');
      const params = (qs ?? '')
        .split('&')
        .map((kv) => kv.split('=')[0])
        .filter((n) => /^[A-Za-z_][\w.-]*$/.test(n));
      if (!out.some((e) => e.method === r.method && e.path === (p || '/'))) out.push({ method: r.method, path: p || '/', params });
    }
  }
  return out;
}

/** The endpoint the ticket is about: the first one ticketEndpoints finds. */
export function ticketEndpoint(title: string, description: string): TicketEndpoint | undefined {
  return ticketEndpoints(title, description)[0];
}

/** The first HTTP status code written as a bare number ("up: 200", "503 `{...}`"); counts, units and negated codes ("no 500") are not statuses. */
function httpStatusIn(text: string, accept: (n: number) => boolean = () => true): number | undefined {
  const re = /(?<![\w.$/=-])(?<!\b(?:no|not|never|without|instead of)\s+)([1-5]\d\d)(?![\w.%/-])(?!\s*(?:ms|s|sec|seconds?|min|minutes?|hours?|days?|items?|rows?|products?|orders?|users?|requests?|px|kb|mb|cents?|%)\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (HTTP_CODES.has(Number(m[1])) && accept(Number(m[1]))) return Number(m[1]);
  return undefined;
}

const CALL_WORDS = /\b(call|calls|called|request(s|ed)?|returns?|responds?|answers?|response)\b/i;

/**
 * A criterion that names no endpoint of its own but describes the response
 * of the ticket's endpoint ("Default call returns ...", "`threshold=0`
 * answers 400", "With the database up: 200 and ...", "registered before
 * `/:id`") is checked against that endpoint. Returns the facts with the
 * endpoint (and the criterion's own query values) filled in, or undefined
 * when the criterion is about something else (a table, a file, a function).
 */
export function applyTicketEndpoint(text: string, facts: CriterionFacts, endpoints: TicketEndpoint | TicketEndpoint[] | undefined): CriterionFacts | undefined {
  const eps = Array.isArray(endpoints) ? endpoints : endpoints ? [endpoints] : [];
  if (!eps.length) return undefined;
  if (facts.routes.some((r) => r.method || !/[:{<]/.test(r.path))) return undefined;
  if (facts.tables.length || facts.columns.length) return undefined;
  // The endpoint whose method the criterion names first (`PATCH` stores ...), else the ticket's first.
  const named = new RegExp(`\\b(${METHODS})\\b`).exec(text)?.[1];
  const ep = (named && eps.find((e) => e.method === named)) || eps[0];
  const status = facts.statuses[0] ?? httpStatusIn(text);
  const explicitQuery = /(?:^|[\s`'"(])\?([\w.-]+=[^\s`'")]*(?:&[\w.-]+=[^\s`'")]*)*)/.exec(text)?.[1];
  const paramValues = ep.params
    .map((p) => new RegExp(`(?:^|[\\s\`'"(?&])${p.replace(/[.-]/g, '\\$&')}=([^\\s\`'",;)&]+)`).exec(text))
    .map((m, i) => (m ? `${ep.params[i]}=${m[1]}` : ''))
    .filter(Boolean);
  const query = explicitQuery ?? (paramValues.length ? paramValues.join('&') : '');
  const signal = status !== undefined || facts.statusWords.length > 0 || query !== '' || CALL_WORDS.test(text) || facts.routes.length > 0 || classifyKind(text, facts).kind === 'api';
  if (!signal) return undefined;
  if (status === undefined && (RX.unitWords.test(text) || facts.paths.length)) return undefined;
  const segments = new Set(ep.path.split('/').filter(Boolean).map((s) => s.toLowerCase()));
  return {
    ...facts,
    routes: [{ method: ep.method, path: query ? `${ep.path}?${query}` : ep.path }],
    statuses: facts.statuses.length ? facts.statuses : status !== undefined ? [status] : [],
    bodyFacts: facts.bodyFacts.filter((b) => !segments.has(b.toLowerCase()) && !b.includes('/') && !/^[\w.-]+=/.test(b)),
  };
}

// ---------------------------------------------------------------------------
// EARS rewrite
// ---------------------------------------------------------------------------

export interface EarsResult {
  ears: string;
  /** Facts the ticket does not give; each becomes a question. Empty when the rewrite is complete. */
  missing: string[];
}

const SYSTEMISH = /^(the\s+)?([\w-]+\s+){0,3}(system|service|api|endpoint|page|screen|app|application|job|worker|report|export|import|email|form|module|server|backend|frontend|ui|database|db|cli|command|function|handler|queue|scheduler|integration)$/i;

/** Rewrite a criterion into EARS form; placeholders name the facts that are missing. */
export function earsRewrite(text: string, system: string, facts: CriterionFacts = extractFacts(text), kind?: CriterionKind): EarsResult {
  const sys = system || 'system';
  const missing: string[] = [];
  const base = facts.trigger ? facts.trigger.rest : text.trim().replace(/[.;]$/, '');
  const clause = (s: string) => s.replace(/^then\s+/i, '').replace(/[.;]$/, '').trim();
  const parts = responseOf(clause(base), sys);
  const who = parts.subject ?? sys;
  let response = parts.response;
  for (const v of facts.vague) {
    const re = VAGUE.find(([, w]) => w === v)![0];
    response = response.replace(re, (w) => `${w} [measurable: ${placeholderFor(v)}]`);
    missing.push(`what "${v}" means as a measurable result (${placeholderFor(v)})`);
  }
  if (kind === 'nonfunctional' && !facts.measures.length && !facts.vague.length) {
    response = `${response} [measurable: a number with a unit, e.g. p95 latency in ms]`;
    missing.push('a number with a unit for the target (for example p95 latency in ms)');
  }
  if (kind === 'untestable' && !facts.vague.length) {
    response = `${response} [observable result: what a test would check]`;
    missing.push('the observable result a test would check');
  }
  let ears: string;
  const t = facts.trigger;
  if (t?.type === 'when') ears = `When ${clause(t.text)}, the ${who} shall ${response}.`;
  else if (t?.type === 'while') ears = `While ${clause(t.text)}, the ${who} shall ${response}.`;
  else if (t?.type === 'if') ears = `If ${clause(t.text)}, then the ${who} shall ${response}.`;
  else ears = `The ${who} shall ${response}.`;
  return { ears: ears.replace(/\s+/g, ' ').replace(/\.\.$/, '.'), missing };
}

/** Split "<subject> must <predicate>" into the EARS system (when the subject is one) and the response. */
function responseOf(s: string, sys: string): { subject?: string; response: string } {
  const m = /^(.*?)\b(must|should|shall|will|needs? to|has to|have to|can)\b\s+(?:be able to\s+)?(.+)$/i.exec(s);
  if (m) {
    const subject = m[1].trim();
    const pred = m[3].trim();
    if (!subject) return { response: pred };
    const bare = subject.replace(/^the\s+/i, '');
    if (bare.toLowerCase() === sys.toLowerCase()) return { response: pred };
    if (SYSTEMISH.test(subject)) return { subject: /^[A-Z]{2,}/.test(bare) ? bare : lowerFirst(bare), response: pred };
    return { response: `ensure that ${lowerFirst(subject)} ${pred}` };
  }
  return { response: `ensure that ${lowerFirst(s)}` };
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function placeholderFor(v: string): string {
  if (v === 'fast' || v === 'slow' || v === 'efficient' || v === 'responsive' || v === 'optimal') return 'a time limit, e.g. p95 under 500 ms';
  if (v === 'scalable') return 'a load, e.g. 200 requests per second with p95 under 500 ms';
  if (v === 'user-friendly' || v === 'intuitive' || v === 'easy' || v === 'simple' || v === 'nice' || v === 'modern' || v === 'clean' || v === 'seamless') return 'an observable UI fact, e.g. done in 3 clicks, or matching an existing screen';
  if (v === 'robust' || v === 'gracefully') return 'the failure behaviour, e.g. a 4xx with a message and nothing half-written';
  if (v === 'secure') return 'the security property, e.g. 401 without a token';
  return 'the exact expected value or behaviour';
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export interface RepoInfo {
  /** repoIdFor(path): the id used for runs/<repoId>/. */
  id: string;
  name: string;
  path: string;
  aliases: string[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  testScript?: string;
  testRunner?: 'jest' | 'vitest' | 'mocha' | 'node' | 'ava' | 'other';
}

const GENERIC_NAMES = new Set(['api', 'web', 'app', 'apps', 'core', 'common', 'lib', 'libs', 'src', 'server', 'client', 'frontend', 'backend', 'service', 'services', 'ui', 'db', 'database', 'shared', 'utils', 'tools', 'infra', 'docs', 'test', 'tests', 'main', 'site', 'admin', 'data', 'orders', 'order']);

function detectPm(repoPath: string, declared?: string): RepoInfo['packageManager'] {
  if (declared && declared !== 'unknown') return declared as RepoInfo['packageManager'];
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(repoPath, 'bun.lockb')) || fs.existsSync(path.join(repoPath, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(repoPath, 'package.json'))) return 'npm';
  return 'unknown';
}

function detectRunner(script: string | undefined): RepoInfo['testRunner'] {
  if (!script) return undefined;
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b|react-scripts test|craco test/.test(script)) return 'jest';
  if (/\bmocha\b/.test(script)) return 'mocha';
  if (/\bnode\b[^&|;]*--test\b/.test(script)) return 'node';
  if (/\bava\b/.test(script)) return 'ava';
  return 'other';
}

/** Repo facts from the config (and an extra repo path such as --repo). Reads each package.json (data only). */
export function repoInfos(config: Pick<HarnessConfig, 'repos'>, extraPaths: string[] = []): RepoInfo[] {
  const out: RepoInfo[] = [];
  const seen = new Set<string>();
  const add = (p: string, name?: string, pm?: string) => {
    const abs = path.resolve(p);
    const id = repoIdFor(abs);
    if (seen.has(id)) return;
    seen.add(id);
    const pkg = readJsonOr<{ name?: unknown; scripts?: Record<string, unknown> } | null>(path.join(abs, 'package.json'), null);
    const base = path.basename(abs);
    const nm = name || base;
    const aliases = new Set<string>([nm, base]);
    if (pkg && typeof pkg.name === 'string' && pkg.name) {
      aliases.add(pkg.name);
      aliases.add(pkg.name.replace(/^@[^/]+\//, ''));
    }
    const testScript = pkg && pkg.scripts && typeof pkg.scripts.test === 'string' ? (pkg.scripts.test as string) : undefined;
    out.push({ id, name: nm, path: abs, aliases: [...aliases].filter((a) => a.length >= 2), packageManager: detectPm(abs, pm), testScript, testRunner: detectRunner(testScript) });
  };
  for (const r of config.repos ?? []) if (r && typeof r.path === 'string') add(r.path, r.name, r.packageManager);
  for (const p of extraPaths) add(p);
  return out;
}

function aliasRegex(alias: string): RegExp {
  const parts = alias
    .toLowerCase()
    .split(/[-_\s/]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\@]/g, '\\$&'));
  const body = parts.join('[-_\\s]?');
  return new RegExp(`(?<![\\w-])@?${body}(?![\\w-])`, 'i');
}

/** How a text mentions a repo: by name/alias, by a path inside it, or not at all. */
export function mentionsRepo(text: string, repo: RepoInfo, paths: string[] = findPaths(text)): 'name' | 'path' | null {
  for (const a of repo.aliases) {
    const generic = GENERIC_NAMES.has(a.toLowerCase());
    if (!generic) {
      if (aliasRegex(a).test(text)) return 'name';
    } else {
      const re = new RegExp(`(?:\`${a}\`|\\b${a}/|\\b${a}\\s+(?:repo|repository|service))`, 'i');
      if (re.test(text)) return 'name';
    }
  }
  for (const p of paths) {
    const segs = p.split('/');
    if (repo.aliases.some((a) => segs.slice(0, -1).some((s) => s.toLowerCase() === a.toLowerCase().replace(/^@[^/]+\//, '')))) return 'path';
    if (!p.includes('*') && segs.length >= 2) {
      try {
        if (fs.existsSync(path.join(repo.path, p))) return 'path';
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function resourceTokens(facts: CriterionFacts): string[] {
  const toks = new Set<string>();
  for (const r of facts.routes) {
    const seg = r.path.split(/[/?]/).filter((s) => s && !/^(api|v\d+|:\w+|\{\w+\})$/i.test(s))[0];
    if (seg) toks.add(seg.toLowerCase());
  }
  for (const t of facts.tables) toks.add(t.toLowerCase());
  return [...toks];
}

function singular(s: string): string {
  return s.replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
}

export interface RepoMatch {
  repos: string[];
  how: 'mention' | 'path' | 'resource' | 'ticket' | 'default' | 'only-repo' | 'given' | 'none';
}

/** Repos for one criterion; `ticketRepos` are the repos the ticket as a whole mentions. */
export function mapCriterionRepos(text: string, facts: CriterionFacts, repos: RepoInfo[], ticketRepos: string[], defaultRepo?: string): RepoMatch {
  const direct = repos.filter((r) => mentionsRepo(text, r, facts.paths) === 'name').map((r) => r.id);
  const byPath = repos.filter((r) => !direct.includes(r.id) && mentionsRepo(text, r, facts.paths) === 'path').map((r) => r.id);
  if (direct.length || byPath.length) return { repos: [...direct, ...byPath], how: direct.length ? 'mention' : 'path' };
  const toks = resourceTokens(facts).map(singular);
  if (toks.length) {
    const cand = repos.filter((r) => r.aliases.some((a) => a.toLowerCase().split(/[-_\s/@]+/).map(singular).some((p) => toks.includes(p)))).map((r) => r.id);
    const inTicket = cand.filter((c) => ticketRepos.includes(c));
    if (inTicket.length === 1) return { repos: inTicket, how: 'resource' };
    if (cand.length === 1) return { repos: cand, how: 'resource' };
  }
  if (ticketRepos.length === 1) return { repos: ticketRepos, how: 'ticket' };
  if (defaultRepo && (ticketRepos.length === 0 || ticketRepos.includes(defaultRepo))) return { repos: [defaultRepo], how: 'default' };
  if (repos.length === 1) return { repos: [repos[0].id], how: 'only-repo' };
  return { repos: [], how: 'none' };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** One unclear point, before the ambiguity gate decides what to do with it. */
export interface Unclear {
  criterionId?: string;
  topic: 'repo' | 'route' | 'table' | 'status' | 'method' | 'measure' | 'meaning' | 'scope' | 'security' | 'privacy' | 'ux' | 'criteria' | 'behaviour';
  /** Plain-language statement of what is unclear. */
  detail: string;
  /** A command that finds the answer (observable). */
  command?: string;
  /** What the harness does without an answer (reasonable default). */
  assume?: string;
  /** Question text and options for forks and missing facts. */
  question?: string;
  options?: string[];
  /** Index into options. */
  recommended?: number;
  /** Work on the criterion waits for the answer (no check can be written without it). */
  blocking?: boolean;
  /** Impact 1..5 and uncertainty 1..3 for ordering questions. */
  impact?: number;
  uncertainty?: number;
}

export interface CheckResult {
  check?: CheckSpec;
  unclear: Unclear[];
}

function q(s: string): string {
  return /^[\w./:@{}-]+$/.test(s) ? s : JSON.stringify(s);
}

function methodFor(text: string): { method: string; assumed: boolean } {
  if (/\b(create[sd]?|submit(s|ted)?|add(s|ed)?|post(s|ed)?|register(s|ed)?|upload(s|ed)?|place[sd]?)\b/i.test(text)) return { method: 'POST', assumed: true };
  if (/\b(update[sd]?|edit(s|ed)?|change[sd]?|replace[sd]?|rename[sd]?)\b/i.test(text)) return { method: 'PATCH', assumed: true };
  if (/\b(delete[sd]?|remove[sd]?|cancel(s|led)?)\b/i.test(text)) return { method: 'DELETE', assumed: true };
  return { method: 'GET', assumed: true };
}

function defaultStatus(method: string, text: string): number {
  if (method === 'POST' && /\b(create[sd]?|add(s|ed)?|register(s|ed)?|place[sd]?)\b/i.test(text)) return 201;
  if (method === 'DELETE') return 204;
  return 200;
}

export function testCommand(repo: RepoInfo | undefined, testName: string): string | undefined {
  if (!repo || !repo.testScript) return undefined;
  const pm = repo.packageManager === 'unknown' ? 'npm' : repo.packageManager;
  const base = pm === 'npm' ? 'npm test --' : pm === 'bun' ? 'bun run test' : `${pm} test`;
  const name = JSON.stringify(testName);
  switch (repo.testRunner) {
    case 'jest':
    case 'vitest':
      return `${base} -t ${name}`;
    case 'mocha':
      return `${base} --grep ${name}`;
    case 'node':
      return `${base} --test-name-pattern ${name}`;
    case 'ava':
      return `${base} --match ${JSON.stringify(testName + '*')}`;
    default:
      return pm === 'npm' ? 'npm test' : `${pm} test`;
  }
}

function short(text: string, n = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** The command-line tool a repository builds: its package `bin` name, else the package or folder name. */
function cliToolName(repo: RepoInfo | undefined): string | undefined {
  if (!repo) return undefined;
  const pkg = readJsonOr<{ name?: unknown; bin?: unknown } | null>(path.join(repo.path, 'package.json'), null);
  const bin = pkg?.bin;
  if (typeof bin === 'string' && typeof pkg?.name === 'string') return pkg.name.replace(/^@[^/]+\//, '');
  if (bin && typeof bin === 'object') {
    const first = Object.keys(bin)[0];
    if (first) return first;
  }
  return repo.name;
}

/** The document a criterion names and the texts it must contain (quoted strings, else the flags it names). */
function docTarget(text: string, facts: CriterionFacts): { file?: string; needles: string[] } {
  const named = /([\w./-]+\.md)\b/i.exec(text)?.[1];
  const file = named ?? (/\breadme\b/i.test(text) ? 'README.md' : /\bchangelog\b/i.test(text) ? 'CHANGELOG.md' : /\bcontributing\b/i.test(text) ? 'CONTRIBUTING.md' : undefined);
  const quoted = facts.quoted.filter((x) => x.length >= 2 && !/\.md$/i.test(x));
  // a single-letter flag (`-v`) is a substring of many longer ones, so it is never a needle on its own
  const needles = quoted.length ? quoted : cliSignals(text).flags.filter((f) => !/^-[a-zA-Z]$/.test(f));
  return { ...(file ? { file } : {}), needles: [...new Set(needles)] };
}

/**
 * Why a criterion's check is green at the base commit, or undefined when it is not: its wording says so
 * (characterisation, no behaviour change, existing tests, documentation-only), or it is a document
 * criterion whose named text the named file already holds.
 */
export function greenAtBaseFor(text: string, facts: CriterionFacts, repo: RepoInfo | undefined): string | undefined {
  const wording = greenAtBaseByWording(text);
  if (wording) return wording;
  if (!isDocCriterion(text) || !repo) return undefined;
  const { file, needles } = docTarget(text, facts);
  if (!file || !needles.length) return undefined;
  const body = readTextOr(path.join(repo.path, file), null);
  if (body === null) return undefined;
  const norm = (t: string) => t.replace(/\s+/g, ' ').toLowerCase();
  const hay = norm(body);
  // whole tokens: `--verbose` does not hold `--verb`, and `-v` inside `--verbose` is not a `-v`
  const holds = (n: string) => new RegExp(`(?<![\\w-])${norm(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(hay);
  if (!needles.every(holds)) return undefined;
  return `${file} already holds ${needles.map((n) => `"${short(n, 40)}"`).join(', ')}, so the check passes before the change and must keep passing`;
}

/** The check for a criterion, plus the unclear points found while building it. */
export function checkFor(id: string, text: string, kind: CriterionKind, facts: CriterionFacts, repo: RepoInfo | undefined, ears?: EarsResult, ticket?: TicketText): CheckResult {
  const unclear: Unclear[] = [];
  const where = repo ? ` in ${repo.name}` : '';
  switch (kind) {
    case 'unit': {
      const proved = gateSpec(text, facts, ticket);
      if (proved) return { check: proved, unclear };
      const name = `${id}: ${short(text, 50)}`;
      const command = testCommand(repo, `${id}:`);
      const sig = cliSignals(text);
      let cli = '';
      if (isDocCriterion(text)) {
        const d = docTarget(text, facts);
        cli = ` that reads ${d.file ?? 'the named document'} and checks it contains ${d.needles.length ? d.needles.map((n) => `"${short(n, 40)}"`).join(', ') : 'the named text'}`;
      } else if (facts.commands.length) cli = ` that runs \`${facts.commands[0]}\` (the built command line or its entry point) and checks its output`;
      else if (!facts.routes.length && (sig.flags.length || sig.exit || sig.output)) {
        const tool = cliToolName(repo);
        cli = ` that runs the command-line tool${tool ? ` \`${tool}\`` : ''}${sig.flags.length ? ` with ${sig.flags.map((f) => `\`${f}\``).join(' ')}` : ''} (the built command line or its entry point) and checks its ${sig.exit && !sig.output ? 'exit code' : sig.exit ? 'exit code and output' : 'output'}`;
      }
      const noScript = command ? '' : repo ? ' (no test script in package.json: use the repo\'s test runner)' : '';
      const gab = greenAtBaseFor(text, facts, repo);
      if (gab) {
        const desc = `Unit test named "${name}"${where}${cli}; green at the base commit and must stay green after the change (green-at-base: ${gab})${noScript}`;
        return { check: { kind: 'unit', description: desc, ...(command ? { command } : {}), redFirst: false, greenAtBase: true, greenAtBaseReason: gab }, unclear };
      }
      const desc = `Unit test named "${name}"${where}${cli}; red at the base commit, green after the change${noScript}`;
      return { check: { kind: 'unit', description: desc, ...(command ? { command } : {}), redFirst: true }, unclear };
    }
    case 'api': {
      const route = facts.routes.find((r) => r.method) ?? facts.routes[0];
      let method = route?.method;
      if (!method) {
        const m = methodFor(text);
        method = m.method;
        unclear.push({ criterionId: id, topic: 'method', detail: `${id} names no HTTP method`, assume: `${id}: method ${method} (read from the wording)` });
      }
      const dbDown = dbDownCriterion(text);
      let status = facts.statuses[0];
      if (dbDown) {
        const d = dbDownStatus(text);
        status = d.status;
        if (!d.named) unclear.push({ criterionId: id, topic: 'status', detail: `${id} names no status code`, assume: `${id}: expected status ${status} while the database is unreachable` });
      }
      if (status === undefined) {
        status = facts.statusWords[0] ?? defaultStatus(method, text);
        unclear.push({ criterionId: id, topic: 'status', detail: `${id} names no status code`, assume: `${id}: expected status ${status} for ${method}${facts.statusWords.length ? ' (read from the wording)' : ''}` });
      }
      const routePath = route?.path ?? '<route>';
      if (!route) {
        const kw = (facts.bodyFacts[0] ?? text.split(/\s+/).find((w) => w.length > 4) ?? '').replace(/[^\w-]/g, '');
        unclear.push({
          criterionId: id,
          topic: 'route',
          detail: `${id} names no route; find it in the code before writing the check`,
          command: repo ? `git -C ${q(repo.path)} grep -n -i -e ${q(kw || 'router')} -- "*.ts" "*.js"` : `git grep -n -i -e ${q(kw || 'router')}`,
        });
      }
      const parts = ['harness verify drive', `--method ${method}`, `--path ${q(routePath)}`, `--expect-status ${status}`];
      const headers = findHeaders(text);
      const bodyFacts = facts.bodyFacts.filter((b) => !headers.some((h) => b.toLowerCase().includes(h.name.toLowerCase()) || h.name.toLowerCase().startsWith(b.toLowerCase()) || b === h.value));
      for (const b of bodyFacts.slice(0, 5)) parts.push(`--expect-body ${q(b)}`);
      for (const h of headers) parts.push(expectHeaderArg(h));
      const body = (bodyFacts.length ? `; body has ${bodyFacts.map((b) => `"${b}"`).join(', ')}` : '') + (headers.length ? `; header ${headers.map((h) => (h.value ? `${h.name} contains "${h.value}"` : `${h.name} present`)).join(', ')}` : '');
      const nf = facts.measures.find((m) => m.unit === 'ms' || m.unit === 's');
      if (nf) parts.push(`--repeat 20 --expect-${nf.metric && /^p\d+$/.test(nf.metric) ? nf.metric : 'p95'}-ms ${nf.unit === 's' ? nf.value * 1000 : nf.value}`);
      // the artefact is linked to this criterion by name (two criteria may share a route)
      parts.push(`--criterion ${id}`);
      if (dbDown) {
        // two run lines: start the services with the database unreachable, then drive the route
        return {
          check: { kind: 'e2e-http', description: `${method} ${routePath} -> ${status} while the database is unreachable${body}${where}`, command: ['harness verify launch --db-unreachable', parts.join(' ')].join('\n'), redFirst: true },
          unclear,
        };
      }
      // a status-only expectation on a known route: a live drive, or a unit test that names the route, proves it
      const statusOnly = !!route && !bodyFacts.length && !headers.length && !nf && !facts.tables.length && !facts.columns.length;
      if (statusOnly) {
        return {
          check: {
            kind: 'e2e-http',
            description: `${method} ${routePath} -> ${status}${where}; live drive, or a unit test named "${id}:" that names the route "${method} ${routePath}"`,
            command: parts.join(' '),
            redFirst: true,
            liveOptional: true,
            liveOptionalRoute: `${method} ${routePath}`,
          },
          unclear,
        };
      }
      return {
        check: { kind: 'e2e-http', description: `${method} ${routePath} -> ${status}${body}${where}`, command: parts.join(' '), redFirst: true },
        unclear,
      };
    }
    case 'db': {
      const table = facts.tables[0] ?? (facts.columns.find((c) => c.includes('.'))?.split('.')[0] ?? '<table>');
      const cols = facts.columns.map((c) => (c.includes('.') ? c.split('.')[1] : c));
      if (table === '<table>') {
        unclear.push({
          criterionId: id,
          topic: 'table',
          detail: `${id} names no table; find it in the schema or migrations`,
          command: repo ? `git -C ${q(repo.path)} grep -n -i -e "create table" -- "*.sql" "*migration*"` : 'git grep -n -i -e "create table"',
        });
      }
      const parts = ['harness verify db', `--table ${q(table)}`];
      if (cols.length) parts.push(`--expect-columns ${q(cols.join(','))}`);
      if (facts.rowCount !== undefined) parts.push(`--expect-rows ${facts.rowCount}`);
      parts.push(`--criterion ${id}`);
      const what = cols.length ? `${cols.length === 1 ? 'column' : 'columns'} ${cols.join(', ')}` : facts.rowCount !== undefined ? `${facts.rowCount} row(s)` : 'the expected rows';
      return { check: { kind: 'e2e-db', description: `Table ${table} has ${what} after the change (test database only)${where}`, command: parts.join(' '), redFirst: true }, unclear };
    }
    case 'ui-artifact': {
      const artifact = `${id.toLowerCase()}-${slug(short(text, 40)).slice(0, 40)}.png`;
      return {
        check: { kind: 'manual', description: `Manual: capture ${artifact} showing "${short(text, 70)}"${where}; the write-up links it`, redFirst: true },
        unclear,
      };
    }
    case 'nonfunctional': {
      const m = facts.measures[0];
      if (!m) {
        if (RX.nfSecurity.test(text)) {
          return { check: { kind: 'manual', description: `Manual: show evidence that "${short(text, 70)}"${where} (config, test or scan output)`, redFirst: true }, unclear };
        }
        unclear.push({
          criterionId: id,
          topic: 'measure',
          detail: `${id} has no number to measure against`,
          question: `${id} ("${short(text)}") gives no number. What target should the check use?`,
          options: ['p95 under 200 ms', 'p95 under 500 ms', 'p95 under 1 s', 'Another number: say which'],
          recommended: 1,
          blocking: true,
          impact: 3,
          uncertainty: 3,
        });
        return { unclear };
      }
      const route = facts.routes[0];
      const target = `${m.metric || 'value'} ${m.op} ${m.value} ${m.unit}`.trim();
      if (route && (m.unit === 'ms' || m.unit === 's')) {
        const ms = m.unit === 's' ? m.value * 1000 : m.value;
        const metric = m.metric && /^p\d+$/.test(m.metric) ? m.metric : 'p95';
        return {
          check: {
            kind: 'e2e-http',
            description: `${route.method ?? 'GET'} ${route.path}: ${metric} under ${ms} ms over 20 requests${where}`,
            command: `harness verify drive --method ${route.method ?? 'GET'} --path ${q(route.path)} --repeat 20 --expect-${metric}-ms ${ms} --criterion ${id}`,
            redFirst: true,
          },
          unclear,
        };
      }
      return { check: { kind: 'manual', description: `Measure before and after: ${target}${where}; record both numbers as an artifact`, redFirst: true }, unclear };
    }
    case 'untestable': {
      const e = ears ?? earsRewrite(text, repo?.name ?? 'system', facts, kind);
      unclear.push({
        criterionId: id,
        topic: 'meaning',
        detail: `${id} is not testable as written`,
        question: `${id} ("${short(text)}") is not testable as written. I would check: "${e.ears}". What should replace the bracketed part?`,
        options: optionsForMeaning(facts.vague),
        recommended: 0,
        blocking: true,
        impact: 4,
        uncertainty: 3,
      });
      return { unclear };
    }
  }
}

function optionsForMeaning(vague: string[]): string[] {
  const opts = meaningOptions(vague);
  return opts.includes('Drop it from this ticket') ? opts : [...opts, 'Drop it from this ticket'];
}

function meaningOptions(vague: string[]): string[] {
  const v = vague[0] ?? '';
  if (['fast', 'slow', 'efficient', 'responsive', 'optimal'].includes(v)) return ['p95 under 500 ms', 'p95 under 200 ms', 'p95 under 1 s', 'Another limit: say which'];
  if (['user-friendly', 'intuitive', 'easy', 'simple', 'nice', 'modern', 'clean', 'seamless'].includes(v))
    return ['Match the closest existing screen; you review the screenshot', 'Done in at most 3 clicks from the start page', 'Something else: say what to check'];
  if (['robust', 'gracefully'].includes(v)) return ['Errors return 4xx/5xx with a message and nothing is half-written', 'Retries 3 times, then reports the error', 'Something else: say what to check'];
  if (v === 'secure') return ['Requests without a valid token get 401', 'Only the owner can read it; others get 403', 'Something else: say what to check'];
  return ['Tell me the exact result to check', 'Treat it as a manual check you review in the write-up', 'Drop it from this ticket'];
}

/** Ticket-level and criterion-level forks: scope, security, privacy, UX, changed behaviour. */
export function forksFor(id: string, text: string, kind: CriterionKind, facts: CriterionFacts): Unclear[] {
  const out: Unclear[] = [];
  const scope = /\b(etc\.?|and so on|and more|everywhere|any other|all (?:other )?(?:endpoints|pages|screens|services|reports|places|cases|fields)|similar|as needed|where applicable|if possible|optionally|\(optional\)|nice to have|tbd|to be decided)\b|\?\s*$/i.exec(text);
  if (scope) {
    out.push({
      criterionId: id,
      topic: 'scope',
      detail: `${id} leaves the scope open ("${scope[0].trim()}")`,
      question: `${id} says "${scope[0].trim()}". What is in scope?`,
      options: ['Only what the ticket names explicitly', 'Everything matching the same pattern in the touched repos', 'A list I will give you'],
      recommended: 0,
      impact: 5,
      uncertainty: 2,
    });
  }
  const access = /\b(only (?:admins?|managers?|owners?|authori[sz]ed|logged[- ]in|signed[- ]in|staff|the owner)|permissions?|roles?|authori[sz](?:ed|ation)|access control|restricted|not (?:be )?(?:visible|accessible) to)\b/i.exec(text);
  if (access && !facts.statuses.some((s) => s === 401 || s === 403 || s === 404)) {
    out.push({
      criterionId: id,
      topic: 'security',
      detail: `${id} restricts access ("${access[0]}") without saying what others get`,
      question: `${id} restricts access. What should a caller without access get?`,
      options: ['403 Forbidden', '404 Not Found (hide that it exists)', '401 and a sign-in prompt'],
      recommended: 0,
      impact: 4,
      uncertainty: 2,
    });
  }
  const pii = /\b(email address(?:es)?|phone(?: number)?s?|home address(?:es)?|postal address(?:es)?|date of birth|personal data|pii|customer data|ssn|social security|iban|card numbers?|passwords?)\b/i.exec(text);
  const piiAction = /\b(log(?:s|ged)?|export(?:s|ed)?|share[sd]?|sen[dt] to|third[- ]party|analytics|display(?:s|ed)?|show(?:s|n)?|include[sd]?|stored?)\b/i.test(text);
  if (pii && piiAction && !/\b(mask(?:ed)?|redact(?:ed)?|hash(?:ed)?|omit(?:ted)?|without)\b/i.test(text)) {
    out.push({
      criterionId: id,
      topic: 'privacy',
      detail: `${id} touches personal data ("${pii[0]}")`,
      question: `${id} involves ${pii[0]}. How should it appear?`,
      options: ['Masked (for example j***@example.com)', 'In full', 'Left out'],
      recommended: 0,
      impact: 4,
      uncertainty: 2,
    });
  }
  if (kind === 'ui-artifact' && /\b(message|text|wording|label|copy|title|tooltip|placeholder|error message|notification)\b/i.test(text) && !facts.quoted.length) {
    out.push({
      criterionId: id,
      topic: 'ux',
      detail: `${id} names a text without its wording`,
      question: `${id} needs a text but gives no wording. Which wording?`,
      options: ['Follow the closest existing message; the write-up shows it', 'Use the wording I will give you'],
      recommended: 0,
      impact: 2,
      uncertainty: 2,
    });
  }
  if (/\b(existing behaviou?r|as (?:it is )?today|as before|unchanged|same as (?:before|now|today|the current)|still works?|no regressions?|backwards? compatible|keeps? working)\b/i.test(text)) {
    out.push({
      criterionId: id,
      topic: 'behaviour',
      detail: `${id} refers to current behaviour; record it at the base commit first (characterisation check)`,
      command: 'run the check at the base commit and keep its output as the expected result',
    });
  }
  return out;
}
