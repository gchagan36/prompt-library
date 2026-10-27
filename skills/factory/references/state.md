# Factory state: layout, job schema, leases, and `factoryctl`

This is the contract between the orchestrator (`SKILL.md`), the helper
(`bin/factoryctl.mjs`), and the dashboard (`bin/dashboard.mjs`). Change it here
first, then change the code and tests to match.

## Layout

All runtime state lives outside any repo, under `FACTORY_HOME`
(default `~/.claude/factory`, overridable with the `FACTORY_HOME` env var):

```
$FACTORY_HOME/
  gaps.jsonl                          agent-gap ledger, append-only (factoryctl gap)
  repos/<repo>/
    repo.json                         { key, name, path, remote, updated }
    jobs/<id>/
      state.json                      the job's state. Written only by factoryctl.
      state.prev.json                 restore backup. Written only by factoryctl.
      lease.json                      which session owns the job. Written only by factoryctl.
      issue.md                        GitHub issue snapshot (orchestrator, at intake)
      spec.md                         factory-spec-writer
      build-<P>.md                    the builder of package <P> (e.g. build-P1.md)
      round-<r>/review-<lens>.md      one reviewer per file
      decision.md                     factory-approver
    worktrees/<id>/                   the job's git worktree (never served by the dashboard)
```

- `<repo>` is the **repo key**: `<name>-<h8>`, where `<name>` is the basename of the
  repo's main worktree lowercased with characters outside `[a-z0-9-]` turned into `-`
  (max 40 chars), and `<h8>` is the first 8 hex chars of the sha256 of the absolute
  real path of `git rev-parse --git-common-dir`. Every worktree of one repo gets the
  same key.
- `<id>` matches `^[0-9]{3}(-i[0-9]+)?(-[a-z0-9]+){1,4}$`: a zero-padded sequence
  number, an optional `i<issue>`, and a 1–4 word slug. Numbers are per repo.

## state.json

```json
{
  "schema": 1,
  "id": "004-i57-last-run-timestamp",
  "repo": "webapp-1a2b3c4d",
  "title": "Last Run Timestamp",
  "feature": "#57 show a last-run timestamp in the header",
  "issue": 57,
  "target": "develop",
  "branch": "factory/004-i57-last-run-timestamp",
  "linked": true,
  "worktree": "/home/me/.claude/factory/repos/webapp-1a2b3c4d/worktrees/004-i57-last-run-timestamp",
  "base": "8e8521d…40 hex",
  "head": "4b1c0a2…40 hex",
  "stage": "review",
  "signoff": "…64 hex, or null",
  "packages": [
    { "id": "P1", "title": "Timestamp API", "agent": "factory-builder-typescript", "gap": null, "status": "done" },
    { "id": "P2", "title": "Header display", "agent": "factory-builder", "gap": "react-ui", "status": "done" }
  ],
  "lenses": ["code", "security", "ui", "ux"],
  "round": 1,
  "rounds": [ { "code": "PASS", "security": "CHANGES", "ui": "PASS", "ux": "pending" } ],
  "rework": 0,
  "feedback": [],
  "decision": null,
  "pr": null,
  "note": "round 1: waiting on ux",
  "created": "2026-10-27T18:00:00Z",
  "updated": "2026-10-27T18:04:00Z"
}
```

| Field | Rule |
|---|---|
| `schema` | Always `1`. |
| `id`, `repo` | Patterns above. Set at `create`, never change. |
| `title` | `^[A-Za-z0-9 ,.()#/-]{1,60}$`. |
| `feature` | Human request, verbatim. Prose: max 4000 chars, never on a command line. |
| `issue` | `null` or integer ≥ 1. Must equal the `i<N>` in `id` when `id` has one. |
| `target` | Branch name `^[A-Za-z0-9._/-]{1,100}$`, no `..`, not starting with `-`. The PR base. |
| `branch` | `null` or `factory/<id>`. |
| `linked` | `null`, `true`, or `false` (branch linked to the issue on GitHub). |
| `worktree` | `null` or exactly `$FACTORY_HOME/repos/<repo>/worktrees/<id>`. |
| `base`, `head` | `null` or `^[0-9a-f]{40}$`. |
| `stage` | Working: `spec`, `build`, `review`, `approve`. Resting: `signoff`, `needs-human`, `pr-open`, `merged`, `closed`. |
| `signoff` | `null` or `^[0-9a-f]{64}$`: sha256 of the `spec.md` a human signed off. |
| `packages[]` | `id` `^P[1-9]$` (unique, in order); `title` (title pattern); `agent` `^factory-builder(-[a-z0-9]+){0,3}$`; `gap` `null` or `^[a-z0-9]+(-[a-z0-9]+){0,3}$`; `status` `pending`, `building`, `done`. Max 9. |
| `lenses` | Non-empty, unique, each `^[a-z0-9]+(-[a-z0-9]+){0,2}$`, must include `code`. |
| `round`, `rounds` | `round == rounds.length`. Each round holds a chip per lens that was in `lenses` when it opened (`pending`, `PASS`, or `CHANGES`); the validator checks that every chip key is a current lens and `code` is present. Lenses never shrink once a round exists, so old rounds stay valid. |
| `rework` | Integer 0–10. |
| `feedback` | Array of prose strings (≤ 4000 chars each), oldest first. |
| `decision` | `null`, `APPROVE`, `ESCALATE`, or `APPROVE (human)`. |
| `pr` | `null` or `^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$`. |
| `note` | `^[A-Za-z0-9 ,.:;()#/_+=-]{1,160}$`. No `@`: notes are posted to GitHub, where it would ping people. |
| `created`, `updated` | UTC `YYYY-MM-DDTHH:MM:SSZ`. Set by the helper. |

