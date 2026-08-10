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

/** The exact fixed substrings, one per permanent class - never extended casually. */
const PATTERNS: readonly { pattern: PermanentSshPattern; needle: string }[] = [
    { pattern: "auth-failure", needle: "Permission denied (" },
    { pattern: "host-key-verification", needle: "Host key verification failed" },
    { pattern: "host-key-changed", needle: "REMOTE HOST IDENTIFICATION HAS CHANGED" },
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
        if (stderrTail.includes(needle)) {
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
