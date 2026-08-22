/**
 * The remote (push-mode) snapshot store: every operation is one jailed remote
 * command through `runRemote` (which quotes every argv element and wraps the
 * control-path transient retry). Listing is `find -print0` when the key is
 * jailed and `ls -A --` when it is not (see {@link listArgv}); `--` precedes
 * every path operand; free space
 * is `df -Pk --` with shape-validated output; and only names matching the
 * snapshot regex family are ever acted upon - a hostile remote listing can
 * never steer a destructive command (security invariants 2, 6, 9).
 */

import { posix } from "node:path";

import type { ExecResult } from "../../exec/exec.js";
import { SnapshotStoreError } from "../../shared/errors.js";
import { describeRemoteStderr } from "../../ssh/classify.js";
import { formatUtc } from "../../shared/format.js";
import type { Logger } from "../../shared/logger.js";
import { sanitize } from "../../shared/sanitize.js";
import { NO_RETRY_POLICY, type RetryPolicy } from "../../shared/retry.js";
import { formatSnapshotName, isDeletingName, isPartialName, parseSnapshotName } from "../../shared/snapshot-name.js";
import type { SnapshotStore } from "../store.js";
import { newestUndeletable } from "../types.js";
import { forceUnlock, withLockScope, type LockBackend, type LockInspection, type UnlockOutcome } from "./lock.js";

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

/**
 * Argv that lists one directory level on the remote.
 *
 * Jailed remotes get the jail's only listing verb, `find -maxdepth 1 -mindepth
 * 1 -print0`. Unjailed remotes get `ls -A --`, because the whole point of
 * `"jail": false` is the restricted appliance account where a forced command
 * cannot be installed - and those shells do not ship `find` (a Hetzner Storage
 * Box offers ls/mkdir/mv/rm/df/rsync and nothing else). `ls` exists everywhere
 * `find` does, so the unjailed path needs no capability probe.
 */
function listArgv(path: string, jailed: boolean): readonly string[] {
    return jailed ? ["find", path, "-maxdepth", "1", "-mindepth", "1", "-print0"] : ["ls", "-A", "--", path];
}

/**
 * Entry basenames from a {@link listArgv} listing: `find` prints NUL-separated
 * absolute paths, `ls` newline-separated basenames (ssh gives it no tty, so
 * coreutils emits names unquoted).
 *
 * ponytail: a newline INSIDE a remote filename splits into fragments under
 * `ls`, where `-print0` is exact. That is safe rather than merely tolerable -
 * every caller acts only on names that pass the snapshot regex family and then
 * re-joins them onto the store root, so a fragment can at worst name a path
 * that does not exist (a failed run), never steer a command at a different one.
 * The exact listing stays available: keep the jail.
 */
function parseListing(stdout: string, jailed: boolean): string[] {
    const names: string[] = [];
    for (const entry of stdout.split(jailed ? "\0" : "\n")) {
        if (entry === "") {
            continue;
        }
        names.push(entry.slice(entry.lastIndexOf("/") + 1));
    }
    return names;
}

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

    /**
     * The same path as an operator has to read it: `<user@host>:<path>`. The
     * lock lives on the ARCHIVE host, and a bare absolute path in a message
     * reads as a local one - it sent an operator to `rm -rf` a path his own
     * machine does not even have while the real lock sat untouched.
     */
    readonly displayPath: string;

    /** The remote command seam. */
    private readonly runner: RemoteRunner;

    /** Clock for the TTL comparison and the marker name. */
    private readonly now: () => Date;

    /** Whether the remote key is jailed, which decides the listing verb (see {@link listArgv}). */
    private readonly jailed: boolean;

    /** Construct the backend for one remote store root. */
    constructor(root: string, runner: RemoteRunner, now: () => Date, jailed: boolean, sshDestination: string) {
        this.lockPath = posix.join(root, LOCK_DIR_NAME);
        this.displayPath = sshDestination === "" ? this.lockPath : `${sshDestination}:${this.lockPath}`;
        this.runner = runner;
        this.now = now;
        this.jailed = jailed;
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
            throw new SnapshotStoreError(remoteFailure("lock meta write", result.exitCode, result.stderr));
        }
    }

    /**
     * TTL staleness: list the lock directory and parse its snapshot-named
     * marker; more than 24 h from now in EITHER direction means stale. A lock
     * that cannot be READ AT ALL (the `find` exits non-zero - a permission
     * change, a transport failure, an FS error) is treated as held: "we could
     * not read the lock" is strictly LESS information than "the lock has no
     * marker", so it must not be treated as more conclusive. Judging it stale
     * deleted a LIVE holder's lock and ran two pipelines against one archive
     * root, which is the single thing this lock exists to prevent. A
     * lock with NO parseable marker is treated as held, NOT stale: acquisition
     * is two round-trips (mkdir the lock, then mkdir the marker), so a
     * markerless lock is almost always one a contender caught mid-acquire, and
     * stealing it would run two pipelines against the same archive root
     * concurrently. This is the remote analogue of the local backend's
     * META_GRACE_MS window, but unbounded: the jail's `find` surface cannot
     * read the lock dir's mtime, so there is no time signal for a markerless
     * lock. ponytail: the price is that a holder that crashed in the tiny
     * mkdir->marker window - or one whose lock became unreadable - leaves a lock
     * only an operator `rm -rf` can clear; every marker-present, readable lock
     * still auto-recovers via the 24 h TTL. Holder
     * pid/hostname are unknowable through this command surface and stay null.
     */
    async inspect(): Promise<LockInspection> {
        const stale = (detail: string): LockInspection => ({ stale: true, pid: null, hostname: null, detail });
        const result = await this.runner(listArgv(this.lockPath, this.jailed));
        if (result.exitCode !== 0) {
            return { stale: false, pid: null, hostname: null, detail: "lock unreadable (assuming held)" };
        }
        for (const name of parseListing(result.stdout, this.jailed)) {
            const created = parseSnapshotName(name);
            if (created === null) {
                continue;
            }
            // Math.abs, not a bare age: a marker dated in the FUTURE yields a
            // negative age, which no `> TTL` test can ever satisfy - the lock
            // would be reported held forever. A jailed writer can plant exactly
            // that with one `mkdir -p -- <lock>/2099-01-01T000000Z`, and so can
            // an honest holder whose clock is wrong when it is SIGKILLed. A
            // marker the client's clock could not have written is stale.
            const ageMs = this.now().getTime() - created.getTime();
            if (Math.abs(ageMs) > LOCK_TTL_MS) {
                return stale(`created ${formatUtc(created)}, past the 24h TTL`);
            }
            return { stale: false, pid: null, hostname: null, detail: `created ${formatUtc(created)}` };
        }
        return { stale: false, pid: null, hostname: null, detail: "no creation marker yet (assuming freshly acquired)" };
    }

    /** Remove the lock directory. */
    async remove(): Promise<void> {
        const result = await this.runner(["rm", "-rf", "--", this.lockPath]);
        if (result.exitCode !== 0) {
            throw new SnapshotStoreError(remoteFailure("lock release", result.exitCode, result.stderr));
        }
    }
}

