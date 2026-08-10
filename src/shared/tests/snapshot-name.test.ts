import { describe, expect, it } from "vitest";
import {
    SNAPSHOT_NAME_REGEX,
    formatSnapshotName,
    isDeletingName,
    isPartialName,
    parseSnapshotName,
} from "../snapshot-name.js";

describe("formatSnapshotName", () => {
    it("formats a UTC date as ISO-basic without colons", () => {
        expect(formatSnapshotName(new Date(Date.UTC(2026, 7, 10, 3, 15, 2)))).toBe("2026-08-10T031502Z");
    });

    it("truncates to whole seconds", () => {
        expect(formatSnapshotName(new Date(Date.UTC(2026, 7, 10, 3, 15, 2, 999)))).toBe("2026-08-10T031502Z");
    });

    it("zero-pads every component", () => {
        expect(formatSnapshotName(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe("2026-01-01T000000Z");
    });

    it("produces names matching the regex", () => {
        expect(SNAPSHOT_NAME_REGEX.test(formatSnapshotName(new Date()))).toBe(true);
    });
});

describe("parseSnapshotName", () => {
    it("round-trips through formatSnapshotName", () => {
        const date = new Date(Date.UTC(2026, 7, 10, 3, 15, 2));
        expect(parseSnapshotName(formatSnapshotName(date))?.getTime()).toBe(date.getTime());
    });

    it.each([
        ["a legacy epoch-seconds name", "1723275300"],
        ["a compact form", "20260810T031502Z"],
        ["a colon ISO form", "2026-08-10T03:15:02Z"],
        ["a missing Z", "2026-08-10T031502"],
        ["a partial suffix", "2026-08-10T031502Z.partial"],
        ["a deleting suffix", "2026-08-10T031502Z.deleting"],
        ["trailing garbage", "2026-08-10T031502Zx"],
        ["leading garbage", "x2026-08-10T031502Z"],
        ["the empty string", ""],
    ] as const)("rejects %s", (_label, name) => {
        expect(parseSnapshotName(name)).toBeNull();
    });

    it.each([
        ["an impossible day", "2026-02-30T000000Z"],
        ["a zero day", "2026-08-00T000000Z"],
        ["month 13", "2026-13-01T000000Z"],
        ["month 00", "2026-00-10T000000Z"],
        ["hour 24", "2026-08-10T240000Z"],
        ["minute 60", "2026-08-10T036000Z"],
        ["second 60", "2026-08-10T031560Z"],
        ["a non-leap Feb 29", "2026-02-29T000000Z"],
    ] as const)("rejects %s despite matching the regex shape", (_label, name) => {
        expect(parseSnapshotName(name)).toBeNull();
    });

    it("accepts a real leap day", () => {
        expect(parseSnapshotName("2024-02-29T120000Z")?.getTime()).toBe(Date.UTC(2024, 1, 29, 12, 0, 0));
    });
});

describe("lexical sort = chronological sort", () => {
    it("sorting names lexically equals sorting their dates chronologically", () => {
        const dates = [
            new Date(Date.UTC(2026, 7, 10, 3, 15, 2)),
            new Date(Date.UTC(1999, 11, 31, 23, 59, 59)),
            new Date(Date.UTC(2000, 0, 1, 0, 0, 0)),
            new Date(Date.UTC(2026, 7, 9, 23, 59, 59)),
            new Date(Date.UTC(2026, 7, 10, 3, 15, 3)),
            new Date(Date.UTC(2026, 11, 31, 0, 0, 0)),
            new Date(Date.UTC(2027, 0, 1, 0, 0, 0)),
        ];
        const lexical = dates.map(formatSnapshotName).sort();
        const chronological = [...dates].sort((a, b) => a.getTime() - b.getTime()).map(formatSnapshotName);
        expect(lexical).toEqual(chronological);
    });

    it("names are fixed width", () => {
        const names = [new Date(0), new Date(Date.UTC(2099, 11, 31, 23, 59, 59))].map(formatSnapshotName);
        expect(new Set(names.map((name) => name.length)).size).toBe(1);
    });
});

describe("isPartialName / isDeletingName", () => {
    it.each([
        ["2026-08-10T031502Z.partial", true],
        ["2026-08-10T031502Z", false],
        ["2026-08-10T031502Z.deleting", false],
        ["1723275300.partial", false],
        ["2026-02-30T000000Z.partial", false],
        [".partial", false],
        ["2026-08-10T031502Z.partial.partial", false],
    ] as const)("isPartialName(%s) -> %s", (entry, expected) => {
        expect(isPartialName(entry)).toBe(expected);
    });

    it.each([
        ["2026-08-10T031502Z.deleting", true],
        ["2026-08-10T031502Z", false],
        ["2026-08-10T031502Z.partial", false],
        ["1723275300.deleting", false],
        ["2026-13-01T000000Z.deleting", false],
        [".deleting", false],
    ] as const)("isDeletingName(%s) -> %s", (entry, expected) => {
        expect(isDeletingName(entry)).toBe(expected);
    });
});
