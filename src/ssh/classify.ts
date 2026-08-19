/**
 * The ONLY stderr inspection in the codebase (spec section 4): ssh/rsync exit
 * 255 and exec timeouts are transient unless the sanitized stderr tail matches
 * one of exactly three fixed permanent ssh patterns - auth failure, host key
 * verification failure, host key changed. Unknown stderr defaults to
 * transient: retrying a permanent failure wastes minutes, misclassifying a
 * transient one loses a run, so the bias goes toward retry.
 */

import { sanitize } from "../shared/sanitize.js";

/** The three failure classes that make an ssh transport error permanent. */
export type PermanentSshPattern = "auth-failure" | "host-key-verification" | "host-key-changed";

/**
 * The exact fixed patterns, one per permanent class - never extended casually.
 *
 * The auth-failure pattern requires ssh's METHOD LIST inside the parentheses
 * (`Permission denied (publickey,password).`) and not merely the parenthesis.
 * rsync writes an errno in the same shape for every unreadable source file -
 * `send_files failed to open "/x": Permission denied (13)` - so the bare
 * `Permission denied (` substring turned a network drop over a tree holding one
 * root-owned file into "ssh authentication failed - permanent, not retried":
 * the transfer died at exit 255 with those file errors still in the 2 KiB
 * stderr tail, and the retry loop stopped on an auth failure that never
 * happened. Method names are lowercase letters, `-` and `,`; an errno is digits.
 */
const PATTERNS: readonly { pattern: PermanentSshPattern; needle: RegExp }[] = [
    { pattern: "auth-failure", needle: /Permission denied \([a-z][a-z,-]*\)/ },
    { pattern: "host-key-verification", needle: /Host key verification failed/ },
    { pattern: "host-key-changed", needle: /REMOTE HOST IDENTIFICATION HAS CHANGED/ },
];

/**
 * The sanitized last 2 KiB of a child's stderr - the exact text every
 * classification and report inclusion works on (sanitize first, then slice,
 * so a control-char flood cannot push a pattern out of the window).
 */
export function sshStderrTail(stderr: string): string {
    return sanitize(stderr).slice(-2048);
}

/**
 * The permanent pattern a sanitized stderr tail matches, or null when it
 * matches none (i.e. the failure is transient).
 */
export function matchPermanentSshPattern(stderrTail: string): PermanentSshPattern | null {
    for (const { pattern, needle } of PATTERNS) {
        if (needle.test(stderrTail)) {
            return pattern;
        }
    }
    return null;
}

/**
 * Whether a sanitized stderr tail marks the failure permanent (auth failure,
 * host key verification failure, or host key change). Everything else -
 * including empty or garbage stderr - is transient.
 */
export function isPermanentSshStderr(stderrTail: string): boolean {
    return matchPermanentSshPattern(stderrTail) !== null;
}

/**
 * What a TRANSIENT transport failure most likely was, in the reader's terms.
 *
 * The distinction that matters in a log at 04:00 is WHOSE side broke. A
 * dropped Wi-Fi link and a powered-off backup server both surface as "ssh
 * failed (exit 255)", and a reader who cannot tell them apart goes and looks
 * at the wrong machine. ssh already writes the answer to stderr - this maps
 * its wording onto the five causes that call for different reactions.
 */
export type TransientSshCause = "no-network" | "dns" | "refused" | "unanswered" | "dropped";

/**
 * The message for a connection that never got an answer. Shared by the
 * exit-255 "Connection timed out" case and the exec-level timeout, which are
 * one event seen a layer apart (ssh gave up, or backupkit gave up on ssh).
 * It deliberately refuses to pick a side: from this machine an offline host
 * and a dead local link are genuinely indistinguishable, and claiming
 * otherwise is what sends a reader to reboot a server that was never down.
 */
export const SSH_NO_ANSWER_MESSAGE =
    "no answer from the host - it may be offline, or this machine's network/route to it may be down; " +
    "from here those look identical";

/** The plain-language meaning of each transient cause. */
const TRANSIENT_CAUSE_MESSAGE: Record<TransientSshCause, string> = {
    "no-network": "this machine has no route to the network (dropped Wi-Fi/VPN, or an unplugged link) - not the host",
    dns: "the hostname could not be resolved, which is DNS on this machine or its network - not the host",
    refused: "the host answered but refused the ssh port - it is UP; sshd is not listening, or a firewall rejected it",
    unanswered: SSH_NO_ANSWER_MESSAGE,
    dropped: "the connection dropped mid-session - a flaky link on either side, not a configuration problem",
};

/**
 * The stderr needles per transient cause, matched in this order. Kept
 * deliberately loose across platforms: macOS says "Operation timed out" where
 * Linux says "Connection timed out", and each resolver family words a DNS
 * failure differently.
 */
const TRANSIENT_PATTERNS: readonly { cause: TransientSshCause; needle: RegExp }[] = [
    { cause: "no-network", needle: /Network is (unreachable|down)|No route to host|Host is unreachable/ },
    {
        cause: "dns",
        needle: /Could not resolve hostname|Name or service not known|Temporary failure in name resolution|nodename nor servname provided|No address associated with hostname/,
    },
    { cause: "refused", needle: /Connection refused/ },
    { cause: "unanswered", needle: /Connection timed out|Operation timed out/ },
    { cause: "dropped", needle: /Connection reset by peer|Connection closed by|Broken pipe|kex_exchange_identification/ },
];

/**
 * The transient cause a sanitized stderr tail names, or null when it names
 * none. Purely explanatory - it never changes whether a failure is retried
 * (`isPermanentSshStderr` alone decides that), so a needle that misses only
 * costs the reader a sentence, never a run.
 */
export function matchTransientSshCause(stderrTail: string): TransientSshCause | null {
    for (const { cause, needle } of TRANSIENT_PATTERNS) {
        if (needle.test(stderrTail)) {
            return cause;
        }
    }
    return null;
}

/**
 * The plain-language explanation for a sanitized stderr tail, or null when
 * the tail names no cause this recognises. Callers append it to their own
 * message; they never replace the raw tail with it, because the tail is the
 * evidence and this is only the reading of it.
 */
export function describeTransientSshStderr(stderrTail: string): string | null {
    const cause = matchTransientSshCause(stderrTail);
    return cause === null ? null : TRANSIENT_CAUSE_MESSAGE[cause];
}