Unknown keys are invalid. Key lookups use `Object.hasOwn` so `constructor=…` and
similar inherited names are rejected.

## Leases: one session owns a working job

```json
{ "tokenHash": "…64 hex: sha256 of the token", "pid": 3807702, "pstart": "Tue Oct 27 22:22:49 2026",
  "host": "DESKTOP-1", "claimed": "2026-10-27T18:00:00Z", "released": null }
```

- **Owner process.** On `create` and `claim`, the helper walks up its process
  ancestry (`ps -o ppid=,lstart=,comm= -p <pid>` under `LC_ALL=C TZ=UTC`, so `lstart`
  parses as five fields) to the first ancestor whose `comm`
  is `claude`, and records its `pid` and `lstart` as `pstart`. Run from the Bash
  tool, the chain is helper → shell → `claude`. If no such ancestor is found, `pid` and
  `pstart` are `null`.
- **Live** means: `released` is `null`, `host` equals this host, and either the
  process `pid` exists with the same `lstart` (guards PID reuse), or (`pid` is
  `null` and `claimed` is less than `FACTORY_LEASE_TTL_MIN` minutes old, default
  240). Anything else is **free**: released, stale, or on a dead process.
- **Token.** 128 random bits, printed once by `create`/`claim`. The orchestrator
  keeps it in context with the state hash. Every write passes `--lease <token>`; a
  wrong token exits 6.
- **Release** at every resting stage, so any session can pick the job up with
  `approve`, `rework`, or `resume`. A working-stage job whose lease is free is an
  **orphan**: its session died mid-loop.
- `claim` on a job whose lease is live exits 6 and prints the owner's `pid` and
  `claimed` time. It never steals a live lease.

## Integrity

- Every write prints the new sha256 of `state.json` (`<hash>`). The session that
  owns the job keeps it in context; that copy is the only one that counts.
- Every write takes `--expect <hash>`. If `state.json` changed outside the helper,
  nothing is written and the helper exits 3.
- `restore` puts `state.prev.json` back only if its hash equals the given `<hash>`;
  otherwise it exits 4 (the backup was tampered with too).
- `state.json`, `state.prev.json`, and `lease.json` are written atomically: write to
  an exclusive random temp file in the same directory (`wx`), then rename. A
  symlink at any of these paths is tampering (exit 3), never followed.

## `factoryctl` reference

`node <skill>/bin/factoryctl.mjs <command> …`. `<job>` is `<repo>/<id>`. Mutating
commands end with `--lease '<token>' --expect '<hash>'` (in that order, last four
arguments). Output is plain text, one value per line, unless noted.

