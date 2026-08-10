import { describe, expect, it } from "vitest";
import {
    BackupkitError,
    ConfigError,
    DiskSpaceError,
    LockHeldError,
    RestoreError,
    SnapshotStoreError,
    SshError,
    TransferError,
    isBackupkitError,
} from "../errors.js";

describe("error hierarchy", () => {
    it.each([
        ["ConfigError", new ConfigError("boom"), "config"],
        ["SshError", new SshError("boom"), "ssh"],
        ["TransferError", new TransferError("boom", { exitCode: 10, retriable: true, stderrTail: "" }), "transfer"],
        ["SnapshotStoreError", new SnapshotStoreError("boom"), "snapshot-store"],
        ["LockHeldError", new LockHeldError("boom"), "lock-held"],
        ["DiskSpaceError", new DiskSpaceError("boom", { requiredBytes: 1, freeBytes: 0 }), "disk-space"],
        ["RestoreError", new RestoreError("boom"), "restore"],
    ] as const)("%s carries code %s, its class name, and the message", (name, error, code) => {
        expect(error.code).toBe(code);
        expect(error.name).toBe(name);
        expect(error.message).toBe("boom");
        expect(error).toBeInstanceOf(BackupkitError);
        expect(error).toBeInstanceOf(Error);
    });

    it("ConfigError carries file, line, and path payload", () => {
        const error = new ConfigError("x", { file: "/etc/backupkit/config.jsonc", line: 12, path: "targets.web" });
        expect(error.file).toBe("/etc/backupkit/config.jsonc");
        expect(error.line).toBe(12);
        expect(error.path).toBe("targets.web");
    });

    it("ConfigError payload defaults to null", () => {
        const error = new ConfigError("x");
        expect(error.file).toBeNull();
        expect(error.line).toBeNull();
        expect(error.path).toBeNull();
    });

    it("SshError retriable defaults to false and is settable", () => {
        expect(new SshError("x").retriable).toBe(false);
        expect(new SshError("x", { retriable: true }).retriable).toBe(true);
    });

    it("TransferError carries exitCode, retriable, and stderrTail", () => {
        const error = new TransferError("x", { exitCode: 255, retriable: false, stderrTail: "denied" });
        expect(error.exitCode).toBe(255);
        expect(error.retriable).toBe(false);
        expect(error.stderrTail).toBe("denied");
    });

    it("TransferError accepts a null exit code (signal death)", () => {
        expect(new TransferError("x", { exitCode: null, retriable: true, stderrTail: "" }).exitCode).toBeNull();
    });

    it("LockHeldError carries pid and hostname, defaulting to null", () => {
        const full = new LockHeldError("x", { pid: 42, hostname: "web1" });
        expect(full.pid).toBe(42);
        expect(full.hostname).toBe("web1");
        const empty = new LockHeldError("x");
        expect(empty.pid).toBeNull();
        expect(empty.hostname).toBeNull();
    });

    it("DiskSpaceError carries requiredBytes and freeBytes", () => {
        const error = new DiskSpaceError("x", { requiredBytes: 100, freeBytes: 7 });
        expect(error.requiredBytes).toBe(100);
        expect(error.freeBytes).toBe(7);
    });
});

describe("isBackupkitError", () => {
    it.each([
        ["a ConfigError", new ConfigError("x")],
        ["an SshError", new SshError("x")],
        ["a TransferError", new TransferError("x", { exitCode: 0, retriable: false, stderrTail: "" })],
    ] as const)("accepts %s", (_label, error) => {
        expect(isBackupkitError(error)).toBe(true);
    });

    it("accepts a branded duck-typed error from a duplicated package instance", () => {
        expect(isBackupkitError({ isBackupkitError: true, code: "ssh", message: "x" })).toBe(true);
    });

    it.each([
        ["a plain Error", new Error("x")],
        ["null", null],
        ["undefined", undefined],
        ["a string", "boom"],
        ["a number", 3],
        ["an unbranded object", { code: "ssh" }],
        ["a wrongly branded object", { isBackupkitError: "yes", code: "ssh" }],
        ["a brand without a code", { isBackupkitError: true }],
    ] as const)("rejects %s", (_label, value) => {
        expect(isBackupkitError(value)).toBe(false);
    });

    it("narrows the type so code is readable in a catch", () => {
        const value: unknown = new SshError("x", { retriable: true });
        if (isBackupkitError(value)) {
            expect(value.code).toBe("ssh");
        } else {
            expect.unreachable("guard must accept an SshError");
        }
    });
});
