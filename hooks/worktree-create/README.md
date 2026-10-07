---
purpose: Claude Code WorktreeCreate hook that branches worktrees off develop instead of main
model-notes: Claude Code only (hook contract documented at https://code.claude.com/docs/en/hooks)
last-validated: 2026-10-07
---

# worktree-create

Without this hook, `claude --worktree <name>` creates `.claude/worktrees/<name>` on a branch named `worktree-<name>`, and it starts that branch from the **default branch** (`main`). That's wrong for repos that integrate through `develop`. This hook replaces the built-in creation step:

| Behavior | Without the hook | With the hook |
|---|---|---|
| Base when the request is the default branch | `main` | `origin/develop`, or `origin/$CLAUDE_WORKTREE_BASE`. Falls back to the requested base (unchanged) when no develop branch exists |
| Base when the request is any other ref (e.g. a subagent isolating off a feature branch) | that ref | that ref (unchanged) |
| Branch name | `worktree-<name>` | `fix-foo-33` → `fix/foo-33` for conventional-commit prefixes, otherwise `worktree-<name>` |
| Untracked local files | not copied | globs in `.worktreeinclude`, or `.env` and `.env.local` by default. Tracked files are skipped |
| Dependencies | not installed | installed according to the lockfile: pnpm, npm, yarn, bun or uv |

The hook fires for `claude --worktree`, for subagents with `isolation: "worktree"`, and for background sessions.

## Install (global)

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

## Usage

```bash
claude -w fix-health-leak-33      # -> .claude/worktrees/fix-health-leak-33 on fix/health-leak-33 from origin/develop
claude -w spike                   # -> branch worktree-spike from origin/develop
```

| Env var | Effect |
|---|---|
| `CLAUDE_WORKTREE_BASE` | Integration branch to prefer instead of `develop` (e.g. `staging`) |
| `CLAUDE_WORKTREE_SKIP_INSTALL=1` | Skip the dependency install |

`.worktreeinclude` (optional, at the repo root) takes one glob per line, relative to the root. `#` starts a comment. Patterns that are absolute or contain `..` are skipped.

## Contract notes

- **Stdout carries only the worktree path.** All git, install and log output goes to stderr. Any non-zero exit aborts the worktree creation.
- **Idempotent.** If `worktree_dir` already holds a worktree, the hook just prints its path. If the branch exists but has no worktree, the hook reuses the branch.
- **Recovers from deleted worktree folders.** It runs `git worktree prune` first, so deleting a worktree folder with `rm -rf` doesn't block reusing its name.
- **Cleans up after a failed run.** If the hook fails after creating the worktree, it removes the worktree, and the branch too if this run created it.
- **Copies files only.** `.worktreeinclude` matches that are directories are skipped, so nothing like `node_modules` gets copied. A failed copy only logs a warning.
- **Detached HEAD on the default branch tip** is treated as the default branch, so the worktree still goes to `develop`.
- **Fetches before branching.** It fetches `origin`, plus the remote named in `base_ref` (e.g. `upstream/release`).
- **Works offline.** A failed `git fetch` only logs a warning, and the hook falls back to the cached remote refs.
- **Leaves removal to Claude Code.** There is no `WorktreeRemove` hook, so Claude Code's normal cleanup runs on exit.
- **Requires** `git`, `jq` and bash 4 or later.

## Tests

```bash
./test-create-worktree.sh
```

The tests build throwaway repos, each with a bare origin, in a temp directory, then cover base resolution, branch naming, idempotency, include copying, offline mode and error cases.
