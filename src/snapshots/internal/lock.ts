/**
 * The ONE lock mechanism both snapshot stores share (spec section 6): an
 * atomic `mkdir <root>/.backupkit.lock` followed by meta recording
 * `{ pid, pidStartTime, hostname, createdAt }`. The acquire algorithm is
 * identical for both stores - mkdir, on EEXIST inspect for staleness, steal a
 * stale lock (a COMPARE-and-delete, never a blind one: see `acquire`) and
 * re-attempt exactly once, second EEXIST = live contention (`LockHeldError`) -
 * only the primitives differ (fs vs `runRemote`), injected via `LockBackend`.
 * Release is structural: `withLockScope` releases in `finally`, so FORGETTING
 * to release is unrepresentable - but the release of a REMOTE lock is itself an
 * ssh command, and a command can fail. That is what the {@link LockJournal}
 * covers: the release is attempted on every path, and when the network denies
 * it, the owner records the lock as its own so its next run retakes it instead
 * of waiting out the 24 h TTL. The lock-acquire mkdir is
 * deliberately never retry-wrapped at ANY layer: EEXIST is its contention
 * signal, so a re-sent mkdir would read this process's own fresh lock as
 * contention. The local backend gets that for free (one `fs.mkdir` call); the
 * remote backend enforces it by passing `NO_RETRY_POLICY` through its runner,
 * because `runRemote`'s transport retry would otherwise re-send the command.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { exec } from "../../exec/exec.js";
import { describeError, LockHeldError, SnapshotStoreError } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";

/** Meta recorded inside the lock directory by the holder. */
export interface LockMeta {
    /** Pid of the holding process. */
    pid: number;
    /** OS-reported start time of that pid (recycled-pid detection), or null when undeterminable. */
    pidStartTime: string | null;
    /** Hostname of the holding machine. */
    hostname: string;
    /** ISO timestamp of lock acquisition. */
    createdAt: string;
}

/** Outcome of inspecting a held lock for staleness. */
export interface LockInspection {
    /** True when the lock is stale (holder dead, meta unparseable, or TTL expired) and may be removed. */
    stale: boolean;
    /** Holder pid from the meta, or null when unreadable (remote locks are always null). */
    pid: number | null;
    /** Holder hostname from the meta, or null when unreadable. */
    hostname: string | null;
    /** Short human-readable description of the holder or the staleness reason. */
    detail: string;
    /**
     * The observed acquisition token - the value that identifies WHICH
     * acquisition this lock is, so its own owner can recognise it again. This
     * is a TRI-STATE and every one of the three means something different:
     *
     * - `string` - the lock was read and carries this token.
     * - `null`   - the lock was read and carries NO token (a holder caught
     *              between winning the lock and recording it).
     * - `undefined` - the lock could NOT be read at all.
     *
     * `undefined` must NEVER be reclaimed (invariant 35: "UNKNOWN is not
     * STALE, and UNKNOWN is not SAFE") - "we could not read the lock" is
     * strictly LESS information than "the lock has no token", so it must not
     * be treated as more conclusive. A refactor that collapses `null |
     * undefined` into one falsy check re-opens that silently, which is why
     * `LockJournal.owns` tests them separately and a test pins it.
     *
     * A backend whose lock already carries a real holder identity (the local
     * store's pid meta) leaves this `undefined` and keeps deciding alone.
     */
    token?: string | null;
}

/**
 * The store-specific lock primitives: how to atomically create the lock
 * directory, record the holder meta, judge staleness, and remove the lock.
 * The local store implements these with node:fs; the remote store with the
 * jailed `mkdir --`/`find`/`rm -rf --` command surface.
 */
export interface LockBackend {
    /** Absolute path of the lock directory, as the backend's own commands address it. */
    readonly lockPath: string;
    /**
     * The token identifying THIS acquisition, set by `tryAcquire()` when it
     * wins, and reported back by `inspect()` as {@link LockInspection.token}
     * when it observes that same lock instance. Undefined until then - and
     * permanently undefined for a backend whose lock records a real holder
     * identity of its own (the local store), which keeps that backend's
     * behaviour untouched: an undefined token matches nothing.
     */
    readonly ownerToken?: string;
    /**
     * How that path is written in messages, when naming the path alone would
     * mislead. The remote backend prefixes its ssh destination, because
     * `another backupkit holds /srv/backups/www/.backupkit.lock` sent an
     * operator to `rm -rf` a path that exists on the ARCHIVE host and not on
     * the machine reading the message. Defaults to `lockPath`.
     */
    readonly displayPath?: string;
    /** Atomically create the lock directory. True = created (lock won); false = it already exists. */
    tryAcquire(): Promise<boolean>;
    /** Record the holder meta inside the freshly created lock directory. */
    writeMeta(): Promise<void>;
    /** Judge whether the existing lock is stale and describe its holder. */
    inspect(): Promise<LockInspection>;
    /** Remove the lock directory and everything in it. */
    remove(): Promise<void>;
    /**
     * Remove the lock ONLY if it is still the exact instance the backend's last
     * `inspect()` judged; false when it changed or vanished (another contender
     * settled it). This is the compare-and-delete the stale-lock steal needs -
     * see `acquire` for the race a blind `remove()` loses. Optional: a backend
     * that cannot compare instances omits it and keeps the blind steal.
     */
    removeIfUnchanged?(): Promise<boolean>;
}

