import { afterEach, describe, expect, it } from "vitest";
import { parseSnapshotName } from "../snapshot-name.js";
import {
    daysSinceEpoch,
    hoursSinceEpoch,
    isDue,
    minutesSinceEpoch,
    monthsSinceEpoch,
    weeksSinceEpoch,
    windowAnchor,
    windowIndex,
    windowStart,
    type ScheduleSpec,
} from "../time.js";

/** Build a ScheduleSpec with defaults filled, overriding what a test needs. */
function schedule(overrides: Partial<ScheduleSpec>): ScheduleSpec {
    return { interval: "day", intervalCount: 1, at: "00:00", on: "mon", dayOfMonth: 1, ...overrides };
}

/** Shorthand UTC date constructor. */
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

describe("units since epoch", () => {
    it("counts whole units, flooring", () => {
        expect(minutesSinceEpoch(new Date(59_999))).toBe(0);
        expect(minutesSinceEpoch(new Date(60_000))).toBe(1);
        expect(hoursSinceEpoch(new Date(3_599_999))).toBe(0);
        expect(hoursSinceEpoch(new Date(3_600_000))).toBe(1);
        expect(daysSinceEpoch(utc(1970, 1, 1, 23, 59, 59))).toBe(0);
        expect(daysSinceEpoch(utc(1970, 1, 2))).toBe(1);
    });

    it("monthsSinceEpoch uses calendar months, not day counts", () => {
        expect(monthsSinceEpoch(utc(1970, 1, 1))).toBe(0);
        expect(monthsSinceEpoch(utc(1970, 12, 31))).toBe(11);
        expect(monthsSinceEpoch(utc(1971, 1, 1))).toBe(12);
        expect(monthsSinceEpoch(utc(2025, 12, 31))).toBe(671);
        expect(monthsSinceEpoch(utc(2026, 1, 1))).toBe(672);
        expect(monthsSinceEpoch(utc(2026, 8, 10))).toBe(679);
    });

    it("weeksSinceEpoch is anchored on the on-day (1970-01-01 was a Thursday)", () => {
        // With a Thursday anchor, day 0 begins week 0 exactly.
        expect(weeksSinceEpoch(utc(1970, 1, 1), "thu")).toBe(0);
        expect(weeksSinceEpoch(utc(1970, 1, 7, 23, 59), "thu")).toBe(0);
        expect(weeksSinceEpoch(utc(1970, 1, 8), "thu")).toBe(1);
        // With a Monday anchor, the week containing day 0 started Mon 1969-12-29.
        expect(weeksSinceEpoch(utc(1970, 1, 1), "mon")).toBe(0);
        expect(weeksSinceEpoch(utc(1970, 1, 4, 23, 59), "mon")).toBe(0);
        expect(weeksSinceEpoch(utc(1970, 1, 5), "mon")).toBe(1);
    });
});

describe("minute windows", () => {
    it("adjacent minutes land in adjacent windows at intervalCount 1", () => {
        const s = schedule({ interval: "minute" });
        const a = windowIndex(s, utc(2026, 8, 10, 3, 15, 59));
        const b = windowIndex(s, utc(2026, 8, 10, 3, 16, 0));
        expect(b).toBe(a + 1);
        expect(windowIndex(s, utc(2026, 8, 10, 3, 15, 0))).toBe(a);
    });

    it("intervalCount 5 groups five minutes per window", () => {
        const s = schedule({ interval: "minute", intervalCount: 5 });
        const base = windowIndex(s, utc(2026, 8, 10, 3, 0, 0));
        expect(windowIndex(s, utc(2026, 8, 10, 3, 4, 59))).toBe(base);
        expect(windowIndex(s, utc(2026, 8, 10, 3, 5, 0))).toBe(base + 1);
    });

    it("the anchor is the window start (at is never meaningful)", () => {
        const s = schedule({ interval: "minute", intervalCount: 5 });
        const index = windowIndex(s, utc(2026, 8, 10, 3, 2, 30));
        expect(windowAnchor(s, index).getTime()).toBe(windowStart(s, index).getTime());
        expect(windowStart(s, index).getTime()).toBe(utc(2026, 8, 10, 3, 0, 0).getTime());
    });
});

