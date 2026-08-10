/**
 * The backupkit config schema: what operators write (BackupkitConfig and its
 * parts) and the fully resolved normal form the rest of the codebase consumes
 * (ResolvedConfig - no optional field survives resolution).
 */

import type { Endpoint, ResolvedRemote, RetentionRules } from "../shared/types.js";
import type { MinFree } from "../shared/format.js";
import type { LogLevel as SharedLogLevel } from "../shared/logger.js";
import type { Interval as SharedInterval, ScheduleSpec, Weekday as SharedWeekday } from "../shared/time.js";

/** Log verbosity level (re-exported from the shared logger - one source of truth). */
export type LogLevel = SharedLogLevel;

/** Weekday short name (re-exported from shared time math - one source of truth). */
export type Weekday = SharedWeekday;

/** Schedule window unit (re-exported from shared time math - one source of truth). */
export type Interval = SharedInterval;

/**
 * GFS retention rules. A snapshot survives if ANY rule claims it.
 * Re-exported from shared/types.ts so the pure retention module can consume
 * the same shape without importing config/.
 */
export type RetentionConfig = RetentionRules;

/**
 * One remote host, keyed by short name in BackupkitConfig.remotes.
 * Two mutually exclusive shapes: explicit (backupkit manages host, user, key,
 * port, and known_hosts) or alias (ssh resolves everything from the user's
 * ssh_config; backupkit manages nothing but the no-hang option baseline).
 */
export type RemoteConfig = ExplicitRemoteConfig | AliasRemoteConfig;

/** Fully specified remote: backupkit owns key loading, known_hosts, and identity selection. */
export interface ExplicitRemoteConfig {
    /** Hostname or IP. IPv6 literals allowed (bracketed by the endpoint formatter). Required. */
    host: string;
    /** SSH username, /^[a-z_][a-z0-9._-]{0,31}$/i. Required. */
    user: string;
    /** SSH port, integer 1-65535. Default 22. */
    port?: number;
    /** Absolute path to the private key. No whitespace or quote chars in the path. Required. */
    identityFile: string;
    /**
     * Passphrase source for an encrypted key. "file:/abs/path" (0600, owner euid/root,
     * read via the shipped SSH_ASKPASS helper) or "prompt" (ssh-add's own TTY prompt
     * during `backupkit check`; refused when no TTY). Omit for unencrypted keys.
     * Raw passphrases and "env:" forms are rejected by the validator. Only valid
     * alongside identityFile - alias remotes cannot carry a passphrase.
     */
    passphrase?: string;
    /** Override the dedicated known_hosts file path. Default: <configDir>/known_hosts. */
    knownHostsFile?: string;
}

/**
 * ssh_config-resolved remote. The alias is passed to ssh/rsync verbatim as the
 * destination; host, user, key, port, and known_hosts all come from the user's
 * ssh_config (~/.ssh/config, /etc/ssh/ssh_config). No other field may accompany
 * "alias" - per-field overrides belong in ssh_config or an explicit remote.
 * backupkit still injects its non-negotiable -o baseline (spec section 4), which
 * overrides ssh_config, so the no-hang and strict-host-key guarantees survive.
 */
export interface AliasRemoteConfig {
    /** Host alias exactly as written in ssh_config. /^[a-z0-9_][a-z0-9._-]*$/i, max 64 - no whitespace, quotes, ':', '@', '/', or leading '-'. Required, and the only allowed key. */
    alias: string;
}

/**
 * Target schedule as written in config. Anchors are optional and interval-gated
 * (validation matrix in spec section 2). Schedules and retention are independent:
 * retention keeps its hourly..yearly tiers regardless of the schedule interval;
 * for minute/hour schedules, keepLast and keepHourly govern sub-daily density.
 */
