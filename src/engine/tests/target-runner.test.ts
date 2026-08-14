/**
 * State-machine tests for the per-target pipeline against a fake store and
 * fake transfer/estimate functions: dedup skip, force, disk guard, clock
 * skew, promote, warning-promote, verify, retention, abort, and lock-release
 * paths.
 */

import { describe, expect, it } from "vitest";

import { LockHeldError, TransferError } from "../../shared/errors.js";
import type { dryRunStats, runTransfer } from "../../rsync/rsync.js";
import type { TransferResult } from "../../rsync/rsync.js";
import { runTarget, type TargetRunnerDeps } from "../internal/target-runner.js";
import { captureLogger, FakeStore, makeStats, makeTarget, makeTransferResult } from "./fakes.js";

/** Fixed run instant: snapshot name "2026-08-10T120000Z". */
const NOW = new Date("2026-08-10T12:00:00.000Z");

/** The snapshot name every run in this suite creates. */
const SNAP = "2026-08-10T120000Z";

/** A fake transfer resolving with `outcome` (or throwing it), recording its params and feeding the attempt log. */
function fakeTransfer(outcome: TransferResult | Error, seen: unknown[] = []): typeof runTransfer {
    return async (params) => {
        seen.push(params);
        if (outcome instanceof Error) {
            params.attemptLog?.push({ exitCode: 12, class: "transient", durationMs: 1, stderrTail: "" });
            throw outcome;
        }
        for (const attempt of outcome.attempts) {
            params.attemptLog?.push(attempt);
        }
        return outcome;
    };
}

/** A fake estimator returning fixed stats, counting its invocations. */
function fakeEstimate(delta: number, counter = { calls: 0 }, filesTransferred?: number): typeof dryRunStats {
    return async () => {
        counter.calls += 1;
        return makeStats({
            totalTransferredSize: delta,
            ...(filesTransferred === undefined ? {} : { filesTransferred }),
        });
    };
}

/** Full runner deps over a fake store with quiet defaults. */
function makeDeps(store: FakeStore, overrides: Partial<TargetRunnerDeps> = {}): TargetRunnerDeps {
    return {
        store,
        log: captureLogger().log,
        now: () => NOW,
        rsyncBin: "/fake/rsync",
        sshTokens: [],
        env: undefined,
        transfer: fakeTransfer(makeTransferResult()),
        estimate: fakeEstimate(1000),
        execFn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 }),
        totalBytes: async () => null,
        diskLowTargets: new Set(),
        previousStats: async () => null,
        previousHistory: async () => null,
        ...overrides,
    };
}

