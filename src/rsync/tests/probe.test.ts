import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../../exec/exec.js";
import { Logger } from "../../shared/logger.js";
import { clearRemoteVersionCache, probeLocalRsync, probeRemoteRsync, type ExecFn } from "../rsync.js";

/** Build one ExecResult with success defaults. */
function res(overrides?: Partial<ExecResult>): ExecResult {
    return {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 5,
        truncated: false,
        ...overrides,
    };
}

/** A silent logger (retry warns go nowhere). */
const silentLog = new Logger({ level: "error", stdout: { write() {} }, stderr: { write() {} } });

const GOOD_BANNER = "rsync  version 3.2.7  protocol version 31\nCopyright (C) 1996-2022 by Andrew Tridgell\n";
const FLOOR_BANNER = "rsync  version 3.2.5  protocol version 31\n";
const V_PREFIX_BANNER = "rsync  version v3.4.1  protocol version 32\n";
const OLD_BANNER = "rsync  version 2.6.9  protocol version 29\n";
const OPENRSYNC_BANNER = "openrsync: protocol version 29\nrsync version 2.6.9 compatible\n";

/** Fake exec whose behavior is keyed by binary path; records every call. */
function fakeExecByBin(
    behavior: Record<string, ExecResult | "ENOENT">,
): { fn: ExecFn; calls: { bin: string; args: readonly string[] }[] } {
    const calls: { bin: string; args: readonly string[] }[] = [];
    const fn: ExecFn = async (bin, args) => {
        calls.push({ bin, args });
        const outcome = behavior[bin];
        if (outcome === undefined || outcome === "ENOENT") {
            throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT" });
        }
        return outcome;
    };
    return { fn, calls };
}

describe("probeLocalRsync", () => {
    it("accepts a good override and reports its version", async () => {
        const { fn, calls } = fakeExecByBin({ "/x/rsync": res({ stdout: GOOD_BANNER }) });
        await expect(probeLocalRsync("/x/rsync", fn)).resolves.toEqual({ bin: "/x/rsync", version: "3.2.7" });
        expect(calls).toEqual([{ bin: "/x/rsync", args: ["--version"] }]);
    });

    it("accepts exactly the 3.2.5 floor", async () => {
        const { fn } = fakeExecByBin({ "/x/rsync": res({ stdout: FLOOR_BANNER }) });
        await expect(probeLocalRsync("/x/rsync", fn)).resolves.toMatchObject({ version: "3.2.5" });
    });

    it('accepts a "version v3.4.1" style banner', async () => {
        const { fn } = fakeExecByBin({ "/x/rsync": res({ stdout: V_PREFIX_BANNER }) });
        await expect(probeLocalRsync("/x/rsync", fn)).resolves.toMatchObject({ version: "3.4.1" });
    });

    it("walks the discovery order: /opt/homebrew, /usr/local, then PATH", async () => {
        const { fn, calls } = fakeExecByBin({ "/usr/local/bin/rsync": res({ stdout: GOOD_BANNER }) });
        await expect(probeLocalRsync(null, fn)).resolves.toEqual({ bin: "/usr/local/bin/rsync", version: "3.2.7" });
        expect(calls.map((c) => c.bin)).toEqual(["/opt/homebrew/bin/rsync", "/usr/local/bin/rsync"]);
    });

    it("falls through to bare PATH rsync last", async () => {
        const { fn, calls } = fakeExecByBin({ rsync: res({ stdout: GOOD_BANNER }) });
        await expect(probeLocalRsync(null, fn)).resolves.toEqual({ bin: "rsync", version: "3.2.7" });
        expect(calls.map((c) => c.bin)).toEqual(["/opt/homebrew/bin/rsync", "/usr/local/bin/rsync", "rsync"]);
    });

    it("names every candidate and the fix when nothing is installed", async () => {
        const { fn } = fakeExecByBin({});
        await expect(probeLocalRsync(null, fn)).rejects.toThrow(/no rsync binary found.*brew install rsync/s);
    });

    it("refuses the first existing candidate when it is too old - no silent fallthrough", async () => {
        const { fn, calls } = fakeExecByBin({
            "/opt/homebrew/bin/rsync": res({ stdout: OLD_BANNER }),
            "/usr/local/bin/rsync": res({ stdout: GOOD_BANNER }),
        });
        await expect(probeLocalRsync(null, fn)).rejects.toThrow(
            /\/opt\/homebrew\/bin\/rsync is rsync 2\.6\.9, below the required floor 3\.2\.5/,
        );
        expect(calls.map((c) => c.bin)).toEqual(["/opt/homebrew/bin/rsync"]);
    });

    it("refuses openrsync with the actionable message", async () => {
        const { fn } = fakeExecByBin({ "/x/rsync": res({ stdout: OPENRSYNC_BANNER }) });
        await expect(probeLocalRsync("/x/rsync", fn)).rejects.toThrow(/openrsync.*brew install rsync/s);
    });

    it("refuses an unrecognizable banner", async () => {
        const { fn } = fakeExecByBin({ "/x/rsync": res({ stdout: "something else entirely" }) });
        await expect(probeLocalRsync("/x/rsync", fn)).rejects.toThrow(/recognizable rsync version/);
    });

    it("refuses a binary whose --version fails", async () => {
        const { fn } = fakeExecByBin({ "/x/rsync": res({ exitCode: 1, stderr: "boom" }) });
        await expect(probeLocalRsync("/x/rsync", fn)).rejects.toThrow(/--version failed \(exit 1\)/);
    });
});

