# Runbook: <service/system>

- **Last verified:** YYYY-MM-DD
- **Owner:** <who>
- **Host/location:** <where it runs — box, VM, container, port>

## What it does

One paragraph: purpose, who/what depends on it, blast radius if it's down.

## Health checks

Exact commands or URLs, with expected output:

```bash
<command>   # expect: <output>
```

## Common failures

For each known failure mode:

### Symptom: <what you observe>
- **Likely cause:**
- **Diagnose:** `<command>` — what confirms it
- **Fix:** exact steps, in order
- **If that doesn't work:** escalation path / next hypothesis

## Routine operations

- **Start/stop/restart:** `<commands>`
- **Logs:** `<where, and how to tail>`
- **Backup/restore:** `<how, and where backups live>`
- **Update procedure:** steps, including how to roll back

## Configuration

Where config lives, what's safe to change, what requires a restart. Note any secrets' *locations* (never values).

## History

Dated log of incidents and changes — newest first. One line each.
