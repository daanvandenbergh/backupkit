/**
 * The local (pull-mode) snapshot store: `node:fs/promises` against the archive
 * root - the target's `destination` itself. Completeness is purely name-based; every
 * destructive operation acts only on names matching the single snapshot-name
 * regex or its `.partial`/`.deleting` forms (security invariant 6), promote is
 * one atomic `rename`, delete is two-phase (`.deleting` rename then recursive
 * rm), and the newest complete snapshot is never deletable (invariant 7).
 */

import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { describeError, SnapshotStoreError } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { sanitize } from "../../shared/sanitize.js";
import { isDeletingName, isPartialName, parseSnapshotName } from "../../shared/snapshot-name.js";
import type { SnapshotStore } from "../store.js";
import { newestUndeletable } from "../types.js";
import {
    forceUnlock,
    isPidAlive,
    pidStartTime,
    withLockScope,
    type LockBackend,
    type LockInspection,
    type LockMeta,
    type UnlockOutcome,
} from "./lock.js";

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

/**
 * Staleness TTL for a lock held by ANOTHER host (shared archive): 24 hours,
 * matching the remote store. A foreign holder's pid says nothing here, so time
 * is the only honest signal - the price is that a crashed foreign holder blocks
 * this target for up to a day, which is strictly better than two pipelines
 * writing one archive root.
 */
const FOREIGN_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

/** Throw unless `name` is a valid snapshot name (the codec form). */
function assertSnapshotName(name: string): void {
    if (parseSnapshotName(name) === null) {
        throw new SnapshotStoreError(`invalid snapshot name "${sanitize(name)}"`);
    }
}

/**
 * Whether any entry under `dir` has a link count above 1 - i.e. writing to it
 * would also write to whatever else shares that inode (a `--link-dest`ed
 * snapshot). Depth-first with an early exit on the first hit, so the common
 * "this partial is linked" answer costs a handful of syscalls. Unreadable
 * entries answer true: unknown is not the same as safe.
 *
 * Every stat here is an `lstat` and every type test comes from `readdir`'s own
 * dirent, so nothing inside the tree is ever followed: a symlink is counted as
 * the link (nlink 1), not as whatever it points at, and a symlinked subdirectory
 * is not recursed into. `dir` ITSELF is still followed by this `readdir` - which
 * is exactly why the caller lstats the partial for a symlink BEFORE getting here.
 *
 * ponytail: a full walk in the (rare) all-clear case. Fine - it happens once
 * per run and only when a partial survived. If it ever shows up in a profile,
 * the upgrade path is `find -links +1 -print -quit`.
 */
async function hasMultiplyLinkedEntry(dir: string): Promise<boolean> {
    let children;
    try {
        children = await readdir(dir, { withFileTypes: true });
    } catch {
        return true;
    }
    for (const child of children) {
        const path = join(dir, child.name);
        if (child.isDirectory()) {
            if (await hasMultiplyLinkedEntry(path)) {
                return true;
            }
            continue;
        }
        try {
            if ((await lstat(path)).nlink > 1) {
                return true;
            }
        } catch {
            return true;
        }
    }
    return false;
}

/** Narrow an unknown error to its errno code, or null. */
function errnoCode(error: unknown): string | null {
    return typeof error === "object" && error !== null && typeof (error as NodeJS.ErrnoException).code === "string"
        ? ((error as NodeJS.ErrnoException).code as string)
        : null;
}

/**
 * Identity of one lock-directory instance: inode plus creation time. Two locks
 * created in sequence at the same path (a steal, or a release followed by a
 * fresh acquire) practically never share both, which is what lets a stale-lock
 * steal tell "still the lock I inspected" from "somebody else's live lock".
 */
function lockIdentity(stats: Stats): string {
    return `${stats.ino}:${stats.ctimeMs}`;
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

    /** Identity of the lock instance the last `inspect()` judged, or null when it saw none. */
    private inspected: string | null = null;

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
     * with a matching (or unverifiable) start time is live contention. A lock
     * whose meta names a DIFFERENT host never reaches the pid checks at all -
     * see the foreign-holder branch.
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
            this.inspected = null;
            return stale("lock disappeared");
        }
        this.inspected = lockIdentity(stats);
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
        const holderHost = typeof meta.hostname === "string" ? sanitize(meta.hostname) : null;
        // A pid probe only proves something about the LOCAL process table. On a
        // shared archive (NFS/SMB, or two containers sharing a volume with
        // separate pid namespaces) another host's LIVE pid is very likely dead
        // or recycled here, and declaring its lock stale removes it - after
        // which claimPartial reaps that host's in-flight (or finished-but-
        // unpromoted) snapshot. A foreign holder is therefore judged on time
        // alone, with the same 24 h TTL the remote backend uses.
        if (holderHost !== null && holderHost !== hostname()) {
            const created = Date.parse(typeof meta.createdAt === "string" ? meta.createdAt : "");
            const ageMs = Date.now() - (Number.isNaN(created) ? stats.mtimeMs : created);
            const detail = `held by pid ${meta.pid} on another host (${holderHost})`;
            // Math.abs: a future-dated meta (the holder's clock is wrong) must
            // not make the TTL unreachable and the lock permanent.
            return Math.abs(ageMs) > FOREIGN_LOCK_TTL_MS
                ? stale(`${detail}, past the 24h TTL`)
                : { stale: false, pid: meta.pid, hostname: holderHost, detail };
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

    /**
     * The compare-and-delete half of the stale-lock steal: remove the lock only
     * while it is still the instance the last `inspect()` judged (same inode and
     * same creation time - an unlink+mkdir by another contender always yields a
     * different pair). False means the lock changed or vanished, and `acquire`
     * then abandons the steal rather than deleting a stranger's LIVE lock.
     *
     * ponytail: `node:fs` has no atomic compare-and-delete (no `unlinkat` with
     * an inode predicate), so this is lstat-then-rm - two adjacent syscalls in
     * one tick instead of the full inspect->remove round-trip the blind delete
     * left open. Closing the last sliver needs a different lock primitive
     * (`flock` on a lock file), which is a spec-section-6 change for both stores.
     */
    async removeIfUnchanged(): Promise<boolean> {
        const stats = await lstat(this.lockPath).catch(() => null);
        if (stats === null || this.inspected === null || lockIdentity(stats) !== this.inspected) {
            return false;
        }
        await this.remove();
        return true;
    }
}

