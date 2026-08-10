import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exec } from "../../exec/exec.js";
import { LockHeldError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import { pidStartTime, type LockMeta } from "../internal/lock.js";
import { LocalSnapshotStore } from "../internal/local-store.js";

/** Silent logger for the suites. */
const log = new Logger({ level: "error", stdout: { write() {} }, stderr: { write() {} } });

/** Poll until `cond` holds (100 ms steps, 10 s budget). */
async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 1000; i += 1) {
        if (cond()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition never became true");
}

/** A date safely older than the unparseable-meta grace window. */
const OLD_LOCK_TIME = new Date(Date.now() - 60 * 60 * 1000);

describe("local store lock (mkdir + meta)", () => {
    let tmp: string;
    let root: string;
    let lockPath: string;
    let store: LocalSnapshotStore;

    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), "backupkit-lock-"));
        root = join(tmp, "web");
        lockPath = join(root, ".backupkit.lock");
        store = new LocalSnapshotStore(root, log);
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    /** Plant a lock directory with the given meta and backdate it past the grace window. */
    async function plantLock(meta: unknown): Promise<void> {
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, "meta"), typeof meta === "string" ? meta : JSON.stringify(meta));
        await utimes(lockPath, OLD_LOCK_TIME, OLD_LOCK_TIME);
    }

    it("two concurrent withLock on one root: exactly one enters, the other gets LockHeldError", async () => {
        let entered = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = store.withLock(async () => {
            entered += 1;
            await gate;
            return "first";
        });
        await waitFor(() => entered === 1);
        const error = await store
            .withLock(async () => {
                entered += 1;
                return "second";
            })
            .then(
                () => null,
                (e: unknown) => e,
            );
        expect(error).toBeInstanceOf(LockHeldError);
        expect((error as LockHeldError).pid).toBe(process.pid);
        expect((error as LockHeldError).hostname).toBe(hostname());
        expect(entered).toBe(1);
        release();
        await expect(first).resolves.toBe("first");
    });

    it("releases the lock after fn resolves, so the next withLock enters", async () => {
        await store.withLock(async () => "a");
        expect(existsSync(lockPath)).toBe(false);
        await expect(store.withLock(async () => "b")).resolves.toBe("b");
    });

    it("releases the lock in finally when fn throws, and rethrows fn's error", async () => {
        await expect(
            store.withLock(async () => {
                throw new Error("pipeline boom");
            }),
        ).rejects.toThrow("pipeline boom");
        expect(existsSync(lockPath)).toBe(false);
        await expect(store.withLock(async () => "recovered")).resolves.toBe("recovered");
    });

    it("records pid, pid start time, hostname, and createdAt in the meta file", async () => {
        await store.withLock(async () => {
            const meta = JSON.parse(await readFile(join(lockPath, "meta"), "utf8")) as LockMeta;
            expect(meta.pid).toBe(process.pid);
            expect(meta.hostname).toBe(hostname());
            expect(typeof meta.pidStartTime).toBe("string");
            expect(meta.pidStartTime).not.toBe("");
            expect(meta.pidStartTime).toBe(await pidStartTime(process.pid));
            expect(new Date(meta.createdAt).getTime()).not.toBeNaN();
        });
    });

    it("takes over a stale lock whose recorded pid is dead", async () => {
        const child = await exec(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 10_000 });
        const deadPid = Number(child.stdout.trim());
        expect(Number.isInteger(deadPid)).toBe(true);
        await plantLock({
            pid: deadPid,
            pidStartTime: "gone",
            hostname: hostname(),
            createdAt: new Date().toISOString(),
        });
        await expect(store.withLock(async () => "took over")).resolves.toBe("took over");
        expect(existsSync(lockPath)).toBe(false);
    });

    // A pid probe proves nothing about ANOTHER host's process table. On a shared
    // archive (NFS/SMB, or two containers with separate pid namespaces) this host
    // sees the other's live pid as dead-or-recycled; stealing that lock then lets
    // claimPartial reap the other host's in-flight snapshot.
    it("never steals a lock held by another host, even when the recorded pid looks dead here", async () => {
        const child = await exec(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 10_000 });
        await plantLock({
            pid: Number(child.stdout.trim()),
            pidStartTime: "gone",
            hostname: `${hostname()}-other`,
            createdAt: new Date().toISOString(),
        });
        await expect(store.withLock(async () => "took over")).rejects.toBeInstanceOf(LockHeldError);
        expect(existsSync(lockPath)).toBe(true);
    });

    it("a foreign lock past the 24h TTL is stale, and so is one dated in the future", async () => {
        for (const createdAt of [
            new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
            new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
        ]) {
            await rm(lockPath, { recursive: true, force: true });
            await plantLock({ pid: process.pid, pidStartTime: null, hostname: `${hostname()}-other`, createdAt });
            await expect(store.withLock(async () => "took over")).resolves.toBe("took over");
        }
    });

    it("takes over a stale lock whose live pid has a mismatched start time (recycled pid)", async () => {
        await plantLock({
            pid: process.pid,
            pidStartTime: "definitely not our start time",
            hostname: hostname(),
            createdAt: new Date().toISOString(),
        });
        await expect(store.withLock(async () => "took over")).resolves.toBe("took over");
    });

    it("takes over a lock with unparseable meta once it is past the grace window", async () => {
        await plantLock("this is not json {");
        await expect(store.withLock(async () => "took over")).resolves.toBe("took over");
    });

    it("does NOT steal a fresh meta-less lock (young-lock grace window)", async () => {
        await mkdir(lockPath, { recursive: true });
        // No meta, mtime is now: a winner mid-acquisition. Must be treated as held.
        await expect(store.withLock(async () => "never")).rejects.toBeInstanceOf(LockHeldError);
        expect(existsSync(lockPath)).toBe(true);
    });

    it("refuses to run fn while a live holder with matching identity exists", async () => {
        await plantLock({
            pid: process.pid,
            pidStartTime: await pidStartTime(process.pid),
            hostname: hostname(),
            createdAt: new Date().toISOString(),
        });
        let ran = false;
        const error = await store
            .withLock(async () => {
                ran = true;
            })
            .then(
                () => null,
                (e: unknown) => e,
            );
        expect(error).toBeInstanceOf(LockHeldError);
        expect(ran).toBe(false);
        // The live lock was left alone.
        expect(existsSync(lockPath)).toBe(true);
    });

    it("a pre-planted symlink lock is unlinked as stale, never followed", async () => {
        const victim = join(tmp, "victim");
        await mkdir(victim, { recursive: true });
        await writeFile(join(victim, "precious"), "do not delete");
        await mkdir(root, { recursive: true });
        await symlink(victim, lockPath);
        await expect(store.withLock(async () => "ok")).resolves.toBe("ok");
        // The symlink target survived untouched; the link itself is gone.
        expect(existsSync(join(victim, "precious"))).toBe(true);
        expect(existsSync(lockPath)).toBe(false);
    });
});

describe("pidStartTime", () => {
    it("returns a stable non-empty string for the current process", async () => {
        const first = await pidStartTime(process.pid);
        const second = await pidStartTime(process.pid);
        expect(typeof first).toBe("string");
        expect(first).not.toBe("");
        expect(second).toBe(first);
    });
});
