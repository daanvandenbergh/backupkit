/**
 * The rsync exit-code table from spec section 3, as one pure classifier:
 * `classifyExit(exitCode, stderrTail)` decides promote vs retry vs fail and
 * sets the `retriable` flag the retry loop reads. Exit 255 (ssh transport) is
 * transient unless the sanitized stderr tail matches one of the three fixed
 * permanent ssh patterns, which `ssh/classify.ts` owns for the whole codebase
 * (spec section 4).
 */

import { matchPermanentSshPattern, type PermanentSshPattern } from "../../ssh/classify.js";

/**
 * The message this classifier reports per permanent ssh failure class. The
 * PATTERNS themselves are deliberately NOT restated here:
 * `matchPermanentSshPattern` is the one place that owns which stderr text means
 * what. A second copy of the substrings would silently disagree the day a
 * fourth class is added - `runRemote` would stop retrying it while a transfer's
 * exit 255 kept retrying it for the target's whole attempt budget (up to ten
 * attempts with 15 s-300 s backoff).
 *
 * This is a type-level dependency too: adding a `PermanentSshPattern` variant
 * without a message here fails `npm run typecheck`, so the two cannot drift.
 */
const PERMANENT_SSH_MESSAGE: Record<PermanentSshPattern, string> = {
    "auth-failure": "ssh authentication failed (exit 255) - permanent, not retried",
    "host-key-verification":
        'ssh host key verification failed (exit 255) - permanent; pin the host key via "backupkit check"',
    "host-key-changed": "remote host key changed (exit 255) - permanent, possible MITM; a human must fix known_hosts",
};

/**
 * rsync exit codes that are transient: 10 socket I/O, 12 protocol stream,
 * 13 message I/O, 14 IPC, 21 waitpid, 30/35 timeouts.
 *
 * All seven are ONE event seen from different layers - the transport died
 * mid-transfer. Which code rsync happens to return depends on where it was
 * when the link dropped (reading the socket, writing the message pipe, reaping
 * the ssh child), and treating only some of them as retriable means a flaky
 * link loses the run on the codes that fell through to the fatal default. The
 * cost of being wrong here is asymmetric: a retry resumes the same `.partial`
 * so it costs one attempt out of the target's budget, while a missed retry
 * costs the whole run.
 */
const TRANSIENT_EXIT_CODES = new Set([10, 12, 13, 14, 21, 30, 35]);

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
        const pattern = matchPermanentSshPattern(stderrTail);
        if (pattern !== null) {
            return row("fatal", false, false, PERMANENT_SSH_MESSAGE[pattern]);
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
