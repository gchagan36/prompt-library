---
purpose: Claude Code PreToolUse hook that denies commits, PRs and other GitHub writes carrying AI attribution
model-notes: Claude Code only (hook contract documented at https://code.claude.com/docs/en/hooks)
last-validated: 2026-10-08
---

# block-ai-attribution

Claude Code's default behavior is to append `Co-Authored-By: Claude …` to commits and `🤖 Generated with [Claude Code]` to PRs. Other agents and plugins (Codex, Copilot, …) add their own. A line in CLAUDE.md asking the model not to is only a request. This hook enforces it: the tool call is **denied**, and the deny reason tells the model to remove the attribution and retry.

It runs on `PreToolUse` for `Bash` and the GitHub MCP tools (`mcp__github__*`).

| Tool | When it scans | What it scans |
|---|---|---|
| `Bash` | The command writes a message: `git commit/tag/notes/merge`, `gh pr/issue/release/api` | The whole command (covers `-m`, heredocs, `--body`), plus message files it names: `-F`/`--file`/`--body-file <path>` and `-F key=@path` |
| `mcp__github__*` | Always | Only `title`, `body`, `message`, `commit_message`, `commit_title`, `description`. File `content` is never scanned |

Other commands (`grep -r "Co-Authored-By" .`) and other tools are left alone. Human co-author trailers are allowed.

## What counts as attribution

Case-insensitive match on any of:

- `Co-Authored-By:` followed by a line naming Claude, Anthropic, Codex, OpenAI, ChatGPT, GPT, Copilot, Gemini, Cursor or Aider
- an `@anthropic.com` / `@openai.com` `noreply@` address
- `Generated with|by …` naming one of those, or `🤖 Generated`
- `claude.com/claude-code`, `claude.ai/code`

## Install

```bash
../../install.sh --hooks block-ai-attribution                          # global
../../install.sh --hooks block-ai-attribution --project-dir ~/dev/app  # one project
```

That links the script into `~/.claude/hooks/` and registers it in `settings.json` under `PreToolUse` with the matcher `Bash|mcp__github__.*`. See [INSTALL.md](../../INSTALL.md).

<details>
<summary>Manual install</summary>

```bash
mkdir -p ~/.claude/hooks
ln -sf ~/development/prompt-library/hooks/block-ai-attribution/block-ai-attribution.sh ~/.claude/hooks/block-ai-attribution.sh
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|mcp__github__.*",
        "hooks": [ { "type": "command", "command": "$HOME/.claude/hooks/block-ai-attribution.sh" } ]
      }
    ]
  }
}
```

</details>

## Pair it with the `attribution` setting

The hook is the backstop. To stop Claude Code asking for attribution in the first place, set this in `settings.json` (this installer does not touch it):

```json
{ "attribution": { "commit": "", "pr": "" } }
```

## Env vars

| Env var | Effect |
|---|---|
| `CLAUDE_ATTRIBUTION_PATTERN` | ERE (case-insensitive) that replaces the default pattern |
| `CLAUDE_ALLOW_AI_ATTRIBUTION=1` | Disable the hook. Set it in the environment Claude Code starts in; a variable set inline in a command never reaches the hook, so the model can't bypass it |

## Contract notes

- **Deny, not rewrite.** Rewriting shell commands (heredocs, quoting) is fragile; a deny with a clear reason lets the model fix the message itself.
- **Fails open.** A missing `jq`, malformed stdin or a missing message file lets the call through (with a warning on stderr), so the hook can't wedge a session.
- **Limits.** It scans text it can see. A message built dynamically (`git commit -m "$(some-script)"`) or in a file that doesn't exist yet at hook time is not inspected.
- **Requires** `jq` and bash.

## Tests

```bash
./test-block-ai-attribution.sh
```
