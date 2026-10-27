# Repo profile template (`<repo>/.claude/factory.md`)

Copy this to `.claude/factory.md` in a repo and fill it in. Every factory agent reads
it from the main checkout as owner-written requirements. Keep it short and factual:
it is loaded into every spec, build, and review. Delete sections that don't apply.
Changes to it are human-owned (the approver escalates on any `.claude/` change).

```markdown
# Factory profile: <repo name>

## Stack
Tags: typescript, nextjs, react, node        <- primary first; see the factory's routing.md
Runtime: Node 24, Next.js 15 App Router, React 19, strict TypeScript

## Setup
Setup: npm ci                                <- run in a fresh worktree; omit if node_modules is symlinked
Python: <R>/.venv/bin/python                 <- for Python repos: the interpreter builders must use

## Commands
Typecheck: npm run typecheck
Lint: npm run lint
Test: npm test                               <- fast; run before every commit
Integration: npm run test:integration        <- when touching app/api, middleware, lib/db
E2E: npm run test:e2e                        <- Playwright; UI flows
Build: npm run build                         <- when touching UI or routes
Coverage: node --test --experimental-test-coverage --test-coverage-include=<file> … <tests>

## Tests
Layout: scripts/test-*.mjs (node:test); new files must be registered in package.json "test"
Fixtures: tests/fixtures/; temp dirs per test, never shared state

## Conventions
- Immutable updates; functions < 50 lines; files < 800 lines
- Routes return NextResponse.json in the neighbouring routes' shape
- No console.log; log through lib/observability

## Human-owned paths
- lib/db/schema.ts, migrations/          <- in addition to the factory's built-in list
- docs/api-v1.schema.json (breaking changes)

## Security hotspots
- middleware.ts: bearer auth, publicRoutePrefixes is a PREFIX match
- lib/files/resolve.ts: every user-supplied id must stay under DATA_ROOT
- Outbound hosts are fixed in lib/adapters/*

## UI
Tokens: app/globals.css :root (--bg, --panel, --text, --accent); no hex literals
Components: components/*.tsx, one per file, siblings are the style reference

## Lenses
Always: security                             <- lenses to include on every job, beyond the diff triggers
```
