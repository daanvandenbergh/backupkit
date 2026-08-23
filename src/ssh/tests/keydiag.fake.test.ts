/**
 * `diagnoseAliasAuth` over fake ssh/ssh-keygen/ssh-add binaries: the cause
 * behind "authentication failed under BatchMode" for an alias remote.
 *
 * The load-bearing property under test is restraint - the diagnosis speaks ONLY
 * when it is certain (every ssh_config identity file is passphrase-protected
 * and the agent backupkit handed to ssh cannot unlock it) and returns null for
 * every inconclusive shape, because a confidently wrong cause is worse than the
 * generic message it replaces.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diagnoseAliasAuth } from "../internal/keydiag.js";
import { FakeBinDir, type FakeCallBehavior } from "./fake-bin.js";

/** A `ssh -G` stdout block naming the given identity files. */
function sshConfigOutput(...identityFiles: string[]): string {
    return [
        "user backup",
        "hostname archive.example.com",
        "port 22",
        ...identityFiles.map((path) => `identityfile ${path}`),
        "",
    ].join("\n");
}

/**
 * The `ssh-keygen -y -P "" -f <key>` behavior of a PASSPHRASE-PROTECTED key.
 * The stderr wording is load-bearing: ssh-keygen fails identically on a
 * corrupt key, and only its naming a passphrase makes the key encrypted.
 */
const LOCKED: FakeCallBehavior = {
    exit: 255,
    stderr: 'Load key "k": incorrect passphrase supplied to decrypt private key\n',
};

/** `ssh-add -l` stdout for the given fingerprints. */
function agentListing(...fingerprints: string[]): string {
    return `${fingerprints.map((print) => `256 ${print} key (ED25519)`).join("\n")}\n`;
}

