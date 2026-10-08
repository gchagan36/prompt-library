#!/usr/bin/env bash
# Tests for install.sh. Every case runs against a throwaway HOME and project
# directory, so the real ~/.claude is never touched.
set -euo pipefail

readonly REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly INSTALL="$REPO/install.sh"
readonly HOOK_CMD='$HOME/.claude/hooks/create-worktree.sh'
readonly WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKE_HOME=""
PROJ=""
OUT=""
RC=0
PASSES=0
FAILURES=0

# ---- harness ---------------------------------------------------------------

new_env() {
  FAKE_HOME=$(mktemp -d "$WORK/home.XXXX")
  PROJ=$(mktemp -d "$WORK/proj.XXXX")
}

run() { # install.sh args...
  local rc=0
  OUT=$(HOME="$FAKE_HOME" "$INSTALL" "$@" 2>&1 </dev/null) || rc=$?
  RC=$rc
}

check() { # description command...
  local desc=$1
  shift
  if "$@"; then
    PASSES=$((PASSES + 1))
    echo "  ok    $desc"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL  $desc"
    echo "        output: ${OUT:-<none>}"
  fi
}

contains() { grep -qF -- "$2" <<<"$1"; }

is_link_to() { [[ -L $1 && $(readlink "$1") == "$2" ]]; }

count_links() { find "$1" -maxdepth 1 -type l 2>/dev/null | wc -l; }

hook_count() { # settings-file
  jq --arg c "$HOOK_CMD" \
    '[.hooks.WorktreeCreate[]?.hooks[]? | select(.command == $c)] | length' "$1"
}

# A file under $1.bak.* whose content is exactly $2
backup_has() {
  local f
  for f in "$1".bak.*; do
    if [[ -f $f ]] && grep -qx -- "$2" "$f"; then return 0; fi
  done
  return 1
}

claude() { echo "$FAKE_HOME/.claude"; }

jq_ok() { jq "$@" >/dev/null; }

# ---- cases -----------------------------------------------------------------

test_full_install() {
  echo "full install"
  new_env
  run --all
  check "exits 0" [ "$RC" -eq 0 ]
  check "every agent is linked" [ "$(count_links "$(claude)/agents")" -eq "$(ls "$REPO"/agents/*.md | wc -l)" ]
  check "planner links into the repo" is_link_to "$(claude)/agents/planner.md" "$REPO/agents/planner.md"
  check "skill links into the repo" is_link_to "$(claude)/skills/vault-distill" "$REPO/skills/vault-distill"
  check "hook script links into the repo" is_link_to "$(claude)/hooks/create-worktree.sh" "$REPO/hooks/worktree-create/create-worktree.sh"
  check "hook registered exactly once" [ "$(hook_count "$(claude)/settings.json")" -eq 1 ]
  check "fresh install makes no backups" [ -z "$(ls -A "$(claude)" | grep '\.bak\.' || true)" ]
}

test_rerun_is_noop() {
  echo "re-run"
  new_env
  run --all
  local before after
  before=$(cat "$(claude)/settings.json")
  run --all
  after=$(cat "$(claude)/settings.json")
  check "second run exits 0" [ "$RC" -eq 0 ]
  check "second run installs nothing" contains "$OUT" "done: 0 installed"
  check "settings.json unchanged" [ "$before" = "$after" ]
  check "re-run makes no backups" [ -z "$(ls -A "$(claude)" | grep '\.bak\.' || true)" ]
}

test_skills_only() {
  echo "skills only"
  new_env
  run --skills
  check "exits 0" [ "$RC" -eq 0 ]
  check "skill is linked" is_link_to "$(claude)/skills/vault-distill" "$REPO/skills/vault-distill"
  check "no agents directory created" [ ! -e "$(claude)/agents" ]
  check "no settings.json created" [ ! -e "$(claude)/settings.json" ]
}

