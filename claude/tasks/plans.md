# Plans

## Build backupkit v1 from the approved spec (2026-08-10)

The full implementation-ready specification (v4) lives at `claude/tasks/backupkit-spec.md` -
it is the single authority. User-approved on 2026-08-10. Phases per spec section 11:

- [x] Phase 0: repo hygiene (publish script, engines, claude/ files, rule imports, skill symlinks, build exclude)
- [ ] Phase 1: foundations - `shared/`, `exec/`, `config/` + full tests
- [ ] Phase 2: building blocks - `ssh/`, `rsync/`, `snapshots/` (+ jail script), `retention/` (parallel agents, one module each)
- [ ] Phase 3: `engine/` - pipeline, scheduler, reports, disk guard
- [ ] Phase 4: `cli/` - commands, service units, bin wiring
- [ ] Phase 5: verification - /audit-security, review pass, scripts/smoke-test.sh
- [ ] Phase 6: docs - scribekit corpus + site/ + GitHub Pages deploy
- [ ] Phase 7: README restructure

Every phase ends at a green checkpoint (`npm run typecheck && npm test`) and a commit with
explicit paths. The 2-host smoke test in `scripts/smoke-test.sh` is the owner's release gate
before first production use.

### Review

(Appended when the build completes.)
