#!/usr/bin/env bash
# Tests for create-worktree.sh. Builds throwaway git repos (with a bare
# "origin") under a temp dir and feeds the hook WorktreeCreate JSON on stdin.
#
# Usage: ./test-create-worktree.sh
set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/create-worktree.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && echo "       $2"; }

assert_eq() { # name expected actual
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}

# make_repo <name> <with_develop:yes|no> -> prints the clone path
make_repo() {
  local name="$1" with_develop="$2"
  local origin="$TMP_ROOT/$name-origin.git" clone="$TMP_ROOT/$name"
  git init -q --bare -b main "$origin"
  git clone -q "$origin" "$clone" 2>/dev/null
  (
    cd "$clone"
    git config user.email test@example.com
    git config user.name test
    git commit -q --allow-empty -m "main commit"
    git push -q origin main
    if [[ "$with_develop" == yes ]]; then
      git switch -q -c develop
      git commit -q --allow-empty -m "develop commit"
      git push -q origin develop
      git switch -q main
    fi
    git remote set-head origin -a >/dev/null 2>&1
  )
  echo "$clone"
}

# run_hook <repo> <worktree-name> <base_ref> [extra env...] -> stdout in $OUT, exit code in $RC
run_hook() {
  local repo="$1" name="$2" base="$3"; shift 3
  local dir="$repo/.claude/worktrees/$name"
  local input
  input=$(jq -n --arg cwd "$repo" --arg dir "$dir" --arg base "$base" \
    '{session_id:"t", transcript_path:"/dev/null", cwd:$cwd,
      hook_event_name:"WorktreeCreate", base_ref:$base, worktree_dir:$dir}')
  OUT=$(cd "$repo" && env CLAUDE_PROJECT_DIR="$repo" CLAUDE_WORKTREE_SKIP_INSTALL=1 "$@" \
    bash "$HOOK" <<<"$input" 2>"$TMP_ROOT/stderr")
  RC=$?
}

branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD; }
sha_of() { git -C "$1" rev-parse "$2"; }

echo "create-worktree.sh tests"

# 1. Default branch base is redirected to develop when develop exists
repo=$(make_repo r1 yes)
run_hook "$repo" fix-health-leak-33 main
dir="$repo/.claude/worktrees/fix-health-leak-33"
assert_eq "exits 0" 0 "$RC"
assert_eq "prints only the worktree path on stdout" "$dir" "$OUT"
assert_eq "bases on origin/develop" "$(sha_of "$repo" origin/develop)" "$(sha_of "$dir" HEAD)"
assert_eq "maps conventional prefix to branch name" "fix/health-leak-33" "$(branch_of "$dir")"

# 2. origin/main and HEAD-on-main are also treated as the default branch
run_hook "$repo" feat-a origin/main
assert_eq "origin/main redirected to develop" "$(sha_of "$repo" origin/develop)" \
  "$(sha_of "$repo/.claude/worktrees/feat-a" HEAD)"
run_hook "$repo" feat-b HEAD
assert_eq "HEAD on main redirected to develop" "$(sha_of "$repo" origin/develop)" \
  "$(sha_of "$repo/.claude/worktrees/feat-b" HEAD)"

# 3. Non-default base refs are honored (e.g. subagent isolation on a feature branch)
git -C "$repo" switch -q -c feat/topic origin/develop
git -C "$repo" commit -q --allow-empty -m "topic commit"
run_hook "$repo" agent-x feat/topic
assert_eq "honors a feature-branch base" "$(sha_of "$repo" feat/topic)" \
  "$(sha_of "$repo/.claude/worktrees/agent-x" HEAD)"
run_hook "$repo" agent-y HEAD
assert_eq "HEAD on a feature branch stays on that branch" "$(sha_of "$repo" feat/topic)" \
  "$(sha_of "$repo/.claude/worktrees/agent-y" HEAD)"
assert_eq "unprefixed name gets worktree- branch" "worktree-agent-y" \
  "$(branch_of "$repo/.claude/worktrees/agent-y")"
git -C "$repo" switch -q main

