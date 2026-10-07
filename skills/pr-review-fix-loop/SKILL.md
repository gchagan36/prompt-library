---
name: pr-review-fix-loop
description: Review a PR with subagents, post the feedback to the PR, fix only Critical/High issues, push the fixes, and re-review — looping for up to three cycles until no Critical/High remain. Use when the user wants an iterative review-and-fix loop on a PR that posts its feedback and applies fixes (e.g. "review and fix PR 48 in a loop", "keep reviewing and fixing this PR until it's clean", "iterate on PR 30 up to 3 rounds"), not a single bounded pass.
---

# PR review-and-fix loop

Run a bounded review→fix→re-review loop **on a specific pull request**: each cycle reviews
only the PR's changed lines, posts the findings to the PR, fixes only what breaks
behavior (Critical/High), pushes those fixes to the PR branch, then re-reviews the updated
PR. The loop stops as soon as no Critical/High findings remain, or after three cycles —
whichever comes first. This is the iterative counterpart to `scoped-pr-review`; use it only
against an explicitly named PR whose branch you can push to (never against `main`/`develop`
directly).

## Process

1. **Resolve and confirm the PR.** Take a concrete PR number/URL — this skill posts
   comments and pushes commits, so it needs a real PR, not a bare working tree. Confirm
   access with `gh auth status`, read it with `gh pr view <n>`, and check out its head
   branch with `gh pr checkout <n>`. Refuse to run if the target resolves to `main`/`develop`.

2. **Review — scoped to the diff, via subagents.** Delegate to the `code-reviewer` agent
   (add the `security-reviewer` agent when the diff touches auth, user input, secrets, or
   network calls). Give it `gh pr diff <n>` and the "only the changed lines plus immediate
   context" scope. Have it return findings ranked most-severe first, each tagged
   Critical/High/Medium/Low with a `file:line`, a one-line claim, and a concrete failure
   scenario. Do not audit unrelated files.

3. **Post the feedback to the PR.** Post one `gh pr comment <n> --body "…"` per cycle with a
   structured body: a `### Review cycle <k>` header, then **Critical**, **High**, and
   **Medium / Low (noted, not fixed)** sections listing each finding's `file:line`, claim,
   and scenario. This comment is the visible record of the cycle and the spec for the fix step.

4. **Stop early when clean.** If the cycle surfaced no Critical or High findings, the loop is
   done: leave the Medium/Low notes on the PR, skip fixing, and go to step 8.

5. **Fix — Critical/High only, from the posted feedback.** Spawn a fix subagent whose input
   is the feedback just posted to the PR (fetch it with `gh pr view <n> --comments`). Scope
   it strictly to the Critical/High items; skip Medium/Low, style nits, and
   efficiency-only/refactor suggestions unless the user widened scope. Keep each fix minimal
   and behavior-focused.

6. **Verify, commit, and push.** Run the project's build/tests once after fixing. Commit the
   fixes with a conventional-commit message (`fix: …`), no AI-attribution lines, then
   `git push` to the PR's head branch so the PR reflects the fixes.

7. **Re-review.** Return to step 2 for the next cycle; the reviewer now reads the updated
   `gh pr diff <n>`, confirming prior fixes and catching anything they introduced.

8. **Bound the loop to three cycles.** Stop at the earlier of: no Critical/High remain, or
   three completed cycles. If Critical/High are still open after cycle 3, post a final
   `gh pr comment` listing exactly what remains unresolved rather than continuing.

9. **Report.** Summarize the cycles run, what was fixed and pushed in each, the Medium/Low
   items left noted on the PR, and any Critical/High still open after three cycles.

## Fix scope

Fix (and re-review): Critical/High — correctness bugs, logic errors, broken behavior,
security issues, data loss. Note only (posted to the PR, never auto-fixed): Medium/Low —
style, naming, comments, test-altitude, and any behavior-preserving efficiency or refactor
suggestion. When a finding's severity is ambiguous, treat it as Medium/Low: note it, do not
fix it, and let the user decide.
