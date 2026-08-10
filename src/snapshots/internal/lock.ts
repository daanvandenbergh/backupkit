/**
 * The ONE lock mechanism both snapshot stores share (spec section 6): an
 * atomic `mkdir <root>/.backupkit.lock` followed by meta recording
 * `{ pid, pidStartTime, hostname, createdAt }`. The acquire algorithm is
 * identical for both stores - mkdir, on EEXIST inspect for staleness, remove a
 * stale lock and re-attempt exactly once, second EEXIST = live contention
 * (`LockHeldError`) - only the primitives differ (fs vs `runRemote`), injected
 * via `LockBackend`. Release is structural: `withLockScope` releases in
 * `finally`, so leaking a lock is unrepresentable. The lock-acquire mkdir is
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
    /** Absolute path of the lock directory (for messages). */
    readonly lockPath: string;
    /** Atomically create the lock directory. True = created (lock won); false = it already exists. */
    tryAcquire(): Promise<boolean>;
    /** Record the holder meta inside the freshly created lock directory. */
    writeMeta(): Promise<void>;
    /** Judge whether the existing lock is stale and describe its holder. */
    inspect(): Promise<LockInspection>;
    /** Remove the lock directory and everything in it. */
    remove(): Promise<void>;
}

/**
 * Acquire the lock: mkdir, on EEXIST inspect; a stale lock is removed with one
 * warn and the mkdir re-attempted exactly once; a live lock or a second EEXIST
 * throws `LockHeldError` with the recorded holder identity. A failure to write
 * the meta rolls the fresh lock back before rethrowing.
 */
async function acquire(backend: LockBackend, log: Logger): Promise<void> {
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
            throw new LockHeldError(`another backupkit holds ${backend.lockPath}${suffix}`, {
                pid: inspection.pid,
                hostname: inspection.hostname,
            });
        }
        log.warn(`removing stale lock ${backend.lockPath}`, { detail: inspection.detail });
        await backend.remove();
    }
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
            log.error(`failed to release lock ${backend.lockPath} after an error`, {
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
