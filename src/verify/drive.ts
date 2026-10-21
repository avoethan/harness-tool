/**
 * `harness verify drive`: one HTTP request (or `--repeat n`) through Node's
 * fetch against a service of the run, with the auth slot filled by a login
 * recipe from the overlay, assertions on status, JSON paths, body text and
 * latency, and an artefact `e2e/<id>.json` (redacted by construction) whose
 * treeHash is the repository's working tree when it ran. Prints the
 * equivalent curl line. Exit 1 when an assertion fails.
 */
import * as path from 'node:path';
import { readTextOr } from '../lib/fsx';
import { instrument } from '../lib/log';
import { DROP_HEADERS, isSecretName, redactObject, redactText } from '../lib/redact';
import { loadBrief } from '../intake/brief';
import { criteriaForRepo } from '../gate/context';
import type { Criterion } from '../types';
import { artefactId, currentTree, redactBody, redactHeaders, routeSlug, writeArtefact, type Assertion, type HttpArtefact, type SchemaChange } from './artifact';
import { assertPath, checkTable, getPath, parseExpectation, parseLiteral, type Expectation } from './dbassert';
import { findRoute, loadFeatureMap, matchPath, type FeatureMap, type RouteEntry } from './featuremap';
import { loadOverlay, type LoginRecipe, type Overlay, type RouteRecipe } from './overlay';
import { planFromRun, recheckPlan } from './dbrun';
import { shellQuote } from './sqlcmd';
import { runDirOf, runFolder, saveRun, type ServiceRun, type VerifyContext, type VerifyRun } from './state';
import { writeTree } from '../lib/git';

export interface DriveOptions {
  method?: string;
  path?: string;
  /** `POST /orders` or a route id of the overlay. */
  route?: string;
  service?: string;
  body?: string;
  as?: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  expectStatus?: number;
  expectJson: string[];
  expectBody: string[];
  /** `Name=value` (exact), `Name~text` (contains), `Name=*` (present); the name is case-insensitive. */
  expectHeader?: string[];
  repeat?: number;
  expectPms: Partial<Record<'p50' | 'p95' | 'p99', number>>;
  criterion?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Skip the overlay recipe's expectations and side-effect checks. */
  noRecipe?: boolean;
}

export interface DriveResult {
  code: number;
  lines: string[];
  artefact?: HttpArtefact;
  files?: string[];
}

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;

/** `POST /orders` / ['POST', '/orders'] -> method and path. */
export function parseRouteArg(parts: string[]): { method: string; path: string } | null {
  const joined = parts.join(' ').trim();
  const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(joined);
  if (m && METHOD_RE.test(m[1])) return { method: m[1].toUpperCase(), path: m[2] };
  return null;
}

/** Fill `{{runId}}`, `{{last.<path>}}`, `{{env.NAME}}`, `{{base.<service>}}` in strings, deeply. */
export function fillTemplate(v: unknown, vars: { runId: string; last?: unknown; env: NodeJS.ProcessEnv; bases: Record<string, string> }, missing: string[] = []): unknown {
  if (typeof v === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(v);
    const resolve = (expr: string): unknown => {
      if (expr === 'runId') return vars.runId;
      if (expr.startsWith('last.')) return getPath(vars.last, expr.slice(5));
      if (expr === 'last') return vars.last;
      if (expr.startsWith('env.')) return vars.env[expr.slice(4)];
      if (expr.startsWith('base.')) return vars.bases[expr.slice(5)];
      return undefined;
    };
    if (whole) {
      const r = resolve(whole[1]);
      if (r === undefined) missing.push(whole[1]);
      return r;
    }
    return v.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => {
      const r = resolve(expr);
      if (r === undefined) {
        missing.push(expr);
        return '';
      }
      return typeof r === 'object' ? JSON.stringify(r) : String(r);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fillTemplate(x, vars, missing));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillTemplate(x, vars, missing)]));
  return v;
}

