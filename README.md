# Prompt & Skill Library

A model-agnostic library of prompts, agent definitions, and workflow templates. Everything here is designed to survive model/pricing changes — plain markdown, no vendor lock-in.

## Structure

```
prompts/
  coding/     implementation, refactoring, debugging prompts
  review/     code review, security review checklists
  writing/    docs, PR descriptions, explanations
  analysis/   architecture, research, decision-making
skills/       Claude Code skill definitions (portable SKILL.md format)
agents/       subagent definitions (frontmatter + system prompt)
hooks/        Claude Code hooks (one folder per hook, with a hook.json manifest)
scripts/lib/  helpers sourced by install.sh
hooks/        Claude Code hook scripts, one folder per hook (script + README + tests)
templates/    reusable document skeletons (ADRs, runbooks, PR bodies)
```

## Install

`./install.sh` links agents, skills and hooks into `~/.claude` (or a single project). Install everything, one category, or named items, and re-running is safe:

```bash
./install.sh --all                     # everything
./install.sh --skills --hooks          # categories
./install.sh --agents planner,debugger # specific items
./install.sh                           # interactive menu
```

See [INSTALL.md](INSTALL.md) for every option, project installs, uninstalling, and adding a hook.

## Conventions

- One prompt per file. Filename = what it does (`refactor-to-small-files.md`).
- Each prompt file starts with a short frontmatter block:

```yaml
---
purpose: one-line description
model-notes: anything model-specific (usually empty)
last-validated: YYYY-MM-DD
---
```

- Write prompts to be **self-contained**: include the role, the constraints, the output format. A good prompt works pasted into any LLM chat, not just Claude Code.
- When a prompt produces a noticeably better result after tweaking, update the file — this library only compounds if it's maintained.

## Relationship to other config

- `~/.claude/CLAUDE.md` + `~/.claude/rules/` — *always-on* behavior for Claude Code sessions.
- This library — *on-demand* prompts and definitions you invoke deliberately or copy elsewhere.
- Exocortex vault (`Knowledge/`) — durable *knowledge*; this repo is durable *tooling*. Link between them.
