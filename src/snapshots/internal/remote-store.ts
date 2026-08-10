/**
 * The remote (push-mode) snapshot store: every operation is one jailed remote
 * command through `runRemote` (which quotes every argv element and wraps the
 * control-path transient retry). Listing is `find -maxdepth 1 -mindepth 1
 * -print0` parsed NUL-delimited; `--` precedes every path operand; free space
 * is `df -Pk --` with shape-validated output; and only names matching the
 * snapshot regex family are ever acted upon - a hostile remote listing can
 * never steer a destructive command (security invariants 2, 6, 9).
 */

import { posix } from "node:path";

import type { ExecResult } from "../../exec/exec.js";
import { SnapshotStoreError } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { sanitize } from "../../shared/sanitize.js";
import { NO_RETRY_POLICY, type RetryPolicy } from "../../shared/retry.js";
import { formatSnapshotName, isDeletingName, isPartialName, parseSnapshotName } from "../../shared/snapshot-name.js";
import type { SnapshotStore } from "../store.js";
import { withLockScope, type LockBackend, type LockInspection } from "./lock.js";

/** Name of the lock directory inside a store root. */
const LOCK_DIR_NAME = ".backupkit.lock";

/** Remote lock staleness TTL: 24 hours (spec section 6). */
const LOCK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The seam to `runRemote`: one remote command argv in, its `ExecResult` out.
 * `openStore` binds the real `runRemote` (remote, ssh options, control retry);
 * tests inject a recorder.
 *
 * `options.retryPolicy` overrides the transport retry for ONE call. Every
 * mutating command below passes {@link NO_RETRY_POLICY} through it - see that
 * constant for why re-sending a mutation is unsafe.
 */
export type RemoteRunner = (
    argv: readonly string[],
    options?: { retryPolicy?: RetryPolicy },
) => Promise<ExecResult>;

/** Per-call runner options that disable the transport retry (non-idempotent commands). */
const NO_RETRY = { retryPolicy: NO_RETRY_POLICY } as const;

/** Throw unless `name` is a valid snapshot name (the codec form). */
function assertSnapshotName(name: string): void {
    if (parseSnapshotName(name) === null) {
        throw new SnapshotStoreError(`invalid snapshot name "${sanitize(name)}"`);
    }
}

/**
 * Remote lock primitives over the jailed command surface: plain `mkdir --`
 * (its non-zero exit is the EEXIST contention signal - issued with
 * {@link NO_RETRY_POLICY} so `runRemote`'s transport retry can never re-send a
 * mkdir that already succeeded on the remote), a timestamp-named
 * marker directory inside the lock (`mkdir -p -- <lock>/<snapshotName>`, the
 * only meta a mkdir/find-only surface can record), `find` to read it back,
 * and a 24 h TTL staleness predicate.
 */
class RemoteLockBackend implements LockBackend {
    /** Absolute remote path of the lock directory. */
    readonly lockPath: string;

    /** The remote command seam. */
    private readonly runner: RemoteRunner;

    /** Clock for the TTL comparison and the marker name. */
    private readonly now: () => Date;

    /** Construct the backend for one remote store root. */
    constructor(root: string, runner: RemoteRunner, now: () => Date) {
        this.lockPath = posix.join(root, LOCK_DIR_NAME);
        this.runner = runner;
        this.now = now;
    }

    /**
     * Plain (non `-p`) `mkdir -- <lock>`: exit 0 = created, anything else =
     * exists. Never transport-retried: a blip AFTER the remote mkdir succeeded
     * would re-send it, the second attempt would see EEXIST against this
     * process's own fresh lock, and the resulting markerless lock is held
     * forever (see `inspect`). One attempt; the next scheduler tick retries.
     */
    async tryAcquire(): Promise<boolean> {
        const result = await this.runner(["mkdir", "--", this.lockPath], NO_RETRY);
        return result.exitCode === 0;
    }

    /** Record the acquisition time as a snapshot-named marker directory inside the lock. */
    async writeMeta(): Promise<void> {
        const marker = posix.join(this.lockPath, formatSnapshotName(this.now()));
        const result = await this.runner(["mkdir", "-p", "--", marker]);
        if (result.exitCode !== 0) {
            throw new SnapshotStoreError(
                `remote lock meta write failed (exit ${result.exitCode ?? "signal"}): ${sanitize(result.stderr).slice(-500)}`,
            );
        }
    }

