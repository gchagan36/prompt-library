---
purpose: Thorough code review of a diff or PR, ranked by severity
model-notes:
last-validated: 2026-07-08
---

Review the following change as a senior engineer. Report findings ranked most-severe first; skip style nitpicks unless they hide a bug.

Check, in order:

1. **Correctness** — For each changed function, name one concrete input/state where it could produce wrong output or crash. If you can't, say why it's safe.
2. **Error handling** — Are failures handled at every level? Any silently swallowed errors? Do user-facing messages avoid leaking internals?
3. **Security** — Hardcoded secrets, unvalidated input at system boundaries, injection (SQL/command/XSS), missing authz checks on new endpoints.
4. **Mutation & side effects** — Does anything mutate shared state in place where a copy was expected?
5. **Tests** — What behavior changed that has no test? Name the specific missing test case, not "add more tests."
6. **Simplification** — Is there existing code in this repo that already does this? Could the change be smaller?

For each finding give: file:line, one-sentence defect statement, and a concrete failure scenario (inputs → wrong outcome). If nothing survives scrutiny, say "no findings" — do not invent issues to seem thorough.

--- PASTE DIFF BELOW ---