# 4. Repo without develop falls back to the default branch
repo2=$(make_repo r2 no)
run_hook "$repo2" feat-thing main
assert_eq "no develop: exits 0" 0 "$RC"
assert_eq "no develop: bases on origin/main" "$(sha_of "$repo2" origin/main)" \
  "$(sha_of "$repo2/.claude/worktrees/feat-thing" HEAD)"

# 5. Re-running for an existing worktree is idempotent
run_hook "$repo" fix-health-leak-33 main
assert_eq "existing worktree: exits 0" 0 "$RC"
assert_eq "existing worktree: prints path" "$repo/.claude/worktrees/fix-health-leak-33" "$OUT"

# 6. Existing branch (worktree removed earlier) is reused, not recreated
git -C "$repo" worktree remove "$repo/.claude/worktrees/feat-a"
run_hook "$repo" feat-a main
assert_eq "reuses existing branch: exits 0" 0 "$RC"
assert_eq "reuses existing branch: on feat/a" "feat/a" "$(branch_of "$repo/.claude/worktrees/feat-a")"

# 7. Gitignored env files are copied; missing ones are skipped
printf '.env\n.env.local\n' >"$repo/.gitignore"
echo "SECRET=1" >"$repo/.env.local"
run_hook "$repo" chore-env main
if [[ -f "$repo/.claude/worktrees/chore-env/.env.local" ]]; then pass "copies .env.local"; else fail "copies .env.local"; fi
if [[ ! -e "$repo/.claude/worktrees/chore-env/.env" ]]; then pass "skips missing .env"; else fail "skips missing .env"; fi

# 8. .worktreeinclude overrides the default copy list
echo "local.config" >"$repo/.worktreeinclude"
echo "x" >"$repo/local.config"
run_hook "$repo" chore-include main
if [[ -f "$repo/.claude/worktrees/chore-include/local.config" ]]; then pass "honors .worktreeinclude"; else fail "honors .worktreeinclude"; fi
if [[ ! -e "$repo/.claude/worktrees/chore-include/.env.local" ]]; then pass ".worktreeinclude replaces defaults"; else fail ".worktreeinclude replaces defaults"; fi
rm "$repo/.worktreeinclude"

# 9. CLAUDE_WORKTREE_BASE overrides the preferred integration branch
git -C "$repo" switch -q -c staging main
git -C "$repo" commit -q --allow-empty -m "staging commit"
git -C "$repo" push -q origin staging
git -C "$repo" switch -q main
run_hook "$repo" feat-staged main CLAUDE_WORKTREE_BASE=staging
assert_eq "CLAUDE_WORKTREE_BASE respected" "$(sha_of "$repo" origin/staging)" \
  "$(sha_of "$repo/.claude/worktrees/feat-staged" HEAD)"

# 10. Works offline (fetch failure is a warning, not an error)
git -C "$repo" remote set-url origin "$TMP_ROOT/does-not-exist.git"
run_hook "$repo" fix-offline main
assert_eq "offline: exits 0" 0 "$RC"
assert_eq "offline: still bases on cached origin/develop" "$(sha_of "$repo" origin/develop)" \
  "$(sha_of "$repo/.claude/worktrees/fix-offline" HEAD)"

# 11. Not a git repo -> non-zero exit, nothing on stdout
plain="$TMP_ROOT/plain"; mkdir -p "$plain"
run_hook "$plain" feat-z main
if [[ "$RC" -ne 0 ]]; then pass "non-git dir fails"; else fail "non-git dir fails" "exit $RC"; fi
assert_eq "non-git dir prints nothing on stdout" "" "$OUT"

# 12. Malformed input -> non-zero exit
OUT=$(echo "not json" | bash "$HOOK" 2>/dev/null); RC=$?
if [[ "$RC" -ne 0 ]]; then pass "malformed JSON fails"; else fail "malformed JSON fails"; fi
OUT=$(echo '{"worktree_dir":""}' | bash "$HOOK" 2>/dev/null); RC=$?
if [[ "$RC" -ne 0 ]]; then pass "missing worktree_dir fails"; else fail "missing worktree_dir fails"; fi

