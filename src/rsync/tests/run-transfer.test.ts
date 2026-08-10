import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../../exec/exec.js";
import { Logger, type LogStream } from "../../shared/logger.js";
import type { Endpoint } from "../../shared/types.js";
import {
    dryRunStats,
    runTransfer,
    type ExecFn,
    type TransferAttempt,
    type TransferSpec,
} from "../rsync.js";

/** A parsable stats2 stdout for successful attempts. */
const STATS_OUT = [
    "Number of files: 100 (reg: 90, dir: 10)",
    "Number of regular files transferred: 12",
    "Total transferred file size: 4,096 bytes",
].join("\n");

/** Build one ExecResult with success defaults. */
function res(overrides?: Partial<ExecResult>): ExecResult {
    return { exitCode: 0, signal: null, stdout: STATS_OUT, stderr: "", timedOut: false, durationMs: 41, ...overrides };
}

/** A queued fake exec: call n gets results[n] (last repeats); records every call. */
function queuedExec(results: ExecResult[]): {
    fn: ExecFn;
    calls: { bin: string; args: readonly string[] }[];
} {
    const calls: { bin: string; args: readonly string[] }[] = [];
    const fn: ExecFn = async (bin, args) => {
        calls.push({ bin, args });
        return results[Math.min(calls.length - 1, results.length - 1)];
    };
    return { fn, calls };
}

/** A logger capturing every emitted line. */
function captureLogger(): { log: Logger; lines: string[] } {
    const lines: string[] = [];
    const sink: LogStream = {
        write(chunk: string) {
            lines.push(chunk);
        },
    };
    return { log: new Logger({ level: "debug", stdout: sink, stderr: sink }), lines };
}

/** A minimal local-to-local spec (retry wiring does not care about endpoints). */
function localSpec(): TransferSpec {
    return {
        src: { kind: "local", path: "/src" } satisfies Endpoint,
        dst: { kind: "local", path: "/store/t/2026-08-10T031500Z.partial" } satisfies Endpoint,
        options: {
            compress: true,
            bwlimit: null,
            ioTimeoutSec: 600,
            xattrs: false,
            preserveOwnership: true,
            preserveDevices: false,
            remoteRsyncBin: null,
        },
        exclude: [],
        sshTokens: [],
        linkDestBase: null,
        fakeSuper: false,
    };
}

/** Await settlement while advancing fake timers through every retry delay. */
async function settle<T>(promise: Promise<T>): Promise<{ ok?: T; err?: unknown }> {
    const settled = promise.then(
        (ok) => ({ ok }),
        (err) => ({ err }),
    );
    // 5 transfer delays cap at 300 s * 1.2 jitter each; 2,000,000 ms clears them all.
    await vi.advanceTimersByTimeAsync(2_000_000);
    return settled;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("runTransfer: retry wiring", () => {
    it("exit 10 then 0 -> exactly 2 attempts, success, both recorded", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 10, stderr: "error in socket IO" }), res()]);
        const { log, lines } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(calls).toHaveLength(2);
        expect(outcome.ok).toMatchObject({
            status: "success",
            stats: { filesTransferred: 12, totalFiles: 100, totalTransferredSize: 4096 },
            skippedFiles: [],
        });
        expect(outcome.ok?.attempts.map((a: TransferAttempt) => a.class)).toEqual(["transient", "ok"]);
        expect(lines.filter((l) => l.includes("transient failure, retrying"))).toHaveLength(1);
    });

    it("every attempt reuses the exact same argv - the same .partial destination", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 10 }), res()]);
        const { log } = captureLogger();
        await settle(runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }));
        expect(calls[1].args).toEqual(calls[0].args);
        expect(calls[0].args.at(-1)).toBe("/store/t/2026-08-10T031500Z.partial");
    });

    it("exit 10 five times -> 5 attempts then fatal, attemptLog carries all 5", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 10, stderr: "flaky" })]);
        const { log } = captureLogger();
        const attemptLog: TransferAttempt[] = [];
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn, attemptLog }),
        );
        expect(calls).toHaveLength(5);
        expect(attemptLog).toHaveLength(5);
        expect(outcome.err).toMatchObject({ code: "transfer", exitCode: 10, retriable: true });
    });

    it("retry.attempts 2 -> 2 attempts then fatal", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 10 })]);
        const { log } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 2, log, execFn: fn }),
        );
        expect(calls).toHaveLength(2);
        expect(outcome.err).toMatchObject({ code: "transfer" });
    });

    it("255 with a permanent ssh pattern -> exactly 1 attempt, no retry", async () => {
        const { fn, calls } = queuedExec([
            res({ exitCode: 255, stdout: "", stderr: "backup@h: Permission denied (publickey,password)." }),
        ]);
        const { log } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(calls).toHaveLength(1);
        expect(outcome.err).toMatchObject({ code: "transfer", exitCode: 255, retriable: false });
    });

    it("255 with garbage stderr stays transient and is retried", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 255, stderr: "Connection reset by peer" }), res()]);
        const { log } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(calls).toHaveLength(2);
        expect(outcome.ok?.status).toBe("success");
    });

    it("exit 23 -> single attempt, promote with warning, skipped paths extracted with the exclude hint", async () => {
        const stderr = [
            'rsync: [sender] send_files failed to open "/var/www/secret.txt": Permission denied (13)',
            'rsync: [sender] opendir "/var/www/protected" failed: Permission denied (13)',
            "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338)",
        ].join("\n");
        const { fn, calls } = queuedExec([res({ exitCode: 23, stderr })]);
        const { log, lines } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(calls).toHaveLength(1);
        expect(outcome.ok).toMatchObject({
            status: "warning",
            skippedFiles: ["/var/www/secret.txt", "/var/www/protected"],
        });
        expect(outcome.ok?.attempts[0].class).toBe("warning");
        expect(lines.some((l) => l.includes("exclude"))).toBe(true);
    });

    it("exit 23 caps the extracted paths at 100", async () => {
        const stderr = Array.from(
            { length: 150 },
            (_, i) => `rsync: [sender] send_files failed to open "/f/${i}": Permission denied (13)`,
        ).join("\n");
        const { fn } = queuedExec([res({ exitCode: 23, stderr })]);
        const { log } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(outcome.ok?.skippedFiles).toHaveLength(100);
    });

    it("exit 24 -> promote with warning, no skipped paths", async () => {
        const { fn } = queuedExec([res({ exitCode: 24, stderr: 'file has vanished: "/var/www/tmp.x"' })]);
        const { log, lines } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(outcome.ok).toMatchObject({ status: "warning", skippedFiles: [] });
        expect(lines.some((l) => l.includes("vanished"))).toBe(true);
    });

    it("exit 11 (disk) -> single attempt, surfaced as a disk error, never retried", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 11, stderr: "No space left on device (28)" })]);
        const { log } = captureLogger();
        const attemptLog: TransferAttempt[] = [];
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn, attemptLog }),
        );
        expect(calls).toHaveLength(1);
        expect(attemptLog[0].class).toBe("disk");
        expect(String((outcome.err as Error).message)).toMatch(/disk/);
    });

    it("a signal death is never retried (shutdown path)", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: null, signal: "SIGTERM", stdout: "" })]);
        const { log } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        expect(calls).toHaveLength(1);
        expect(outcome.err).toMatchObject({ code: "transfer", exitCode: null, retriable: false });
    });

    it("an already-aborted signal starts no attempt at all", async () => {
        const { fn, calls } = queuedExec([res()]);
        const { log } = captureLogger();
        const controller = new AbortController();
        controller.abort();
        const outcome = await settle(
            runTransfer({
                rsyncBin: "/bin/rsync",
                spec: localSpec(),
                retryAttempts: 5,
                log,
                execFn: fn,
                signal: controller.signal,
            }),
        );
        expect(calls).toHaveLength(0);
        expect(String((outcome.err as Error).message)).toContain("aborted");
    });

    it("stderr tails are sanitized before landing in the attempt record", async () => {
        const { fn } = queuedExec([res({ exitCode: 24, stderr: "line1\nline2\x1b[31mred\x1b[0m" })]);
        const { log } = captureLogger();
        const outcome = await settle(
            runTransfer({ rsyncBin: "/bin/rsync", spec: localSpec(), retryAttempts: 5, log, execFn: fn }),
        );
        const tail = outcome.ok?.attempts[0].stderrTail ?? "";
        expect(tail).not.toMatch(/[\n\x1b]/);
        expect(tail).toContain("line1line2");
    });
});

