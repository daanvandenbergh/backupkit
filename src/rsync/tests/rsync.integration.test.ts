/**
 * Local-to-local integration checks against a REAL rsync binary: proves the
 * built argv actually transfers, resumes the link-dest chain with hardlinks,
 * and that estimate mode writes nothing. No ssh, no network, tmpdirs only.
 * Skips loudly when no rsync >= 3.2.5 is installed locally.
 */

import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../../shared/logger.js";
import { dryRunStats, probeLocalRsync, runTransfer, type TransferSpec } from "../rsync.js";

let rsyncProbe: { bin: string; version: string } | null = null;
try {
    rsyncProbe = await probeLocalRsync(null);
} catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[rsync integration] SKIPPED - no usable local rsync: ${(error as Error).message}`);
}

const silentLog = new Logger({ level: "error", stdout: { write() {} }, stderr: { write() {} } });

/** Build a local-to-local spec into the given partial directory. */
function spec(src: string, dstPartial: string, overrides?: Partial<TransferSpec>): TransferSpec {
    return {
        src: { kind: "local", path: src },
        dst: { kind: "local", path: dstPartial },
        options: {
            compress: false,
            bwlimit: null,
            ioTimeoutSec: 600,
            xattrs: false,
            preserveOwnership: true,
            preserveDevices: false,
            remoteRsyncBin: null,
        },
        exclude: [],
        sshTokens: [],
        linkDestBase: null,
        fakeSuper: false,
        ...overrides,
    };
}

describe.skipIf(rsyncProbe === null)("rsync integration (real local rsync)", () => {
    let root = "";
    let srcDir = "";
    let storeDir = "";

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "backupkit-rsync-"));
        srcDir = join(root, "src");
        storeDir = join(root, "store", "web");
        await mkdir(join(srcDir, "sub"), { recursive: true });
        await mkdir(join(srcDir, "cache"), { recursive: true });
        await mkdir(storeDir, { recursive: true });
        await writeFile(join(srcDir, "a.txt"), "alpha v1\n");
        await writeFile(join(srcDir, "sub", "b.txt"), "beta\n");
        await writeFile(join(srcDir, "we ird $file'name.txt"), "hostile name\n");
        await writeFile(join(srcDir, "cache", "junk.tmp"), "excluded\n");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("first snapshot: transfers content byte-identically and honors excludes", async () => {
        const partial = join(storeDir, "2026-08-10T031500Z.partial");
        const bin = rsyncProbe as { bin: string };
        const result = await runTransfer({ rsyncBin: bin.bin, spec: spec(srcDir, partial, { exclude: ["cache/"] }), retryAttempts: 5, log: silentLog });
        expect(result.status).toBe("success");
        expect(result.attempts).toHaveLength(1);
        expect(result.stats?.filesTransferred).toBeGreaterThan(0);
        await rename(partial, join(storeDir, "2026-08-10T031500Z"));
        const snap = join(storeDir, "2026-08-10T031500Z");
        expect(await readFile(join(snap, "a.txt"), "utf8")).toBe("alpha v1\n");
        expect(await readFile(join(snap, "sub", "b.txt"), "utf8")).toBe("beta\n");
        expect(await readFile(join(snap, "we ird $file'name.txt"), "utf8")).toBe("hostile name\n");
        expect(existsSync(join(snap, "cache"))).toBe(false);
    }, 30_000);

    it("second snapshot: unchanged files hardlink into --link-dest, changed files diverge", async () => {
        const bin = (rsyncProbe as { bin: string }).bin;
        const firstPartial = join(storeDir, "2026-08-10T031500Z.partial");
        await runTransfer({ rsyncBin: bin, spec: spec(srcDir, firstPartial), retryAttempts: 5, log: silentLog });
        const first = join(storeDir, "2026-08-10T031500Z");
        await rename(firstPartial, first);

        await writeFile(join(srcDir, "a.txt"), "alpha v2 - changed\n");
        const secondPartial = join(storeDir, "2026-08-10T041500Z.partial");
        const result = await runTransfer({
            rsyncBin: bin,
            spec: spec(srcDir, secondPartial, { linkDestBase: "2026-08-10T031500Z" }),
            retryAttempts: 5,
            log: silentLog,
        });
        expect(result.status).toBe("success");
        const second = join(storeDir, "2026-08-10T041500Z");
        await rename(secondPartial, second);

        const unchangedFirst = await stat(join(first, "sub", "b.txt"));
        const unchangedSecond = await stat(join(second, "sub", "b.txt"));
        expect(unchangedSecond.ino).toBe(unchangedFirst.ino);

        const changedFirst = await stat(join(first, "a.txt"));
        const changedSecond = await stat(join(second, "a.txt"));
        expect(changedSecond.ino).not.toBe(changedFirst.ino);
        expect(await readFile(join(second, "a.txt"), "utf8")).toBe("alpha v2 - changed\n");
        expect(await readFile(join(first, "a.txt"), "utf8")).toBe("alpha v1\n");
    }, 30_000);

    it("estimate mode reports a delta without creating the partial", async () => {
        const bin = (rsyncProbe as { bin: string }).bin;
        const partial = join(storeDir, "2026-08-10T031500Z.partial");
        const stats = await dryRunStats({ rsyncBin: bin, spec: spec(srcDir, partial), log: silentLog });
        expect(stats.totalTransferredSize).toBeGreaterThan(0);
        expect(stats.totalFiles).toBeGreaterThan(0);
        expect(existsSync(partial)).toBe(false);
    }, 30_000);
});
