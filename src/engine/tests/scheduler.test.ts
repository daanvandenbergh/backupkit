/**
 * Scheduler tests: the backoff delay table, nextDueAt math, BackoffTracker
 * transition logging, and the tick loop under fake timers (no real sleeps) -
 * due targets in config order, catch-up as one run per missed window, backoff
 * delaying but never stopping a target, stop() ending the loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LockHeldError, SshError } from "../../shared/errors.js";
import { parseSnapshotName } from "../../shared/snapshot-name.js";
import type { ScheduleSpec } from "../../shared/time.js";
import { deriveBackoff } from "../internal/reports.js";
import { BACKOFF_CAP_MS, backoffDelayMs, BackoffTracker, nextDueAt, Scheduler } from "../internal/scheduler.js";
import type { ReachResult } from "../../ssh/reach.js";
import type { TargetRunReport } from "../types.js";
import { captureLogger, makeTarget } from "./fakes.js";

/** A daily schedule fixture. */
const DAILY: ScheduleSpec = { interval: "day", intervalCount: 1, at: "00:00", on: "mon", dayOfMonth: 1 };

/** An hourly schedule fixture. */
const HOURLY: ScheduleSpec = { ...DAILY, interval: "hour" };

/** A success report fixture for the loop's runTarget seam. */
function report(target: string, status: TargetRunReport["status"], snapshot: string | null): TargetRunReport {
    return {
        runId: `x_${target}`,
        target,
        direction: "pull",
        snapshot,
        status,
        reason: null,
        // Load-bearing: the loop caches a completed run's startedAt as the
        // window it fulfilled (a mirror run has no snapshot name to cache).
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempts: [],
        stats: null,
        skippedFiles: [],
        error: null,
    };
}

describe("backoffDelayMs", () => {
    it.each([
        { failures: 0, delay: 0 },
        { failures: 1, delay: 15 * 60_000 },
        { failures: 2, delay: 30 * 60_000 },
        { failures: 3, delay: 60 * 60_000 },
        { failures: 5, delay: 4 * 3_600_000 },
        { failures: 6, delay: BACKOFF_CAP_MS },
        { failures: 10, delay: BACKOFF_CAP_MS },
        { failures: 50, delay: BACKOFF_CAP_MS },
    ])("$failures failures -> $delay ms (6h ceiling absolute)", ({ failures, delay }) => {
        expect(backoffDelayMs(failures)).toBe(delay);
    });
});

describe("nextDueAt", () => {
    const now = new Date("2026-08-10T12:00:00Z");

    it("is now when the window is unfulfilled and the anchor has passed", () => {
        expect(nextDueAt(DAILY, null, null, now).toISOString()).toBe(now.toISOString());
    });

    it("is the next window's anchor when the current window is fulfilled", () => {
        const newest = new Date("2026-08-10T03:00:00Z");
        expect(nextDueAt(DAILY, newest, null, now).toISOString()).toBe("2026-08-11T00:00:00.000Z");
    });

    it("is the current window's anchor when it lies in the future", () => {
        const at0300: ScheduleSpec = { ...DAILY, at: "15:00" };
        expect(nextDueAt(at0300, null, null, now).toISOString()).toBe("2026-08-10T15:00:00.000Z");
    });

    it("an active backoff pushes the due time out", () => {
        const backoffUntil = new Date("2026-08-10T14:30:00Z");
        expect(nextDueAt(DAILY, null, backoffUntil, now).toISOString()).toBe("2026-08-10T14:30:00.000Z");
    });

    it("a backoff already elapsed changes nothing", () => {
        const backoffUntil = new Date("2026-08-10T11:00:00Z");
        expect(nextDueAt(DAILY, null, backoffUntil, now).toISOString()).toBe(now.toISOString());
    });
});

