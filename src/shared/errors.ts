/**
 * The backupkit error hierarchy: one flat base class, one subclass per domain,
 * each with a stable machine-readable code from the closed BackupkitErrorCode
 * union and typed payload fields. `isBackupkitError` is the supported
 * catch-side guard (ESM-safe where `instanceof` across duplicated package
 * copies betrays you).
 *
 * It also owns `describeError` - the ONE way an unknown caught value becomes
 * text a person reads. Every log line, report field and CLI message goes
 * through it, so an errno is explained in the same words everywhere.
 */

import { sanitize } from "./sanitize.js";

/** Closed union of every stable error code a BackupkitError can carry. */
export type BackupkitErrorCode =
    | "config"
    | "ssh"
    | "transfer"
    | "snapshot-store"
    | "lock-held"
    | "disk-space"
    | "restore";

/**
 * Base class of every backupkit error. Never thrown directly - one subclass
 * exists per domain. Carries a stable `code` and a brand marker so
 * `isBackupkitError` works across duplicated package instances.
 */
export abstract class BackupkitError extends Error {
    /** Stable machine-readable error domain code. */
    readonly code: BackupkitErrorCode;

    /** Brand marker read by isBackupkitError; always true. */
    readonly isBackupkitError: true = true;

    /**
     * Construct a backupkit error with its domain code and human message.
     * Sets `name` to the concrete subclass name for readable stack traces.
     */
    protected constructor(code: BackupkitErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = new.target.name;
    }
}

/**
 * Configuration failure: unresolvable config path, JSONC parse error, or
 * validation error. Message format is `<file>:<line>: <dotted.path>: <problem>`
 * for validation errors and `<file>:<line>:<col>: <problem>` for parse errors.
 */
export class ConfigError extends BackupkitError {
    /** Config file the error came from, or null when no file was involved (e.g. no config found). */
    readonly file: string | null;

    /** 1-based line of the offending node in `file`, or null when not tied to a line. */
    readonly line: number | null;

    /** Dotted config path of the offending field (e.g. "targets.web.schedule.on"), or null. */
    readonly path: string | null;

    /** Construct a config error with its optional file/line/path payload. */
    constructor(message: string, details?: { file?: string; line?: number; path?: string }) {
        super("config", message);
        this.file = details?.file ?? null;
        this.line = details?.line ?? null;
        this.path = details?.path ?? null;
    }
}

/**
 * SSH-layer failure: agent, key loading, permission preflight, or a remote
 * command. `retriable` is set only by the ssh classifier and is the sole flag
 * `withTransientRetry` reads.
 */
export class SshError extends BackupkitError {
    /** True when the failure is transient (classifier-decided) and may be retried. */
    readonly retriable: boolean;

    /** Construct an ssh error; `retriable` defaults to false (permanent). */
    constructor(message: string, options?: { retriable?: boolean }) {
        super("ssh", message);
        this.retriable = options?.retriable ?? false;
    }
}

/**
 * rsync transfer failure. `retriable` is set only by the rsync exit-code
 * classifier; `stderrTail` is the sanitized tail of the child's stderr.
 */
export class TransferError extends BackupkitError {
    /** rsync exit code, or null when the child died without one (signal/timeout). */
    readonly exitCode: number | null;

    /** True when the failure is transient (classifier-decided) and may be retried. */
    readonly retriable: boolean;

    /** Sanitized last portion of the child's stderr, for reports and classification. */
    readonly stderrTail: string;

    /** Construct a transfer error with its exit code, retriability, and stderr tail. */
    constructor(message: string, options: { exitCode: number | null; retriable: boolean; stderrTail: string }) {
        super("transfer", message);
        this.exitCode = options.exitCode;
        this.retriable = options.retriable;
        this.stderrTail = options.stderrTail;
    }
}

/** Snapshot store failure: listing, claim, promote, or delete went wrong. */
export class SnapshotStoreError extends BackupkitError {
    /** Construct a snapshot store error. */
    constructor(message: string) {
        super("snapshot-store", message);
    }
}

/** The destination-root lock is held by another live backupkit process. */
export class LockHeldError extends BackupkitError {
    /** Pid recorded in the lock meta file, or null when unreadable. */
    readonly pid: number | null;

    /** Hostname recorded in the lock meta file, or null when unreadable. */
    readonly hostname: string | null;

    /** Construct a lock-held error with the holder's recorded identity. */
    constructor(message: string, options?: { pid?: number | null; hostname?: string | null }) {
        super("lock-held", message);
        this.pid = options?.pid ?? null;
        this.hostname = options?.hostname ?? null;
    }
}

/** The disk guard refused a run: projected free space would fall below the floor. */
export class DiskSpaceError extends BackupkitError {
    /** Bytes the transfer is projected to need (delta * 1.2 + inode floor). */
    readonly requiredBytes: number;

    /** Bytes currently free on the archive filesystem. */
    readonly freeBytes: number;

    /** Construct a disk-space error with the projected requirement and current free bytes. */
    constructor(message: string, options: { requiredBytes: number; freeBytes: number }) {
        super("disk-space", message);
        this.requiredBytes = options.requiredBytes;
        this.freeBytes = options.freeBytes;
    }
}

/** Restore failure: unknown snapshot, existing output path, or a copy/verify error. */
export class RestoreError extends BackupkitError {
    /** Construct a restore error. */
    constructor(message: string) {
        super("restore", message);
    }
}

