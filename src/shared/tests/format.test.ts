import { describe, expect, it } from "vitest";
import {
    formatBytes,
    formatDuration,
    formatEndpoint,
    formatUtc,
    isValidBwlimit,
    parseMinFree,
    parseSize,
} from "../format.js";
import { formatSnapshotName } from "../snapshot-name.js";
import type { Endpoint, ResolvedRemote } from "../types.js";

/** A fully resolved explicit remote fixture. */
function explicitRemote(overrides?: Partial<Extract<ResolvedRemote, { kind: "explicit" }>>): ResolvedRemote {
    return {
        kind: "explicit",
        restrictedShell: false,
        name: "r1",
        host: "10.0.0.11",
        user: "backup-reader",
        port: 22,
        identityFile: "/etc/backupkit/keys/id",
        passphrase: null,
        knownHostsFile: "/etc/backupkit/known_hosts",
        ...overrides,
    };
}

describe("parseSize", () => {
    it.each([
        ["500K", 500 * 1024],
        ["10M", 10 * 1024 ** 2],
        ["10G", 10 * 1024 ** 3],
        ["1.5T", 1.5 * 1024 ** 4],
        ["0K", 0],
        ["0.5M", 0.5 * 1024 ** 2],
    ] as const)("parses %s as binary bytes", (text, expected) => {
        expect(parseSize(text)).toBe(expected);
    });

    it.each([["10"], ["10GB"], ["10g"], ["K"], ["-5M"], [""], ["1..5G"], ["1,5G"], ["10 G"], ["10P"]])(
        "rejects %s",
        (text) => {
            expect(parseSize(text)).toBeNull();
        },
    );
});

describe("parseMinFree", () => {
    it.each([
        ["5%", { kind: "percent", percent: 5 }],
        ["0%", { kind: "percent", percent: 0 }],
        ["50%", { kind: "percent", percent: 50 }],
        ["2.5%", { kind: "percent", percent: 2.5 }],
        ["10G", { kind: "bytes", bytes: 10 * 1024 ** 3 }],
        ["500M", { kind: "bytes", bytes: 500 * 1024 ** 2 }],
        ["1T", { kind: "bytes", bytes: 1024 ** 4 }],
    ] as const)("parses %s", (text, expected) => {
        expect(parseMinFree(text)).toEqual(expected);
    });

    it.each([["51%"], ["100%"], ["-5%"], ["%"], ["10"], ["abc"], ["10GB"], [""], ["5 %"]])(
        "rejects %s",
        (text) => {
            expect(parseMinFree(text)).toBeNull();
        },
    );
});

describe("isValidBwlimit", () => {
    it.each([["500K"], ["10M"], ["2G"], ["1"], ["1.5"], ["1.5M"], ["0"]])("accepts %s", (text) => {
        expect(isValidBwlimit(text)).toBe(true);
    });

    it.each([["10Kbps"], ["10T"], ["K"], ["-1"], [""], ["1 M"], ["10m"], ["1,5"]])("rejects %s", (text) => {
        expect(isValidBwlimit(text)).toBe(false);
    });
});

