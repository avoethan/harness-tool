/**
 * A temporary checkout of the base commit, for proving acceptance tests red
 * and for measuring the base's coverage: `git worktree add --detach` into a
 * temp folder outside the repository (git hooks off), the repository's
 * node_modules linked in (nothing installed), removed and pruned afterwards.
 * The user's working tree and index are never touched. The gate's baseline
 * (src/gate/baseline.ts) keeps one open for a whole run (`openBaseCheckout`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rawGit } from '../lib/git';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function symlink(target: string, at: string): boolean {
  try {
    let type: 'junction' | 'dir' | 'file' = LINK_TYPE;
    try {
      if (!fs.statSync(target).isDirectory()) type = 'file';
    } catch {
      /* dangling: keep the dir type */
    }
    fs.symlinkSync(target, at, type);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror one node_modules folder into the checkout as a folder of links.
 * Entries that are workspace links (symlinks into the repository itself,
 * outside node_modules, as npm/yarn/pnpm workspaces create them) are
 * re-pointed at the same path inside the checkout, so a workspace package
 * resolves to the checkout's version of it, not the working tree's.
 */
function mirrorNodeModules(root: string, wt: string, rel: string): number {
  const src = path.join(root, rel);
  const dst = path.join(wt, rel);
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const linkEntry = (srcEntry: string, dstEntry: string) => {
    let target = srcEntry;
    try {
      if (fs.lstatSync(srcEntry).isSymbolicLink()) {
        const real = fs.realpathSync(srcEntry);
        const inside = path.relative(realRoot, real);
        if (inside && !inside.startsWith('..') && !path.isAbsolute(inside) && !inside.split(path.sep).includes('node_modules')) target = path.join(wt, inside);
      }
    } catch {
      /* dangling link: link it as it is */
    }
    if (symlink(target, dstEntry)) n++;
  };
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.name.startsWith('@') && e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      for (const sub of fs.readdirSync(s)) linkEntry(path.join(s, sub), path.join(d, sub));
    } else linkEntry(s, d);
  }
  return n;
}

/** Link every node_modules folder of the repository (to depth 3) into the checkout. Returns the links made. */
export function linkNodeModules(root: string, wt: string): number {
  let n = 0;
  const walk = (rel: string, depth: number) => {
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') {
        const target = path.join(wt, childRel);
        if (fs.existsSync(path.dirname(target)) && !fs.existsSync(target)) {
          try {
            n += mirrorNodeModules(root, wt, childRel);
          } catch {
            /* best effort: fall back to one link for the whole folder */
            if (!fs.existsSync(target) && symlink(path.join(root, childRel), target)) n++;
          }
        }
        continue;
      }
      if (depth >= 3 || e.name.startsWith('.') || /^(?:dist|build|coverage)$/.test(e.name)) continue;
      walk(childRel, depth + 1);
    }
  };
  walk('', 0);
  return n;
}

let checkouts = 0;

/** How many base checkouts this process has made (tests read it to prove the baseline cache works). */
export function checkoutCount(): number {
  return checkouts;
}

export interface BaseCheckout {
  /** The checkout's folder. */
  wt: string;
  /** Remove the checkout and prune it from git's worktree list. Safe to call twice. */
  close(): void;
}

/**
 * Check `base` out at a temporary path and leave it open until `close()`;
 * files from `overlay` (repo-relative path -> text) are written into it first.
 */
export function openBaseCheckout(root: string, base: string, overlay: Map<string, string> = new Map()): { ok: true; checkout: BaseCheckout } | { ok: false; error: string } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-base-')));
  const wt = path.join(tmp, 'base');
  const hooks = path.join(tmp, 'no-hooks');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rawGit(root, ['worktree', 'remove', '--force', wt], 60_000);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp */
    }
    rawGit(root, ['worktree', 'prune'], 30_000);
  };
  try {
    fs.mkdirSync(hooks);
    checkouts++;
    const add = rawGit(root, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '--detach', '--force', '-q', wt, base], 300_000);
    if (add.code !== 0) {
      close();
      return { ok: false, error: `could not check out the base commit into a temporary worktree: ${add.stderr.trim().split('\n').pop() ?? ''}` };
    }
    for (const [rel, text] of overlay) {
      const dst = path.join(wt, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, text);
    }
    linkNodeModules(root, wt);
    return { ok: true, checkout: { wt, close } };
  } catch (e) {
    close();
    return { ok: false, error: `could not prepare the base checkout: ${String((e as Error)?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * Run `fn` with a checkout of `base` at a temporary path; files from
 * `overlay` (repo-relative path -> text) are written into it first.
 */
export function withBaseCheckout<T>(root: string, base: string, overlay: Map<string, string>, fn: (wt: string) => T): { ok: true; value: T } | { ok: false; error: string } {
  const co = openBaseCheckout(root, base, overlay);
  if (!co.ok) return co;
  try {
    return { ok: true, value: fn(co.checkout.wt) };
  } finally {
    co.checkout.close();
  }
}