/**
 * One lock this process recorded winning and has not confirmed releasing.
 * Persisted so a daemon that was SIGKILLed while holding a lock can still
 * recognise it after a restart - which is the one case in-process memory
 * cannot cover.
 */
interface LockRecord {
    /** The lock as its own backend addresses it, for forensics. */
    lockPath: string;
    /** The acquisition token (`LockBackend.ownerToken`) we recorded winning. */
    marker: string;
    /** Pid that won it. */
    pid: number;
    /** OS-reported start time of that pid, for recycled-pid detection; null when undeterminable. */
    pidStartTime: string | null;
    /** Host that won it - a record from any OTHER host is never actionable here. */
    hostname: string;
    /** ISO timestamp of acquisition. */
    acquiredAt: string;
}

/** True when `value` has the shape of a {@link LockRecord} read back from disk. */
function isLockRecord(value: unknown): value is LockRecord {
    const r = value as LockRecord;
    return (
        typeof value === "object" &&
        value !== null &&
        typeof r.lockPath === "string" &&
        typeof r.marker === "string" &&
        typeof r.pid === "number" &&
        (r.pidStartTime === null || typeof r.pidStartTime === "string") &&
        typeof r.hostname === "string" &&
        typeof r.acquiredAt === "string"
    );
}

/**
 * What this process did to each lock - the client-side half of the lock's
 * identity, and the whole of `backupkit`'s answer to "is this MY leaked lock?".
 *
 * The observation it rests on: `inspect()` already reads a value that uniquely
 * identifies ONE acquisition, and used to throw it away. Only the process that
 * WON the `mkdir` ever writes a token, so "the token I now see is the token I
 * wrote and never confirmed releasing" is a proof that the lock is mine and
 * orphaned - and it can be retaken at once instead of waiting out the 24 h TTL.
 *
 * Why the identity lives HERE and not on the archive server: a lock's holder is
 * a process, and a process can only be probed from the machine it runs on. The
 * remote command surface cannot record a pid, and if it could, every push
 * client able to write in the lock directory could FORGE one - turning
 * self-recognition into an attacker-controlled input to a decision whose wrong
 * answer is "two pipelines over one archive root". A record in this process's
 * memory (and its own 0700 state dir) cannot be written by anybody else. This
 * is the same asymmetry `LocalLockBackend.inspect` already respects from the
 * other side when it refuses to pid-probe a holder on another host.
 *
 * Two states per lock, and which one an entry is in is STRUCTURAL, not a
 * heuristic: `live: true` is written on acquisition, and it is cleared only in
 * `withLockScope`'s `finally` and in `acquire`'s rollback - both, by
 * construction, outside the critical section. No code path can mark an entry
 * reclaimable while a scope is still running, so a live in-process holder is
 * never reclaimed even if per-target concurrency is ever added.
 *
 * Persistence failures are deliberately swallowed: a journal that cannot write
 * its state dir degrades to memory-only, which is strictly the behaviour that
 * existed before it. A journal that cannot READ fails CLOSED (no reclaim).
 */
export class LockJournal {
    /** Locks this process holds or has orphaned, keyed by the lock's display path. */
    private readonly entries = new Map<string, { marker: string; live: boolean }>();

    /** Directory for the persisted records, or null for a memory-only journal. */
    private readonly dir: string | null;

    /** Construct a journal; pass a directory to survive a restart. */
    constructor(dir: string | null = null) {
        this.dir = dir;
    }

    /** Path of one lock's record file: the key hashed, because it carries `user@host:/path`. */
    private fileFor(key: string): string | null {
        return this.dir === null ? null : join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
    }

