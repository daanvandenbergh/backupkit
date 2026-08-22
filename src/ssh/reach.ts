/**
 * The pre-flight reachability probe: can this machine actually reach a
 * remote's ssh port RIGHT NOW - a link check, then DNS, then one TCP connect.
 *
 * It answers the question a daemon log kept failing to answer. An offline
 * laptop dialled every due target, burned three ssh retries and a 60 s
 * timeout each, and logged a failure worded exactly like a revoked key - so a
 * night of flaky Wi-Fi and a genuinely broken configuration were
 * indistinguishable at a glance, and the failure backoff climbed to its 6 h
 * ceiling over an outage that fixed itself.
 *
 * It probes THE CONFIGURED BACKUP SERVER, never a third-party "are you
 * online?" endpoint: that is the only host whose reachability actually
 * decides whether a backup can run, it sends no traffic anywhere the user did
 * not already point backupkit at, and it survives the captive-portal case a
 * ping to a public resolver reports as healthy.
 *
 * It NEVER decides that a failure is permanent - a refused port means the
 * host is up and answering, so the probe passes and lets ssh produce the real
 * error. Only "there is no path to this host" stops a run, because only that
 * is a condition where dialling cannot possibly work.
 */

import { createConnection } from "node:net";

import { hasNetworkLink } from "../shared/network.js";
import { sanitize } from "../shared/sanitize.js";
import type { ResolvedRemote } from "../shared/types.js";
import { resolveAlias, type ResolveAliasOptions } from "./ssh.js";

/** Default milliseconds to wait for the TCP connect before calling a host unreachable. */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Why a reachability probe failed - the three conditions where dialling cannot work. */
export type ReachFailure =
    /** No usable interface at all: Wi-Fi off, cable out, VPN down. */
    | "no-link"
    /** The hostname did not resolve: no DNS server reachable, or the name is wrong. */
    | "dns"
    /** Resolved, but no route or no answer on the ssh port. */
    | "unreachable";

/** The outcome of one reachability probe. */
export interface ReachResult {
    /** True when a run may proceed - reachable, or not provably unreachable. */
    ok: boolean;
    /** Which condition failed, or null when `ok`. */
    failure: ReachFailure | null;
    /** One sanitized sentence naming what was tried and what happened; empty when `ok`. */
    detail: string;
}

/** The passing result - nothing stands in the way of dialling. */
const REACHABLE: ReachResult = { ok: true, failure: null, detail: "" };

/** Options for one `reachRemote` call. */
export interface ReachRemoteOptions extends ResolveAliasOptions {
    /** Milliseconds to wait for the TCP connect. Default 5000. */
    probeTimeoutMs?: number;
    /**
     * The already-resolved `host:port`, skipping this call's alias lookup.
     * A remote's endpoint is fixed configuration, so the daemon resolves it
     * ONCE and passes it here - without that, every scheduler tick spawned an
     * `ssh -G` per alias target, thirty seconds apart, forever.
     */
    endpoint?: RemoteEndpoint | null;
}

/** The `host:port` a remote is dialled at. */
export interface RemoteEndpoint {
    /** Hostname or address ssh will connect to. */
    host: string;
    /** TCP port ssh will connect to. */
    port: number;
}

/**
 * The `host:port` for a remote: taken straight from an explicit remote, or
 * read out of `ssh -G` for an alias. Null when an alias cannot be resolved -
 * the caller then has nothing to probe and must treat the remote as
 * reachable. Static per remote; resolve it once and cache it.
 */
export async function remoteEndpoint(
    remote: ResolvedRemote,
    options: ResolveAliasOptions,
): Promise<RemoteEndpoint | null> {
    if (remote.kind !== "alias") {
        return { host: remote.host, port: remote.port };
    }
    const resolved = await resolveAlias(remote, options);
    return resolved === null ? null : { host: resolved.hostname, port: Number(resolved.port) };
}

/**
 * Open a TCP connection to `host:port` and close it immediately, resolving to
 * the failing errno-ish code, "timeout", or null on success. Never rejects.
 */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        /** Resolve once and tear the socket down. */
        const finish = (outcome: string | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve(outcome);
        };
        const socket = createConnection({ host, port });
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(null));
        socket.once("timeout", () => finish("timeout"));
        socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
    });
}

/** DNS-layer failures, as node reports them from a connect. */
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME"]);

/**
 * Codes proving the host is UP and answering - the port is closed or the
 * peer hung up, but packets got there and back. The probe PASSES on these:
 * whatever is wrong is a real condition ssh must report, not a dead network.
 */
const HOST_IS_UP_CODES = new Set(["ECONNREFUSED", "ECONNRESET"]);

/**
 * Whether `remote` can be reached right now. Passes unless the machine is
 * provably cut off from it: no interface, no DNS answer, or no route/no reply
 * on the ssh port. An alias whose `ssh -G` resolution fails passes too - an
 * unknown destination is not evidence of an outage, and ssh will say what is
 * actually wrong far better than a guess here would.
 */
export async function reachRemote(remote: ResolvedRemote, options: ReachRemoteOptions): Promise<ReachResult> {
    if (!hasNetworkLink()) {
        return {
            ok: false,
            failure: "no-link",
            detail: "this machine has no network interface up (Wi-Fi off, cable out, or VPN down)",
        };
    }
    const endpoint = options.endpoint === undefined ? await remoteEndpoint(remote, options) : options.endpoint;
    if (endpoint === null) {
        return REACHABLE;
    }
    const { host, port } = endpoint;
    const where = `${sanitize(host)}:${port}`;
    const outcome = await tcpProbe(host, port, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    if (outcome === null || HOST_IS_UP_CODES.has(outcome)) {
        return REACHABLE;
    }
    if (DNS_CODES.has(outcome)) {
        return {
            ok: false,
            failure: "dns",
            detail: `${sanitize(host)} did not resolve (${outcome}) - DNS on this machine or its network, not the backup server`,
        };
    }
    return {
        ok: false,
        failure: "unreachable",
        detail: `no answer from ${where} (${outcome}) - the network path to the backup server is down, or the host is off`,
    };
}
