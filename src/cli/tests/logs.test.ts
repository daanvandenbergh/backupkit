/**
 * `backupkit logs` argv-construction tables per platform against the fake
 * exec (no real journalctl/tail is ever spawned): default and explicit -n,
 * -f/--follow propagation, inherited stdio, child exit-code passthrough, and
 * the missing-source message with exit 1.
 */

import { describe, expect, it } from "vitest";

import { main } from "../main.js";
import { LAUNCHD_PLIST_PATH, MACOS_LOG_FILES, SYSTEMD_UNIT_PATH } from "../internal/service/units.js";
import { fakeDeps, makeExecResult } from "./fakes.js";

/** Fake deps with the systemd unit already installed (the normal Linux case). */
function linuxDeps(options: Parameters<typeof fakeDeps>[0] = {}): ReturnType<typeof fakeDeps> {
    return fakeDeps({ ...options, files: { [SYSTEMD_UNIT_PATH]: "[Unit]\n", ...options.files } });
}

describe("Linux (journalctl)", () => {
    it("tails the unit with the default 100 lines over inherited stdio", async () => {
        const h = linuxDeps();
        expect(await main(["logs"], h.deps)).toBe(0);
        expect(h.execCalls).toHaveLength(1);
        expect([h.execCalls[0].bin, ...h.execCalls[0].args]).toEqual(["journalctl", "-u", "backupkit", "-n", "100"]);
        expect(h.execCalls[0].options?.stdio).toBe("inherit");
        expect(h.execCalls[0].options?.timeoutMs).toBeUndefined();
    });

    it.each([
        [["logs", "-f"], ["journalctl", "-u", "backupkit", "-n", "100", "-f"]],
        [["logs", "--follow", "-n", "20"], ["journalctl", "-u", "backupkit", "-n", "20", "-f"]],
        [["logs", "--lines=7"], ["journalctl", "-u", "backupkit", "-n", "7"]],
    ])("%j builds %j", async (argv, expected) => {
        const h = linuxDeps();
        expect(await main(argv, h.deps)).toBe(0);
        expect([h.execCalls[0].bin, ...h.execCalls[0].args]).toEqual(expected);
    });

    it("passes the child's exit code through", async () => {
        const h = linuxDeps({ execResults: [{ match: (bin) => bin === "journalctl", result: makeExecResult({ exitCode: 3 }) }] });
        expect(await main(["logs"], h.deps)).toBe(3);
    });

    it("rejects a non-numeric -n with exit 64", async () => {
        const h = linuxDeps();
        expect(await main(["logs", "-n", "ten"], h.deps)).toBe(64);
        expect(h.err[0]).toContain("--lines takes a whole number");
        expect(h.execCalls).toEqual([]);
    });

    it("reports the not-installed message with exit 1 when the unit was never installed", async () => {
        const h = fakeDeps();
        expect(await main(["logs"], h.deps)).toBe(1);
        expect(h.err).toEqual([
            "No daemon logs found - the service is not installed. Register it with: sudo backupkit service install",
        ]);
        expect(h.execCalls).toEqual([]);
    });
});

describe("macOS (tail)", () => {
    it("tails the existing launchd log files", async () => {
        const h = fakeDeps({
            platform: "darwin",
            files: { [LAUNCHD_PLIST_PATH]: "<plist>", [MACOS_LOG_FILES[0]]: "log", [MACOS_LOG_FILES[1]]: "err" },
        });
        expect(await main(["logs", "-n", "50", "-f"], h.deps)).toBe(0);
        expect([h.execCalls[0].bin, ...h.execCalls[0].args]).toEqual([
            "tail",
            "-n",
            "50",
            "-f",
            "/var/log/backupkit/backupkit.log",
            "/var/log/backupkit/backupkit.err.log",
        ]);
        expect(h.execCalls[0].options?.stdio).toBe("inherit");
    });

    it("skips a missing file but still tails the other", async () => {
        const h = fakeDeps({ platform: "darwin", files: { [LAUNCHD_PLIST_PATH]: "<plist>", [MACOS_LOG_FILES[1]]: "err" } });
        expect(await main(["logs"], h.deps)).toBe(0);
        expect(h.execCalls[0].args).toEqual(["-n", "100", "/var/log/backupkit/backupkit.err.log"]);
    });

    it("reports the not-installed message with exit 1 when the plist is absent", async () => {
        const h = fakeDeps({ platform: "darwin" });
        expect(await main(["logs"], h.deps)).toBe(1);
        expect(h.err).toEqual([
            "No daemon logs found - the service is not installed. Register it with: sudo backupkit service install",
        ]);
        expect(h.execCalls).toEqual([]);
    });

    it("distinguishes installed-but-no-logs (crash-loop) from not-installed (as root)", async () => {
        const h = fakeDeps({ platform: "darwin", euid: 0, files: { [LAUNCHD_PLIST_PATH]: "<plist>" } });
        expect(await main(["logs"], h.deps)).toBe(1);
        expect(h.err).toEqual([
            "The service is installed but has written no logs yet - if it should be running, it may be failing to start. Check: backupkit service status",
        ]);
        expect(h.execCalls).toEqual([]);
    });

    it("a non-root operator who cannot read the root-owned logs is told to use sudo, not 'no logs'", async () => {
        // Log files read as absent because /var/log/backupkit is 0750 root:wheel.
        const h = fakeDeps({ platform: "darwin", euid: 501, files: { [LAUNCHD_PLIST_PATH]: "<plist>" } });
        expect(await main(["logs", "-f"], h.deps)).toBe(1);
        expect(h.err).toEqual(["The daemon logs are owned by root - re-run with sudo: sudo backupkit logs -f"]);
        expect(h.execCalls).toEqual([]);
    });
});
