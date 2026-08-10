/**
 * The rsync exit-code table from spec section 3, as one pure classifier:
 * `classifyExit(exitCode, stderrTail)` decides promote vs retry vs fail and
 * sets the `retriable` flag the retry loop reads. Exit 255 (ssh transport) is
 * transient unless the sanitized stderr tail matches one of the three fixed
 * permanent ssh patterns from spec section 4.
 */

/**
 * The three fixed substrings that mark an ssh transport failure permanent
 * (auth failure, host-key verification failure, host-key change). These
 * mirror ssh/classify.ts's `isPermanentSshStderr` exactly - spec section 4
 * defines them once for both modules.
 * ponytail: inlined because rsync/ is built in parallel with ssh/ and takes
 * no import on it; converge on ssh/classify.ts in the engine phase if wanted.
 */
const PERMANENT_SSH_PATTERNS: readonly { substring: string; message: string }[] = [
    { substring: "Permission denied (", message: "ssh authentication failed (exit 255) - permanent, not retried" },
    {
        substring: "Host key verification failed",
        message: "ssh host key verification failed (exit 255) - permanent; pin the host key via \"backupkit check\"",
    },
    {
        substring: "REMOTE HOST IDENTIFICATION HAS CHANGED",
        message: "remote host key changed (exit 255) - permanent, possible MITM; a human must fix known_hosts",
    },
];

/** rsync exit codes that are transient by the spec table: 10 socket I/O, 12 protocol stream, 30/35 timeouts. */
const TRANSIENT_EXIT_CODES = new Set([10, 12, 30, 35]);

/** rsync exit codes that are a backupkit bug or rsync-version escape: usage, protocol, unsupported action. */
const HARD_FAIL_EXIT_CODES = new Set([1, 2, 4, 5, 6]);

/** Outcome class of one rsync exit, mirroring the spec's exit-code table rows. */
export type ExitClass =
    | "ok"
    | "warning"
    | "transient"
    | "disk"
    | "hard"
    | "signal"
    | "fatal";

/** Full classification of one rsync exit for the retry loop and the run report. */
export interface ExitClassification {
    /** Table row this exit landed on. */
    class: ExitClass;
    /** True when the retry loop may run another attempt (the sole flag it reads). */
    retriable: boolean;
    /** True when the partial may be promoted to a complete snapshot (exit 0/23/24). */
    promote: boolean;
    /** Human summary of the row, used as the TransferError message on failure. */
    message: string;
}

/** Build a classification row. */
function row(cls: ExitClass, retriable: boolean, promote: boolean, message: string): ExitClassification {
    return { class: cls, retriable, promote, message };
}

/**
 * Classify one rsync exit per the spec section 3 table. `exitCode` null means
 * the child died on a signal. `stderrTail` MUST already be sanitized
 * (shared/sanitize) - the permanent ssh patterns are matched against the
 * sanitized tail by contract.
 */
export function classifyExit(exitCode: number | null, stderrTail: string): ExitClassification {
    if (exitCode === null || exitCode === 20) {
        return row("signal", false, false, "rsync terminated by signal - not retried (shutdown path)");
    }
    if (exitCode === 0) {
        return row("ok", false, true, "rsync completed");
    }
    if (exitCode === 24) {
        return row("warning", false, true, "rsync completed with vanished source files (exit 24)");
    }
    if (exitCode === 23) {
        return row("warning", false, true, "rsync completed with skipped files (exit 23)");
    }
    if (TRANSIENT_EXIT_CODES.has(exitCode)) {
        return row("transient", true, false, `transient rsync failure (exit ${exitCode})`);
    }
    if (exitCode === 255) {
        for (const pattern of PERMANENT_SSH_PATTERNS) {
            if (stderrTail.includes(pattern.substring)) {
                return row("fatal", false, false, pattern.message);
            }
        }
        return row("transient", true, false, "ssh transport error (exit 255)");
    }
    if (exitCode === 11) {
        return row("disk", false, false, "rsync file I/O error (exit 11) - disk full or destination unwritable");
    }
    if (HARD_FAIL_EXIT_CODES.has(exitCode)) {
        return row(
            "hard",
            false,
            false,
            `rsync hard failure (exit ${exitCode}) - likely a backupkit bug or an unsupported rsync; not retried`,
        );
    }
    return row("fatal", false, false, `rsync failed (exit ${exitCode}) - not retried`);
}
