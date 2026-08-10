# Project: Backupkit

Backupkit is an npm typescript package for backing up projects and data.

## Directory Architecture

```
src/
  index.ts                          # Package root entry (".")
```
Each top-level `src/` folder is one module. Modules that are part of the public API are
re-exported from `index.ts`; internal ones are deliberately not exported.

@node_modules/@daanvandenbergh/claudekit/rules/ts_coding_standards.md
@node_modules/@daanvandenbergh/claudekit/rules/core_principles.md
@node_modules/@daanvandenbergh/claudekit/rules/workflow.md
@node_modules/@daanvandenbergh/claudekit/rules/todo.md
@node_modules/@daanvandenbergh/claudekit/rules/ts_modular_coding.md
@node_modules/@daanvandenbergh/claudekit/skills/ts/audit-tests/claude-rules.md

## Git
- Never create new git branches unless asked, if you really feel it is needed, ask for permission first.
- **A session MAY commit its own verified work, and should** - a finished unit sitting uncommitted is
  one git accident away from gone.
  - **Stage EXPLICIT PATHS ONLY - `git add <the files you edited>`. NEVER `git add -A`, `git add .`
    or `git commit -a`.**
  - **Commit only at a GREEN CHECKPOINT** - typecheck + tests have passed on the unit you are
    committing. A commit is a recovery point; a broken one is a trap wearing one.
  - **The message names the area and what shipped**, ending with the Co-Authored-By trailer.
  - **NEVER push** - the user pushes.

## Maintained README.md
When making changes to the library, ensure the README.md instructions for how to use the library are still up to date.