    /**
     * Record winning `key` with `marker`. A backend with no token
     * (the local store, whose lock carries a real holder identity already) is
     * not journalled at all.
     */
    async held(key: string, marker: string | undefined): Promise<void> {
        if (marker === undefined) {
            return;
        }
        this.entries.set(key, { marker, live: true });
        const file = this.fileFor(key);
        if (file === null) {
            return;
        }
        const record: LockRecord = {
            lockPath: key,
            marker,
            pid: process.pid,
            pidStartTime: await pidStartTime(process.pid),
            hostname: hostname(),
            acquiredAt: new Date().toISOString(),
        };
        await mkdir(this.dir as string, { recursive: true, mode: 0o700 }).catch(() => undefined);
        // tmp + rename, so a crash mid-write can never leave a half-record that
        // reads as somebody's lock.
        await writeFile(`${file}.tmp`, JSON.stringify(record, null, 4) + "\n", { mode: 0o600 })
            .then(() => rename(`${file}.tmp`, file))
            .catch(() => undefined);
    }

    /** The lock was released cleanly: forget it everywhere. */
    async released(key: string): Promise<void> {
        this.entries.delete(key);
        const file = this.fileFor(key);
        if (file !== null) {
            await rm(file, { force: true }).catch(() => undefined);
        }
    }

    /**
     * The release FAILED: the lock is still out there and it is ours. The
     * persisted record deliberately stays exactly as it is - its presence is
     * what "we never confirmed releasing this" means on disk.
     */
    orphaned(key: string): void {
        const entry = this.entries.get(key);
        if (entry !== undefined) {
            entry.live = false;
        }
    }

    /**
     * Whether the lock now at `key`, presenting `observed`, is one WE left
     * behind and may retake. Every `false` here is a lock left alone.
     *
     * The three refusals that carry the whole safety argument:
     * - `observed === undefined` - the lock could not be read. Never (inv. 35).
     * - a live in-process entry - we are inside that scope right now.
     * - a persisted record from another host, or one whose pid is still alive
     *   with a matching start time - that is somebody's running backup.
     */
    async owns(key: string, observed: string | null | undefined): Promise<boolean> {
        if (observed === undefined) {
            return false;
        }
        const entry = this.entries.get(key);
        if (entry !== undefined) {
            if (entry.live) {
                return false;
            }
            // A markerless lock (`observed === null`) is reclaimable only from
            // MEMORY, and only because this process life provably won the
            // `mkdir` that created it: the sole other way that directory could
            // have gone and come back is `unlock --force` or a shell on the
            // archive host, and neither happens without a human asserting
            // nothing is running. Across a restart that window is unbounded,
            // so a persisted record never reclaims a markerless lock.
            return observed === null || observed === entry.marker;
        }
        const record = await this.read(key);
        if (record === null || observed === null || record.marker !== observed) {
            return false;
        }
        if (record.hostname !== hostname()) {
            // A shared state dir must not let this host probe another host's
            // process table - the exact inversion `LocalLockBackend.inspect`
            // refuses for a foreign holder. Time (the TTL) is the only honest
            // signal about another machine's process, and that path still runs.
            return false;
        }
        if (!isPidAlive(record.pid)) {
            return true;
        }
        // The pid is alive but may have been RECYCLED onto a different process
        // since the record was written. A start time we cannot determine on
        // either side is not evidence of anything, so it refuses.
        const started = await pidStartTime(record.pid);
        return started !== null && record.pidStartTime !== null && started !== record.pidStartTime;
    }

