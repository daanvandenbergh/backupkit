/**
 * The rsync exit-code table from spec section 3, as one pure classifier:
 * `classifyExit(exitCode, stderrTail)` decides promote vs retry vs fail and
 * sets the `retriable` flag the retry loop reads. Exit 255 (ssh transport) is
 * transient unless the sanitized stderr tail matches one of the three fixed
 * permanent ssh patterns, which `ssh/classify.ts` owns for the whole codebase
 * (spec section 4).
 */

import {
    describeTransientSshStderr,
    matchPermanentSshPattern,
    type PermanentSshPattern,
} from "../../ssh/classify.js";

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


/**
 * What rsync's OWN stderr says, in the reader's terms.
 *
 * The exit code alone names a CLASS of failure - "rsync hard failure (exit
 * 12)" - while the one line that says WHICH failure sits in stderr and never
 * reached the log. The worst case was the jail: a `backupkit-remote` that
 * refuses a command prints `rejected` and dies, rsync reports a protocol
 * error, and the operator was told to look for "a backupkit bug or an
 * unsupported rsync" while the backup server was in fact turning the command
 * away. Every row below is a line rsync actually writes.
 *
 * Deliberately excluded: anything auth- or host-key-shaped. Exit 255 is ssh's
 * failure, `ssh/classify.ts` owns its wording, and rsync writes its own
 * unrelated `Permission denied (13)` for every unreadable source file - the
 * two were confused here once already.
 */
const STDERR_MEANING: readonly { needle: RegExp; meaning: string }[] = [
    {
        needle: /backupkit-remote: rejected/,
        meaning:
            "the backup server's backupkit-remote jail REFUSED this command - the jail script there and this client " +
            'disagree about the command shape; re-run "backupkit jail" on the server to reinstall it',
    },
    { needle: /No space left on device/, meaning: "the destination filesystem is FULL" },
    { needle: /Read-only file system/, meaning: "the destination filesystem is mounted read-only" },
    { needle: /Disk quota exceeded/, meaning: "the destination account is over its disk quota" },
    {
        needle: /Too many links/,
        meaning: "the destination filesystem's hard-link limit is exhausted - too many snapshots share one file",
    },
    {
        needle: /change_dir "([^"]*)" failed/,
        meaning: "the SOURCE directory could not be entered - it does not exist, or this user may not read it",
    },
    {
        needle: /link_stat "([^"]*)" failed/,
        meaning: "a source path could not be read - it vanished mid-run, or this user may not read it",
    },
    {
        needle: /--link-dest arg does not exist/,
        meaning:
            "the previous snapshot this run was going to hard-link against is gone - the next run makes a full copy instead",
    },
    {
        needle: /@ERROR: auth failed/,
        meaning: "the rsync DAEMON on the far side refused the login (this is rsync's own auth, not ssh's)",
    },
    { needle: /@ERROR: (chdir|Unknown module)/, meaning: "the rsync daemon has no such module, or cannot enter it" },
    {
        needle: /protocol version mismatch/,
        meaning: "the two rsync versions cannot talk to each other - upgrade the older side",
    },
    {
        needle: /connection unexpectedly closed/,
        meaning: "the far side went away before finishing - a dropped link, a killed process, or a jail that refused",
    },
    {
        needle: /IO error encountered/,
        meaning:
            "rsync hit read errors in the source, so it disabled deletion for this run - files removed at the source stay in the snapshot",
    },
    {
        needle: /failed to set (times|permissions|ownership)/,
        meaning: "the destination filesystem cannot store the metadata being copied (often exFAT, NTFS, or SMB)",
    },
    {
        needle: /mkdir "?([^"\s]*)"? failed|failed to create directory/,
        meaning: "a destination directory could not be created - check the path exists and this user may write it",
    },
];