describe("formatUtc", () => {
    it.each([
        // The canonical shape, and the one every other surface is compared to.
        ["2026-08-10T03:15:02.000Z", "2026-08-10T03:15:02Z"],
        // Sub-second precision is TRUNCATED, never rounded: .999 must not roll
        // the second forward, or a displayed time could sit ahead of the
        // snapshot name minted from the same instant.
        ["2026-08-10T03:15:02.999Z", "2026-08-10T03:15:02Z"],
        // Every field zero-padded to its full width.
        ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05Z"],
        // Boundaries: midnight, the last second of a day, a leap day, and the
        // epoch itself.
        ["2026-08-10T00:00:00Z", "2026-08-10T00:00:00Z"],
        ["2026-12-31T23:59:59Z", "2026-12-31T23:59:59Z"],
        ["2028-02-29T12:00:00Z", "2028-02-29T12:00:00Z"],
        ["1970-01-01T00:00:00Z", "1970-01-01T00:00:00Z"],
    ] as const)("formats %s as %s", (input, expected) => {
        expect(formatUtc(new Date(input))).toBe(expected);
    });

    // The whole point of the `Z`: the output is the UTC wall clock, never the
    // host's. A host at UTC+02:00 must still print 03:15:02Z for this instant.
    it("renders UTC, not the host timezone", () => {
        const instant = new Date(Date.UTC(2026, 7, 10, 3, 15, 2));
        expect(formatUtc(instant)).toBe("2026-08-10T03:15:02Z");
        // Same instant, expressed via a local-time offset - same UTC rendering.
        expect(formatUtc(new Date(instant.getTime()))).toBe("2026-08-10T03:15:02Z");
    });

    // The two formats are one format: the snapshot DIRECTORY name is this
    // string with the colons removed (`:` is illegal on exFAT/NTFS/SMB). If
    // this ever fails the display and on-disk forms have drifted apart.
    it("is the snapshot name with colons - the two forms cannot drift", () => {
        for (const iso of ["2026-08-10T03:15:02Z", "1999-12-31T23:59:59Z", "2028-02-29T00:00:00Z"]) {
            const date = new Date(iso);
            expect(formatSnapshotName(date)).toBe(formatUtc(date).replaceAll(":", ""));
        }
    });
});

describe("formatBytes", () => {
    it.each([
        [0, "0 B"],
        [812, "812 B"],
        [1023, "1023 B"],
        [1024, "1.0 KiB"],
        [10 * 1024 ** 2, "10.0 MiB"],
        [1.5 * 1024 ** 3, "1.5 GiB"],
        [2 * 1024 ** 4, "2.0 TiB"],
        [3 * 1024 ** 5, "3.0 PiB"],
    ] as const)("formats %d as %s", (bytes, expected) => {
        expect(formatBytes(bytes)).toBe(expected);
    });
});

describe("formatDuration", () => {
    it.each([
        [0, "0ms"],
        [743, "743ms"],
        [1000, "1s"],
        [41_000, "41s"],
        [125_000, "2m 5s"],
        [120_000, "2m"],
        [3_840_000, "1h 4m"],
        [3_600_000, "1h"],
        [183_600_000, "2d 3h"],
        [86_400_000, "1d"],
    ] as const)("formats %d ms as %s", (ms, expected) => {
        expect(formatDuration(ms)).toBe(expected);
    });
});

describe("formatEndpoint", () => {
    it("passes a local endpoint through as its bare path", () => {
        const endpoint: Endpoint = { kind: "local", path: "/srv/backups" };
        expect(formatEndpoint(endpoint)).toBe("/srv/backups");
    });

    it("prefixes user@host: for an explicit remote", () => {
        const endpoint: Endpoint = { kind: "remote", remote: explicitRemote(), path: "/var/www" };
        expect(formatEndpoint(endpoint)).toBe("backup-reader@10.0.0.11:/var/www");
    });

    it("brackets an IPv6 host", () => {
        const endpoint: Endpoint = { kind: "remote", remote: explicitRemote({ host: "fe80::1" }), path: "/var/www" };
        expect(formatEndpoint(endpoint)).toBe("backup-reader@[fe80::1]:/var/www");
    });

    it("ignores the port - ports travel in the ssh tokens", () => {
        const endpoint: Endpoint = { kind: "remote", remote: explicitRemote({ port: 2222 }), path: "/var/www" };
        expect(formatEndpoint(endpoint)).not.toContain("2222");
    });

    it("formats an alias remote as alias:path - no user@, no brackets", () => {
        const remote: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "r1", alias: "myserver" };
        const endpoint: Endpoint = { kind: "remote", remote, path: "/var/www" };
        expect(formatEndpoint(endpoint)).toBe("myserver:/var/www");
        expect(formatEndpoint(endpoint)).not.toContain("@");
        expect(formatEndpoint(endpoint)).not.toContain("[");
    });
});
