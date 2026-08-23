/**
 * Network-link guard tests: the free, packet-free half of the reachability
 * probe. Its answer decides whether a due target is dialled at all, so a
 * wrong `false` silently stops every backup on the machine - which makes
 * "which addresses count as a link" the rule worth pinning.
 *
 * Fixtures, never the live interface table: a first version asserted the real
 * machine was online and failed the moment the developer's Wi-Fi dropped
 * mid-run - a test of the room it ran in, not of the code.
 */

import { describe, expect, it } from "vitest";

import { hasNetworkLink } from "../network.js";

/** An interface-table reader over the given fixture. */
function table(entries: Record<string, { address: string; internal: boolean }[]>): () => typeof entries {
    return () => entries;
}

describe("hasNetworkLink", () => {
    it("is true for an ordinary IPv4 address on a real interface", () => {
        expect(
            hasNetworkLink(
                table({
                    lo0: [{ address: "127.0.0.1", internal: true }],
                    en0: [{ address: "192.168.1.208", internal: false }],
                }),
            ),
        ).toBe(true);
    });

    it("is true for a routable IPv6 address", () => {
        expect(hasNetworkLink(table({ en0: [{ address: "2a0d:3344:6c80:c310::1", internal: false }] }))).toBe(true);
    });

    it("is false when only the loopback is up", () => {
        expect(
            hasNetworkLink(
                table({
                    lo0: [
                        { address: "127.0.0.1", internal: true },
                        { address: "::1", internal: true },
                        { address: "fe80::1", internal: true },
                    ],
                }),
            ),
        ).toBe(false);
    });

    // The case this rule exists for: a laptop whose Wi-Fi associated but got no
    // configuration still has non-internal interfaces, all self-assigned. They
    // reach nothing, so they must not read as a link.
    it("is false when every non-loopback address is self-assigned", () => {
        expect(
            hasNetworkLink(
                table({
                    lo0: [{ address: "127.0.0.1", internal: true }],
                    en0: [{ address: "169.254.31.7", internal: false }],
                    awdl0: [{ address: "fe80::9069:fcff:fedb:aa0e", internal: false }],
                    utun0: [{ address: "FE80::4A12:795C:408A:C1A8", internal: false }],
                }),
            ),
        ).toBe(false);
    });

    // One real address among a pile of link-local ones is a link - this is the
    // ordinary shape of a Mac with VPN and AirDrop interfaces up.
    it("finds a single real address among many link-local ones", () => {
        expect(
            hasNetworkLink(
                table({
                    awdl0: [{ address: "fe80::9069:fcff:fedb:aa0e", internal: false }],
                    utun3: [{ address: "fe80::ce81:b1c:bd2c:69e", internal: false }],
                    en0: [
                        { address: "fe80::1802:1f06:9928:21a7", internal: false },
                        { address: "192.168.1.208", internal: false },
                    ],
                }),
            ),
        ).toBe(true);
    });

    it("is false for an empty interface table", () => {
        expect(hasNetworkLink(table({}))).toBe(false);
    });
});
