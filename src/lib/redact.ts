/**
 * Secret detection and redaction by construction.
 * Patterns are deliberately broad: a false positive costs a redaction, a miss leaks a secret.
 */

const SECRET_NAME = /(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|auth|cookie|session[_-]?id|bearer)/i;

export const DROP_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization']);

const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'connection-string-password', re: /(password|pwd)\s*=\s*[^;\s"']{3,}/i },
  { name: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: 'generic-assignment', re: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}["']?/i },
];

export interface SecretHit {
  name: string;
  index: number;
  sample: string;
}

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of VALUE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      hits.push({ name, index: m.index, sample: m[0].slice(0, 6) + '…' });
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function redactText(text: string): string {
  let out = text;
  for (const { re } of VALUE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    out = out.replace(g, '[REDACTED]');
  }
  return out;
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Drop secret-named headers and fields; returns a new object. Nested objects are walked. */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_HEADERS.has(k.toLowerCase()) || isSecretName(k)) {
        out[k] = '[DROPPED]';
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out as T;
  }
  if (typeof value === 'string') return redactText(value) as unknown as T;
  return value;
}

/** Files whose names mean key material or env secrets. */
export const SECRET_FILE_RE = /(^|[\\/])(\.env(\..+)?|[^\\/]*\.(pem|key|p12|pfx|jks|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;

export function isSecretFile(p: string): boolean {
  return SECRET_FILE_RE.test(p.replace(/\\/g, '/'));
}
