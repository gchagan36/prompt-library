---
purpose: Claude Code WorktreeCreate hook that branches worktrees off develop instead of main
model-notes: Claude Code only (hook contract documented at https://code.claude.com/docs/en/hooks; see the note below on where that documentation is wrong)
last-validated: 2026-10-07
---

# worktree-create

Without this hook, `claude --worktree <name>` creates `.claude/worktrees/<name>` on a branch named `worktree-<name>`, and it starts that branch from the **default branch** (`main`). That's wrong for repos that integrate through `develop`. This hook replaces the built-in creation step entirely — including deciding the worktree's path and its base ref, since Claude Code hands both decisions to the hook once one is configured:

| Behavior | Without the hook | With the hook |
|---|---|---|
| Base when the repo's current checkout is the default branch | `main` | `origin/develop`, or `$CLAUDE_WORKTREE_BASE`. Falls back to the current base (unchanged) when no develop branch exists |
| Base when the repo is already on another ref (a feature branch, or Claude isolating further from inside an existing worktree) | that ref | that ref (unchanged) |
| Branch name | `worktree-<name>` | `fix-foo-33` → `fix/foo-33` for conventional-commit prefixes, otherwise `worktree-<name>` |
| Worktree location | `.claude/worktrees/<name>` under wherever Claude currently is | `.claude/worktrees/<name>` under the repo's **main** worktree, even when requested from inside another worktree |
| Untracked local files | not copied | globs in `.worktreeinclude`, or `.env` and `.env.local` by default. Tracked files are skipped |
| Dependencies | not installed | installed according to the lockfile: pnpm, npm, yarn, bun or uv |

> **The hook reference docs for `WorktreeCreate` are wrong as of 2026-10.** They list `worktree_path` and `base_ref` input fields that Claude Code does not actually send — see the [filed doc bug](https://claudeissues.com/issue/77566-docs-worktreecreate-hook-stdin-field-is-name-not-the-documented-worktree-path). The real stdin payload has only `name` (the worktree name) and `cwd`. This hook is written against the real payload: it computes the worktree path itself and derives the base ref from the repo's current `HEAD`, rather than reading either from input.

The hook fires for `claude --worktree`, for subagents with `isolation: "worktree"`, and for background sessions.

## Install

```bash
../../install.sh --hooks worktree-create              # global
../../install.sh --hooks worktree-create --project-dir ~/dev/app   # one project
```

That links the script into `~/.claude/hooks/` and registers it in `settings.json`. See [INSTALL.md](../../INSTALL.md).

<details>
<summary>Manual install</summary>

```bash
mkdir -p ~/.claude/hooks
ln -sf ~/development/prompt-library/hooks/worktree-create/create-worktree.sh ~/.claude/hooks/create-worktree.sh
```

Then merge this into `~/.claude/settings.json`. The event takes no matcher.

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [ { "type": "command", "command": "$HOME/.claude/hooks/create-worktree.sh" } ] }
    ]
  }
}
```

To install it for a single project only, put the same block in `<repo>/.claude/settings.json`.

</details>

## Usage

```bash
claude -w fix-health-leak-33      # -> .claude/worktrees/fix-health-leak-33 on fix/health-leak-33 from origin/develop
claude -w spike                   # -> branch worktree-spike from origin/develop
```

| Env var | Effect |
|---|---|
| `CLAUDE_WORKTREE_BASE` | Integration branch to prefer instead of `develop`. A bare name (e.g. `staging`), an `origin/` prefix, or `<remote>/<branch>` for another configured remote |
| `CLAUDE_WORKTREE_ROOT` | Where worktrees go, relative to the repo's main worktree (default: `.claude/worktrees`) |
| `CLAUDE_WORKTREE_SKIP_INSTALL=1` | Skip the dependency install |

`.worktreeinclude` (optional, at the repo root) takes one glob per line, relative to the root. `#` starts a comment. Patterns that are absolute or contain `..` are skipped.

## Contract notes

- **Input is just `name` and `cwd`.** No `base_ref` or `worktree_path`/`worktree_dir` is sent (despite what the hook reference docs say — see the note above), so the hook decides both itself: the path from `name` plus the repo's main worktree root, and the base ref from the repo's current `HEAD`.
- **Stdout carries only the worktree path.** All git, install and log output goes to stderr. Any non-zero exit aborts the worktree creation.
- **Idempotent.** If the computed path already holds a worktree, the hook just prints its path. If the branch exists but has no worktree, the hook reuses the branch.
- **Worktrees always nest under the main worktree**, never under whichever worktree the request came from, so isolating further from inside a worktree doesn't create worktrees-in-worktrees.
- **Recovers from deleted worktree folders.** It runs `git worktree prune` first, so deleting a worktree folder with `rm -rf` doesn't block reusing its name.
- **Cleans up after a failed run.** If the hook fails after creating the worktree, it removes the worktree, and the branch too if this run created it.
- **Copies files only.** `.worktreeinclude` matches that are directories are skipped, so nothing like `node_modules` gets copied. A failed copy only logs a warning.
- **Detached HEAD on the default branch tip** is treated as the default branch, so the worktree still goes to `develop`.
- **Fetches before branching.** It fetches `origin`, plus the remote named in `CLAUDE_WORKTREE_BASE` (e.g. `upstream/release`).
- **Works offline.** A failed `git fetch` only logs a warning, and the hook falls back to the cached remote refs.
- **Leaves removal to Claude Code.** There is no `WorktreeRemove` hook, so Claude Code's normal cleanup runs on exit.
- **Requires** `git`, `jq` and bash 4 or later.

## Tests

```bash
./test-create-worktree.sh
```

The tests build throwaway repos, each with a bare origin, in a temp directory, then cover base resolution, branch naming, idempotency, include copying, offline mode and error cases.
