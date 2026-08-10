/**
 * The disk-guard decision (spec section 3 step 3): pure arithmetic over the
 * estimated delta, the archive filesystem's free bytes, and the configured
 * minFree floor. Required = delta * 1.2 + 256 MiB (20% margin + inode floor);
 * a shortfall skips the run (`skipped`, reason `disk-low`) - the guard never
 * crashes the daemon and never deletes anything.
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
}

/**
 * Evaluate the guard: the run may proceed iff `free - required >= floor`.
 * Pure - the caller supplies every number.
 */
export function evaluateDiskGuard(params: {
    /** Estimated transfer delta in bytes (from the dry-run pre-pass). */
    deltaBytes: number;
    /** Free bytes on the archive filesystem. */
    freeBytes: number;
    /** Total bytes of the archive filesystem, or null when unknown. */
    totalBytes: number | null;
    /** The parsed minFree floor. */
    minFree: MinFree;
}): DiskGuardDecision {
    const required = requiredBytes(params.deltaBytes);
    const floor = minFreeFloorBytes(params.minFree, params.totalBytes);
    return {
        ok: params.freeBytes - required >= floor,
        requiredBytes: required,
        freeBytes: params.freeBytes,
        floorBytes: floor,
    };
}