/**
 * The jail's refusal, which is PERMANENT however rsync happens to exit.
 *
 * `backupkit-remote` prints this and dies, so rsync sees its peer vanish and
 * returns a transport code - usually 12. That put the failure on the transient
 * row: the log said "the link to the remote died mid-transfer - a network drop,
 * not your data" about a backup server that had just refused the command in
 * writing, and then retried the identical command up to ten times over the
 * target's whole backoff budget. A rejection is not ambiguous the way unknown
 * stderr is, so the retry bias does not apply to it.
 */
const JAIL_REJECTED = /backupkit-remote: rejected/;

/** The last non-empty line of a sanitized tail that looks like rsync reporting an error, or null. */
function rsyncErrorLine(stderrTail: string): string | null {
    const lines = stderrTail
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    // Last match, not first: rsync prints the specific failure and THEN its
    // generic `rsync error: ... at main.c(...)` summary, so scanning forward
    // for the useful line means walking back past the summary.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (/^(rsync:|@ERROR|backupkit-remote:)/.test(line) && !/^rsync error: .* at [a-z_]+\.c\(/.test(line)) {
            return line;
        }
    }
    return null;
}

/** How much of rsync's own stderr line is carried into the message before it is trimmed. */
const SAID_MAX_CHARS = 300;

/**
 * The plain-language reading of an rsync stderr tail plus the one line rsync
 * actually wrote, or null when the tail says nothing recognisable. `tail` must
 * already be sanitized. Callers APPEND this to the exit-code row; it never
 * replaces it, because the exit code is what decided retry vs fail and the
 * reader needs both.
 */
export function describeRsyncStderr(stderrTail: string): string | null {
    const matched = STDERR_MEANING.find(({ needle }) => needle.test(stderrTail));
    const said = rsyncErrorLine(stderrTail);
    if (matched === undefined && said === null) {
        return null;
    }
    const quoted = said === null ? "" : ` [rsync said: ${said.length > SAID_MAX_CHARS ? `${said.slice(0, SAID_MAX_CHARS)}...` : said}]`;
    return `${matched?.meaning ?? "rsync reported a failure"}${quoted}`;
}

/** Append rsync's own reading of stderr to an exit-code row's message, when it has one. */
function withStderr(message: string, stderrTail: string): string {
    const explanation = describeRsyncStderr(stderrTail);
    return explanation === null ? message : `${message} - ${explanation}`;
}

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
        return row("warning", false, true, withStderr("rsync completed with skipped files (exit 23)", stderrTail));
    }
    if (JAIL_REJECTED.test(stderrTail)) {
        return row("fatal", false, false, withStderr(`the backup server refused the command (rsync exit ${exitCode})`, stderrTail));
    }
    if (TRANSIENT_EXIT_CODES.has(exitCode)) {
        return row(
            "transient",
            true,
            false,
            withStderr(
                `the link to the remote died mid-transfer (rsync exit ${exitCode}) - a network drop, not your data`,
                stderrTail,
            ),
        );
    }
    if (exitCode === 255) {
        const pattern = matchPermanentSshPattern(stderrTail);
        if (pattern !== null) {
            return row("fatal", false, false, PERMANENT_SSH_MESSAGE[pattern]);
        }
        const cause = describeTransientSshStderr(stderrTail);
        return row("transient", true, false, `ssh transport error (exit 255)${cause === null ? "" : ` - ${cause}`}`);
    }
    if (exitCode === 11) {
        return row(
            "disk",
            false,
            false,
            withStderr("rsync file I/O error (exit 11) - disk full or destination unwritable", stderrTail),
        );
    }
    if (HARD_FAIL_EXIT_CODES.has(exitCode)) {
        return row(
            "hard",
            false,
            false,
            withStderr(
                `rsync hard failure (exit ${exitCode}) - likely a backupkit bug or an unsupported rsync; not retried`,
                stderrTail,
            ),
        );
    }
    return row("fatal", false, false, withStderr(`rsync failed (exit ${exitCode}) - not retried`, stderrTail));
}
