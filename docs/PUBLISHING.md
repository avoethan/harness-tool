# Publishing the tool

The tool is the `harness/` folder and nothing else. The repository it is
developed in also holds private material outside that folder (research notes,
design and mission files, test stand-ins, a private token list). This page
gives the checks to run first and two ways to publish only the tool.

**Option A, recommended: a new public repository made from the `harness/`
folder, with its history flattened to one commit.** Nothing outside the
folder, and no old version of any file, can leak.

**Option B: make the development repository public** after removing the
private parts. Only safe when you also replace its whole history, and only if
it never had a pull request (see the warning in B).

Every command below is run by you, in your own terminal. `<dev>` is the
development repository's folder, `<out>` an empty folder for the public copy,
`<private-tokens>` the private token list (kept outside `harness/`).

## 1. Checks to run first

Run them on the commit you want to publish, from `<dev>/harness`:

```sh
git -C <dev> status --short                      # nothing uncommitted
npm ci --ignore-scripts && npm run build

# 1. Nothing personal or setup-specific: private tokens, this machine's home
#    folder and the checkout's absolute path.
node scripts/check-public.js --denylist <private-tokens>

# 2. Absolute paths of any machine (check-public covers this machine only).
#    Expect only generic placeholder users in tests and comments (u, me,
#    someone, alice; and <tmp>/home/work in a test helper); anything else is a
#    leak to fix.
grep -rnI --exclude-dir=node_modules --exclude-dir=dist -E "/home/[^/ ]+/|/Users/[^/ ]+/|[A-Za-z]:[\\/]Users[\\/]" .

# 3. Licences of every dependency (all must allow redistribution).
node -e "const l=require('./package-lock.json');for(const[k,v]of Object.entries(l.packages))if(k)console.log(k.replace(/^.*node_modules\//,''),v.version,v.license,v.dev?'dev':v.optional?'optional':'runtime')"

# 4. What the npm package would hold: the runtime and the docs, no tests.
npm pack --dry-run

# 5. The suites from a clean copy (step 2 below does this on the copy itself).
npm run test:quick
npm run test:acceptance
```

What the licence check printed for 0.1.0 (2026-10-19):

| Package | Licence | Kind |
|---|---|---|
| `@ast-grep/cli` and its seven platform packages | MIT | optional (the only thing users install besides the tool) |
| `detect-libc` | Apache-2.0 | optional (used by the ast-grep installer) |
| `typescript` | Apache-2.0 | development only |
| `@types/node`, `undici-types` | MIT | development only |

The tool itself is MIT (`LICENSE`, copyright "the agent-harness authors").

What `npm pack --dry-run` listed for 0.1.0 (2026-10-19): 343 files:
`bin/` (the two launchers), `dist/src/` (the built runtime), `templates/`
(the skills), `probes/` (the probe library and its own valid/invalid cases,
which `harness discover --self-test` runs), `selfcheck/`, `scripts/`
(the publish check), `docs/`, the component READMEs under `src/`,
`README.md`, `SAFETY.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `LICENSE`,
`package.json`. No `dist/test/`, no `test/`, no fixtures, no TypeScript
sources. The unit test `test/unit/package-contents.test.ts` checks this on
every run.

Recorded run of the clean copy (option A's first block: `git archive` of the
committed tool folder into an empty folder outside any git repository, no
`node_modules`, no `dist`), 2026-10-19, Linux, Node 22.22.0:

| Step | Result |
|---|---|
| `npm ci --ignore-scripts` | ok, 6 packages, 0 vulnerabilities reported |
| `npm run build` | ok |
| `npm run test:quick` | 553 tests: 552 passed, 1 skipped (no real ESLint installed), 0 failed; 49 s |
| `npm run test:acceptance` (agent sessions off) | 18 tests: 9 passed, 9 skipped with the reason (stand-in folders not given, Claude Code off, one placeholder), 0 failed; 8 s |
| `node scripts/check-public.js` (with and without the private denylist) | ok |
| `npm pack --dry-run` | 343 files, 733.6 kB packed, 2.8 MB unpacked |

The first run of this kind found one acceptance test that passed only from a
git checkout; it was fixed before the run above.

The tests contain obviously fake, secret-shaped strings (alphabet runs such as
`ghp_abcdefghijklmnopqrstuvwxyz0123`) on purpose: the redaction and secret
rails are tested against them. If GitHub push protection flags one when you
push, choose "it's used in tests".

## 2. Option A: a new public repository from the tool folder

```sh
# Copy exactly the committed tool folder: no node_modules, no dist, no history.
mkdir -p <out>
git -C <dev> archive --format=tar HEAD:harness | tar -x -C <out>
cd <out>

