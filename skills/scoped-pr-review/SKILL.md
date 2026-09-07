---
name: scoped-pr-review
description: Review a PR, branch, or diff with subagents — scoped strictly to the changed lines — and apply fixes only for issues that affect app/logic functionality. Use when the user asks to review a PR or diff before merge (e.g. "review PR 48", "code review this diff", "review my changes"), especially when they want fixes applied, not just a report.
---

# Scoped PR review

Review a pull request, branch, or diff and (optionally) apply fixes, following a fixed set
of standing preferences: stay on the diff, use subagents, and only fix what actually
affects how the app behaves. This is a single bounded pass, not an open-ended loop.

## Process

1. **Scope to the diff, never the whole codebase.** Resolve the target to a concrete diff
   (a PR number, a branch, or the working tree) and review only those changed lines plus
   the immediate context needed to judge them. Do not audit unrelated files.

2. **Spawn a reviewer subagent.** Delegate the actual review to a code-review subagent so
   file dumps stay out of the main context. Give it the diff, the "only the diff" scope,
   and the merge bar below. Have it return findings ranked most-severe first with a
   file:line, a one-line claim, and a concrete failure scenario for each.

3. **Apply the merge bar.** Only issues that break behavior or logic are blocking. Treat
   style, naming, altitude, and behavior-preserving efficiency/refactor suggestions as
   non-blocking nits — surface them, but they do not gate merge and are not auto-fixed.

4. **Fix only app/logic items — via a subagent.** If fixes are wanted, scope them to the
   findings that affect app/logic functionality. Skip pure nits, efficiency-only, and
   dev-only-tooling items unless the user explicitly widens scope. Spawn a fix subagent (or
   do it inline for a single trivial change) and keep each fix minimal and behavior-focused.

5. **Stay bounded — no continuous loop.** Run one review pass and one fix pass. Do not
   re-review your own fixes in an open loop. Verify (build/tests) once after fixing, then
   stop and report.

6. **Report clearly.** Summarize what was fixed (in-scope) and what was deliberately left
   (out-of-scope, with a one-line reason each), so the user can widen scope if they want.

## Merge bar

Blocking: correctness bugs, logic errors, broken behavior, security issues, data loss.
Non-blocking (report only): style, naming, comments, test-altitude, and any
behavior-preserving efficiency or refactor suggestion. When in doubt, do not block and do
not auto-fix — call it out and let the user decide.
