import { describe, expect, it } from "vitest";
import type { ResolvedRemote } from "../../shared/types.js";
import { sshArgs, sshDestination } from "../ssh.js";

/** A fully explicit remote fixture. */
const EXPLICIT: ResolvedRemote = {
    kind: "explicit",
    restrictedShell: false,
    name: "example",
    host: "10.0.0.11",
    user: "backup-reader",
    port: 2222,
    identityFile: "/etc/backupkit/keys/example_ed25519",
    passphrase: null,
    knownHostsFile: "/etc/backupkit/known_hosts",
};

/** An alias remote fixture. */
const ALIAS: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "myserver", alias: "myserver" };

/** The option tokens alias mode must never carry. */
const FORBIDDEN_FOR_ALIAS = ["-i", "-p", "IdentitiesOnly", "PreferredAuthentications", "UserKnownHostsFile"];

describe("sshArgs", () => {
    it("explicit + unattended: exact full argv with StrictHostKeyChecking=yes", () => {
        expect(sshArgs(EXPLICIT, "unattended")).toEqual([
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=4",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "ForwardAgent=no",
            "-o", "ForwardX11=no",
            "-o", "ForwardX11Trusted=no",
            "-o", "UserKnownHostsFile=/etc/backupkit/known_hosts",
            "-o", "IdentitiesOnly=yes",
            "-o", "PreferredAuthentications=publickey",
            "-o", "LogLevel=ERROR",
            "-p", "2222",
            "-i", "/etc/backupkit/keys/example_ed25519",
        ]);
    });

    it("explicit + interactive: identical except StrictHostKeyChecking=accept-new", () => {
        const unattended = sshArgs(EXPLICIT, "unattended");
        const interactive = sshArgs(EXPLICIT, "interactive");
        expect(interactive).toEqual(
            unattended.map((token) => (token === "StrictHostKeyChecking=yes" ? "StrictHostKeyChecking=accept-new" : token)),
        );
    });

    it("alias + unattended: exactly the baseline plus contextual strictness and LogLevel", () => {
        expect(sshArgs(ALIAS, "unattended")).toEqual([
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=4",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "ForwardAgent=no",
            "-o", "ForwardX11=no",
            "-o", "ForwardX11Trusted=no",
            "-o", "LogLevel=ERROR",
        ]);
    });

    it("alias + interactive: same shape with StrictHostKeyChecking=accept-new", () => {
        expect(sshArgs(ALIAS, "interactive")).toEqual([
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=4",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ForwardAgent=no",
            "-o", "ForwardX11=no",
            "-o", "ForwardX11Trusted=no",
            "-o", "LogLevel=ERROR",
        ]);
    });

    // A `Host * / ForwardAgent yes` in the user's ssh_config would otherwise
    // forward backupkit's agent (holding the archive key, no lifetime, no
    // confirmation) into every host backupkit dials - including a compromised
    // pull source. Both remote kinds, and the rsync `-e` path that reuses these
    // tokens, must pin it off.
    it.each(["ForwardAgent=no", "ForwardX11=no", "ForwardX11Trusted=no"])(
        "%s is pinned for every remote kind and context",
        (option) => {
            for (const remote of [EXPLICIT, ALIAS]) {
                for (const context of ["unattended", "interactive"] as const) {
                    expect(sshArgs(remote, context)).toContain(option);
                }
            }
        },
    );

    it.each(["ForwardAgent=yes", "ForwardX11=yes", "ForwardX11Trusted=yes"])(
        "%s is emitted in no combination",
        (option) => {
            for (const remote of [EXPLICIT, ALIAS]) {
                for (const context of ["unattended", "interactive"] as const) {
                    expect(sshArgs(remote, context)).not.toContain(option);
                }
            }
        },
    );

    it.each(FORBIDDEN_FOR_ALIAS)("alias mode never carries %s (asserted as absence)", (forbidden) => {
        for (const context of ["unattended", "interactive"] as const) {
            expect(sshArgs(ALIAS, context).some((token) => token.includes(forbidden))).toBe(false);
        }
    });

    it("StrictHostKeyChecking=no is emitted in no combination", () => {
        for (const remote of [EXPLICIT, ALIAS]) {
            for (const context of ["unattended", "interactive"] as const) {
                expect(sshArgs(remote, context)).not.toContain("StrictHostKeyChecking=no");
            }
        }
    });

    it("every emitted token is whitespace- and quote-free for these fixtures", () => {
        for (const token of [...sshArgs(EXPLICIT, "unattended"), ...sshArgs(ALIAS, "interactive")]) {
            expect(token).not.toMatch(/[\s'"]/);
        }
    });
});

describe("sshDestination", () => {
    it("explicit remotes are user@host (port travels in the tokens, not here)", () => {
        expect(sshDestination(EXPLICIT)).toBe("backup-reader@10.0.0.11");
    });

    it("alias remotes are the bare alias", () => {
        expect(sshDestination(ALIAS)).toBe("myserver");
    });
});