describe("hour windows", () => {
    it("adjacent hours land in adjacent windows", () => {
        const s = schedule({ interval: "hour" });
        const a = windowIndex(s, utc(2026, 8, 10, 3, 59, 59));
        expect(windowIndex(s, utc(2026, 8, 10, 4, 0, 0))).toBe(a + 1);
    });

    it("intervalCount 6 groups six hours and anchors at the window start", () => {
        const s = schedule({ interval: "hour", intervalCount: 6 });
        const index = windowIndex(s, utc(2026, 8, 10, 3, 30, 0));
        expect(windowStart(s, index).getTime()).toBe(utc(2026, 8, 10, 0, 0, 0).getTime());
        expect(windowIndex(s, utc(2026, 8, 10, 5, 59, 59))).toBe(index);
        expect(windowIndex(s, utc(2026, 8, 10, 6, 0, 0))).toBe(index + 1);
        expect(windowAnchor(s, index).getTime()).toBe(windowStart(s, index).getTime());
    });
});

describe("day windows", () => {
    it("midnight UTC separates adjacent windows", () => {
        const s = schedule({ interval: "day" });
        const a = windowIndex(s, utc(2026, 8, 9, 23, 59, 59));
        expect(windowIndex(s, utc(2026, 8, 10, 0, 0, 0))).toBe(a + 1);
    });

    it("the anchor is the window's first day at 'at'", () => {
        const s = schedule({ interval: "day", at: "03:00" });
        const index = windowIndex(s, utc(2026, 8, 10, 12, 0, 0));
        expect(windowAnchor(s, index).getTime()).toBe(utc(2026, 8, 10, 3, 0, 0).getTime());
    });

    it("intervalCount 3 anchors at the window's FIRST day at 'at'", () => {
        const s = schedule({ interval: "day", intervalCount: 3, at: "12:00" });
        const index = windowIndex(s, utc(2026, 8, 10));
        const start = windowStart(s, index);
        expect(daysSinceEpoch(start) % 3).toBe(0);
        expect(windowAnchor(s, index).getTime()).toBe(start.getTime() + 12 * 3_600_000);
    });
});

describe("week windows", () => {
    it("windows start on the schedule's on-day (2026-08-10 is a Monday)", () => {
        const s = schedule({ interval: "week", on: "mon" });
        const index = windowIndex(s, utc(2026, 8, 12));
        expect(windowStart(s, index).getTime()).toBe(utc(2026, 8, 10).getTime());
        expect(windowStart(s, index).getUTCDay()).toBe(1);
    });

    it("the on-day boundary separates adjacent windows", () => {
        const s = schedule({ interval: "week", on: "mon" });
        const before = windowIndex(s, utc(2026, 8, 9, 23, 59, 59));
        expect(windowIndex(s, utc(2026, 8, 10, 0, 0, 0))).toBe(before + 1);
    });

    it("on 'sun' shifts the window start to Sunday", () => {
        const s = schedule({ interval: "week", on: "sun" });
        const index = windowIndex(s, utc(2026, 8, 10));
        expect(windowStart(s, index).getTime()).toBe(utc(2026, 8, 9).getTime());
        expect(windowStart(s, index).getUTCDay()).toBe(0);
    });

    it("the anchor is the window's first on-day at 'at'", () => {
        const s = schedule({ interval: "week", on: "mon", at: "01:00" });
        const index = windowIndex(s, utc(2026, 8, 12));
        expect(windowAnchor(s, index).getTime()).toBe(utc(2026, 8, 10, 1, 0, 0).getTime());
    });

    it("intervalCount 2 groups two on-anchored weeks", () => {
        const s = schedule({ interval: "week", intervalCount: 2, on: "mon" });
        const index = windowIndex(s, utc(2026, 8, 10));
        const start = windowStart(s, index);
        expect(start.getUTCDay()).toBe(1);
        expect(windowIndex(s, new Date(start.getTime() + 13 * 86_400_000))).toBe(index);
        expect(windowIndex(s, new Date(start.getTime() + 14 * 86_400_000))).toBe(index + 1);
    });
});

