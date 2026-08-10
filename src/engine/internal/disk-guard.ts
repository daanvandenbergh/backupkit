/**
 * The disk-guard decision (spec section 3 step 3): pure arithmetic over the
 * estimated delta, the archive filesystem's free bytes, and the configured
 * minFree floor, plus the inode-headroom half. Required = delta * 1.2 + 256 MiB
 * (20% margin + metadata floor) and, where the store can report inodes,
 * newFiles * 1.2 + 1024 free inodes; a shortfall on either skips the run
 * (`skipped`, reason `disk-low`) - the guard never crashes the daemon and never
 * deletes anything.
 */

import type { MinFree } from "../../shared/format.js";

/** Safety margin multiplied onto the estimated delta. */
export const DISK_GUARD_MARGIN = 1.2;

/** Flat inode/metadata floor added to the projected requirement: 256 MiB. */
export const INODE_FLOOR_BYTES = 268_435_456;

/** The projected bytes a transfer needs: `deltaBytes * 1.2 + 256 MiB`. */
export function requiredBytes(deltaBytes: number): number {
    return Math.ceil(deltaBytes * DISK_GUARD_MARGIN) + INODE_FLOOR_BYTES;
}

/**
 * The minFree floor in bytes. Percent floors need the filesystem's total
 * size; when it is unknown (`totalBytes === null`, e.g. a remote store) the
 * percent floor degrades to 0 - the delta*1.2+256MiB requirement still
 * guards the run. The caller logs that degradation once.
 */
export function minFreeFloorBytes(minFree: MinFree, totalBytes: number | null): number {
    if (minFree.kind === "bytes") {
        return minFree.bytes;
    }
    return totalBytes === null ? 0 : Math.ceil((totalBytes * minFree.percent) / 100);
}

/**
 * Safety margin multiplied onto the estimated NEW-file count, plus a flat
 * headroom of 1024 inodes for directories the estimate does not count.
 *
 * The count fed in is the dry-run's "regular files transferred" - the files
 * that need a NEW inode. Unchanged files are hardlinked from `--link-dest` and
 * consume none, which is why the file-LIST size (`totalFiles`) would be wildly
 * over-conservative here and could pin a healthy target at `disk-low` forever.
 *
 * ponytail: one flat margin, no per-target knob. The check exists to stop a
 * source that presents tens of millions of empty files from exhausting the
 * archive filesystem's inodes and breaking every other target on it - not to
 * predict inode use precisely.
 */
export const INODE_MARGIN = 1.2;

/** Flat inode headroom added to the projected inode requirement. */
export const INODE_HEADROOM = 1024;

/** The projected inodes a transfer needs for `newFiles` new files. */
export function requiredInodes(newFiles: number): number {
    return Math.ceil(newFiles * INODE_MARGIN) + INODE_HEADROOM;
}

/** Outcome of one disk-guard evaluation. */
export interface DiskGuardDecision {
    /** True when the transfer may run. */
    ok: boolean;
    /** Projected bytes the transfer needs. */
    requiredBytes: number;
    /** Free bytes on the archive filesystem at evaluation time. */
    freeBytes: number;
    /** The minFree floor in bytes. */
    floorBytes: number;
    /** Projected inodes the transfer needs, or null when the store cannot report inodes. */
    requiredInodes: number | null;
    /** Free inodes on the archive filesystem, or null when the store cannot report them. */
    freeInodes: number | null;
}

/**
 * Evaluate the guard: the run may proceed iff `free - required >= floor` AND
 * the archive has inode headroom for the new files. A store that cannot report
 * inodes (`freeInodes === null`, e.g. the push store behind the jail's fixed
 * `df -Pk --`) skips the inode half - null means unknown, never "plenty".
 * Pure - the caller supplies every number.
 */
export function evaluateDiskGuard(params: {
    /** Estimated transfer delta in bytes (from the dry-run pre-pass). */
    deltaBytes: number;
    /** Estimated count of files needing a new inode (the dry-run's transferred-file count). */
    newFiles: number;
    /** Free bytes on the archive filesystem. */
    freeBytes: number;
    /** Free inodes on the archive filesystem, or null when unknown. */
    freeInodes: number | null;
    /** Total bytes of the archive filesystem, or null when unknown. */
    totalBytes: number | null;
    /** The parsed minFree floor. */
    minFree: MinFree;
}): DiskGuardDecision {
    const required = requiredBytes(params.deltaBytes);
    const floor = minFreeFloorBytes(params.minFree, params.totalBytes);
    const inodes = params.freeInodes === null ? null : requiredInodes(params.newFiles);
    return {
        ok:
            params.freeBytes - required >= floor &&
            (inodes === null || params.freeInodes === null || params.freeInodes >= inodes),
        requiredBytes: required,
        freeBytes: params.freeBytes,
        floorBytes: floor,
        requiredInodes: inodes,
        freeInodes: params.freeInodes,
    };
}
