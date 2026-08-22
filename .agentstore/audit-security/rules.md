# Backupkit security invariants

The silent-failure invariants this package must uphold. Every one of these is either enforced
by a structural guard test or checked during `/audit-security`. Breaking one is a security bug
even when nothing visibly fails.

1. No process is ever spawned with `shell: true`; no command line is ever built by string
   concatenation of config- or remote-derived values; `exec/` is the only `child_process`
   importer.
2. Every remote command argv element goes through `ssh/internal/quote.ts`;
   `--` precedes every path operand of `mkdir`/`mv`/`rm`/`df`/`ls`; no other code constructs remote
   commands. The `find` forms pass their operand BARE and must keep doing so - the jail's
   `find` case pattern hardcodes the no-`--` shape, so "fixing" the caller would make every
   listing fail with a bare "rejected". `find`'s operand is bounded by absoluteness and by
   `check_lifecycle_path`, not by `--`.
   That module now holds TWO quoters, and which one runs is decided by `remote.restrictedShell`
   in `runRemote` - the single place allowed to make that choice. `quoteShellArg` (the default)
   makes ANY value one shell word. `bareShellArg` returns the value unchanged and is only for an
   appliance account whose shell parses no quoting at all (a Hetzner Storage Box reads `'mkdir'`
   as a command named `'mkdir'`), where no escape would survive; its safety therefore comes from
   REFUSING anything outside `^[A-Za-z0-9._/@:=+,-]+$` rather than from encoding. Two ways to
   break this silently: widening that charset (whitespace or a quote re-opens word-splitting on
   an ordinary POSIX shell, which is what such a remote falls back to), and reaching for
   `bareShellArg` anywhere other than that one `restrictedShell` branch. Neither turns a test red
   by itself. *graduated: `src/ssh/tests/quote.test.ts` (the bare accept/refuse tables) and
   `src/ssh/tests/run-remote.fake.test.ts` ("restrictedShell remotes") - expect: >= 15 refused
   values, and a remote that did not opt in still receiving single-quoted words.*
   ALSO: the listing verb is chosen by `target.jail`, not by taste - jailed stores list with
   `find -print0` (the jail's grammar answers nothing else), unjailed ones with `ls -A --`
   (appliance shells ship no `find`). Both parse into basenames that are then re-joined onto the
   store root and matched against invariant 6's regex before any destructive command, which is
   what makes `ls`'s newline-delimited output safe to consume. A future caller that acts on a
   listed name WITHOUT that regex gate turns a remote-controlled filename into a path operand.
   *graduated: `src/snapshots/tests/remote-store.test.ts` ("RemoteSnapshotStore unjailed
   (jail: false)") - expect: no `find` on the unjailed path, and the NUL-mangled-name row still
   ignored on the jailed one.*
3. Passphrases are never in config values, env, argv, or logs; only ssh-add's TTY prompt or the
   0600 askpass file ever carries one. Alias remotes carry no passphrase at all (structurally
   impossible).
   A SERVICE holds no encrypted key at all: `loadKeys` in `serviceMode` refuses every
   passphrase-protected key (declared `file:`/`prompt`, or merely encrypted in fact - the
   `ssh-keygen -y -P ""` probe decides) BEFORE it starts an agent, and `backupkit daemon` is the
   only caller that sets that flag. The silent failure is dropping the flag at that one call
   site: the daemon then comes back up looking healthy and fails every target on every tick
   instead, with an error no unattended process can ever resolve. Do not "fix" a report of this
   by adding an askpass file to the service - a passphrase file beside the key it unlocks is not
   a secret, and inventing that path is what this rule exists to prevent. *graduated:
   `src/ssh/tests/agent.fake.test.ts` ("serviceMode refuses passphrase-protected keys") and
   `src/cli/tests/commands.test.ts` ("preflights in SERVICE mode") - expect: nothing spawned at
   all before the refusal, and `daemon` passing `{ serviceMode: true }`.*
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
   The MODE check (no group/other access) is the confidentiality boundary and ALWAYS runs.
   OWNERSHIP, by deliberate design, is NOT required when the process runs as root (euid 0): root
   can read/write/chown any file regardless of owner, so demanding files be chown'd to root adds
   zero security and only forced operators to copy keys into a root-owned tree. A root daemon
   accepts the operator's own user-owned keys/config/stateDir as-is. This lives in TWO places,
   both of which waive ownership for root and both of which STILL enforce the mode check:
   `ownershipOk` in `ssh/permissions.ts` (the runtime matrix) and `assertConfigTrusted` in
   `cli/internal/service/lifecycle.ts` (the `service install`/lifecycle config-file row). They
   must stay consistent - relaxing one and not the other means `run`/`daemon` accept a user-owned
   config while `service install` rejects it (the exact bug this rule now prevents). Intentional
   and locked by tests ("root (euid 0) accepts a foreign-owned ..." in
   `src/ssh/tests/permissions.test.ts`; "root (euid 0) accepts a user-owned config ..." in
   `src/cli/tests/service.test.ts`) - do NOT re-introduce a "root must own it" rule in EITHER
   place; it is friction, not protection. A NON-root process still requires euid-or-root ownership
   (a real confused-deputy risk: another unprivileged user could swap the file).
   "Before any network I/O" binds EVERY engine verb that reaches a remote, not just the obvious
   ones - `listSnapshots` and `prune` were the sibling paths that skipped the gate while being
   exactly the verbs an operator uses to confirm the archive is healthy.
   *graduated: `src/ssh/tests/permissions.test.ts` ("checkFilePermissions - parent directories",
   "checkFilePermissions - logging.file"), `src/engine/tests/backupkit.test.ts` ("%s fails closed
   on a group-writable config, before any store access") - expect: one row per remote-I/O verb.*
9. All remote-derived data is untrusted: shape-validated before use, control-char-sanitized
   before logging, never interpolated into a subsequent command.
10. Push-mode keys are jailed by the `backupkit-remote` forced command by default - opting out
    is an EXPLICIT per-target `"jail": false` in config (accepted risk, e.g. a storage-box host
    with no shell), never an implicit omission; the
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
21. `backupkit-remote.sh` re-implements the snapshot-name codec in POSIX shell, and it is a copy
    deployed out-of-band on each archive server. The single-source regex guard scans `.ts` only,
    and the older jail suite feeds LITERAL names, so neither can see a codec change: widening the
    grammar would ship a client whose every push operation an installed jail rejects with a bare
    "rejected". The parity guard derives its cases from `formatSnapshotName` and runs the shipped
    script. Its second half pins the REVERSE: a jail root is ONE target's archive root (its
    `destination`), so a target name is no part of any path the client sends, and every name
    `validateConfig` accepts as a target must be REJECTED by the script as a path component. The
    shell used to carry a target-name-charset arm for the shared-root layout; an accepted shape
    nothing sends is one only an attacker has a use for, and re-adding that arm - or an appended
    `<target>` level anywhere in the client - has to turn this red.
    *graduated: `src/snapshots/tests/jail-grammar.test.ts` - expect: the candidate set spans both
    validator verdicts (its own vacuity guard), and every candidate is rejected as a component.*
22. The graceful-shutdown signal reaches EVERY child, not just rsync. The snapshot store's remote
    commands and `withTransientRetry`'s backoff both take it, so a stop is bounded by the child's
    death rather than by a 60 s ssh timeout times its attempts, or by a backoff of up to the
    300 s transfer cap. Without this a `systemctl stop` against an unresponsive archive host
    overruns `TimeoutStopSec=30` and is SIGKILLed mid-lock, leaving a remote lock only the 24 h
    TTL clears. *graduated: `src/shared/tests/retry.test.ts` ("an abort mid-backoff wakes the
    sleep immediately"), `src/snapshots/tests/remote-store.test.ts` ("aborts an in-flight store
    command when the shutdown signal fires").*
23. The jail's `rm -rf` branch uses a NARROWER path policy than every other verb. `mkdir`, `find`
    and `df` legitimately name the archive ROOT itself (the store's `ensureRoot`, listing and
    `df` all target it) and `mv`/`find` legitimately name a complete snapshot, so
    `check_lifecycle_path`'s default mode permits both - and sharing that mode with `rm -rf` made
    `rm -rf -- $ROOT` and `rm -rf` of the newest complete snapshot legal jail commands,
    i.e. a compromised push client could erase a target's entire history in one line. The root
    arm is the newer half of this and the more dangerous one: it was added so the store could
    name the root directly once `destination` became the archive root, and it is refused for the
    `delete` mode explicitly rather than by `check_delete_component`, which never sees a final
    component when the operand IS the root. The
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
**THE SIBLING-PATH RULE (read this before adding any guard).** Four separate Critical/High bugs in
this repo have had the identical shape: a guard was added to the path where the bug was noticed, and
its sibling - a second call site reaching the same sink - was left unguarded. `listSnapshots`/`prune`
skipped the permission preflight that `run`/`restore` had (invariant 8); the scheduler's generic
`runTarget` catch wrote no run report while the due-check catch 30 lines above did (invariant 19);
the run path's retention had no future-snapshot split while `prune`'s had one (invariant 32); and
`rm -rf` was narrowed while `mv` and `rsync --server` still reached the same deletion (invariant 30).
So: **when you add a guard, enumerate every caller of the sink and assert the guard on ALL of them in
the same change** - the enumeration, not the fix, is the work. A guard on one of N paths is not a
partial fix, it is a false sense of security plus a test that reads as green.

29. The jail's rsync option handling is an ALLOWLIST, and its path operand is pinned to the ONE
    shape the client writes. A deny list with a `--*` "benign flag" catch-all cannot be complete
    against a tool that keeps adding options, and it let three destructive ones through:
    `--remove-source-files` (the archive-side sender unlinks what it sends - a delete primitive that
    never touches the `rm -rf` verb), `--inplace` (writes THROUGH a `--link-dest` hardlink, mutating
    already-promoted snapshots), and `--protect-args`/`-s` (rsync then takes its file arguments from
    the protocol stream, so the argv operand the jail validated is not the one governing the
    transfer - nullifying every path check at once; rsync's own `rrsync` refuses it for this reason).
    Separately, bounding the operand only by "under $ROOT, no `..`" - with no component policy at
    all, unlike `check_lifecycle_path` - meant `--delete --force . $ROOT` erased a target's whole
    history in ONE command, and `. $ROOT/<complete-snap>` overwrote verified history.
    Pinning the destination to exactly `<snap>.partial`, ONE component under the root, for a write
    (and `<snap>` additionally for a `--sender` read) is what makes the permitted deletes
    harmless: they can only reach inside the scratch partial being built. That covers
    `--delete-excluded` as well, which the client now always sends and rsync forwards IN PLACE OF
    `--delete` (it implies it) - same blast radius, bounded by the same pinned operand, and it is on
    the allowlist because it was MEASURED on the wire, not because it looked benign. The root itself is a legal
    operand for the LIFECYCLE verbs and never for rsync in either direction - which is also why a
    push mirror, whose destination IS the root, cannot be jailed and the validator refuses one. The allowlist is derived from MEASURED argv, not intent - see 24.
    THE STANDING OBLIGATION: the `--*` arm accepts any option that is VALUELESS or whose value
    carries no path characters, so a valueless destructive flag is invisible to every filter in
    `validate_rsync` except its own NAME. The deny list is therefore not a finished artifact - it
    must be re-diffed against each rsync release, and "we have not seen it" is not a reason to
    accept a flag. Diffing rsync 3.4.4's full option set against it found five already shipping,
    each in a group the file already claimed to refuse: `--trust-sender` (turns OFF the receiver's
    checks on the sender's file list - `--protect-args` by another route, and in push mode the
    sender IS the untrusted party), `--old-args` (restores pre-3.2.4 whitespace re-splitting of
    arguments, i.e. switches off the very protection the project's rsync >= 3.2.5 floor exists to
    guarantee), `--write-devices` (writes THROUGH an existing device node - the `--inplace` hazard
    aimed at a device), `--copy-devices` (reads a device node as file data), and `--super` (asks the
    receiver to attempt chown/mknod). None was in the measured forwarded set, so refusing them cost
    the honest client nothing - which is the test to apply to the next one too. `--fake-super` is
    NOT in that group: the client really sends it.
    The re-diff is the maintenance step: `rsync --help | grep -oE '\-\-[a-z0-9-]+'` against the deny
    arm, then judge each unnamed flag by whether it names a path, executes, follows a symlink, makes
    the argv non-authoritative, or widens what the receiver may create.
    *graduated: `src/snapshots/tests/jail.fake.test.ts` ("the rsync path operand is pinned to the
    run's own .partial (destination policy)", "unmeasured rsync options are refused by default (the
    option allowlist)") - expect: >= 7 destination rejects and >= 17 option rejects.*
30. Narrowing a VERB is not the same as enforcing a PROPERTY. Invariant 23 narrowed `rm -rf` to
    `<snap>.partial`/`<snap>.deleting`/`.backupkit.lock` - and the property "a compromised push
    client cannot delete a completed snapshot or a target's history" still did not hold, because
    `mv`'s two operands were validated INDEPENDENTLY (each by `check_lifecycle_path`, whose default
    mode accepts the archive root). `mv -- $ROOT $ROOT/<snap>.deleting` was therefore legal,
    and its output is exactly the leaf shape `check_delete_component` then permits `rm -rf` to
    remove: two permitted commands, whole archive gone, delete policy reduced to decoration. A
    rename is a delete gadget whenever the destination namespace is deletable. `check_mv_pair`
    requires both operands to be SNAPSHOT-shaped and SIBLINGS in one directory, which is what the
    three real renames (promote, delete phase 1, partial re-claim) all are; it also closes moving
    `.backupkit.lock` out of the way to defeat the remote mutex. When a policy names a verb, ask
    which other verb reaches the same end state.
    *graduated: `src/snapshots/tests/jail.fake.test.ts` ("the mv PAIR is one of three real renames
    (closing the rename gadget)", "a rename may not bury its source inside an existing directory") -
    expect: >= 6 reject rows, the 3 real renames accepted, and the real-data gadget proof.*
31. A short-option token is validated WHOLE. `pre=${pre%%.*}` stripped everything after the first
    dot to isolate rsync's pre-`.` active flags - and thereby discarded the VALUE of any
    value-taking short option: `-T../../../tmp` reduced to the letter `T` (pure letters, accepted)
    while meaning `--temp-dir=../../../tmp`, so rsync wrote its temp files outside the jail root.
    `-T` sat in the deny list as a bare token, which is dead weight the moment the attached-value
    form walks past. The long-option branch rejected `*=/*` and `*..*`; the short branch performed
    no equivalent check on the part it had thrown away. Any prefix-strip used for validation must be
    paired with a rule for the remainder, or the remainder is unvalidated by construction.
    *graduated: `src/snapshots/tests/jail.fake.test.ts` ("a short bundle may not smuggle an attached
    option VALUE (bundle grammar)").*
32. Every retention decision applies the future-dated-snapshot split - the post-run path and `prune`
    alike. `planFor` (prune) passed its listing through `splitFutureSnapshots`; the run path called
    `planRetention` on a raw listing, justified by a comment claiming the clock-skew guard upstream
    made a future name impossible. It does not: that guard reads the listing BEFORE the transfer and
    retention re-reads it AFTER, and the attacker is the party serving the transfer, so it controls
    the window exactly. ~46 jail-legal `mkdir` commands issued mid-transfer, dated to occupy every
    tier's buckets, took all 24 keep slots and put every genuine snapshot in the prune list - 30 of
    31 deleted, the honest client doing the deleting. This is the mirror of 23/29: having stopped the
    attacker deleting history itself, make sure it cannot make US delete it.
    *graduated: `src/engine/tests/target-runner.test.ts` (future names planted mid-transfer never
    capture retention buckets; nothing is pruned when no genuine history survives them).*
33. A capped stream's `truncated` flag is READ wherever that stream feeds a decision. `exec()` caps
    each stream at 1 MiB (invariant 28) and sets `truncated` - and nothing in production ever read
    it, so a remote `find -print0` listing over the cap silently became a SHORT listing: `newest`
    went ~4 months stale, and a cut landing on a `.partial` boundary manufactured a complete
    snapshot name that does not exist. Downstream that breaks the schedule (window dedup compares a
    stale name), points `--link-dest` at a months-old base, and makes invariant 7's newest-snapshot
    floor protect the WRONG snapshot. A jailed client can force it with ~15 000 legal `mkdir`s.
    Adding a cap without a reader converts a crash into silent data corruption, which is worse.
    *graduated: `src/snapshots/tests/remote-store.test.ts` ("refuses a truncated listing", "refuses
    truncated df output too") - the guard sits in the store's single `run()` chokepoint.*
34. A parse of child output takes the LAST match, not the first. rsync relays messages generated by
    the REMOTE onto the local client's stdout, ahead of the client's own `--info=stats2` block, so
    `RegExp.exec` (first match) let a hostile source dictate `totalFiles` and
    `totalTransferredSize`. Measured: the disk guard flipped from correctly refusing to proceeding,
    and the content-collapse tripwire (invariant 27) went silent - re-opening the
    archive-destruction path 27 exists to close. Every numeric parse of remote output also carries
    the `Number.isSafeInteger` bound the `df` parsers already had.
    *graduated: `src/rsync/tests/stats.test.ts` ("takes the LAST match, so a fake block relayed from
    the remote cannot win", plus the safe-integer bound).*
35. UNKNOWN is not STALE, and UNKNOWN is not SAFE. Two inversions of the same rule: an unreadable
    remote lock returned `stale`, so the shared algorithm deleted a LIVE holder's lock and ran two
    pipelines against one archive root - while the same method deliberately treats a MARKERLESS lock
    as held, i.e. it treated strictly less information as more conclusive. And `claimPartial`
    adopted a resumed partial it could not vouch for: a symlinked partial became the transfer
    destination and `--delete --force` wiped the link target, with the hardlink guard next to it
    FOLLOWING the symlink and answering "no multiply-linked entry". `local-store`'s own docstring
    states the rule ("unknown is not the same as safe"); both sites violated it.
    *graduated: `src/snapshots/tests/remote-store.test.ts` (an unlistable lock is HELD, never
    stolen), `src/snapshots/tests/local-store.test.ts` (a symlinked partial is discarded).*
36. The config-trust gate precedes every spawn of a config-named binary and every privileged write
    to a config-chosen path. `check` spawned `config.rsyncBin --version` and `sshBin -V` as root
    BEFORE `preflight()` - so a group/other-writable config (the exact state preflight refuses) gave
    a local user root code execution via the command `init` tells the operator to run. Separately the
    `Backupkit` constructor opened `logging.file` and flushed `config.warnings` before any gate, so
    the first act of every verb was a root-privileged create/append at an attacker-chosen path
    (`O_NOFOLLOW` covers the symlink variant, nothing covered the direct path). A gate that runs
    after the action it guards is not a gate.
    *graduated: `src/engine/tests/backupkit.test.ts` ("check: a group-writable config reports the gate
    failure and spawns/probes NOTHING", "logging.file is not opened until the permission gate has
    judged the path") - expect: the spawn log is empty and the planted path absent after a FAILED
    preflight, not merely after a passing one.*
37. Log field values are QUOTED at the sink. `sanitize` (invariant 16) makes a string safe for a
    TERMINAL - it strips control characters and so a forged whole line is impossible - but it leaves
    SPACE and `=` untouched, and the logger emits bare `key=value`. Remote stderr containing
    `failed status=success target=payroll consecutiveFailures=0` therefore forged fields inside a
    genuine ERROR line, so a logfmt/journald field extractor read an attacker-authored `status` and
    `target`: a failure line that parses as a success, which is a cheap way to keep an alert from
    firing. Same value, different grammar, different encoding - a sanitizer chosen for one sink is
    not a sanitizer for another.
    *graduated: `src/shared/tests/logger.test.ts` (a value containing `key=value` text stays ONE
    quoted token and forges no fields).*
38. Every path that reaches rsync's `-e` string is whitespace- and quote-free, INCLUDING the ones
    synthesized from defaults. The validator enforces it for `identityFile`, an explicitly-written
    `knownHostsFile`, `passphrase`, `rsyncBin`, `sshBin`, `remoteRsyncBin` and a push `destination` -
    but the DEFAULT `knownHostsFile` is derived from `configPath` downstream of that gate, and
    `configPath` was only NUL/CR/LF-filtered. rsync word-splits `-e` before exec, so a config path
    containing a space silently broke every remote transfer while `check` still reported the host
    reachable, and a path containing ` -o ProxyCommand=...` gave ssh an option it executes via
    `/bin/sh -c` - local root code execution. A rule enforced on the written value and not on the
    derived default is enforced on the wrong set; assert it at the single `-e` producer too.
    *graduated: `src/config/tests/config-path.test.ts` (whitespace/quote rejection table),
    `src/engine/tests/backupkit.test.ts` ("refuses to build an rsync -e command whose tokens carry
    whitespace or quotes") - the config-path half and the sink-assert half both.*
39. No engine method captures unbounded child output, and no child's stdout/stderr is trusted to
    be small. A hostile remote's rsync stderr flows through ssh into the local pipe; string
    concatenation past V8's ~512 MB limit throws `RangeError` inside a stream `data` listener -
    outside the promise, uncatchable by the caller, with no `uncaughtException` handler in the
    tree - so the daemon dies and `Restart=on-failure` with `StartLimitIntervalSec=0` turns that
    into a permanent crash loop. `exec()` caps each stream (stderr keeps the tail, stdout the
    head) and sets `truncated`. A new capture path that accumulates without a cap re-opens it.
    *graduated: `src/exec/tests/exec.test.ts` ("caps captured stdout ... keeps the HEAD", "caps
    captured stderr ... keeps the TAIL").*
40. The content-collapse baseline is the newest TRUSTED run, never merely the newest run with
    stats. A collapsed run persists its own (tiny) stats, so taking "the newest report that
    completed a transfer" made the tripwire disarm itself after exactly ONE run: run N tripped and
    skipped its prune, run N+1 compared empty against empty, saw no collapse, and pruned on
    schedule. Measured end-to-end: run 3 deleted the last two genuine snapshots and by run 7 the
    archive was two empty snapshots - i.e. invariant 27's guarantee, and the README sentence
    promising retention stays off "until you confirm the shrink is real", were both worth one
    schedule interval. `newestStats` skips any report carrying `contentCollapse`. The cost is
    bounded rather than permanent: reports rotate at `REPORTS_KEPT`, so once every pre-collapse
    report has aged out the wire stops tripping and scheduled retention resumes; `backupkit prune`
    stays the operator's immediate override. Note also the asymmetry inside the comparison - NO
    BASELINE (a first run) means "nothing to compare", but NO CURRENT STATS with a baseline on
    record means the wire cannot do its job, and the destructive path used to score that as "no
    collapse" while its read-only sibling `dryRunStats` THREW on the same unparsable output. A
    hostile source picks whether its rsync emits a parsable stats block, so it picked the branch.
    *graduated: `src/engine/tests/reports.test.ts` ("newestStats - the content-collapse baseline",
    5 rows incl. the rotation bound), `src/engine/tests/target-runner.test.ts` ("trips when this
    run's file count cannot be measured at all, rather than pruning blind").*
41. A planted snapshot name is not always a FUTURE-dated one. `splitFutureSnapshots` (invariant 26)
    only separates names dated ahead of now - and the party planting names chooses the timestamp, so
    dating each plant one second AFTER a real snapshot puts a planted name in every retention bucket
    while the future-split reports nothing at all. Measured: 10 of 11 real snapshots went into the
    delete list and `newestUndeletable` ended up protecting a PLANTED name, with no log line, because
    the `future.length > 0` branch never fired. Counting is what catches it: this client only ever
    creates snapshots named for the current time, so the number of complete snapshots AT OR BELOW a
    fixed past point can shrink (retention) or hold, but never grow. Each run records
    `completeCount`, and the next run compares against it; growth means names appeared underneath us,
    and is treated exactly like a content collapse (promote, skip retention, log at error) because
    the safe direction is identical. The listing counted and the listing retention plans over must be
    the SAME listing - re-listing between them reopens the window for the very party the check exists
    to catch. `prune` runs the SAME check through the same owner (`detectHistoryInsertion`) - the run
    path and the prune path drifting apart is this codebase's most repeated bug shape, so the
    comparison has one home and two callers. Prune cannot merely refuse, because it is the documented
    way to clear the state the run path trips into: it refuses BY DEFAULT and takes `--force`, and
    `--dry-run` still prints the full plan because that is the review step the refusal sends the
    operator to. What it must never do is quietly proceed.
    RESIDUAL, deliberately: the guard reports HOW MANY names appeared, never WHICH. Naming them
    exactly needs complete attestation, and run reports rotate at `REPORTS_KEPT`, so a genuine
    snapshot older than the report window is unattested exactly like a plant. `unattestedBelow` is
    therefore offered as best-effort context and labelled as such - nothing in the code acts on it,
    because acting on it would delete real history on any archive older than 50 runs.
    *graduated: `src/engine/tests/target-runner.test.ts` ("PAST-dated planted names trip the
    insertion guard...", plus the shrink/own-snapshot/no-baseline controls) and
    `src/engine/tests/backupkit.test.ts` ("prune: the past-dated insertion guard", 6 rows incl.
    --force and --dry-run) - expect: at least one reject row and three accept rows in each, so
    neither guard can be satisfied by tripping on everything.*
42. The reachability probe (`src/ssh/reach.ts`) opens the ONLY TCP socket in this codebase that is
    not an ssh/rsync child, and it may dial exactly one destination: the host and port of the
    remote it was handed - `remote.host`/`remote.port` for an explicit remote, or the `ssh -G`
    resolution of the alias. It must never contact a third-party "are you online?" endpoint (a
    public resolver, a captive-portal probe URL, a vendor health check). That reads as harmless
    plumbing and is not: it turns every scheduler tick on every install into a beacon announcing
    that this machine runs backupkit, to a party the user never configured, on a machine whose
    whole reason for running this package is that its data is worth protecting. It also lies -
    a reachable public resolver says nothing about whether the archive host is up, which is the
    only question the probe exists to answer.
    The second half is the direction it may fail in. The probe is allowed to conclude "provably
    cut off" and nothing else; every inconclusive outcome MUST return `ok: true`. A host that
    answers and refuses the port is UP (`ECONNREFUSED`/`ECONNRESET` pass), an alias whose
    `ssh -G` will not resolve is unknown, a throw inside the probe is unknown. Getting this
    backwards fails silently in the worst possible direction: a probe that returns `ok: false`
    on an inconclusive answer SKIPS the target with no report and no backoff, which is exactly
    the shape of "backups quietly stopped and `status` kept showing last week's success".
    Widening the skip is never the fix for a noisy log - the level rules are.
    ✗ `if (outcome !== null) return { ok: false, ... }`  // refused/unknown treated as an outage
    ✓ `if (outcome === null || HOST_IS_UP_CODES.has(outcome)) return REACHABLE`
    ```hunt
    rg -n "createConnection|net\.connect|reachRemote|ok: false" src/
    expect: >= 4
    witness: src/ssh/reach.ts
    ```
    *graduated: `src/ssh/tests/reach.test.ts` ("passes when the host answers but REFUSES the
    port", "passes an alias it cannot resolve rather than guessing an outage") and
    `src/engine/tests/scheduler.test.ts` ("a reachable probe never suppresses a real failure") -
    expect: at least two passing-on-inconclusive rows alongside the dns/unreachable rejects, so
    the probe cannot be satisfied by passing everything either.*
44. `TargetRunReport.reason` is a CLOSED union (`RunReason`), and the CLI's plain-English map is
    `Record<RunReason, string>` - not `Record<string, string>`. This is a legibility invariant,
    and it fails exactly the way security invariants do: silently, in a direction nobody notices.
    While `reason` was a bare `string` the engine emitted `due-check-failed` and `run-threw`, the
    CLI map knew neither, and `backupkit status` printed the raw code at a person; the docstring
    listing the codes named seven of the eleven. Nothing went red - the `?? reason` fallback made
    every miss look like a design choice. Typing both sides against one union turns the next
    addition into a `npm run typecheck` failure. Keep the runtime fallback anyway: reports
    PERSISTED under an older name are still on disk, and printing an unrecognised code beats
    printing "undefined".
    ✗ `const REASON_TEXT: Record<string, string> = { ... }`   // a new code is silently unexplained
    ✓ `const REASON_TEXT: Record<RunReason, string> = { ... }` // a new code fails typecheck
    ```hunt
    rg -n "RunReason|REASON_TEXT|reason:" src/engine/types.ts src/cli/internal/context.ts src/engine/internal
    expect: >= 6
    witness: src/cli/internal/context.ts
    ```
    *graduated: `npm run typecheck` itself is the guard - `REASON_TEXT` cannot compile with a
    member missing. Verify by deleting one key from the map and confirming typecheck fails.*
