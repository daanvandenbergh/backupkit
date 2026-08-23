import { describe, expect, it } from "vitest";
import {
    describeTransientSshStderr,
    isPermanentSshStderr,
    matchPermanentSshPattern,
    matchTransientSshCause,
    SSH_NO_ANSWER_MESSAGE,
    sshStderrTail,
    describeRemoteStderr,
} from "../classify.js";

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

/**
 * Real stderr lines per transient cause, one per wording the platforms
 * actually emit. The whole point of the classifier is that a reader can tell
 * "my Wi-Fi dropped" from "the server is off", so each fixture also states
 * which side the message must blame.
 */
const TRANSIENT_FIXTURES = [
    { label: "linux network unreachable", stderr: "ssh: connect to host backup port 22: Network is unreachable", cause: "no-network" },
    { label: "network down", stderr: "ssh: connect to host backup port 22: Network is down", cause: "no-network" },
    { label: "no route", stderr: "ssh: connect to host 10.0.0.11 port 22: No route to host", cause: "no-network" },
    { label: "host unreachable", stderr: "ssh: connect to host 10.0.0.11 port 22: Host is unreachable", cause: "no-network" },
    { label: "dns could not resolve", stderr: "ssh: Could not resolve hostname backup: Name or service not known", cause: "dns" },
    { label: "dns temporary failure", stderr: "ssh: Could not resolve hostname backup: Temporary failure in name resolution", cause: "dns" },
    { label: "dns macos wording", stderr: "ssh: Could not resolve hostname backup: nodename nor servname provided, or not known", cause: "dns" },
    { label: "dns no address", stderr: "ssh: Could not resolve hostname backup: No address associated with hostname", cause: "dns" },
    { label: "refused", stderr: "ssh: connect to host 10.0.0.11 port 22: Connection refused", cause: "refused" },
    { label: "linux timeout", stderr: "ssh: connect to host 10.0.0.11 port 22: Connection timed out", cause: "unanswered" },
    { label: "macos timeout", stderr: "ssh: connect to host 10.0.0.11 port 22: Operation timed out", cause: "unanswered" },
    { label: "reset", stderr: "Connection reset by peer", cause: "dropped" },
    { label: "closed by remote", stderr: "Connection closed by remote host", cause: "dropped" },
    { label: "broken pipe", stderr: "client_loop: send disconnect: Broken pipe", cause: "dropped" },
    { label: "handshake drop", stderr: "kex_exchange_identification: read: Connection reset by peer", cause: "dropped" },
] as const;

describe("transient ssh cause", () => {
    it.each(TRANSIENT_FIXTURES)("names the cause for $label", ({ stderr, cause }) => {
        const tail = sshStderrTail(stderr);
        expect(matchTransientSshCause(tail)).toBe(cause);
        expect(describeTransientSshStderr(tail)).toBeTruthy();
    });

    it("blames THIS machine for a dead link or DNS, and never the host", () => {
        for (const { stderr } of TRANSIENT_FIXTURES.filter((f) => f.cause === "no-network" || f.cause === "dns")) {
            expect(describeTransientSshStderr(sshStderrTail(stderr))).toContain("this machine");
        }
    });

    it("says the host is UP when it actively refused the port", () => {
        const message = describeTransientSshStderr(sshStderrTail("ssh: connect to host h port 22: Connection refused"));
        expect(message).toContain("UP");
    });

    it("refuses to pick a side when nothing answered - the whole point of the change", () => {
        const message = describeTransientSshStderr(sshStderrTail("ssh: connect to host h port 22: Connection timed out"));
        expect(message).toBe(SSH_NO_ANSWER_MESSAGE);
        // Still refuses to pick a side - an offline host and a dead local link
        // are indistinguishable from here - now in one clause instead of three.
        expect(message).toContain("the host is offline");
        expect(message).toContain("this machine cannot reach it");
    });

    it("returns null for stderr it does not recognise, and for empty stderr", () => {
        expect(matchTransientSshCause("")).toBeNull();
        expect(describeTransientSshStderr("")).toBeNull();
        expect(describeTransientSshStderr(sshStderrTail("some rsync noise nobody classified"))).toBeNull();
    });

    it("is purely explanatory: a permanent failure still classifies permanent", () => {
        // A cause match must never be read as "transient" on its own - only
        // isPermanentSshStderr decides retry, and an auth failure whose stderr
        // ALSO carries a reset line must stay permanent.
        const tail = sshStderrTail("Connection reset by peer\ndaan@h: Permission denied (publickey).");
        expect(matchTransientSshCause(tail)).toBe("dropped");
        expect(isPermanentSshStderr(tail)).toBe(true);
    });

    it("survives a 2 KiB control-character flood pushing the needle to the tail edge", () => {
        const tail = sshStderrTail(`${"\u0000".repeat(4000)}ssh: connect to host h port 22: Network is unreachable`);
        expect(tail.length).toBeLessThanOrEqual(2048);
        expect(matchTransientSshCause(tail)).toBe("no-network");
    });
});

describe("describeRemoteStderr", () => {
    // The archive host's `mkdir`/`mv`/`rm`/`ls`/`find`/`df` fail with an exit
    // code and one line of shell output. That line used to be passed through
    // verbatim, so `remote listing failed (exit 1): backupkit-remote: rejected`
    // told an operator that something was rejected and nothing more.
    it.each([
        ["backupkit-remote: rejected", "jail REFUSED this command"],
        ["mkdir: cannot create directory '/archive/x': Permission denied", "may not touch that path"],
        ["ls: cannot access '/archive': No such file or directory", "does not exist on the backup server"],
        ["mv: cannot move '/a' to '/b': Invalid cross-device link", "an archive root must be ONE filesystem"],
        ["cp: error writing '/archive/x': No space left on device", "filesystem is FULL"],
        ["mkdir: cannot create directory '/archive': Read-only file system", "mounted read-only"],
        ["rm: cannot remove '/archive/x': Directory not empty", "is not empty"],
        ["df: /archive: Input/output error", "disk may be failing"],
        ["ls: /archive: Stale file handle", "may need remounting"],
    ])("reads %s", (tail, expected) => {
        expect(describeRemoteStderr(tail)).toContain(expected);
    });

    it("is null when the tail says nothing recognisable", () => {
        expect(describeRemoteStderr("")).toBeNull();
        expect(describeRemoteStderr("some unrelated chatter")).toBeNull();
    });

    // Explanatory ONLY. Every needle here could miss and no run would be lost -
    // `isPermanentSshStderr` alone decides retriability, and it is deliberately
    // not consulted by this table.
    it("never changes what the retry loop does", () => {
        const tail = "mkdir: cannot create directory '/archive/x': Permission denied";
        expect(describeRemoteStderr(tail)).not.toBeNull();
        expect(isPermanentSshStderr(tail)).toBe(false);
    });
});
