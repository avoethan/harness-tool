import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanHiddenUnicode } from './unicode';

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

export function readTextOr(p: string, fallback: string | null = null): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Write a file atomically (temp file + rename). Refuses content with hidden
 * Unicode unless `allowHidden` is set, so the harness never writes what it
 * would flag.
 */
export function writeTextAtomic(p: string, content: string, opts: { allowHidden?: boolean; mode?: number } = {}): void {
  if (!opts.allowHidden) {
    const hits = scanHiddenUnicode(content);
    if (hits.length) {
      throw new Error(`refusing to write ${p}: hidden Unicode at offsets ${hits.slice(0, 5).map((h) => h.offset).join(',')}`);
    }
  }
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: opts.mode });
  fs.renameSync(tmp, p);
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(readText(p)) as T;
}

export function readJsonOr<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readText(p)) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(p: string, value: unknown): void {
  writeTextAtomic(p, JSON.stringify(value, null, 2) + '\n');
}

/** Append a line to a file, creating it. Not atomic across processes but append-only. */
export function appendLine(p: string, line: string): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'vendor',
  '.harness',
  'tmp',
  '.idea',
  '.vscode',
]);

export interface WalkOptions {
  ignoreDirs?: Set<string>;
  /** Return true to include a file. */
  filter?: (absPath: string, rel: string) => boolean;
  maxFiles?: number;
  followSymlinks?: boolean;
}

/** Depth-first file walk. Never follows symlinks by default. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const ignore = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const out: string[] = [];
  const max = opts.maxFiles ?? Infinity;
  const stack: string[] = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink() && !opts.followSymlinks) continue;
      if (e.isDirectory()) {
        if (!ignore.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs);
        if (!opts.filter || opts.filter(abs, rel)) out.push(abs);
        if (out.length >= max) break;
      }
    }
  }
  return out.sort();
}

export function copyFile(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

export function removeFile(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function mtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