    /** Read one persisted record; anything unreadable or malformed reads as "no record". */
    private async read(key: string): Promise<LockRecord | null> {
        const file = this.fileFor(key);
        if (file === null) {
            return null;
        }
        try {
            const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
            return isLockRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
}

/**
 * The journal every store in THIS process shares by default.
 *
 * Process-global on purpose: the live-holder guard above is only sound if every
 * scope over one lock path consults ONE map, and a per-`Backupkit`-instance
 * journal would be a strictly weaker scope. A caller that wants persistence
 * injects its own via `SnapshotStoreDeps.lockJournal`; tests inject a fresh one
 * and get full isolation with no filesystem at all.
 */
export const processLocks: LockJournal = new LockJournal();

/**
 * Acquire the lock: mkdir, on EEXIST inspect; a stale lock is removed with one
 * warn and the mkdir re-attempted exactly once; a live lock or a second EEXIST
 * throws `LockHeldError` with the recorded holder identity. A failure to write
 * the meta rolls the fresh lock back before rethrowing.
 *
 * The steal is a compare-and-delete, not a blind delete, and that is
 * load-bearing: `remove()` deletes whatever sits at the lock path NOW, which is
 * not necessarily the instance `inspect()` judged one round-trip ago. With a
 * blind delete, two contenders over ONE pre-existing stale lock both ended up
 * holding it - A removed the stale lock, acquired, wrote its meta and entered
 * the critical section; B, one round-trip behind and still holding its own
 * stale observation, removed A's LIVE lock and acquired too (measured over a
 * fake jail runner with realistic per-command latency: at a 200 ms stagger both
 * were inside at once, and a two-round-trip stagger is the ordinary case for two
 * processes contending over ssh). The damage was silent: B's `claimPartial`
 * renamed A's in-flight `<snapA>.partial` away, A kept writing into a recreated
 * one holding only the post-rename remainder, promoted that truncated tree and
 * reported success - and both releases then deleted an already-gone lock with
 * `force`, so nothing was logged.
 *
 * Residual, stated precisely: neither `node:fs` nor the jailed `rm -rf` surface
 * offers a true atomic compare-and-delete, so `removeIfUnchanged` compares the
 * lock's identity and then deletes. The local backend closes the window to two
 * adjacent syscalls in one tick (it compares the lock directory's inode); a
 * backend WITHOUT `removeIfUnchanged` - the remote store today - still does the
 * blind delete and keeps the full round-trip window. Closing that needs
 * `RemoteLockBackend` to implement `removeIfUnchanged` (a second `find` of the
 * lock, comparing the marker it last inspected).
 */
async function acquire(backend: LockBackend, log: Logger, journal: LockJournal): Promise<void> {
    const where = backend.displayPath ?? backend.lockPath;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (await backend.tryAcquire()) {
            // Recorded BEFORE the meta write, because the meta write is the
            // round-trip that can be lost: a lock we won and could not mark is
            // still a lock we won, and this record is what lets us say so.
            await journal.held(where, backend.ownerToken);
            try {
                await backend.writeMeta();
            } catch (error) {
                // The rollback used to swallow its own failure, which left a
                // markerless lock that NEVER expires - the worse half of the
                // 24 h trap. It is now recorded as ours instead, so the next
                // attempt of this process retakes it.
                await backend.remove().then(
                    () => journal.released(where),
                    () => journal.orphaned(where),
                );
                throw error;
            }
            return;
        }
        const inspection = await backend.inspect();
        // One extra bit into the EXISTING staleness decision - deliberately not
        // a second steal path, so the compare-and-delete, the exactly-one
        // re-attempt bound and the warn all stay exactly where they are.
        const mine = await journal.owns(where, inspection.token);
        if ((!inspection.stale && !mine) || attempt === 2) {
            const suffix = inspection.detail === "" ? "" : ` (${inspection.detail})`;
            throw new LockHeldError(`another backupkit holds ${where}${suffix}`, {
                pid: inspection.pid,
                hostname: inspection.hostname,
            });
        }
        const stolen =
            backend.removeIfUnchanged === undefined
                ? await backend.remove().then(() => true)
                : await backend.removeIfUnchanged();
        if (!stolen) {
            // The lock changed under us: another contender already took this
            // stale lock over, so what sits there now is somebody else's LIVE
            // lock. Losing the steal is a skip, never a delete - the scheduler
            // treats `lock-held` as "try again next tick".
            throw new LockHeldError(
                `another backupkit took over the stale lock ${where} while it was being inspected`,
                { pid: null, hostname: null },
            );
        }
        log.warn(
            mine
                ? `reclaimed this backupkit's own lock at ${where} - the run that held it could not release it`
                : `removed the stale lock at ${where}`,
            { detail: inspection.detail },
        );
    }
}

/** What `forceUnlock` did to the lock. */
export type UnlockOutcome =
    /** Nothing was holding the lock. */
    | { status: "none" }
    /** A lock was there and is gone now; `detail` describes what it was. */
    | { status: "removed"; detail: string }
    /** A LIVE lock was there and was left alone (no `force`); `detail` describes its holder. */
    | { status: "held"; detail: string };

/**
 * Clear the lock by hand - the operator escape hatch behind `backupkit unlock`.
 *
 * A leaked lock is not hypothetical: a remote lock has no pid to probe, so a
 * holder killed between `mkdir` and its `finally` blocks the target until the
 * 24 h TTL expires, and a MARKERLESS one (killed inside the acquire window)
 * blocks it forever. Without this verb the only cure was an ssh session and an
 * `rm -rf` typed against a live archive root - by hand, as root, next to real
 * snapshots. This does the same thing with the store's own primitives, and
 * refuses by default in exactly the case a human cannot check for himself.
 *
 * Existence is probed by ACQUIRING, not by reading: `tryAcquire` is the only
 * primitive both backends can answer honestly (the jail's `find` cannot tell
 * "no lock" from "unreadable lock", and guessing wrong there means deleting a
 * live holder's lock). Winning it proves nothing held it - and holding it for
 * the removal is exactly right, since no contender can slip in between. The
 * meta is written first for the same reason `acquire` writes it: a crash in
 * this window would otherwise leave the markerless lock that never expires.
 *
 * A live lock is left alone unless `force`, because "held" here means a real
 * pipeline may be writing into this archive root right now, and two pipelines
 * over one root is the single thing the lock exists to prevent. A stale one is
 * removed without ceremony - that is what an ordinary `acquire` would do.
 */
export async function forceUnlock(
    backend: LockBackend,
    force: boolean,
    journal: LockJournal = processLocks,
): Promise<UnlockOutcome> {
    const where = backend.displayPath ?? backend.lockPath;
    if (await backend.tryAcquire()) {
        await journal.held(where, backend.ownerToken);
        await backend.writeMeta().catch(() => undefined);
        // This probe CREATED a lock. If the removal now fails, `unlock` has
        // made the situation worse than it found it - so say exactly that,
        // rather than reporting a bare remote failure the operator would read
        // as "nothing happened".
        try {
            await backend.remove();
        } catch (error) {
            journal.orphaned(where);
            throw new SnapshotStoreError(
                `nothing was holding ${where}, but probing it left a NEW lock that could not be removed: ` +
                    `${describeError(error)}. Fix: run \`backupkit unlock --force\` once the destination is reachable`,
            );
        }
        await journal.released(where);
        return { status: "none" };
    }
    const inspection = await backend.inspect();
    if (!inspection.stale && !force) {
        return { status: "held", detail: inspection.detail };
    }
    await backend.remove();
    await journal.released(where);
    return { status: "removed", detail: inspection.detail };
}

/**
 * Run `fn` under the destination-root lock: acquire (throwing `LockHeldError`
 * on live contention without running `fn`), then release in `finally` on every
 * path - success, throw, or abort.
 *
 * A release failure is logged at error level and NEVER rethrown. It used to be
 * rethrown after a successful `fn`, on the reasoning that the next run would
 * otherwise hit the stale/TTL path - which turned a promoted snapshot with
 * completed retention into a `failed` report that fed the backoff, for a
 * backup that had in fact succeeded. Two things changed that: the release is
 * now recorded in the {@link LockJournal}, so the next run of this process
 * retakes the lock instead of waiting out the TTL, and the release itself runs
 * detached from the shutdown signal, so the common cause of the failure is
 * gone. What is left is an honest error line about a lock, not a lie about a
 * backup.
 */
export async function withLockScope<T>(
    backend: LockBackend,
    log: Logger,
    fn: () => Promise<T>,
    journal: LockJournal = processLocks,
): Promise<T> {
    const where = backend.displayPath ?? backend.lockPath;
    await acquire(backend, log, journal);
    try {
        return await fn();
    } finally {
        let releaseError: unknown = null;
        try {
            await backend.remove();
        } catch (error) {
            releaseError = error;
        }
        if (releaseError === null) {
            await journal.released(where);
        } else {
            journal.orphaned(where);
            log.error(`could not release the lock ${where} - this backupkit will retake it on its next run`, {
                error: describeError(releaseError),
                fix: "nothing, unless this process is about to exit - then `backupkit unlock` clears it",
            });
        }
    }
}

/**
 * The OS-reported start time of a local pid, used to detect a recycled pid:
 * Linux reads field 22 of `/proc/<pid>/stat` (parsed after the last ")" so a
 * hostile comm name cannot shift fields); everywhere else `ps -p <pid> -o
 * lstart=` is compared verbatim. Returns null when undeterminable.
 */
export async function pidStartTime(pid: number): Promise<string | null> {
    if (process.platform === "linux") {
        try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            const close = stat.lastIndexOf(")");
            const fields = stat
                .slice(close + 1)
                .trim()
                .split(/\s+/);
            // Field 1 is the pid and field 2 the comm; fields[0] is field 3, so field 22 is fields[19].
            return fields[19] ?? null;
        } catch {
            return null;
        }
    }
    try {
        const result = await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeoutMs: 5000 });
        const out = result.stdout.trim();
        return result.exitCode === 0 && out !== "" ? out : null;
    } catch {
        return null;
    }
}

/**
 * Whether a local pid is alive: signal 0 probe; ESRCH = dead, EPERM = alive
 * but owned by another user, anything else = alive.
 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}