/**
 * One remote command's failure, worded for a person: the exit code, the plain
 * reading of what the far side said, and the raw tail as evidence.
 *
 * Every one of these used to be `remote <what> failed (exit 1): <tail>`, so a
 * jail refusal, a full disk and a wrong path all arrived as an exit code and a
 * fragment of shell output. The reading comes from `ssh/classify.ts`, which
 * owns every stderr needle in this codebase.
 */
function remoteFailure(what: string, exitCode: number | null, stderr: string): string {
    const tail = sanitize(stderr).slice(-500);
    const meaning = describeRemoteStderr(tail);
    const because = meaning === null ? "" : ` - ${meaning}`;
    const said = tail === "" ? "" : ` [the server said: ${tail}]`;
    return `remote ${what} failed (exit ${exitCode ?? "signal"})${because}${said}`;
}

/** The remote `SnapshotStore` implementation over one jailed archive root. */
export class RemoteSnapshotStore implements SnapshotStore {
    /** Absolute remote archive root: the target's `destination` (POSIX), holding `<snapshot>/` directories directly. */
    private readonly root: string;

    /** The remote command seam (the real one runs through `runRemote`). */
    private readonly runner: RemoteRunner;

    /** Logger for lock warnings. */
    private readonly log: Logger;

    /** Clock, injectable for tests. */
    private readonly now: () => Date;

    /** Whether the push key is jailed - decides the listing verb (see {@link listArgv}). */
    private readonly jailed: boolean;

    /** ssh destination of the archive host, prefixed onto lock paths in messages (`""` = no prefix). */
    private readonly sshDestination: string;

    /** Whether `mkdir -p -- <root>` has succeeded this process (idempotent, so a lost race just re-runs it). */
    private rootEnsured = false;

    /** Construct a store over one remote archive root. */
    constructor(
        root: string,
        runner: RemoteRunner,
        log: Logger,
        now: () => Date = () => new Date(),
        jailed = true,
        sshDestination = "",
    ) {
        this.root = root;
        this.runner = runner;
        this.log = log;
        this.now = now;
        this.jailed = jailed;
        this.sshDestination = sshDestination;
    }