    /**
     * TTL staleness: list the lock directory and parse its snapshot-named
     * marker; older than 24 h means stale, an unlistable lock means stale. A
     * lock with NO parseable marker is treated as held, NOT stale: acquisition
     * is two round-trips (mkdir the lock, then mkdir the marker), so a
     * markerless lock is almost always one a contender caught mid-acquire, and
     * stealing it would run two pipelines against the same archive root
     * concurrently. This is the remote analogue of the local backend's
     * META_GRACE_MS window, but unbounded: the jail's `find` surface cannot
     * read the lock dir's mtime, so there is no time signal for a markerless
     * lock. ponytail: the price is that a holder that crashed in the tiny
     * mkdir->marker window leaves a lock only an operator `rm -rf` can clear;
     * every marker-present lock still auto-recovers via the 24 h TTL. Holder
     * pid/hostname are unknowable through this command surface and stay null.
     */
    async inspect(): Promise<LockInspection> {
        const stale = (detail: string): LockInspection => ({ stale: true, pid: null, hostname: null, detail });
        const result = await this.runner(["find", this.lockPath, "-maxdepth", "1", "-mindepth", "1", "-print0"]);
        if (result.exitCode !== 0) {
            return stale("lock meta unreadable");
        }
        for (const entry of result.stdout.split("\0")) {
            if (entry === "") {
                continue;
            }
            const name = entry.slice(entry.lastIndexOf("/") + 1);
            const created = parseSnapshotName(name);
            if (created === null) {
                continue;
            }
            const ageMs = this.now().getTime() - created.getTime();
            if (ageMs > LOCK_TTL_MS) {
                return stale(`created ${name}, past the 24h TTL`);
            }
            return { stale: false, pid: null, hostname: null, detail: `created ${name}` };
        }
        return { stale: false, pid: null, hostname: null, detail: "no creation marker yet (assuming freshly acquired)" };
    }

    /** Remove the lock directory. */
    async remove(): Promise<void> {
        const result = await this.runner(["rm", "-rf", "--", this.lockPath]);
        if (result.exitCode !== 0) {
            throw new SnapshotStoreError(
                `remote lock release failed (exit ${result.exitCode ?? "signal"}): ${sanitize(result.stderr).slice(-500)}`,
            );
        }
    }
}

/** The remote `SnapshotStore` implementation over one jailed archive root. */
export class RemoteSnapshotStore implements SnapshotStore {
    /** Absolute remote archive root: `<destination>/<targetName>` (POSIX). */
    private readonly root: string;

    /** The remote command seam (the real one runs through `runRemote`). */
    private readonly runner: RemoteRunner;

    /** Logger for lock warnings. */
    private readonly log: Logger;

    /** Clock, injectable for tests. */
    private readonly now: () => Date;

    /** Whether `mkdir -p -- <root>` has succeeded this process (idempotent, so a lost race just re-runs it). */
    private rootEnsured = false;

    /** Construct a store over one remote archive root. */
    constructor(root: string, runner: RemoteRunner, log: Logger, now: () => Date = () => new Date()) {
        this.root = root;
        this.runner = runner;
        this.log = log;
        this.now = now;
    }

    /**
     * Run one remote command and throw `SnapshotStoreError` on a non-zero exit.
     * `options` forwards a per-call retry override; every rename below passes
     * {@link NO_RETRY_POLICY} so a transport blip cannot re-send a `mv` that
     * already renamed on the remote.
     */
    private async run(
        argv: readonly string[],
        what: string,
        options?: { retryPolicy?: RetryPolicy },
    ): Promise<ExecResult> {
        const result = await this.runner(argv, options);
        if (result.exitCode !== 0) {
            const tail = sanitize(result.stderr).slice(-500);
            throw new SnapshotStoreError(
                `remote ${what} failed (exit ${result.exitCode ?? "signal"})${tail === "" ? "" : `: ${tail}`}`,
            );
        }
        return result;
    }

    /** Ensure the archive root exists (`mkdir -p --`, once per instance). */
    private async ensureRoot(): Promise<void> {
        if (this.rootEnsured) {
            return;
        }
        await this.run(["mkdir", "-p", "--", this.root], "archive root creation");
        this.rootEnsured = true;
    }