| Command | Does | Prints |
|---|---|---|
| `repo` | Registers the repo containing the cwd (writes `repo.json`). | the repo key |
| `create '<repo>' '<file>' [--min N]` | Reads `{ slug, issue, title, feature, target }` from a JSON file written with the Write tool. Needs `repo` first (exit 5 otherwise). Reserves the next number atomically with an exclusive `mkdir` of `repos/<repo>/seq/NNN` (retry on `EEXIST`; `N` is a floor from remote `factory/*` branches). `issue` and an `i<N>` slug must agree both ways, writes `state.json` (`stage: spec`, `note: writing spec`, everything else empty) and a lease. | `id`, `token`, `hash` |
| `claim '<job>'` | Takes a free lease. There is no reclaim of a live lease, even by the same session: subagents share the orchestrator's process. Refuses (exit 2) a job whose `state.json` is invalid; a human must repair or delete it. | `token`, `hash` |
| `release '<job>'` + lease/expect | Sets `released`. Allowed only at a resting stage. | `hash` |
| `hash '<job>'` | | `hash` |
| `show '<job>'` | | state JSON |
| `validate ['<repo>']` | Validates every job (or every repo's jobs). Exit 2 names the first bad job and field. | `ok` |
| `list [--repo '<repo>']` | All jobs with lease status. | JSON array: `{ repo, id, title, stage, lease: live\|free\|released, orphan, note, updated }`; an unreadable or invalid job appears with `invalid: "<message>"` |
| `set '<job>' 'k=v' …` | Token fields only: `stage target branch linked worktree base head signoff rework decision pr`. `null` clears. **Gated:** `decision=APPROVE` needs every lens `PASS` in the last round and `signoff` equal to the current `spec.md` hash; `stage=pr-open` needs `decision` `APPROVE` or `APPROVE (human)` and a `pr`. Exit 2 otherwise. | `hash` |
| `note '<job>' --text '<t>'` / `--append '<t>'` | Note charset, ≤160 (append trims from the left). | `hash` |
| `note '<job>' --line '<file>' '<n>'` | Copies line n of a job-folder file, unsafe chars → `_`, cut to 160. A secret-shaped line becomes `possible secret in <name>`. | `hash` |
| `pkg '<job>' '<P>' '<status>'` | Sets one package's status. | `hash` |
| `lens '<job>' '<lens>'` | Adds a lens (never removes). Applies from the next round. | `hash` |
| `round '<job>'` | Appends a round with a `pending` chip per lens, increments `round`, sets `stage: review`, `note: round <r>: reviewing`. | `hash` |
| `chip '<job>' '<lens>' '<file>'` | Sets the latest round's chip from the file's first line: exactly `VERDICT: PASS` → `PASS`, anything else (or missing) → `CHANGES`. Updates `note` to name pending lenses. | `hash` |
| `feedback '<job>' '<file>'` | Appends the file's text to `feedback`; sets `rework: 0`, `decision: null`, `signoff: null`. | `hash` |
| `signoff '<job>'` | Sets `signoff` to the sha256 of the job's `spec.md`. | `hash` |
| `signoff-check '<job>'` | Exit 0 only if `signoff` equals the current `spec.md` sha256. | |
| `restore '<job>' '<hash>' --lease '<token>'` | See Integrity. No `--expect`: the state has already diverged. | `hash` |
| `gap '<job>' '<file>'` | Appends `{ date, repo, job, kind, specialty, package, fallback, reason }` from a JSON file to `gaps.jsonl`. `kind` is `builder` or `reviewer`; `specialty` uses the gap pattern; `reason` is note-charset ≤160. Deduplicates on (repo, job, kind, specialty). | `ok` |
| `gaps` | Groups the ledger by (kind, specialty). | JSON array: `{ kind, specialty, count, repos, jobs, lastSeen, reasons }`, most frequent first |
| `scan '<file>' …` | Secret scan. Exit 1 and print `file:line` per hit, never the match. | |
| `roster '<job>' '<repo-path>'` | Discovers agents (see **Roster** below) and writes `roster.json` into the job folder for the spec writer. | `hash` of roster.json |
| `plan '<job>'` | Parses the spec's plan block (see **Plan block**), validates it, checks every `agent` is a builder in `roster.json` and every lens a reviewer in it, then sets `packages` (all `pending`) and `lenses` (unioned with the current lenses once any round exists). Only in stage `spec` or `signoff`. Exit 2 names the first bad field. | `hash` |
| `ownership '<job>' '<P>' '<from-sha>' '<to-sha>' ['--unowned']` | Runs `git diff --name-only <from>..<to>` in the job's worktree (`--no-renames`) and prints each changed file that package `<P>` neither owns nor lists as a hotspot. With `--unowned`, files no package owns are allowed too (never another package's). Exit 1 if any. Re-parses the plan from `spec.md` and requires a valid sign-off (exit 2 if none, 3 if `spec.md` changed since). | files |
| `lenses '<job>'` | Computes the lenses the diff `base..head` requires (see **Diff triggers**), adds any missing ones that have a reviewer in `roster.json`, and prints `added <lens>` / `missing <lens>` lines (missing = triggered but no reviewer: a reviewer gap). Never removes a lens. | lines, then `hash` |

### Roster

Agent files are read from `<repo-path>/.claude/agents/` and `~/.claude/agents/`
(override with `FACTORY_AGENT_DIRS`, colon-separated, first wins on a name clash).
Only YAML frontmatter is read; symlinks are followed only to regular files.

- **Builders:** `name` matches `^factory-builder(-[a-z0-9]+){0,3}$`. Specialties come
  from the description's `Specialties: a, b, c.` sentence (tag pattern below). The
  generic `factory-builder` has `Specialties: any.`
