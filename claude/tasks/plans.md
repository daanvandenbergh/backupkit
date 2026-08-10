# Plans

## Build backupkit v1 from the approved spec (2026-08-10)

The full implementation-ready specification (v4) lives at `claude/tasks/backupkit-spec.md` -
it is the single authority. User-approved on 2026-08-10. Phases per spec section 11:

- [x] Phase 0: repo hygiene (publish script, engines, claude/ files, rule imports, skill symlinks, build exclude)
- [x] Phase 1: foundations - `shared/`, `exec/`, `config/` + full tests
- [x] Phase 2: building blocks - `ssh/`, `rsync/`, `snapshots/` (+ jail script), `retention/`
- [x] Phase 3: `engine/` - pipeline, scheduler, reports, disk guard
- [x] Phase 4: `cli/` - commands, service units, bin wiring
- [x] Phase 5: verification - adversarial review (20 findings fixed) + /audit-security (3 findings, 1 critical, fixed) + scripts/smoke-test.sh
- [x] Phase 6: docs - scribekit 8-page corpus + site/ + GitHub Pages deploy
- [x] Phase 7: README restructure

DONE. Final state: 102 source files, 47 test files, 1176 tests passing (5 skipped - the
rsync integration suite, gated on rsync >= 3.2.5, which this macOS dev host lacks). Typecheck
clean, `npm run build` produces a working `dist/cli/main.js`, `npm run docs:build` static-exports.

### Review

The build ran as a design team (14-agent workflow producing the spec, revised 4x per owner
feedback: JSONC config, structured interval/intervalCount schedules incl. minute+month,
maximized retry/restart stability, ssh-alias remotes, full daemon-lifecycle CLI) then phased
build agents with green-checkpoint commits. A cross-module adversarial review (4 finder lenses
+ 2-vote verification) found 20 real defects; a follow-up /audit-security found 1 more critical
(jail validated path strings but not the resolved path - a planted symlink could be traversed
out of the jail root). All fixed with regression tests.

Deferred to the owner (needs the real world, cannot be finished by typing):
- Run `scripts/smoke-test.sh` against two real hosts before first production use (the release gate).
- On the dev machine, `brew install rsync` to light up the 5 skipped rsync-integration tests.
- Push, publish (`npm publish`), and enable GitHub Pages on the repo (the deploy workflow is in
  place at .github/workflows/deploy.yml; first Pages deploy needs Pages enabled in repo settings).
