# Backupkit security invariants

The silent-failure invariants this package must uphold. Every one of these is either enforced
by a structural guard test or checked during `/audit-security`. Breaking one is a security bug
even when nothing visibly fails.

1. No process is ever spawned with `shell: true`; no command line is ever built by string
   concatenation of config- or remote-derived values; `exec/` is the only `child_process`
   importer.
2. Every remote command argv element is quoted by the single quoter in `ssh/internal/quote.ts`;
   `--` precedes every path operand; no other code constructs remote commands.
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
   passes `--delete`.
8. Private keys, passphrase files, config, known_hosts, stateDir, and destination roots fail
   closed on permissive modes before any network I/O - for the files backupkit owns;
   ssh_config-managed files (alias mode) are ssh's own enforcement domain and are never a
   reason to skip checking backupkit's own files.
9. All remote-derived data is untrusted: shape-validated before use, control-char-sanitized
   before logging, never interpolated into a subsequent command.
10. Push-mode keys are always jailed by the `backupkit-remote` forced command; the
    `authorized_keys` line (explicit remotes) or restriction prefix + key instruction (alias
    remotes) is generated only by `backupkit check` from the loaded config; no example or
    generated line ever shows an unrestricted key.
11. rsync < 3.2.5 (or openrsync) on either end is refused, never worked around.
12. Received trees are stripped of setuid/setgid and refuse device/special files unless a
    target opts in.
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
16. Every remote-derived string is stripped of C0, DEL, C1 (0x80-0x9f), and the bidi/line
    separators U+2028/U+2029/U+202E before it reaches a log or a run-report - no
    terminal-escape or bidi-spoof survives into operator-facing output.
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
    destination root, `stateDir`, the runtime dir, the config dir, and the `logging.file` dir.
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