    /**
     * Run one remote command and throw `SnapshotStoreError` on a non-zero exit
     * OR on truncated output. `options` forwards a per-call retry override;
     * every rename below passes {@link NO_RETRY_POLICY} so a transport blip
     * cannot re-send a `mv` that already renamed on the remote.
     *
     * Why truncation is fatal here: `exec` caps captured stdout at 1 MiB and
     * keeps the HEAD (invariant 28), so an over-cap `find` listing comes back as
     * a SHORT, entirely plausible list whose newest name is months stale - and
     * nothing downstream can tell. That silently breaks the schedule (window
     * dedup compares against a stale name), points `--link-dest` at an ancient
     * base, and makes `newestUndeletable` protect the wrong snapshot, so the
     * genuinely-newest ones fall outside the deletion floor. A cut landing on a
     * `.partial` boundary is worse still: the tail is re-read as a complete
     * snapshot that does not exist. A push client drives the root over the cap
     * with jail-legal `mkdir` commands, so this must fail loudly. One check at
     * the chokepoint covers every store command (listing, promote verification,
     * `df`); a refused command costs one run, a wrong listing costs snapshots.
     */
    private async run(
        argv: readonly string[],
        what: string,
        options?: { retryPolicy?: RetryPolicy },
    ): Promise<ExecResult> {
        const result = await this.runner(argv, options);
        if (result.exitCode !== 0) {
            throw new SnapshotStoreError(remoteFailure(what, result.exitCode, result.stderr));
        }
        if (result.truncated) {
            throw new SnapshotStoreError(
                `remote ${what} output was truncated at the capture cap - refusing to act on a partial result for ${this.root}; ` +
                    "reduce the number of entries in the archive root (a snapshot count this high is not normal - check for planted directories)",
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
     * All entry basenames in the root ({@link listArgv} / {@link parseListing}).
     * Remote-derived and untrusted: callers act only on names that pass the
     * snapshot regex family.
     */
    private async listEntries(): Promise<string[]> {
        await this.ensureRoot();
        const result = await this.run(listArgv(this.root, this.jailed), "listing");
        return parseListing(result.stdout, this.jailed);
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

    /**
     * `mv -- <name>.partial <name>` (pure rename), then a post-check that the
     * rename REPLACED rather than NESTED.
     *
     * Unlike `fs.rename` (which fails ENOTEMPTY), POSIX `mv A B` with B an
     * existing directory moves A INSIDE B: if `<name>` appears between the
     * listing above and the `mv`, the finished snapshot silently lands at
     * `<name>/<name>.partial`, `mv` exits 0 and the pipeline reports success on
     * an archive that no longer holds the snapshot where it says it does. The
     * check-then-mv window cannot be closed from this side (the jail's command
     * grammar is fixed - no `mv -T`, no `[ -e ]`), so detection is the client's
     * job: one extra `find` inside the promoted directory turns a silent
     * corruption into a loud failure with the partial still on disk.
     */
    async promote(name: string): Promise<void> {
        assertSnapshotName(name);
        const entries = await this.listEntries();
        if (entries.includes(name)) {
            throw new SnapshotStoreError(`refusing to promote: complete snapshot ${name} already exists`);
        }
        if (!entries.includes(`${name}.partial`)) {
            throw new SnapshotStoreError(`no partial snapshot ${name}.partial to promote`);
        }
        const final = posix.join(this.root, name);
        await this.run(["mv", "--", posix.join(this.root, `${name}.partial`), final], "promote", NO_RETRY);
        const inside = await this.run(listArgv(final, this.jailed), "promote verification");
        const nested = parseListing(inside.stdout, this.jailed).includes(`${name}.partial`);
        if (nested) {
            throw new SnapshotStoreError(
                `promote of ${name} nested instead of renaming: ${name} already existed on the remote, so the snapshot now sits at ${name}/${name}.partial - not promoted`,
            );
        }
    }

    /**
     * Two-phase delete: `mv --` to `<name>.deleting`, then `rm -rf --`.
     * Refuses non-complete names and the newest complete snapshot - where
     * "newest" means the newest GENUINELY dated one (see `newestUndeletable`),
     * so a future-dated name a jailed writer planted stays prunable instead of
     * bricking the target forever.
     *
     * Phase 1 needs no nesting post-check (unlike `promote`): if `mv` nests
     * `<name>` into a pre-existing `<name>.deleting`, phase 2's `rm -rf` still
     * removes it, which is exactly what this method was asked to do.
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
        // The digit test alone has no length bound: a hostile `df` answering 400
        // digits parses to Infinity, and `Infinity * 1024 >= anything` makes the
        // disk guard pass unconditionally. The safe-integer bound is the check.
        const kib = Number(available);
        if (!/^[0-9]+$/.test(available) || !Number.isSafeInteger(kib * 1024)) {
            throw malformed;
        }
        return kib * 1024;
    }

    /**
     * Free inodes: always null for a push store. The jailed surface answers
     * `df -Pk --`, whose POSIX output has no inode columns, and the jail's
     * command grammar is an exact string match - a client cannot ask for
     * `df -Pi`. The disk guard skips its inode half rather than guess.
     */
    async freeInodes(): Promise<number | null> {
        return null;
    }

    /** Run `fn` under the store-root lock (structural release; spec section 6). */
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureRoot();
        return withLockScope(
            new RemoteLockBackend(this.root, this.runner, this.now, this.jailed, this.sshDestination),
            this.log,
            fn,
        );
    }

    /** Clear a leaked lock; a live one is reported and left alone without `force`. */
    async unlock(force: boolean): Promise<UnlockOutcome> {
        await this.ensureRoot();
        return forceUnlock(
            new RemoteLockBackend(this.root, this.runner, this.now, this.jailed, this.sshDestination),
            force,
        );
    }
}
