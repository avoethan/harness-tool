#!/usr/bin/env node
/**
 * One-way publishing of the tool folder, and the drift check.
 *
 *   node scripts/publish-copy.js --check   <public-repo-or-url> [--dev <dir>]
 *   node scripts/publish-copy.js --publish <public-repo-or-url> [--version <x.y.z>] [--tag]
 *                                [--force] [--denylist <file>] [--dev <dir>]
 *
 * Run it from the DEVELOPMENT repository (the one that holds the tool in its
 * `harness/` folder), never from inside the public copy. It never edits
 * anything under `harness/` and prints every command it runs.
 *
 * --check     Fetches the public `main` and compares its tree with `HEAD:harness`
 *             of the development repository (what `git archive HEAD:harness`
 *             would write: tracked files only, so ignored paths are excluded):
 *             file list, modes and blob hashes. Prints the differing paths.
 *             Exit 0 when identical, 1 on any difference, 2 on a usage or
 *             environment problem.
 * --publish   Refuses when the development working tree has uncommitted changes
 *             under `harness/`, or when the version in `harness/package.json`
 *             equals the public main's version (unless --force). Then: archives
 *             `HEAD:harness` into a temp folder, runs `npm ci --ignore-scripts`,
 *             `npm run build`, the unit suite with agent sessions off, and
 *             scripts/check-public.js (with --denylist when given); commits the
 *             copy as a CHILD of the public main (subject `harness <version>`,
 *             body naming the development commit and date), checks the commit's
 *             tree equals `HEAD:harness`, and pushes main. With --tag it also
 *             pushes `v<version>` (a refused tag push is reported, not fatal).
 *             An empty public repository gets one root commit.
 * --version   The version being published; must equal harness/package.json's.
 * --skip-build  TEST ONLY: skips the npm steps (install, build, unit suite) and
 *             the public check when the copy has no check script.
 * --dev       TEST ONLY: the development repository (default: the repository
 *             this script lives in).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

function die(msg, code = 2) {
  console.error(`publish-copy: ${msg}`);
  process.exit(code);
}

/** Hide credentials embedded in a URL. */
const hide = (s) => s.replace(/(:\/\/)[^/@\s]+@/g, '$1***@');

/** Run a command, printing it first. `inherit` streams the output. */
function sh(cmd, a, opts = {}) {
  console.log(`$ ${hide([cmd, ...a].join(' '))}${opts.cwd ? `   (in ${opts.cwd})` : ''}`);
  const r = spawnSync(cmd, a, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && cmd === 'npm',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}

function must(cmd, a, opts) {
  const r = sh(cmd, a, opts);
  if (r.code !== 0) {
    if (r.out) console.error(hide(r.out.trim()));
    die(`\`${hide([cmd, ...a].join(' '))}\` failed (exit ${r.code})`, 1);
  }
  return r.stdout;
}

const mode = has('--check') ? 'check' : has('--publish') ? 'publish' : null;
if (!mode || (has('--check') && has('--publish'))) die('give exactly one of --check <public> or --publish <public>');
const target = flag(mode === 'check' ? '--check' : '--publish');
if (!target || target.startsWith('--')) die(`--${mode} needs the public repository (a URL or a clone's folder)`);

// ---- the development repository ----------------------------------------------------
const devArg = flag('--dev');
const devStart = devArg ? path.resolve(devArg) : __dirname;
const top = sh('git', ['rev-parse', '--show-toplevel'], { cwd: devStart });
if (top.code !== 0) die(`${devStart} is not inside a git repository`);
const dev = top.stdout.trim();
if (sh('git', ['cat-file', '-e', 'HEAD:harness'], { cwd: dev }).code !== 0) {
  die('this repository has no harness/ folder at HEAD. Run this script from the development repository, not from the public copy.');
}
const devSha = must('git', ['rev-parse', 'HEAD'], { cwd: dev }).trim();
const devShort = devSha.slice(0, 7);
const devTree = must('git', ['rev-parse', 'HEAD:harness'], { cwd: dev }).trim();

/** path -> "mode blob" for a tree-ish. */
function listTree(cwd, treeish) {
  const out = must('git', ['ls-tree', '-r', '-z', treeish], { cwd });
  const map = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [m, , blob] = rec.slice(0, tab).split(' ');
    map.set(rec.slice(tab + 1), `${m} ${blob}`);
  }
  return map;
}

