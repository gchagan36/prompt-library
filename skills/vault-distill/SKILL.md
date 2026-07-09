---
name: vault-distill
description: Distill the current session into durable Knowledge notes in the Exocortex vault. Use when the user says "distill this", "save what we learned", or at the end of a session that produced reusable understanding (not just project narrative).
---

# Vault distill

Extract the *durable knowledge* from this conversation and write it into the Exocortex vault's `Knowledge/` folder. This is different from the session summary in `Conversations/` (which records what happened): a knowledge note must be useful to someone who never reads this conversation.

## Process

1. **Inventory the candidates.** Scan the session for things with a shelf life beyond this task:
   - Concepts or mental models that were explained or corrected
   - Non-obvious facts about tools, systems, or the user's own infrastructure
   - Decision rules ("when X, prefer Y because Z")
   - Debugging insights whose root cause generalizes
   Exclude: task narrative, one-off values, anything trivially re-derivable from docs, sensitive data.

2. **Search before writing.** For each candidate, search the vault (`Knowledge/` first) for an existing note on the topic. **Prefer updating an existing note over creating a new one** — amend, don't overwrite; never silently delete past thinking.

3. **Write dense notes.** One topic per note, `Knowledge/<topic>.md`. Each note:
   - Required frontmatter: `date`, `tags`, `source: claude-session`, `related`
   - Lead with the mental model or rule, not the story of how it came up
   - Concrete examples from the user's actual stack where possible
   - Mark speculation explicitly — future readers treat these notes as ground truth
   - Link liberally with `[[wikilinks]]` to related notes found in step 2

4. **Connect the graph.** Add backlinks: if an updated note relates to a project, link it from that project's `index.md`. Update the session's `Conversations/` note to link the knowledge notes under **Artifacts**.

5. **Report.** End with the standard vault operations line: which notes were created vs. updated, one phrase on what each contains. If nothing in the session cleared the durability bar, say so explicitly rather than manufacturing notes.

## Quality bar

Density over volume: 1–3 strong notes beat 8 shallow ones. A good distilled note answers "what do I now know that I didn't?" — if a note only answers "what did we do?", it belongs in `Conversations/`, not `Knowledge/`.
