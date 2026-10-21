# Opening the pull request (`src/pr/`, `harness pr open`)

The personal setting lands work with `harness land`. `harness pr open` is
the other ending: you push the task branch and the harness opens the pull
request from the write-up. It is the one command that writes to GitHub, so
only the user runs it (the guard denies `harness pr` to every agent).

## Command

```
harness pr open [--task <id>] [--repo <path>] [--base <branch>] [--draft] [--dry-run] [--json]
```

| Exit | Meaning |
|---|---|
| 0 | the pull request was opened, one was already open for the branch (nothing created), or it was a dry run |
| 1 | refused or failed: the branch is not on the remote at the same tip, no write-up, no token, not a github.com remote, GitHub answered an error |
| 2 | usage: no subcommand, not a git repository, no task |
| 4 | refused by a safety rail: the repository's effective setting is team (the team setting never posts to GitHub; paste the write-up) |

- **Task**: `--task`; else `task/<id>` checked out where it runs; else the
  repository's current task. **Branch**: the one in the task's `run.json`,
  else its landing record, else `task/<id>`, else the current branch.
- **Pushed**: `git ls-remote` must show the branch on the remote (the
  branch's own remote, else `origin`) at the same commit as your local
  branch. Otherwise it stops and prints `git push -u origin <branch>`. The
  harness never pushes for this command.
- **Write-up**: `~/.harness/runs/<repo>/<task>/writeup.md` (written by
  `harness gate`). The title is the brief's title (else the task file's).
  The body is cut at 60,000 characters (GitHub's limit is 65,536).
- **Base**: `--base`, else the remote's default branch as git knows it
  (`origin/HEAD`), else `main`, else `master`.
- **Request**: `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{branch}`
  first. If one is open it is printed and recorded, not duplicated. Else
  `POST /repos/{owner}/{repo}/pulls` with `title`, `body`, `head`, `base`,
  `draft`. Only `https://api.github.com` is ever called.
- **Token**: `GITHUB_TOKEN` or `GH_TOKEN`, else `gh auth token`, the same
  helper as `harness reviews`. It is sent in the `Authorization` header only;
  never printed, logged or stored.
- **`--dry-run`**: runs every check above (including the remote tip), then
  prints the request without the token and sends nothing; needs no token.
- **Record**: `~/.harness/runs/<repo>/<task>/pr.json` with `url`, `number`,
  `at`, `head`, `base` (and `existing: true` when it was already open).
- `--json` prints the result (and, for a dry run, the request).
