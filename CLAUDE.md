# Project: Backupkit

Backupkit is an npm typescript package for creating backups with `rsync`. It handles automated,
versioned backups over SSH, in both directions: **push** (the source host sends its data to the
backup server) and **pull** (the backup server reaches out and fetches from the source, so a
compromised source host cannot touch the backup archive).

## Directory Architecture

```
assets/
  logo/                             # The mark: bare SVG + dark and light app tiles
claude/
  scribekit-hero/readme/            # The README hero: brand settings, params, rendered hero.png
src/
  index.ts                          # Package root entry (".")
```
Each top-level `src/` folder is one module. Modules that are part of the public API are
re-exported from `index.ts`; internal ones are deliberately not exported.

## Commands
`npm run typecheck` (`tsc --noEmit`) · `npm test` (vitest) · `npm run build` (emits `dist/`) ·
`npm run test:watch`. **No linter, no formatter, no CI: typecheck and test are the only gates** -
so a change is not done until both are green. Vitest collects `src/**/tests/**/*.test.ts` only.

## Conventions
- **Tests go in a `tests/` subdir next to the code**, NEVER alongside the source -
  `src/<module>/tests/<thing>.test.ts`. (The imported `ts_modular_coding` rule shows a test at the
  module root; this project overrides that, and `vitest.config.ts` only collects the subdir - a test
  written beside its source silently never runs.)
- **An architectural promise is kept by a red test, not by this document.** When a rule matters
  (a module that must not reach the filesystem, a flag that must never be passed), write the test
  that fails when it breaks, and name it here.
- **Anything that shells out is a trust boundary.** A path, a host, or a remote spec that reaches an
  `rsync`/`ssh` argument list is validated before it gets there, and arguments are passed as an
  array - never interpolated into a shell string.
- **Never run a real destructive operation to "test" it.** `rsync --delete` against a live tree, a
  prune of real snapshots: those are exercised against a temp fixture dir, never a user's data.

@node_modules/@daanvandenbergh/claudekit/rules/ts_coding_standards.md
@node_modules/@daanvandenbergh/claudekit/rules/core_principles.md
@node_modules/@daanvandenbergh/claudekit/rules/workflow.md
@node_modules/@daanvandenbergh/claudekit/rules/todo.md
@node_modules/@daanvandenbergh/claudekit/rules/ts_modular_coding.md
@node_modules/@daanvandenbergh/claudekit/rules/active_sessions.md
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

## Releasing
Bump `version` in `package.json` and `npm publish` (public scope; `prepublishOnly` builds). The
user publishes and pushes - never do either unasked.

## The public contract stays in lockstep
`README.md` is this package's contract with its users. Any change to the API, the config shape, or
the on-disk snapshot layout updates the README in the SAME change - a doc that lags the code is
part of the definition of NOT done.
