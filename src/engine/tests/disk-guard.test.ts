/**
 * Disk-guard arithmetic tables: the delta*1.2 + 256 MiB requirement, the
 * percent/absolute minFree floors, and the shortfall decision.
 */

import { describe, expect, it } from "vitest";

import { evaluateDiskGuard, INODE_FLOOR_BYTES, minFreeFloorBytes, requiredBytes } from "../internal/disk-guard.js";

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

describe("evaluateDiskGuard", () => {
    it("passes when free covers required plus the floor", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            freeBytes: INODE_FLOOR_BYTES + 100,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 100 },
        });
        expect(decision.ok).toBe(true);
    });

    it("fails on a one-byte shortfall", () => {
        const decision = evaluateDiskGuard({
            deltaBytes: 0,
            freeBytes: INODE_FLOOR_BYTES + 99,
            totalBytes: null,
            minFree: { kind: "bytes", bytes: 100 },
        });
        expect(decision.ok).toBe(false);
        expect(decision.requiredBytes).toBe(INODE_FLOOR_BYTES);
        expect(decision.floorBytes).toBe(100);
    });
});
