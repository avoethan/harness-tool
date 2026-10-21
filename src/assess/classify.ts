/**
 * Classification (DESIGN 2.2): every line of every instruction file, rule,
 * skill and command gets KEEP / CONVERT / TRIM / FIX / SPLIT / QUARANTINE with
 * a reason and the check that drove it. The unit is the paragraph, list item,
 * code fence, table row or front-matter key, so lines that belong together get
 * the same class. Output is data: propose moves text by line, it never
 * rewrites the user's wording.
 *
 * Precedence inside a unit: QUARANTINE > FIX > (safety sentence: KEEP) >
 * SPLIT > CONVERT > TRIM > KEEP. A safety sentence is never trimmed or
 * converted away; it stays and is listed in the safety inventory. A file with
 * hidden Unicode or injection patterns (R10-R12) is QUARANTINE as a whole;
 * each line keeps the class it would otherwise have in `underlying`.
 */
import { docOf, proseFiles } from './checks';
import { sentences, unitText } from './markdown';
import { visibleLine } from './scan';
import { safetyTopic } from './safety';
import type { Classification, LineClassification } from '../types';
import type { AssessContext, InvFile, Mark } from './model';
import { CLASS_RANK } from './model';

const DEFAULT_REASON: Record<string, string> = {
  blank: 'blank line',
  heading: 'heading',
  hr: 'separator',
  'fm-delim': 'front matter',
  'fm-key': 'front matter',
  comment: 'comment with no instruction words',
  fence: 'code block; no check fired',
  'table-row': 'no check fired; kept as written',
  paragraph: 'no check fired; kept as written',
  'list-item': 'no check fired; kept as written',
};

/** Text of a line as stored in the report: hidden code points shown as <U+XXXX>, secrets redacted. */
export function storedLineText(s: string): string {
  return visibleLine(s);
}

function quarantineReason(ctx: AssessContext, f: InvFile, line: number): { check: string; reason: string } {
  const direct = ctx.findings.find((x) => x.file === f.abs && x.line === line && ['R10', 'R11', 'R12'].includes(x.check));
  if (direct) return { check: direct.check, reason: direct.check === 'R10' ? `hidden Unicode on this line (${(/: (U\+[0-9A-F]+[^.]*)\./.exec(direct.message) ?? ['', 'invisible characters'])[1]})` : direct.check === 'R11' ? 'HTML comment that reads like an instruction to an agent' : 'injection phrasing on this line' };
  const q = f.quarantine!;
  return { check: q.checks[0], reason: `quarantined line (${q.checks.join(', ')}); nothing from it is used until a person has looked at it` };
}

export function classifyAll(ctx: AssessContext): LineClassification[] {
  const out: LineClassification[] = [];
  const byFile = new Map<InvFile, Mark[]>();
  for (const m of ctx.marks) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  const files = [...proseFiles(ctx)].sort((a, b) => a.display.localeCompare(b.display));
  for (const f of files) {
    const doc = docOf(f);
    const marks = byFile.get(f) ?? [];
    for (const u of doc.units) {
      const inUnit = marks.filter((m) => m.line >= u.start && m.line <= u.end);
      let best: Mark | null = null;
      for (const m of inUnit) if (!best || CLASS_RANK[m.cls] > CLASS_RANK[best.cls]) best = m;
      let cls: Classification = 'KEEP';
      let reason = DEFAULT_REASON[u.kind] ?? 'kept as written';
      let check: string | undefined;
      if (best) {
        cls = best.cls === 'CONVERT' && best.partial ? 'SPLIT' : best.cls;
        reason = best.reason;
        check = best.check;
      }
      const isSafety = ['paragraph', 'list-item', 'table-row'].includes(u.kind) && sentences(unitText(u), { semicolons: false }).some((s) => !!safetyTopic(s));
      if (isSafety && CLASS_RANK[cls] < CLASS_RANK.FIX) {
        cls = 'KEEP';
        reason = 'safety rule: kept, listed in the safety inventory and promoted to a hard block where one exists';
        check = 'safety';
      }
      for (let n = u.start; n <= u.end; n++) {
        const rec: LineClassification = { file: f.abs, line: n, text: storedLineText(doc.lines[n - 1] ?? ''), cls, reason, unitStart: u.start, provenance: 'deterministic' };
        if (check) rec.check = check;
        // Quarantine is per line: the line that carries hidden Unicode, an
        // instruction-like HTML comment or injection phrasing is QUARANTINE
        // (never rendered anywhere); the file itself keeps its high finding and
        // `quarantine` marker, and its other lines are classified normally.
        if (f.quarantine && ctx.findings.some((x) => x.file === f.abs && x.line === n && ['R10', 'R11', 'R12'].includes(x.check))) {
          const q = quarantineReason(ctx, f, n);
          rec.underlying = cls;
          rec.cls = 'QUARANTINE';
          rec.check = q.check;
          rec.reason = q.reason;
        }
        out.push(rec);
      }
    }
  }
  return out;
}

export function classCounts(cls: LineClassification[]): Record<Classification, number> {
  const out: Record<Classification, number> = { KEEP: 0, CONVERT: 0, TRIM: 0, FIX: 0, SPLIT: 0, QUARANTINE: 0 };
  for (const c of cls) out[c.cls]++;
  return out;
}
