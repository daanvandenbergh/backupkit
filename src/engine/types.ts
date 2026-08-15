/**
 * The engine's public report and status types (spec sections 1 and 8):
 * `RunReport` (one invocation) and its per-target `TargetRunReport` (the
 * persisted JSON shape), plus the prune/check/restore reports and the
 * `TargetStatus` row surfaced by `Backupkit.status()`.
 */

import type { TransferAttempt } from "../rsync/rsync.js";
import type { RetentionPlan } from "../retention/retention.js";
import type { EncryptedKey } from "../ssh/agent.js";

export type { TransferAttempt } from "../rsync/rsync.js";

/** Outcome status of one per-target run. */
export type RunStatus = "success" | "warning" | "failed" | "skipped" | "aborted";

/** Transfer statistics recorded in a run report. */
export interface RunStats {
    /** Regular files rsync actually transferred. */
    filesTransferred: number;
    /** Bytes of file content transferred (the real delta moved). */
    bytesTransferred: number;
    /** Total files in the transfer file list (both sides). */
    totalFiles: number;
    /** The disk guard's projected delta in bytes, or the transferred bytes when no estimate ran. */
    deltaBytes: number;
}

/**
 * One target's run outcome - the persisted JSON at
 * `<stateDir>/runs/<target>/<runId>.json` (atomic write, 0600, newest 50
 * kept). These files are the single persistent record: `status()`, the
 * backoff derivation, and restart recovery read nothing else.
 */
export interface TargetRunReport {
    /** `<formatSnapshotName(start)>_<target>` - the snapshot codec, reused. */
    runId: string;
    /** Target name. */
    target: string;
    /** Human-facing transfer direction word. */
    direction: "pull" | "push";
    /** Snapshot name this run created (or resumed into), or null when none was attempted. */
    snapshot: string | null;
    /** Outcome status. */
    status: RunStatus;
    /** Machine-readable skip/failure reason ("window", "disk-low", "clock-skew", "verify-failed", "aborted", "dry-run", "remote-unavailable"), or null. */
    reason: string | null;
    /** ISO start time of the run. */
    startedAt: string;
    /** ISO finish time of the run. */
    finishedAt: string;
    /** Every transfer attempt this run made, first to last. */
    attempts: TransferAttempt[];
    /** Transfer statistics of the final attempt, or null when no transfer completed. */
    stats: RunStats | null;
    /** On exit 23: up to 100 offending paths from stderr (sanitized). Empty otherwise. */
    skippedFiles: string[];
    /** Sanitized error message when the run did not succeed cleanly, or null. */
    error: string | null;
    /**
     * Set when the content-collapse tripwire fired: this snapshot holds far
     * fewer files than the previous run's, so the snapshot was promoted but
     * RETENTION WAS SKIPPED (no snapshot was pruned this run). Absent or null
     * when it did not fire. Optional so older persisted reports still parse.
     */
    contentCollapse?: {
        /** File count of the newest previous run that completed a transfer WITHOUT tripping this wire. */
        previousFiles: number;
        /**
         * File count of this run, or null when it could not be measured at all
         * (rsync's stats block did not parse). Unmeasurable is treated as a trip,
         * not as a pass: with a baseline on record, "this run moved far less than
         * the last one" and "we cannot tell what this run moved" are the same
         * answer as far as deleting history goes.
         */
        files: number | null;
    } | null;
    /**
     * Number of COMPLETE snapshots in the archive when this run finished, or
     * null/absent when the run never got far enough to list them. Persisted for
     * one reason: it is the only record of how much history existed at a known
     * point, and `historyInsertion` compares against it. Optional so older
     * persisted reports still parse.
     */
    completeCount?: number | null;
    /**
     * Set when snapshots APPEARED in the archive below the previous run's newest
     * name - which this client never does, since it only ever creates snapshots
     * named for the current time. The snapshot was promoted but RETENTION WAS
     * SKIPPED. Absent or null when it did not fire.
     *
     * This is the past-dated twin of the future-dated guard. `splitFutureSnapshots`
     * only separates names dated AHEAD of now, and the party planting names picks
     * the timestamp - so dating a plant one second after each real snapshot put a
     * planted name in every retention bucket while `splitFutureSnapshots` reported
     * nothing unusual. Counting is what catches it: retention only ever removes
     * names, so the number of snapshots at or below a fixed past point can shrink
     * or hold, never grow.
     */
    historyInsertion?: {
        /** Newest complete snapshot recorded by the previous run. */
        previousNewest: string;
        /** How many complete snapshots existed then. */
        previousCount: number;
        /** How many now sit at or below `previousNewest` - greater than `previousCount` is the trip. */
        count: number;
    } | null;
}

