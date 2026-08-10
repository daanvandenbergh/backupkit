/**
 * The one public type of the snapshots module: `SnapshotInfo`, the read-only
 * description of a complete snapshot as surfaced by `Backupkit.listSnapshots`.
 * The store interface and its implementations stay package-internal so no
 * library user can bypass the lock, retention floors, or newest-snapshot
 * invariant.
 */

/** One complete snapshot of one target, as listed by the read surface. */
export interface SnapshotInfo {
    /** Name of the target the snapshot belongs to. */
    target: string;
    /** Snapshot directory name (the codec form, e.g. "2026-08-10T031502Z"). */
    name: string;
    /** UTC creation time parsed from the name (the run's start time). */
    createdAt: Date;
}
