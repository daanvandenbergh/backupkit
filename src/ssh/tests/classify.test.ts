import { describe, expect, it } from "vitest";
import { isPermanentSshStderr, matchPermanentSshPattern, sshStderrTail } from "../classify.js";

/**
 * Shared permanent-pattern fixtures (the rsync 255-cross-table reuses these
 * shapes so the two callers cannot diverge).
 */
export const PERMANENT_FIXTURES = [
    {
        label: "auth failure",
        stderr: "daan@10.0.0.11: Permission denied (publickey,password).",
        pattern: "auth-failure",
    },
    {
        label: "host key verification failure",
        stderr: "Host key verification failed.",
        pattern: "host-key-verification",
    },
    {
        label: "host key changed",
        stderr:
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
            "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n" +
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
        pattern: "host-key-changed",
    },
] as const;

describe("matchPermanentSshPattern / isPermanentSshStderr", () => {
    it.each([...PERMANENT_FIXTURES])("$label is permanent", ({ stderr, pattern }) => {
        const tail = sshStderrTail(stderr);
        expect(matchPermanentSshPattern(tail)).toBe(pattern);
        expect(isPermanentSshStderr(tail)).toBe(true);
    });

    it.each([
        ["empty stderr", ""],
        ["garbage", "kex_exchange_identification: read: Connection reset by peer"],
        ["timeout text", "Connection timed out during banner exchange"],
        ["connection refused", "connect to host 10.0.0.11 port 22: Connection refused"],
        ["permission denied without paren (not the auth pattern)", "Permission denied"],
        // rsync writes EACCES in ssh's own shape for every unreadable source
        // file. Reading it as an auth failure makes a network drop over a tree
        // holding one root-owned file permanent, so the run is never retried.
        [
            "rsync EACCES on a source file (errno, not an ssh method list)",
            'rsync: [sender] send_files failed to open "/var/www/secret.txt": Permission denied (13)\n' +
                "rsync error: unexplained error (code 255) at io.c(231)",
        ],
        ["random binary-ish noise", "partial"],
    ])("%s is transient", (_label, stderr) => {
        const tail = sshStderrTail(stderr);
        expect(matchPermanentSshPattern(tail)).toBeNull();
        expect(isPermanentSshStderr(tail)).toBe(false);
    });
});

describe("sshStderrTail", () => {
    it("sanitizes control characters before slicing", () => {
        expect(sshStderrTail("a\x1b[31mred\x1b[0m\nb")).toBe("a[31mred[0mb");
    });

    it("keeps only the last 2 KiB, sanitizing first so a control flood cannot hide a pattern", () => {
        const flood = "\n".repeat(4096) + "x".repeat(2040) + "Permission denied (publickey).";
        const tail = sshStderrTail(flood);
        expect(tail.length).toBeLessThanOrEqual(2048);
        expect(isPermanentSshStderr(tail)).toBe(true);
    });
});
