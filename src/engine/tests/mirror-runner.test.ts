/**
 * State-machine tests for the MIRROR pipeline against fake transfer/estimate
 * functions: the in-place destination (no snapshot subdirectory, no `.partial`,
 * no `--link-dest`), window dedup from the run reports, the pre-transfer
 * collapse guard and its `--force` override, dry-run, verify, and abort.
 *
 * The load-bearing one is "refuses BEFORE the transfer": a mirror runs
 * `--delete --force` against a live tree, so a guard that fires afterwards -
 * the way the snapshot pipeline's does - would fire over an already-deleted
 * archive.
 */

import { describe, expect, it } from "vitest";

import { TransferError } from "../../shared/errors.js";
import type { dryRunStats, runTransfer, TransferResult } from "../../rsync/rsync.js";
import { runMirror, type MirrorRunnerDeps } from "../internal/target-runner.js";
import { captureLogger, makeExecResult, makeStats, makeTarget, makeTransferResult } from "./fakes.js";
import type { RunStats } from "../types.js";

/** Fixed run instant. */
const NOW = new Date("2026-08-10T12:00:00.000Z");

/** An hourly mirror target: local source, local destination, nothing else set. */
function mirrorTarget(overrides: Parameters<typeof makeTarget>[0] = {}) {
    return makeTarget({
        name: "persistance",
        mode: "mirror",
        retention: null,
        minFree: null,
        destination: "/Volumes/persistance",
        dst: { kind: "local", path: "/Volumes/persistance" },
        schedule: { interval: "hour", intervalCount: 1, at: "00:00", on: "mon", dayOfMonth: 1 },
        ...overrides,
    });
}

/** A fake transfer resolving with `outcome` (or throwing it), recording its params. */
function fakeTransfer(outcome: TransferResult | Error, seen: unknown[] = []): typeof runTransfer {
    return async (params) => {
        seen.push(params);
        if (outcome instanceof Error) {
            throw outcome;
        }
        for (const attempt of outcome.attempts) {
            params.attemptLog?.push(attempt);
        }
        return outcome;
    };
}

/** A fake estimator reporting `totalFiles`, counting its invocations. */
function fakeEstimate(totalFiles: number, counter = { calls: 0 }): typeof dryRunStats {
    return async () => {
        counter.calls += 1;
        return makeStats({ totalFiles, totalTransferredSize: 1000 });
    };
}

/** A previous-run stats fixture with the given file count. */
function previous(totalFiles: number): RunStats {
    return { filesTransferred: 1, bytesTransferred: 1, totalFiles, deltaBytes: 1 };
}

/** Mirror runner deps with quiet defaults (never ran before, nothing to compare against). */
function makeDeps(overrides: Partial<MirrorRunnerDeps> = {}): MirrorRunnerDeps {
    return {
        log: captureLogger().log,
        now: () => NOW,
        rsyncBin: "/fake/rsync",
        sshTokens: [],
        env: undefined,
        transfer: fakeTransfer(makeTransferResult()),
        estimate: fakeEstimate(10),
        execFn: async () => makeExecResult(),
        previousStats: async () => null,
        lastRunAt: async () => null,
        ...overrides,
    };
}

