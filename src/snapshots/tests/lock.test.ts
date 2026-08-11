import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exec } from "../../exec/exec.js";
import { LockHeldError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import { pidStartTime, withLockScope, type LockBackend, type LockMeta } from "../internal/lock.js";
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

describe("unlock (the operator escape hatch behind `backupkit unlock`)", () => {
    let tmp: string;
    let root: string;
    let lockPath: string;
    let store: LocalSnapshotStore;

    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), "backupkit-unlock-"));
        root = join(tmp, "web");
        lockPath = join(root, ".backupkit.lock");
        store = new LocalSnapshotStore(root, log);
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    /** Plant a lock directory with the given meta, backdated past the grace window. */
    async function plantLock(meta: unknown): Promise<void> {
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, "meta"), JSON.stringify(meta));
        await utimes(lockPath, OLD_LOCK_TIME, OLD_LOCK_TIME);
    }

    it("reports `none` when nothing is holding it, and leaves no lock behind", async () => {
        // Existence is probed by ACQUIRING, so the probe itself must not leak
        // the very thing this verb exists to clean up.
        await expect(store.unlock(false)).resolves.toEqual({ status: "none" });
        expect(existsSync(lockPath)).toBe(false);
    });

    it("removes a stale lock without --force (a dead holder is nobody's live run)", async () => {
        await plantLock({ pid: 999999, pidStartTime: null, hostname: hostname(), createdAt: OLD_LOCK_TIME.toISOString() });
        const outcome = await store.unlock(false);
        expect(outcome.status).toBe("removed");
        expect(existsSync(lockPath)).toBe(false);
    });

    it("refuses a LIVE lock without --force and leaves it exactly where it was", async () => {
        // process.pid is alive by definition - the one case an operator cannot
        // adjudicate from the message alone, so the default must not delete it.
        await plantLock({
            pid: process.pid,
            pidStartTime: await pidStartTime(process.pid),
            hostname: hostname(),
            createdAt: new Date().toISOString(),
        });
        const outcome = await store.unlock(false);
        expect(outcome.status).toBe("held");
        expect(existsSync(lockPath)).toBe(true);
        expect(existsSync(join(lockPath, "meta"))).toBe(true);
    });

    it("clears that same live lock with --force", async () => {
        await plantLock({
            pid: process.pid,
            pidStartTime: await pidStartTime(process.pid),
            hostname: hostname(),
            createdAt: new Date().toISOString(),
        });
        expect((await store.unlock(true)).status).toBe("removed");
        expect(existsSync(lockPath)).toBe(false);
    });

    it("a cleared lock is immediately re-acquirable", async () => {
        await plantLock({ pid: 999999, pidStartTime: null, hostname: hostname(), createdAt: OLD_LOCK_TIME.toISOString() });
        await store.unlock(true);
        await expect(store.withLock(async () => "ok")).resolves.toBe("ok");
    });
});

// Regression (HIGH): the stale-lock steal was a blind `remove()` of whatever
// sat at the lock path at that moment, not of the instance `inspect()` had
// judged - so two contenders over ONE pre-existing stale lock BOTH ended up
// holding it: A removed the stale lock, acquired and wrote its meta while B -
// one round-trip behind, still holding its own stale observation - removed A's
// LIVE lock and acquired too. Measured over a fake jail runner with realistic
// per-command latency: at a 200 ms stagger both processes were inside at once,
// timeline [A IN, B IN, A OUT, B OUT]. B's claimPartial then renamed A's
// in-flight <snapA>.partial away, A kept writing into a recreated one holding
// only the post-rename remainder, and A promoted that truncated tree and
// reported success - after which it became the --link-dest basis and the
// newest-snapshot floor while real history aged out.
//
// The interleaving is reproduced deterministically here: contender B's
// `inspect` observes the lock, and A's ENTIRE steal (remove, acquire, write
// meta) lands before B acts on that observation.
describe("stale-lock takeover is not a TOCTOU (two contenders, one stale lock)", () => {
    /**
     * A `LockBackend` over one in-memory lock path, modelling what both real
     * backends do: `tryAcquire` creates the lock only when the path is free and
     * every creation is a NEW instance; a freshly created lock inspects as HELD
     * (the local backend's META_GRACE_MS window, the remote backend's
     * markerless-lock grace) while the pre-planted one inspects as stale; and
     * `removeIfUnchanged` is the identity compare the real local backend does
     * against the lock directory's inode.
     */
    function fakeWorld() {
        const world = { lock: { instance: 0, stale: true } as { instance: number; stale: boolean } | null, next: 1 };
        const backend = (afterInspect?: () => Promise<void>): LockBackend => {
            let observed: number | null = null;
            return {
                lockPath: "/archive/web/.backupkit.lock",
                async tryAcquire() {
                    if (world.lock !== null) {
                        return false;
                    }
                    world.lock = { instance: world.next, stale: false };
                    world.next += 1;
                    return true;
                },
                async writeMeta() {},
                async inspect() {
                    const seen = world.lock;
                    observed = seen?.instance ?? null;
                    // The other contender's whole steal lands here: the answer
                    // below describes the lock as it was when we looked.
                    await afterInspect?.();
                    return seen === null
                        ? { stale: true, pid: null, hostname: null, detail: "lock disappeared" }
                        : { stale: seen.stale, pid: null, hostname: null, detail: `instance ${seen.instance}` };
                },
                async removeIfUnchanged() {
                    if (world.lock === null || world.lock.instance !== observed) {
                        return false;
                    }
                    world.lock = null;
                    return true;
                },
                async remove() {
                    world.lock = null;
                },
            };
        };
        return { world, backend };
    }

    it("only one contender ever gets inside; the loser reports the lock held", async () => {
        const { world, backend } = fakeWorld();
        let inside = 0;
        let bothInsideAtOnce = false;
        const timeline: string[] = [];
        let announceA!: () => void;
        const aIsInside = new Promise<void>((resolve) => {
            announceA = resolve;
        });
        let releaseA!: () => void;
        const aMayLeave = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        /** Enter the critical section as `label`, recording any overlap. */
        function enter(label: string): void {
            inside += 1;
            timeline.push(`${label} IN`);
            bothInsideAtOnce = bothInsideAtOnce || inside > 1;
        }
        /** Leave the critical section as `label`. */
        function leave(label: string): void {
            inside -= 1;
            timeline.push(`${label} OUT`);
        }

        let a: Promise<string> | null = null;
        // B observes the stale lock; A's ENTIRE steal then completes and A is
        // holding a LIVE lock by the time B acts on its stale observation.
        const b = withLockScope(
            backend(async () => {
                if (a === null) {
                    a = withLockScope(backend(), log, async () => {
                        enter("A");
                        announceA();
                        await aMayLeave;
                        leave("A");
                        return "A";
                    });
                    await aIsInside;
                }
            }),
            log,
            async () => {
                enter("B");
                leave("B");
                return "B";
            },
        );
        const outcome = await b.then(
            (value) => value,
            (error: unknown) => error,
        );
        expect(bothInsideAtOnce).toBe(false);
        expect(outcome).toBeInstanceOf(LockHeldError);
        // A's lock survived B's attempt and is released structurally.
        expect(world.lock).not.toBeNull();
        releaseA();
        await expect(a).resolves.toBe("A");
        expect(timeline).toEqual(["A IN", "A OUT"]);
        expect(world.lock).toBeNull();
    });

    it("a stale lock nobody else contends for is still taken over", async () => {
        const { world, backend } = fakeWorld();
        await expect(withLockScope(backend(), log, async () => "took over")).resolves.toBe("took over");
        expect(world.lock).toBeNull();
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
