import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../../shared/logger.js";
import type { ResolvedRemote } from "../../shared/types.js";
import { agentSocketPath, ensureAgent, loadKeys, type AgentDeps } from "../agent.js";
import { askpassScriptPath } from "../internal/askpass.js";
import { FakeBinDir, type FakeCallBehavior } from "./fake-bin.js";

/** Silent logger for the suites. */
const log = new Logger({ level: "debug", stdout: { write() {} }, stderr: { write() {} } });

/** An explicit remote over the given key/passphrase fixture paths. */
function explicitRemote(identityFile: string, passphrase: { kind: "file" | "prompt"; value: string } | null): ResolvedRemote {
    return {
        kind: "explicit",
        name: "example",
        host: "10.0.0.11",
        user: "backup",
        port: 22,
        identityFile,
        passphrase,
        knownHostsFile: "/tmp/unused_known_hosts",
    };
}

describe("ssh agent lifecycle (fake binaries)", () => {
    let fake: FakeBinDir;
    let runtimeDir: string;
    let keyPath: string;
    let pubPath: string;

    beforeEach(async () => {
        fake = await FakeBinDir.create();
        runtimeDir = join(fake.dir, "run");
        await mkdir(runtimeDir, { mode: 0o700 });
        keyPath = join(fake.dir, "id_ed25519");
        pubPath = `${keyPath}.pub`;
        await writeFile(keyPath, "FAKE PRIVATE KEY\n", { mode: 0o600 });
        await fake.install("ssh-add");
        await fake.install("ssh-agent");
        await fake.install("ssh-keygen");
    });

    afterEach(async () => {
        await fake.dispose();
    });

    /** AgentDeps over the fake-bin dir with the given behaviors. */
    function deps(behaviors: Record<string, FakeCallBehavior[]>, extra?: Partial<AgentDeps>): AgentDeps {
        return { runtimeDir, log, env: fake.env(behaviors), hasTty: false, timeoutMs: 5000, ...extra };
    }

    it("adopts a live agent: ssh-add -l answers, ssh-agent is never spawned", async () => {
        const sock = await ensureAgent(deps({ "ssh-add": [{ exit: 0 }] }));
        expect(sock).toBe(agentSocketPath(runtimeDir));
        const calls = await fake.calls();
        expect(calls.map((c) => [c.bin, ...c.argv])).toEqual([["ssh-add", "-l"]]);
        expect(calls[0].env.SSH_AUTH_SOCK).toBe(sock);
    });

    it("exit 1 (agent alive, no identities) also adopts", async () => {
        await ensureAgent(deps({ "ssh-add": [{ exit: 1 }] }));
        expect((await fake.calls()).map((c) => c.bin)).toEqual(["ssh-add"]);
    });

    it("spawns ssh-agent -a <sock> when the probe cannot connect, removing the stale socket", async () => {
        const sock = agentSocketPath(runtimeDir);
        await writeFile(sock, "stale");
        await ensureAgent(deps({ "ssh-add": [{ exit: 2 }], "ssh-agent": [{ exit: 0 }] }));
        const calls = await fake.calls();
        expect(calls.map((c) => [c.bin, ...c.argv])).toEqual([
            ["ssh-add", "-l"],
            ["ssh-agent", "-a", sock],
        ]);
        await expect(stat(sock)).rejects.toThrow();
    });

    it("surfaces an ssh-agent spawn failure with its stderr", async () => {
        await expect(
            ensureAgent(deps({ "ssh-add": [{ exit: 2 }], "ssh-agent": [{ exit: 1, stderr: "bind: boom" }] })),
        ).rejects.toThrowError(/ssh-agent .*boom/);
    });

    it("hang prevention: a sleeping ssh-add times out instead of hanging", async () => {
        const started = Date.now();
        await expect(
            ensureAgent(deps({ "ssh-add": [{ sleepMs: 30_000 }] }, { timeoutMs: 250 })),
        ).rejects.toThrowError(/did not answer within 250ms/);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("an all-alias remote list starts no agent and spawns nothing", async () => {
        const aliases: ResolvedRemote[] = [
            { kind: "alias", name: "a", alias: "a" },
            { kind: "alias", name: "b", alias: "b" },
        ];
        const result = await loadKeys(aliases, deps({}));
        expect(result.sock).toBeNull();
        expect(result.failures.size).toBe(0);
        expect(await fake.calls()).toEqual([]);
    });

    it("primes an unencrypted key: probe, fingerprint, ssh-add argv order; passphrase never in argv", async () => {
        await writeFile(pubPath, "ssh-ed25519 AAAA c\n", { mode: 0o644 });
        const { sock, failures } = await loadKeys([explicitRemote(keyPath, null)], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }, { exit: 0 }],
            "ssh-keygen": [
                { exit: 0, stdout: "256 SHA256:AAAA c (ED25519)\n" },
                { exit: 0, stdout: "ssh-ed25519 AAAA c\n" },
            ],
        }));
        expect(sock).toBe(agentSocketPath(runtimeDir));
        expect(failures.size).toBe(0);
        const calls = await fake.calls();
        expect(calls.map((c) => [c.bin, ...c.argv])).toEqual([
            ["ssh-add", "-l"],
            ["ssh-add", "-l"],
            ["ssh-keygen", "-lf", pubPath],
            ["ssh-keygen", "-y", "-P", "", "-f", keyPath],
            ["ssh-add", keyPath],
        ]);
        const add = calls[4];
        expect(add.env.SSH_AUTH_SOCK).toBe(sock);
        expect(add.env.SSH_ASKPASS).toBeUndefined();
        expect(add.env.BACKUPKIT_PASSPHRASE_FILE).toBeUndefined();
    });

    it("fingerprint skip: an already-loaded key is never re-added", async () => {
        await writeFile(pubPath, "ssh-ed25519 AAAA c\n", { mode: 0o644 });
        const listing = "256 SHA256:AAAA c (ED25519)\n";
        await loadKeys([explicitRemote(keyPath, null)], deps({
            "ssh-add": [{ exit: 0 }, { exit: 0, stdout: listing }],
            "ssh-keygen": [{ exit: 0, stdout: listing }],
        }));
        const calls = await fake.calls();
        expect(calls.map((c) => [c.bin, ...c.argv])).toEqual([
            ["ssh-add", "-l"],
            ["ssh-add", "-l"],
            ["ssh-keygen", "-lf", pubPath],
        ]);
    });

    it("file: passphrase keys get exactly the askpass env - the passphrase file path, never a passphrase", async () => {
        await writeFile(pubPath, "ssh-ed25519 BBBB c\n", { mode: 0o644 });
        const passFile = join(fake.dir, "key.pass");
        await loadKeys([explicitRemote(keyPath, { kind: "file", value: passFile })], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }, { exit: 0 }],
            "ssh-keygen": [{ exit: 0, stdout: "256 SHA256:BBBB c (ED25519)\n" }],
        }));
        const calls = await fake.calls();
        const add = calls.at(-1);
        expect(add?.bin).toBe("ssh-add");
        expect(add?.argv).toEqual([keyPath]);
        expect(add?.env.SSH_ASKPASS).toBe(askpassScriptPath());
        expect(add?.env.SSH_ASKPASS_REQUIRE).toBe("force");
        expect(add?.env.BACKUPKIT_PASSPHRASE_FILE).toBe(passFile);
        expect(add?.env.SSH_AUTH_SOCK).toBe(agentSocketPath(runtimeDir));
        // The askpass helper itself is the shipped POSIX script.
        expect(await readFile(askpassScriptPath(), "utf8")).toContain('cat "$BACKUPKIT_PASSPHRASE_FILE"');
    });

    it("prompt keys without a TTY fail fast with the actionable message and never spawn an add", async () => {
        await writeFile(pubPath, "ssh-ed25519 CCCC c\n", { mode: 0o644 });
        const { failures } = await loadKeys([explicitRemote(keyPath, { kind: "prompt", value: "" })], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }],
            "ssh-keygen": [{ exit: 0, stdout: "256 SHA256:CCCC c (ED25519)\n" }],
        }));
        expect(failures.get("example")).toMatch(
            /is encrypted and not loaded; run "backupkit check" in a terminal, then restart the service/,
        );
        const addCalls = (await fake.calls()).filter((c) => c.bin === "ssh-add");
        expect(addCalls.map((c) => c.argv)).toEqual([["-l"], ["-l"]]);
    });

    it("per-remote fault isolation: an un-primeable prompt key fails only its remote, the other key still primes", async () => {
        // Remote "example" uses an encrypted prompt key with no TTY; remote
        // "other" uses a distinct unencrypted key. loadKeys must resolve with a
        // failure for "example" only and still add "other"'s key - the seam that
        // keeps a daemon restart from crash-looping on one bad key (spec 4/5).
        await writeFile(pubPath, "ssh-ed25519 FFFF c\n", { mode: 0o644 });
        const otherKey = join(fake.dir, "id_other");
        await writeFile(otherKey, "FAKE OTHER KEY\n", { mode: 0o600 });
        await writeFile(`${otherKey}.pub`, "ssh-ed25519 GGGG c\n", { mode: 0o644 });
        const prompt = explicitRemote(keyPath, { kind: "prompt", value: "" });
        const other = { ...explicitRemote(otherKey, null), name: "other" } as ResolvedRemote;
        const { sock, failures } = await loadKeys([prompt, other], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }, { exit: 0 }],
            "ssh-keygen": [
                { exit: 0, stdout: "256 SHA256:FFFF c (ED25519)\n" },
                { exit: 0, stdout: "256 SHA256:GGGG c (ED25519)\n" },
                { exit: 0, stdout: "ssh-ed25519 GGGG c\n" },
            ],
        }));
        expect(sock).toBe(agentSocketPath(runtimeDir));
        expect([...failures.keys()]).toEqual(["example"]);
        expect(failures.get("example")).toMatch(/run "backupkit check" in a terminal/);
        // The other remote's key was still added despite the earlier failure.
        const addCalls = (await fake.calls()).filter((c) => c.bin === "ssh-add" && c.argv[0] !== "-l");
        expect(addCalls.map((c) => c.argv)).toEqual([[otherKey]]);
    });

    it("both remotes sharing one un-primeable key are marked failed", async () => {
        const first = explicitRemote(keyPath, { kind: "prompt", value: "" });
        const second = { ...first, name: "other" } as ResolvedRemote;
        await writeFile(pubPath, "ssh-ed25519 HHHH c\n", { mode: 0o644 });
        const { failures } = await loadKeys([first, second], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }],
            "ssh-keygen": [{ exit: 0, stdout: "256 SHA256:HHHH c (ED25519)\n" }],
        }));
        expect([...failures.keys()].sort()).toEqual(["example", "other"]);
    });

    it("generates a missing .pub for an unencrypted key (0644) and reuses the probe for the add", async () => {
        const pub = "ssh-ed25519 DDDD c\n";
        await loadKeys([explicitRemote(keyPath, null)], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }, { exit: 0 }],
            "ssh-keygen": [
                { exit: 0, stdout: pub },
                { exit: 0, stdout: "256 SHA256:DDDD c (ED25519)\n" },
            ],
        }));
        const calls = await fake.calls();
        expect(calls.filter((c) => c.bin === "ssh-keygen").map((c) => c.argv)).toEqual([
            ["-y", "-P", "", "-f", keyPath],
            ["-lf", pubPath],
        ]);
        expect(await readFile(pubPath, "utf8")).toBe(pub);
        expect(((await stat(pubPath)).mode & 0o777)).toBe(0o644);
    });

    it("encrypted key with a missing .pub fails unattended, pointing at backupkit check", async () => {
        const { failures } = await loadKeys([explicitRemote(keyPath, { kind: "file", value: join(fake.dir, "p") })], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }],
        }));
        expect(failures.get("example")).toMatch(/backupkit check/);
        expect((await fake.calls()).filter((c) => c.bin === "ssh-keygen")).toEqual([]);
    });

    it("a key that needs a passphrase but configures none is an actionable per-remote failure", async () => {
        const { failures } = await loadKeys([explicitRemote(keyPath, null)], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }],
            "ssh-keygen": [{ exit: 1, stderr: "incorrect passphrase supplied" }],
        }));
        expect(failures.get("example")).toMatch(/configure "passphrase"/);
    });

    it("dedupes remotes sharing one identityFile: the key is primed once", async () => {
        await writeFile(pubPath, "ssh-ed25519 EEEE c\n", { mode: 0o644 });
        const first = explicitRemote(keyPath, null);
        const second = { ...first, name: "other" } as ResolvedRemote;
        await loadKeys([first, second], deps({
            "ssh-add": [{ exit: 0 }, { exit: 1 }, { exit: 0 }],
            "ssh-keygen": [
                { exit: 0, stdout: "256 SHA256:EEEE c (ED25519)\n" },
                { exit: 0, stdout: "ssh-ed25519 EEEE c\n" },
            ],
        }));
        const addCalls = (await fake.calls()).filter((c) => c.bin === "ssh-add" && c.argv[0] !== "-l");
        expect(addCalls).toHaveLength(1);
    });
});
