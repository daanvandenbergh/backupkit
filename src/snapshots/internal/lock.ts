/**
 * The ONE lock mechanism both snapshot stores share (spec section 6): an
 * atomic `mkdir <root>/.backupkit.lock` followed by meta recording
 * `{ pid, pidStartTime, hostname, createdAt }`. The acquire algorithm is
 * identical for both stores - mkdir, on EEXIST inspect for staleness, steal a
 * stale lock (a COMPARE-and-delete, never a blind one: see `acquire`) and
 * re-attempt exactly once, second EEXIST = live contention (`LockHeldError`) -
 * only the primitives differ (fs vs `runRemote`), injected via `LockBackend`.
 * Release is structural: `withLockScope` releases in `finally`, so leaking a
 * lock is unrepresentable. The lock-acquire mkdir is
 * deliberately never retry-wrapped at ANY layer: EEXIST is its contention
 * signal, so a re-sent mkdir would read this process's own fresh lock as
 * contention. The local backend gets that for free (one `fs.mkdir` call); the
 * remote backend enforces it by passing `NO_RETRY_POLICY` through its runner,
 * because `runRemote`'s transport retry would otherwise re-send the command.
 */

import { readFile } from "node:fs/promises";

import { exec } from "../../exec/exec.js";
import { LockHeldError } from "../../shared/errors.js";
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
async function acquire(backend: LockBackend, log: Logger): Promise<void> {
    const where = backend.displayPath ?? backend.lockPath;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (await backend.tryAcquire()) {
            try {
                await backend.writeMeta();
            } catch (error) {
                await backend.remove().catch(() => undefined);
                throw error;
            }
            return;
        }
        const inspection = await backend.inspect();
        if (!inspection.stale || attempt === 2) {
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
        log.warn(`removed stale lock ${where}`, { detail: inspection.detail });
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
export async function forceUnlock(backend: LockBackend, force: boolean): Promise<UnlockOutcome> {
    if (await backend.tryAcquire()) {
        await backend.writeMeta().catch(() => undefined);
        await backend.remove();
        return { status: "none" };
    }
    const inspection = await backend.inspect();
    if (!inspection.stale && !force) {
        return { status: "held", detail: inspection.detail };
    }
    await backend.remove();
    return { status: "removed", detail: inspection.detail };
}

/**
 * Run `fn` under the destination-root lock: acquire (throwing `LockHeldError`
 * on live contention without running `fn`), then release in `finally` on every
 * path - success, throw, or abort. A release failure after a successful `fn`
 * is rethrown (loud - the next run would otherwise hit the stale/TTL path);
 * after a failed `fn` it is logged at error level so the original error wins.
 */
export async function withLockScope<T>(backend: LockBackend, log: Logger, fn: () => Promise<T>): Promise<T> {
    await acquire(backend, log);
    let fnFailed = false;
    try {
        return await fn();
    } catch (error) {
        fnFailed = true;
        throw error;
    } finally {
        try {
            await backend.remove();
        } catch (releaseError) {
            if (!fnFailed) {
                throw releaseError;
            }
            log.error(`failed to release lock ${backend.displayPath ?? backend.lockPath} after an error`, {
                releaseError: String(releaseError),
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
