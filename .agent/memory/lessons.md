# Lessons

Corrections and confirmed approaches from the user, one entry each. Newest first.

- 2026-08-10: Spec revisions the owner made during planning, binding on all future design work:
  config must be JSONC (comments supported); schedules are structured
  `{interval, intervalCount}` objects, never string grammars; remotes support ssh_config
  aliases (`{alias}`) alongside explicit form; retry/restart resilience is a headline feature,
  not an option; detailed is good but over-engineering is not (owner trimmed `--json`
  everywhere, table formatter, log self-rotation).