/** The summary `run()` returns: one invocation over its due (or forced) targets. */
export interface RunReport {
    /** ISO start time of the invocation. */
    startedAt: string;
    /** ISO finish time of the invocation. */
    finishedAt: string;
    /** One report per target that entered the pipeline, in run order. */
    targets: TargetRunReport[];
}

/** One target's prune outcome. */
export interface TargetPruneReport {
    /** Target name. */
    target: string;
    /** The retention plan (keeps with reasons + prune list, newest first). */
    plan: RetentionPlan;
    /** True when the prune list was actually deleted (false on dry-run or when nothing was pruned). */
    executed: boolean;
    /** Per-deletion error messages (a failed deletion never stops the rest). */
    errors: string[];
}

/** The report `prune()` returns. */
export interface PruneReport {
    /** One entry per selected target, in config order. */
    targets: TargetPruneReport[];
}

/** One target's `unlock()` outcome. */
export interface TargetUnlockReport {
    /** Target name. */
    target: string;
    /**
     * What happened: `none` = nothing was holding the lock, `removed` = a lock
     * was cleared, `held` = a LIVE lock was found and left alone (no `force`),
     * `failed` = the store could not be reached or the removal failed.
     */
    status: "none" | "removed" | "held" | "failed";
    /** The holder description (or the error), empty when there was no lock. */
    detail: string;
}

/** One remote's readiness probe outcome inside a `CheckReport`. */
export interface RemoteCheck {
    /** The remote's short name. */
    remote: string;
    /** Remote shape. */
    kind: "explicit" | "alias";
    /** True when the connectivity + rsync-version probe succeeded. */
    reachable: boolean;
    /** The probed remote rsync version, or null when unreachable. */
    rsyncVersion: string | null;
    /** For alias remotes: what `ssh -G` says ssh will dial, or null when unresolvable. */
    resolved: { hostname: string; user: string; port: string } | null;
    /** Actionable probe error, or null. */
    error: string | null;
}

/** One push target's jail line DATA (printing is the CLI's job). */
export interface JailLine {
    /** The push target this line belongs to. */
    target: string;
    /** The remote the key authenticates against. */
    remote: string;
    /**
     * The exact `authorized_keys` line for explicit remotes (restriction
     * prefix + the real public key), or the restriction prefix + the
     * append-your-key instruction for alias remotes.
     */
    line: string;
}

/** The readiness report `check()` returns. */
export interface CheckReport {
    /** True when every probe passed and no error was collected. */
    ok: boolean;
    /** The accepted local rsync binary + version, or null when refused/missing. */
    localRsync: { bin: string; version: string } | null;
    /** True when the local ssh binary answered `-V`. */
    sshOk: boolean;
    /** One probe row per configured remote, in config order. */
    remotes: RemoteCheck[];
    /** Jail-line data for every push target with the jail enabled (`jail: false` targets are omitted). */
    jailLines: JailLine[];
    /**
     * Every configured key a SERVICE could never unlock, in config order -
     * empty when this config can run unattended. Not an error: such a config is
     * perfectly valid, it just belongs to `backupkit start` rather than to
     * `backupkit service install`, and `check` has to say which of the two it
     * is instead of always recommending the daemon.
     */
    encryptedKeys: EncryptedKey[];
    /** Every collected error, in discovery order. */
    errors: string[];
}

/** The report `restore()` returns. */
export interface RestoreReport {
    /** Target the snapshot belongs to. */
    target: string;
    /** The resolved snapshot name that was copied. */
    snapshot: string;
    /** The output path the snapshot was copied to (would be copied to, on a dry run). */
    output: string;
    /** True only when the opt-in verify pass ran and found no difference. */
    verified: boolean;
    /**
     * Non-null only on a dry run, and only when rsync's stats block parsed:
     * what the real copy would write. Null on a real restore, and on a dry run
     * whose output could not be parsed.
     */
    plan: { files: number; bytes: number } | null;
}

/** One row of `status()`: everything an operator needs about one target. */
export interface TargetStatus {
    /** Target name. */
    target: string;
    /** Newest snapshot recorded by a successful run report, or null. */
    lastSnapshot: string | null;
    /** ISO time the target is next due (including any active backoff delay), or null when disabled. */
    nextDueAt: string | null;
    /** Status of the newest run report, or null when the target never ran. */
    lastResult: RunStatus | null;
    /** Consecutive failed runs, derived from the run reports. */
    consecutiveFailures: number;
    /** True when the destination-root lock is currently held (local stores only; remote locks report false). */
    lockHeld: boolean;
}
