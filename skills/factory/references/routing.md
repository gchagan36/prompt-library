# Factory routing: profile, builders, reviewers, gaps

The factory doesn't assume any particular agent exists beyond the core set
(`factory-spec-writer`, `factory-builder`, `factory-review-code`, and
`factory-approver`). It discovers what's installed, routes work to the best match,
falls back to the generic agent, and logs every fallback as an **agent gap**, so
over time you can see which specialists are worth writing.

## Codebase profile

Repo-specific knowledge (stack, commands, conventions, risky paths) lives in an
optional, owner-written **`<R>/.claude/factory.md`** (template:
`profile-template.md`). Every factory agent reads it from the main checkout `<R>`,
never from the worktree, so a build can't rewrite its own rules. Its contents are
requirements from the repo owner, at the same trust level as the feature text.

Without one, the spec writer derives a `## Codebase profile` section in `spec.md`
from the repo (manifests, lockfiles, CI config, README, test layout), and the
human checks it at sign-off. The **Report** suggests saving it as
`.claude/factory.md` once it has proven right, because a reviewed profile is
better than one re-derived for every job.

## Tags

Each package gets 1–6 tags, the **primary tag first**. Use these when they fit, and
coin a new one (`^[a-z0-9]+(-[a-z0-9]+){0,2}$`) only when none does:

| Area | Tags |
|---|---|
| Languages | `typescript` `javascript` `python` `go` `rust` `java` `kotlin` `swift` `csharp` `ruby` `bash` `sql` |
| Web/UI | `react` `nextjs` `vue` `svelte` `css` `html` `react-native` |
| Backend | `node` `api` `fastapi` `django` `flask` `graphql` `grpc` |
| Data | `db-migration` `data-pipeline` `ml` `notebook` |
| Ops | `ci` `docker` `infra` `terraform` `k8s` |
| Other | `docs` `cli` `tests` `security` `a11y` `perf` |

## Builders

**Discovery.** `fctl roster` reads `factory-builder*` agents from the project's
`.claude/agents/` and from `~/.claude/agents/` (the project wins a name clash).
Each declares what it covers in its description: `Specialties: typescript, node, react.`
The generic `factory-builder` declares `Specialties: any.`

**Routing (spec writer proposes, human signs off, `fctl plan` verifies).** For each
package:

1. Candidates are the specialists whose specialties include the package's
   **primary** tag.
2. Pick the one covering the most of the package's other tags. On a tie, pick the
   one with fewer specialties overall (the more focused agent).
3. No candidate → `factory-builder` with `gap` set to the primary tag, or to a
   sharper specialty when the primary tag is too broad to be useful
   (`react-native` rather than `javascript`).

**Packages.** One job is still one PR. Split it into packages only where the work
really divides by stack or concern (e.g. API + UI + migration). Most jobs have one
package. Each package declares the files it **owns** (globs, tests included), the
packages it **depends** on (earlier ones only), the **interfaces** it provides or
consumes (in prose in the spec), and any **hotspot** files it must touch that
others may also touch (`package.json`, lockfiles, barrel `index` files, route
registries, migration indexes). Packages run in order in one worktree.
`fctl ownership` checks every package stayed inside its files plus its hotspots.

> **v2 (not built):** packages whose owned files don't overlap could build in
> parallel in separate worktrees and be merged. That needs an integrator agent for
> hotspot files and for textual and semantic conflicts, plus rework routed back to
> each package's owner. The plan block already carries everything that would need.

## Reviewers

**Discovery.** `factory-review-<lens>` agents, from the same two directories. The
core lenses are `code`, `security`, `ui`, `ux`, and `docs`. Adding a lens means dropping in
an agent, e.g. `factory-review-a11y` or `factory-review-perf`, optionally with
`Triggers: <glob>, <glob>.` in its description.

**Selection** happens in three layers, and each one can only add lenses:

1. **Spec writer**: proposes lenses in the plan with one reason each. `code` is
   always included.
2. **Human sign-off**: can add or drop any lens except `code`, by requesting changes.
3. **`fctl lenses`**, before every round: adds lenses the actual diff requires.
   Security is on unless every changed file is docs, tests, or styles. UI is on for
   frontend files. UX is on for UI, docs, API schemas, i18n, and CLI entry points. Docs is on for
   every non-empty diff, because comment quality applies to all code; the reviewer
   exits early when nothing it covers changed.
   Custom lenses follow their `Triggers:` globs. The exact rules are in `state.md`
   under "Diff triggers". A lens can be triggered without a reviewer installed
   (e.g. a `perf` lens wanted but no agent for it): the round runs without it and a
   reviewer gap is logged.

## Agent gaps

A gap is recorded (`fctl gap`, deduplicated per job) when:

- a package falls back to `factory-builder` (`kind: builder`)
- a lens is wanted or triggered but has no reviewer (`kind: reviewer`)

The ledger is `<home>/gaps.jsonl`, shared by every repo. The dashboard's "Agent
gaps" panel and `/factory gaps` group it by specialty. **Rule of thumb:** a
specialty seen in 3 or more jobs, or in 2 or more repos, is worth a dedicated
agent. A specialist pays off when its stack knowledge would have caught things the
generic builder missed, which the job's review rounds show: count the HIGH findings
in those jobs.

**Making the specialist.** `/factory gaps` drafts one from `agent-template.md` into
`<home>/drafts/`. Move it into your agent library (e.g. prompt-library `agents/`)
and install it. The next `fctl roster` picks it up automatically, with no change to
the skill.
