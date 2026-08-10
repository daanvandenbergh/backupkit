/**
 * The fully commented starter config `backupkit init` writes - and the
 * canonical schema example. A unit test feeds this text through parseJsonc +
 * the validator, so the shipped example can never drift from the schema.
 * Every field comment is that field's docstring from `config/types.ts`.
 */

/** The starter config.jsonc text, written verbatim by `backupkit init`. */
export const STARTER_CONFIG: string = `// backupkit - /etc/backupkit/config.jsonc
// Comments (// and /* */) and trailing commas are allowed; otherwise strict JSON.
// Reference: https://daanvandenbergh.github.io/backupkit/configuration
{
    // Instance label used in logs and lock files.
    "name": "backupkit",

    // Machines this host talks to, keyed by a short name targets refer to.
    "remotes": {
        "example": {
            // Hostname or IP. IPv6 literals are fine.
            "host": "10.0.0.11",
            // SSH user on the remote. For pull targets a read-only user is enough.
            "user": "backup-reader",
            // "port": 22,
            // Absolute path to the SSH private key (mode 0600).
            "identityFile": "/etc/backupkit/keys/example_ed25519",
            // Only for encrypted keys. "file:/abs/path" = a 0600 file holding the
            // passphrase (unattended daemons); "prompt" = you type it once via
            // \`backupkit check\` after each reboot. NEVER the passphrase itself.
            // "passphrase": "file:/etc/backupkit/keys/example.pass",
        },
        // Alternatively: a Host alias from your ~/.ssh/config or /etc/ssh/ssh_config.
        // ssh resolves the hostname, user, key, and port itself; backupkit manages
        // nothing but its safety options. "alias" must be the ONLY field.
        // "myserver": { "alias": "myserver" },
    },

    // What to back up. The key is the target name: it becomes the snapshot
    // subdirectory (<destination>/<name>/<timestamp>/) and the log identifier.
    "targets": {
        "example-var-www": {
            // "pull": this machine fetches from the remote (recommended).
            // "push": this machine sends to the remote (the key is jailed; see
            // \`backupkit check\`, which prints the authorized_keys line to install).
            "direction": "pull",
            // A key of "remotes" above.
            "remote": "example",
            // Directory to back up. pull: path ON the remote. push: local path.
            "source": "/var/www",
            // Archive root. pull: local path. push: path ON the remote.
            "destination": "/srv/backups",
            // rsync exclude patterns.
            "exclude": ["cache/", "*.tmp"],
            // How often: "interval" is "minute" | "hour" | "day" | "week" | "month";
            // "intervalCount" = every N intervals (default 1). Optional anchors:
            // "at" "HH:MM" UTC (day/week/month), "on" "mon".."sun" (week),
            // "dayOfMonth" 1-28 (month). Default { "interval": "day" }.
            "schedule": { "interval": "day", "at": "03:00" },
            // Per-target override of the default retention below.
            // false = never prune this target.
            // "retention": { "keepLast": 24, "keepDaily": 30 },
            // Transfer retry attempts per run (transient failures only, 1-10).
            // "retry": { "attempts": 5 },
            // Keep this much free on the archive filesystem: "5%" or "10G".
            // false disables the free-space guard. Default "5%".
            // "minFree": "5%",
            // Tuning knobs, all optional: compress, bwlimit ("10M"), ioTimeoutSec,
            // xattrs, preserveOwnership, preserveDevices, remoteRsyncBin, verify.
            // "rsync": { "bwlimit": "10M" },
            // false = configured but never scheduled.
            // "enabled": true,
        },
    },

    // Default retention for targets that define none. A snapshot survives if ANY
    // rule claims it. Omit the whole object to keep everything forever.
    "retention": {
        "keepLast": 7,      // the 7 newest, unconditionally
        "keepDaily": 14,    // newest snapshot of each day, 14 days
        "keepWeekly": 8,    // newest per ISO week, 8 weeks
        "keepMonthly": 12,  // newest per month, 12 months
    },

    // Run reports live here. Default: /var/lib/backupkit (root),
    // else ~/.local/state/backupkit.
    // "stateDir": "/var/lib/backupkit",

    // "error" | "warn" | "info" | "debug"; optional "file" for a log path.
    "logging": { "level": "info" },
}
`;