- **Reviewers:** `name` matches `^factory-review-([a-z0-9]+(-[a-z0-9]+){0,2})$`; the
  capture is the lens. Custom triggers come from the description's
  `Triggers: <glob>, <glob>.` sentence (optional).

`roster.json`: `{ "builders": [{ "name", "specialties": [], "model", "source" }], "reviewers": [{ "lens", "name", "triggers": [], "model", "source" }] }`, sorted by name.
`source` is `project` or `global`.

### Plan block

`spec.md` must contain exactly one fenced ```` ```json ```` block directly under the
`## Plan` heading:

```json
{
  "packages": [
    { "id": "P1", "title": "Timestamp API", "tags": ["typescript", "node"],
      "agent": "factory-builder-typescript", "gap": null,
      "owns": ["lib/run/**", "tests/run/**"], "depends": [],
      "hotspots": ["package.json"] }
  ],
  "lenses": ["code", "security"]
}
```

- `tags`: 1–6 unique tags `^[a-z0-9]+(-[a-z0-9]+){0,2}$`, primary tag first.
- `owns`: 1–20 repo-relative globs (`*`, `**`, `?` only), no leading `/`, no `..`
  segment, no backslash. To bound regex backtracking: at most 2 `**` segments
  (consecutive ones collapse into one), `**` only as a whole segment, and at most 8
  other wildcards. Reviewer `Triggers:` globs follow the same rules. `hotspots`: 0–10 repo-relative file paths, same rules, no
  globs.
- `depends`: ids of **earlier** packages only (v1 runs packages in order).
- `owns` globs of different packages must not overlap on any file that exists in
  the worktree or appears in the diff (checked again by `ownership`); a hotspot may
  appear in several packages.
- `gap` is non-null exactly when `agent` is `factory-builder`.
- `lenses` must include `code`.

### Diff triggers (`lenses`)

Built-in, evaluated on the file names from `git diff --name-only --no-renames base..head`
(file names only; added lines aren't inspected). Trigger globs without a `/` match a
basename at any depth, like `.gitignore`; patterns with a `/` (`docs/**`) are anchored
at the repo root. `owns` globs are always anchored, so a pattern without `/` matches
top-level files only.

- **security**: added unless *every* changed file is docs (`*.md`, `*.mdx`, `*.rst`,
  `*.txt`, `docs/**`), tests (`test/**`, `tests/**`, `__tests__/**`, `*.test.*`,
  `*.spec.*`, `test_*.py`, `*_test.py`, `*_test.go`), or styles (`*.css`, `*.scss`,
  `*.sass`, `*.less`).
- **ui**: any `*.tsx *.jsx *.vue *.svelte *.html *.css *.scss *.sass *.less`, or a
  path segment `components`, `templates`, `views`, `pages`, `layouts`.
- **ux**: every ui trigger, plus `README*`, `docs/**`, `*.md` outside tests, OpenAPI
  / JSON Schema files (`*openapi*`, `*.schema.json`), i18n (`locales/**`, `i18n/**`),
  and CLI entry points (`bin/**`, `cli/**`, `**/cli.*`).
- **docs**: any non-empty diff (code comments count, not just doc files).
- Custom reviewers: any changed file matching one of their `Triggers:` globs.

**Auth.** Commands that change `state.json` or `lease.json` (`release`, `set`, `note`,
`plan`, `pkg`, `lens`, `lenses`, `round`, `chip`, `feedback`, `signoff`) end with
`--lease '<token>' --expect '<hash>'`. `restore` takes `--lease` only. `create` and
`claim` issue the token. Read-only and side-file commands (`repo`, `hash`, `show`,
`validate`, `list`, `roster`, `gap`, `gaps`, `ownership`, `signoff-check`, `scan`)
take neither. `roster.json` and `gaps.jsonl` aren't hash-protected by the helper:
`roster.json` sits in the job folder, so the orchestrator's job-folder snapshot
covers it, and the ledger is advisory.

**File arguments** (`chip`, `note --line`) must be a whitelisted job-file name, or an
absolute path inside the job folder. A symlinked review file counts as `CHANGES`.

**Exit codes:** 0 ok · 1 scan hit / check failed · 2 invalid input or usage · 3
tampered (hash mismatch or symlink) · 4 restore backup tampered · 5 not found · 6
lease held by another live session, or wrong token.

**Secret patterns** (only defined in the helper): GitHub tokens
(`ghp_ gho_ ghs_ ghu_ github_pat_`), `sk-…` (anchored, so kebab-case words don't
match), Stripe `sk_live_/sk_test_`, AWS `AKIA…`, PEM private-key headers, Slack
`xox[baprs]-`, JWTs (`eyJ….eyJ….…`), and Anthropic `sk-ant-`.