test_named_agents() {
  echo "named agents"
  new_env
  run --agents planner,debugger
  check "planner linked" is_link_to "$(claude)/agents/planner.md" "$REPO/agents/planner.md"
  check "debugger linked" is_link_to "$(claude)/agents/debugger.md" "$REPO/agents/debugger.md"
  check "architect not linked" [ ! -e "$(claude)/agents/architect.md" ]
  check "exactly two agents" [ "$(count_links "$(claude)/agents")" -eq 2 ]
}

test_skills_and_hooks_combined() {
  echo "skills + hooks"
  new_env
  run --skills --hooks
  check "exits 0" [ "$RC" -eq 0 ]
  check "skill linked" is_link_to "$(claude)/skills/vault-distill" "$REPO/skills/vault-distill"
  check "hook registered" [ "$(hook_count "$(claude)/settings.json")" -eq 1 ]
  check "agents untouched" [ ! -e "$(claude)/agents" ]
}

test_unknown_name_rejected() {
  echo "unknown name"
  new_env
  run --agents nope
  check "exits non-zero" [ "$RC" -ne 0 ]
  check "names the bad item" contains "$OUT" "unknown agents 'nope'"
  check "nothing created" [ ! -e "$(claude)" ]
}

test_settings_merge_preserves_keys() {
  echo "settings merge"
  new_env
  mkdir -p "$(claude)"
  cat > "$(claude)/settings.json" <<'EOF'
{"model":"opusplan","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}
EOF
  run --hooks
  local file="$(claude)/settings.json"
  check "exits 0" [ "$RC" -eq 0 ]
  check "unrelated top-level key kept" jq_ok -e '.model == "opusplan"' "$file"
  check "existing hook kept" jq_ok -e '.hooks.PreToolUse[0].hooks[0].command == "echo hi"' "$file"
  check "hook registered once" [ "$(hook_count "$file")" -eq 1 ]
  check "original settings backed up" [ -n "$(ls "$(claude)"/settings.json.bak.* 2>/dev/null)" ]
}

test_conflict_skip_then_force() {
  echo "conflicts"
  new_env
  mkdir -p "$(claude)/agents"
  echo "mine" > "$(claude)/agents/planner.md"
  run --agents planner
  check "skips a file not from this repo" contains "$OUT" "skipped agents planner"
  check "exits 0 on skip" [ "$RC" -eq 0 ]
  check "user file left as-is" [ -f "$(claude)/agents/planner.md" ] && [ ! -L "$(claude)/agents/planner.md" ]
  run --agents planner --force
  check "--force links the agent" is_link_to "$(claude)/agents/planner.md" "$REPO/agents/planner.md"
  check "--force backs up the user file" backup_has "$(claude)/agents/planner.md" "mine"
}

test_dry_run_changes_nothing() {
  echo "dry run"
  new_env
  run --all --dry-run
  check "exits 0" [ "$RC" -eq 0 ]
  check "says dry run" contains "$OUT" "dry run"
  check "no ~/.claude created" [ ! -e "$(claude)" ]
}

test_copy_mode() {
  echo "copy mode"
  new_env
  run --skills --copy
  local dest="$(claude)/skills/vault-distill"
  check "installs a real directory" [ -d "$dest" ] && [ ! -L "$dest" ]
  check "copy matches the repo" diff -rq "$REPO/skills/vault-distill" "$dest"
  run --skills --copy
  check "second copy run is up to date" contains "$OUT" "done: 0 installed"
}

test_uninstall_removes_only_ours() {
  echo "uninstall"
  new_env
  mkdir -p "$(claude)"
  cat > "$(claude)/settings.json" <<'EOF'
{"model":"opusplan","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}
EOF
  run --all
  run --all --uninstall
  check "exits 0" [ "$RC" -eq 0 ]
  check "agent link removed" [ ! -e "$(claude)/agents/planner.md" ]
  check "skill link removed" [ ! -e "$(claude)/skills/vault-distill" ]
  check "hook script removed" [ ! -e "$(claude)/hooks/create-worktree.sh" ]
  check "hook registration removed" [ "$(hook_count "$(claude)/settings.json")" -eq 0 ]
  check "unrelated settings kept" jq_ok -e '.model == "opusplan" and .hooks.PreToolUse[0].hooks[0].command == "echo hi"' "$(claude)/settings.json"
}

test_uninstall_leaves_foreign_file() {
  echo "uninstall with foreign file"
  new_env
  mkdir -p "$(claude)/agents"
  echo "mine" > "$(claude)/agents/planner.md"
  run --agents planner --uninstall
  check "warns and leaves the file" contains "$OUT" "left agents planner alone"
  check "user file still there" [ "$(cat "$(claude)/agents/planner.md")" = "mine" ]
}

test_project_target() {
  echo "project target"
  new_env
  run --hooks --target project --project-dir "$PROJ"
  local settings="$PROJ/.claude/settings.json"
  check "exits 0" [ "$RC" -eq 0 ]
  check "hook script linked in the project" is_link_to "$PROJ/.claude/hooks/create-worktree.sh" "$REPO/hooks/worktree-create/create-worktree.sh"
  check "registered with the project-relative command" jq_ok -e '[.hooks.WorktreeCreate[].hooks[].command] | index("$CLAUDE_PROJECT_DIR/.claude/hooks/create-worktree.sh") != null' "$settings"
  check "global ~/.claude untouched" [ ! -e "$(claude)" ]
}

test_list() {
  echo "list"
  new_env
  run --list
  check "exits 0" [ "$RC" -eq 0 ]
  check "shows not-installed items before install" contains "$OUT" "planner"
  run --agents planner
  run --list
  check "reports the installed agent" contains "$OUT" "planner                  installed"
}

test_no_selection_without_tty() {
  echo "no selection"
  new_env
  run
  check "exits non-zero" [ "$RC" -ne 0 ]
  check "asks for a selection" contains "$OUT" "nothing selected"
}

test_malformed_settings_refused() {
  echo "malformed settings"
  new_env
  mkdir -p "$(claude)"
  echo '{not json' > "$(claude)/settings.json"
  run --hooks
  check "exits non-zero" [ "$RC" -ne 0 ]
  check "says the file is not valid JSON" contains "$OUT" "not valid JSON"
  check "settings.json left untouched" [ "$(cat "$(claude)/settings.json")" = "{not json" ]
  check "hook script not installed" [ ! -e "$(claude)/hooks/create-worktree.sh" ]
}

test_pretooluse_hook_with_matcher() {
  echo "PreToolUse hook with matcher"
  new_env
  mkdir -p "$(claude)"
  cat >"$(claude)/settings.json" <<'JSON'
{"model":"opusplan","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}
JSON
  run --hooks block-ai-attribution
  check "exits 0" [ "$RC" -eq 0 ]
  check "script links into the repo" is_link_to "$(claude)/hooks/block-ai-attribution.sh" "$REPO/hooks/block-ai-attribution/block-ai-attribution.sh"
  check "registered under PreToolUse with its matcher" jq_ok -e \
    '.hooks.PreToolUse | any(.matcher == "Bash|mcp__github__.*" and (.hooks | any(.command == "$HOME/.claude/hooks/block-ai-attribution.sh")))' "$(claude)/settings.json"
  check "existing PreToolUse entry survives" jq_ok -e '.hooks.PreToolUse | any(.hooks | any(.command == "echo hi"))' "$(claude)/settings.json"
  run --hooks block-ai-attribution
  check "re-run registers it once" jq_ok -e '[.hooks.PreToolUse[].hooks[] | select(.command | endswith("block-ai-attribution.sh"))] | length == 1' "$(claude)/settings.json"
}

main() {
  echo "install.sh tests"
  test_full_install
  test_rerun_is_noop
  test_skills_only
  test_named_agents
  test_skills_and_hooks_combined
  test_unknown_name_rejected
  test_settings_merge_preserves_keys
  test_conflict_skip_then_force
  test_dry_run_changes_nothing
  test_copy_mode
  test_uninstall_removes_only_ours
  test_uninstall_leaves_foreign_file
  test_project_target
  test_list
  test_no_selection_without_tty
  test_malformed_settings_refused
  test_pretooluse_hook_with_matcher
  echo
  echo "$PASSES passed, $FAILURES failed"
  [ "$FAILURES" -eq 0 ]
}

main "$@"
