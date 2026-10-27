---
purpose: Overview of the /factory skill — a spec→build→review→PR loop of subagents with human sign-off, parallel sessions, and a cross-repo dashboard
model-notes: Claude Code only (skills, subagents, SendMessage, AskUserQuestion)
last-validated: 2026-10-27
---

# factory

`/factory <feature or #issue>` runs a feature through a loop of subagents in any
repo. Every spec stops for human sign-off, and every job ends as a PR the factory
never merges.

1. **Spec writer** writes `spec.md`: acceptance criteria, work packages tagged by
   stack and routed to builder agents, and a review plan.
2. **You sign off** on the spec, the builder routing, and the reviewer plan, send
   changes back, or park the job.
3. **Builders** build the packages in order in a single worktree. Each package goes
   to the best specialist installed, or to the generic builder, and that fallback
   is logged as an **agent gap**.
4. **Reviewers** run in parallel, only for the lenses the change needs (code always;
   security, ui, ux, and custom lenses by spec and diff). CRITICAL/HIGH findings
   send the work back, at most twice.
5. **Approver** checks the build against the signed-off spec. If it matches, the
   factory opens a PR to `develop` (or the default branch). Otherwise the job goes
   to `needs-human`.
6. **Sync** cleans up after you merge: it deletes the branch, closes the issue, and
   moves the card to Done.

Run `/factory` in as many sessions as you like. Each job is leased to the session
running it, and a dashboard shows every job across every repo.

| What | Where |
|---|---|
| Orchestrator loop and commands | `SKILL.md` |
| State, leases, `factoryctl` | `references/state.md`, `bin/factoryctl.mjs` |
| Routing, profiles, agent gaps | `references/routing.md` |
| Git, PRs, issues, sync | `references/github.md` |
| Builder and reviewer contracts | `references/builder-contract.md`, `references/review-contract.md` |
| Templates | `references/profile-template.md` (per repo), `references/agent-template.md` (new specialists) |
| Dashboard | `bin/dashboard.mjs`, `dashboard/` |
| Agents | `../../agents/factory-*.md` |
| Tests | `tests/` |

## Install

```bash
./install.sh --skills factory --agents factory-spec-writer,factory-builder,factory-builder-typescript,factory-builder-python,factory-review-code,factory-review-security,factory-review-ui,factory-review-ux,factory-approver
```

The skill and agents need to be installed in the same scope (global or the same
project). For best results, give each repo a profile: copy
`references/profile-template.md` to `<repo>/.claude/factory.md`.

**Permissions.** Agents read and write job files under `~/.claude/factory/`, which is
outside the repo. If you don't run with bypass permissions, allow `Read`, `Write`,
and `Edit` on `~/.claude/factory/**` and the `node …/factoryctl.mjs` Bash command,
or you'll be prompted on every step.

## Use

```
/factory add a last-run timestamp to the header      # new job from text
/factory #57                                         # new job from an issue
/factory approve 004-i57-last-run-timestamp          # sign off a parked spec, or override an escalation
/factory rework 004-i57-last-run-timestamp <note>    # send notes back through the spec
/factory resume 004-i57-last-run-timestamp           # pick up a job whose session died
/factory status | sync | dashboard | gaps
```

## Watch it

```bash
node ~/.claude/skills/factory/bin/dashboard.mjs     # http://127.0.0.1:8765/
```

The dashboard is read-only and bound to localhost. It shows every repo's jobs by
stage, with package builders, lens chips per round, lease status (live or ORPHANED),
each job's files, and the agent-gap ledger.

## Add a specialist

`/factory gaps` lists the specialties that keep falling back to the generic agents,
and drafts an agent from the template for any you choose. Add the draft to
`agents/` here and install it. Any agent named `factory-builder-<x>` that declares
`Specialties: …` is picked up on the next job, or `factory-review-<lens>` with
optional `Triggers: …` for reviewers. The skill itself needs no change.

## Test

```bash
node --test 'skills/factory/tests/*.test.mjs'   # Node 24 needs the glob, not the directory
```

## Known limits

These are accepted for now, found by the security review on 2026-10-27:

- **No sandbox.** Every agent runs as you. A prompt-injected builder could edit
  `.git/config` or hooks, or read files in `$HOME`.
  - The factory's integrity checks catch tampering with its own state: hash-checked
    state, job-folder snapshots, per-review hashes, branch checks, and helper-gated
    APPROVE and PR transitions.
  - They don't stop an agent from attacking the rest of your machine. For real
    isolation, run sessions in a container or under the Claude Code sandbox.
- **Prose rules only.** Subagents are told never to run `factoryctl`, but nothing
  enforces it. They can't get a lease token, though: tokens appear only in the
  orchestrator's own Bash output, and `lease.json` stores just a hash. Any write
  they attempt fails with exit 6, and any direct edit fails the hash check.
- **Same-session recovery.** If the orchestrator loses its lease token, the job stays
  locked until that session exits. Run `/factory resume` from a new session after it
  does.
- **Narrow secret scan.** It covers common token formats only (GitHub, OpenAI and
  Anthropic, Stripe, AWS, Slack, PEM keys, JWTs). It doesn't cover generic
  `password=` lines, commit messages, or filenames.
- **Same-user threats not covered:**
  - The dashboard port can be squatted by another local process.
  - Races on job files are possible during the narrow window between the
    symlink check and the read.

## Relationship to Scout's factory

This is a repo-agnostic rewrite of Scout's `.claude/skills/factory`, carrying over its
hard-won rules: untrusted-input handling, one writer per file, first-line verdicts,
no prose in shell commands, secret scanning, and never merging. Scout's version
remains in that repo. What changed:

- Each job has its own state and a lease, replacing one shared board, so several
  sessions can run at once.
- State lives under `~/.claude/factory/`, not in the repo.
- Sign-off on the spec is mandatory.
- Builders and reviewers are discovered and routed, not fixed, and fallbacks are
  logged as gaps.
- Repo knowledge lives in `.claude/factory.md`, not in the agent files.
