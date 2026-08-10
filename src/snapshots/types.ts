/**
 * The one public type of the snapshots module: `SnapshotInfo`, the read-only
 * description of a complete snapshot as surfaced by `Backupkit.listSnapshots`.
 * The store interface and its implementations stay package-internal so no
 * library user can bypass the lock, retention floors, or newest-snapshot
 * invariant.
 */

import { parseSnapshotName } from "../shared/snapshot-name.js";

/** One complete snapshot of one target, as listed by the read surface. */
export interface SnapshotInfo {
    /** Name of the target the snapshot belongs to. */
    target: string;
    /** Snapshot directory name (the codec form, e.g. "2026-08-10T031502Z"). */
    name: string;
    /** UTC creation time parsed from the name (the run's start time). */
    createdAt: Date;
}

/**
 * Clock-skew allowance for a snapshot name dated in the FUTURE: 5 minutes.
 *
 * The client's own clock is the only legitimate writer of snapshot names, so a
 * name dated meaningfully ahead of now cannot be genuine - it is either a
 * clock-skew accident or something a jailed writer planted (one `mkdir -p --
 * <root>/<target>/2099-01-01T000000Z` is accepted by the jail by design). Such
 * a name must never become "the newest complete snapshot": that would fail the
 * clock-skew guard on every run forever AND make the archive unprunable,
 * because a store refuses to delete its newest complete snapshot.
 *
 * ponytail: one flat 5 min allowance - generous for NTP wander, far below any
 * real schedule interval. A per-target knob only if someone runs on hardware
 * whose clock is worse than that.
 */
export const SNAPSHOT_FUTURE_SKEW_MS = 5 * 60_000;

/** A snapshot listing split into plausibly-dated names and future-dated ones. */
export interface SnapshotSplit {
    /** Names dated at or before `now + SNAPSHOT_FUTURE_SKEW_MS`, in input order. */
    genuine: string[];
    /** Names dated beyond the skew allowance in the future, in input order. */
    future: string[];
}

/** Whether `name` is dated further than the skew allowance ahead of `now`. */
export function isFutureSnapshotName(name: string, now: Date): boolean {
    const created = parseSnapshotName(name);
    return created !== null && created.getTime() - now.getTime() > SNAPSHOT_FUTURE_SKEW_MS;
}

/**
 * Split a complete-snapshot listing into genuine and future-dated names,
 * preserving the input order (callers pass the store's ascending listing).
 * Names failing the codec are dropped - they are never snapshots.
 */
export function splitFutureSnapshots(names: readonly string[], now: Date): SnapshotSplit {
    const genuine: string[] = [];
    const future: string[] = [];
    for (const name of names) {
        if (parseSnapshotName(name) === null) {
            continue;
        }
        (isFutureSnapshotName(name, now) ? future : genuine).push(name);
    }
    return { genuine, future };
}

/**
 * The newest complete snapshot a store must refuse to delete (invariant 7):
 * the newest GENUINE name, falling back to the newest name overall when every
 * name is future-dated - so a target whose only snapshot is future-dated keeps
 * it (it may hold the only copy of the data), while a future-dated name sitting
 * next to real history is deletable and the archive can heal itself.
 */
export function newestUndeletable(names: readonly string[], now: Date): string | null {
    const { genuine, future } = splitFutureSnapshots(names, now);
    return genuine.at(-1) ?? future.at(-1) ?? null;
}