describe("runTarget pipeline", () => {
    it("first run: claims, transfers with no link-dest, promotes, reports success", async () => {
        const store = new FakeStore();
        const seen: { spec: { linkDestBase: string | null; dst: { path: string } } }[] = [];
        const deps = makeDeps(store, { transfer: fakeTransfer(makeTransferResult(), seen) });
        const report = await runTarget(makeTarget(), deps);
        expect(report.status).toBe("success");
        expect(report.snapshot).toBe(SNAP);
        expect(report.runId).toBe(`${SNAP}_web`);
        expect(report.reason).toBeNull();
        expect(report.error).toBeNull();
        expect(seen[0].spec.linkDestBase).toBeNull();
        // The partial sits DIRECTLY in the destination: no target-name level.
        expect(seen[0].spec.dst.path).toBe(`/data/archive/${SNAP}.partial`);
        expect(store.calls).toContain(`claimPartial:${SNAP}`);
        expect(store.calls).toContain(`promote:${SNAP}`);
        expect(store.names).toContain(SNAP);
        expect(store.locked).toBe(false);
    });

    it("passes the newest complete snapshot as the link-dest base", async () => {
        const store = new FakeStore();
        store.names = ["2026-08-08T000000Z", "2026-08-09T000000Z"];
        const seen: { spec: { linkDestBase: string | null } }[] = [];
        const report = await runTarget(makeTarget(), makeDeps(store, { transfer: fakeTransfer(makeTransferResult(), seen) }));
        expect(report.status).toBe("success");
        expect(seen[0].spec.linkDestBase).toBe("2026-08-09T000000Z");
    });

    it("skips when a complete snapshot already sits in the current window", async () => {
        const store = new FakeStore();
        store.names = ["2026-08-10T031500Z"];
        const seen: unknown[] = [];
        const report = await runTarget(makeTarget(), makeDeps(store, { transfer: fakeTransfer(makeTransferResult(), seen) }));
        expect(report.status).toBe("skipped");
        expect(report.reason).toBe("window");
        expect(report.snapshot).toBeNull();
        expect(seen).toHaveLength(0);
        expect(store.calls.some((call) => call.startsWith("promote"))).toBe(false);
    });

    it("force bypasses the window dedup", async () => {
        const store = new FakeStore();
        store.names = ["2026-08-10T031500Z"];
        const report = await runTarget(makeTarget(), makeDeps(store), { force: true });
        expect(report.status).toBe("success");
        expect(store.names).toContain(SNAP);
    });

    it("fails with reason clock-skew when the new name would not sort after the newest", async () => {
        const store = new FakeStore();
        store.names = ["2026-08-11T000000Z"];
        const seen: unknown[] = [];
        const report = await runTarget(makeTarget(), makeDeps(store, { transfer: fakeTransfer(makeTransferResult(), seen) }));
        expect(report.status).toBe("failed");
        expect(report.reason).toBe("clock-skew");
        expect(report.error).toContain("2026-08-11T000000Z");
        expect(seen).toHaveLength(0);
        expect(store.calls.some((call) => call.startsWith("promote"))).toBe(false);
    });

    it("skips with reason disk-low on a shortfall, logging the transition exactly once", async () => {
        const store = new FakeStore();
        store.free = 5000;
        const { log, lines } = captureLogger();
        const diskLow = new Set<string>();
        const deps = makeDeps(store, {
            log,
            estimate: fakeEstimate(1000),
            diskLowTargets: diskLow,
        });
        const target = makeTarget({ minFree: { kind: "bytes", bytes: 10_000 } });
        const first = await runTarget(target, deps);
        expect(first.status).toBe("skipped");
        expect(first.reason).toBe("disk-low");
        expect(store.calls.some((call) => call.startsWith("promote"))).toBe(false);
        const errorLines = lines.filter((line) => line.includes("ERROR") && line.includes("not enough free disk space"));
        expect(errorLines).toHaveLength(1);

        // Second shortfall run: same state, no second error line.
        await runTarget(target, deps);
        expect(lines.filter((line) => line.includes("ERROR") && line.includes("not enough free disk space"))).toHaveLength(1);

        // Recovery clears the sticky state.
        store.free = Number.MAX_SAFE_INTEGER;
        const healed = await runTarget(target, deps);
        expect(healed.status).toBe("success");
        expect(diskLow.has("web")).toBe(false);
        expect(lines.some((line) => line.includes("disk space recovered"))).toBe(true);
    });

    it("disk guard disabled (minFree null): the estimator is never called", async () => {
        const store = new FakeStore();
        const counter = { calls: 0 };
        const report = await runTarget(makeTarget({ minFree: null }), makeDeps(store, { estimate: fakeEstimate(1, counter) }));
        expect(report.status).toBe("success");
        expect(counter.calls).toBe(0);
    });

    it("percent minFree with unknown total degrades the floor and still guards the delta requirement", async () => {
        const store = new FakeStore();
        store.free = 300_000_000; // above delta*1.2 + 256MiB for a 1000-byte delta
        const report = await runTarget(
            makeTarget({ minFree: { kind: "percent", percent: 5 } }),
            makeDeps(store, { totalBytes: async () => null }),
        );
        expect(report.status).toBe("success");
    });

    it("records the estimated delta and the transfer stats in the report", async () => {
        const store = new FakeStore();
        const report = await runTarget(
            makeTarget({ minFree: { kind: "bytes", bytes: 0 } }),
            makeDeps(store, {
                estimate: fakeEstimate(4242),
                transfer: fakeTransfer(makeTransferResult({ stats: makeStats({ totalTransferredSize: 999 }) })),
            }),
        );
        expect(report.stats).toEqual({ filesTransferred: 3, bytesTransferred: 999, totalFiles: 10, deltaBytes: 4242 });
    });

    it("promotes on a warning transfer and caps skippedFiles at 100", async () => {
        const store = new FakeStore();
        const report = await runTarget(
            makeTarget(),
            makeDeps(store, {
                transfer: fakeTransfer(
                    makeTransferResult({ status: "warning", skippedFiles: Array.from({ length: 150 }, (_, i) => `f${i}`) }),
                ),
            }),
        );
        expect(report.status).toBe("warning");
        expect(report.skippedFiles).toHaveLength(100);
        expect(store.names).toContain(SNAP);
    });

    it("verify pass: clean checksum dry-run promotes", async () => {
        const store = new FakeStore();
        const argvs: string[][] = [];
        const deps = makeDeps(store, {
            execFn: async (_bin, args) => {
                argvs.push([...args]);
                return { exitCode: 0, signal: null, stdout: ".d..t...... ./\n", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
            },
        });
        const report = await runTarget(makeTarget({ rsync: { ...makeTarget().rsync, verify: true } }), deps);
        expect(report.status).toBe("success");
        expect(store.names).toContain(SNAP);
        expect(argvs.at(-1)).toContain("--checksum");
        expect(argvs.at(-1)).toContain("--dry-run");
    });

    it("verify failure keeps the partial and fails the run without promoting", async () => {
        const store = new FakeStore();
        const deps = makeDeps(store, {
            execFn: async () => ({
                exitCode: 0,
                signal: null,
                stdout: ">f.st...... a.txt\n",
                stderr: "",
                timedOut: false,
                truncated: false,
                durationMs: 1,
            }),
        });
        const report = await runTarget(makeTarget({ rsync: { ...makeTarget().rsync, verify: true } }), deps);
        expect(report.status).toBe("failed");
        expect(report.reason).toBe("verify-failed");
        expect(report.error).toContain("a.txt");
        expect(store.calls.some((call) => call.startsWith("promote"))).toBe(false);
        expect(store.names).not.toContain(SNAP);
    });

    it("runs retention after promote: prunes oldest-first, never the newest", async () => {
        const store = new FakeStore();
        store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
        const report = await runTarget(makeTarget({ retention: { keepLast: 1 } }), makeDeps(store));
        expect(report.status).toBe("success");
        const removes = store.calls.filter((call) => call.startsWith("remove:"));
        expect(removes).toEqual(["remove:2026-08-01T000000Z", "remove:2026-08-02T000000Z"]);
        expect(store.names).toEqual([SNAP]);
    });

    // Retention selects purely on names, so a name dated in the future occupies
    // every bucket it touches and pushes the GENUINE snapshots into the prune
    // list. The clock-skew guard is no cover: it reads the listing BEFORE the
    // transfer, retention re-reads it AFTER, and the party serving the transfer
    // is exactly the party that can plant snapshot-shaped names inside that
    // window with jail-legal `mkdir` commands (measured: 30 of 31 real
    // snapshots put up for deletion).
    describe("future-dated names planted during the transfer", () => {
        const FUTURE = ["2099-01-01T000000Z", "2099-02-01T000000Z", "2099-03-01T000000Z"];
        const GENUINE = ["2026-08-01T000000Z", "2026-08-02T000000Z", "2026-08-03T000000Z"];

        /** A transfer that plants `FUTURE` in the store mid-flight, like a compromised source does. */
        function plantingTransfer(store: FakeStore): typeof runTransfer {
            return async (params) => {
                store.names.push(...FUTURE);
                return fakeTransfer(makeTransferResult())(params);
            };
        }

        it("never capture retention buckets: every genuine snapshot survives", async () => {
            const store = new FakeStore();
            store.names = [...GENUINE];
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 3 } }),
                makeDeps(store, { transfer: plantingTransfer(store) }),
            );
            expect(report.status).toBe("success");
            // keepLast:3 over the genuine names keeps SNAP + the two newest;
            // only the genuinely-oldest one is pruned.
            expect(store.names.sort()).toEqual(["2026-08-02T000000Z", "2026-08-03T000000Z", SNAP]);
        });

        it("are pruned like `backupkit prune` does it, oldest genuine first, and logged loudly", async () => {
            const store = new FakeStore();
            store.names = [...GENUINE];
            const { log, lines } = captureLogger("error");
            await runTarget(
                makeTarget({ retention: { keepLast: 3 } }),
                makeDeps(store, { log, transfer: plantingTransfer(store) }),
            );
            expect(store.calls.filter((call) => call.startsWith("remove:"))).toEqual([
                // Oldest first, exactly like the genuine half - so the planted
                // names (which sort after everything) go last.
                "remove:2026-08-01T000000Z",
                ...FUTURE.map((name) => `remove:${name}`),
            ]);
            expect(lines.some((line) => line.includes("ERROR") && line.includes("future"))).toBe(true);
        });

        it("are kept, never pruned, when nothing genuine survives them (a clock that stepped backwards)", async () => {
            const store = new FakeStore();
            store.names = [...GENUINE];
            // The clock steps back past every existing name (including this run's
            // own promoted one) between the run's start and retention: with a
            // 2020 "now" the whole archive looks future-dated, and auto-deleting
            // it would destroy real data (invariant 26).
            let clockReads = 0;
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    now: () => {
                        clockReads += 1;
                        return clockReads === 1 ? NOW : new Date("2020-01-01T00:00:00.000Z");
                    },
                }),
            );
            expect(report.status).toBe("success");
            expect(store.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
        });
    });

    // Every transfer runs `--delete --force` and retention selects purely on
    // names and counts, so a compromised source presenting an empty tree on each
    // scheduled run promotes empty snapshots and retention ages the real history
    // out - the one way a source can destroy its own archive despite the jail.
    describe("content-collapse tripwire", () => {
        it("skips retention, reports the collapse and logs at error level when the file count collapses", async () => {
            const store = new FakeStore();
            store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
            const { log, lines } = captureLogger("error");
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    log,
                    previousStats: async () => ({
                        filesTransferred: 5,
                        bytesTransferred: 500,
                        totalFiles: 1000,
                        deltaBytes: 500,
                    }),
                    transfer: fakeTransfer(makeTransferResult({ stats: makeStats({ totalFiles: 3 }) })),
                }),
            );
            expect(report.status).toBe("success");
            expect(report.contentCollapse).toEqual({ previousFiles: 1000, files: 3 });
            // Promoted (the data is already transferred), but nothing pruned.
            expect(store.names).toContain(SNAP);
            expect(store.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
            expect(lines.some((line) => line.includes("ERROR") && line.includes("content collapse"))).toBe(true);
        });

        it("a shrink inside the threshold prunes normally and reports no collapse", async () => {
            const store = new FakeStore();
            store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    previousStats: async () => ({
                        filesTransferred: 5,
                        bytesTransferred: 500,
                        totalFiles: 20,
                        deltaBytes: 500,
                    }),
                    transfer: fakeTransfer(makeTransferResult({ stats: makeStats({ totalFiles: 10 }) })),
                }),
            );
            expect(report.contentCollapse).toBeNull();
            expect(store.calls.filter((call) => call.startsWith("remove:")).length).toBeGreaterThan(0);
        });

        it("trips when this run's file count cannot be measured at all, rather than pruning blind", async () => {
            // The read-only sibling (dryRunStats) THROWS on unparsable rsync
            // stats; this path used to score the same input as "no collapse" and
            // go on to delete. A hostile source chooses whether its rsync emits a
            // parsable stats block, so it also chose which branch ran.
            const store = new FakeStore();
            store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
            const { log, lines } = captureLogger("error");
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    log,
                    previousStats: async () => ({
                        filesTransferred: 5,
                        bytesTransferred: 500,
                        totalFiles: 1000,
                        deltaBytes: 500,
                    }),
                    transfer: fakeTransfer(makeTransferResult({ stats: null })),
                }),
            );

            expect(report.contentCollapse).toEqual({ previousFiles: 1000, files: null });
            expect(store.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
            expect(lines.some((line) => line.includes("ERROR") && line.includes("could not be measured"))).toBe(true);
        });

        it("PAST-dated planted names trip the insertion guard, so retention never runs on a poisoned listing", async () => {
            // The demonstrated bypass of the future-dated guard: the planter
            // picks the timestamp, so it dates each plant one second AFTER a real
            // snapshot. splitFutureSnapshots reports nothing (none are ahead of
            // now), every plant takes its bucket, and the real history is what
            // gets pruned. Counting catches it - this client never back-dates, so
            // the number of names at or below a fixed past point cannot grow.
            const store = new FakeStore();
            store.names = [
                "2026-08-01T000000Z",
                "2026-08-01T000001Z", // planted, one second later
                "2026-08-02T000000Z",
                "2026-08-02T000001Z", // planted
                "2026-08-03T000000Z",
            ];
            const { log, lines } = captureLogger("error");
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    log,
                    previousHistory: async () => ({ newest: "2026-08-03T000000Z", count: 3 }),
                }),
            );

            expect(report.status).toBe("success");
            expect(report.historyInsertion).toEqual({
                previousNewest: "2026-08-03T000000Z",
                previousCount: 3,
                count: 5,
            });
            // Promoted, but nothing pruned - the real history survives.
            expect(store.names).toContain(SNAP);
            expect(store.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
            expect(lines.some((line) => line.includes("ERROR") && line.includes("appeared BELOW"))).toBe(true);
        });

        it("records how much history existed, so the next run has a baseline to count against", async () => {
            const store = new FakeStore();
            store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
            const report = await runTarget(makeTarget({ retention: null }), makeDeps(store));

            // Two existing plus the one this run promoted.
            expect(report.completeCount).toBe(3);
        });

        it("does not trip when retention has REMOVED names since the mark (a count may shrink, never grow)", async () => {
            const store = new FakeStore();
            store.names = ["2026-08-02T000000Z", "2026-08-03T000000Z"];
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    previousHistory: async () => ({ newest: "2026-08-03T000000Z", count: 9 }),
                }),
            );

            expect(report.historyInsertion).toBeNull();
            expect(store.calls.filter((call) => call.startsWith("remove:")).length).toBeGreaterThan(0);
        });

        it("does not trip on this run's OWN new snapshot, which is newer than the mark", async () => {
            const store = new FakeStore();
            store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z", "2026-08-03T000000Z"];
            const report = await runTarget(
                makeTarget({ retention: null }),
                makeDeps(store, {
                    previousHistory: async () => ({ newest: "2026-08-03T000000Z", count: 3 }),
                }),
            );

            expect(report.historyInsertion).toBeNull();
        });

        it("a first run with no baseline never trips the wire", async () => {
            const store = new FakeStore();
            store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
            const report = await runTarget(
                makeTarget({ retention: { keepLast: 1 } }),
                makeDeps(store, {
                    previousStats: async () => null,
                    transfer: fakeTransfer(makeTransferResult({ stats: makeStats({ totalFiles: 0 }) })),
                }),
            );
            expect(report.contentCollapse).toBeNull();
            expect(store.calls.filter((call) => call.startsWith("remove:")).length).toBeGreaterThan(0);
        });
    });

    // A source presenting tens of millions of empty files exhausts the archive
    // filesystem's inodes and breaks every target on it, with bytes to spare.
    it("skips with disk-low on an inode shortfall, and ignores inodes when the store cannot report them", async () => {
        const store = new FakeStore();
        store.freeInodeCount = 1000;
        const target = makeTarget({ minFree: { kind: "bytes", bytes: 0 } });
        const hungry = makeDeps(store, { estimate: fakeEstimate(0, { calls: 0 }, 10_000_000) });
        const report = await runTarget(target, hungry);
        expect(report.status).toBe("skipped");
        expect(report.reason).toBe("disk-low");
        expect(report.error).toContain("free inodes");

        const blind = new FakeStore();
        blind.freeInodeCount = null;
        const unknown = await runTarget(target, makeDeps(blind, { estimate: fakeEstimate(0, { calls: 0 }, 10_000_000) }));
        expect(unknown.status).toBe("success");
    });

    it("a retention failure never demotes a promoted run - it lands in the error field", async () => {
        const store = new FakeStore();
        store.names = ["2026-08-01T000000Z", "2026-08-02T000000Z"];
        const failingRemove = store.remove.bind(store);
        store.remove = async (name: string) => {
            if (name === "2026-08-01T000000Z") {
                throw new Error("remote rm blew up");
            }
            await failingRemove(name);
        };
        const report = await runTarget(makeTarget({ retention: { keepLast: 1 } }), makeDeps(store));
        expect(report.status).toBe("success");
        expect(report.error).toContain("retention failed");
        expect(store.names).toContain(SNAP);
    });

    it("graceful abort during the verify pass is aborted, never verify-failed (no false backoff)", async () => {
        const store = new FakeStore();
        const controller = new AbortController();
        // The verify child dies on the shutdown SIGTERM: exec resolves with a
        // signal death exactly when the run's abort signal is set.
        const deps = makeDeps(store, {
            execFn: async () => {
                controller.abort();
                return { exitCode: null, signal: "SIGTERM" as const, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
            },
        });
        const report = await runTarget(makeTarget({ rsync: { ...makeTarget().rsync, verify: true } }), deps, {
            signal: controller.signal,
        });
        expect(report.status).toBe("aborted");
        expect(report.reason).toBe("aborted");
        expect(store.calls.some((call) => call.startsWith("promote"))).toBe(false);
        expect(store.locked).toBe(false);
    });

    it("the estimate pass receives the shutdown signal (dry-run and disk-guard estimates)", async () => {
        const controller = new AbortController();
        const seenSignals: (AbortSignal | undefined)[] = [];
        /** Deps whose estimator spawns through the runner-provided execFn and whose execFn records the signal it got. */
        function signalProbeDeps(store: FakeStore): ReturnType<typeof makeDeps> {
            return makeDeps(store, {
                estimate: async (params) => {
                    await params.execFn?.("rsync", ["--dry-run"], {});
                    return makeStats({ totalTransferredSize: 1 });
                },
                execFn: async (_bin, _args, options) => {
                    seenSignals.push(options?.signal);
                    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
                },
            });
        }
        await runTarget(makeTarget(), signalProbeDeps(new FakeStore()), { dryRun: true, signal: controller.signal });
        await runTarget(makeTarget({ minFree: { kind: "bytes", bytes: 0 } }), signalProbeDeps(new FakeStore()), {
            signal: controller.signal,
        });
        expect(seenSignals).toHaveLength(2);
        expect(seenSignals.every((signal) => signal === controller.signal)).toBe(true);
    });

    it("aborted signal: report status aborted, lock released", async () => {
        const store = new FakeStore();
        const controller = new AbortController();
        controller.abort();
        const deps = makeDeps(store, {
            transfer: fakeTransfer(new TransferError("transfer aborted", { exitCode: null, retriable: false, stderrTail: "" })),
        });
        const report = await runTarget(makeTarget(), deps, { signal: controller.signal });
        expect(report.status).toBe("aborted");
        expect(report.reason).toBe("aborted");
        expect(report.attempts).toHaveLength(1);
        expect(store.locked).toBe(false);
    });

    it("a transfer failure produces a failed report with the recorded attempts and releases the lock", async () => {
        const store = new FakeStore();
        const deps = makeDeps(store, {
            transfer: fakeTransfer(new TransferError("boom (exit 12)", { exitCode: 12, retriable: true, stderrTail: "x" })),
        });
        const report = await runTarget(makeTarget(), deps);
        expect(report.status).toBe("failed");
        expect(report.error).toContain("boom");
        expect(report.attempts).toHaveLength(1);
        expect(store.locked).toBe(false);
        expect(store.calls).toContain("unlock");
        expect(store.names).toEqual([]);
    });

    it("rethrows LockHeldError (engine policy: live contention aborts the invocation)", async () => {
        const store = new FakeStore();
        store.failLock = new LockHeldError("another backupkit holds it", { pid: 42 });
        await expect(runTarget(makeTarget(), makeDeps(store))).rejects.toThrow(LockHeldError);
    });

    it("dry run: estimate only - no claim, no transfer, no promote", async () => {
        const store = new FakeStore();
        const seen: unknown[] = [];
        const counter = { calls: 0 };
        const report = await runTarget(
            makeTarget({ retention: { keepLast: 1 } }),
            makeDeps(store, { transfer: fakeTransfer(makeTransferResult(), seen), estimate: fakeEstimate(777, counter) }),
            { dryRun: true },
        );
        expect(report.status).toBe("success");
        expect(report.reason).toBe("dry-run");
        expect(report.stats?.deltaBytes).toBe(777);
        expect(counter.calls).toBe(1);
        expect(seen).toHaveLength(0);
        expect(store.calls.some((call) => call.startsWith("claimPartial") || call.startsWith("promote") || call.startsWith("remove"))).toBe(false);
        // A dry run writes nothing, so it must not take the destination lock:
        // taking it made a read-only estimate leave a lock behind, and a remote
        // one has no pid to check - a SIGKILLed dry run blocked the target for
        // the full 24 h TTL.
        expect(store.calls).not.toContain("lock");
    });

    it("dry run: runs even while another backupkit holds the destination lock", async () => {
        const store = new FakeStore();
        store.failLock = new LockHeldError("another backupkit holds it", { pid: 42 });
        const report = await runTarget(makeTarget(), makeDeps(store), { dryRun: true });
        expect(report.status).toBe("success");
        expect(report.reason).toBe("dry-run");
    });

    it("resumes an existing partial (claimPartial reports resumed)", async () => {
        const store = new FakeStore();
        store.partials = ["2026-08-09T110000Z.partial"];
        const { log, lines } = captureLogger();
        const report = await runTarget(makeTarget(), makeDeps(store, { log }));
        expect(report.status).toBe("success");
        expect(lines.some((line) => line.includes("picking up where the last, unfinished run left off"))).toBe(true);
    });
});
