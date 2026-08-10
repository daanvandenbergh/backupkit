# Backupkit security invariants

The silent-failure invariants this package must uphold. Every one of these is either enforced
by a structural guard test or checked during `/audit-security`. Breaking one is a security bug
even when nothing visibly fails.

1. No process is ever spawned with `shell: true`; no command line is ever built by string
   concatenation of config- or remote-derived values; `exec/` is the only `child_process`
   importer.
2. Every remote command argv element is quoted by the single quoter in `ssh/internal/quote.ts`;
   `--` precedes every path operand of `mkdir`/`mv`/`rm`/`df`; no other code constructs remote
   commands. The two `find` forms pass their operand BARE and must keep doing so - the jail's
   `find` case pattern hardcodes the no-`--` shape, so "fixing" the caller would make every
   listing fail with a bare "rejected". `find`'s operand is bounded by absoluteness and by
   `check_lifecycle_path`, not by `--`.
3. Passphrases are never in config values, env, argv, or logs; only ssh-add's TTY prompt or the
   0600 askpass file ever carries one. Alias remotes carry no passphrase at all (structurally
   impossible).
4. Every ssh invocation carries `BatchMode=yes`; no code path can block on an interactive
   prompt - alias mode included, because the injected command-line `-o` overrides any
   ssh_config setting.
5. `StrictHostKeyChecking` is `yes` unattended and `accept-new` only on an interactive TTY, for
   explicit and alias remotes alike; `no` is unrepresentable; a key mismatch is fatal, never
   retried at any layer (the retry classifier marks it permanent), never auto-removed.
6. There is exactly one snapshot-name regex (`shared/snapshot-name.ts`); every destructive
   operation acts only on names matching it or its `.partial`/`.deleting` forms.
7. Complete snapshot directories are never a write destination; prune never deletes the newest
   complete snapshot; restore output can never resolve inside an archive root; restore never
   passes `--delete`. The newest-snapshot floor is a CLIENT-side guard, so it binds only code
   that goes through the store - never an attacker holding the jailed key. The server-side half
   is invariant 23, and neither one alone is sufficient.
