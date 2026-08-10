/**
 * The local (pull-mode) snapshot store: `node:fs/promises` against the archive
 * root `<destination>/<targetName>`. Completeness is purely name-based; every
 * destructive operation acts only on names matching the single snapshot-name
 * regex or its `.partial`/`.deleting` forms (security invariant 6), promote is
 * one atomic `rename`, delete is two-phase (`.deleting` rename then recursive
 * rm), and the newest complete snapshot is never deletable (invariant 7).
 */

import { lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { SnapshotStoreError } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { sanitize } from "../../shared/sanitize.js";
import { isDeletingName, isPartialName, parseSnapshotName } from "../../shared/snapshot-name.js";
import type { SnapshotStore } from "../store.js";
import { isPidAlive, pidStartTime, withLockScope, type LockBackend, type LockInspection, type LockMeta } from "./lock.js";

/** Name of the lock directory inside a store root. */
const LOCK_DIR_NAME = ".backupkit.lock";

/**
 * Grace window for a lock directory whose meta is missing or unparseable: a
 * lock younger than this (dir mtime) is assumed held - its creator may simply
 * not have written the meta yet (the mkdir and the meta write are two steps) -
 * so a contender can never steal a freshly won lock. Older than this,
 * unparseable meta = stale (spec section 6).
 */
const META_GRACE_MS = 30_000;

/** Throw unless `name` is a valid snapshot name (the codec form). */
function assertSnapshotName(name: string): void {
    if (parseSnapshotName(name) === null) {
        throw new SnapshotStoreError(`invalid snapshot name "${sanitize(name)}"`);
    }
}

/** Narrow an unknown error to its errno code, or null. */
function errnoCode(error: unknown): string | null {
    return typeof error === "object" && error !== null && typeof (error as NodeJS.ErrnoException).code === "string"
        ? ((error as NodeJS.ErrnoException).code as string)
        : null;
}

/**
 * Local lock primitives: atomic `fs.mkdir` (fails EEXIST on a pre-planted
 * symlink too), a JSON meta file written 0600, and pid-liveness plus
 * pid-start-time staleness (unparseable meta = stale).
 */
class LocalLockBackend implements LockBackend {
    /** Absolute path of the lock directory. */
    readonly lockPath: string;

    /** Clock used for the meta's createdAt. */
    private readonly now: () => Date;

    /** Construct the backend for one store root. */
    constructor(root: string, now: () => Date) {
        this.lockPath = join(root, LOCK_DIR_NAME);
        this.now = now;
    }

    /** Atomically create the lock directory; false on EEXIST. */
    async tryAcquire(): Promise<boolean> {
        try {
            await mkdir(this.lockPath);
            return true;
        } catch (error) {
            if (errnoCode(error) === "EEXIST") {
                return false;
            }
            throw error;
        }
    }

    /** Write the holder meta file (0600) inside the fresh lock directory. */
    async writeMeta(): Promise<void> {
        const meta: LockMeta = {
            pid: process.pid,
            pidStartTime: await pidStartTime(process.pid),
            hostname: hostname(),
            createdAt: this.now().toISOString(),
        };
        await writeFile(join(this.lockPath, "meta"), JSON.stringify(meta), { mode: 0o600 });
    }

    /**
     * Staleness judgement: a non-directory lock path (planted symlink), an
     * unreadable/unparseable meta, a dead pid, or a live pid whose start time
     * mismatches the recorded one (recycled pid) are all stale. A live pid
     * with a matching (or unverifiable) start time is live contention.
     */
    async inspect(): Promise<LockInspection> {
        const stale = (detail: string): LockInspection => ({ stale: true, pid: null, hostname: null, detail });
        // A lock with missing/unparseable meta is stale - unless it is younger
        // than the grace window, in which case its creator may simply not have
        // written the meta yet and the lock is assumed held.
        const unparseable = (mtimeMs: number, detail: string): LockInspection =>
            Date.now() - mtimeMs < META_GRACE_MS
                ? { stale: false, pid: null, hostname: null, detail: `${detail} (young lock, assuming held)` }
                : stale(detail);
        let stats;
        try {
            stats = await lstat(this.lockPath);
        } catch {
            // The lock vanished between mkdir and inspect: the re-attempt settles it.
            return stale("lock disappeared");
        }
        if (!stats.isDirectory()) {
            return stale("lock path is not a directory");
        }
        let meta: LockMeta;
        try {
            meta = JSON.parse(await readFile(join(this.lockPath, "meta"), "utf8")) as LockMeta;
        } catch {
            return unparseable(stats.mtimeMs, "unreadable lock meta");
        }
        if (!Number.isInteger(meta.pid) || meta.pid <= 0) {
            return unparseable(stats.mtimeMs, "unparseable lock meta");
        }
        if (!isPidAlive(meta.pid)) {
            return stale(`holder pid ${meta.pid} is dead`);
        }
        if (typeof meta.pidStartTime !== "string" || meta.pidStartTime === "") {
            return stale("lock meta records no pid start time");
        }
        const live = await pidStartTime(meta.pid);
        if (live !== null && live !== meta.pidStartTime) {
            return stale(`pid ${meta.pid} was recycled`);
        }
        const holderHost = typeof meta.hostname === "string" ? sanitize(meta.hostname) : null;
        return {
            stale: false,
            pid: meta.pid,
            hostname: holderHost,
            detail: `pid ${meta.pid}${holderHost === null ? "" : ` on ${holderHost}`}`,
        };
    }

    /** Remove the lock directory (a planted symlink is unlinked, never followed). */
    async remove(): Promise<void> {
        await rm(this.lockPath, { recursive: true, force: true });
    }
}

/** The local `SnapshotStore` implementation over one archive root directory. */
export class LocalSnapshotStore implements SnapshotStore {
    /** Absolute archive root: `<destination>/<targetName>`. */
    private readonly root: string;

    /** Logger for lock warnings. */
    private readonly log: Logger;

    /** Clock, injectable for tests. */
    private readonly now: () => Date;

    /** Construct a store over one archive root. */
    constructor(root: string, log: Logger, now: () => Date = () => new Date()) {
        this.root = root;
        this.log = log;
        this.now = now;
    }

    /** All entry names in the root, or [] when the root does not exist yet. */
    private async entries(): Promise<string[]> {
        try {
            return await readdir(this.root);
        } catch (error) {
            if (errnoCode(error) === "ENOENT") {
                return [];
            }
            throw error;
        }
    }

    /** Complete snapshot names, lexically ascending. Ignores anything failing the regex. */
    async listComplete(): Promise<string[]> {
        return (await this.entries()).filter((name) => parseSnapshotName(name) !== null).sort();
    }

    /**
     * Sweep every `.deleting` entry (crash artifacts of a two-phase delete),
     * delete all but the newest `.partial`, and rename that survivor to
     * `<newName>.partial` for this run to resume into. Names failing the
     * snapshot regex family are never touched.
     */
    async claimPartial(newName: string): Promise<{ resumed: boolean }> {
        assertSnapshotName(newName);
        await mkdir(this.root, { recursive: true });
        const entries = await this.entries();
        for (const entry of entries.filter(isDeletingName)) {
            await rm(join(this.root, entry), { recursive: true, force: true });
        }
        const partials = entries.filter(isPartialName).sort();
        for (const extra of partials.slice(0, -1)) {
            await rm(join(this.root, extra), { recursive: true, force: true });
        }
        const keep = partials.at(-1);
        if (keep === undefined) {
            return { resumed: false };
        }
        const claimed = `${newName}.partial`;
        if (keep !== claimed) {
            await rename(join(this.root, keep), join(this.root, claimed));
        }
        return { resumed: true };
    }

    /** Atomic rename `<name>.partial` -> `<name>`; the destination must not pre-exist. */
    async promote(name: string): Promise<void> {
        assertSnapshotName(name);
        const final = join(this.root, name);
        try {
            await stat(final);
            throw new SnapshotStoreError(`refusing to promote: complete snapshot ${name} already exists`);
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }
        try {
            await rename(join(this.root, `${name}.partial`), final);
        } catch (error) {
            if (errnoCode(error) === "ENOENT") {
                throw new SnapshotStoreError(`no partial snapshot ${name}.partial to promote`);
            }
            throw error;
        }
    }

    /**
     * Two-phase delete: rename to `<name>.deleting`, then recursive rm (a
     * crash in between leaves an invisible `.deleting` swept next run).
     * Refuses non-complete names and the newest complete snapshot.
     */
    async remove(name: string): Promise<void> {
        assertSnapshotName(name);
        const complete = await this.listComplete();
        if (!complete.includes(name)) {
            throw new SnapshotStoreError(`${name} is not a complete snapshot`);
        }
        if (complete.at(-1) === name) {
            throw new SnapshotStoreError(`refusing to delete the newest complete snapshot ${name}`);
        }
        const deleting = join(this.root, `${name}.deleting`);
        await rename(join(this.root, name), deleting);
        await rm(deleting, { recursive: true, force: true });
    }

    /** Free bytes on the archive filesystem via statfs (bavail * bsize). */
    async freeBytes(): Promise<number> {
        try {
            const stats = await statfs(this.root);
            return stats.bavail * stats.bsize;
        } catch (error) {
            throw new SnapshotStoreError(`statfs failed for ${this.root}: ${sanitize(String(error))}`);
        }
    }

    /** Run `fn` under the store-root lock (structural release; spec section 6). */
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await mkdir(this.root, { recursive: true });
        return withLockScope(new LocalLockBackend(this.root, this.now), this.log, fn);
    }
}
