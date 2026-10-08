#!/usr/bin/env bash
# Claude Code PreToolUse hook: denies commits, tags, PRs, issues, comments and
# releases that carry AI attribution (Co-Authored-By trailers naming an AI,
# "Generated with Claude Code" footers, ...). The deny reason tells the model
# to retry without the attribution.
#
# Matches the Bash tool and the GitHub MCP tools (mcp__github__*).
#   Bash:   only commands that write messages (git commit/tag/notes/merge,
#           gh pr/issue/release/api). The whole command is scanned, plus any
#           message file it names (-F/--file/--body-file/-F key=@file).
#   GitHub: only message-like fields (title, body, message, ...). File
#           `content` is never scanned, so pushing a file that merely
#           mentions Co-Authored-By is fine.
#
# Contract: JSON on stdin ({tool_name, tool_input, cwd, ...}). A deny is
# exit 0 with a hookSpecificOutput JSON on stdout; allowing is exit 0 with no
# output. The hook fails OPEN: a missing jq or malformed input never blocks.
#
# Env:
#   CLAUDE_ATTRIBUTION_PATTERN    ERE (case-insensitive) replacing the default
#   CLAUDE_ALLOW_AI_ATTRIBUTION   set to 1 (in Claude Code's own environment)
#                                 to disable the hook
set -uo pipefail

readonly AI_NAMES='claude|anthropic|codex|openai|chatgpt|gpt|copilot|gemini|cursor|aider'
readonly DEFAULT_PATTERN="co-authored-by:.*(${AI_NAMES})|noreply@(anthropic|openai)\\.com|generated (with|by).*(${AI_NAMES})|🤖 *generated|claude\\.com/claude-code|claude\\.ai/code"
readonly PATTERN="${CLAUDE_ATTRIBUTION_PATTERN:-$DEFAULT_PATTERN}"
readonly WRITE_CMD='\bgit\b[^|;&]*\b(commit|tag|notes|merge)\b|\bgh[[:space:]]+(pr|issue|release|api)\b'
readonly MESSAGE_FIELDS='["title","body","message","commit_message","commit_title","description"]'

log() { echo "[block-ai-attribution] $*" >&2; }

[[ "${CLAUDE_ALLOW_AI_ATTRIBUTION:-0}" == 1 ]] && exit 0
command -v jq >/dev/null || { log "warning: jq not found; hook disabled"; exit 0; }

input=$(cat)
jq -e 'type == "object"' >/dev/null 2>&1 <<<"$input" || { log "warning: stdin is not a JSON object; skipping"; exit 0; }

tool=$(jq -r '.tool_name // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")

# Message files named on a command line: -F/--file/--body-file <path>, -F key=@path.
referenced_files() { # command
  local raw path
  while IFS= read -r raw; do
    path="${raw#*[ =]}"
    path="${path#"${path%%[![:space:]]*}"}"
    path="${path#@}"; path="${path#*=@}"
    path="${path//[\"\']/}"
    [[ -n "$path" && "$path" != - ]] || continue
    [[ "$path" == /* || -z "$cwd" ]] || path="$cwd/$path"
    [[ -f "$path" && -r "$path" ]] && cat -- "$path"
  done < <(grep -oE -- '(-F|--file|--body-file)(=|[[:space:]]+)[^[:space:]]+' <<<"$1" || true)
}

case "$tool" in
  Bash)
    command=$(jq -r '.tool_input.command // empty' <<<"$input")
    grep -qE -- "$WRITE_CMD" <<<"$command" || exit 0
    text="$command"$'\n'"$(referenced_files "$command")"
    ;;
  mcp__github__*)
    text=$(jq -r --argjson f "$MESSAGE_FIELDS" \
      '[.tool_input // {} | to_entries[] | select(.key | IN($f[])) | .value | strings] | join("\n")' <<<"$input")
    ;;
  *) exit 0 ;;
esac

matched=$(grep -m1 -iE -- "$PATTERN" <<<"$text") || exit 0
matched="${matched:0:120}"

jq -n --arg line "$matched" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("AI attribution is not allowed in commits/PRs (matched: " + $line + "). Remove it and retry.")
  }
}'
