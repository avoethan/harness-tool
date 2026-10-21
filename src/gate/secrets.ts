/**
 * Step 2, secret scan over the diff and over the evidence folder (DESIGN
 * §2.10 "no secrets in commits or logs").
 *
 * Only lines the change adds are scanned (a secret already at the base is
 * not this change's doing). Secret-file names (key files, `.env`) added to
 * the tree fail too; `.env.example`-style templates are content-scanned
 * only. The evidence folder (E2E artefacts, run.env, the write-up) is
 * scanned in full; the files the gate itself writes are skipped.
 * Findings name the pattern and the file, never the value.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateContext } from './context';
import { entriesDigest } from './cache';
import { findSecrets, isSecretFile } from '../lib/redact';
import { sha256 } from '../lib/hash';
import { scanHiddenUnicode, stripHiddenUnicode } from '../lib/unicode';
import { capReasons, fail, pass, type StepDef, type StepOutcome } from './steps';

const TEMPLATE_ENV = /(^|\/)\.env\.(?:example|sample|template|dist|defaults)$/i;
/** Files the gate writes into the run folder itself (never scanned, never part of the cache key). */
export const GATE_OWNED = new Set(['evidence.json', 'gate-cache.json', 'cap.json']);
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

export interface SecretFinding {
  file: string;
  line?: number;
  pattern: string;
}

/** Secret-shaped text in added lines. `added` maps file -> added lines. */
export function scanAddedLines(added: Map<string, Array<{ line: number; text: string }>>): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const [file, lines] of added) {
    for (const l of lines) {
      for (const h of findSecrets(l.text)) out.push({ file, line: l.line, pattern: h.name });
    }
  }
  return out;
}

/** Every file under the evidence folder except the gate's own (relative paths). */
export function evidenceFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        const rel = path.relative(runDir, p).split(path.sep).join('/');
        if (!GATE_OWNED.has(rel)) out.push(rel);
      }
    }
  };
  walk(runDir, 0);
  return out.sort();
}

/** Secret-shaped text in the evidence folder. */
export function scanEvidence(runDir: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const rel of evidenceFiles(runDir)) {
    const p = path.join(runDir, rel);
    let text: string;
    try {
      if (fs.statSync(p).size > MAX_EVIDENCE_BYTES) {
        out.push({ file: `evidence ${rel}`, pattern: 'oversized (not scanned; evidence bodies are capped)' });
        continue;
      }
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const h of findSecrets(text)) {
      if (seen.has(h.name)) continue;
      seen.add(h.name);
      const line = text.slice(0, h.index).split('\n').length;
      out.push({ file: `evidence ${rel}`, line, pattern: h.name });
    }
  }
  return out;
}

function evidenceDigest(runDir: string): string {
  const parts: string[] = [];
  for (const rel of evidenceFiles(runDir)) {
    try {
      const st = fs.statSync(path.join(runDir, rel));
      parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* gone */
    }
  }
  return sha256(parts.join('\n'));
}

export function runSecrets(ctx: GateContext): StepOutcome {
  const reasons: string[] = [];
  for (const d of ctx.diff) {
    if (d.status === 'D') continue;
    if (isSecretFile(d.path) && !TEMPLATE_ENV.test(d.path)) reasons.push(`${d.path}: a secret or key file is part of the change (remove it and add it to .gitignore)`);
  }
  for (const f of scanAddedLines(ctx.addedLines())) reasons.push(`${f.file}:${f.line}: secret-shaped text (${f.pattern}) added`);
  // Hidden Unicode (bidi controls, zero-width, tag characters) can make code read differently from how it runs.
  for (const d of ctx.diff) {
    if (d.status !== 'D' && scanHiddenUnicode(d.path).length) reasons.push(`${stripHiddenUnicode(d.path)}: the file name carries hidden Unicode characters`);
  }
  for (const [file, lines] of ctx.addedLines()) {
    for (const l of lines) {
      const hits = scanHiddenUnicode(l.text);
      if (hits.length) {
        reasons.push(`${stripHiddenUnicode(file)}:${l.line}: hidden Unicode added (${[...new Set(hits.map((h) => h.kind))].join(', ')})`);
        break;
      }
    }
  }
  for (const f of scanEvidence(ctx.runDir)) reasons.push(`${f.file}${f.line ? `:${f.line}` : ''}: secret-shaped text (${f.pattern})`);
  if (reasons.length) return fail(capReasons(reasons));
  return pass(`${ctx.addedLines().size} changed file(s) and ${evidenceFiles(ctx.runDir).length} evidence file(s) scanned; no secret-shaped text or hidden Unicode`);
}

export const secretsStep: StepDef = {
  name: 'secrets',
  design: 2,
  group: 'secrets',
  cacheFail: true,
  inputs: (ctx) => {
    const touched = new Set(ctx.diff.map((d) => d.path));
    return [entriesDigest(ctx.entries, (p) => touched.has(p)), entriesDigest(ctx.baseEntries, (p) => touched.has(p) || ctx.diff.some((d) => d.oldPath === p)), evidenceDigest(ctx.runDir)];
  },
  run: runSecrets,
};