# 13. Branch names that git rejects fail cleanly
repo3=$(make_repo r3 yes)
run_hook "$repo3" "feat-..bad" main
if [[ "$RC" -ne 0 ]]; then pass "invalid branch name fails"; else fail "invalid branch name fails"; fi

# 14. Orphaned worktree (dir deleted without `git worktree remove`) is pruned and recreated
repo4=$(make_repo r4 yes)
run_hook "$repo4" fix-orphan main
rm -rf "$repo4/.claude/worktrees/fix-orphan"
run_hook "$repo4" fix-orphan main
assert_eq "orphaned worktree: exits 0" 0 "$RC"
assert_eq "orphaned worktree: recreated on fix/orphan" "fix/orphan" \
  "$(branch_of "$repo4/.claude/worktrees/fix-orphan" 2>/dev/null)"

# 15. Include globs skip directories (no recursive node_modules copies)
mkdir -p "$repo4/node_modules/pkg"; echo x >"$repo4/node_modules/pkg/index.js"
printf 'node_modules/*\n' >"$repo4/.worktreeinclude"
run_hook "$repo4" chore-nodirs main
if [[ ! -e "$repo4/.claude/worktrees/chore-nodirs/node_modules/pkg" ]]; then pass "include skips directories"; else fail "include skips directories"; fi

# 16. Include lines are trimmed, not stripped of inner whitespace
mkdir -p "$repo4/my config"; echo x >"$repo4/my config/a.json"
printf '  my config/a.json  # local\n' >"$repo4/.worktreeinclude"
run_hook "$repo4" chore-spaces main
if [[ -f "$repo4/.claude/worktrees/chore-spaces/my config/a.json" ]]; then pass "include keeps inner spaces"; else fail "include keeps inner spaces"; fi
rm "$repo4/.worktreeinclude"

# 17. Copy failures are warnings, not fatal
echo "x" >"$repo4/.env.local"; chmod 000 "$repo4/.env.local"
run_hook "$repo4" chore-unreadable main
chmod 600 "$repo4/.env.local"
if [[ "$(id -u)" -eq 0 ]]; then pass "copy failure non-fatal (skipped as root)"; else
  assert_eq "copy failure non-fatal" 0 "$RC"; fi

# 18. Detached HEAD at the default branch tip is redirected to develop
git -C "$repo4" switch -q --detach origin/main
run_hook "$repo4" feat-detached HEAD
assert_eq "detached HEAD at main redirected to develop" "$(sha_of "$repo4" origin/develop)" \
  "$(sha_of "$repo4/.claude/worktrees/feat-detached" HEAD)"
git -C "$repo4" switch -q main

# 19. A base on a non-origin remote is fetched before use
upstream="$TMP_ROOT/upstream.git"
git clone -q --bare "$TMP_ROOT/r4-origin.git" "$upstream"
(cd "$repo4" && git push -q "$upstream" origin/develop:refs/heads/release)
git -C "$repo4" remote add upstream "$upstream"
run_hook "$repo4" feat-rel upstream/release
assert_eq "non-origin remote base: exits 0" 0 "$RC"
assert_eq "non-origin remote base: on upstream/release" "$(git --git-dir="$upstream" rev-parse release)" \
  "$(sha_of "$repo4/.claude/worktrees/feat-rel" HEAD)"

# 20. CLAUDE_WORKTREE_BASE accepts an origin/ prefix
git -C "$repo4" switch -q -c staging main
git -C "$repo4" commit -q --allow-empty -m "staging commit"
git -C "$repo4" push -q origin staging
git -C "$repo4" switch -q main
run_hook "$repo4" feat-prefixed main CLAUDE_WORKTREE_BASE=origin/staging
assert_eq "origin/-prefixed CLAUDE_WORKTREE_BASE respected" "$(sha_of "$repo4" origin/staging)" \
  "$(sha_of "$repo4/.claude/worktrees/feat-prefixed" HEAD)"

echo
echo "passed: $PASS  failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
