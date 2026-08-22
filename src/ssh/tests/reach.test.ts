/**
 * Reachability probe tests: a real listening socket, a real closed port, and
 * an unresolvable name - the three outcomes that decide whether a due target
 * is dialled at all. No mocking of node:net; the whole point of the probe is
 * that it touches the network.
 */

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { reachRemote } from "../reach.js";
import type { ResolvedRemote } from "../../shared/types.js";

/** An explicit remote pointing at loopback on `port`. */
function remoteAt(port: number): ResolvedRemote {
    return {
        kind: "explicit",
        name: "archive",
        user: "backup",
        host: "127.0.0.1",
        port,
        identityFile: "/dev/null",
        passphrase: null,
        knownHostsFile: "/dev/null",
        restrictedShell: false,
    };
}

/** Listen on an ephemeral loopback port and resolve its number. */
function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
    });
}

describe("reachRemote", () => {
    let server: Server | null = null;

    afterEach(() => {
        server?.close();
        server = null;
    });

    it("passes when the ssh port accepts a connection", async () => {
        server = createServer();
        const port = await listen(server);
        const result = await reachRemote(remoteAt(port), { sshBin: "/usr/bin/ssh" });
        expect(result).toEqual({ ok: true, failure: null, detail: "" });
    });

    // Load-bearing: a host that ANSWERS - even with a refusal - is up, so the
    // probe must not swallow the run. sshd being down, a firewall rejecting the
    // port, a wrong port in config: every one of those is a real condition the
    // user has to see, and only ssh's own error says which.
    it("passes when the host answers but REFUSES the port - that is not a network outage", async () => {
        server = createServer();
        const port = await listen(server);
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = null;
        const result = await reachRemote(remoteAt(port), { sshBin: "/usr/bin/ssh" });
        expect(result.ok).toBe(true);
    });

    it("fails with the dns cause when the hostname does not resolve", async () => {
        const remote = { ...remoteAt(22), host: "no-such-host.invalid" } as ResolvedRemote;
        const result = await reachRemote(remote, { sshBin: "/usr/bin/ssh" });
        expect(result.ok).toBe(false);
        expect(result.failure).toBe("dns");
        expect(result.detail).toContain("no-such-host.invalid");
        // Names WHOSE side is broken - the line exists so nobody goes and
        // reboots a backup server whose network was never the problem.
        expect(result.detail).toContain("not the backup server");
    });

    it("fails with the unreachable cause when nothing answers before the timeout", async () => {
        // TEST-NET-1 (RFC 5737): documentation space, guaranteed to be routed
        // nowhere, so the connect can only time out or be told there is no route.
        const remote = { ...remoteAt(22), host: "192.0.2.1" } as ResolvedRemote;
        const result = await reachRemote(remote, { sshBin: "/usr/bin/ssh", probeTimeoutMs: 300 });
        expect(result.ok).toBe(false);
        expect(result.failure).toBe("unreachable");
        expect(result.detail).toContain("192.0.2.1:22");
    });

    // Regression: the endpoint is fixed configuration, but the probe resolved
    // it on every call - so every 30 s tick spawned an `ssh -G` per alias
    // target, forever. A supplied endpoint must be used verbatim: here the
    // sshBin cannot run at all, so a fallback to `ssh -G` would resolve to
    // nothing and PASS, and only the real probe can produce this verdict.
    it("uses a supplied endpoint verbatim instead of resolving the alias again", async () => {
        const alias: ResolvedRemote = { kind: "alias", name: "box", alias: "box", restrictedShell: false };
        const result = await reachRemote(alias, {
            sshBin: "/nonexistent/ssh",
            endpoint: { host: "192.0.2.1", port: 22 },
            probeTimeoutMs: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.failure).toBe("unreachable");
    });

    // An alias whose `ssh -G` resolution fails leaves no host to probe. That is
    // not evidence of an outage, so the run proceeds and ssh reports the truth.
    it("passes an alias it cannot resolve rather than guessing an outage", async () => {
        const alias: ResolvedRemote = {
            kind: "alias",
            name: "box",
            alias: "box",
            restrictedShell: false,
        };
        const result = await reachRemote(alias, { sshBin: "/nonexistent/ssh" });
        expect(result.ok).toBe(true);
    });
});
