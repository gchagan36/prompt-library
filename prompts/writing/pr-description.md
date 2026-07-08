---
purpose: Generate a complete PR description from a branch diff
model-notes:
last-validated: 2026-07-08
---

Look at the full branch history (`git log` and `git diff <base>...HEAD` — all commits, not just the latest) and write a PR description:

**Title** — conventional commit style: `<type>: <description>`.

**Body:**
- **What changed** — bullet the meaningful changes, grouped by area. Omit mechanical churn (lockfiles, formatting).
- **Why** — the problem or issue this solves. Reference the issue with `Closes #<n>` if one exists.
- **How to test** — exact commands or click-paths a reviewer can run, plus what they should observe.
- **Risk & rollout** — anything reversible-with-difficulty: migrations, config changes, behavior changes for existing users. Say "none" if none.

Keep it honest: if tests are missing or something is untested, list it under a **TODO** section rather than omitting it.
