#!/usr/bin/env bash
# Install this library's agents, skills and hooks into Claude Code.
#
# Usage: ./install.sh [action] [selection] [options]   (./install.sh --help)
#
# Items are symlinked by default, so this repo stays the source of truth.
# Re-running is safe: items already in place are left alone. With no selection
# in a terminal, an interactive menu asks what to install.
set -euo pipefail

readonly REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly CATEGORIES=(agents skills hooks)

# shellcheck source=scripts/lib/settings.sh
source "$REPO_DIR/scripts/lib/settings.sh"

ACTION=install     # install | uninstall | list
TARGET=global      # global (~/.claude) | project (<dir>/.claude)
PROJECT_DIR="$PWD"
COPY=0
FORCE=0
DRY_RUN=0
SETTINGS_BACKED_UP=0
INSTALLED=0
UNCHANGED=0
SKIPPED=0
REMOVED=0
declare -A WANT=()  # category -> "all" or comma-separated item names
SRC=""
DEST=""
HOOK_EVENT=""
HOOK_MATCHER=""
HOOK_SCRIPT=""

log()  { echo "[install] $*"; }
warn() { echo "[install] warning: $*" >&2; }
die()  { echo "[install] error: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [action] [selection] [options]

Selection (combine freely; a bare category flag selects the whole category):
  --all                  every agent, skill and hook
  --agents [a,b,...]     agents (all, or only the named ones)
  --skills [a,b,...]     skills
  --hooks  [a,b,...]     hooks

Action (default: install):
  --list                 show what is available and what is installed
  --uninstall            remove what this repo installed for the selection

Options:
  --target global|project   ~/.claude (default) or <dir>/.claude
  --project-dir DIR         project for --target project (implies it)
  --copy                    copy files instead of symlinking
  --force                   replace existing files not from this repo (backed up first)
  --dry-run                 show what would change without changing anything
  -h, --help                show this help

With no selection in a terminal, an interactive menu asks what to install.
EOF
}

parse_args() {
  local cat val
  while [[ $# -gt 0 ]]; do
    case $1 in
      --all)
        for cat in "${CATEGORIES[@]}"; do WANT[$cat]=all; done ;;
      --agents|--skills|--hooks)
        cat=${1#--}
        val=all
        if [[ $# -gt 1 && $2 != -* ]]; then val=$2; shift; fi
        WANT[$cat]=$val ;;
      --list) ACTION=list ;;
      --uninstall) ACTION=uninstall ;;
      --target)
        [[ $# -gt 1 ]] || die "--target needs a value"
        case $2 in
          global|project) TARGET=$2 ;;
          *) die "--target must be global or project" ;;
        esac
        shift ;;
      --project-dir)
        [[ $# -gt 1 ]] || die "--project-dir needs a value"
        [[ -d $2 ]] || die "not a directory: $2"
        PROJECT_DIR=$(cd "$2" && pwd)
        TARGET=project
        shift ;;
      --copy) COPY=1 ;;
      --force) FORCE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
}

# ---- discovery -------------------------------------------------------------

list_agents() {
  local f
  for f in "$REPO_DIR"/agents/*.md; do
    if [[ -f $f ]]; then basename "$f" .md; fi
  done
}

list_skills() {
  local d
  for d in "$REPO_DIR"/skills/*/; do
    if [[ -f $d/SKILL.md ]]; then basename "$d"; fi
  done
}

