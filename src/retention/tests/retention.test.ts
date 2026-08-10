import { describe, expect, it } from "vitest";
import { formatSnapshotName } from "../../shared/snapshot-name.js";
import type { RetentionRules } from "../../shared/types.js";
import { planRetention } from "../retention.js";

/** Build a snapshot name for a UTC instant, defaulting time-of-day fields to zero. */
function snap(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): string {
    return formatSnapshotName(new Date(Date.UTC(year, month - 1, day, hour, minute, second)));
}

/** Fixed clock used everywhere `now` is required but, per the algorithm, never consulted. */
const NOW = new Date(Date.UTC(2026, 7, 10, 12, 0, 0));

describe("planRetention: base cases", () => {
    it("returns an empty plan for empty input", () => {
        expect(planRetention([], null, NOW)).toEqual({ keep: [], prune: [] });
    });

    it("ignores names that fail parseSnapshotName, in either list", () => {
        const valid = snap(2026, 8, 10);
        const plan = planRetention(
            [valid, "not-a-snapshot", "2026-02-30T000000Z", "20260810T031502Z"],
            null,
            NOW,
        );
        expect(plan.keep).toEqual([{ name: valid, reasons: ["newest", "keep-all"] }]);
        expect(plan.prune).toEqual([]);
    });

    it("keeps every snapshot with reason keep-all (plus newest on the newest) when rules is null", () => {
        const s1 = snap(2026, 1, 1);
        const s2 = snap(2026, 6, 1);
        const s3 = snap(2026, 8, 10);
        const plan = planRetention([s1, s2, s3], null, NOW);
        expect(plan.keep).toEqual([
            { name: s3, reasons: ["newest", "keep-all"] },
            { name: s2, reasons: ["keep-all"] },
            { name: s1, reasons: ["keep-all"] },
        ]);
        expect(plan.prune).toEqual([]);
    });

    it("keeps only the newest, unconditionally, when every rule is explicitly zero", () => {
        const s1 = snap(2026, 1, 1);
        const s2 = snap(2026, 6, 1);
        const s3 = snap(2026, 8, 10);
        const rules: RetentionRules = {
            keepLast: 0,
            keepHourly: 0,
            keepDaily: 0,
            keepWeekly: 0,
            keepMonthly: 0,
            keepYearly: 0,
        };
        const plan = planRetention([s1, s2, s3], rules, NOW);
        expect(plan.keep).toEqual([{ name: s3, reasons: ["newest"] }]);
        expect(plan.prune).toEqual([s2, s1]);
    });

    it("input order does not matter - output is sorted newest first regardless of input order", () => {
        const s1 = snap(2026, 1, 1);
        const s2 = snap(2026, 6, 1);
        const s3 = snap(2026, 8, 10);
        const plan = planRetention([s2, s3, s1], null, NOW);
        expect(plan.keep.map((k) => k.name)).toEqual([s3, s2, s1]);
    });
});

describe("planRetention: single-tier GFS tables", () => {
    it.each([
        [
            "keepHourly keeps the newest snapshot per unseen hour, newest-first, up to the count",
            [
                snap(2026, 8, 10, 5, 0, 0),
                snap(2026, 8, 10, 5, 30, 0),
                snap(2026, 8, 10, 6, 0, 0),
                snap(2026, 8, 10, 7, 0, 0),
            ],
            { keepHourly: 2 } as RetentionRules,
            [
                { name: snap(2026, 8, 10, 7, 0, 0), reasons: ["newest", "hourly=2026-08-10T07"] },
                { name: snap(2026, 8, 10, 6, 0, 0), reasons: ["hourly=2026-08-10T06"] },
            ],
            [snap(2026, 8, 10, 5, 30, 0), snap(2026, 8, 10, 5, 0, 0)],
        ],
        [
            "keepDaily keeps the newest snapshot per unseen day, even when a same-day older one exists",
            [snap(2026, 8, 8), snap(2026, 8, 8, 12), snap(2026, 8, 9), snap(2026, 8, 9, 12), snap(2026, 8, 10)],
            { keepDaily: 2 } as RetentionRules,
            [
                { name: snap(2026, 8, 10), reasons: ["newest", "daily=2026-08-10"] },
                { name: snap(2026, 8, 9, 12), reasons: ["daily=2026-08-09"] },
            ],
            [snap(2026, 8, 9), snap(2026, 8, 8, 12), snap(2026, 8, 8)],
        ],
        [
            "keepWeekly keeps the newest snapshot per unseen ISO week, Monday start",
            [snap(2025, 12, 29), snap(2025, 12, 31), snap(2026, 1, 1), snap(2026, 1, 4), snap(2026, 1, 5)],
            { keepWeekly: 2 } as RetentionRules,
            [
                { name: snap(2026, 1, 5), reasons: ["newest", "weekly=2026-W02"] },
                { name: snap(2026, 1, 4), reasons: ["weekly=2026-W01"] },
            ],
            [snap(2026, 1, 1), snap(2025, 12, 31), snap(2025, 12, 29)],
        ],
        [
            "keepMonthly keeps the newest snapshot per unseen UTC month",
            [snap(2026, 1, 5), snap(2026, 1, 20), snap(2026, 2, 5), snap(2026, 2, 20), snap(2026, 3, 5)],
            { keepMonthly: 2 } as RetentionRules,
            [
                { name: snap(2026, 3, 5), reasons: ["newest", "monthly=2026-03"] },
                { name: snap(2026, 2, 20), reasons: ["monthly=2026-02"] },
            ],
            [snap(2026, 2, 5), snap(2026, 1, 20), snap(2026, 1, 5)],
        ],
        [
            "keepYearly keeps the newest snapshot per unseen UTC year",
            [snap(2024, 6, 1), snap(2024, 12, 1), snap(2025, 6, 1), snap(2025, 12, 1), snap(2026, 6, 1)],
            { keepYearly: 2 } as RetentionRules,
            [
                { name: snap(2026, 6, 1), reasons: ["newest", "yearly=2026"] },
                { name: snap(2025, 12, 1), reasons: ["yearly=2025"] },
            ],
            [snap(2025, 6, 1), snap(2024, 12, 1), snap(2024, 6, 1)],
        ],
        [
            "keepLast keeps the N newest unconditionally",
            [
                snap(2026, 8, 1),
                snap(2026, 8, 2),
                snap(2026, 8, 3),
                snap(2026, 8, 4),
                snap(2026, 8, 5),
            ],
            { keepLast: 3 } as RetentionRules,
            [
                { name: snap(2026, 8, 5), reasons: ["newest", "last"] },
                { name: snap(2026, 8, 4), reasons: ["last"] },
                { name: snap(2026, 8, 3), reasons: ["last"] },
            ],
            [snap(2026, 8, 2), snap(2026, 8, 1)],
        ],
    ] as const)("%s", (_description, snapshots, rules, expectedKeep, expectedPrune) => {
        const plan = planRetention([...snapshots], rules, NOW);
        expect(plan.keep).toEqual(expectedKeep);
        expect(plan.prune).toEqual(expectedPrune);
    });
});

