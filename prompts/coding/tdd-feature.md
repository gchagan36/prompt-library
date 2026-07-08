---
purpose: Implement a feature strictly test-first, with verification at each step
model-notes:
last-validated: 2026-07-08
---

Implement the feature described below using strict TDD. Follow this loop and show your work at each step:

1. **RED** — Write the failing test first. Run it and show me the failure output. If it passes before implementation, the test is wrong — fix the test.
2. **GREEN** — Write the minimal implementation that makes it pass. Run the test and show the pass.
3. **REFACTOR** — Clean up while keeping tests green. New objects over mutation; small functions (<50 lines); extract rather than nest.
4. Repeat per behavior until the feature is covered: happy path, edge cases, and at least one failure/error path.
5. **Verify** — Run the full suite and report coverage for the touched files. Then exercise the feature end-to-end (not just unit tests) and describe what you observed.

Constraints:
- Fix the implementation, not the tests, when a test fails — unless you can articulate why the test itself is wrong.
- No test that merely mirrors the implementation; each test must state a behavior a user or caller depends on.

--- FEATURE DESCRIPTION BELOW ---
