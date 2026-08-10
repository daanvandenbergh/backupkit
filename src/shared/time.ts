/**
 * UTC schedule-window math for all five intervals (minute, hour, day, week,
 * month). Every boundary is UTC; the host timezone never influences a result.
 * Months use months-since-epoch indexing (calendar months), never a day-count
 * approximation. Pure: no clocks, no I/O - callers pass `now` explicitly.
 */

/** Schedule window unit. "month" means calendar months in UTC. */
export type Interval = "minute" | "hour" | "day" | "week" | "month";

/** Weekday short name, Monday-first. */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * Resolved schedule shape consumed by the window math: every field filled
 * (config resolution supplies the defaults). `config/types.ts` re-exports this
 * as `ScheduleConfig` - one source of truth for the shape.
 */
export interface ScheduleSpec {
    /** Window unit. Required. */
    interval: Interval;
    /** Run once every N intervals. Positive integer, default 1. */
    intervalCount: number;
    /** "HH:MM" UTC anchor within the window. Always "00:00" (never meaningful) for minute/hour. */
    at: string;
    /** Week anchor day. Only meaningful for interval "week". */
    on: Weekday;
    /** Anchor day-of-month, 1-28. Only meaningful for interval "month". */
    dayOfMonth: number;
}

/** Milliseconds per minute. */
const MINUTE_MS = 60_000;

/** Milliseconds per hour. */
const HOUR_MS = 3_600_000;

/** Milliseconds per day. */
const DAY_MS = 86_400_000;

/** Weekday name -> index, Monday = 0. */
const WEEKDAY_INDEX: Record<Weekday, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

/** Whole UTC minutes since the Unix epoch (floor). */
export function minutesSinceEpoch(date: Date): number {
    return Math.floor(date.getTime() / MINUTE_MS);
}

/** Whole UTC hours since the Unix epoch (floor). */
export function hoursSinceEpoch(date: Date): number {
    return Math.floor(date.getTime() / HOUR_MS);
}

/** Whole UTC days since the Unix epoch (floor). */
export function daysSinceEpoch(date: Date): number {
    return Math.floor(date.getTime() / DAY_MS);
}

/**
 * Calendar months since the Unix epoch: (utcYear - 1970) * 12 + utcMonth.
 * The month-window primitive - month length and leap years are irrelevant
 * by construction.
 */
export function monthsSinceEpoch(date: Date): number {
    return (date.getUTCFullYear() - 1970) * 12 + date.getUTCMonth();
}

/**
 * The latest epoch-day index at or before day 0 that falls on the given
 * weekday - the fixed anchor from which week indices are counted. Day 0
 * (1970-01-01) was a Thursday.
 */
function weekAnchorDayZero(on: Weekday): number {
    const thursday = 3;
    return -((((thursday - WEEKDAY_INDEX[on]) % 7) + 7) % 7);
}

/** Whole weeks since the fixed `on`-day anchor at/before the epoch (floor). */
export function weeksSinceEpoch(date: Date, on: Weekday): number {
    return Math.floor((daysSinceEpoch(date) - weekAnchorDayZero(on)) / 7);
}

/** Parse a validated "HH:MM" anchor into milliseconds past midnight UTC. */
function atOffsetMs(at: string): number {
    const [hours, minutes] = at.split(":");
    return Number(hours) * HOUR_MS + Number(minutes) * MINUTE_MS;
}

/**
 * The schedule window index containing `date`. Consecutive windows have
 * consecutive indices; two dates share a window iff their indices are equal.
 */
export function windowIndex(schedule: ScheduleSpec, date: Date): number {
    const count = schedule.intervalCount;
    switch (schedule.interval) {
        case "minute":
            return Math.floor(minutesSinceEpoch(date) / count);
        case "hour":
            return Math.floor(hoursSinceEpoch(date) / count);
        case "day":
            return Math.floor(daysSinceEpoch(date) / count);
        case "week":
            return Math.floor(weeksSinceEpoch(date, schedule.on) / count);
        case "month":
            return Math.floor(monthsSinceEpoch(date) / count);
    }
}

/**
 * The UTC start moment of the window with the given index: the first minute,
 * hour, or day of the window; the window's first `on` day at 00:00 for weeks;
 * 00:00 UTC on the 1st of the window's first month for months.
 */
export function windowStart(schedule: ScheduleSpec, index: number): Date {
    const count = schedule.intervalCount;
    switch (schedule.interval) {
        case "minute":
            return new Date(index * count * MINUTE_MS);
        case "hour":
            return new Date(index * count * HOUR_MS);
        case "day":
            return new Date(index * count * DAY_MS);
        case "week":
            return new Date((weekAnchorDayZero(schedule.on) + index * count * 7) * DAY_MS);
        case "month": {
            const months = index * count;
            const year = 1970 + Math.floor(months / 12);
            const month = ((months % 12) + 12) % 12;
            return new Date(Date.UTC(year, month, 1));
        }
    }
}

/**
 * The window's anchor moment - the earliest instant the window's run may
 * fire: the window start for minute/hour; the window's first day at `at` for
 * day; the window's first `on` day at `at` for week; the window's first
 * month's `dayOfMonth` at `at` for month.
 */
export function windowAnchor(schedule: ScheduleSpec, index: number): Date {
    const start = windowStart(schedule, index);
    switch (schedule.interval) {
        case "minute":
        case "hour":
            return start;
        case "day":
        case "week":
            return new Date(start.getTime() + atOffsetMs(schedule.at));
        case "month":
            return new Date(start.getTime() + (schedule.dayOfMonth - 1) * DAY_MS + atOffsetMs(schedule.at));
    }
}

/**
 * Whether a run is due: true when (a) no snapshot exists in the current
 * window (`newest` is the parsed time of the newest complete snapshot, or
 * null when none exists) and (b) `now` has reached the current window's
 * anchor moment. Failure backoff (condition c) is the engine's, not ours.
 */
export function isDue(schedule: ScheduleSpec, newest: Date | null, now: Date): boolean {
    const index = windowIndex(schedule, now);
    if (newest !== null && windowIndex(schedule, newest) === index) {
        return false;
    }
    return now.getTime() >= windowAnchor(schedule, index).getTime();
}
