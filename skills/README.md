# Skills

Claude Code skill definitions. Each skill is a directory containing a `SKILL.md`:

```
skills/
  my-skill/
    SKILL.md        # frontmatter (name, description) + instructions
    references/     # optional supporting docs the skill can load
```

`SKILL.md` frontmatter:

```yaml
---
name: my-skill
description: One line saying when to use this skill — this is what triggers it.
---
```

To install skills, run `../install.sh --skills` (or name individual skills, e.g. `--skills vault-distill`). It symlinks each directory into `~/.claude/skills/` (global) or `<project>/.claude/skills/` (with `--project-dir`). See [../INSTALL.md](../INSTALL.md). Keeping the source of truth here means skills survive reinstalls and can be versioned with git.

Agent definitions in `../agents/` install the same way into `~/.claude/agents/` or `<project>/.claude/agents/`.
