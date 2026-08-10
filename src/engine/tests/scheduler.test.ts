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
    }): { scheduler: Scheduler; runs: string[]; tracker: BackoffTracker } {
        const { log } = captureLogger("error");
        const tracker = new BackoffTracker(log);
        const runs: string[] = [];
        const scheduler = new Scheduler({
            targets: params.targets,
            log,
            now: () => new Date(),
            tickMs: 30_000,
            backoff: tracker,
            listNewest: async (target) => params.newest?.[target.name] ?? null,
            runTarget: async (target) => {
                runs.push(target.name);
                const result = params.outcome?.(target.name) ?? report(target.name, "success", "2026-08-10T120000Z");
                tracker.record(target.name, result.status, new Date());
                return result;
            },
        });
        return { scheduler, runs, tracker };
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
        });
        const loop = scheduler.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(lines.some((line) => line.includes("lock held"))).toBe(true);
        scheduler.stop();
        await loop;
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