describe("BackoffTracker transitions", () => {
    const finished = new Date("2026-08-10T12:00:00Z");

    it("logs only the transitions INTO backoff; clearing it is silent", () => {
        const { log, lines } = captureLogger("debug");
        const tracker = new BackoffTracker(log);
        const backoffLines = (): string[] => lines.filter((line) => line.includes("failure backoff"));
        const errorLines = (): string[] => lines.filter((line) => line.includes("ERROR"));

        // A failure with a retry already scheduled is a WARNING: the run that
        // caused it logged one line above, and nobody has to do anything. Only
        // the ceiling - six consecutive failures, retries plainly not working -
        // is an ERROR. A night of flaky Wi-Fi must not read like a broken key.
        tracker.record("web", "failed", finished);
        expect(backoffLines()).toHaveLength(1);
        expect(backoffLines()[0]).toContain("WARN");
        expect(backoffLines()[0]).toContain("entering failure backoff");
        expect(backoffLines()[0]).toContain("failures=1");
        expect(errorLines()).toHaveLength(0);

        tracker.record("web", "failed", finished);
        expect(backoffLines()).toHaveLength(2);
        expect(backoffLines()[1]).toContain("WARN");
        expect(backoffLines()[1]).toContain("extending failure backoff");
        expect(errorLines()).toHaveLength(0);

        for (let i = 0; i < 4; i += 1) {
            tracker.record("web", "failed", finished);
        }
        expect(backoffLines().at(-1)).toContain("at ceiling for failure backoff");
        expect(backoffLines().at(-1)).toContain("ERROR");
        expect(errorLines()).toHaveLength(1);

        // Clearing the backoff logs NOTHING, at any level. It lands after the
        // `backup finished` line has already reported the success, so a line
        // here only makes a healthy target's LAST line look like a problem.
        const count = lines.length;
        tracker.record("web", "success", finished);
        expect(tracker.failuresFor("web")).toBe(0);
        expect(tracker.untilFor("web")).toBeNull();
        expect(lines).toHaveLength(count);

        tracker.record("web", "warning", finished);
        tracker.record("web", "skipped", finished);
        tracker.record("web", "aborted", finished);
        expect(lines).toHaveLength(count);
    });

    it("aborted and skipped never change the failure count", () => {
        const tracker = new BackoffTracker(captureLogger("error").log);
        tracker.record("web", "failed", finished);
        tracker.record("web", "skipped", finished);
        tracker.record("web", "aborted", finished);
        expect(tracker.failuresFor("web")).toBe(1);
        expect(tracker.untilFor("web")?.toISOString()).toBe("2026-08-10T12:15:00.000Z");
    });

    it("rehydrates from a derived report history", () => {
        const tracker = new BackoffTracker(captureLogger("error").log);
        tracker.rehydrate(
            "web",
            deriveBackoff([
                report("web", "failed", null),
                report("web", "failed", null),
            ].map((r) => ({ ...r, finishedAt: "2026-08-10T12:00:00.000Z" }))),
        );
        expect(tracker.failuresFor("web")).toBe(2);
        expect(tracker.untilFor("web")?.toISOString()).toBe("2026-08-10T12:30:00.000Z");
    });
});

