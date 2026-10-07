#!/usr/bin/env bash
# Claude Code WorktreeCreate hook (replaces the built-in `git worktree add`).
#
# - Bases new worktrees on the integration branch (develop by default) instead
#   of the default branch, when the requested base is the default branch.
#   Any other base ref (e.g. a subagent isolating off a feature branch) is honored.
# - Names the branch from the worktree name: `fix-foo-33` -> `fix/foo-33`
#   for conventional-commit prefixes, otherwise `worktree-<name>`.
# - Copies untracked local files (.worktreeinclude, or .env/.env.local) and
#   installs dependencies when a lockfile is present.
#
# Contract: JSON on stdin ({cwd, base_ref, worktree_dir, ...}); the worktree
# path is the ONLY thing printed on stdout; any non-zero exit aborts creation.
#
# Env:
#   CLAUDE_WORKTREE_BASE          integration branch to prefer (default: develop;
#                                 an origin/ prefix is accepted)
#   CLAUDE_WORKTREE_SKIP_INSTALL  set to 1 to skip dependency installation
set -euo pipefail

readonly PREFIXES='feat|fix|chore|docs|perf|refactor|test|ci|build|style|revert'
readonly DEFAULT_INCLUDES=(.env .env.local)
CLAUDE_WORKTREE_BASE="${CLAUDE_WORKTREE_BASE:-develop}"

log() { echo "[worktree-create] $*" >&2; }
die() { log "error: $*"; exit 1; }

command -v jq >/dev/null || die "jq is required"
command -v git >/dev/null || die "git is required"

read_input() {
  local input
  input=$(cat)
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$input" || die "stdin is not a JSON object"
  WORKTREE_DIR=$(jq -r '.worktree_dir // empty' <<<"$input")
  BASE_REF=$(jq -r '.base_ref // empty' <<<"$input")
  SOURCE_DIR=$(jq -r '.cwd // empty' <<<"$input")
  [[ -n "$WORKTREE_DIR" ]] || die "worktree_dir missing from input"
  [[ "$WORKTREE_DIR" == /* ]] || die "worktree_dir must be absolute: $WORKTREE_DIR"
  SOURCE_DIR=${SOURCE_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}
}

default_branch() {
  local ref
  if ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then
    echo "${ref#origin/}"
  elif git show-ref --verify --quiet refs/heads/main; then
    echo main
  else
    echo master
  fi
}

is_default_branch() { # name
  local name="${1#origin/}"
  [[ "$name" == "$DEFAULT_BRANCH" ]]
}

# Prefer origin/<branch>, then local <branch>; empty if neither exists.
existing_ref() { # branch
  if git show-ref --verify --quiet "refs/remotes/origin/$1"; then
    echo "origin/$1"
  elif git show-ref --verify --quiet "refs/heads/$1"; then
    echo "$1"
  fi
}

# Detached HEAD sitting exactly on the default branch tip counts as the default branch.
is_default_tip() { # sha
  local tip
  tip=$(git rev-parse --verify --quiet "$(existing_ref "$DEFAULT_BRANCH")^{commit}" 2>/dev/null) || return 1
  [[ -n "$tip" && "$tip" == "$1" ]]
}

resolve_base() {
  local base="$BASE_REF" redirect=0
  if [[ -z "$base" || "$base" == HEAD ]]; then
    if ! base=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
      base=$(git rev-parse HEAD)
      is_default_tip "$base" && redirect=1
    fi
  fi
  is_default_branch "$base" && redirect=1
  if [[ "$redirect" -eq 0 ]]; then
    echo "$base"
    return
  fi
  local preferred fallback
  preferred=$(existing_ref "${CLAUDE_WORKTREE_BASE#origin/}")
  if [[ -n "$preferred" ]]; then
    echo "$preferred"
    return
  fi
  # No integration branch: keep the requested base (a local main may hold unpushed work).
  if git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    echo "$base"
    return
  fi
  fallback=$(existing_ref "$DEFAULT_BRANCH")
  echo "${fallback:-$base}"
}

branch_name() { # worktree name
  if [[ "$1" =~ ^($PREFIXES)-(.+)$ ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  else
    echo "worktree-$1"
  fi
}

add_worktree() { # branch base
  git worktree prune >&2  # drop registrations whose directories were deleted by hand
  if git show-ref --verify --quiet "refs/heads/$1"; then
    local holder
    holder=$(git worktree list --porcelain \
      | awk -v ref="branch refs/heads/$1" '/^worktree /{wt=substr($0, 10)} $0 == ref {print wt; exit}')
    [[ -z "$holder" ]] || die "branch $1 is already checked out at $holder; switch that checkout off it or pick another worktree name"
    log "reusing existing branch $1"
    git worktree add "$WORKTREE_DIR" "$1" >&2
  else
    log "creating $1 from $2"
    git worktree add --no-track -b "$1" "$WORKTREE_DIR" "$2" >&2
    CREATED_BRANCH="$1"
  fi
  WORKTREE_ADDED=1
}

# Copy untracked local files (secrets, local config) the worktree needs.
copy_includes() { # repo_root
  local root="$1" patterns=() line
  if [[ -f "$root/.worktreeinclude" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="${line#"${line%%[![:space:]]*}"}"   # trim leading whitespace
      line="${line%"${line##*[![:space:]]}"}"   # trim trailing whitespace
      [[ -n "$line" ]] && patterns+=("$line")
    done <"$root/.worktreeinclude"
  else
    patterns=("${DEFAULT_INCLUDES[@]}")
  fi

  local pattern path rel IFS=$'\n'  # glob-expand patterns without splitting on spaces
  for pattern in "${patterns[@]}"; do
    if [[ "$pattern" == /* || "$pattern" == *..* ]]; then
      log "skipping unsafe include pattern: $pattern"
      continue
    fi
    for path in "$root"/$pattern; do
      [[ -e "$path" ]] || continue
      rel="${path#"$root"/}"
      if [[ ! -f "$path" ]]; then
        log "skipping non-file include: $rel"
        continue
      fi
      git -C "$root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && continue
      if mkdir -p "$(dirname "$WORKTREE_DIR/$rel")" && cp "$path" "$WORKTREE_DIR/$rel"; then
        log "copied $rel"
      else
        log "warning: could not copy $rel"
      fi
    done
  done
}

install_deps() {
  [[ "${CLAUDE_WORKTREE_SKIP_INSTALL:-0}" == 1 ]] && return 0
  local cmd=()
  if   [[ -f "$WORKTREE_DIR/pnpm-lock.yaml" ]]; then cmd=(pnpm install --frozen-lockfile)
  elif [[ -f "$WORKTREE_DIR/package-lock.json" ]]; then cmd=(npm ci --no-audit --no-fund)
  elif [[ -f "$WORKTREE_DIR/yarn.lock" ]]; then cmd=(yarn install --frozen-lockfile)
  elif [[ -f "$WORKTREE_DIR/bun.lock" || -f "$WORKTREE_DIR/bun.lockb" ]]; then cmd=(bun install --frozen-lockfile)
  elif [[ -f "$WORKTREE_DIR/uv.lock" ]]; then cmd=(uv sync --frozen)
  else return 0
  fi
  if ! command -v "${cmd[0]}" >/dev/null; then
    log "warning: ${cmd[0]} not found; skipping dependency install"
    return 0
  fi
  log "installing dependencies: ${cmd[*]}"
  (cd "$WORKTREE_DIR" && "${cmd[@]}") >&2 || log "warning: dependency install failed; continuing"
}

# Fetch origin, plus the remote named in base_ref (e.g. upstream/release).
fetch_remotes() {
  local remotes=(origin) remote="${BASE_REF%%/*}"
  if [[ "$BASE_REF" == */* && "$remote" != origin ]] && git remote get-url "$remote" >/dev/null 2>&1; then
    remotes+=("$remote")
  fi
  for remote in "${remotes[@]}"; do
    git remote get-url "$remote" >/dev/null 2>&1 || continue
    git fetch --quiet "$remote" >&2 2>/dev/null || log "warning: fetch of $remote failed; using cached refs"
  done
}

