/**
 * `backupkit logs` argv-construction tables per platform against the fake
 * exec (no real journalctl/tail is ever spawned): default and explicit -n,
 * -f/--follow propagation, inherited stdio, child exit-code passthrough, and
 * the missing-source message with exit 1.
 */

import { describe, expect, it } from "vitest";

import { main } from "../main.js";
import { MACOS_LOG_FILES } from "../internal/service/units.js";
import { fakeDeps, makeExecResult } from "./fakes.js";

describe("Linux (journalctl)", () => {
    it("tails the unit with the default 100 lines over inherited stdio", async () => {
        const h = fakeDeps();
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
        const h = fakeDeps();
        expect(await main(argv, h.deps)).toBe(0);
        expect([h.execCalls[0].bin, ...h.execCalls[0].args]).toEqual(expected);
    });

    it("passes the child's exit code through", async () => {
        const h = fakeDeps({ execResults: [{ match: (bin) => bin === "journalctl", result: makeExecResult({ exitCode: 3 }) }] });
        expect(await main(["logs"], h.deps)).toBe(3);
    });

    it("rejects a non-numeric -n with exit 64", async () => {
        const h = fakeDeps();
        expect(await main(["logs", "-n", "ten"], h.deps)).toBe(64);
        expect(h.err[0]).toContain("--lines takes a whole number");
        expect(h.execCalls).toEqual([]);
    });
});

describe("macOS (tail)", () => {
    it("tails the existing launchd log files", async () => {
        const h = fakeDeps({
            platform: "darwin",
            files: { [MACOS_LOG_FILES[0]]: "log", [MACOS_LOG_FILES[1]]: "err" },
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
        const h = fakeDeps({ platform: "darwin", files: { [MACOS_LOG_FILES[1]]: "err" } });
        expect(await main(["logs"], h.deps)).toBe(0);
        expect(h.execCalls[0].args).toEqual(["-n", "100", "/var/log/backupkit/backupkit.err.log"]);
    });

    it("reports the missing-source message with exit 1 when no log file exists", async () => {
        const h = fakeDeps({ platform: "darwin" });
        expect(await main(["logs"], h.deps)).toBe(1);
        expect(h.err).toEqual(["no daemon logs found - is the service installed? (backupkit service install)"]);
        expect(h.execCalls).toEqual([]);
    });
});
