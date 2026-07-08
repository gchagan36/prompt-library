---
purpose: Generate a durable "how this system actually works" doc for an unfamiliar or undocumented repo
model-notes:
last-validated: 2026-07-08
---

Explore this codebase and write an architecture document for a new senior engineer joining the project. Do not paraphrase the README — derive everything from the code itself.

Cover:

1. **What it does** — the product/system purpose in 2–3 sentences, inferred from entry points and domain models.
2. **Runtime shape** — processes, services, entry points, and how a request/job flows end to end. Name actual files and functions.
3. **Data model** — core entities, where they're defined, how they're persisted.
4. **Key decisions embedded in the code** — patterns in use (and where they're violated), notable dependencies and why they're probably there.
5. **The sharp edges** — global state, implicit ordering requirements, config that must exist, anything that will bite someone making their first change.
6. **Where to start** — the 5 files to read first, in order, with one line on why each matters.

Format as markdown with file paths as inline code. Mark anything inferred-but-unverified with "(inferred)". Target 1–2 pages — dense, not exhaustive.
