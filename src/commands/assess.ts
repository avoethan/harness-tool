/**
 * `harness assess` — read the existing agent setup and classify every line
 * (DESIGN 2.2). Deterministic and offline. Writes `assess.json` (AssessReport)
 * and `assess.md` to `~/.harness/assess/` (or `--out <dir>`).
 *
 *   harness assess [--workspace <dir>] [--setting team|personal]
 *                  [--agents devin,claude,codex] [--include <dir>]...
 *                  [--json] [--out <dir>]
 *   harness assess --judgment            also write an escaped evidence bundle for the driving agent
 *   harness assess --import-judgment <id>  merge the agent's result.json (validated, re-scanned)
 *
 * Exit 0 always unless the arguments are wrong (2): findings are data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandMeta } from '../cli';
import { ALL_AGENTS, type AgentId, type AssessReport, type Setting } from '../types';
import { flagBool, flagList, flagStr, parseArgv } from '../lib/argv';
import { loadConfig } from '../lib/config';
import { writeJson, writeTextAtomic } from '../lib/fsx';
import { instrument } from '../lib/log';
import { harnessHome, userHome } from '../lib/paths';
import { runAssess } from '../assess/index';
import { classCounts } from '../assess/classify';
import { renderMarkdown } from '../assess/report';
import { importJudgment, writeJudgmentBundle, JUDGMENT_ID_RE } from '../assess/judgment';
import { displayPath } from '../assess/inventory';

export const meta: CommandMeta = {
  name: 'assess',
  summary: 'Read the existing agent setup and classify every line',
  usage: 'harness assess [--workspace <dir>] [--setting team|personal] [--agents devin,claude,codex] [--include <dir>]... [--json] [--out <dir>] [--judgment | --import-judgment <id>]',
  examples: ['harness assess', 'harness assess --workspace ~/work --include ~/notes/agent-rules', 'harness assess --judgment', 'harness assess --import-judgment 3f2a9c1b7d4e'],
};

const BOOLEANS = new Set(['json', 'judgment', 'help', 'h']);

function usage(msg: string): number {
  process.stderr.write(`assess: ${msg}\nUsage: ${meta.usage}\n`);
  return 2;
}

export function outDir(flag?: string): string {
  return flag ? path.resolve(flag) : path.join(harnessHome(), 'assess');
}

function writeOutputs(dir: string, report: AssessReport, markdown: string): { json: string; md: string } {
  const json = path.join(dir, 'assess.json');
  const md = path.join(dir, 'assess.md');
  writeJson(json, report);
  writeTextAtomic(md, markdown);
  return { json, md };
}

function summary(report: AssessReport, paths: { json: string; md: string }, ctx: { workspace: string; userHome: string }): string {
  const sev = (s: string) => report.findings.filter((f) => f.severity === s).length;
  const c = classCounts(report.classifications);
  const lines: string[] = [];
  lines.push(`Assessed ${report.files.length} agent files in ${report.workspaceRoot} (${report.setting}; ${(report.agents ?? []).join(', ')}).`);
  for (const a of ALL_AGENTS) {
    const l = report.loaded[a];
    if (!l) continue;
    lines.push(`  ${a.padEnd(6)} loads ${l.files.length} file${l.files.length === 1 ? '' : 's'}, ${l.lines} lines, ${l.bytes} bytes at session start${l.limit ? ` (limit ${l.limit} bytes${a === 'devin' ? ', measured on Devin CLI 3000.11.92' : ''})` : ''}`);
  }
  lines.push(`Findings: ${sev('high')} high, ${sev('warn')} warn, ${sev('info')} info.`);
  for (const f of report.findings.filter((x) => x.severity === 'high').slice(0, 10)) lines.push(`  high ${f.check} ${displayPath(ctx, f.file)}${f.line ? `:${f.line}` : ''}  ${f.message}`);
  if (sev('high') > 10) lines.push(`  … ${sev('high') - 10} more in the report`);
  lines.push(`Lines: KEEP ${c.KEEP}, CONVERT ${c.CONVERT}, TRIM ${c.TRIM}, FIX ${c.FIX}, SPLIT ${c.SPLIT}, QUARANTINE ${c.QUARANTINE}.`);
  lines.push(`Safety rules found: ${report.safetyRules.length} (kept; later steps only add to them).`);
  if (report.neverLoaded.length) lines.push(`Never loaded by any agent: ${report.neverLoaded.length} file(s).`);
  lines.push(`Wrote ${paths.json}`);
  lines.push(`Wrote ${paths.md}`);
  return lines.join('\n') + '\n';
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgv(argv, BOOLEANS);
  if (p.positional.length) return usage(`unexpected argument: ${p.positional[0]}`);
  const known = new Set(['workspace', 'setting', 'agents', 'include', 'json', 'out', 'judgment', 'import-judgment', 'help', 'h']);
  for (const k of Object.keys(p.flags)) if (!known.has(k)) return usage(`unknown flag --${k}`);
  for (const k of ['workspace', 'setting', 'out', 'import-judgment']) {
    const v = p.flags[k];
    if (v === true || v === false || Array.isArray(v)) return usage(`--${k} needs one value`);
  }
  const cfg = loadConfig();
  const out = outDir(flagStr(p, 'out'));
  const json = flagBool(p, 'json');

  const importId = flagStr(p, 'import-judgment');
  if (importId !== undefined) {
    if (!JUDGMENT_ID_RE.test(importId)) return usage('--import-judgment needs the bundle id printed by `harness assess --judgment`');
    const r = importJudgment(importId, out);
    if (!r.ok) {
      process.stderr.write(`assess: ${r.error}\n`);
      return 1;
    }
    const ctx = { workspace: r.report.workspaceRoot ?? process.cwd(), userHome: userHome() };
    const paths = writeOutputs(out, r.report, renderMarkdown(r.report, ctx));
    instrument({ event: 'assess.import-judgment', ids: { bundle: importId }, counts: { accepted: r.accepted, rejected: r.rejected.length } });
    if (json) process.stdout.write(JSON.stringify({ accepted: r.accepted, rejected: r.rejected }, null, 2) + '\n');
    else {
      process.stdout.write(`Judgment ${importId}: ${r.accepted} item(s) merged, ${r.rejected.length} rejected.\n`);
      for (const x of r.rejected.slice(0, 20)) process.stdout.write(`  rejected ${x.id}: ${x.reason}\n`);
      process.stdout.write(`Wrote ${paths.json}\nWrote ${paths.md}\n`);
    }
    return 0;
  }

  const workspace = path.resolve(flagStr(p, 'workspace') ?? cfg?.workspaceRoot ?? process.cwd());
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) return usage(`workspace ${workspace} is not a folder`);
  const settingRaw = flagStr(p, 'setting') ?? cfg?.setting ?? 'team';
  if (settingRaw !== 'team' && settingRaw !== 'personal') return usage('--setting must be team or personal');
  const setting = settingRaw as Setting;
  const agentsRaw = flagList(p, 'agents');
  const agents = (agentsRaw.length ? agentsRaw : (cfg?.agents ?? ALL_AGENTS)) as AgentId[];
  const bad = agents.filter((a) => !ALL_AGENTS.includes(a));
  if (bad.length) return usage(`unknown agent ${bad.join(', ')} (use devin, claude, codex)`);
  const includes = [...flagList(p, 'include').map((x) => path.resolve(x)), ...(cfg?.include ?? [])];

  const result = runAssess({ workspace, setting, agents, includes });
  const paths = writeOutputs(out, result.report, result.markdown);
  let bundle: { id: string; dir: string; items: number } | null = null;
  if (flagBool(p, 'judgment')) bundle = writeJudgmentBundle(result.report, result.ctx, paths.json);
  const r = result.report;
  instrument({
    event: 'assess.run',
    counts: {
      files: r.files.length,
      findings: r.findings.length,
      high: r.findings.filter((f) => f.severity === 'high').length,
      lines: r.classifications.length,
      safetyRules: r.safetyRules.length,
      neverLoaded: r.neverLoaded.length,
    },
    ids: bundle ? { judgment: bundle.id } : undefined,
  });
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write(summary(r, paths, result.ctx));
    if (bundle) {
      process.stdout.write(`Judgment bundle ${bundle.id}: ${bundle.items} item(s) in ${bundle.dir}\n`);
      process.stdout.write(`  Have the agent follow ${path.join(bundle.dir, 'prompt.md')}, then run: harness assess --import-judgment ${bundle.id}\n`);
    }
  }
  return 0;
}
