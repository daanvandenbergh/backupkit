/**
 * The one "is this machine on a network at all?" check, read from the local
 * interface table - no probe, no packet, no dependency.
 *
 * It exists to keep an OFFLINE laptop from producing a night of alarming
 * logs. Without it every due target dialled its remote, burned three retries
 * and a 60 s timeout, and logged a failure that read exactly like a revoked
 * key - so a week of flaky Wi-Fi and a genuinely broken config were
 * indistinguishable at a glance.
 *
 * Deliberately one-sided: it can prove the machine is OFF the network, never
 * that a route to the archive exists. A captive portal, a dead uplink or a
 * powered-off backup server all still read as "connected" here, and the ssh
 * classifier stays the authority on what actually went wrong. That asymmetry
 * is the safety property - only a certainty is allowed to skip a backup.
 */

import { networkInterfaces } from "node:os";

/** Self-assigned (APIPA / IPv6 link-local) addresses: an interface that got no real configuration. */
const LINK_LOCAL = /^(169\.254\.|fe80:)/i;

/**
 * Whether this machine has any usable network interface: one that is not the
 * loopback and whose address is not self-assigned. False means every
 * interface is loopback or link-local, i.e. nothing can be reached and there
 * is no point dialling.
 */
export function hasNetworkLink(): boolean {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (!address.internal && !LINK_LOCAL.test(address.address)) {
                return true;
            }
        }
    }
    return false;
}