/**
 * Type guard for BackupkitError that survives duplicated package instances
 * (where `instanceof` fails): checks the brand marker and a string code.
 */
export function isBackupkitError(error: unknown): error is BackupkitError {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { isBackupkitError?: unknown }).isBackupkitError === true &&
        typeof (error as { code?: unknown }).code === "string"
    );
}

/**
 * Whether a failure is TRANSIENT - the classifier-set `retriable` flag on an
 * `SshError`/`TransferError`, read structurally so it also holds for an error
 * that crossed a package boundary.
 *
 * It answers one question two places need: "was this the network, or is
 * something actually wrong?". `withTransientRetry` reads it to decide whether
 * to try again; the daemon's failure log sites read it to decide the LEVEL. A
 * night of dropped Wi-Fi used to emit the same ERROR lines as a revoked key,
 * so a log full of red said nothing about whether a human had to do anything.
 */
export function isTransientFailure(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { retriable?: unknown }).retriable === true;
}

/**
 * Plain English for the OS error codes this package can actually surface.
 *
 * ssh and rsync failures already arrive explained - their classifiers own
 * that. Everything ELSE a backup touches is the filesystem, and node reports
 * those as `EXDEV: cross-device link, rename ...`: accurate, and meaningless
 * to the person whose backup just stopped. Each line below says what happened
 * in the reader's terms and, where there is one, what to do about it.
 *
 * Deliberately not exhaustive - a code with no entry is left as node wrote it
 * rather than padded with a guess.
 */
const ERRNO_MEANING: Record<string, string> = {
    ENOENT: "the file or directory does not exist (or a program backupkit needs is not installed)",
    EACCES: "permission denied - the user running backupkit may not read or write that path",
    EPERM: "the operation is not permitted for this user, even though the path exists",
    ENOSPC: "the filesystem is FULL - nothing more can be written until space is freed",
    EDQUOT: "the disk quota for this user is exhausted",
    EROFS: "the filesystem is mounted read-only",
    EXDEV: "source and destination are on DIFFERENT filesystems, so this cannot be a rename or a hard link - snapshots need one filesystem per archive root",
    EMLINK: "the filesystem's hard-link limit for one file is exhausted - too many snapshots share it",
    ENOTEMPTY: "the directory is not empty",
    EEXIST: "it already exists",
    EISDIR: "that path is a directory, not a file",
    ENOTDIR: "a component of that path is a file, not a directory",
    ELOOP: "a symlink was found where a real file was required - backupkit refuses to follow it",
    EBUSY: "the file or device is in use (open elsewhere, or a mount point)",
    EMFILE: "this process has too many files open - raise its open-file limit",
    ENFILE: "the whole system has too many files open",
    EIO: "a low-level I/O error - the disk or the connection to it may be failing",
    ENAMETOOLONG: "that path is longer than the filesystem allows",
    ENOMEM: "the system is out of memory",
    ETIMEDOUT: "the operation timed out with no answer",
    ECONNREFUSED: "the host answered but refused the connection - it is UP; nothing is listening on that port",
    ECONNRESET: "the connection was dropped by the peer",
    EHOSTUNREACH: "there is no route to that host",
    ENETUNREACH: "there is no route to that network - this machine's link may be down",
    ENOTFOUND: "the hostname did not resolve - DNS on this machine or its network, not the remote",
    EAI_AGAIN: "the hostname could not be resolved right now - a temporary DNS failure",
    EPIPE: "the other end closed the connection before backupkit finished writing",
};

/** The plain-English meaning of an OS error code, or null when there is no entry for it. */
export function errnoMeaning(code: string): string | null {
    return ERRNO_MEANING[code] ?? null;
}

/**
 * The sanitized, human-readable text for ANY caught value - the single
 * conversion every log field, report field and CLI message uses.
 *
 * Three things it fixes, each of which had its own hand-rolled copy at
 * roughly twenty call sites:
 *
 * 1. `String(error)` prefixes the class name, so a daemon log read
 *    `error="SshError: ssh alias ..."` - the class of a private TypeScript
 *    object leaking into the one field a person actually reads.
 * 2. A raw syscall failure said `EXDEV: cross-device link, rename '/a' -> '/b'`
 *    and nothing else. The errno is now spelled out after it, so the message
 *    names both what the OS said and what it means.
 * 3. Some sites sanitized and some did not, on values that can carry a remote
 *    peer's bytes. Sanitizing HERE means no site can forget.
 *
 * A backupkit error is returned as-is: its message was already written for a
 * person, and its errno (if any) was explained when it was built.
 */
export function describeError(error: unknown): string {
    if (isBackupkitError(error)) {
        return sanitize(error.message);
    }
    const message = sanitize(error instanceof Error ? error.message : String(error));
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof code !== "string") {
        return message;
    }
    // A failed spawn reads `spawn /opt/homebrew/bin/rsync ENOENT`, where the
    // generic ENOENT wording ("the file or directory does not exist") sends the
    // reader looking for a missing backup file rather than a missing program.
    if (code === "ENOENT" && message.startsWith("spawn ")) {
        return `${message} - that program is not installed, or is not at that path`;
    }
    const meaning = errnoMeaning(code);
    // Never explain twice: a message that already carries the meaning (the
    // caller built it from this same table) stays as it is.
    if (meaning === null || message.includes(meaning)) {
        return message;
    }
    return `${message} - ${meaning}`;
}
