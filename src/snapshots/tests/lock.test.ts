import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exec } from "../../exec/exec.js";
import { LockHeldError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import {
    forceUnlock,
    LockJournal,
    pidStartTime,
    withLockScope,
    type LockBackend,
    type LockMeta,
} from "../internal/lock.js";
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

/**
 * A `LockBackend` over one in-memory lock that carries an acquisition
 * TOKEN, modelling the remote backend: `tryAcquire` wins the lock and
 * stamps `ownerToken`; `writeMeta` records that token in the lock;
 * `inspect` reports it back as `LockInspection.token`. The three knobs are
 * the three things the field bug and its neighbours turn on - a release
 * that fails, a lock that cannot be read, and a lock caught mid-acquire.
 */
function makeTokenWorld(options: { unreadable?: boolean } = {}) {
    const world = { lock: null as { token: string | null } | null, next: 1, removes: 0, failRemove: false };
    const backend = (): LockBackend & { ownerToken?: string } => {
        const self = {
            lockPath: "/archive/web/.backupkit.lock",
            ownerToken: undefined as string | undefined,
            async tryAcquire() {
                if (world.lock !== null) {
                    return false;
                }
                // Markerless until writeMeta lands - the real two-round-trip
                // acquire, whose gap is where a forever-lock comes from.
                world.lock = { token: null };
                self.ownerToken = `2026-08-10T03150${world.next}Z`;
                world.next += 1;
                return true;
            },
            async writeMeta() {
                (world.lock as { token: string | null }).token = self.ownerToken ?? null;
            },
            async inspect() {
                if (options.unreadable === true) {
                    // `token` stays UNDEFINED: we could not read the lock.
                    return { stale: false, pid: null, hostname: null, detail: "lock unreadable (assuming held)" };
                }
                return world.lock === null
                    ? { stale: true, pid: null, hostname: null, detail: "lock disappeared", token: null }
                    : { stale: false, pid: null, hostname: null, detail: "in TTL", token: world.lock.token };
            },
            async remove() {
                world.removes += 1;
                if (world.failRemove) {
                    throw new Error("the hostname could not be resolved");
                }
                world.lock = null;
            },
        };
        return self;
    };
    return { world, backend };
}

// The bug this whole mechanism exists for, from the field: a `backupkit start`
// daemon lost DNS mid-run on a push target. The release of a REMOTE lock is
// itself an ssh command, so it failed too - and because the run had already
// failed, the release error was only logged. The lock stayed on the archive
// host, and the SAME still-running daemon was then locked out of its own target
// for 24 h, logging "skipped, another backupkit run has this target" every
// 30 s tick until the TTL expired.
//
// The fix rests on one observation: `inspect()` already reads a value that
// uniquely identifies ONE acquisition, and used to throw it away. Only the
// process that WON the mkdir ever writes a token, so "the token I see is the
// token I wrote and never confirmed releasing" proves the lock is mine.
describe("lock journal: reclaiming a lock this process could not release", () => {
    it("retakes a lock whose release failed, instead of waiting out the 24h TTL", async () => {
        const { world, backend } = makeTokenWorld();
        const journal = new LockJournal();
        world.failRemove = true;
        await expect(withLockScope(backend(), log, async () => "first", journal)).resolves.toBe("first");
        // The lock is still on the "archive": the release could not run.
        expect(world.lock).not.toBeNull();

        world.failRemove = false;
        let ran = false;
        await expect(
            withLockScope(
                backend(),
                log,
                async () => {
                    ran = true;
                    return "second";
                },
                journal,
            ),
        ).resolves.toBe("second");
        expect(ran).toBe(true);
        expect(world.lock).toBeNull();
    });

    // A release failure after a SUCCESSFUL run used to be rethrown, turning a
    // promoted snapshot with completed retention into a `failed` report that
    // fed the backoff - a lie about the backup, to report the truth about a lock.
    it("a failed release does not turn a successful run into a failure", async () => {
        const { world, backend } = makeTokenWorld();
        world.failRemove = true;
        await expect(withLockScope(backend(), log, async () => "done", new LockJournal())).resolves.toBe("done");
    });

    it("refuses to reclaim while this process is still inside the scope", async () => {
        const { world, backend } = makeTokenWorld();
        const journal = new LockJournal();
        let inner: unknown = null;
        await withLockScope(
            backend(),
            log,
            async () => {
                inner = await withLockScope(backend(), log, async () => "nested", journal).catch((error: unknown) => error);
            },
            journal,
        );
        expect(inner).toBeInstanceOf(LockHeldError);
        expect(world.removes).toBe(1);
    });

    it("never reclaims a lock whose token is not the one we wrote", async () => {
        const { world, backend } = makeTokenWorld();
        const journal = new LockJournal();
        world.failRemove = true;
        await withLockScope(backend(), log, async () => "first", journal);
        // Our release actually landed and the reply was lost; somebody else
        // then acquired. Their token is not ours, so this is a skip.
        (world.lock as { token: string | null }).token = "2026-08-10T099999Z";
        const before = world.removes;
        await expect(withLockScope(backend(), log, async () => "no", journal)).rejects.toBeInstanceOf(LockHeldError);
        expect(world.removes).toBe(before);
    });

    // Invariant 35: UNKNOWN is not STALE, and UNKNOWN is not SAFE. "We could
    // not read the lock" (token undefined) is strictly LESS information than
    // "the lock has no token" (token null), so it must never be the more
    // conclusive of the two. A refactor collapsing the two falsy values into
    // one check re-opens this silently, which is what this test stands guard on.
    it("never reclaims a lock it could not READ, even with a matching journal entry", async () => {
        const readable = makeTokenWorld();
        const journal = new LockJournal();
        readable.world.failRemove = true;
        await withLockScope(readable.backend(), log, async () => "first", journal);

        // Same journal, same lock path - but now the lock cannot be listed.
        const blind = makeTokenWorld({ unreadable: true });
        blind.world.lock = { token: null };
        const before = blind.world.removes;
        await expect(withLockScope(blind.backend(), log, async () => "no", journal)).rejects.toBeInstanceOf(LockHeldError);
        expect(blind.world.removes).toBe(before);
    });

    // The acquire is irreducibly two round-trips (win the lock, then mark it),
    // and a holder killed in between leaves a lock with NO token - which has no
    // TTL and so never expires at all. Ours is reclaimable because we recorded
    // winning the mkdir; anybody else's is not.
    it("reclaims a MARKERLESS lock only when this process recorded winning it", async () => {
        const mine = makeTokenWorld();
        const journal = new LockJournal();
        mine.world.failRemove = true;
        // Fail the meta write, so the lock exists with no token at all.
        const first = mine.backend();
        first.writeMeta = async () => {
            throw new Error("marker write failed");
        };
        await expect(withLockScope(first, log, async () => "never", journal)).rejects.toThrow("marker write failed");
        expect(mine.world.lock).toEqual({ token: null });

        mine.world.failRemove = false;
        await expect(withLockScope(mine.backend(), log, async () => "mine", journal)).resolves.toBe("mine");

        // The same markerless lock, with nothing in the journal, is left alone.
        const theirs = makeTokenWorld();
        theirs.world.lock = { token: null };
        await expect(
            withLockScope(theirs.backend(), log, async () => "no", new LockJournal()),
        ).rejects.toBeInstanceOf(LockHeldError);
        expect(theirs.world.removes).toBe(0);
    });

    it("forgets the lock once it is released cleanly", async () => {
        const { world, backend } = makeTokenWorld();
        const journal = new LockJournal();
        await withLockScope(backend(), log, async () => "first", journal);
        expect(world.lock).toBeNull();
        // A later lock that happens to present our old token is somebody
        // else's: we confirmed our release, so we own nothing here.
        world.lock = { token: "2026-08-10T031501Z" };
        await expect(withLockScope(backend(), log, async () => "no", journal)).rejects.toBeInstanceOf(LockHeldError);
        expect(world.removes).toBe(1);
    });

    // The journal is per PROCESS, and this is the executable statement of it:
    // two backupkits on one machine may overlap freely, and neither may ever
    // take over the other's lock.
    it("one journal never reclaims a lock recorded in another", async () => {
        const { world, backend } = makeTokenWorld();
        world.failRemove = true;
        await withLockScope(backend(), log, async () => "first", new LockJournal());
        world.failRemove = false;
        await expect(
            withLockScope(backend(), log, async () => "no", new LockJournal()),
        ).rejects.toBeInstanceOf(LockHeldError);
    });

    // The local store's lock records a real holder identity (pid, start time,
    // hostname) and decides staleness from it. A backend with no `ownerToken`
    // is journalled not at all, so that path is untouched.
    it("leaves a backend that carries no acquisition token entirely alone", async () => {
        const { world, backend } = makeTokenWorld();
        const journal = new LockJournal();
        const tokenless = () => {
            const b = backend();
            b.ownerToken = undefined;
            const won = b.tryAcquire.bind(b);
            b.tryAcquire = async () => {
                const ok = await won();
                b.ownerToken = undefined;
                return ok;
            };
            return b;
        };
        world.failRemove = true;
        await withLockScope(tokenless(), log, async () => "first", journal);
        world.failRemove = false;
        await expect(withLockScope(tokenless(), log, async () => "no", journal)).rejects.toBeInstanceOf(LockHeldError);
    });
});

// Persistence covers the one case in-process memory cannot: a daemon SIGKILLed
// while holding a lock (a `systemctl stop` that outran its timeout) and then
// restarted. It comes back as a NEW process, so the proof has to be a record on
// disk - and a record read by a DIFFERENT process proves nothing until its
// holder has been shown to be gone. Every refusal below is one live holder's
// lock left alone.
// `forceUnlock` answers "is anything holding this?" by ACQUIRING, because on a
// find-only remote surface that is the only primitive that can answer honestly.
// The consequence nobody had looked at: when nothing was holding it, the probe
// has CREATED a lock - and if the removal then fails on the same flaky link
// that made the operator reach for `unlock` in the first place, the escape
// hatch has left a fresh lock behind and reported a bare remote failure the
// operator would read as "nothing happened".
describe("unlock: the probe must not silently leave the lock it created", () => {
    it("says plainly that its probe left a NEW lock when the removal fails", async () => {
        const { world, backend } = makeTokenWorld();
        world.failRemove = true;
        await expect(forceUnlock(backend(), false, new LockJournal())).rejects.toThrow(
            /probing it left a NEW lock/,
        );
        expect(world.lock).not.toBeNull();
    });

    it("names the command that clears what it left behind", async () => {
        const { world, backend } = makeTokenWorld();
        world.failRemove = true;
        await expect(forceUnlock(backend(), false, new LockJournal())).rejects.toThrow(/backupkit unlock --force/);
        expect(world.removes).toBe(1);
    });

    it("still reports nothing held when the probe cleans up after itself", async () => {
        const { world, backend } = makeTokenWorld();
        await expect(forceUnlock(backend(), false, new LockJournal())).resolves.toEqual({ status: "none" });
        expect(world.lock).toBeNull();
    });
});

describe("lock journal: persisted across a restart", () => {
    let dir = "";
    let world: ReturnType<typeof makeTokenWorld>["world"];
    let backend: ReturnType<typeof makeTokenWorld>["backend"];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "backupkit-journal-"));
        ({ world, backend } = makeTokenWorld());
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /** Leave a lock behind with a persisted record, the way a killed run does. */
    async function leakWith(mutate: (record: Record<string, unknown>) => void): Promise<void> {
        const journal = new LockJournal(dir);
        world.failRemove = true;
        await withLockScope(backend(), log, async () => "leaked", journal);
        world.failRemove = false;
        // Reach the record through the directory rather than recomputing its
        // name, so this never restates how the journal names its files.
        const [name] = await readdir(dir);
        const file = join(dir, name);
        const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        mutate(record);
        await writeFile(file, JSON.stringify(record));
    }

    /** Attempt the lock as a FRESH process would: a new journal over the same dir. */
    async function reacquire(): Promise<unknown> {
        return withLockScope(backend(), log, async () => "retaken", new LockJournal(dir)).catch(
            (error: unknown) => error,
        );
    }

    it("retakes a lock whose recorded holder is dead", async () => {
        const child = await exec(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 10_000 });
        const deadPid = Number(child.stdout.trim());
        expect(Number.isInteger(deadPid)).toBe(true);
        await leakWith((record) => {
            record.pid = deadPid;
            record.pidStartTime = "gone";
        });
        expect(await reacquire()).toBe("retaken");
        expect(world.lock).toBeNull();
    });

    it("retakes a lock whose recorded pid was recycled onto another process", async () => {
        await leakWith((record) => {
            record.pidStartTime = "a start time this pid never had";
        });
        expect(await reacquire()).toBe("retaken");
    });

    // The holder is still running. This is the case the whole lock exists for.
    it("never retakes a lock whose recorded pid is still alive", async () => {
        await leakWith(() => undefined);
        expect(await reacquire()).toBeInstanceOf(LockHeldError);
        expect(world.removes).toBe(1);
    });

    // A pid probe proves nothing about ANOTHER machine's process table. On a
    // shared state dir (NFS/SMB, or two containers with separate pid
    // namespaces) this host reads the other's live pid as dead-or-recycled, and
    // stealing that lock runs two pipelines over one archive root. Time is the
    // only honest signal about another machine, and the TTL path still carries it.
    it("never retakes a lock recorded by another host, even when its pid looks dead here", async () => {
        const child = await exec(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 10_000 });
        await leakWith((record) => {
            record.pid = Number(child.stdout.trim());
            record.pidStartTime = "gone";
            record.hostname = `${hostname()}-other`;
        });
        expect(await reacquire()).toBeInstanceOf(LockHeldError);
        expect(world.removes).toBe(1);
    });

    it("fails CLOSED on a record it cannot parse", async () => {
        await leakWith((record) => {
            record.pid = "not a number";
        });
        expect(await reacquire()).toBeInstanceOf(LockHeldError);
    });

    // Within one process life a markerless lock is provably ours, because we
    // saw the mkdir win. Across a restart the "an operator cleared it in
    // between" window is unbounded, so the proof is gone and so is the reclaim.
    it("never retakes a MARKERLESS lock across a restart", async () => {
        const child = await exec(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 10_000 });
        await leakWith((record) => {
            record.pid = Number(child.stdout.trim());
            record.pidStartTime = "gone";
        });
        (world.lock as { token: string | null }).token = null;
        expect(await reacquire()).toBeInstanceOf(LockHeldError);
        expect(world.removes).toBe(1);
    });

    it("forgets the record on a clean release, so a later lock is never mistaken for ours", async () => {
        const journal = new LockJournal(dir);
        await withLockScope(backend(), log, async () => "clean", journal);
        expect(await readdir(dir)).toEqual([]);
    });
});
