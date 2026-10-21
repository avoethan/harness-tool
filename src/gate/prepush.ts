/**
 * The git pre-push refusal of history rewrites (DESIGN §2.10 "No force-push
 * or history rewrite": git pre-push hooks in the personal setting, R-68).
 *
 * git runs the pre-push hook with one line per ref on standard input:
 *
 *   <local ref> SP <local sha> SP <remote ref> SP <remote sha> LF
 *
 * A line is refused when
 *   - it deletes the remote ref (local sha all zeros), or
 *   - the remote ref exists (remote sha not all zeros) and its commit is not
 *     an ancestor of the pushed commit: a forced, non-fast-forward update.
 *     When the remote commit is not known locally the update cannot be shown
 *     to be a fast-forward, so it is refused too (fail closed; fetch first).
 *
 * This is the layer that holds when the agent's hooks are bypassed: the
 * guard denies `git push --force` before it runs, and this hook refuses the
 * same push from any process that still runs git's hooks. A push that skips
 * hooks (`--no-verify`, `core.hooksPath`) is the guard's to deny.
 */
import * as fs from 'node:fs';
import { rawGit } from '../lib/git';

export interface PushLine {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface PushRefusal {
  remoteRef: string;
  why: 'delete' | 'non-fast-forward' | 'unknown-remote-commit' | 'malformed';
}

const ZERO_RE = /^0+$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/** Lines of the pre-push input; blank lines are skipped, malformed ones kept for refusal. */
export function parsePushLines(text: string): Array<PushLine | { malformed: string }> {
  const out: Array<PushLine | { malformed: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4 || !SHA_RE.test(parts[1]) || !SHA_RE.test(parts[3])) {
      out.push({ malformed: line.slice(0, 80) });
      continue;
    }
    out.push({ localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] });
  }
  return out;
}

/** The refusals for the pushed refs (empty when every update is a creation or a fast-forward). */
export function checkPushLines(root: string, lines: Array<PushLine | { malformed: string }>): PushRefusal[] {
  const refused: PushRefusal[] = [];
  for (const l of lines) {
    if ('malformed' in l) {
      refused.push({ remoteRef: l.malformed.split(/\s+/)[2] ?? '(unknown)', why: 'malformed' });
      continue;
    }
    if (ZERO_RE.test(l.localSha)) {
      refused.push({ remoteRef: l.remoteRef, why: 'delete' });
      continue;
    }
    if (ZERO_RE.test(l.remoteSha)) continue; // a new ref on the remote
    if (l.remoteSha.toLowerCase() === l.localSha.toLowerCase()) continue;
    const known = rawGit(root, ['cat-file', '-e', `${l.remoteSha}^{commit}`], 10_000);
    if (known.code !== 0) {
      refused.push({ remoteRef: l.remoteRef, why: 'unknown-remote-commit' });
      continue;
    }
    const anc = rawGit(root, ['merge-base', '--is-ancestor', l.remoteSha, l.localSha], 30_000);
    if (anc.code !== 0) refused.push({ remoteRef: l.remoteRef, why: 'non-fast-forward' });
  }
  return refused;
}

/** The hook's standard input; empty when it is a terminal (a hand-run `harness gate --hook pre-push`). */
export function readHookInput(): string {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function refusalMessage(refused: PushRefusal[]): string {
  const why: Record<PushRefusal['why'], string> = {
    delete: 'deletes the remote branch or tag',
    'non-fast-forward': 'is not a fast-forward of the remote commit (a forced push rewrites history)',
    'unknown-remote-commit': 'replaces a remote commit this clone does not have, so it cannot be shown to be a fast-forward (fetch and merge first)',
    malformed: 'could not be read from the pre-push input',
  };
  const lines = refused.map((r) => `  ${r.remoteRef}: ${why[r.why]}`);
  return `harness: push refused (no force-push or history rewrite):\n${lines.join('\n')}\nPush a new commit on top instead: merge the remote branch in, commit, and push without --force.\n`;
}