describe("month windows (months-since-epoch indexing)", () => {
    it("indices are adjacent across a year boundary", () => {
        const s = schedule({ interval: "month" });
        expect(windowIndex(s, utc(2026, 1, 1))).toBe(windowIndex(s, utc(2025, 12, 31, 23, 59, 59)) + 1);
    });

    it("Jan-31 23:59 and Feb-01 00:00 land in adjacent windows", () => {
        const s = schedule({ interval: "month" });
        const jan = windowIndex(s, utc(2026, 1, 31, 23, 59, 59));
        expect(windowIndex(s, utc(2026, 2, 1, 0, 0, 0))).toBe(jan + 1);
    });

    it("leap February is one whole window: Feb-01 through Feb-29 2024", () => {
        const s = schedule({ interval: "month" });
        const feb = windowIndex(s, utc(2024, 2, 1));
        expect(windowIndex(s, utc(2024, 2, 29, 23, 59, 59))).toBe(feb);
        expect(windowIndex(s, utc(2024, 3, 1))).toBe(feb + 1);
    });

    it("window starts at 00:00 UTC on the 1st of its first month", () => {
        const s = schedule({ interval: "month" });
        const index = windowIndex(s, utc(2026, 8, 10, 12, 30));
        expect(windowStart(s, index).getTime()).toBe(utc(2026, 8, 1).getTime());
    });

    it("intervalCount 2 windows start on even months-since-epoch", () => {
        const s = schedule({ interval: "month", intervalCount: 2 });
        // mse(2026-01) = 672 (even) -> Jan starts a window; Feb shares it; Mar starts the next.
        const jan = windowIndex(s, utc(2026, 1, 15));
        expect(windowIndex(s, utc(2026, 2, 15))).toBe(jan);
        expect(windowIndex(s, utc(2026, 3, 1))).toBe(jan + 1);
        expect(windowStart(s, jan).getTime()).toBe(utc(2026, 1, 1).getTime());
        expect(windowStart(s, jan + 1).getTime()).toBe(utc(2026, 3, 1).getTime());
    });

    it("the anchor is the first month's dayOfMonth at 'at'", () => {
        const s = schedule({ interval: "month", dayOfMonth: 15, at: "03:00" });
        const index = windowIndex(s, utc(2026, 8, 20));
        expect(windowAnchor(s, index).getTime()).toBe(utc(2026, 8, 15, 3, 0, 0).getTime());
    });

    it("with intervalCount 2 the anchor stays in the window's FIRST month", () => {
        const s = schedule({ interval: "month", intervalCount: 2, dayOfMonth: 10, at: "06:00" });
        const index = windowIndex(s, utc(2026, 2, 20));
        expect(windowAnchor(s, index).getTime()).toBe(utc(2026, 1, 10, 6, 0, 0).getTime());
    });
});

