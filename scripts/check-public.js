#!/usr/bin/env node
/**
 * Publish check (hard rule: nothing personal or setup-specific in the tool).
 *
 *   node scripts/check-public.js [--denylist <file>] [--root <dir>]
 *
 * Scans every text file under the harness folder (default: the folder above
 * this script) for forbidden tokens. Exit 1 on any hit, naming the file and
 * line (never the full token).
 *
 * Tokens:
 *   - built in: this machine's home folder and the absolute path of the folder
 *     being checked, in both slash styles, so an absolute path copied from this
 *     machine into a doc or a test is caught wherever the check runs;
 *   - the denylist (`--denylist <file>` or HARNESS_PUBLIC_DENYLIST): one token
 *     per line, `#` comments allowed, matched case-insensitively. It lives
 *     OUTSIDE the tool folder, so the tokens themselves are never shipped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const root = path.resolve(flag('--root') || path.join(__dirname, '..'));
const denylistPath = flag('--denylist') || process.env.HARNESS_PUBLIC_DENYLIST;

/** Absolute paths of this machine, in the spellings a file could carry them. */
function machineTokens() {
  const out = new Set();
  const forms = (p) => {
    const posix = p.split('\\').join('/');
    return [p, posix];
  };
  // The home folder with a trailing separator ("/home/alice/", "C:\Users\alice\"), so "/rootfs" is not "/root".
  const home = os.homedir();
  if (home && path.resolve(home) !== path.parse(path.resolve(home)).root) {
    for (const f of forms(home)) out.add(f.replace(/[\\/]+$/, '') + (f.includes('\\') ? '\\' : '/'));
  }
  // The folder being checked, as an absolute path.
  if (root !== path.parse(root).root) for (const f of forms(root)) out.add(f);
  return [...out].filter((t) => t.length >= 6);
}

const tokens = machineTokens();
if (denylistPath) {
  if (!fs.existsSync(denylistPath)) {
    console.error(`check-public: the denylist ${denylistPath} does not exist`);
    process.exit(2);
  }
  for (const line of fs.readFileSync(denylistPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) tokens.push(t);
  }
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const TEXT_EXT = new Set(['.ts', '.js', '.json', '.md', '.yml', '.yaml', '.txt', '.sh', '.cmd', '.ps1', '.sql', '.toml', '.rules', '']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (e.isFile()) {
      if (TEXT_EXT.has(path.extname(e.name))) out.push(p);
    }
  }
  return out;
}

const files = walk(root, []);
const hits = [];
for (const f of files) {
  if (path.resolve(f) === path.resolve(__filename)) continue;
  const text = fs.readFileSync(f, 'utf8');
  const lower = text.toLowerCase();
  for (const t of tokens) {
    const idx = lower.indexOf(t.toLowerCase());
    if (idx >= 0) {
      const line = text.slice(0, idx).split('\n').length;
      hits.push(`${path.relative(root, f)}:${line}: contains a forbidden token (${t.length > 12 ? t.slice(0, 4) + '…' : t})`);
    }
  }
}
if (hits.length) {
  console.error('check-public: FAILED');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`check-public: ok (${files.length} files, ${tokens.length} tokens${denylistPath ? '' : '; no denylist given, so only this machine\'s paths were checked'})`);
