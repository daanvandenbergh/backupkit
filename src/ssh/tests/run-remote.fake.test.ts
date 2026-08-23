import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SshError, isBackupkitError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import type { RetryPolicy } from "../../shared/retry.js";
import type { ResolvedRemote } from "../../shared/types.js";
import { resolveAlias, runRemote, sshArgs, type RunRemoteOptions } from "../ssh.js";
import { FakeBinDir, type FakeCallBehavior } from "./fake-bin.js";

/** Silent logger for the suites. */
const log = new Logger({ level: "error", stdout: { write() {} }, stderr: { write() {} } });

/** Millisecond-scale retry policy so retry-wiring tests run fast. */
const FAST: RetryPolicy = { attempts: 3, baseDelayMs: 1, capMs: 2 };

/** The explicit remote fixture. */
const EXPLICIT: ResolvedRemote = {
    kind: "explicit",
    restrictedShell: false,
    name: "example",
    host: "10.0.0.11",
    user: "backup",
    port: 22,
    identityFile: "/keys/id_ed25519",
    passphrase: null,
    knownHostsFile: "/cfg/known_hosts",
};

/** The alias remote fixture. */
const ALIAS: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "myserver", alias: "myserver" };

describe("runRemote (fake ssh)", () => {
    let fake: FakeBinDir;
    let sshBin: string;

    beforeEach(async () => {
        fake = await FakeBinDir.create();
        sshBin = await fake.install("ssh");
    });

    afterEach(async () => {
        await fake.dispose();
    });

    /** RunRemoteOptions over the fake ssh with the given per-call behaviors. */
    function options(behaviors: FakeCallBehavior[], extra?: Partial<RunRemoteOptions>): RunRemoteOptions {
        return {
            sshBin,
            context: "unattended",
            log,
            authSock: null,
            env: fake.env({ ssh: behaviors }),
            timeoutMs: 5000,
            retryPolicy: FAST,
            ...extra,
        };
    }

    it("spawns exactly sshArgs + destination + the single-quoted command", async () => {
        const result = await runRemote(EXPLICIT, ["mkdir", "-p", "--", "/a b/c"], options([{ exit: 0, stdout: "ok" }]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("ok");
        const calls = await fake.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0].argv).toEqual([
            ...sshArgs(EXPLICIT, "unattended"),
            "backup@10.0.0.11",
            "'mkdir' '-p' '--' '/a b/c'",
        ]);
    });

    it("alias spawns show the bare alias as destination and no -i/-p anywhere", async () => {
        await runRemote(ALIAS, ["rsync", "--version"], options([{ exit: 0 }]));
        const argv = (await fake.calls())[0].argv;
        expect(argv.at(-2)).toBe("myserver");
        expect(argv.at(-1)).toBe("'rsync' '--version'");
        expect(argv).not.toContain("-i");
        expect(argv).not.toContain("-p");
        expect(argv.some((t) => t.includes("UserKnownHostsFile"))).toBe(false);
    });

    // A Hetzner Storage Box parses no quoting at all: it reads `'mkdir'` as a
    // command literally named `'mkdir'` and answers "Command not found" (exit
    // 8), so a quoted lifecycle command fails every run while rsync still
    // works. `restrictedShell` sends bare words instead - and refuses anything
    // that is not already one inert word, since no escaping would help there.
    describe("restrictedShell remotes", () => {
        const RESTRICTED: ResolvedRemote = { kind: "alias", restrictedShell: true, name: "box", alias: "box" };

        it("sends bare words, never single-quoted ones", async () => {
            await runRemote(RESTRICTED, ["mkdir", "-p", "--", "/home/backupkit"], options([{ exit: 0 }]));
            expect((await fake.calls())[0].argv.at(-1)).toBe("mkdir -p -- /home/backupkit");
        });

        it("refuses to send an element that is not one inert word - nothing is spawned", async () => {
            await expect(
                runRemote(RESTRICTED, ["mkdir", "-p", "--", "/home/my backups"], options([{ exit: 0 }])),
            ).rejects.toThrowError(/unquotable/);
            expect(await fake.calls()).toHaveLength(0);
        });

        it("still quotes for a remote that did not opt in", async () => {
            await runRemote(ALIAS, ["mkdir", "-p", "--", "/home/backupkit"], options([{ exit: 0 }]));
            expect((await fake.calls())[0].argv.at(-1)).toBe("'mkdir' '-p' '--' '/home/backupkit'");
        });
    });

    it("interactive context reaches the spawn as StrictHostKeyChecking=accept-new", async () => {
        await runRemote(ALIAS, ["true"], options([{ exit: 0 }], { context: "interactive" }));
        expect((await fake.calls())[0].argv).toContain("StrictHostKeyChecking=accept-new");
    });

    it("sets SSH_AUTH_SOCK from authSock and omits it when null", async () => {
        await runRemote(EXPLICIT, ["true"], options([{ exit: 0 }], { authSock: "/run/backupkit/agent.sock" }));
        await runRemote(EXPLICIT, ["true"], options([{ exit: 0 }], { authSock: null }));
        const calls = await fake.calls();
        expect(calls[0].env.SSH_AUTH_SOCK).toBe("/run/backupkit/agent.sock");
        expect(calls[1].env.SSH_AUTH_SOCK).toBeUndefined();
    });

    it("retries a transient 255 and succeeds on the next attempt", async () => {
        const result = await runRemote(
            EXPLICIT,
            ["df", "-Pk", "--", "/srv"],
            options([{ exit: 255, stderr: "Connection reset by peer" }, { exit: 0, stdout: "healed" }]),
        );
        expect(result.stdout).toBe("healed");
        expect(await fake.calls()).toHaveLength(2);
    });

    it("exhausts the retry budget on persistent transient failure", async () => {
        await expect(
            runRemote(EXPLICIT, ["true"], options([{ exit: 255, stderr: "kex: connection lost" }])),
        ).rejects.toSatisfy((error: unknown) => error instanceof SshError && error.retriable === true);
        expect(await fake.calls()).toHaveLength(3);
    });

    it("auth failure short-circuits: exactly one invocation, retriable false, actionable message", async () => {
        await expect(
            runRemote(EXPLICIT, ["true"], options([{ exit: 255, stderr: "backup@10.0.0.11: Permission denied (publickey)." }])),
        ).rejects.toThrowError(/backupkit check/);
        expect(await fake.calls()).toHaveLength(1);
    });

    it("alias auth failure names the alias and the no-key-management rule", async () => {
        await expect(
            runRemote(ALIAS, ["true"], options([{ exit: 255, stderr: "myserver: Permission denied (publickey,password)." }])),
        ).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof SshError &&
                error.retriable === false &&
                /ssh alias "myserver": authentication failed under BatchMode/.test(error.message) &&
                /does not manage keys for alias remotes/.test(error.message),
        );
        // One CONNECT attempt (auth failure is permanent - never retried), plus
        // the local `ssh -G myserver` the key diagnosis runs to look for a
        // passphrase-protected ssh_config key. The fake resolves no
        // identityfile, so the diagnosis finds no cause and the generic message
        // stands - which is the required behaviour: never guess.
        const calls = await fake.calls();
        expect(calls).toHaveLength(2);
        expect(calls[1].argv).toEqual(["-G", "myserver"]);
    });

    it("host key mismatch is permanent and never auto-healed", async () => {
        await expect(
            runRemote(EXPLICIT, ["true"], options([{ exit: 255, stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" }])),
        ).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof SshError && error.retriable === false && /never auto-removes/.test(error.message),
        );
        expect(await fake.calls()).toHaveLength(1);
    });

    it("unpinned host key is permanent, pointing at backupkit check", async () => {
        await expect(
            runRemote(EXPLICIT, ["true"], options([{ exit: 255, stderr: "Host key verification failed." }])),
        ).rejects.toThrowError(/pin the host key/);
        expect(await fake.calls()).toHaveLength(1);
    });

    it("a non-255 remote command failure resolves without any retry (lock-mkdir EEXIST semantics)", async () => {
        const result = await runRemote(
            EXPLICIT,
            ["mkdir", "--", "/srv/.backupkit.lock"],
            options([{ exit: 1, stderr: "mkdir: cannot create directory" }]),
        );
        expect(result.exitCode).toBe(1);
        expect(await fake.calls()).toHaveLength(1);
    });

    it("a hanging ssh is killed by the timeout, never a hang", async () => {
        const started = Date.now();
        await expect(
            runRemote(
                EXPLICIT,
                ["true"],
                options([{ sleepMs: 30_000 }], { timeoutMs: 250, retryPolicy: { attempts: 1, baseDelayMs: 1, capMs: 2 } }),
            ),
            // The message must name BOTH possibilities. A timeout cannot tell an
            // offline host from a dead local link, and the old "timed out after
            // 60000ms" wording read as a verdict on the host.
        ).rejects.toThrowError(/gave up after 250ms.*may be offline.*network\/route to it may be down/);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("a NUL/newline argv element is rejected by the quoter before anything spawns", async () => {
        await expect(runRemote(EXPLICIT, ["rm", "-rf", "--", "/srv/x\ny"], options([{ exit: 0 }]))).rejects.toSatisfy(
            (error: unknown) => isBackupkitError(error) && error.code === "ssh",
        );
        expect(await fake.calls()).toHaveLength(0);
    });
});

describe("resolveAlias (fake ssh -G)", () => {
    let fake: FakeBinDir;
    let sshBin: string;

    beforeEach(async () => {
        fake = await FakeBinDir.create();
        sshBin = await fake.install("ssh");
    });

    afterEach(async () => {
        await fake.dispose();
    });

    /** The alias fixture typed to the alias arm. */
    const alias = ALIAS as Extract<ResolvedRemote, { kind: "alias" }>;

    it("parses hostname/user/port from ssh -G output and records the -G argv", async () => {
        const stdout = "user daan\nhostname 10.0.0.5\nport 2222\nidentityfile ~/.ssh/id\n";
        const result = await resolveAlias(alias, { sshBin, env: fake.env({ ssh: [{ exit: 0, stdout }] }) });
        expect(result).toEqual({ hostname: "10.0.0.5", user: "daan", port: "2222" });
        expect((await fake.calls())[0].argv).toEqual(["-G", "myserver"]);
    });

    it("sanitizes control characters out of the resolved values", async () => {
        const stdout = "user da\x1ban\nhostname evil\x1b[2Jhost\nport 22\n";
        const result = await resolveAlias(alias, { sshBin, env: fake.env({ ssh: [{ exit: 0, stdout }] }) });
        expect(result).toEqual({ hostname: "evil[2Jhost", user: "daan", port: "22" });
    });

    it.each([
        ["garbage output", { exit: 0, stdout: "not ssh output at all" }],
        ["missing port line", { exit: 0, stdout: "user daan\nhostname h\n" }],
        ["non-numeric port", { exit: 0, stdout: "user daan\nhostname h\nport twenty\n" }],
        ["non-zero exit", { exit: 255, stderr: "unknown alias" }],
    ] as const)("degrades to null on %s", async (_label, behavior) => {
        const result = await resolveAlias(alias, { sshBin, env: fake.env({ ssh: [{ ...behavior }] }) });
        expect(result).toBeNull();
    });

    it("degrades to null when ssh cannot be spawned at all", async () => {
        const result = await resolveAlias(alias, { sshBin: "/nonexistent/backupkit-ssh", env: fake.env() });
        expect(result).toBeNull();
    });
});
