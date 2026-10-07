# Installing

`install.sh` links this library's agents, skills and hooks into Claude Code. Install everything, one category, or only the items you name. Run it again any time: items already in place are left alone.

## Requirements

- bash 4.4 or newer (macOS ships 3.2: `brew install bash`, then run `bash install.sh`)
- `jq`, only for installing or removing hooks (it edits `settings.json`)
- Claude Code

## Quick start

```bash
git clone git@github.com:gchagan36/prompt-library.git ~/development/prompt-library
cd ~/development/prompt-library
./install.sh --all
```

Restart Claude Code or open a new session so it picks up the changes.

## What gets installed where

| Kind | Source in this repo | Installed to (global) |
|---|---|---|
| Agent | `agents/<name>.md` | `~/.claude/agents/<name>.md` |
| Skill | `skills/<name>/` (folder with `SKILL.md`) | `~/.claude/skills/<name>/` |
| Hook | `hooks/<name>/` (folder with `hook.json`) | script linked to `~/.claude/hooks/`, and registered in `~/.claude/settings.json` |

`prompts/` and `templates/` are reference material, not Claude Code config, so the installer ignores them.

## Choosing what to install

| Command | Installs |
|---|---|
| `./install.sh --all` | every agent, skill and hook |
| `./install.sh --agents` | all agents |
| `./install.sh --skills` | all skills |
| `./install.sh --hooks` | all hooks |
| `./install.sh --skills --hooks` | skills and hooks, no agents |
| `./install.sh --agents planner,debugger` | only those two agents |
| `./install.sh --skills vault-distill --hooks worktree-create` | one skill and one hook |
| `./install.sh` (in a terminal) | interactive menu: everything, a category, or pick items by number |

Names are the file or folder names without extensions. Run `./install.sh --list` to see them. An unknown name stops the run before anything changes.

## Where to install

By default, items go into `~/.claude` and apply to every project.

To install for one project only, pass the project directory. Items go into `<project>/.claude/`:

```bash
./install.sh --hooks --project-dir ~/development/my-app
```

`--project-dir` implies `--target project`. Use `--target global` to name the default explicitly.

## Checking what's installed

```bash
./install.sh --list                          # global target
./install.sh --list --project-dir ~/dev/app  # a project
```

Each item shows one of:

- `installed`: links to this repo and is current
- `not installed`
- `exists, not from this repo`: a file or folder is already there, and the installer won't replace it without `--force`

For hooks, the line also shows whether the hook is registered in `settings.json`.

## Previewing

`--dry-run` prints every change it would make and changes nothing. Add it to any command:

```bash
./install.sh --all --dry-run
```

## Updating

Items are symlinks, so updating is a `git pull`. Run `./install.sh` again only if you've added a new agent, skill or hook. Re-running is safe.

## Removing

`--uninstall` takes the same selectors and removes only what this repo installed:

```bash
./install.sh --uninstall --all                 # remove everything
./install.sh --uninstall --skills vault-distill
./install.sh --uninstall --hooks               # removes the link and the settings.json entry
```

Files that aren't from this repo are left alone, with a warning.

## Copy instead of symlink

```bash
./install.sh --all --copy
```

Copies are standalone. They won't pick up later edits to this repo, so re-run the install after you change anything. Use symlinks (the default) if you're editing the library.

## Existing files and settings

- **A file or folder with the same name that isn't from this repo** is skipped with a warning. Pass `--force` to replace it. The original is kept as `<name>.bak.<timestamp>`.
- **`settings.json`**: before the first change in a run, the installer backs it up to `settings.json.bak.<timestamp>`. It adds only the hook entry it needs and keeps every other key. Hook entries are matched by exact command, so re-running never adds duplicates. If `settings.json` isn't valid JSON, the installer stops and changes nothing.
- **Hook entries it writes** run the script through `$HOME/.claude/hooks/<script>` (global) or `$CLAUDE_PROJECT_DIR/.claude/hooks/<script>` (project). Nothing is hard-coded to your username or home path.

## All options

| Option | Effect |
|---|---|
| `--all` | every agent, skill and hook |
| `--agents [a,b]`, `--skills [a,b]`, `--hooks [a,b]` | a category; with no names, the whole category |
| `--list` | show availability and install status |
| `--uninstall` | remove what this repo installed for the selection |
| `--target global\|project` | `~/.claude` (default) or `<dir>/.claude` |
| `--project-dir DIR` | project directory; implies `--target project` |
| `--copy` | copy instead of symlink |
| `--force` | replace files not from this repo (backed up first) |
| `--dry-run` | show what would change |
| `-h`, `--help` | show usage |

## Adding a new hook

Create `hooks/<name>/` with two files:

- `hook.json`: which event the hook runs on, and which script to link.

  ```json
  {
    "event": "PreToolUse",
    "matcher": "Bash",
    "script": "my-hook.sh"
  }
  ```

  `event` and `script` are required. `matcher` is optional; leave it out for events that take none.
- The script itself, named in `script`. Mark it executable (`chmod +x`) and commit it with that mode.

`./install.sh --list` will show it, and `./install.sh --hooks <name>` installs it.

## Running the tests

```bash
./test-install.sh
```

The tests run against throwaway home and project directories, so your real `~/.claude` is never touched.