function diffTrees(devMap, pubMap) {
  const lines = [];
  for (const [p, v] of devMap) {
    if (!pubMap.has(p)) lines.push(`only in the development repository: ${p}`);
    else if (pubMap.get(p) !== v) lines.push(`differs: ${p}`);
  }
  for (const p of pubMap.keys()) if (!devMap.has(p)) lines.push(`only in the public repository: ${p}`);
  return lines.sort();
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-publish-'));
process.on('exit', () => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Make `dir` a repository whose main is the public main. Returns false when the public repository has none. */
function openPublic(dir) {
  fs.mkdirSync(dir, { recursive: true });
  must('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const heads = must('git', ['ls-remote', '--heads', target, 'main'], { cwd: dir });
  if (!heads.trim()) return false;
  must('git', ['fetch', '-q', target, 'main'], { cwd: dir });
  must('git', ['reset', '-q', '--hard', 'FETCH_HEAD'], { cwd: dir });
  return true;
}

function publicVersion(dir) {
  const r = sh('git', ['show', 'HEAD:package.json'], { cwd: dir });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout).version || null;
  } catch {
    return null;
  }
}

// ---- --check -------------------------------------------------------------------------
if (mode === 'check') {
  const pub = path.join(scratch, 'public');
  if (!openPublic(pub)) {
    console.log('The public repository has no main branch yet: nothing is published.');
    process.exit(1);
  }
  const diffs = diffTrees(listTree(dev, 'HEAD:harness'), listTree(pub, 'HEAD'));
  if (diffs.length === 0) {
    console.log(`In step: the public main is identical to harness/ at development commit ${devShort}.`);
    process.exit(0);
  }
  console.log(`The public main differs from harness/ at development commit ${devShort} (${diffs.length} path${diffs.length === 1 ? '' : 's'}):`);
  for (const d of diffs) console.log(`  ${d}`);
  process.exit(1);
}

// ---- --publish -----------------------------------------------------------------------
const force = has('--force');
const denylist = flag('--denylist');
const skipBuild = has('--skip-build');
if (denylist && !fs.existsSync(denylist)) die(`the denylist ${denylist} does not exist`);

const dirty = must('git', ['status', '--porcelain', '--', 'harness'], { cwd: dev }).trim();
if (dirty) {
  console.error(dirty);
  die('the development working tree has uncommitted changes under harness/. Commit or discard them first; only committed content is published.', 1);
}

const copy = path.join(scratch, 'copy');
fs.mkdirSync(copy);
const tarFile = path.join(scratch, 'harness.tar');
must('git', ['archive', '--format=tar', '-o', tarFile, 'HEAD:harness'], { cwd: dev });
must('tar', ['-x', '-f', tarFile, '-C', copy]);

let version;
try {
  version = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8')).version;
} catch {
  die('harness/package.json is missing or unreadable at HEAD');
}
const wanted = flag('--version');
if (wanted && wanted !== version) die(`--version ${wanted} does not match harness/package.json (${version}). Bump the version in the development repository and commit it first.`);

const work = path.join(scratch, 'work');
const hadMain = openPublic(work);
if (hadMain) {
  if (diffTrees(listTree(dev, 'HEAD:harness'), listTree(work, 'HEAD')).length === 0) {
    console.log(`Nothing to publish: the public main already equals harness/ at development commit ${devShort}.`);
    process.exit(0);
  }
  if (publicVersion(work) === version && !force) {
    die(`the public main is already at version ${version} and the content differs. Bump the version in harness/package.json (and CHANGELOG.md) and commit, or pass --force to publish another commit at the same version.`, 1);
  }
}

// Prove the copy on its own, outside the development repository.
if (!skipBuild) {
  must('npm', ['ci', '--ignore-scripts'], { cwd: copy, inherit: true });
  must('npm', ['run', 'build'], { cwd: copy, inherit: true });
  must('npm', ['run', 'test:quick'], { cwd: copy, inherit: true, env: { HARNESS_SKIP_CLAUDE: '1', HARNESS_SAFETY_BEHAVIOUR: '0' } });
}
if (fs.existsSync(path.join(copy, 'scripts', 'check-public.js'))) {
  must(process.execPath, ['scripts/check-public.js', ...(denylist ? ['--denylist', path.resolve(denylist)] : [])], { cwd: copy, inherit: true });
} else if (!skipBuild) {
  die('the copy has no scripts/check-public.js');
}
fs.rmSync(path.join(copy, 'node_modules'), { recursive: true, force: true });
fs.rmSync(path.join(copy, 'dist'), { recursive: true, force: true });

// Replace the public checkout's content with the copy, then commit on top of main.
for (const name of fs.readdirSync(work)) if (name !== '.git') fs.rmSync(path.join(work, name), { recursive: true, force: true });
for (const name of fs.readdirSync(copy)) fs.cpSync(path.join(copy, name), path.join(work, name), { recursive: true });
must('git', ['add', '-A'], { cwd: work });

const subject = `harness ${version}`;
const date = must('git', ['log', '-1', '--format=%cs', 'HEAD'], { cwd: dev }).trim();
const body = `Published from development commit ${devShort} (${date}).`;
const hasIdentity = sh('git', ['config', 'user.email'], { cwd: work }).stdout.trim() !== '';
const ident = hasIdentity ? [] : ['-c', 'user.name=harness publisher', '-c', 'user.email=publisher@users.noreply.invalid'];
must('git', [...ident, 'commit', '-q', '-m', subject, '-m', body], { cwd: work });

const pubTree = must('git', ['rev-parse', 'HEAD^{tree}'], { cwd: work }).trim();
if (pubTree !== devTree) {
  die(`the commit's tree (${pubTree.slice(0, 7)}) is not harness/ at HEAD (${devTree.slice(0, 7)}); a tracked file probably matches an ignore rule. Nothing was pushed.`, 1);
}

must('git', ['push', target, 'HEAD:refs/heads/main'], { cwd: work });
console.log(`Published ${subject} (${hadMain ? 'a child of the public main' : 'a root commit'}), tree ${pubTree.slice(0, 7)}.`);

if (has('--tag')) {
  const tag = `v${version}`;
  const made = sh('git', ['tag', tag], { cwd: work });
  const pushed = made.code === 0 ? sh('git', ['push', target, `refs/tags/${tag}`], { cwd: work }) : made;
  if (pushed.code === 0) console.log(`Pushed tag ${tag}.`);
  else console.log(`The tag ${tag} was not pushed (${hide(pushed.out.trim().split('\n').pop() || 'no reason given')}). The commit is published. Tag it yourself: git tag ${tag} <the published commit> && git push origin ${tag}.`);
}