describe("probeRemoteRsync", () => {
    beforeEach(() => {
        clearRemoteVersionCache();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** A queued fake runner: each call consumes the next result (last repeats). */
    function fakeRunner(results: ExecResult[]): { run: (argv: readonly string[]) => Promise<ExecResult>; calls: (readonly string[])[] } {
        const calls: (readonly string[])[] = [];
        return {
            calls,
            run: async (argv) => {
                calls.push(argv);
                return results[Math.min(calls.length - 1, results.length - 1)];
            },
        };
    }

    /** Run a probe to settlement while advancing fake timers through any retry delays. */
    async function settle<T>(promise: Promise<T>): Promise<{ ok?: T; err?: unknown }> {
        const settled = promise.then(
            (ok) => ({ ok }),
            (err) => ({ err }),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        return settled;
    }

    it("parses a good remote banner and probes with the default bin", async () => {
        const runner = fakeRunner([res({ stdout: GOOD_BANNER })]);
        const outcome = await settle(
            probeRemoteRsync({ identity: "backup@h:22", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(outcome.ok).toBe("3.2.7");
        expect(runner.calls).toEqual([["rsync", "--version"]]);
    });

    it("uses remoteRsyncBin when set", async () => {
        const runner = fakeRunner([res({ stdout: GOOD_BANNER })]);
        await settle(
            probeRemoteRsync({ identity: "a", runRemote: runner.run, remoteRsyncBin: "/opt/bin/rsync", log: silentLog }),
        );
        expect(runner.calls).toEqual([["/opt/bin/rsync", "--version"]]);
    });

    it("caches a success per identity: the second probe never touches the runner", async () => {
        const runner = fakeRunner([res({ stdout: GOOD_BANNER })]);
        const params = { identity: "backup@h:22", runRemote: runner.run, remoteRsyncBin: null, log: silentLog };
        await settle(probeRemoteRsync(params));
        const second = await settle(probeRemoteRsync(params));
        expect(second.ok).toBe("3.2.7");
        expect(runner.calls).toHaveLength(1);
    });

    // remoteRsyncBin is per TARGET, not per remote: two targets can share one
    // host and point --rsync-path at different binaries. A host-only cache key
    // would let the first target's result stand in for the second's, so a
    // binary the transfer really uses would never meet the 3.2.5 floor.
    it("probes each binary on one host separately, and refuses an old one the other host entry accepted", async () => {
        const runner = fakeRunner([res({ stdout: GOOD_BANNER }), res({ stdout: OLD_BANNER })]);
        const identity = "backup@h:22";
        const modern = await settle(
            probeRemoteRsync({ identity, runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(modern.ok).toBe("3.2.7");
        const legacy = await settle(
            probeRemoteRsync({
                identity,
                runRemote: runner.run,
                remoteRsyncBin: "/opt/legacy/bin/rsync",
                log: silentLog,
            }),
        );
        expect(runner.calls).toHaveLength(2);
        expect(runner.calls[1][0]).toBe("/opt/legacy/bin/rsync");
        expect(String((legacy.err as Error).message)).toContain("below the required floor 3.2.5");
    });

    it("still caches per host+binary: the same pair never re-probes", async () => {
        const runner = fakeRunner([res({ stdout: GOOD_BANNER })]);
        const params = { identity: "backup@h:22", runRemote: runner.run, remoteRsyncBin: "/opt/x/rsync", log: silentLog };
        await settle(probeRemoteRsync(params));
        expect((await settle(probeRemoteRsync(params))).ok).toBe("3.2.7");
        expect(runner.calls).toHaveLength(1);
    });

    it("probes distinct identities separately", async () => {
        const runner = fakeRunner([res({ stdout: GOOD_BANNER })]);
        await settle(probeRemoteRsync({ identity: "a", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }));
        await settle(probeRemoteRsync({ identity: "b", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }));
        expect(runner.calls).toHaveLength(2);
    });

    it("retries a transient 255 blip and succeeds without failing the host", async () => {
        const runner = fakeRunner([res({ exitCode: 255, stderr: "Connection reset by peer" }), res({ stdout: GOOD_BANNER })]);
        const outcome = await settle(
            probeRemoteRsync({ identity: "flaky", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(outcome.ok).toBe("3.2.7");
        expect(runner.calls).toHaveLength(2);
    });

    it("gives up after the 3 control attempts when the blip persists", async () => {
        const runner = fakeRunner([res({ exitCode: 255, stderr: "Connection timed out" })]);
        const outcome = await settle(
            probeRemoteRsync({ identity: "down", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(outcome.err).toMatchObject({ code: "ssh", retriable: true });
        expect(runner.calls).toHaveLength(3);
    });

    it("a permanent ssh pattern is never retried", async () => {
        const runner = fakeRunner([res({ exitCode: 255, stderr: "backup@h: Permission denied (publickey)." })]);
        const outcome = await settle(
            probeRemoteRsync({ identity: "authfail", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(outcome.err).toMatchObject({ code: "ssh", retriable: false });
        expect(runner.calls).toHaveLength(1);
    });

    it("exit 127 (rsync missing on remote) is a permanent, actionable refusal", async () => {
        const runner = fakeRunner([res({ exitCode: 127, stderr: "rsync: command not found" })]);
        const outcome = await settle(
            probeRemoteRsync({ identity: "norsync", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(String((outcome.err as Error).message)).toMatch(/not found on norsync.*remoteRsyncBin/s);
        expect(runner.calls).toHaveLength(1);
    });

    it("a remote below the floor is refused, never retried, and not cached", async () => {
        const runner = fakeRunner([res({ stdout: OLD_BANNER })]);
        const params = { identity: "old", runRemote: runner.run, remoteRsyncBin: null, log: silentLog };
        const first = await settle(probeRemoteRsync(params));
        expect(String((first.err as Error).message)).toMatch(/2\.6\.9.*3\.2\.5/s);
        expect(runner.calls).toHaveLength(1);
        // Failure is not cached: a later run re-probes (and may find a fixed host).
        await settle(probeRemoteRsync(params));
        expect(runner.calls).toHaveLength(2);
    });

    it("remote openrsync is refused", async () => {
        const runner = fakeRunner([res({ stdout: OPENRSYNC_BANNER })]);
        const outcome = await settle(
            probeRemoteRsync({ identity: "mac", runRemote: runner.run, remoteRsyncBin: null, log: silentLog }),
        );
        expect(String((outcome.err as Error).message)).toContain("openrsync");
    });
});
