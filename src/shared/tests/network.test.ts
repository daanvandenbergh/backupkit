/**
 * Network-link guard tests: the free, packet-free half of the reachability
 * probe. It may only ever answer "off the network" when nothing at all is
 * usable - a false negative silently stops every backup.
 */

import { describe, expect, it } from "vitest";

import { hasNetworkLink } from "../network.js";

describe("hasNetworkLink", () => {
    // The machine running these tests has an interface, so the real answer is
    // true. The value of the assertion is the direction it fails in: a probe
    // that reads "offline" on a working machine would stop every backup.
    it("is true on a machine with a real interface", () => {
        expect(hasNetworkLink()).toBe(true);
    });
});