describe("diagnoseAliasAuth (fake binaries)", () => {
    let fake: FakeBinDir;
    let sshBin: string;
    let home: string;
    let keyPath: string;

    beforeEach(async () => {
        fake = await FakeBinDir.create();
        sshBin = await fake.install("ssh");
        await fake.install("ssh-keygen");
        await fake.install("ssh-add");
        home = await mkdtemp(join(tmpdir(), "backupkit-keydiag-"));
        keyPath = join(home, "id_locked");
        await writeFile(keyPath, "not a real key - only its existence is probed\n");
    });

    afterEach(async () => {
        await fake.dispose();
        await rm(home, { recursive: true, force: true });
    });

    /**
     * Diagnosis options over the fakes. `keygen`/`add` are the per-call
     * behavior scripts; `authSock` is layered in exactly as runRemote layers
     * it, so "unset" is genuinely absent rather than empty.
     */
    function options(
        sshCalls: FakeCallBehavior[],
        keygen: FakeCallBehavior[] = [],
        add: FakeCallBehavior[] = [],
        authSock?: string,
    ): { sshBin: string; env: Record<string, string>; timeoutMs: number } {
        const env: Record<string, string> = {
            ...fake.env({ ssh: sshCalls, "ssh-keygen": keygen, "ssh-add": add }),
            HOME: home,
        };
        if (authSock !== undefined) {
            env.SSH_AUTH_SOCK = authSock;
        }
        return { sshBin, env, timeoutMs: 5000 };
    }

    /** The `ssh -G` behavior resolving the fixture key as the alias's only identity file. */
    function resolvesFixtureKey(): FakeCallBehavior[] {
        return [{ exit: 0, stdout: sshConfigOutput(keyPath) }];
    }

    it("encrypted key with NO agent: one sentence and the exact ssh-add that fixes it", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(resolvesFixtureKey(), [{ exit: 255, stderr: "load failed: incorrect passphrase" }]),
        );
        // The whole message, asserted literally: this is a terminal line, and
        // it stops being one the moment it grows a second sentence.
        expect(message).toBe(`the SSH key needs a passphrase and no ssh-agent is running. Fix: ssh-add ${keyPath}`);
    });

    it("encrypted key with an agent that does not answer: says so, never claims the key is missing", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(resolvesFixtureKey(), [LOCKED], [{ exit: 2, stderr: "Error connecting to agent" }], "/run/dead.sock"),
        );
        expect(message).toBe(`the SSH key needs a passphrase and the ssh-agent is not answering. Fix: ssh-add ${keyPath}`);
    });

    it("encrypted key with an EMPTY agent (ssh-add -l exit 1): the agent holds no keys at all", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(resolvesFixtureKey(), [LOCKED], [{ exit: 1, stderr: "The agent has no identities." }], "/run/a.sock"),
        );
        expect(message).toBe(`the SSH key needs a passphrase and the ssh-agent is empty. Fix: ssh-add ${keyPath}`);
    });

    it("encrypted key absent from a POPULATED agent: says it is not in the agent, not that the agent is empty", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(
                resolvesFixtureKey(),
                // [0] the -y -P "" encryption probe, [1] the -lf fingerprint read.
                [LOCKED, { exit: 0, stdout: "256 SHA256:MINE key (ED25519)\n" }],
                [{ exit: 0, stdout: agentListing("SHA256:OTHER1", "SHA256:OTHER2") }],
                "/run/a.sock",
            ),
        );
        expect(message).toBe(`the SSH key needs a passphrase and is not in the ssh-agent. Fix: ssh-add ${keyPath}`);
    });

    it("SILENT when the agent already holds the key - the failure is something else", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(
                resolvesFixtureKey(),
                [LOCKED, { exit: 0, stdout: "256 SHA256:MINE key (ED25519)\n" }],
                [{ exit: 0, stdout: agentListing("SHA256:MINE") }],
                "/run/a.sock",
            ),
        );
        expect(message).toBeNull();
    });

    it("SILENT for an UNENCRYPTED key - a passphrase is not what stopped this connection", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(resolvesFixtureKey(), [{ exit: 0, stdout: "ssh-ed25519 AAAA...\n" }]),
        );
        expect(message).toBeNull();
    });

    it("SILENT when one of several identity files is unencrypted", async () => {
        const other = join(home, "id_plain");
        await writeFile(other, "plain\n");
        const message = await diagnoseAliasAuth(
            "archive",
            options(
                [{ exit: 0, stdout: sshConfigOutput(keyPath, other) }],
                // The locked key probes first, then the plain one answers exit 0.
                [LOCKED, { exit: 0, stdout: "ssh-ed25519 AAAA...\n" }],
                [],
                "/run/a.sock",
            ),
        );
        expect(message).toBeNull();
    });

    it("SILENT when ssh -G cannot resolve the alias", async () => {
        const message = await diagnoseAliasAuth("archive", options([{ exit: 255, stderr: "Bad configuration option" }]));
        expect(message).toBeNull();
    });

    it("SILENT when the alias resolves only to identity files that do not exist", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options([{ exit: 0, stdout: sshConfigOutput(join(home, "nope"), join(home, "also-nope")) }]),
        );
        expect(message).toBeNull();
        // No key existed, so no encryption probe was worth spawning.
        expect((await fake.calls()).filter((call) => call.bin === "ssh-keygen")).toHaveLength(0);
    });

    it("SILENT when the key is UNREADABLE rather than locked - a corrupt key is not a passphrase", async () => {
        // ssh-keygen exits non-zero the same way for both; only its naming a
        // passphrase makes the key encrypted. Sending an operator to `ssh-add`
        // a truncated key is the confidently-wrong cause this guards against.
        const message = await diagnoseAliasAuth(
            "archive",
            options(resolvesFixtureKey(), [{ exit: 255, stderr: 'Load key "k": invalid format\n' }]),
        );
        expect(message).toBeNull();
    });

    it("SILENT when the encryption probe cannot be spawned at all", async () => {
        await rm(join(fake.dir, "ssh-keygen"));
        // A PATH without ssh-keygen at either end: whether the key is encrypted
        // is unknowable, so the diagnosis degrades rather than inventing.
        const opts = options(resolvesFixtureKey());
        opts.env.PATH = `${fake.dir}:${dirname(process.execPath)}`;
        expect(await diagnoseAliasAuth("archive", opts)).toBeNull();
    });

    it("SILENT when the fingerprint cannot be read but the agent holds keys - never guess against a populated agent", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options(
                resolvesFixtureKey(),
                [LOCKED, { exit: 1, stderr: "is not a public key file" }],
                [{ exit: 0, stdout: agentListing("SHA256:OTHER1") }],
                "/run/a.sock",
            ),
        );
        expect(message).toBeNull();
    });

    it("expands a ~ identity file against the CHILD env's HOME, not this process's", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options([{ exit: 0, stdout: sshConfigOutput("~/id_locked") }], [LOCKED]),
        );
        expect(message).toContain(keyPath);
    });

    it("ignores a non-absolute identity file ssh could not expand", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options([{ exit: 0, stdout: sshConfigOutput("id_relative") }], [LOCKED]),
        );
        expect(message).toBeNull();
    });

    it("an empty SSH_AUTH_SOCK counts as no agent, not as a dead one", async () => {
        const message = await diagnoseAliasAuth("archive", options(resolvesFixtureKey(), [LOCKED], [], ""));
        expect(message).toBe(`the SSH key needs a passphrase and no ssh-agent is running. Fix: ssh-add ${keyPath}`);
    });

    it("names every locked key once and offers a single ssh-add that loads them all", async () => {
        const second = join(home, "id_locked2");
        await writeFile(second, "also locked\n");
        const message = await diagnoseAliasAuth(
            "archive",
            options([{ exit: 0, stdout: sshConfigOutput(keyPath, second) }], [LOCKED]),
        );
        expect(message).toBe(`the SSH key needs a passphrase and no ssh-agent is running. Fix: ssh-add ${keyPath} ${second}`);
    });

    it("de-duplicates an identity file ssh -G printed twice", async () => {
        const message = await diagnoseAliasAuth(
            "archive",
            options([{ exit: 0, stdout: sshConfigOutput(keyPath, keyPath) }], [LOCKED]),
        );
        expect(message).toContain(`ssh-add ${keyPath}`);
        expect(message).not.toContain(`${keyPath} ${keyPath}`);
    });
});
