#!/usr/bin/env bash
# Tests for block-ai-attribution.sh. Feeds the hook PreToolUse JSON on stdin
# and checks whether it denies (JSON on stdout) or allows (no output).
#
# Usage: ./test-block-ai-attribution.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/block-ai-attribution.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && echo "       $2"; }

# run_hook <json> [env...] -> stdout in $OUT, exit code in $RC
run_hook() {
  local input="$1"; shift
  OUT=$(env "$@" bash "$HOOK" <<<"$input" 2>/dev/null)
  RC=$?
}

bash_input() { jq -n --arg c "$1" --arg cwd "${2:-$TMP_ROOT}" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$c}}'; }
mcp_input() { jq -n --arg t "$1" --argjson i "$2" '{tool_name:$t, cwd:"/tmp", tool_input:$i}'; }

expect_deny() { # name input [env...]
  local name="$1" input="$2"; shift 2
  run_hook "$input" "$@"
  if [[ $RC -eq 0 ]] && jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1 <<<"$OUT"; then
    pass "$name"
  else
    fail "$name" "rc=$RC out='$OUT'"
  fi
}

expect_allow() { # name input [env...]
  local name="$1" input="$2"; shift 2
  run_hook "$input" "$@"
  if [[ $RC -eq 0 && -z "$OUT" ]]; then pass "$name"; else fail "$name" "rc=$RC out='$OUT'"; fi
}

CLAUDE_TRAILER='Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
FOOTER='🤖 Generated with [Claude Code](https://claude.com/claude-code)'

echo "deny: Bash"
expect_deny "git commit -m with trailer" "$(bash_input "git commit -m \"feat: x

$CLAUDE_TRAILER\"")"
expect_deny "heredoc commit with trailer" "$(bash_input "git commit -m \"\$(cat <<'EOF'
feat: x

$CLAUDE_TRAILER
EOF
)\"")"
expect_deny "mixed-case trailer" "$(bash_input 'git commit -m "x" -m "co-authored-by: CLAUDE <a@b.c>"')"
expect_deny "codex trailer" "$(bash_input 'git commit -m "x

Co-Authored-By: Codex <codex@openai.com>"')"
expect_deny "git tag -m with trailer" "$(bash_input "git tag -a v1 -m \"$CLAUDE_TRAILER\"")"
expect_deny "gh pr create footer" "$(bash_input "gh pr create --title t --body \"body

$FOOTER\"")"
expect_deny "gh issue comment footer" "$(bash_input "gh issue comment 3 --body '$FOOTER'")"

printf 'feat: x\n\n%s\n' "$CLAUDE_TRAILER" >"$TMP_ROOT/msg.txt"
printf 'body\n%s\n' "$FOOTER" >"$TMP_ROOT/body.md"
expect_deny "git commit -F file (absolute)" "$(bash_input "git commit -F $TMP_ROOT/msg.txt")"
expect_deny "git commit -F file (relative to cwd)" "$(bash_input "git commit -F msg.txt")"
expect_deny "gh pr create --body-file" "$(bash_input "gh pr create --title t --body-file $TMP_ROOT/body.md")"
expect_deny "gh api -F body=@file" "$(bash_input "gh api repos/o/r/issues/1/comments -F body=@body.md")"

echo "deny: GitHub MCP"
expect_deny "create_pull_request body" "$(mcp_input mcp__github__create_pull_request "$(jq -n --arg b "x
$FOOTER" '{title:"t", body:$b}')")"
expect_deny "merge_pull_request commit_message" "$(mcp_input mcp__github__merge_pull_request "$(jq -n --arg m "$CLAUDE_TRAILER" '{commit_message:$m}')")"
expect_deny "add_issue_comment body" "$(mcp_input mcp__github__add_issue_comment "$(jq -n --arg b "$FOOTER" '{body:$b}')")"

echo "allow"
expect_allow "plain commit" "$(bash_input 'git commit -m "feat: add thing"')"
expect_allow "human co-author" "$(bash_input 'git commit -m "x

Co-Authored-By: Jane Doe <jane@example.com>"')"
expect_allow "grep for the trailer" "$(bash_input 'grep -r "Co-Authored-By: Claude" .')"
expect_allow "non-write command mentioning footer" "$(bash_input "echo '$FOOTER'")"
expect_allow "gh pr create clean" "$(bash_input 'gh pr create --title t --body "what, why, how to test"')"
expect_allow "-F file without attribution" "$(printf 'feat: ok\n' >"$TMP_ROOT/clean.txt"; bash_input "git commit -F clean.txt")"
expect_allow "-F missing file" "$(bash_input 'git commit -F nope.txt')"
expect_allow "mcp file content only" "$(mcp_input mcp__github__create_or_update_file "$(jq -n --arg c "$CLAUDE_TRAILER" '{path:"README.md", message:"docs: x", content:$c}')")"
expect_allow "mcp clean PR" "$(mcp_input mcp__github__create_pull_request '{"title":"t","body":"what and why"}')"
expect_allow "other tool" "$(jq -n --arg c "$CLAUDE_TRAILER" '{tool_name:"Write", tool_input:{content:$c}}')"

echo "robustness and overrides"
expect_allow "malformed JSON fails open" "not json"
expect_allow "non-object JSON fails open" "[1,2]"
expect_allow "CLAUDE_ALLOW_AI_ATTRIBUTION=1 disables" "$(bash_input "git commit -m \"$CLAUDE_TRAILER\"")" CLAUDE_ALLOW_AI_ATTRIBUTION=1
expect_deny "custom pattern" "$(bash_input 'git commit -m "wip: secret-marker"')" CLAUDE_ATTRIBUTION_PATTERN=secret-marker
expect_allow "custom pattern replaces default" "$(bash_input "git commit -m \"$CLAUDE_TRAILER\"")" CLAUDE_ATTRIBUTION_PATTERN=secret-marker

run_hook "$(bash_input "git commit -m \"$CLAUDE_TRAILER\"")"
if jq -e '.hookSpecificOutput | .hookEventName == "PreToolUse" and (.permissionDecisionReason | contains("Remove it and retry"))' >/dev/null 2>&1 <<<"$OUT"; then
  pass "deny output has event name and retry reason"
else
  fail "deny output has event name and retry reason" "out='$OUT'"
fi

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