# If anything fails after the worktree exists, remove it so the name stays reusable.
CREATED_BRANCH=""
WORKTREE_ADDED=0
rollback() {
  local rc=$?
  [[ "$rc" -eq 0 || "$WORKTREE_ADDED" -eq 0 ]] && return
  log "creation failed (exit $rc); rolling back $WORKTREE_DIR"
  git worktree remove --force "$WORKTREE_DIR" >&2 2>/dev/null || true
  [[ -n "$CREATED_BRANCH" ]] && git branch -D "$CREATED_BRANCH" >&2 2>/dev/null || true
}

main() {
  trap rollback EXIT
  trap 'exit 130' INT TERM

  read_input

  # Already a worktree (e.g. resumed session): nothing to do.
  # Compare physical paths: --show-toplevel resolves symlinks (e.g. macOS /var -> /private/var).
  if [[ -d "$WORKTREE_DIR" ]] \
    && [[ "$(git -C "$WORKTREE_DIR" rev-parse --show-toplevel 2>/dev/null)" == "$(cd -P "$WORKTREE_DIR" && pwd)" ]]; then
    log "worktree already exists: $WORKTREE_DIR"
    echo "$WORKTREE_DIR"
    return 0
  fi

  local root
  root=$(git -C "$SOURCE_DIR" rev-parse --show-toplevel 2>/dev/null) || die "not a git repository: $SOURCE_DIR"
  cd "$root"

  fetch_remotes

  DEFAULT_BRANCH=$(default_branch)
  local base branch
  base=$(resolve_base)
  branch=$(branch_name "$(basename "$WORKTREE_DIR")")
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "invalid branch name: $branch"

  log "base_ref requested: ${BASE_REF:-<none>}, using: $base"
  add_worktree "$branch" "$base"
  copy_includes "$root"
  install_deps

  echo "$WORKTREE_DIR"
}

main "$@"