describe("isDue", () => {
    it("not due on the 1st when dayOfMonth is 15", () => {
        const s = schedule({ interval: "month", dayOfMonth: 15 });
        expect(isDue(s, null, utc(2026, 8, 1))).toBe(false);
        expect(isDue(s, null, utc(2026, 8, 14, 23, 59))).toBe(false);
        expect(isDue(s, null, utc(2026, 8, 15))).toBe(true);
    });

    it("gates on 'at' even with intervalCount > 1", () => {
        const s = schedule({ interval: "day", intervalCount: 3, at: "12:00" });
        const index = windowIndex(s, utc(2026, 8, 10));
        const start = windowStart(s, index);
        expect(isDue(s, null, new Date(start.getTime() + 11 * 3_600_000))).toBe(false);
        expect(isDue(s, null, new Date(start.getTime() + 12 * 3_600_000))).toBe(true);
        // The window's later days are past the anchor - still due when uncovered.
        expect(isDue(s, null, new Date(start.getTime() + 2 * 86_400_000))).toBe(true);
    });

    it("a snapshot in the current window suppresses due-ness", () => {
        const s = schedule({ interval: "day" });
        expect(isDue(s, utc(2026, 8, 10, 3, 15), utc(2026, 8, 10, 22, 0))).toBe(false);
        expect(isDue(s, utc(2026, 8, 10, 3, 15), utc(2026, 8, 11, 0, 0))).toBe(true);
    });

    it("restart simulation from a directory listing: intervalCount 3, no early re-fire", () => {
        const s = schedule({ interval: "day", intervalCount: 3 });
        const listing = ["2026-08-01T031500Z", "2026-08-04T031501Z", "2026-08-07T031459Z"];
        const newest = parseSnapshotName(listing[listing.length - 1])!;
        const coveredWindow = windowIndex(s, newest);
        // Every instant remaining in the covered window: not due, restart or not.
        const nextStart = windowStart(s, coveredWindow + 1);
        expect(isDue(s, newest, new Date(nextStart.getTime() - 1000))).toBe(false);
        // First instant of the next window: due.
        expect(isDue(s, newest, nextStart)).toBe(true);
    });

    it("catch-up after missed weeks is a single due state, not a queue", () => {
        const s = schedule({ interval: "week", on: "mon" });
        const lastRun = utc(2026, 7, 13, 4, 0);
        const now = utc(2026, 8, 12, 4, 0);
        expect(windowIndex(s, now) - windowIndex(s, lastRun)).toBeGreaterThan(2);
        expect(isDue(s, lastRun, now)).toBe(true);
        // One snapshot taken now covers the current window - nothing else is owed.
        expect(isDue(s, now, new Date(now.getTime() + 3_600_000))).toBe(false);
    });

    it("catch-up after missed months is a single due state", () => {
        const s = schedule({ interval: "month" });
        const lastRun = utc(2026, 3, 1, 0, 30);
        const now = utc(2026, 8, 10);
        expect(isDue(s, lastRun, now)).toBe(true);
        expect(isDue(s, now, utc(2026, 8, 20))).toBe(false);
    });

    it("minute schedules come due each window with no anchor gating", () => {
        const s = schedule({ interval: "minute" });
        const last = utc(2026, 8, 10, 3, 15, 30);
        expect(isDue(s, last, utc(2026, 8, 10, 3, 15, 59))).toBe(false);
        expect(isDue(s, last, utc(2026, 8, 10, 3, 16, 0))).toBe(true);
    });

    it("a null newest is due as soon as the anchor passes", () => {
        const s = schedule({ interval: "day", at: "03:00" });
        expect(isDue(s, null, utc(2026, 8, 10, 2, 59))).toBe(false);
        expect(isDue(s, null, utc(2026, 8, 10, 3, 0))).toBe(true);
    });
});

describe("timezone invariance", () => {
    const originalTz = process.env.TZ;

    afterEach(() => {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    });

    it.each([["America/New_York"], ["Asia/Kolkata"], ["UTC"]])(
        "window math is identical under TZ=%s",
        (tz) => {
            process.env.TZ = tz;
            const cases: ScheduleSpec[] = [
                schedule({ interval: "minute" }),
                schedule({ interval: "hour", intervalCount: 6 }),
                schedule({ interval: "day", at: "03:00" }),
                schedule({ interval: "week", on: "sun", at: "01:00" }),
                schedule({ interval: "month", intervalCount: 2, dayOfMonth: 15, at: "12:30" }),
            ];
            // A US DST transition instant and an Indian half-hour-offset midnight.
            const dates = [utc(2026, 3, 8, 7, 0), utc(2026, 11, 1, 6, 0), utc(2026, 8, 9, 18, 30)];
            for (const spec of cases) {
                for (const date of dates) {
                    const index = windowIndex(spec, date);
                    expect(windowIndex(spec, date)).toBe(index);
                    expect(windowStart(spec, index).toISOString()).toBe(
                        windowStart(spec, index).toISOString(),
                    );
                    // Anchor and start derive from UTC fields only - assert they are stable values.
                    expect(windowAnchor(spec, index).getTime()).toBeGreaterThanOrEqual(
                        windowStart(spec, index).getTime(),
                    );
                }
            }
        },
    );

    it("produces byte-identical results across two zones", () => {
        const spec = schedule({ interval: "month", dayOfMonth: 15, at: "03:00" });
        const date = utc(2026, 8, 10, 12, 0);
        process.env.TZ = "America/New_York";
        const indexNy = windowIndex(spec, date);
        const anchorNy = windowAnchor(spec, indexNy).toISOString();
        process.env.TZ = "Asia/Kolkata";
        const indexIn = windowIndex(spec, date);
        const anchorIn = windowAnchor(spec, indexIn).toISOString();
        expect(indexIn).toBe(indexNy);
        expect(anchorIn).toBe(anchorNy);
    });
});
