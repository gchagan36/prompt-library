# Helpers for registering hooks in a Claude Code settings.json.
# Sourced by install.sh, which provides log, die, settings_file, TIMESTAMP
# and SETTINGS_BACKED_UP.

readonly REGISTER_FILTER='
  .hooks //= {}
  | if any(.hooks[$ev][]?.hooks[]?; .command == $cmd) then .
    else .hooks[$ev] = (.hooks[$ev] // []) + [
      {hooks: [{type: "command", command: $cmd}]}
      + (if $matcher == "" then {} else {matcher: $matcher} end)
    ] end'
readonly UNREGISTER_FILTER='
  if (.hooks | type) == "object" then
    .hooks |= with_entries(
      .value |= (map(.hooks |= ((. // []) | map(select(.command != $cmd))))
                 | map(select((.hooks | length) > 0)))
      | select((.value | length) > 0))
    | if .hooks == {} then del(.hooks) else . end
  else . end'

# True when settings.json already runs this command under the event.
hook_registered() { # event command
  local file
  file=$(settings_file)
  [[ -f $file ]] && jq -e --arg ev "$1" --arg cmd "$2" \
    '[.hooks[$ev][]?.hooks[]?.command] | any(. == $cmd)' "$file" >/dev/null
}

# Applies a jq program to settings.json. Backs the file up once per run and
# replaces it through a temp file, so a failed jq leaves the original intact.
update_settings() { # jq args (filter first)
  local file tmp
  file=$(settings_file)
  mkdir -p "$(dirname "$file")"
  if [[ ! -f $file ]]; then
    printf '{}\n' > "$file"
    SETTINGS_BACKED_UP=1
  elif [[ $SETTINGS_BACKED_UP != 1 ]]; then
    cp -p "$file" "$file.bak.$TIMESTAMP"
    SETTINGS_BACKED_UP=1
    log "backed up $file"
  fi
  tmp=$(mktemp "$file.XXXXXX")
  if ! jq "$@" "$file" > "$tmp"; then
    rm -f "$tmp"
    die "could not update $file"
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
}
