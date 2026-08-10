/**
 * Pure GFS (grandfather-father-son) retention policy, restic-style. No I/O:
 * every input arrives as a parameter, every output is a value. `retention/`
 * may import only from `shared/` (see the module map) and this file honors
 * that - `RetentionRules` is defined once in `shared/types.ts` and reused
 * here, never redefined.
 */

import { parseSnapshotName } from "../shared/snapshot-name.js";
import type { RetentionRules } from "../shared/types.js";

/**
 * The result of applying a retention policy to a set of snapshot names.
 * `keep` and `prune` together partition every syntactically valid input name
 * exactly once; both are ordered newest first for determinism.
 */
export interface RetentionPlan {
    /** Every snapshot the policy keeps, newest first, with every reason that claimed it. */
    keep: { name: string; reasons: string[] }[];
    /** Every snapshot no rule claimed, newest first. */
    prune: string[];
}

/** A parsed snapshot: its original name plus its decoded UTC instant. */
interface ParsedSnapshot {
    name: string;
    date: Date;
}

/** Left-pad a non-negative integer with zeros to the given width. */
function pad(value: number, width: number): string {
    return String(value).padStart(width, "0");
}

/** Hourly bucket key for a UTC instant: "YYYY-MM-DDTHH". */
function hourlyBucket(date: Date): string {
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}`;
}

/** Daily bucket key for a UTC instant: "YYYY-MM-DD". */
function dailyBucket(date: Date): string {
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/**
 * ISO-8601 week bucket key for a UTC instant: "GGGG-Www", Monday-start,
 * week 1 defined as the week containing the year's first Thursday (the
 * standard ISO rule, which is also why a week can belong to a different
 * year than the calendar date's own year at year boundaries).
 */
function weeklyBucket(date: Date): string {
    const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const mondayIndexedDay = (midnight.getUTCDay() + 6) % 7;
    midnight.setUTCDate(midnight.getUTCDate() - mondayIndexedDay + 3);
    const isoYear = midnight.getUTCFullYear();
    const yearStart = Date.UTC(isoYear, 0, 1);
    const weekNumber = Math.ceil(((midnight.getTime() - yearStart) / 86_400_000 + 1) / 7);
    return `${pad(isoYear, 4)}-W${pad(weekNumber, 2)}`;
}

/** Monthly bucket key for a UTC instant: "YYYY-MM". */
function monthlyBucket(date: Date): string {
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}`;
}

/** Yearly bucket key for a UTC instant: "YYYY". */
function yearlyBucket(date: Date): string {
    return `${pad(date.getUTCFullYear(), 4)}`;
}

/** One GFS tier: its reason prefix, its configured bucket count, and its bucket function. */
interface Tier {
    reasonPrefix: string;
    count: number | undefined;
    bucketOf: (date: Date) => string;
}

/**
 * Determine which snapshots a GFS retention policy keeps and which it
 * prunes.
 *
 * Algorithm (restic-style, deterministic - no wall-clock windowing):
 * snapshots are sorted newest first. The newest is always kept, reason
 * `"newest"` - a hard, unconditional invariant. `rules.keepLast` then keeps
 * the N newest, reason `"last"`. Each of the five tiers - hourly, daily,
 * weekly, monthly, yearly, in that order - then walks the snapshots
 * newest-first, computing that tier's UTC bucket key for each, and keeps the
 * newest snapshot of every bucket it has not yet seen until it has kept
 * `rules.keep<Tier>` distinct buckets, reason e.g. `"daily=2026-08-10"`. A
 * snapshot claimed by more than one rule carries every reason that claimed
 * it. Everything no rule claims is pruned.
 *
 * `rules === null` (no retention configured, or a target's retention turned
 * off) keeps every snapshot unconditionally, reason `"keep-all"` (in
 * addition to `"newest"` on the newest one). Any non-null `rules` value -
 * including one whose fields are all zero or absent - runs the tiered
 * algorithm above, under which only the newest snapshot survives if every
 * tier is off.
 *
 * Names that fail `parseSnapshotName` are ignored defensively (never appear
 * in `keep` or `prune`) - callers are expected to have already filtered to
 * complete-snapshot names, but this function does not trust that.
 *
 * `now` is accepted for signature parity with the rest of the codebase's
 * pure planning functions (every one takes its clock as an explicit
 * parameter, never reads `Date.now()`), but the restic-style algorithm above
 * has no wall-clock window to anchor - the tiers count backward through
 * whatever snapshots exist, not backward from `now` - so it does not affect
 * the plan.
 */
export function planRetention(snapshots: string[], rules: RetentionRules | null, now: Date): RetentionPlan {
    void now;

    const parsed: ParsedSnapshot[] = snapshots
        .map((name) => ({ name, date: parseSnapshotName(name) }))
        .filter((entry): entry is ParsedSnapshot => entry.date !== null)
        .sort((a, b) => b.date.getTime() - a.date.getTime());

    if (parsed.length === 0) {
        return { keep: [], prune: [] };
    }

    const reasonsByName = new Map<string, string[]>();
    const addReason = (name: string, reason: string): void => {
        const existing = reasonsByName.get(name);
        if (existing === undefined) {
            reasonsByName.set(name, [reason]);
        } else {
            existing.push(reason);
        }
    };

    addReason(parsed[0]!.name, "newest");

    if (rules === null) {
        for (const snapshot of parsed) {
            addReason(snapshot.name, "keep-all");
        }
    } else {
        if (rules.keepLast !== undefined && rules.keepLast > 0) {
            for (const snapshot of parsed.slice(0, rules.keepLast)) {
                addReason(snapshot.name, "last");
            }
        }

        const tiers: Tier[] = [
            { reasonPrefix: "hourly", count: rules.keepHourly, bucketOf: hourlyBucket },
            { reasonPrefix: "daily", count: rules.keepDaily, bucketOf: dailyBucket },
            { reasonPrefix: "weekly", count: rules.keepWeekly, bucketOf: weeklyBucket },
            { reasonPrefix: "monthly", count: rules.keepMonthly, bucketOf: monthlyBucket },
            { reasonPrefix: "yearly", count: rules.keepYearly, bucketOf: yearlyBucket },
        ];

        for (const tier of tiers) {
            if (tier.count === undefined || tier.count <= 0) {
                continue;
            }
            const seenBuckets = new Set<string>();
            for (const snapshot of parsed) {
                if (seenBuckets.size >= tier.count) {
                    break;
                }
                const bucket = tier.bucketOf(snapshot.date);
                if (seenBuckets.has(bucket)) {
                    continue;
                }
                seenBuckets.add(bucket);
                addReason(snapshot.name, `${tier.reasonPrefix}=${bucket}`);
            }
        }
    }

    const keep: { name: string; reasons: string[] }[] = [];
    const prune: string[] = [];
    for (const snapshot of parsed) {
        const reasons = reasonsByName.get(snapshot.name);
        if (reasons === undefined) {
            prune.push(snapshot.name);
        } else {
            keep.push({ name: snapshot.name, reasons });
        }
    }
    return { keep, prune };
}