8. Private keys, passphrase files, config, known_hosts, `logging.file`, stateDir, destination
   roots, AND THE PARENT DIRECTORY OF EACH fail closed on permissive modes before any network
   I/O - for the files backupkit owns; ssh_config-managed files (alias mode) are ssh's own
   enforcement domain and are never a reason to skip checking backupkit's own files. Checking a
   0600 file inside a world-writable directory proves nothing: the attacker replaces the file.
   "Before any network I/O" binds EVERY engine verb that reaches a remote, not just the obvious
   ones - `listSnapshots` and `prune` were the sibling paths that skipped the gate while being
   exactly the verbs an operator uses to confirm the archive is healthy.
   *graduated: `src/ssh/tests/permissions.test.ts` ("checkFilePermissions - parent directories",
   "checkFilePermissions - logging.file"), `src/engine/tests/backupkit.test.ts` ("%s fails closed
   on a group-writable config, before any store access") - expect: one row per remote-I/O verb.*
9. All remote-derived data is untrusted: shape-validated before use, control-char-sanitized
   before logging, never interpolated into a subsequent command.
10. Push-mode keys are always jailed by the `backupkit-remote` forced command; the
    `authorized_keys` line (explicit remotes) or restriction prefix + key instruction (alias
    remotes) is generated only by `backupkit check` from the loaded config; no example or
    generated line ANYWHERE in the repo - source, `scripts/`, README, or docs - ever shows an
    unrestricted key. This binds the PULL side too, which has no jail: a pull key line carries
    at least `restrict` and a `from=`. The rule was written push-first and a pull-side bare
    `.pub` in `scripts/smoke-test.sh` slipped past it for exactly that reason.
11. rsync < 3.2.5 (or openrsync) on either end is refused, never worked around - on EVERY path
    that spawns rsync against a remote, `restore` included. Restore is the server-to-client
    write direction the floor exists for (the CVE-2022-29154 class), and it was the one
    entrypoint that probed only the local end.
12. Received trees are stripped of setuid/setgid and refuse device/special files unless a
    target opts in - in BOTH directions of the trust crossing. Ingest hardening alone is half
    the rule: the client's `--chmod=ug-s` never reaches the server argv, so on a push the
    stripping is done by the machine the model distrusts, and `restore` is where the archive's
    contents re-enter a trusted host. A restore that omits the ingest flags recreates a
    setuid-root binary or a device node outside every archive root - where the `nosuid`/`nodev`
    mount the docs prescribe structurally cannot reach it.
13. Config is read only through the single JSONC reader in `config/internal/jsonc.ts`, whose
    tolerance is exactly comments and trailing commas; duplicate keys are fatal, so a shadowed
    remote or target is unrepresentable.
14. Alias mode never weakens the baseline: `sshArgs` injects `BatchMode=yes`, `ConnectTimeout`,
    `ServerAlive*`, `LogLevel=ERROR`, and the contextual `StrictHostKeyChecking` on the command
    line for every remote kind, and injects NO identity/port/known_hosts options for aliases;
    an alias remote admits no sibling config fields, and the alias charset excludes every
    character that could confuse host:path splitting, option parsing, or quoting.
15. The push jail validates the RESOLVED path, not just the literal string: for every path
    operand, `backupkit-remote` walks each existing prefix component and refuses if any is a
    symlink, so an attacker-planted symlink inside the jail (rsync transfers symlinks by
    default) can never be traversed to write outside `$ROOT`. The `authorized_keys` forced
    command shell-quotes the jail root so a destination with spaces or quotes cannot widen or
    break out of it.
16. Every remote-derived string is stripped of C0, DEL, C1 (0x80-0x9f), the line separators
    U+2028/U+2029, AND THE WHOLE BIDI FAMILY - U+061C, U+200E/U+200F, U+202A-U+202E, and the
    isolates U+2066-U+2069 - before it reaches a log or a run-report. Naming U+202E alone was
    the bug: RLE (U+202B) and RLI (U+2067) reverse rendering exactly as RLO does, so a hostile
    filename still reached the operator's terminal reversed while the rule read as satisfied.
    Sanitizing must also happen BEFORE any truncation, or a control-char flood pushes the real
    text out of the window (see `sshStderrTail`, the single owner).
17. No non-idempotent remote command is ever transport-retried. `runRemote`'s retry re-executes
    the whole ssh command, so a blip AFTER the remote already applied the change re-applies it:
    the lock-acquire `mkdir` and all three `mv` renames therefore carry `NO_RETRY_POLICY` through
    the store's per-call runner override. Retrying the lock mkdir is the worst case - the second
    attempt reads EEXIST against this process's own fresh lock, and a lock with no creation
    marker has no TTL, so the target stops backing up permanently while `status()` still reads
    green (the scheduler swallows `lock-held` without a report, and remote stores report
    `lockHeld: false`). Only reads (`find`, `df`) and idempotent commands (`mkdir -p`, `rm -rf`)
    may retry. *graduated: `src/snapshots/tests/remote-store.test.ts` ("issues every mutating
    remote command with NO_RETRY_POLICY", "never re-sends the lock mkdir when the transport
    blips") - expect: exactly 3 unretried commands per locked run.*
18. Every path in a `ResolvedConfig` is in ONE normal form (duplicate slashes collapsed, trailing
    slash stripped, no `.`/`..` component), because a target's `destination` reaches the push jail
    by two routes - the literal string baked into the `authorized_keys` forced command as `$ROOT`,
    and `posix.join`-built operands - which the jail compares as literal string prefixes. A
    non-normal destination validates, prints a plausible jail line, then has every remote command
    rejected; a `..` component makes the jail refuse to start at all. Normalization belongs in
    `expectPath`, never at a single use site. *graduated: `src/config/tests/validate.test.ts`
    ("returns every path in one normal form", the `.`/`..` rejection table).*
19. The generated systemd unit's `ReadWritePaths` covers EVERY path the daemon writes - each local
    destination root, `stateDir`, the config dir, the `logging.file` dir, and (per explicit remote)
    the `identityFile` and `knownHostsFile` directories, because preflight creates the known_hosts
    file and `agent.ts` writes the `.pub` sidecar. The runtime dir is NOT a `ReadWritePaths` member:
    systemd resolves those entries before `ExecStart` and a missing one is fatal (226/NAMESPACE),
    and `/run` is tmpfs that the daemon creates for itself - so it survived install and died at the
    first reboot into a silent forever-restart. `RuntimeDirectory=`/`RuntimeDirectoryMode=` own it
    instead, and any member install does not itself create is `-`-prefixed so a missing path
    surfaces as backupkit's own error rather than a namespace failure.
    Under `ProtectSystem=strict` a missing member is not a hardening gap but a crash loop
    (`Restart=on-failure` with `StartLimitIntervalSec=0` never gives up). The unit is a mirror of
    config-derived facts, so `start` and `restart` re-derive and refresh it - `install` alone is
    not enough, because a target added later would otherwise be sandboxed away from its archive.
    Independently, the `logging.file` sink is fail-safe: a log write must never throw out of the
    call site that logged. *graduated: `src/cli/tests/units.test.ts` ("includes the logging.file
    directory"), `src/cli/tests/service.test.ts` ("refreshes a unit that no longer matches"),
    `src/engine/tests/backupkit.test.ts` ("an unwritable logging.file disables file logging").*
20. The rsync >= 3.2.5 floor (invariant 11) is probed per host AND per binary. `rsync.remoteRsyncBin`
    is a per-TARGET setting, so two targets can share one host while pointing `--rsync-path` at
    different binaries; a host-only cache key lets the first target's result stand in for the
    second's, and the binary its transfer really uses is never checked. Both probe caches key on
    `<identity>\0<bin>`, and `check` probes every binary in use on a remote.
    *graduated: `src/rsync/tests/probe.test.ts` ("probes each binary on one host separately"),
    `src/engine/tests/backupkit.test.ts` ("probes each remoteRsyncBin on a shared remote").*
21. `backupkit-remote.sh` re-implements the snapshot-name codec and the target-name charset in
    POSIX shell, and it is a copy deployed out-of-band on each archive server. The single-source
    regex guard scans `.ts` only, and the older jail suite feeds LITERAL names, so neither can see
    a codec change: widening either grammar would ship a client whose every push operation an
    installed jail rejects with a bare "rejected". The parity guard derives its cases from
    `formatSnapshotName` and from `validateConfig` itself and runs the shipped script.
    *graduated: `src/snapshots/tests/jail-grammar.test.ts` - expect: the candidate set spans both
    validator verdicts (its own vacuity guard).*
22. The graceful-shutdown signal reaches EVERY child, not just rsync. The snapshot store's remote
    commands and `withTransientRetry`'s backoff both take it, so a stop is bounded by the child's
    death rather than by a 60 s ssh timeout times its attempts, or by a backoff of up to the
    300 s transfer cap. Without this a `systemctl stop` against an unresponsive archive host
    overruns `TimeoutStopSec=30` and is SIGKILLed mid-lock, leaving a remote lock only the 24 h
    TTL clears. *graduated: `src/shared/tests/retry.test.ts` ("an abort mid-backoff wakes the
    sleep immediately"), `src/snapshots/tests/remote-store.test.ts` ("aborts an in-flight store
    command when the shutdown signal fires").*
23. The jail's `rm -rf` branch uses a NARROWER component policy than every other verb. `mkdir`,
    `mv`, `find` and `df` legitimately name a bare target directory or a complete snapshot, so
    `check_component` permits both - and sharing that function with `rm -rf` made
    `rm -rf -- <root>/<target>` and `rm -rf` of the newest complete snapshot legal jail commands,
    i.e. a compromised push client could erase a target's entire history in one line. The
    legitimate client never issues those shapes: its delete is two-phase (`mv` to `.deleting`,
    then `rm -rf` the `.deleting` leaf), so the only leaves it ever removes are `<snap>.partial`,
    `<snap>.deleting` and `.backupkit.lock`. `check_delete_component` enforces exactly that, and
    invariant 7's newest-snapshot floor is the client-side half of the same property. A new verb
    that reuses `check_lifecycle_path` without passing the `delete` mode silently re-opens this.
    *graduated: `src/snapshots/tests/jail.fake.test.ts` ("rm -rf is narrower than every other
    verb (the delete-component policy)") - expect: >= 4 reject rows and exactly 3 accept rows,
    plus the "broader policy the other verbs need is untouched" row.*
24. The jail's rsync grammar is validated against what the LOCAL rsync REALLY EMITS, never
    against a hand-written command string. rsync re-serializes its own options for `--server`:
    it splits `--opt=value` into two argv elements and backslash-escapes spaces. A grammar
    written from the client's intent therefore passes every synthetic test and rejects every
    real push, with a bare "rejected" and no other signal. This shipped: `validate_rsync`
    accepted only `--link-dest=../<snap>` while rsync sends `--link-dest ../<snap>`, so every
    incremental push snapshot would have been refused, and the jail suite was green because it
    fed the `=` form it invented. This rule is METHODOLOGY and cannot be graduated to a grep -
    the test must capture a real `SSH_ORIGINAL_COMMAND` (an `-e` recorder against a fake host)
    and feed THAT to the shipped script, for the first-snapshot argv and the `--link-dest` argv
    both. *partially graduated: `src/snapshots/tests/jail.fake.test.ts` ("permits the REAL
    captured rsync argv, whose --link-dest is space-separated").*
25. Every rsync `-e` value carries the ssh BINARY, not just ssh options. `sshArgs()` returns
    options only, by design - `runRemote` supplies the binary separately - so feeding its result
    straight into `-e` produces `-e "-o BatchMode=yes ..."`, and rsync tries to exec `-o`. Every
    remote transfer, estimate and restore failed with `Failed to exec -o` (exit 14). It stayed
    invisible because the argv unit test supplies the `"ssh"` token itself and the engine tests
    inject a fake `transfer`, so no test crossed the engine-to-argv seam. There is now one
    producer, `sshCommandFor`; a second call site that reaches for `sshArgs` directly re-opens it.
    *graduated: `src/engine/tests/backupkit.test.ts` ("the rsync -e command the engine builds
    starts with the ssh binary") - it must be an ENGINE test; an args-level test cannot see this.*
26. A snapshot name or lock marker dated in the FUTURE is never trusted as genuine and never
    becomes permanently undeletable. The client's own clock is the only legitimate writer of
    both, and the jail accepts any snapshot-shaped `mkdir`, so one command plants either. Two
    silent-failure shapes came from one sign error: `ageMs > LOCK_TTL_MS` can never fire for a
    negative age, so a future-dated lock marker is held forever (and the scheduler swallowed
    `lock-held` with no report, leaving `status` green); and an unconditional "never delete the
    newest complete snapshot" makes a future-dated snapshot both permanently fatal to every run
    and impossible for `prune` to clear. Comparisons against a marker or name age use
    `Math.abs`, and `prune` can always clear a future-dated name - EXCEPT when it is the only
    snapshot, since it might be the sole copy. Do NOT solve this by excluding future names from
    the newest computation: a backwards clock makes real snapshots look future-dated, and that
    would auto-prune real data. *graduated: `src/snapshots/tests/remote-store.test.ts` (future
    marker is stale), `src/engine/tests/backupkit.test.ts` ("a future-dated snapshot fails the
    run, is pruned by prune, and the target then runs again", "...that is the ONLY snapshot is
    never pruned away").*
27. A run whose content COLLAPSES against the previous snapshot promotes but prunes nothing.
    `--delete --force` plus count-based retention means a compromised source that presents an
    empty or selectively-emptied tree promotes empty snapshots until retention has aged out
    every snapshot holding real data - destroying the archive from the source side, which is
    exactly what the README promises cannot happen. Retention selects purely on names and
    counts, so it has no content signal of its own; the tripwire supplies one. It fails SAFE in
    one direction only: skipping a prune costs disk, never data, so a false trip is cheap and a
    missed trip is permanent. `backupkit prune` is the operator's override once a human has
    confirmed the shrink is real. *graduated: `src/engine/tests/target-runner.test.ts` (collapse
    -> no removes + an error log; a shrink inside the threshold still prunes).*
28. No engine method captures unbounded child output, and no child's stdout/stderr is trusted to
    be small. A hostile remote's rsync stderr flows through ssh into the local pipe; string
    concatenation past V8's ~512 MB limit throws `RangeError` inside a stream `data` listener -
    outside the promise, uncatchable by the caller, with no `uncaughtException` handler in the
    tree - so the daemon dies and `Restart=on-failure` with `StartLimitIntervalSec=0` turns that
    into a permanent crash loop. `exec()` caps each stream (stderr keeps the tail, stdout the
    head) and sets `truncated`. A new capture path that accumulates without a cap re-opens it.
    *graduated: `src/exec/tests/exec.test.ts` ("caps captured stdout ... keeps the HEAD", "caps
    captured stderr ... keeps the TAIL").*
