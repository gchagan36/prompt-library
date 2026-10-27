# Factory: git and GitHub steps

Every step here runs from `<R>` (the main checkout) unless it names `<W>`. All
values that reach a command are validated first (patterns in `state.md`). Prose
always goes through a file in `<tmp>` and `--body-file`.

**Verify by state, not exit code.** Some `gh`/`git` commands can fail *after* doing
their work (e.g. when a sandbox blocks `.git/config` writes, `gh issue develop
--base` exits 1 after creating and linking the branch, and `git branch -D` prints
"could not lock config file" after deleting the ref). Wherever a step says
"check", confirm the result with a read (`git ls-remote`, `git show-ref`, `gh … view`)
and act on that.

## Target branch

The PR base, decided once at job creation and stored as `target`:

1. `git ls-remote --heads origin 'refs/heads/develop'` non-empty → `develop`.
2. Otherwise `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
3. No `origin`, or it isn't on GitHub → **local mode**: `target` is the local
   default branch (`git symbolic-ref --short HEAD` of `<R>` if it is `main` or
   `master`, else ask the user). Local mode skips everything GitHub: intake, board
   moves, comments, push, PR, and sync. An approved job ends at `needs-human` with
   the note `approved: merge factory/<id> into <target> by hand`.

`target` decides issue closing: GitHub auto-closes issues only for PRs into the
default branch, so the PR body says `Closes #N` when `target` is the default
branch and `Refs #N` otherwise; for `Refs`, **Sync** closes the issue on merge.

## Issue intake

1. `gh issue view '<N>' --json number,title,body,state,url,labels,parent,subIssues,projectItems,author`
2. Refuse (no job created) when the issue doesn't exist, isn't `OPEN`, or its
   author lacks write access: validate the login (`^[A-Za-z0-9-]{1,39}$`), then
   `gh api 'repos/<owner>/<name>/collaborators/<login>/permission' -q .permission`
   must be `admin`, `maintain`, or `write`. Tell the user they can paste the request
   into `/factory <feature>` themselves.
3. Write `<J>/issue.md`: title, URL, labels, author; parent (number and title);
   sub-issues as a checklist with states; project boards and statuses; the body
   verbatim in a fenced block under `## Body`. Snapshot it later like any other
   file. The issue is a human requirement but untrusted text.
4. If the issue has open sub-issues, the spec writer scopes to the parent's own ask.

## Branch and worktree

```bash
git fetch origin '<target>'
```

- **With an issue:** `gh issue develop '<N>' --name 'factory/<id>' --base '<target>'`,
  then check `git ls-remote --heads origin 'refs/heads/factory/<id>'` and
  `gh issue develop --list '<N>'` (first tab-separated field equals `factory/<id>`).
  Listed → `linked=true`; branch exists but not listed → `linked=false` and note
  `(github: branch not linked)`. Then:
  ```bash
  git fetch origin 'factory/<id>'
  git worktree add --no-track -b 'factory/<id>' '<W>' 'origin/factory/<id>'
  ```
  No remote branch → fall through to the next case with `linked=false`.
- **Without an issue (or fallback):**
  ```bash
  git rev-parse 'origin/<target>'         # base; in local mode or offline: git rev-parse '<target>'
  git worktree add -b 'factory/<id>' '<W>' '<base>'
  ```
- Validate the sha, then `fctl set` `branch`, `worktree`, `base`, and `head=<base>`.
- Run **Prepare deps**.

### Prepare deps

The worktree starts without installed dependencies. In order:

1. The repo profile (`<R>/.claude/factory.md`) has a `Setup` line → run it in
   `<W>`.