describe("Scheduler loop (fake timers)", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date("2026-08-10T12:00:00Z") });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Build a loop over the given targets recording every runTarget call. */
    function makeLoop(params: {
        targets: ReturnType<typeof makeTarget>[];
        newest?: Record<string, string | null>;
        outcome?: (target: string) => TargetRunReport;
        lastFulfilledAt?: (target: ReturnType<typeof makeTarget>) => Promise<Date | null>;
        reachable?: (target: ReturnType<typeof makeTarget>) => Promise<ReachResult>;
    }): {
        scheduler: Scheduler;
        runs: string[];
        tracker: BackoffTracker;
        recorded: TargetRunReport[];
        lines: string[];
    } {
        const { log, lines } = captureLogger("debug");
        const tracker = new BackoffTracker(log);
        const runs: string[] = [];
        const recorded: TargetRunReport[] = [];
        const scheduler = new Scheduler({
            targets: params.targets,
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            reachable: params.reachable,
            // `newest` stays snapshot-NAMED in these fixtures (that is what a
            // snapshot target's store answers with); the engine's own parse to a
            // Date is mirrored here.
            lastFulfilledAt:
                params.lastFulfilledAt ??
                (async (target) => {
                    const name = params.newest?.[target.name] ?? null;
                    return name === null ? null : parseSnapshotName(name);
                }),
            runTarget: async (target) => {
                runs.push(target.name);
                const result = params.outcome?.(target.name) ?? report(target.name, "success", "2026-08-10T120000Z");
                tracker.record(target.name, result.status, new Date());
                return result;
            },
            // Mirrors the engine's wiring: persist the report, then feed backoff.
            recordOutcome: async (target, status, reason, error) => {
                const persisted = { ...report(target.name, status, null), reason, error };
                recorded.push(persisted);
                tracker.record(target.name, status, new Date(persisted.finishedAt));
            },
        });
        return { scheduler, runs, tracker, recorded, lines };
    }

    it("first tick runs due targets sequentially in config order; a fulfilled window does not rerun", async () => {
        const a = makeTarget({ name: "aaa", schedule: HOURLY });
        const b = makeTarget({ name: "bbb", schedule: HOURLY });
        const { scheduler, runs } = makeLoop({ targets: [a, b] });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual(["aaa", "bbb"]);
        // Next tick, same window: cache says fulfilled, nothing runs.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(runs).toEqual(["aaa", "bbb"]);
        scheduler.stop();
        await loop;
    });

    it("catch-up after many missed windows is exactly one run (window comparison, not a replay queue)", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, runs } = makeLoop({
            targets: [target],
            newest: { web: "2026-08-10T050000Z" }, // 7 windows ago
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual(["web"]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(runs).toEqual(["web"]);
        scheduler.stop();
        await loop;
    });

    it("runs again when the window advances", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, runs } = makeLoop({ targets: [target] });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual(["web"]);
        // Advance past the next hour boundary (12:00 -> 13:00).
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(runs).toEqual(["web", "web"]);
        scheduler.stop();
        await loop;
    });

    it("backoff delays a failing target but never stops it", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, runs } = makeLoop({
            targets: [target],
            outcome: (name) => report(name, "failed", null),
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual(["web"]);
        // Within the 15-minute backoff: nothing.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(runs).toEqual(["web"]);
        // Past the backoff: retried (still the same unfulfilled window).
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(runs).toEqual(["web", "web"]);
        scheduler.stop();
        await loop;
    });

    it("a target whose due-check LISTING fails backs off - it is not re-listed every tick", async () => {
        // Regression: an unreachable remote made the due-check ssh listing fail
        // on every 30s tick, spamming a failure and driving the count past the
        // ceiling because backoff was checked only AFTER the listing. Now backoff
        // gates the listing too, so an unreachable target is probed on its
        // backoff schedule, not every tick.
        const target = makeTarget({ name: "web", schedule: HOURLY });
        let listCalls = 0;
        const { scheduler, runs, recorded } = makeLoop({
            targets: [target],
            lastFulfilledAt: async () => {
                listCalls++;
                throw new Error("ssh: host unreachable");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        // First tick: listed once, fails, recorded failed, backoff engages.
        expect(listCalls).toBe(1);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe("failed");
        expect(runs).toEqual([]); // never reached runTarget
        // Within the 15-minute backoff: NOT re-listed (the bug re-listed ~20x).
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(listCalls).toBe(1);
        // Past the backoff: probed again - backoff delays, never stops.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(listCalls).toBe(2);
        scheduler.stop();
        await loop;
    });

    it("disabled targets never run", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY, enabled: false });
        const { scheduler, runs } = makeLoop({ targets: [target] });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual([]);
        scheduler.stop();
        await loop;
    });

    it("lock contention is a warn-and-skip, not a crash", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { log, lines } = captureLogger("warn");
        const tracker = new BackoffTracker(log);
        const scheduler = new Scheduler({
            targets: [target],
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            lastFulfilledAt: async () => null,
            runTarget: async () => {
                throw new LockHeldError("another backupkit holds it");
            },
            recordOutcome: async () => undefined,
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(lines.some((line) => line.includes("lock held"))).toBe(true);
        scheduler.stop();
        await loop;
    });

    it("a window-skip report drops the stale newest cache: re-list once, no per-tick pipeline storm", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { log } = captureLogger("error");
        const tracker = new BackoffTracker(log);
        const runs: string[] = [];
        let listCalls = 0;
        // Another writer (a manual `backupkit run`) creates the current window's
        // snapshot behind the daemon's back: the store answers with it, but the
        // daemon's cache still says "nothing complete".
        let newest: string | null = null;
        const scheduler = new Scheduler({
            targets: [target],
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            lastFulfilledAt: async () => {
                listCalls += 1;
                return newest === null ? null : parseSnapshotName(newest);
            },
            runTarget: async () => {
                runs.push("web");
                return { ...report("web", "skipped", null), reason: "window" };
            },
            recordOutcome: async () => undefined,
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        // First tick: stale cache says due, the pipeline detects the fulfilled window.
        expect(runs).toEqual(["web"]);
        newest = "2026-08-10T120100Z"; // the other writer's snapshot, current window
        await vi.advanceTimersByTimeAsync(30_000);
        // The skip invalidated the cache: this tick re-listed instead of re-running.
        expect(listCalls).toBe(2);
        expect(runs).toEqual(["web"]);
        await vi.advanceTimersByTimeAsync(30_000);
        // And the refreshed cache keeps the target quiet for the rest of the window.
        expect(runs).toEqual(["web"]);
        expect(listCalls).toBe(2);
        scheduler.stop();
        await loop;
    });

    // Regression: an offline laptop dialled every due target, burned three ssh
    // retries and a 60 s timeout each, and recorded a FAILED RUN worded exactly
    // like a revoked key - a night of dropped Wi-Fi produced a wall of ERROR
    // lines and drove the backoff to its 6 h ceiling, so the backup that could
    // finally run when the link returned was still hours from being attempted.
    it("an unreachable backup server skips the target: one warn, no report, no backoff", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        let reachable = false;
        let probes = 0;
        const { scheduler, runs, tracker, recorded, lines } = makeLoop({
            targets: [target],
            reachable: async () => {
                probes += 1;
                return reachable
                    ? { ok: true, failure: null, detail: "" }
                    : { ok: false, failure: "no-link", detail: "this machine has no network interface up" };
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual([]);
        // Not a failed run: nothing was learned about the target.
        expect(recorded).toEqual([]);
        expect(tracker.failuresFor("web")).toBe(0);
        expect(tracker.untilFor("web")).toBeNull();
        const warned = lines.filter((line) => line.includes("not reachable"));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("WARN");
        expect(warned[0]).toContain("cause=no-link");
        // The outage is logged on its EDGES: ten more ticks stay silent.
        for (let i = 0; i < 10; i += 1) {
            await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(probes).toBeGreaterThan(1);
        expect(lines.filter((line) => line.includes("not reachable"))).toHaveLength(1);
        expect(lines.filter((line) => line.includes("ERROR"))).toEqual([]);

        // And with no backoff to serve, the FIRST tick after the network
        // returns runs the window that was missed.
        reachable = true;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(runs).toEqual(["web"]);
        expect(lines.filter((line) => line.includes("reachable again"))).toHaveLength(1);
        scheduler.stop();
        await loop;
    });

    // The probe may only DELAY a backup. An answering-but-refusing host, or any
    // inconclusive probe, must pass so the real condition still reaches ssh and
    // its classifier - a wrong "unreachable" silently stops backups, which is
    // worse than every log line it would save.
    it("a reachable probe never suppresses a real failure", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, recorded, lines } = makeLoop({
            targets: [target],
            reachable: async () => ({ ok: true, failure: null, detail: "" }),
            lastFulfilledAt: async () => {
                throw new Error("ssh: Permission denied (publickey).");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe("failed");
        // A permanent cause keeps its ERROR level - this is the line that must
        // still stand out once the network noise is gone.
        const failure = lines.filter((line) => line.includes("due check"));
        expect(failure).toHaveLength(1);
        expect(failure[0]).toContain("ERROR");
        scheduler.stop();
        await loop;
    });

    // The sibling of the rule above: a due check that failed for a TRANSIENT
    // reason is a warning, not an error. It still records a failed run (the
    // backoff has to space the retries out), but the level says who has to act.
    it("a transient due-check failure logs at warn; the run is still recorded as failed", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, recorded, tracker, lines } = makeLoop({
            targets: [target],
            lastFulfilledAt: async () => {
                throw new SshError("ssh web timed out after 60000ms", { retriable: true });
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe("failed");
        expect(tracker.failuresFor("web")).toBe(1);
        expect(lines.filter((line) => line.includes("ERROR"))).toEqual([]);
        const warned = lines.filter((line) => line.includes("could not reach the backup server"));
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain("WARN");
        scheduler.stop();
        await loop;
    });

    // Regression: the due check's listing is an ssh round-trip for a push
    // target, so archive host down / key revoked / jail script renamed all land
    // in its catch - which logged a warn and continued BEFORE runTarget, so no
    // report was ever written. consecutiveFailures stayed 0, backoff never
    // engaged, and `status` kept reporting the last success while nothing ran.
    it("a failing due check is recorded as a failed run and climbs the failure count", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, runs, tracker, recorded } = makeLoop({
            targets: [target],
            lastFulfilledAt: async () => {
                throw new Error("ssh: connect to host archive port 22: Connection refused");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual([]);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe("failed");
        expect(recorded[0].reason).toBe("due-check-failed");
        expect(recorded[0].error).toContain("Connection refused");
        expect(tracker.failuresFor("web")).toBe(1);
        // And the failure now delays the retry instead of hammering every tick.
        expect(tracker.untilFor("web")).not.toBeNull();
        scheduler.stop();
        await loop;
    });

    // Regression: the sibling of the due-check catch above logged "target run
    // threw unexpectedly" and wrote NO report, so the identical silent failure
    // was still live on that path - reachable whenever the local rsync becomes
    // unusable (uninstalled, downgraded below the 3.2.5 floor, sandboxed away by
    // ProtectSystem=strict), when the report write itself fails, or on any
    // unexpected throw. Demonstrated with a throwing rsync probe: three ticks
    // logged an error each and the persisted state still read lastResult
    // "success", consecutiveFailures 0.
    it("an unexpected throw out of runTarget is recorded as a failed run too", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, tracker, recorded } = makeLoop({
            targets: [target],
            outcome: () => {
                throw new Error("rsync 3.1.3 is below the 3.2.5 floor");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].status).toBe("failed");
        // Distinguishable from the due-check path.
        expect(recorded[0].reason).toBe("run-threw");
        expect(recorded[0].error).toContain("3.2.5 floor");
        expect(tracker.failuresFor("web")).toBe(1);
        expect(tracker.untilFor("web")).not.toBeNull();
        scheduler.stop();
        await loop;
    });

    it("a lock-held throw stays a warn-and-skip: no failure report, no backoff", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, tracker, recorded } = makeLoop({
            targets: [target],
            outcome: () => {
                throw new LockHeldError("another backupkit holds it");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(recorded).toEqual([]);
        expect(tracker.failuresFor("web")).toBe(0);
        scheduler.stop();
        await loop;
    });

    it("a failing report write after an unexpected throw never ends the daemon loop", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { log } = captureLogger("error");
        const tracker = new BackoffTracker(log);
        const scheduler = new Scheduler({
            targets: [target],
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            lastFulfilledAt: async () => null,
            runTarget: async () => {
                throw new Error("rsync vanished");
            },
            recordOutcome: async () => {
                throw new Error("state dir is read-only");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        scheduler.stop();
        await expect(loop).resolves.toBeUndefined();
    });

    it("a failing report write never ends the daemon loop", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { log } = captureLogger("error");
        const tracker = new BackoffTracker(log);
        const scheduler = new Scheduler({
            targets: [target],
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            lastFulfilledAt: async () => {
                throw new Error("archive unreachable");
            },
            runTarget: async () => report("web", "success", null),
            recordOutcome: async () => {
                throw new Error("state dir is read-only");
            },
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        scheduler.stop();
        await expect(loop).resolves.toBeUndefined();
    });

    it("stop() ends the loop promptly", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, runs } = makeLoop({ targets: [target] });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        scheduler.stop();
        await loop;
        await vi.advanceTimersByTimeAsync(10 * 3_600_000);
        expect(runs).toEqual(["web"]);
    });
});