export interface ScheduleInput {
    /**
     * Window unit. "minute" is for high-frequency targets; "month" means calendar
     * months in UTC (months-since-epoch indexing) - never a day-count
     * approximation. Required.
     */
    interval: Interval;
    /** Run once every N intervals. Positive integer. Default 1. */
    intervalCount?: number;
    /**
     * "HH:MM" UTC: the earliest time-of-day the window's run may fire, measured
     * on the window's anchor day. Valid for day/week/month. Default "00:00".
     */
    at?: string;
    /** Weekday the week window starts on (the week anchor). Valid for week. Default "mon". */
    on?: Weekday;
    /**
     * Day of the window's first month the run anchors to, 1-28 (a day every
     * month has - no clamping, no skipped February). Valid for month. Default 1.
     */
    dayOfMonth?: number;
}

/**
 * Resolved normal form of ScheduleInput: every default filled. All boundaries
 * UTC. Re-exported from the shared time module's ScheduleSpec - one source of
 * truth for the shape the window math consumes.
 */
export type ScheduleConfig = ScheduleSpec;

/** Per-target rsync tuning. All optional. */
export interface RsyncOptions {
    /** -z compression. Default true. */
    compress?: boolean;
    /** rsync --bwlimit: "500K", "10M", or a bare number string (KiB/s). Default: unlimited. */
    bwlimit?: string;
    /** rsync --timeout seconds. Default 600. */
    ioTimeoutSec?: number;
    /** --xattrs. Default false. */
    xattrs?: boolean;
    /** Receive owner/group (--numeric-ids). Default true; set false to add --no-owner --no-group. */
    preserveOwnership?: boolean;
    /** Allow device/special files (rsync -D). Default false: --no-devices --no-specials always added. */
    preserveDevices?: boolean;
    /** Absolute path to the rsync binary on the remote (--rsync-path). Default: remote default rsync. */
    remoteRsyncBin?: string;
    /** Pre-promote --checksum --dry-run verification pass. Default false (full re-read of both sides). */
    verify?: boolean;
}

/** One backup target. Keyed by name in BackupkitConfig.targets. */
export interface TargetConfig {
    /** "pull": this machine fetches remote source into local destination (preferred). "push": this machine sends local source to remote destination. Required. */
    direction: "pull" | "push";
    /** Key into BackupkitConfig.remotes. Required. */
    remote: string;
    /** Directory to back up (contents synced). pull: absolute path ON the remote. push: absolute local path. Required. */
    source: string;
    /** Archive root. pull: absolute local path. push: absolute path ON the remote (must equal the jail root of the forced command). Snapshots at <destination>/<name>/<snapshot>/. Required. */
    destination: string;
    /** rsync exclude patterns, one --exclude=<p> argv element each. Default []. */
    exclude?: string[];
    /** When to run (validation matrix in spec section 2). Default { interval: "day" }. */
    schedule?: ScheduleInput;
    /** Overrides top-level retention wholesale (no merge). false = never prune this target. */
    retention?: RetentionConfig | false;
    /**
     * Transfer retry: total attempts per run for transient failures, integer
     * 1-10. Default 5. The only retry knob - delays are fixed (15 s doubling to
     * a 300 s cap, ±20% jitter), always resuming into the same .partial.
     */
    retry?: {
        /** Total transfer attempts per run, integer 1-10. Default 5. */
        attempts?: number;
    };
    /** Free-space floor after transfer: "N%" of the filesystem or absolute "10G"/"500M" (binary units). false disables the guard and its dry-run pre-pass. Default "5%". */
    minFree?: string | false;
    /** Default {}. */
    rsync?: RsyncOptions;
    /** false = configured but never scheduled. Default true. */
    enabled?: boolean;
}