    /**
     * All entry basenames in the root via `find -maxdepth 1 -mindepth 1
     * -print0`, parsed NUL-delimited. Remote-derived and untrusted: callers
     * act only on names that pass the snapshot regex family.
     */
    private async listEntries(): Promise<string[]> {
        await this.ensureRoot();
        const result = await this.run(["find", this.root, "-maxdepth", "1", "-mindepth", "1", "-print0"], "listing");
        const names: string[] = [];
        for (const entry of result.stdout.split("\0")) {
            if (entry === "") {
                continue;
            }
            names.push(entry.slice(entry.lastIndexOf("/") + 1));
        }
        return names;
    }

    /** Complete snapshot names, lexically ascending. Ignores anything failing the regex. */
    async listComplete(): Promise<string[]> {
        return (await this.listEntries()).filter((name) => parseSnapshotName(name) !== null).sort();
    }

    /**
     * Sweep every `.deleting` entry, delete all but the newest `.partial`, and
     * rename that survivor to `<newName>.partial` (`mv --`, pure rename) for
     * this run to resume into. Names failing the snapshot regex family are
     * ignored and never deleted.
     */
    async claimPartial(newName: string): Promise<{ resumed: boolean }> {
        assertSnapshotName(newName);
        const entries = await this.listEntries();
        for (const entry of entries.filter(isDeletingName)) {
            await this.run(["rm", "-rf", "--", posix.join(this.root, entry)], "deleting-entry sweep");
        }
        const partials = entries.filter(isPartialName).sort();
        for (const extra of partials.slice(0, -1)) {
            await this.run(["rm", "-rf", "--", posix.join(this.root, extra)], "stray-partial cleanup");
        }
        const keep = partials.at(-1);
        if (keep === undefined) {
            return { resumed: false };
        }
        const claimed = `${newName}.partial`;
        if (keep !== claimed) {
            await this.run(
                ["mv", "--", posix.join(this.root, keep), posix.join(this.root, claimed)],
                "partial claim",
                NO_RETRY,
            );
        }
        return { resumed: true };
    }

    /** Atomic `mv -- <name>.partial <name>` (pure rename); the destination must not pre-exist. */
    async promote(name: string): Promise<void> {
        assertSnapshotName(name);
        const entries = await this.listEntries();
        if (entries.includes(name)) {
            throw new SnapshotStoreError(`refusing to promote: complete snapshot ${name} already exists`);
        }
        if (!entries.includes(`${name}.partial`)) {
            throw new SnapshotStoreError(`no partial snapshot ${name}.partial to promote`);
        }
        await this.run(
            ["mv", "--", posix.join(this.root, `${name}.partial`), posix.join(this.root, name)],
            "promote",
            NO_RETRY,
        );
    }

    /**
     * Two-phase delete: `mv --` to `<name>.deleting`, then `rm -rf --`.
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
        const deleting = posix.join(this.root, `${name}.deleting`);
        await this.run(["mv", "--", posix.join(this.root, name), deleting], "delete phase 1 (rename)", NO_RETRY);
        await this.run(["rm", "-rf", "--", deleting], "delete phase 2 (recursive rm)");
    }

    /**
     * Free bytes on the remote archive filesystem via `df -Pk --`: the last
     * output line's "Available" column (the all-digits token before the
     * percent token), shape-validated - garbage output is refused, never
     * guessed at (security invariant 9).
     */
    async freeBytes(): Promise<number> {
        await this.ensureRoot();
        const result = await this.run(["df", "-Pk", "--", this.root], "free-space query");
        const lines = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");
        const malformed = new SnapshotStoreError(
            `unexpected df output from remote for ${this.root}: ${sanitize(result.stdout).slice(0, 200)}`,
        );
        if (lines.length < 2) {
            throw malformed;
        }
        const tokens = lines[lines.length - 1].split(/\s+/);
        const pctIndex = tokens.findIndex((token) => /^[0-9]+%$/.test(token));
        if (pctIndex < 4) {
            throw malformed;
        }
        const available = tokens[pctIndex - 1];
        if (!/^[0-9]+$/.test(available)) {
            throw malformed;
        }
        return Number(available) * 1024;
    }

    /** Run `fn` under the store-root lock (structural release; spec section 6). */
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureRoot();
        return withLockScope(new RemoteLockBackend(this.root, this.runner, this.now), this.log, fn);
    }
}