/** The local `SnapshotStore` implementation over one archive root directory. */
export class LocalSnapshotStore implements SnapshotStore {
    /** Absolute archive root: the target's `destination`, holding `<snapshot>/` directories directly. */
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
     *
     * A survivor that is a SYMLINK, or that contains ANY multiply-linked entry,
     * is discarded instead of resumed (security invariant 7: a snapshot is
     * immutable once promoted, and a run's destination never leaves the archive).
     * `--link-dest` hardlinks unchanged files into the previous snapshot, so
     * resuming into such a partial lets rsync's attribute-only update path
     * (same size and mtime, different mode or uid) `chmod`/`chown` THROUGH the
     * link and mutate the already-promoted snapshot. Discarding fails safe and
     * is nearly free: a fresh transfer re-links the unchanged files from
     * `--link-dest` locally and only re-sends the delta. A first-ever partial
     * (no previous snapshot, so no links) still resumes - the case where a
     * resume actually saves a large transfer.
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
        const keepPath = join(this.root, keep);
        // lstat, never stat: the survivor becomes THIS run's rsync destination
        // and the transfer argv carries `--delete --force`, so a `<snap>.partial`
        // SYMLINK planted by anyone who can write the archive root aims that
        // delete at the link's target, outside the archive - and `promote` would
        // then rename the link to the snapshot name, so the "snapshot" is a link
        // and the data lives outside the archive entirely. The hardlink guard
        // below cannot catch it: its `readdir` FOLLOWS the link, finds an
        // ordinary tree and waves it through. Discarded rather than fatal,
        // matching the hardlink guard right below it - a fresh transfer is cheap
        // and a hard error here would fail the target every 30 s. (The push side
        // gets this from the jail script's `check_no_symlink_prefix`, invariant
        // 15; the local/pull store had no equivalent.)
        if ((await lstat(keepPath)).isSymbolicLink()) {
            this.log.warn(
                "throwing away an unfinished snapshot that is a symlink instead of a directory - it was not left by backupkit; starting this backup fresh",
                { unfinished: keep },
            );
            // No `recursive`: unlink the link itself, never walk into its target.
            await rm(keepPath, { force: true });
            return { resumed: false };
        }
        if (await hasMultiplyLinkedEntry(keepPath)) {
            this.log.warn(
                "throwing away an unfinished snapshot that shares files with a completed one - resuming it could corrupt that backup; starting this one fresh",
                { unfinished: keep },
            );
            await rm(keepPath, { recursive: true, force: true });
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
     * Refuses non-complete names and the newest complete snapshot - where
     * "newest" means the newest GENUINELY dated one (see `newestUndeletable`),
     * so a future-dated name planted next to real history stays prunable
     * instead of bricking the target forever.
     */
    async remove(name: string): Promise<void> {
        assertSnapshotName(name);
        const complete = await this.listComplete();
        if (!complete.includes(name)) {
            throw new SnapshotStoreError(`${name} is not a complete snapshot`);
        }
        if (newestUndeletable(complete, this.now()) === name) {
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
            throw new SnapshotStoreError(`statfs failed for ${this.root}: ${describeError(error)}`);
        }
    }

    /**
     * Total bytes of the archive filesystem via the same statfs
     * (`blocks * bsize`), or null when statfs cannot answer - the percent
     * `minFree` floor then degrades to 0 and the caller logs it once. Null is
     * "cannot know", never "plenty": `freeBytes` runs a moment later and throws
     * on the same failure, so a genuinely missing filesystem still fails loudly.
     */
    async totalBytes(): Promise<number | null> {
        const stats = await statfs(this.root).catch(() => null);
        return stats === null ? null : stats.blocks * stats.bsize;
    }

    /**
     * Free inodes via the same statfs (`ffree`), or null when the filesystem
     * reports no inode accounting at all (`files === 0`, e.g. APFS/btrfs) - a
     * dynamic-inode filesystem cannot be exhausted this way, so the guard's
     * inode half is skipped rather than fed a meaningless zero.
     */
    async freeInodes(): Promise<number | null> {
        const stats = await statfs(this.root).catch(() => null);
        if (stats === null || stats.files === 0) {
            return null;
        }
        return stats.ffree;
    }

    /** Run `fn` under the store-root lock (structural release; spec section 6). */
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await mkdir(this.root, { recursive: true });
        return withLockScope(new LocalLockBackend(this.root, this.now), this.log, fn);
    }

    /** Clear a leaked lock; a live one is reported and left alone without `force`. */
    async unlock(force: boolean): Promise<UnlockOutcome> {
        await mkdir(this.root, { recursive: true });
        return forceUnlock(new LocalLockBackend(this.root, this.now), force);
    }
}
