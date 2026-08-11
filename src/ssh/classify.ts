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
