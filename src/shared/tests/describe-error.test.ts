/**
 * `describeError` tests: the single conversion every log field, report field
 * and CLI message uses. Its job is that a person reading one line learns what
 * went wrong - not the class name of a TypeScript object, and not a bare errno.
 */

import { describe, expect, it } from "vitest";

import { describeError, errnoMeaning, SshError, SnapshotStoreError } from "../errors.js";

/** A node-shaped syscall error: a message plus the `code` node sets on it. */
function syscallError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

describe("describeError", () => {
    // Regression: the daemon log read `error="SshError: ssh alias ..."`. That
    // prefix is `String(error)` leaking a private class name into the one field
    // a person actually reads.
    it("never prefixes a backupkit error with its class name", () => {
        expect(describeError(new SshError("ssh archive timed out"))).toBe("ssh archive timed out");
        expect(describeError(new SnapshotStoreError("no partial snapshot to promote"))).toBe(
            "no partial snapshot to promote",
        );
    });

    it.each([
        ["ENOSPC", "ENOSPC: no space left on device, write", "the filesystem is FULL"],
        ["EACCES", "EACCES: permission denied, open '/archive/x'", "permission denied"],
        ["EXDEV", "EXDEV: cross-device link, rename '/a' -> '/b'", "DIFFERENT filesystems"],
        ["EROFS", "EROFS: read-only file system, mkdir '/archive'", "read-only"],
        ["EMLINK", "EMLINK: too many links, link '/a' -> '/b'", "hard-link limit"],
    ])("explains %s in the reader's terms", (_code, message, expected) => {
        const described = describeError(syscallError(_code, message));
        // The OS text is KEPT - it names the path and the syscall, which the
        // explanation deliberately does not.
        expect(described).toContain(message);
        expect(described).toContain(expected);
    });

    // A failed spawn is the one ENOENT that is NOT about a backup file: the
    // generic wording sent the reader looking for a missing directory when the
    // answer is that rsync or ssh is not installed at that path.
    it("says a missing PROGRAM when a spawn fails, not a missing file", () => {
        const described = describeError(syscallError("ENOENT", "spawn /opt/homebrew/bin/rsync ENOENT"));
        expect(described).toContain("that program is not installed, or is not at that path");
        expect(described).not.toContain("the file or directory does not exist");
    });

    it("leaves an unrecognised code as the OS wrote it rather than guessing", () => {
        const message = "ESOMETHING: a code this table has never heard of";
        expect(describeError(syscallError("ESOMETHING", message))).toBe(message);
        expect(errnoMeaning("ESOMETHING")).toBeNull();
    });

    it("never explains the same errno twice", () => {
        const meaning = errnoMeaning("ENOSPC") as string;
        const described = describeError(syscallError("ENOSPC", `write failed - ${meaning}`));
        expect(described.split(meaning)).toHaveLength(2);
    });

    it("handles values that are not Errors at all", () => {
        expect(describeError("a bare string")).toBe("a bare string");
        expect(describeError(undefined)).toBe("undefined");
        expect(describeError({ code: "ENOSPC" })).toContain("the filesystem is FULL");
    });

    // Control characters in a caught value can come from a remote peer's
    // stderr, and this is the last point before the logger's field grammar.
    it("sanitizes the message", () => {
        expect(describeError(new Error("line one\nforged=value"))).not.toContain("\n");
    });
});
