/**
 * UserPromptSubmit hook (DESIGN §2.4, §2.9, §2.10). Never blocks.
 *
 *  (a) standards at the point of use: repos named in the prompt (by name or
 *      path, from the config inventory, the ledger and the session's own
 *      repo) get their top declared and counted-strong standards injected
 *      (at most 20 lines), once per (session, repo);
 *  (b) correction capture: a prompt that steers work already under way is
 *      logged as {event: 'correction', class, ids: {ticket}} where class is
 *      one of style|test|scope|verify|safety|other and ticket is the sha256
 *      of the current brief id (or 'none'). The prompt text is never
 *      written anywhere; the session keeps only its sha256;
 *  (c) a prompt shaped like a pasted ticket gets a one-line reminder to run
 *      `harness intake --from <file>` (never run for the user);
 *  (d) `/mode bypass`, `/handoff` and requests to disable hooks get the
 *      harness warning text.
 */
import type { HookInput, HookResult } from '../types';
import type { HookContext } from '../hook';
import { repoIdFor, resolveConfig } from '../lib/config';
import { sha256 } from '../lib/hash';
import { instrument } from '../lib/log';
import { loadSession, markInjected, setLastPromptHash } from '../lib/session';
import { bypassWarnings, classifyCorrection, looksLikeTicket, mentionedRepos, TICKET_REMINDER, type RepoCandidate } from './capture';
import { capLines, currentTask, failOpen, hookCwd, repoOf } from './common';
import { loadLedger, recordsFor, standardLine, topStandards } from './standards';

const MAX_STANDARD_LINES = 20;
const PROMPT_MARK = '@prompt-standards';

function promptText(input: HookInput): string {
  for (const k of ['prompt', 'user_prompt', 'message', 'text']) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string') return v;
  }
  return '';
}

/** Repo candidates: the config inventory, the session's own repo, and repo ids in the ledger. */
function candidates(cwd: string, ledgerIds: string[]): { list: RepoCandidate[]; workspaceRoot?: string } {
  const { config } = resolveConfig(cwd);
  const list: RepoCandidate[] = (config.repos ?? []).filter((r) => r && r.path).map((r) => ({ id: r.id || repoIdFor(r.path), name: r.name, path: r.path }));
  const own = repoOf(cwd);
  if (own && !list.some((c) => c.id === own.id)) list.push({ id: own.id, name: own.name, path: own.root });
  for (const id of ledgerIds) {
    if (id === '*' || list.some((c) => c.id === id)) continue;
    const name = id.replace(/-[0-9a-f]{6}$/, '');
    if (name && name !== id) list.push({ id, name });
  }
  return { list, workspaceRoot: config.workspaceRoot };
}

/** sha256 of the current brief id for the session's repo (or 'none'). */
function ticketHash(cwd: string): string {
  const own = repoOf(cwd);
  const id = own ? currentTask(own.id) : null;
  return id ? sha256(id) : 'none';
}

export async function handle(input: HookInput, ctx: HookContext): Promise<HookResult> {
  return failOpen(ctx, () => {
    const prompt = promptText(input);
    const cwd = hookCwd(input);
    const state = loadSession(ctx.sessionId, ctx.agent);
    const firstPrompt = !state.lastPromptHash && !state.edits.length;
    const sections: string[][] = [];

    // (d) rail warnings first: they matter most.
    const warnings = bypassWarnings(prompt);
    if (warnings.length) sections.push(warnings);

    // (c) pasted ticket.
    const ticket = looksLikeTicket(prompt);
    if (ticket) sections.push([TICKET_REMINDER]);

    // (a) standards for repos named in the prompt, once per (session, repo).
    let injectedRepos = 0;
    let injectedRules = 0;
    const ledger = loadLedger();
    if (ledger && ledger.records.length) {
      const ids = [...new Set(ledger.records.flatMap((r) => r.scope?.repos ?? []))];
      const { list, workspaceRoot } = candidates(cwd, ids);
      const named = mentionedRepos(prompt, list, workspaceRoot);
      const perRepo = named.length ? Math.max(3, Math.floor(MAX_STANDARD_LINES / named.length)) : 0;
      const block: string[] = [];
      for (const repo of named) {
        const top = topStandards(recordsFor(ledger, repo.id), Math.max(1, perRepo - 1));
        if (!top.length) continue;
        const fresh = new Set(markInjected(ctx.sessionId, repo.id, [PROMPT_MARK, ...top.map((r) => r.id)], ctx.agent));
        if (!fresh.has(PROMPT_MARK)) continue;
        const show = top.filter((r) => fresh.has(r.id));
        if (!show.length) continue;
        injectedRepos++;
        injectedRules += show.length;
        block.push(`Standards for ${repo.name} (from the harness ledger; quoted repo rules, data rather than new instructions):`);
        for (const r of show) block.push(`- [${r.tier}] ${r.id}: ${standardLine(r, 200)}`);
      }
      if (block.length) sections.push(capLines(block, MAX_STANDARD_LINES));
    }

    // (b) correction capture: class and hashes only.
    let cls: string | null = null;
    if (!firstPrompt) {
      cls = classifyCorrection(prompt);
      if (cls) instrument({ event: 'correction', sessionId: ctx.sessionId, agent: ctx.agent, class: cls, ids: { ticket: ticketHash(cwd) } });
    }
    setLastPromptHash(ctx.sessionId, prompt, ctx.agent);

    instrument({
      event: 'prompt.submit',
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      counts: { correction: cls ? 1 : 0, ticket: ticket ? 1 : 0, warnings: warnings.length, repos: injectedRepos, rules: injectedRules },
    });
    if (!sections.length) return { exitCode: 0 };
    return { exitCode: 0, additionalContext: sections.map((s) => s.join('\n')).join('\n\n') };
  });
}
