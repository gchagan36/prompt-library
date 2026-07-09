---
name: fewer-permission-prompts
description: Analyze recent tool usage for safe, frequently-approved commands and add them to the permission allowlist so future sessions prompt less. Use when the user complains about approval interruptions or asks to reduce permission prompts.
---

# Fewer permission prompts

> NOTE: Claude Code ships a built-in `/fewer-permission-prompts` skill. Prefer the built-in when available — this is the portable fallback for environments without it.

Reduce permission-prompt fatigue by allowlisting commands the user approves routinely — without ever allowlisting anything dangerous.

## Process

1. **Gather evidence.** Look at what actually gets run: session transcripts under `~/.claude/projects/<project-dir>/` if readable, plus the current conversation. Build a frequency list of Bash command prefixes and MCP tool names that have been approved repeatedly.

2. **Filter to safe candidates.** Only propose commands that are read-only or trivially reversible:
   - Safe: `ls`, `cat`, `grep`/`rg`, `find`, `git status/log/diff/show/branch`, `npm test`, `pytest`, linters, `gh pr view/list`, read-only MCP tools
   - Never allowlist: anything that writes outside the repo, deletes (`rm`), installs (`npm install`, `pip install`), pushes (`git push`), network mutation (`curl -X POST`), sudo, or piped-to-shell patterns
   - When unsure whether a command mutates, leave it out.

3. **Choose scope.** Project-specific commands (test runners, build tools) → `<project>/.claude/settings.json`. Universal read-only commands (`git status`, `ls`) → `~/.claude/settings.json`. Use `settings.local.json` for anything the user wouldn't want committed.

4. **Propose before writing.** Show the user the exact `permissions.allow` entries as a prioritized list (most-prompted first) with the rule syntax, e.g.:
   ```json
   { "permissions": { "allow": ["Bash(git status:*)", "Bash(rg:*)", "Read(//home/user/**)"] } }
   ```
   Get confirmation, then merge into the existing settings file — never clobber existing entries.

5. **Verify.** Re-read the settings file after editing to confirm valid JSON and that prior entries survived.

## Quality bar

Ten well-chosen rules that eliminate 80% of prompts beat fifty speculative ones. Every rule must be justified by observed usage, not hypothetical convenience.