/** The root config object an operator writes (config.jsonc). */
export interface BackupkitConfig {
    /** Instance label for logs/locks. Default "backupkit". */
    name?: string;
    /** At least one entry. Key charset same as target names. */
    remotes: Record<string, RemoteConfig>;
    /** At least one entry. Keys are target names, /^[a-z0-9][a-z0-9._-]*$/, max 64: snapshot subdir + CLI/log identifier. Run order = document order. */
    targets: Record<string, TargetConfig>;
    /** Default retention for targets defining none. Omit to keep everything forever. */
    retention?: RetentionConfig;
    /** Run-report root. Default /var/lib/backupkit (root) else ${XDG_STATE_HOME:-~/.local/state}/backupkit. */
    stateDir?: string;
    /** Default { level: "info" }. */
    logging?: {
        /** Minimum level to emit. Default "info". */
        level?: LogLevel;
        /** Optional log file path (append sink; rotation belongs to the platform). */
        file?: string;
    };
    /** Absolute local rsync binary override. Default: /opt/homebrew/bin/rsync, /usr/local/bin/rsync, then PATH. */
    rsyncBin?: string;
    /** Absolute local ssh binary override. Default: PATH. */
    sshBin?: string;
}

/** Fully resolved per-target rsync options: every default filled. */
export interface ResolvedRsyncOptions {
    /** -z compression. */
    compress: boolean;
    /** Validated --bwlimit token, or null for unlimited. */
    bwlimit: string | null;
    /** rsync --timeout seconds. */
    ioTimeoutSec: number;
    /** --xattrs. */
    xattrs: boolean;
    /** Receive owner/group. */
    preserveOwnership: boolean;
    /** Allow device/special files. */
    preserveDevices: boolean;
    /** Absolute remote rsync binary path, or null for the remote default. */
    remoteRsyncBin: string | null;
    /** Pre-promote verification pass. */
    verify: boolean;
}

/** One fully resolved target: every default filled, endpoints mapped. */
export interface ResolvedTarget {
    /** Target name (its key in the config `targets` record). */
    name: string;
    /** Human-facing transfer direction word (no downstream code branches on it after endpoint mapping). */
    direction: "pull" | "push";
    /** The referenced remote's short name. */
    remoteName: string;
    /** The resolved remote this target talks to. */
    remoteRef: ResolvedRemote;
    /** Directory backed up (contents synced). */
    source: string;
    /** Archive root (snapshots at <destination>/<name>/<snapshot>/). */
    destination: string;
    /** rsync exclude patterns. */
    exclude: string[];
    /** Fully resolved schedule. */
    schedule: ScheduleConfig;
    /** Effective retention rules, or null for keep-everything (target `false` or nothing configured). */
    retention: RetentionConfig | null;
    /** Transfer retry attempts (1-10). */
    retry: {
        /** Total transfer attempts per run. */
        attempts: number;
    };
    /** Parsed free-space floor, or null when the guard is disabled. */
    minFree: MinFree | null;
    /** Fully resolved rsync tuning. */
    rsync: ResolvedRsyncOptions;
    /** Whether the scheduler considers this target. */
    enabled: boolean;
    /** Transfer source endpoint (mapped once from direction). */
    src: Endpoint;
    /** Transfer destination endpoint - the archive root side (mapped once from direction). */
    dst: Endpoint;
}

/**
 * The fully resolved config the rest of the codebase consumes: no optionals,
 * no unresolved schedule, no direction branching left. Targets are an ordered
 * array in document order (taken from the parser's ordered entries - immune
 * to JS integer-key reordering for names like "2024").
 */
export interface ResolvedConfig {
    /** Instance label for logs/locks. */
    name: string;
    /** Resolved remotes keyed by short name. */
    remotes: Record<string, ResolvedRemote>;
    /** Resolved targets in document order. */
    targets: ResolvedTarget[];
    /** Default retention for targets defining none, or null for keep-everything. */
    retention: RetentionConfig | null;
    /** Run-report root directory. */
    stateDir: string;
    /** Resolved logging settings. */
    logging: {
        /** Minimum level to emit. */
        level: LogLevel;
        /** Log file path, or null for stream-only logging. */
        file: string | null;
    };
    /** Local rsync binary override, or null to probe the documented default locations. */
    rsyncBin: string | null;
    /** Local ssh binary override, or null to resolve from PATH. */
    sshBin: string | null;
    /** The config file this was loaded from. */
    configPath: string;
    /** Non-fatal validation findings (e.g. unreferenced remotes) for the caller to log. */
    warnings: string[];
}
