/**
 * Dispatch and exit-code tests for the CLI entry: bare-invocation help, the
 * command x flag matrix (unknown flags = exit 64 listing valid flags,
 * --flag=value forms, the `ls` alias, --json scope), --version, per-command
 * --help, and the error -> exit-code mapping table (ConfigError 2,
 * LockHeldError 3, generic 1, usage 64) with the `error <CODE>: message`
 * stderr format.
 */

import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ConfigError, LockHeldError, SshError } from "../../shared/errors.js";
import { isEntryPoint, main } from "../main.js";
import { fakeDeps } from "./fakes.js";

describe("bare invocation and global flags", () => {
    it("prints the 3-step help and exits 0 with no arguments", async () => {
        const h = fakeDeps();
        expect(await main([], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(text).toContain("Setup (3 steps):");
        expect(text).toContain("1. backupkit init");
        expect(text).toContain("2. backupkit check");
        expect(text).toContain("3. backupkit service install");
        expect(text).toContain("alias: ls");
        expect(text).toContain("backupkit <command> --help for details.");
    });

    it.each([["--help"], ["-h"], ["help"]])("prints the same help for %s", async (flag) => {
        const h = fakeDeps();
        expect(await main([flag], h.deps)).toBe(0);
        expect(h.out.join("\n")).toContain("Setup (3 steps):");
    });

    it("prints the package version for --version", async () => {
        const h = fakeDeps();
        expect(await main(["--version"], h.deps)).toBe(0);
        expect(h.out).toEqual(["0.1.0-test"]);
    });

    it("rejects an unknown command with exit 64 listing the valid names", async () => {
        const h = fakeDeps();
        expect(await main(["frobnicate"], h.deps)).toBe(64);
        expect(h.err[0]).toContain('Error: unknown command "frobnicate"');
        for (const name of ["run", "daemon", "service", "logs", "list", "ls", "status", "restore", "prune", "check", "init"]) {
            expect(h.err[0]).toContain(name);
        }
    });

    // The dispatch table is a plain object literal, so `COMMANDS["toString"]`
    // is an INHERITED function: an `=== undefined` guard waved it through and
    // CALLED it with (rest, deps). Against the real bin, `backupkit toString`
    // exited 1 with an unhandled ERR_INVALID_ARG_TYPE rejection instead of the
    // usage exit 64; `constructor` returned [] and "succeeded".
    it.each([["toString"], ["constructor"], ["valueOf"], ["hasOwnProperty"], ["__proto__"], ["isPrototypeOf"]])(
        "treats the inherited Object.prototype member %s as an unknown command",
        async (name) => {
            const h = fakeDeps();
            expect(await main([name], h.deps)).toBe(64);
            expect(h.err[0]).toContain(`Error: unknown command "${name}"`);
            expect(h.engine.calls).toEqual([]);
        },
    );
});

describe("per-command --help", () => {
    it.each([
        ["run"],
        ["daemon"],
        ["service"],
        ["logs"],
        ["list"],
        ["status"],
        ["restore"],
        ["prune"],
        ["check"],
        ["init"],
    ])("%s --help prints usage and exits 0 without touching the engine", async (command) => {
        const h = fakeDeps();
        expect(await main([command, "--help"], h.deps)).toBe(0);
        expect(h.out.join("\n")).toContain(`backupkit ${command === "list" ? "list" : command}`);
        expect(h.engine.calls).toEqual([]);
    });
});

describe("unknown flags exit 64 listing the valid flags", () => {
    it.each([
        ["run", "--json"],
        ["prune", "--json"],
        ["check", "--json"],
        ["logs", "--json"],
        ["service", "--json"],
        ["run", "--bogus"],
        ["status", "--force"],
        ["list", "--follow"],
    ])("%s %s", async (command, flag) => {
        const h = fakeDeps();
        expect(await main([command, flag], h.deps)).toBe(64);
        expect(h.err[0]).toContain("Error:");
        expect(h.err[0]).toContain("valid flags:");
        expect(h.err[0]).toContain("--config");
        expect(h.engine.calls).toEqual([]);
    });
});

describe("flag forms and the ls alias", () => {
    it("accepts --config=value and --config value identically", async () => {
        for (const argv of [["status", "--config=/x/config.jsonc"], ["status", "--config", "/x/config.jsonc"]]) {
            const h = fakeDeps();
            expect(await main(argv, h.deps)).toBe(0);
            expect(h.loadedWith).toEqual(["/x/config.jsonc"]);
        }
    });

    it("dispatches ls to the list command", async () => {
        const h = fakeDeps();
        expect(await main(["ls"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).toEqual(["listSnapshots"]);
    });

    it("passes positional targets through and rejects an unknown target with exit 64", async () => {
        const good = fakeDeps();
        expect(await main(["status", "web"], good.deps)).toBe(0);
        expect(good.engine.calls[0]).toEqual({ method: "status", options: { targets: ["web"] } });

        const bad = fakeDeps();
        expect(await main(["status", "nope"], bad.deps)).toBe(64);
        expect(bad.err[0]).toContain('unknown target "nope"');
        expect(bad.err[0]).toContain("web");
        expect(bad.engine.calls).toEqual([]);
    });
});

describe("exit-code mapping", () => {
    it.each([
        [new ConfigError("bad config"), 2, "Error: bad config"],
        [new LockHeldError("lock held by pid 7"), 3, "Error: lock held by pid 7"],
        [new SshError("host down"), 1, "Error: host down"],
        [new Error("boom"), 1, "Error: boom"],
    ])("engine failure %#: exit %i with formatted stderr", async (error, code, line) => {
        const h = fakeDeps();
        h.engine.failure = error as Error;
        expect(await main(["status"], h.deps)).toBe(code);
        expect(h.err).toEqual([line]);
    });

    it("maps a config-load failure to exit 2", async () => {
        const h = fakeDeps({ loadFailure: new ConfigError("/etc/backupkit/config.jsonc:3: targets: missing") });
        expect(await main(["run"], h.deps)).toBe(2);
        expect(h.err[0]).toBe("Error: /etc/backupkit/config.jsonc:3: targets: missing");
    });

    it("prints a stack trace only when debug is enabled", async () => {
        const quiet = fakeDeps();
        quiet.engine.failure = new SshError("host down");
        await main(["status"], quiet.deps);
        expect(quiet.err.join("\n")).not.toContain("at ");

        const loud = fakeDeps();
        loud.engine.failure = new SshError("host down");
        loud.deps.debugEnabled = true;
        await main(["status"], loud.deps);
        expect(loud.err.join("\n")).toContain("SshError: host down");
    });
});

/**
 * The bin is ALWAYS reached through a symlink in a real install, and node
 * reports `import.meta.url` as the realpath while leaving `argv[1]` as
 * invoked. Before `isEntryPoint` resolved that, `main()` never ran off a
 * symlink: every command - `--version`, `service start`, all of them - exited
 * 0 having printed nothing at all. Nothing in-process catches that, so this is
 * the test that does.
 */
describe("bin entry detection", () => {
    it("matches the module's own path", () => {
        expect(isEntryPoint(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
    });

    it("matches a symlink pointing at the module, as every install does", () => {
        const link = join(mkdtempSync(join(tmpdir(), "backupkit-entry-")), "backupkit");
        symlinkSync(fileURLToPath(import.meta.url), link);
        expect(isEntryPoint(import.meta.url, link)).toBe(true);
    });

    it("does not match another script, an unresolvable path, or no argv[1]", () => {
        expect(isEntryPoint(import.meta.url, join(tmpdir(), "some-other-script.js"))).toBe(false);
        expect(isEntryPoint(import.meta.url, undefined)).toBe(false);
    });
});