list_hooks() {
  local d
  for d in "$REPO_DIR"/hooks/*/; do
    if [[ -f $d/hook.json ]]; then basename "$d"; fi
  done
}

# Names selected for a category, one per line. Prints nothing when unselected.
resolve() {
  local cat=$1 val=${WANT[$1]:-} part
  if [[ -z $val ]]; then return 0; fi
  if [[ $val == all ]]; then
    "list_$cat"
    return 0
  fi
  local -a parts
  IFS=',' read -ra parts <<<"$val"
  for part in "${parts[@]}"; do
    if [[ -n $part ]]; then printf '%s\n' "$part"; fi
  done
}

# Dies on unknown names before anything is touched.
validate_selection() {
  local cat name available
  for cat in "${CATEGORIES[@]}"; do
    if [[ -z ${WANT[$cat]:-} || ${WANT[$cat]} == all ]]; then continue; fi
    available=$("list_$cat")
    while IFS= read -r name; do
      if ! grep -qxF -- "$name" <<<"$available"; then
        die "unknown $cat '$name'. Available: $(paste -sd' ' <<<"$available")"
      fi
    done < <(resolve "$cat")
  done
}

# ---- paths and status ------------------------------------------------------

target_dir() {
  if [[ $TARGET == project ]]; then echo "$PROJECT_DIR/.claude"; else echo "$HOME/.claude"; fi
}

settings_file() { echo "$(target_dir)/settings.json"; }

# The command written into settings.json. The literal $HOME or
# $CLAUDE_PROJECT_DIR is expanded by the shell when Claude Code runs the hook.
hook_command() { # script
  if [[ $TARGET == project ]]; then
    printf '%s' "\$CLAUDE_PROJECT_DIR/.claude/hooks/$1"
  else
    printf '%s' "\$HOME/.claude/hooks/$1"
  fi
}

# Sets SRC (repo source) and DEST (install location) for one item.
# A hook installs its script, not its folder.
item_paths() { # category name
  local t
  t=$(target_dir)
  case $1 in
    agents) SRC="$REPO_DIR/agents/$2.md"; DEST="$t/agents/$2.md" ;;
    skills) SRC="$REPO_DIR/skills/$2"; DEST="$t/skills/$2" ;;
    hooks)
      load_hook "$2"
      SRC="$REPO_DIR/hooks/$2/$HOOK_SCRIPT"
      DEST="$t/hooks/$HOOK_SCRIPT" ;;
  esac
}

# Reads hooks/<name>/hook.json into HOOK_EVENT, HOOK_MATCHER and HOOK_SCRIPT.
load_hook() { # name
  local manifest="$REPO_DIR/hooks/$1/hook.json"
  HOOK_EVENT=$(jq -r '.event // empty' "$manifest")
  HOOK_MATCHER=$(jq -r '.matcher // empty' "$manifest")
  HOOK_SCRIPT=$(jq -r '.script // empty' "$manifest")
  [[ -n $HOOK_EVENT && -n $HOOK_SCRIPT ]] || die "$manifest needs \"event\" and \"script\""
}

# True when DEST already holds exactly what SRC would install.
is_current() { # src dest
  if [[ $COPY == 1 ]]; then
    [[ -e $2 && ! -L $2 ]] && diff -rq "$1" "$2" >/dev/null
  else
    [[ -L $2 && $(readlink "$2") == "$1" ]]
  fi
}

exists() { [[ -e $1 || -L $1 ]]; }

item_status() { # src dest
  if is_current "$1" "$2"; then
    echo installed
  elif exists "$2"; then
    echo "exists, not from this repo"
  else
    echo "not installed"
  fi
}

# ---- filesystem changes ----------------------------------------------------

place() { # src dest
  mkdir -p "$(dirname "$2")"
  if [[ $COPY == 1 ]]; then cp -R "$1" "$2"; else ln -sfn "$1" "$2"; fi
}

remove_path() { # dest
  if [[ $COPY == 1 ]]; then rm -rf "$1"; else rm "$1"; fi
}

install_item() { # label src dest
  local label=$1 src=$2 dest=$3
  if is_current "$src" "$dest"; then
    log "up to date: $label"
    UNCHANGED=$((UNCHANGED + 1))
    return 0
  fi
  if exists "$dest"; then
    if [[ $FORCE != 1 ]]; then
      warn "skipped $label: $dest exists and is not from this repo (use --force to replace it)"
      SKIPPED=$((SKIPPED + 1))
      return 0
    fi
    if [[ $DRY_RUN == 1 ]]; then
      log "[dry-run] would back up $dest"
    else
      mv "$dest" "$dest.bak.$TIMESTAMP"
      log "backed up $dest"
    fi
  fi
  if [[ $DRY_RUN == 1 ]]; then
    log "[dry-run] would install $label"
  else
    place "$src" "$dest"
    log "installed $label"
  fi
  INSTALLED=$((INSTALLED + 1))
}

uninstall_item() { # label src dest
  local label=$1 src=$2 dest=$3
  if is_current "$src" "$dest"; then
    if [[ $DRY_RUN == 1 ]]; then
      log "[dry-run] would remove $label"
    else
      remove_path "$dest"
      log "removed $label"
    fi
    REMOVED=$((REMOVED + 1))
  elif exists "$dest"; then
    warn "left $label alone: $dest is not from this repo"
  else
    log "not installed: $label"
  fi
}

# ---- hook registration in settings.json ------------------------------------

register_hook() { # name (after item_paths)
  local name=$1 cmd
  cmd=$(hook_command "$HOOK_SCRIPT")
  if [[ $DRY_RUN != 1 ]] && ! is_current "$SRC" "$DEST"; then
    warn "not registering hook $name: its script is not installed"
    return 0
  fi
  if hook_registered "$HOOK_EVENT" "$cmd"; then
    log "up to date: hook $name registration"
    UNCHANGED=$((UNCHANGED + 1))
    return 0
  fi
  if [[ $DRY_RUN == 1 ]]; then
    log "[dry-run] would register hook $name ($HOOK_EVENT) in $(settings_file)"
  else
    update_settings "$REGISTER_FILTER" --arg ev "$HOOK_EVENT" --arg matcher "$HOOK_MATCHER" --arg cmd "$cmd"
    log "registered hook $name ($HOOK_EVENT) in $(settings_file)"
  fi
  INSTALLED=$((INSTALLED + 1))
}

unregister_hook() { # name (after item_paths)
  local name=$1 cmd
  cmd=$(hook_command "$HOOK_SCRIPT")
  if ! hook_registered "$HOOK_EVENT" "$cmd"; then return 0; fi
  if [[ $DRY_RUN == 1 ]]; then
    log "[dry-run] would unregister hook $name"
  else
    update_settings "$UNREGISTER_FILTER" --arg cmd "$cmd"
    log "unregistered hook $name"
  fi
  REMOVED=$((REMOVED + 1))
}

# ---- actions ---------------------------------------------------------------

apply_category() { # category
  local cat=$1 name
  while IFS= read -r name; do
    item_paths "$cat" "$name"
    if [[ $ACTION == uninstall ]]; then
      uninstall_item "$cat $name" "$SRC" "$DEST"
      if [[ $cat == hooks ]]; then unregister_hook "$name"; fi
    else
      install_item "$cat $name" "$SRC" "$DEST"
      if [[ $cat == hooks ]]; then register_hook "$name"; fi
    fi
  done < <(resolve "$cat")
}

list_status() {
  local cat name
  log "target: $(target_dir)"
  for cat in "${CATEGORIES[@]}"; do
    echo "$cat:"
    while IFS= read -r name; do
      item_paths "$cat" "$name"
      printf '  %-24s %s' "$name" "$(item_status "$SRC" "$DEST")"
      if [[ $cat == hooks ]]; then
        if hook_registered "$HOOK_EVENT" "$(hook_command "$HOOK_SCRIPT")"; then
          printf ', registered'
        else
          printf ', not registered'
        fi
      fi
      echo
    done < <("list_$cat")
  done
}

check_deps() {
  local file
  if [[ -z ${WANT[hooks]:-} ]]; then return 0; fi
  command -v jq >/dev/null || die "jq is required to register hooks"
  file=$(settings_file)
  if [[ -f $file ]] && ! jq -e . "$file" >/dev/null 2>&1; then
    die "$file is not valid JSON; fix it and re-run"
  fi
}

# ---- interactive menu ------------------------------------------------------

pick_items() {
  local -a entries=()
  local -A picked=()
  local cat name n
  for cat in "${CATEGORIES[@]}"; do
    while IFS= read -r name; do
      entries+=("$cat $name")
      printf '  %2d) %-7s %s\n' "${#entries[@]}" "$cat" "$name"
    done < <("list_$cat")
  done
  [[ ${#entries[@]} -gt 0 ]] || die "no agents, skills or hooks found"
  local answer
  read -r -p "Numbers, space-separated (e.g. 1 4 7): " answer
  for n in $answer; do
    if ! [[ $n =~ ^[0-9]+$ ]] || (( n < 1 || n > ${#entries[@]} )); then
      die "invalid choice: $n"
    fi
    read -r cat name <<<"${entries[n - 1]}"
    picked[$cat]="${picked[$cat]:-}${picked[$cat]:+,}$name"
  done
  for cat in "${CATEGORIES[@]}"; do
    if [[ -n ${picked[$cat]:-} ]]; then WANT[$cat]=${picked[$cat]}; fi
  done
}

interactive_select() {
  [[ -t 0 ]] || die "nothing selected. Pass --all, --agents, --skills or --hooks (see --help)"
  cat <<EOF
What do you want to $ACTION?
  1) Everything (agents, skills, hooks)
  2) Agents
  3) Skills
  4) Hooks
  5) Pick individual items
EOF
  local choice
  read -r -p "Choice [1-5]: " choice
  case $choice in
    1) WANT[agents]=all; WANT[skills]=all; WANT[hooks]=all ;;
    2) WANT[agents]=all ;;
    3) WANT[skills]=all ;;
    4) WANT[hooks]=all ;;
    5) pick_items ;;
    *) die "invalid choice: $choice" ;;
  esac
}

ask_target() {
  local choice dir
  read -r -p "Where? 1) global (~/.claude)  2) a project  [1]: " choice
  if [[ ${choice:-1} == 2 ]]; then
    read -r -p "Project directory [$PWD]: " dir
    PROJECT_DIR=$(cd "${dir:-$PWD}" && pwd) || die "not a directory: $dir"
    TARGET=project
  fi
}

confirm() {
  local answer
  read -r -p "$ACTION into $(target_dir)? [y/N] " answer
  if [[ ! $answer =~ ^[Yy]$ ]]; then die "aborted"; fi
}

summary() {
  local suffix=""
  if [[ $DRY_RUN == 1 ]]; then suffix=" (dry run, nothing changed)"; fi
  log "done: $INSTALLED installed, $UNCHANGED up to date, $SKIPPED skipped, $REMOVED removed$suffix"
}

main() {
  local prompted=0 cat
  parse_args "$@"
  if [[ $ACTION == list ]]; then
    list_status
    return 0
  fi
  if [[ ${#WANT[@]} -eq 0 ]]; then
    interactive_select
    ask_target
    prompted=1
  fi
  validate_selection
  check_deps
  if [[ ${#WANT[@]} -eq 0 ]]; then die "nothing selected"; fi
  if [[ $DRY_RUN == 1 ]]; then log "dry run: no changes will be made"; fi
  if [[ $prompted == 1 ]]; then confirm; fi
  for cat in "${CATEGORIES[@]}"; do
    apply_category "$cat"
  done
  summary
}

main "$@"