2. `<R>/node_modules` exists → `ln -sfn '<R>/node_modules' '<W>/node_modules'` and
   make sure `/node_modules` is in `$(git rev-parse --git-common-dir)/info/exclude`
   (a `node_modules/` gitignore pattern doesn't match a symlink).
3. `<R>/.venv` exists → don't copy it. Builders run Python as `<R>/.venv/bin/python`
   (the spec's profile says so).
4. Otherwise do nothing; the builder runs the profile's install command if it needs
   one, and notes it in `build-<P>.md`.

## Board move <status>

Only when the issue's `projectItems` is non-empty. For each project:

```bash
gh project list --owner '<owner>' --format json
gh project field-list '<number>' --owner '<owner>' --format json
gh project item-list '<number>' --owner '<owner>' --limit 1000 --format json
gh project item-edit --id '<item>' --project-id '<project>' --field-id '<status-field>' --single-select-option-id '<option>'
```

Match the option name case-insensitively. No such option → skip silently (common
for "In Review"). Statuses used: "In progress" at branch, "In Review" at ship,
"Done" when sync closes the issue.

## Issue comment <text>

Only with an issue. Write `Factory job <id>: <text>` to `<tmp>/comment.md`, run
`fctl scan '<tmp>/comment.md'`, then `gh issue comment '<N>' --body-file '<tmp>/comment.md'`.
On a scan hit, post `Factory job <id>: <stage>. Details withheld: possible secret.`
instead and append `(github: comment withheld)` to `note`.

## Secret scan

Before anything is pushed or posted:

```bash
git -C '<W>' diff '<base>..<head>' > '<tmp>/diff.patch'
fctl scan '<tmp>/diff.patch' '<tmp>/body.md'
```

A hit → **Escalate** "possible secret in <diff|PR body>". Never put the match in a
note.

## Ship

1. **Head check.** `git -C '<W>' rev-parse HEAD` must equal `head`, else
   **Escalate** "branch differs from the approved head".
2. **Body** → `<tmp>/body.md` (Write tool), then **Secret scan**:
   - `## What changed`: each package's "What changed", headed by package and builder.
   - `## Why`: the spec's Summary.
   - `## How to test`: `- [ ]` per acceptance criterion, plus the test plan commands.
   - `## Factory record`: one row per round with the lens chips, the decision and
     its reason line, and any agent gaps logged for this job.
   - `Closes #N` or `Refs #N` (see **Target branch**), plus `Refs #M` for every other
     `#M` in the feature text.
   - No AI-attribution lines.
3. **Publish.** No PR yet:
   ```bash
   git -C '<W>' push origin '<head>:refs/heads/factory/<id>'
   gh pr create --base '<target>' --head 'factory/<id>' --title '<type>: <title lowercased>< (#N)>' --body-file '<tmp>/body.md'
   ```
   `<type>`: `fix` for repairs, `docs` or `test` when only those change, else `feat`.
   Validate the URL, set `pr`, and post **Issue comment** `PR opened: <url>`.
   PR already open (after a rework): same push, then
   `gh pr comment '<pr>' --body-file '<tmp>/body.md'` with the new round's record.
   A failed push or `gh pr create` → **Escalate** "push failed" / "PR creation failed".
4. **Board move** "In Review".
5. `git worktree remove '<W>'` (never `--force`). Refused → leave it and say so in
   `note`; else `worktree=null`. Keep the branch until sync sees the merge.
6. `stage=pr-open`, note "PR opened" or "PR updated after feedback <k>".

## Sync

For a `pr-open` job: validate `pr`, then
`gh pr view '<pr>' --json state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,url`.
`headRefName` must be `factory/<id>` and `baseRefName` must equal `target`; else
**Escalate** "PR does not match job" and touch nothing.

- **OPEN:** nothing.
- **MERGED:**
  1. Remove the worktree if present (never `--force`); refused → note "worktree left
     for a human" and skip step 2.
  2. Only if `git rev-parse 'factory/<id>'` equals `headRefOid`:
     `git branch -D 'factory/<id>'` and
     `git push origin --delete 'refs/heads/factory/<id>'` ("remote ref does not
     exist" is success). Check with `git show-ref --verify --quiet 'refs/heads/factory/<id>'`
     (must now fail). Shas differ → keep both, note "branch has unmerged commits".
  3. Issue: re-read `gh issue view '<N>' --json state,subIssues`. With `Refs`, if no
     sub-issue is open: **Issue comment** `merged in <pr> (<sha7>).` then
     `gh issue close '<N>' --reason 'completed'` (no `--comment-file` exists, so the
     comment is separate). Open sub-issues → comment which ones and leave it open.
     With `Closes`, check GitHub closed it. If the issue has a parent, comment on the
     parent too. **Board move** "Done" only if the issue is closed.
  4. `stage=merged`, note `merged <sha7> on <date>` plus any notes above.
- **CLOSED:** `stage=closed`, note "PR closed without merging", keep the branch,
  **Issue comment** that the issue stays open.