describe("runMirror pipeline", () => {
    it("transfers into the destination itself: no target subdirectory, no .partial, no link-dest", async () => {
        const seen: { spec: { linkDestBase: string | null; dst: { kind: string; path: string } } }[] = [];
        const report = await runMirror(mirrorTarget(), makeDeps({ transfer: fakeTransfer(makeTransferResult(), seen) }));
        expect(report.status).toBe("success");
        expect(seen[0].spec.dst).toEqual({ kind: "local", path: "/Volumes/persistance" });
        expect(seen[0].spec.linkDestBase).toBeNull();
    });

    it("reports no snapshot, no history count, and the run's own id", async () => {
        const report = await runMirror(mirrorTarget(), makeDeps());
        expect(report.snapshot).toBeNull();
        expect(report.completeCount).toBeNull();
        expect(report.historyInsertion).toBeNull();
        expect(report.contentCollapse).toBeNull();
        expect(report.runId).toBe("2026-08-10T120000Z_persistance");
        expect(report.stats).toEqual({
            filesTransferred: 3,
            bytesTransferred: 1000,
            totalFiles: 10,
            deltaBytes: 1000,
        });
    });

    it("skips when a run already fulfilled the current schedule window", async () => {
        const seen: unknown[] = [];
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(makeTransferResult(), seen),
                lastRunAt: async () => new Date("2026-08-10T12:30:00.000Z"),
            }),
        );
        expect(report.status).toBe("skipped");
        expect(report.reason).toBe("window");
        expect(seen).toHaveLength(0);
    });

    it("runs when the last run fell in an earlier window", async () => {
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({ lastRunAt: async () => new Date("2026-08-10T11:59:00.000Z") }),
        );
        expect(report.status).toBe("success");
    });

    it("force bypasses the window dedup", async () => {
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({ lastRunAt: async () => new Date("2026-08-10T12:30:00.000Z") }),
            { force: true },
        );
        expect(report.status).toBe("success");
    });

    // The whole reason the guard moved ahead of the transfer: an unmounted
    // source volume presents an (almost) empty tree, and `--delete --force`
    // against a live destination cannot be undone afterwards.
    it("refuses BEFORE transferring when the source collapsed against the last run", async () => {
        const seen: unknown[] = [];
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(makeTransferResult(), seen),
                estimate: fakeEstimate(4),
                previousStats: async () => previous(100),
            }),
        );
        expect(report.status).toBe("failed");
        expect(report.reason).toBe("content-collapse");
        expect(report.contentCollapse).toEqual({ previousFiles: 100, files: 4 });
        expect(seen).toHaveLength(0);
    });

    it("does not trip on a shrink above the halving threshold", async () => {
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({ estimate: fakeEstimate(50), previousStats: async () => previous(100) }),
        );
        expect(report.status).toBe("success");
        expect(report.contentCollapse).toBeNull();
    });

    it("has nothing to compare against on a first run", async () => {
        const report = await runMirror(mirrorTarget(), makeDeps({ estimate: fakeEstimate(0) }));
        expect(report.status).toBe("success");
    });

    it("force is the operator's override for a real shrink", async () => {
        const seen: unknown[] = [];
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(makeTransferResult(), seen),
                estimate: fakeEstimate(1),
                previousStats: async () => previous(100),
            }),
            { force: true },
        );
        expect(report.status).toBe("success");
        expect(report.contentCollapse).toBeNull();
        expect(seen).toHaveLength(1);
    });

    it("a dry run estimates and transfers nothing", async () => {
        const seen: unknown[] = [];
        const counter = { calls: 0 };
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({ transfer: fakeTransfer(makeTransferResult(), seen), estimate: fakeEstimate(10, counter) }),
            { dryRun: true },
        );
        expect(report.status).toBe("success");
        expect(report.reason).toBe("dry-run");
        expect(counter.calls).toBe(1);
        expect(seen).toHaveLength(0);
    });

    // The refusal is exactly what an operator runs --dry-run to find out about.
    it("a dry run REPORTS a collapse instead of failing on it", async () => {
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({ estimate: fakeEstimate(1), previousStats: async () => previous(100) }),
            { dryRun: true },
        );
        expect(report.status).toBe("success");
        expect(report.reason).toBe("dry-run");
        expect(report.contentCollapse).toEqual({ previousFiles: 100, files: 1 });
    });

    it("an estimate that fails fails the run without transferring", async () => {
        const seen: unknown[] = [];
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(makeTransferResult(), seen),
                estimate: async () => {
                    throw new TransferError("sizing up the changes produced no parsable rsync stats output", {
                        exitCode: 0,
                        retriable: false,
                        stderrTail: "",
                    });
                },
            }),
        );
        expect(report.status).toBe("failed");
        expect(report.error).toContain("no parsable rsync stats");
        expect(seen).toHaveLength(0);
    });

    it("a failed transfer is a failed report carrying its attempts", async () => {
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(
                    new TransferError("rsync: connection unexpectedly closed", {
                        exitCode: 12,
                        retriable: true,
                        stderrTail: "",
                    }),
                ),
            }),
        );
        expect(report.status).toBe("failed");
        expect(report.error).toContain("connection unexpectedly closed");
    });

    it("announces the run once it is really starting, naming both ends", async () => {
        const { log, lines } = captureLogger();
        await runMirror(mirrorTarget({ src: { kind: "local", path: "/Users/dan/persistance" } }), makeDeps({ log }));
        expect(lines.some((line) => line.includes("backing up /Users/dan/persistance -> /Volumes/persistance"))).toBe(
            true,
        );
        expect(lines.some((line) => line.includes("backup finished"))).toBe(true);
    });

    it("does not announce a backup it is not making (window skip)", async () => {
        const { log, lines } = captureLogger();
        await runMirror(mirrorTarget(), makeDeps({ log, lastRunAt: async () => NOW }));
        expect(lines.some((line) => line.includes("backing up"))).toBe(false);
    });

    it("says it is only checking on a dry run", async () => {
        const { log, lines } = captureLogger();
        await runMirror(mirrorTarget(), makeDeps({ log }), { dryRun: true, force: true });
        expect(lines.some((line) => line.includes("dry run: checking /"))).toBe(true);
    });

    it("promotes exit 23 to a warning report and keeps the skipped paths", async () => {
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(makeTransferResult({ status: "warning", skippedFiles: ["/data/socket"] })),
            }),
        );
        expect(report.status).toBe("warning");
        expect(report.skippedFiles).toEqual(["/data/socket"]);
    });

    it("verify: a content-change line fails the run", async () => {
        const report = await runMirror(
            mirrorTarget({ rsync: { ...mirrorTarget().rsync, verify: true } }),
            makeDeps({ execFn: async () => makeExecResult({ stdout: ">f.st...... data/a\n" }) }),
        );
        expect(report.status).toBe("failed");
        expect(report.reason).toBe("verify-failed");
        expect(report.error).toContain("data/a");
    });

    it("verify: attribute-only itemize lines pass", async () => {
        const report = await runMirror(
            mirrorTarget({ rsync: { ...mirrorTarget().rsync, verify: true } }),
            makeDeps({ execFn: async () => makeExecResult({ stdout: ".f...p..... data/a\n" }) }),
        );
        expect(report.status).toBe("success");
    });

    it("an aborted run reports aborted, never failed", async () => {
        const controller = new AbortController();
        controller.abort();
        const report = await runMirror(
            mirrorTarget(),
            makeDeps({
                transfer: fakeTransfer(
                    new TransferError("transfer aborted", { exitCode: null, retriable: false, stderrTail: "" }),
                ),
            }),
            { signal: controller.signal },
        );
        expect(report.status).toBe("aborted");
        expect(report.reason).toBe("aborted");
    });
});
