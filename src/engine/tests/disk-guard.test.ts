/**
 * Disk-guard arithmetic tables: the delta*1.2 + 256 MiB requirement, the
 * percent/absolute minFree floors, and the shortfall decision.
 */

import { describe, expect, it } from "vitest";

import {
    evaluateDiskGuard,
    INODE_FLOOR_BYTES,
    INODE_HEADROOM,
    minFreeFloorBytes,
    requiredBytes,
    requiredInodes,
} from "../internal/disk-guard.js";

describe("requiredBytes", () => {
    it.each([
        { delta: 0, required: INODE_FLOOR_BYTES },
        { delta: 1000, required: 1200 + INODE_FLOOR_BYTES },
        { delta: 10_485_760, required: 12_582_912 + INODE_FLOOR_BYTES },
    ])("delta $delta -> $required", ({ delta, required }) => {
        expect(requiredBytes(delta)).toBe(required);
    });
});

describe("minFreeFloorBytes", () => {
    it("absolute floors pass through", () => {
        expect(minFreeFloorBytes({ kind: "bytes", bytes: 5_000 }, null)).toBe(5_000);
    });

    it("percent floors scale the filesystem total", () => {
        expect(minFreeFloorBytes({ kind: "percent", percent: 5 }, 1_000_000)).toBe(50_000);
    });

    it("percent floors degrade to 0 when the total is unknown", () => {
        expect(minFreeFloorBytes({ kind: "percent", percent: 5 }, null)).toBe(0);
    });
});

describe("requiredInodes", () => {
    it.each([
        { newFiles: 0, required: INODE_HEADROOM },
        { newFiles: 10, required: 12 + INODE_HEADROOM },
        { newFiles: 10_000_000, required: 12_000_000 + INODE_HEADROOM },
    ])("$newFiles new files -> $required inodes", ({ newFiles, required }) => {
        expect(requiredInodes(newFiles)).toBe(required);
    });
});

describe("evaluateDiskGuard", () => {
    it("passes when free covers required plus the floor", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            newFiles: 0,
            freeBytes: INODE_FLOOR_BYTES + 100,
            freeInodes: null,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 100 },
        });
        expect(decision.ok).toBe(true);
    });

    it("fails on a one-byte shortfall", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            newFiles: 0,
            freeBytes: INODE_FLOOR_BYTES + 99,
            freeInodes: null,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 100 },
        });
        expect(decision.ok).toBe(false);
        expect(decision.requiredBytes).toBe(INODE_FLOOR_BYTES);
        expect(decision.floorBytes).toBe(100);
    });

    // A source presenting tens of millions of empty files exhausts the archive
    // filesystem's inodes and breaks every target on it - bytes never notice.
    it("fails on an inode shortfall even when bytes are abundant", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            newFiles: 10_000_000,
            freeBytes: Number.MAX_SAFE_INTEGER,
            freeInodes: 500_000,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 0 },
        });
        expect(decision.ok).toBe(false);
        expect(decision.requiredInodes).toBe(12_000_000 + INODE_HEADROOM);
        expect(decision.freeInodes).toBe(500_000);
    });

    it("passes when inodes cover the new files with headroom", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            newFiles: 1000,
            freeBytes: Number.MAX_SAFE_INTEGER,
            freeInodes: 1200 + INODE_HEADROOM,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 0 },
        });
        expect(decision.ok).toBe(true);
    });

    // A store that cannot report inodes (the push store: the jail answers only
    // `df -Pk --`, which has no inode columns) must SKIP the inode half, not
    // treat unknown as plenty and not treat it as a shortfall.
    it("skips the inode half when the store cannot report inodes", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            newFiles: 10_000_000,
            freeBytes: Number.MAX_SAFE_INTEGER,
            freeInodes: null,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 0 },
        });
        expect(decision.ok).toBe(true);
        expect(decision.requiredInodes).toBeNull();
        expect(decision.freeInodes).toBeNull();
    });
});