describe("planRetention: leap day", () => {
    it("buckets a leap-day snapshot (2028-02-29) correctly under keepDaily and keepYearly", () => {
        const leapDay = snap(2028, 2, 29);
        const dayBefore = snap(2028, 2, 28);
        const plan = planRetention([dayBefore, leapDay], { keepDaily: 1, keepYearly: 1 }, NOW);
        expect(plan.keep).toEqual([{ name: leapDay, reasons: ["newest", "daily=2028-02-29", "yearly=2028"] }]);
        expect(plan.prune).toEqual([dayBefore]);
    });
});

describe("planRetention: overlapping tiers and multi-reason snapshots", () => {
    it("keepLast can keep a snapshot a tier does not separately claim, while the tier still spends its count on the newest", () => {
        const a = snap(2026, 8, 10, 0, 0, 0);
        const b = snap(2026, 8, 10, 12, 0, 0);
        const c = snap(2026, 8, 11, 0, 0, 0);
        const plan = planRetention([a, b, c], { keepLast: 2, keepDaily: 1 }, NOW);
        expect(plan.keep).toEqual([
            { name: c, reasons: ["newest", "last", "daily=2026-08-11"] },
            { name: b, reasons: ["last"] },
        ]);
        expect(plan.prune).toEqual([a]);
    });

    it("a single snapshot accumulates one reason per rule that independently claims it", () => {
        const d10 = snap(2026, 8, 10);
        const d11 = snap(2026, 8, 11);
        const d12 = snap(2026, 8, 12);
        const plan = planRetention([d10, d11, d12], { keepLast: 1, keepDaily: 2, keepWeekly: 1 }, NOW);
        expect(plan.keep).toEqual([
            { name: d12, reasons: ["newest", "last", "daily=2026-08-12", "weekly=2026-W33"] },
            { name: d11, reasons: ["daily=2026-08-11"] },
        ]);
        expect(plan.prune).toEqual([d10]);
    });
});

describe("planRetention: large mixed table", () => {
    it("combines keepLast, keepDaily, keepWeekly, and keepMonthly across a multi-month history", () => {
        const dates: [number, number, number][] = [
            [2026, 6, 1],
            [2026, 6, 15],
            [2026, 6, 29],
            [2026, 7, 6],
            [2026, 7, 13],
            [2026, 7, 20],
            [2026, 7, 27],
            [2026, 8, 3],
            [2026, 8, 9],
            [2026, 8, 10],
        ];
        const names = dates.map(([y, m, d]) => snap(y, m, d));
        const [n1, n2, n3, n4, n5, n6, , n8, n9, n10] = names;

        const plan = planRetention(names, { keepLast: 2, keepDaily: 3, keepWeekly: 2, keepMonthly: 2 }, NOW);

        expect(plan.keep).toEqual([
            { name: n10, reasons: ["newest", "last", "daily=2026-08-10", "weekly=2026-W33", "monthly=2026-08"] },
            { name: n9, reasons: ["last", "daily=2026-08-09", "weekly=2026-W32"] },
            { name: n8, reasons: ["daily=2026-08-03"] },
            { name: names[6], reasons: ["monthly=2026-07"] },
        ]);
        expect(plan.prune).toEqual([n6, n5, n4, n3, n2, n1]);
    });
});
