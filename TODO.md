# TODO

- [ ] **Make `vault-distill` a session-end hook.** Wire the `vault-distill` skill to run
  automatically at session end (Claude Code `Stop`/`SessionEnd` hook) instead of relying on
  the user typing "distill this". Decide the trigger condition (every session vs. only
  sessions that cleared the durability bar) and where the hook lives (global
  `~/.claude/settings.json` vs. per-project).

- [ ] **Write an install script for this repo.** Add a script that installs the library's
  skills (and optionally agents/prompts) into `~/.claude/` — e.g. symlink each
  `skills/<name>/` into `~/.claude/skills/<name>/` so they survive reinstalls and stay
  git-versioned here. Support global vs. per-project install targets, and make it
  idempotent (skip/refresh existing symlinks).
