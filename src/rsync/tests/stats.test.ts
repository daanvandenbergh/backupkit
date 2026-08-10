import { describe, expect, it } from "vitest";
import { parseStats2 } from "../internal/stats.js";

/** A realistic rsync 3.2.7 --info=stats2 block under LC_ALL=C (comma grouping). */
const FULL_STATS = [
    "Number of files: 120,433 (reg: 100,001, dir: 20,432)",
    "Number of created files: 5 (reg: 5)",
    "Number of deleted files: 2",
    "Number of regular files transferred: 812",
    "Total file size: 5,678,901,234 bytes",
    "Total transferred file size: 10,485,760 bytes",
    "Literal data: 10,485,760 bytes",
    "Matched data: 0 bytes",
    "File list size: 123,456",
    "File list generation time: 0.501 seconds",
    "File list transfer time: 0.000 seconds",
    "Total bytes sent: 10,500,000",
    "Total bytes received: 12,345",
].join("\n");

describe("parseStats2", () => {
    it("parses a full stats2 block with comma grouping", () => {
        expect(parseStats2(FULL_STATS)).toEqual({
            filesTransferred: 812,
            totalFiles: 120433,
            totalTransferredSize: 10485760,
        });
    });

    it("parses small ungrouped values", () => {
        const output = [
            "Number of files: 3 (reg: 2, dir: 1)",
            "Number of regular files transferred: 2",
            "Total transferred file size: 999 bytes",
        ].join("\n");
        expect(parseStats2(output)).toEqual({ filesTransferred: 2, totalFiles: 3, totalTransferredSize: 999 });
    });

    it("parses an all-zero dry-run (nothing to transfer)", () => {
        const output = [
            "Number of files: 10 (reg: 9, dir: 1)",
            "Number of regular files transferred: 0",
            "Total transferred file size: 0 bytes",
        ].join("\n");
        expect(parseStats2(output)).toEqual({ filesTransferred: 0, totalFiles: 10, totalTransferredSize: 0 });
    });

    it("survives transfer noise before the stats block", () => {
        const output = "sent 42 bytes\nsome/file\n" + FULL_STATS + "\n\nsent 10,500,000 bytes  received 12,345 bytes\n";
        expect(parseStats2(output)?.totalTransferredSize).toBe(10485760);
    });

    it('does not confuse "Number of created files" with "Number of files"', () => {
        expect(parseStats2(FULL_STATS)?.totalFiles).toBe(120433);
    });

    it.each([
        ["empty output", ""],
        ["missing Total transferred file size", "Number of files: 3\nNumber of regular files transferred: 2"],
        ["missing Number of files", "Number of regular files transferred: 2\nTotal transferred file size: 9 bytes"],
        [
            "missing Number of regular files transferred",
            "Number of files: 3\nTotal transferred file size: 9 bytes",
        ],
        ["non-numeric garbage", "Number of files: lots\nNumber of regular files transferred: 2\nTotal transferred file size: 9 bytes"],
    ])("returns null for %s", (_label, output) => {
        expect(parseStats2(output)).toBeNull();
    });
});