describe("dryRunStats", () => {
    it("runs an estimate-mode argv and returns the parsed delta", async () => {
        const { fn, calls } = queuedExec([res()]);
        const { log } = captureLogger();
        const outcome = await settle(dryRunStats({ rsyncBin: "/bin/rsync", spec: localSpec(), log, execFn: fn }));
        expect(outcome.ok).toEqual({ filesTransferred: 12, totalFiles: 100, totalTransferredSize: 4096 });
        expect(calls[0].args).toContain("--dry-run");
        expect(calls[0].args).not.toContain("--checksum");
    });

    it("a transient blip is absorbed by the control retry", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 10, stderr: "blip" }), res()]);
        const { log } = captureLogger();
        const outcome = await settle(dryRunStats({ rsyncBin: "/bin/rsync", spec: localSpec(), log, execFn: fn }));
        expect(calls).toHaveLength(2);
        expect(outcome.ok?.totalTransferredSize).toBe(4096);
    });

    it("gives up after the 3 control attempts", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 12, stderr: "stream error" })]);
        const { log } = captureLogger();
        const outcome = await settle(dryRunStats({ rsyncBin: "/bin/rsync", spec: localSpec(), log, execFn: fn }));
        expect(calls).toHaveLength(3);
        expect(outcome.err).toMatchObject({ code: "transfer", retriable: true });
    });

    it("tolerates exit 23 on the estimate pass (unreadable files surface in the real transfer)", async () => {
        const { fn } = queuedExec([res({ exitCode: 23, stderr: 'rsync: opendir "/x" failed' })]);
        const { log } = captureLogger();
        const outcome = await settle(dryRunStats({ rsyncBin: "/bin/rsync", spec: localSpec(), log, execFn: fn }));
        expect(outcome.ok?.totalTransferredSize).toBe(4096);
    });

    it("a hard failure is not retried", async () => {
        const { fn, calls } = queuedExec([res({ exitCode: 2, stderr: "protocol incompatibility" })]);
        const { log } = captureLogger();
        const outcome = await settle(dryRunStats({ rsyncBin: "/bin/rsync", spec: localSpec(), log, execFn: fn }));
        expect(calls).toHaveLength(1);
        expect(outcome.err).toMatchObject({ code: "transfer", retriable: false });
    });

    it("unparsable stats output is a permanent failure", async () => {
        const { fn } = queuedExec([res({ stdout: "no stats here" })]);
        const { log } = captureLogger();
        const outcome = await settle(dryRunStats({ rsyncBin: "/bin/rsync", spec: localSpec(), log, execFn: fn }));
        expect(String((outcome.err as Error).message)).toMatch(/no parsable/);
    });
});
