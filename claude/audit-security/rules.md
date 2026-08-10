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