# Prove the copy builds and passes on its own, outside the development repository.
npm ci --ignore-scripts
npm run build
HARNESS_SKIP_CLAUDE=1 HARNESS_SAFETY_BEHAVIOUR=0 npm run test:quick
HARNESS_SKIP_CLAUDE=1 HARNESS_SAFETY_BEHAVIOUR=0 npm run test:acceptance
node scripts/check-public.js --denylist <private-tokens>
rm -rf node_modules dist                          # .gitignore keeps them out anyway

# One commit, no history.
git init -b main
git add -A
git commit -m "harness 0.1.0"
git tag v0.1.0
```

On Windows (PowerShell), the copy step is:

```powershell
New-Item -ItemType Directory <out> | Out-Null
git -C <dev> archive --format=zip --output "$env:TEMP\harness.zip" HEAD:harness
Expand-Archive "$env:TEMP\harness.zip" -DestinationPath <out>
```

Then create an **empty** public repository on GitHub (no README, no licence,
no .gitignore), in the web UI or with `gh repo create <name> --public`, and
push:

```sh
git remote add origin https://github.com/<you>/<name>.git
git push -u origin main
git push origin v0.1.0
```

The copy carries its own CI (`.github/workflows/ci.yml`: build, unit and
acceptance suites on Node 20 and 22 without agent sessions, the publish
check), which GitHub runs once the folder is the repository root.

**Later releases:** repeat the copy into a fresh `<out>` and replace the
repository content with one new commit on top (`git -C <out> init` is not
needed again if you keep `<out>`: delete everything except `.git`, extract
the new archive, `git add -A`, commit, tag). Never push the development
repository's history to the public one.

**The personal setting's CI** checks out the tool repository named by the
repository variable `HARNESS_TOOL_REPO` (`<you>/<name>`); it finds the tool
at the repository root (option A) or in a `harness/` folder (option B).

## 3. Option B: make the development repository public

> **Warning.** Making a repository public publishes its whole history, every
> branch and tag, and every pull request ref (`refs/pull/<n>/head`). GitHub
> keeps pull request refs even after the branch is gone, and you cannot
> delete them. If the development repository ever had a pull request, or a
> fork, use option A. The private files have been in this repository's
> history since its first commits, so removing them in a new commit is not
> enough: the history must be replaced.

If it never had a pull request, in a **fresh clone** (not your working copy):

```sh
git clone <dev-remote-url> <out> && cd <out>

# A new root commit with the tree you want public.
git checkout --orphan public
git rm -r -q --cached .
# Keep only the tool folder (and git's own files); everything else at the top
# level is development material.
find . -mindepth 1 -maxdepth 1 ! -name .git ! -name harness ! -name .gitignore -exec rm -rf {} +
# Add a short root README.md that points to harness/README.md, and a CI
# workflow: copy harness/.github/workflows/ci.yml to .github/workflows/ci.yml
# and add `defaults: run: working-directory: harness` to its job.
cd harness && npm ci --ignore-scripts && npm run build \
  && HARNESS_SKIP_CLAUDE=1 HARNESS_SAFETY_BEHAVIOUR=0 npm run test:quick \
  && node scripts/check-public.js --denylist <private-tokens> && rm -rf node_modules dist && cd ..
git add -A
git commit -m "harness 0.1.0"
```

Then, on the remote, make `public` the only history: push it as `main`
(`git push --force origin public:main`, a deliberate one-time rewrite that
you run yourself), delete every other branch and tag on the remote
(`git push origin --delete <branch>`), check in the repository settings that
no other branch, tag, release or pull request remains, and only then switch
the visibility to public (Settings, General, Danger Zone).

## 4. After publishing

On the work machine, follow [TEAM-SETUP.md](TEAM-SETUP.md) (team setting) or
[PERSONAL-SETUP.md](PERSONAL-SETUP.md) (personal setting), cloning the public
repository. The private token list never leaves the development machine; the
public CI runs the publish check with the built-in tokens only.