/** Replace `:name` / `{name}` segments; returns the names still missing. */
export function fillPath(pattern: string, params: Record<string, string>): { path: string; missing: string[] } {
  const missing: string[] = [];
  const out = pattern.replace(/:([A-Za-z_][\w]*)\??|\{([A-Za-z_][\w]*)\}/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    const v = params[name];
    if (v === undefined || v === '') {
      missing.push(name);
      return `:${name}`;
    }
    return encodeURIComponent(v);
  });
  return { path: out, missing };
}

export interface HeaderExpectation {
  name: string;
  op: '=' | '~' | 'present';
  value: string;
}

/** `Content-Type~text/csv`, `X-Total=3`, `ETag=*` -> a header expectation, or null when it is not one of the three forms. */
export function parseHeaderExpectation(s: string): HeaderExpectation | null {
  const m = /^\s*([A-Za-z0-9!#$%&'*+.^_`|-]+)\s*([=~])([\s\S]*)$/.exec(s);
  if (!m) return null;
  const value = m[3];
  if (m[2] === '=' && value === '*') return { name: m[1].toLowerCase(), op: 'present', value: '' };
  if (!value.length) return null;
  return { name: m[1].toLowerCase(), op: m[2] as '=' | '~', value };
}

/** Headers whose actual value is safe to record in an artefact; every other name records only matched / not matched. */
const SAFE_HEADER_VALUES = new Set(['content-type', 'content-disposition', 'content-length', 'content-encoding', 'cache-control', 'etag', 'vary', 'allow', 'accept-ranges', 'x-request-id', 'retry-after', 'content-language']);
export function headerValueIsRecordable(name: string): boolean {
  const n = name.toLowerCase();
  return SAFE_HEADER_VALUES.has(n) || n.startsWith('x-ratelimit-');
}

/** Judge one header expectation against a response. Values of secret-named headers are never recorded. */
export function assertHeader(e: HeaderExpectation, res: Pick<HttpResponse, 'headers' | 'setCookie'>): Assertion {
  const values = res.headers.filter(([k]) => k.toLowerCase() === e.name).map(([, v]) => v);
  if (e.name === 'set-cookie') for (const c of res.setCookie) if (!values.includes(c)) values.push(c);
  const present = values.length > 0;
  const joined = values.join(', ');
  const secret = DROP_HEADERS.has(e.name) || isSecretName(e.name);
  const shownValue = (v: string): string => (secret ? '[DROPPED]' : redactText(v));
  if (e.op === 'present') return { kind: 'header', expect: `${e.name} is present`, actual: present ? 'present' : 'absent', pass: present };
  const pass = present && (e.op === '=' ? values.some((v) => v === e.value) || joined === e.value : joined.includes(e.value));
  const expect = e.op === '=' ? `${e.name} = ${shownValue(e.value)}` : `${e.name} contains ${shownValue(e.value)}`;
  const actual = !present ? 'absent' : secret ? 'present (value not recorded)' : headerValueIsRecordable(e.name) ? redactText(joined).slice(0, 200) : pass ? 'matched' : 'not matched';
  return { kind: 'header', expect, actual, pass };
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

export interface HttpResponse {
  status: number;
  headers: Array<[string, string]>;
  text: string;
  ms: number;
  contentType: string;
  setCookie: string[];
}

export async function httpRequest(url: string, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<HttpResponse> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal, redirect: 'manual' });
    const text = await res.text();
    const ms = Math.round((performance.now() - start) * 10) / 10;
    const hs: Array<[string, string]> = [];
    res.headers.forEach((v, k) => hs.push([k, v]));
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    return { status: res.status, headers: hs, text, ms, contentType: res.headers.get('content-type') ?? '', setCookie: getSetCookie ? getSetCookie.call(res.headers) : [] };
  } finally {
    clearTimeout(t);
  }
}

