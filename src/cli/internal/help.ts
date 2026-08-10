/**
 * All CLI help text: the bare-invocation root help headed by the 3-step setup
 * (spec section 7 verbatim) and the per-command `<command> --help` texts.
 */

/** The root help printed by bare `backupkit`, `--help`, and unknown-command hints. */
export const ROOT_HELP: string = `backupkit - versioned rsync-over-SSH backups

Setup (3 steps):
    1. backupkit init             write a commented starter config
    2. backupkit check            verify keys, hosts, and versions
    3. backupkit service install  register the daemon (then: backupkit service start)

Commands:
    run [TARGET...]        back up due targets now
    status  [TARGET...]    one row per target: last run, next due
    list    [TARGET...]    complete snapshots (alias: ls)
    restore TARGET SNAP    copy a snapshot to a fresh path
    prune   [TARGET...]    apply retention now
    logs                   tail the daemon logs
    service <verb>         install|uninstall|start|stop|restart|status
    daemon                 foreground scheduler (what the service runs)
    check | init           readiness / starter config

backupkit <command> --help for details.`;

/** Per-command help text, printed by `backupkit <command> --help`. */
export const COMMAND_HELP: Record<string, string> = {
    run: `backupkit run [TARGET...] [--force] [--dry-run] [--config P]

Back up every due target once (or only the named targets).
    --force      bypass due-ness, backoff, and bucket dedup
    --dry-run    no writes; show what a transfer would do
    --config P   config file path`,
    daemon: `backupkit daemon [--config P]

Foreground scheduler loop - what the installed service unit runs.
    --config P   config file path`,
    service: `backupkit service install|uninstall|start|stop|restart|status [--config P]

Manage the OS service unit (systemd on Linux, launchd on macOS).
install/uninstall/start/stop/restart require root; status does not.
    --config P   config file path`,
    logs: `backupkit logs [-f|--follow] [-n N|--lines N] [--config P]

Tail the daemon logs (journalctl -u backupkit on Linux, tail on macOS).
    -f, --follow    stream until Ctrl-C
    -n, --lines N   number of lines (default 100)
    --config P      config file path`,
    list: `backupkit list [TARGET...] [--json] [--config P]        (alias: ls)

List complete snapshots per target, oldest first.
    --json       one JSON document on stdout
    --config P   config file path`,
    status: `backupkit status [TARGET...] [--json] [--config P]

One row per target: last snapshot, next due, last result, failures, lock.
    --json       one JSON document on stdout
    --config P   config file path`,
    restore: `backupkit restore TARGET SNAPSHOT|latest --output PATH [--verify] [--config P]

Copy one snapshot to a non-existent output path.
    --output P   fresh path to restore into (required)
    --verify     post-copy checksum verification pass
    --config P   config file path`,
    prune: `backupkit prune [TARGET...] [--dry-run] [--config P]

Apply retention now.
    --dry-run    print the retention plan (keeps with reasons) and stop
    --config P   config file path`,
    check: `backupkit check [--config P]

Readiness gate: validate config, verify binaries and versions, load keys,
probe remotes, pin host keys (TTY only), and print push-jail lines.
    --config P   config file path`,
    init: `backupkit init [--force] [--config P]

Write the fully commented starter config.jsonc.
    --force      overwrite an existing config
    --config P   write the config at this exact path`,
};
