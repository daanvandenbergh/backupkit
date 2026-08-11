/**
 * Scheduler tests: the backoff delay table, nextDueAt math, BackoffTracker
 * transition logging, and the tick loop under fake timers (no real sleeps) -
 * due targets in config order, catch-up as one run per missed window, backoff
 * delaying but never stopping a target, stop() ending the loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LockHeldError } from "../../shared/errors.js";
import type { ScheduleSpec } from "../../shared/time.js";
import { deriveBackoff } from "../internal/reports.js";
import { BACKOFF_CAP_MS, backoffDelayMs, BackoffTracker, nextDueAt, Scheduler } from "../internal/scheduler.js";
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
        startedAt: "",
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

    it("logs one error line per transition: enter, extend, ceiling, clear - and none otherwise", () => {
        const { log, lines } = captureLogger("error");
        const tracker = new BackoffTracker(log);
        const errorLines = (): string[] => lines.filter((line) => line.includes("ERROR"));

        tracker.record("web", "failed", finished);
        expect(errorLines()).toHaveLength(1);
        expect(errorLines()[0]).toContain("entering failure backoff");
        expect(errorLines()[0]).toContain("failures=1");

        tracker.record("web", "failed", finished);
        expect(errorLines()).toHaveLength(2);
        expect(errorLines()[1]).toContain("extending failure backoff");

        for (let i = 0; i < 4; i += 1) {
            tracker.record("web", "failed", finished);
        }
        expect(errorLines().at(-1)).toContain("at ceiling for failure backoff");

        tracker.record("web", "success", finished);
        expect(errorLines().at(-1)).toContain("clearing failure backoff");

        const count = errorLines().length;
        tracker.record("web", "success", finished);
        tracker.record("web", "skipped", finished);
        tracker.record("web", "aborted", finished);
        expect(errorLines()).toHaveLength(count);
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
        listNewest?: (target: ReturnType<typeof makeTarget>) => Promise<string | null>;
    }): { scheduler: Scheduler; runs: string[]; tracker: BackoffTracker; recorded: TargetRunReport[] } {
        const { log } = captureLogger("error");
        const tracker = new BackoffTracker(log);
        const runs: string[] = [];
        const recorded: TargetRunReport[] = [];
        const scheduler = new Scheduler({
            targets: params.targets,
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            listNewest: params.listNewest ?? (async (target) => params.newest?.[target.name] ?? null),
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
        return { scheduler, runs, tracker, recorded };
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
            listNewest: async () => {
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
            listNewest: async () => null,
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
            listNewest: async () => {
                listCalls += 1;
                return newest;
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

    // Regression: the due check's listing is an ssh round-trip for a push
    // target, so archive host down / key revoked / jail script renamed all land
    // in its catch - which logged a warn and continued BEFORE runTarget, so no
    // report was ever written. consecutiveFailures stayed 0, backoff never
    // engaged, and `status` kept reporting the last success while nothing ran.
    it("a failing due check is recorded as a failed run and climbs the failure count", async () => {
        const target = makeTarget({ name: "web", schedule: HOURLY });
        const { scheduler, runs, tracker, recorded } = makeLoop({
            targets: [target],
            listNewest: async () => {
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
            listNewest: async () => null,
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
            listNewest: async () => {
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