/** The equivalent curl line (auth as a variable, body redacted). */
export function curlLine(method: string, url: string, headers: Record<string, string>, body: unknown, authHeader?: string): string {
  const argv = ['curl', '-sS', '-X', method, url];
  for (const [k, v] of Object.entries(headers)) argv.push('-H', `${k}: ${v}`);
  let line = shellQuote(argv);
  if (authHeader) line += ` -H "${authHeader}: $HARNESS_TOKEN"`;
  if (body !== undefined) line += ' ' + shellQuote(['--data-binary', typeof body === 'string' ? body : JSON.stringify(redactObject(body))]);
  return line;
}

/** Sign in with a login recipe; the token or cookie is used in memory only. */
export async function signIn(run: VerifyRun, overlay: Overlay, user: string, vars: Parameters<typeof fillTemplate>[1], timeoutMs: number): Promise<{ ok: boolean; header?: [string, string]; via?: string; error?: string }> {
  const u = overlay.users?.[user];
  if (!u) return { ok: false, error: `no login recipe for "${user}" under "users" in the feature-map overlay (\`harness verify maintain\` shows the overlay file)` };
  const login: LoginRecipe = u.login;
  const ra = parseRouteArg([login.route]);
  if (!ra) return { ok: false, error: `the login route of "${user}" is not "METHOD /path"` };
  const svc = run.services.find((s) => s.name === u.service) ?? run.services.find((s) => s.role === 'entry') ?? run.services[0];
  if (!svc) return { ok: false, error: 'no service is running' };
  const missing: string[] = [];
  const body = login.body !== undefined ? fillTemplate(login.body, vars, missing) : undefined;
  if (missing.length) return { ok: false, error: `the login recipe of "${user}" needs ${missing.join(', ')}` };
  let res: HttpResponse;
  try {
    res = await httpRequest(svc.baseUrl + ra.path, ra.method, body !== undefined ? { 'content-type': 'application/json' } : {}, body !== undefined ? JSON.stringify(body) : undefined, timeoutMs);
  } catch (e) {
    return { ok: false, error: `login request failed: ${(e as Error).message}` };
  }
  if (res.status >= 400) return { ok: false, error: `login answered ${res.status}` };
  if (login.cookie) {
    const c = res.setCookie.map((x) => x.split(';')[0]).join('; ');
    if (!c) return { ok: false, error: 'the login response set no cookie' };
    return { ok: true, header: ['cookie', c], via: `${login.route} (cookie)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ok: false, error: 'the login response is not JSON' };
  }
  const tok = getPath(parsed, login.tokenPath ?? 'token');
  if (typeof tok !== 'string' || !tok) return { ok: false, error: `no token at ${login.tokenPath ?? 'token'} in the login response` };
  const scheme = login.scheme === undefined ? 'Bearer' : login.scheme;
  return { ok: true, header: [(login.header ?? 'authorization').toLowerCase(), scheme ? `${scheme} ${tok}` : tok], via: login.route };
}

/** The brief criterion this request proves: --criterion, else the one whose run line names this method and route. */
export function matchCriterion(criteria: Criterion[], kind: 'http' | 'db', key: { method?: string; path?: string; table?: string }): string | undefined {
  const hits: string[] = [];
  for (const c of criteria) {
    const cmd = c.check?.command ?? '';
    if (kind === 'http' && c.check?.kind === 'e2e-http') {
      const m = /--method\s+(\S+)/.exec(cmd);
      const p = /--path\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(cmd);
      const cp = p ? p[1] ?? p[2] ?? p[3] : undefined;
      if (m && cp && key.method && key.path && m[1].toUpperCase() === key.method.toUpperCase() && (cp === key.path || matchPath(cp, key.path) || matchPath(key.path, cp))) hits.push(c.id);
    } else if (kind === 'db' && c.check?.kind === 'e2e-db') {
      const t = /--table\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(cmd);
      const ct = t ? t[1] ?? t[2] ?? t[3] : undefined;
      if (ct && key.table && ct.toLowerCase().replace(/^dbo\./, '') === key.table.toLowerCase().replace(/^dbo\./, '')) hits.push(c.id);
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

export function criteriaOfTask(taskId: string, repoId: string): Criterion[] {
  if (taskId === 'adhoc') return [];
  const b = loadBrief(taskId);
  return b ? criteriaForRepo(b, repoId) : [];
}

export const CRITERION_RE = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/;

/** Repositories of the run and their working trees (cross-repo artefacts carry all of them). */
export function treesOf(run: VerifyRun): Record<string, string> {
  const out: Record<string, string> = {};
  const roots = new Map<string, string>();
  roots.set(run.repoId, run.repoRoot);
  for (const s of run.services) if (!roots.has(s.repoId)) roots.set(s.repoId, s.path);
  for (const [rid, root] of roots) {
    const t = writeTree(root);
    if (t) out[rid] = t;
  }
  return out;
}

export function schemaChangesOf(run: VerifyRun): SchemaChange[] | undefined {
  const ch = (run.db?.migrations ?? []).filter((m) => m.changed).map((m) => ({ service: m.service, id: m.id, file: m.file, sha256: m.sha256 }));
  return ch.length ? ch : undefined;
}

/** Write an artefact into the run folder of each repository it concerns, each with that repository's tree. */
export function writeForRepos(run: VerifyRun, art: HttpArtefact | import('./artifact').DbArtefact, repoIds: string[], roots: Record<string, string>): string[] {
  const files: string[] = [];
  for (const rid of [...new Set(repoIds)]) {
    let dir: string;
    try {
      dir = rid === run.repoId ? runDirOf(run) : runFolder(rid, run.taskId);
    } catch {
      continue;
    }
    const tree = art.trees?.[rid] ?? currentTree(roots[rid] ?? run.repoRoot);
    files.push(writeArtefact(dir, { ...art, repoId: rid, treeHash: tree }));
  }
  return files;
}

export async function drive(ctx: VerifyContext, run: VerifyRun, o: DriveOptions): Promise<DriveResult> {
  const lines: string[] = [];
  const env = o.env ?? process.env;
  const timeoutMs = o.timeoutMs ?? 30_000;
  // 1. Which route.
  let method = o.method?.toUpperCase();
  let rawPath = o.path;
  if (o.route) {
    const ra = parseRouteArg([o.route]);
    if (!ra) return { code: 2, lines: [`"${o.route}" is not a route: write it as "METHOD /path" (for example "POST /orders").`] };
    method = method ?? ra.method;
    rawPath = rawPath ?? ra.path;
  }
  if (!method || !rawPath) return { code: 2, lines: ['Name the request: harness verify drive "POST /orders" or --method POST --path /orders.'] };
  if (!METHOD_RE.test(method)) return { code: 2, lines: [`Unknown HTTP method ${method}.`] };
  const map: FeatureMap | null = loadFeatureMap(run.repoId);
  const started = new Set(run.services.map((s) => s.name));
  let svc: ServiceRun | undefined = o.service ? run.services.find((s) => s.name === o.service) : undefined;
  if (o.service && !svc) return { code: 2, lines: [`The service ${o.service} is not part of run ${run.runId} (${[...started].join(', ')}).`] };
  let route: RouteEntry | null = null;
  if (map) {
    route = findRoute(map, method, rawPath, svc?.name);
    if (route && !svc) svc = run.services.find((s) => s.name === route!.service);
    if (!route && !svc) {
      for (const s of run.services) {
        const r2 = findRoute(map, method, rawPath, s.name);
        if (r2) {
          route = r2;
          svc = s;
          break;
        }
      }
    }
  }
  svc = svc ?? run.services.find((s) => s.role === 'entry') ?? run.services[0];
  if (!svc) return { code: 1, lines: ['The run has no service; launch again.'] };
  if (!svc.ready) lines.push(`Warning: ${svc.name} was not ready at launch (${svc.error ?? 'unknown'}).`);
  const routeKey = route ? route.id : `${method} ${rawPath}`;

  // 2. Recipe from the overlay of the route's repository.
  const overlay = loadOverlay(route?.repoId ?? svc.repoId).overlay;
  const recipe: RouteRecipe | null = o.noRecipe ? null : (route ? overlay.entries[route.id]?.recipe : overlay.entries[routeKey]?.recipe) ?? null;
  const vars = { runId: run.runId, last: run.last?.body, env, bases: Object.fromEntries(run.services.map((s) => [s.name, s.baseUrl])) };
  const missing: string[] = [];
  const recipeParams = recipe?.params ? (fillTemplate(recipe.params, vars, missing) as Record<string, string>) : {};
  const fp = fillPath(rawPath, { ...Object.fromEntries(Object.entries(recipeParams).map(([k, v]) => [k, String(v)])), ...o.params });
  if (fp.missing.length) return { code: 2, lines: [`The path ${rawPath} needs ${fp.missing.map((m) => `--param ${m}=<value>`).join(' ')} (or a concrete path such as ${rawPath.replace(/:([A-Za-z_]\w*)/g, '1')}).`] };
  const qs = new URLSearchParams({ ...(recipe?.query ? (fillTemplate(recipe.query, vars, missing) as Record<string, string>) : {}), ...o.query }).toString();
  const url = `${svc.baseUrl}${fp.path}${qs ? (fp.path.includes('?') ? '&' : '?') + qs : ''}`;

  // 3. Body.
  let body: unknown;
  if (o.body !== undefined) {
    if (o.body.startsWith('@')) {
      const text = readTextOr(path.resolve(ctx.cwd, o.body.slice(1)), null);
      if (text === null) return { code: 2, lines: [`Cannot read the body file ${o.body.slice(1)}.`] };
      body = parseLiteral(text.trim());
    } else body = parseLiteral(o.body);
  } else if (recipe?.body !== undefined && method !== 'GET' && method !== 'HEAD') body = fillTemplate(recipe.body, vars, missing);
  if (missing.length) return { code: 2, lines: [`The recipe for ${routeKey} needs values that are not available: ${[...new Set(missing)].join(', ')} (\`{{last.x}}\` reads the previous response of this run).`] };
  const headers: Record<string, string> = { accept: 'application/json', ...(recipe?.headers ? (fillTemplate(recipe.headers, vars) as Record<string, string>) : {}), ...o.headers };
  let bodyText: string | undefined;
  if (body !== undefined) {
    bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }

  // 4. Auth slot.
  const user = o.as ?? recipe?.auth;
  let authHeader: string | undefined;
  let auth: HttpArtefact['auth'];
  const sendHeaders = { ...headers };
  if (user) {
    const si = await signIn(run, overlay, user, vars, timeoutMs);
    if (!si.ok || !si.header) return { code: 1, lines: [`Sign-in as ${user} failed: ${si.error}`] };
    sendHeaders[si.header[0]] = si.header[1];
    authHeader = si.header[0];
    auth = { user, via: si.via ?? 'login recipe' };
  }

  // 5. Request(s).
  const n = Math.max(1, Math.min(o.repeat ?? 1, 1000));
  let first: HttpResponse | null = null;
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    let res: HttpResponse;
    try {
      res = await httpRequest(url, method, sendHeaders, bodyText, timeoutMs);
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? `no answer within ${timeoutMs} ms` : (e as Error).message;
      return { code: 1, lines: [...lines, `${method} ${url} failed: ${msg}. Is the service up? (\`harness verify doctor\`)`] };
    }
    if (!first) first = res;
    latencies.push(res.ms);
    statuses[String(res.status)] = (statuses[String(res.status)] ?? 0) + 1;
  }
  const res = first!;

  // 6. Assertions.
  const assertions: Assertion[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = undefined;
  }
  const expStatus = o.expectStatus ?? recipe?.expectStatus;
  if (expStatus !== undefined) {
    const allOk = Object.keys(statuses).every((s) => Number(s) === expStatus);
    assertions.push({ kind: 'status', expect: String(expStatus), actual: n > 1 ? Object.entries(statuses).map(([s, c]) => `${s}x${c}`).join(',') : String(res.status), pass: allOk });
  }
  const jsonExp: Expectation[] = [];
  for (const s of o.expectJson) {
    const e = parseExpectation(s);
    if (!e) return { code: 2, lines: [`--expect-json ${s}: write it as path=value (for example order.status=pending).`] };
    jsonExp.push(e);
  }
  if (!o.expectJson.length && !o.expectBody.length && recipe?.expect) {
    for (const [k, v] of Object.entries(fillTemplate(recipe.expect, vars) as Record<string, unknown>)) jsonExp.push({ path: k, op: '=', raw: typeof v === 'string' ? v : JSON.stringify(v), value: v });
  }
  for (const e of jsonExp) assertions.push(assertPath(parsed, e));
  for (const s of o.expectBody) {
    const e = parseExpectation(s);
    if (e && parsed !== undefined) assertions.push(assertPath(parsed, e, 'body'));
    else {
      const hasKey = parsed !== undefined && JSON.stringify(parsed).includes(`"${s}"`);
      const pass = res.text.includes(s) || hasKey;
      assertions.push({ kind: 'body', expect: `body has "${s}"`, actual: pass ? 'present' : 'absent', pass });
    }
  }
  for (const s of o.expectHeader ?? []) {
    const e = parseHeaderExpectation(s);
    if (!e) return { code: 2, lines: [`--expect-header ${s.slice(0, 20)}: write it as "Name=value" (exact), "Name~text" (contains) or "Name=*" (present).`] };
    assertions.push(assertHeader(e, res));
  }
  let repeat: HttpArtefact['repeat'];
  if (n > 1 || Object.keys(o.expectPms).length) {
    repeat = { n, statuses, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: Math.max(...latencies) };
    for (const [k, lim] of Object.entries(o.expectPms) as Array<['p50' | 'p95' | 'p99', number]>) assertions.push({ kind: k, expect: `${k} <= ${lim} ms over ${n} request(s)`, actual: `${repeat[k]} ms`, pass: repeat[k] <= lim });
  }
  // Side effects from the recipe (run database only).
  if (recipe?.db?.length && run.db && !o.noRecipe) {
    const pf = planFromRun(run.db, ctx.vcfg);
    const rc = pf.ok && pf.plan ? recheckPlan(pf.plan, ctx.config.db) : { ok: false, reason: pf.reason ?? 'no plan' };
    if (!pf.ok || !pf.plan || !rc.ok) assertions.push({ kind: 'db', expect: 'recipe side effects', actual: 'not checked', pass: false, detail: rc.reason });
    else {
      const lastNow = parsed;
      for (const d of recipe.db) {
        const where = d.where ? (fillTemplate(d.where, { ...vars, last: lastNow }) as Record<string, unknown>) : undefined;
        const expect = Object.entries(d.expect ? (fillTemplate(d.expect, { ...vars, last: lastNow }) as Record<string, unknown>) : {}).map(([k, v]) => ({ path: k, op: '=' as const, raw: typeof v === 'string' ? v : JSON.stringify(v), value: v }));
        const out = checkTable(pf.plan, { table: d.table, where, expect, expectRows: d.expectRows }, env);
        if (out.error) assertions.push({ kind: 'db', expect: `${d.table} side effect`, actual: 'error', pass: false, detail: out.error });
        else for (const a of out.assertions) assertions.push({ ...a, kind: `db:${d.table}:${a.kind}` });
      }
    }
  }
  if (!assertions.length) assertions.push({ kind: 'status', expect: '< 400 (no expectation given)', actual: String(res.status), pass: res.status < 400 });
  const pass = assertions.every((a) => a.pass);

  // 7. Artefact.
  const criteria = criteriaOfTask(run.taskId, route?.repoId ?? svc.repoId);
  let criterion = o.criterion;
  if (criterion && !CRITERION_RE.test(criterion)) return { code: 2, lines: [`--criterion ${criterion.slice(0, 40)} is not a criterion id.`] };
  if (!criterion) criterion = matchCriterion(criteria, 'http', { method, path: route?.path ?? rawPath }) ?? matchCriterion(criteria, 'http', { method, path: rawPath });
  const id = artefactId('http', criterion, routeSlug(method, route?.path ?? rawPath));
  const rh = redactHeaders(res.headers);
  const reqH = redactHeaders(sendHeaders);
  const rb = redactBody(res.text, res.contentType);
  const trees = treesOf(run);
  const art: HttpArtefact = {
    version: 1,
    id,
    kind: 'http',
    criterion,
    treeHash: trees[route?.repoId ?? svc.repoId] ?? '',
    trees,
    createdAt: new Date().toISOString(),
    pass,
    runId: run.runId,
    repoId: route?.repoId ?? svc.repoId,
    taskId: run.taskId,
    assertions,
    schemaChanges: schemaChangesOf(run),
    dbUnreachable: run.dbUnreachable || undefined,
    command: curlLine(method, url, headers, body, authHeader),
    service: svc.name,
    route: routeKey,
    method,
    url,
    status: res.status,
    latencyMs: res.ms,
    headers: rh.headers,
    droppedHeaders: [...new Set([...rh.dropped, ...(res.setCookie.length ? ['set-cookie'] : [])])].sort(),
    requestHeaders: reqH.headers,
    requestBody: body === undefined ? undefined : redactObject(body),
    body: rb.body,
    bodyText: rb.bodyText,
    bodyBytes: rb.bytes,
    bodyTruncated: rb.truncated,
    repeat,
    auth,
  };
  const roots: Record<string, string> = { [run.repoId]: run.repoRoot };
  for (const s of run.services) roots[s.repoId] = roots[s.repoId] ?? s.path;
  const files = writeForRepos(run, art, [art.repoId, run.repoId], roots);
  run.last = { status: res.status, body: rb.body ?? rb.bodyText, at: art.createdAt };
  saveRun(run);
  instrument({ event: 'verify.drive', repo: art.repoId, task: run.taskId, ids: { runId: run.runId, artefact: id }, counts: { status: res.status, assertions: assertions.length, failed: assertions.filter((a) => !a.pass).length, repeat: n } });

  lines.push(`${method} ${url} -> ${res.status} in ${res.ms} ms${n > 1 ? ` (x${n}: p50 ${repeat?.p50} ms, p95 ${repeat?.p95} ms)` : ''}`);
  lines.push(`curl: ${art.command}`);
  if (auth) lines.push(`auth: signed in as ${auth.user} via ${auth.via} (set HARNESS_TOKEN yourself to repeat the curl line)`);
  for (const a of assertions) lines.push(`  ${a.pass ? 'ok  ' : 'FAIL'} ${a.kind}: expected ${a.expect}${a.actual !== undefined ? `, got ${a.actual}` : ''}${a.detail ? ` (${a.detail})` : ''}`);
  if (art.schemaChanges) lines.push(`shared-schema changes recorded: ${art.schemaChanges.map((c) => `${c.service}/${c.id}`).join(', ')}`);
  lines.push(`artefact: e2e/${id}.json${criterion ? ` (criterion ${criterion})` : ''} ${pass ? 'PASS' : 'FAIL'}`);
  return { code: pass ? 0 : 1, lines, artefact: art, files };
}
