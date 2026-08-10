/**
 * The engine's public report and status types (spec sections 1 and 8):
 * `RunReport` (one invocation) and its per-target `TargetRunReport` (the
 * persisted JSON shape), plus the prune/check/restore reports and the
 * `TargetStatus` row surfaced by `Backupkit.status()`.
 */

import type { TransferAttempt } from "../rsync/rsync.js";
import type { RetentionPlan } from "../retention/retention.js";

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
    /** Machine-readable skip/failure reason ("window", "disk-low", "clock-skew", "verify-failed", "aborted", "dry-run"), or null. */
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
    /** Jail-line data for every push target. */
    jailLines: JailLine[];
    /** Every collected error, in discovery order. */
    errors: string[];
}

/** The report `restore()` returns. */
export interface RestoreReport {
    /** Target the snapshot belongs to. */
    target: string;
    /** The resolved snapshot name that was copied. */
    snapshot: string;
    /** The output path the snapshot was copied to. */
    output: string;
    /** True only when the opt-in verify pass ran and found no difference. */
    verified: boolean;
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
