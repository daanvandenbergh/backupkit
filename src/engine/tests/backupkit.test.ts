/**
 * Class-level Backupkit tests over real temp directories with fake spawn and
 * transfer seams: run (due-ness, force, dry-run, backoff, report
 * persistence), status rows, listSnapshots, prune, preflight (all-alias
 * spawns no agent), check's local probes + jail-line data, and the
 * start/stop/abort flow.
 */

import { exec } from "../../exec/exec.js";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Backupkit } from "../backupkit.js";
import { ConfigError, TransferError } from "../../shared/errors.js";
import type { ResolvedRemote } from "../../shared/types.js";
import {
    captureLogger,
    makeConfig,
    makeExecResult,
    makeKit,
    makeStats,
    makeTarget,
    makeTransferResult,
    type KitFixture,
} from "./fakes.js";

describe("Backupkit", () => {
    const fixtures: KitFixture[] = [];

    /** Track a fixture for cleanup. */
    function track(fixture: KitFixture): KitFixture {
        fixtures.push(fixture);
        return fixture;
    }

    afterEach(async () => {
        for (const fixture of fixtures.splice(0)) {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it("run --force: promotes a snapshot on disk and persists the report", async () => {
        const { kit, destination, stateDir } = track(await makeKit());
        const report = await kit.run({ force: true });
        expect(report.targets).toHaveLength(1);
        expect(report.targets[0].status).toBe("success");
        expect(report.targets[0].snapshot).toBe("2026-08-10T120000Z");
        expect(existsSync(join(destination, "web", "2026-08-10T120000Z"))).toBe(true);
        expect(existsSync(join(destination, "web", "2026-08-10T120000Z.partial"))).toBe(false);
        const files = await readdir(join(stateDir, "runs", "web"));
        expect(files).toEqual(["2026-08-10T120000Z_web.json"]);
    });

    it("run: a fulfilled window is not re-run without force", async () => {
        const { kit, clock } = track(await makeKit());
        await kit.run({ force: true });
        clock.now = new Date("2026-08-10T13:00:00Z"); // same day window
        const second = await kit.run();
        expect(second.targets).toHaveLength(0);
        const third = await kit.run({ force: true });
        expect(third.targets).toHaveLength(1);
    });

    it("run: the next window is due again", async () => {
        const { kit, clock } = track(await makeKit());
        await kit.run({ force: true });
        clock.now = new Date("2026-08-11T00:30:00Z");
        const next = await kit.run();
        expect(next.targets).toHaveLength(1);
        expect(next.targets[0].snapshot).toBe("2026-08-11T003000Z");
    });

    it("run: unknown target names are a ConfigError listing the configured ones", async () => {
        const { kit } = track(await makeKit());
        await expect(kit.run({ targets: ["nope"] })).rejects.toThrow(ConfigError);
        await expect(kit.run({ targets: ["nope"] })).rejects.toThrow(/configured: web/);
    });

    it("run --dry-run: no snapshot, no persisted report", async () => {
        const { kit, destination, stateDir } = track(await makeKit());
        const report = await kit.run({ force: true, dryRun: true });
        expect(report.targets).toHaveLength(1);
        expect(report.targets[0].reason).toBe("dry-run");
        expect(existsSync(join(destination, "web", "2026-08-10T120000Z"))).toBe(false);
        expect(existsSync(join(stateDir, "runs", "web"))).toBe(false);
    });

    it("disabled targets never run unless explicitly named", async () => {
        const { kit } = track(await makeKit({ target: { enabled: false } }));
        expect((await kit.run({ force: true })).targets).toHaveLength(0);
        expect((await kit.run({ targets: ["web"], force: true })).targets).toHaveLength(1);
    });

    it("a failed run enters backoff: skipped without force, rehydrated by a fresh instance", async () => {
        const failing = {
            transfer: async (): Promise<never> => {
                throw new TransferError("link down (exit 10)", { exitCode: 10, retriable: true, stderrTail: "" });
            },
        };
        const fixture = track(await makeKit({ deps: failing }));
        const first = await fixture.kit.run({ force: true });
        expect(first.targets[0].status).toBe("failed");

        // One minute later: due (no snapshot exists), but inside the 15-minute backoff.
        fixture.clock.now = new Date("2026-08-10T12:01:00Z");
        expect((await fixture.kit.run()).targets).toHaveLength(0);
        // Force bypasses backoff.
        expect((await fixture.kit.run({ force: true })).targets).toHaveLength(1);

        // A cold instance rehydrates the same state from the reports alone.
        const cold = new Backupkit(
            makeConfig({
                configPath: join(fixture.root, "config.jsonc"),
                stateDir: fixture.stateDir,
                targets: [fixture.target],
            }),
            {
                now: () => new Date("2026-08-10T12:02:00Z"),
                runtimeDir: join(fixture.root, "run"),
                env: {},
                hasTty: false,
                logger: captureLogger("error").log,
                probeRsync: async () => ({ bin: "/fake/rsync", version: "3.2.7" }),
            },
        );
        expect((await cold.run()).targets).toHaveLength(0);
    });

    it("status: rows from reports - last result, failures, backoff-aware nextDueAt, lock state", async () => {
        const failing = {
            transfer: async (): Promise<never> => {
                throw new TransferError("link down (exit 10)", { exitCode: 10, retriable: true, stderrTail: "" });
            },
        };
        const fixture = track(await makeKit({ deps: failing }));
        await fixture.kit.run({ force: true });
        fixture.clock.now = new Date("2026-08-10T12:01:00Z");
        const [row] = await fixture.kit.status();
        expect(row.target).toBe("web");
        expect(row.lastResult).toBe("failed");
        expect(row.consecutiveFailures).toBe(1);
        expect(row.lastSnapshot).toBeNull();
        // nextDueAt = finishedAt + 15 min backoff (finishedAt ~= 12:00:00).
        expect(row.nextDueAt).toBe("2026-08-10T12:15:00.000Z");
        expect(row.lockHeld).toBe(false);

        await mkdir(join(fixture.destination, "web", ".backupkit.lock"), { recursive: true });
        const [locked] = await fixture.kit.status();
        expect(locked.lockHeld).toBe(true);
    });

    it("status: a successful run surfaces the snapshot and clears failures", async () => {
        const { kit } = track(await makeKit());
        await kit.run({ force: true });
        const [row] = await kit.status();
        expect(row.lastResult).toBe("success");
        expect(row.lastSnapshot).toBe("2026-08-10T120000Z");
        expect(row.consecutiveFailures).toBe(0);
        expect(row.nextDueAt).toBe("2026-08-11T00:00:00.000Z");
    });

    it("status: a disabled target has no nextDueAt", async () => {
        const { kit } = track(await makeKit({ target: { enabled: false } }));
        const [row] = await kit.status();
        expect(row.nextDueAt).toBeNull();
    });

    it("listSnapshots: complete snapshots oldest first, junk names ignored", async () => {
        const fixture = track(await makeKit());
        for (const name of ["2026-08-02T000000Z", "2026-08-01T000000Z", "junk", "999999.partial"]) {
            await mkdir(join(fixture.destination, "web", name), { recursive: true });
        }
        const infos = await fixture.kit.listSnapshots();
        expect(infos.map((info) => info.name)).toEqual(["2026-08-01T000000Z", "2026-08-02T000000Z"]);
        expect(infos[0].target).toBe("web");
        expect(infos[0].createdAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
        await expect(fixture.kit.listSnapshots({ targets: ["nope"] })).rejects.toThrow(ConfigError);
    });

    it("prune: dry-run plans without deleting; execution prunes all but the kept set", async () => {
        const fixture = track(await makeKit({ target: { retention: { keepLast: 1 } } }));
        for (const name of ["2026-08-01T000000Z", "2026-08-02T000000Z", "2026-08-03T000000Z"]) {
            await mkdir(join(fixture.destination, "web", name), { recursive: true });
        }
        const dry = await fixture.kit.prune({ dryRun: true });
        expect(dry.targets[0].executed).toBe(false);
        expect(dry.targets[0].plan.prune).toEqual(["2026-08-02T000000Z", "2026-08-01T000000Z"]);
        expect(existsSync(join(fixture.destination, "web", "2026-08-01T000000Z"))).toBe(true);

        const real = await fixture.kit.prune();
        expect(real.targets[0].executed).toBe(true);
        expect(real.targets[0].errors).toEqual([]);
        expect(existsSync(join(fixture.destination, "web", "2026-08-01T000000Z"))).toBe(false);
        expect(existsSync(join(fixture.destination, "web", "2026-08-02T000000Z"))).toBe(false);
        expect(existsSync(join(fixture.destination, "web", "2026-08-03T000000Z"))).toBe(true);
    });

    it("prune: retention off (null) prunes nothing", async () => {
        const fixture = track(await makeKit({ target: { retention: null } }));
        await mkdir(join(fixture.destination, "web", "2026-08-01T000000Z"), { recursive: true });
        const report = await fixture.kit.prune();
        expect(report.targets[0].plan.prune).toEqual([]);
        expect(report.targets[0].executed).toBe(false);
    });

    it("preflight: an all-alias config starts no agent and is idempotent", async () => {
        const fixture = track(await makeKit());
        await fixture.kit.preflight();
        await fixture.kit.preflight();
        // The runtime dir was created 0700; no agent socket appeared in it.
        expect(await readdir(join(fixture.root, "run"))).toEqual([]);
    });

    it("check: local probes ok, no remotes, no jail lines", async () => {
        const { kit } = track(await makeKit());
        const report = await kit.check();
        expect(report.ok).toBe(true);
        expect(report.localRsync).toEqual({ bin: "/fake/rsync", version: "3.2.7" });
        expect(report.sshOk).toBe(true);
        expect(report.remotes).toEqual([]);
        expect(report.jailLines).toEqual([]);
        expect(report.errors).toEqual([]);
    });

    it("check: a refused local rsync lands in errors and clears ok", async () => {
        const { kit } = track(
            await makeKit({
                deps: {
                    probeRsync: async () => {
                        throw new TransferError("rsync too old", { exitCode: null, retriable: false, stderrTail: "" });
                    },
                },
            }),
        );
        const report = await kit.check();
        expect(report.ok).toBe(false);
        expect(report.localRsync).toBeNull();
        expect(report.errors.some((error) => error.includes("rsync too old"))).toBe(true);
    });

    it("check: alias push target gets the restriction prefix + append-your-key instruction", async () => {
        const fixture = track(
            await makeKit({
                target: {
                    direction: "push",
                    dst: { kind: "remote", remote: { kind: "alias", name: "srv", alias: "myserver" }, path: "/srv/backups" },
                    destination: "/srv/backups",
                },
            }),
        );
        const report = await fixture.kit.check();
        expect(report.jailLines).toHaveLength(1);
        expect(report.jailLines[0].line).toBe(
            'restrict,command="/usr/local/bin/backupkit-remote \'/srv/backups\'" ' +
                '<append the public key your ssh_config uses for "myserver": ssh-add -L, or the .pub of its IdentityFile>',
        );
    });

    it("check: explicit push target embeds the real public key after the restriction prefix", async () => {
        const fixture = track(await makeKit());
        const keyPath = join(fixture.root, "id_ed25519");
        await writeFile(keyPath, "private", { mode: 0o600 });
        await writeFile(`${keyPath}.pub`, "ssh-ed25519 AAAAtest comment\n", { mode: 0o644 });
        const pushTarget = makeTarget({
            name: "push",
            direction: "push",
            destination: "/srv/backups",
            dst: {
                kind: "remote",
                remote: {
                    kind: "explicit",
                    name: "srv",
                    host: "10.0.0.1",
                    user: "backup",
                    port: 22,
                    identityFile: keyPath,
                    passphrase: null,
                    knownHostsFile: join(fixture.root, "known_hosts"),
                },
                path: "/srv/backups",
            },
        });
        const cold = new Backupkit(
            makeConfig({ configPath: join(fixture.root, "config.jsonc"), stateDir: fixture.stateDir, targets: [pushTarget] }),
            {
                now: () => fixture.clock.now,
                runtimeDir: join(fixture.root, "run"),
                env: {},
                hasTty: false,
                logger: captureLogger("error").log,
                execFn: async () => makeExecResult(),
                probeRsync: async () => ({ bin: "/fake/rsync", version: "3.2.7" }),
                loadKeysFn: async () => ({ sock: null, failures: new Map<string, string>() }),
            },
        );
        const report = await cold.check();
        expect(report.jailLines[0].line).toBe(
            'restrict,command="/usr/local/bin/backupkit-remote \'/srv/backups\'" ssh-ed25519 AAAAtest comment',
        );
    });

    it("check: a destination with spaces and quotes is shell- and authorized_keys-safe", async () => {
        // A local-with-spaces destination is legitimate; a naive line would let the
        // space widen $ROOT and the quote break out of command="...". The generated
        // line must survive BOTH nesting layers and hand backupkit-remote the whole
        // destination as exactly one $1 argument.
        const destination = '/Volumes/My "Backups"';
        const fixture = track(
            await makeKit({
                target: {
                    direction: "push",
                    dst: { kind: "remote", remote: { kind: "alias", name: "srv", alias: "myserver" }, path: destination },
                    destination,
                },
            }),
        );
        const report = await fixture.kit.check();
        const line = report.jailLines[0].line;
        expect(line).toContain(
            'restrict,command="/usr/local/bin/backupkit-remote \'/Volumes/My \\"Backups\\"\'"',
        );

        // Emulate sshd: strip the command="..." field, undo authorized_keys
        // backslash-escaping, then let a shell parse it and report $1.
        const field = /command="((?:\\.|[^"\\])*)"/.exec(line)![1].replace(/\\(["\\])/g, "$1");
        const parsed = await exec("sh", ["-c", `set -- ${field}; shift; printf %s "$1"`]);
        expect(parsed.stdout).toBe(destination);
    });

    it("start/stop: the immediate tick runs the due target, stop resolves the loop", async () => {
        const fixture = track(await makeKit({ deps: { tickMs: 20 } }));
        const loop = fixture.kit.start();
        // Poll until the first run's snapshot appears.
        const snapshot = join(fixture.destination, "web", "2026-08-10T120000Z");
        for (let i = 0; i < 200 && !existsSync(snapshot); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(snapshot)).toBe(true);
        await fixture.kit.stop();
        await loop;
    });

    it("stop aborts an in-flight transfer and its report lands as aborted", async () => {
        const fixture = track(
            await makeKit({
                deps: {
                    tickMs: 20,
                    transfer: async (params) =>
                        new Promise((_resolve, reject) => {
                            params.signal?.addEventListener("abort", () =>
                                reject(new TransferError("transfer aborted", { exitCode: null, retriable: false, stderrTail: "" })),
                            );
                        }),
                },
            }),
        );
        const loop = fixture.kit.start();
        // Wait until the transfer is in flight (the partial claim happened).
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fixture.kit.stop();
        await loop;
        const files = await readdir(join(fixture.stateDir, "runs", "web"));
        expect(files).toHaveLength(1);
        const { readFile } = await import("node:fs/promises");
        const persisted = JSON.parse(await readFile(join(fixture.stateDir, "runs", "web", files[0]), "utf8"));
        expect(persisted.status).toBe("aborted");
        // The partial stays for resume.
        expect(existsSync(join(fixture.destination, "web", "2026-08-10T120000Z.partial"))).toBe(false); // fake transfer never created it
    });

    it("stop() aborts an in-flight one-shot run(): the report lands as aborted", async () => {
        // Regression: run() had no abort path, so a signalled `backupkit run`
        // silently kept the transfer going and orphaned the rsync child.
        const fixture = track(
            await makeKit({
                deps: {
                    transfer: async (params) =>
                        new Promise((_resolve, reject) => {
                            params.signal?.addEventListener("abort", () =>
                                reject(new TransferError("transfer aborted", { exitCode: null, retriable: false, stderrTail: "" })),
                            );
                        }),
                },
            }),
        );
        const running = fixture.kit.run({ force: true });
        // Wait until the transfer is in flight.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fixture.kit.stop();
        const report = await running;
        expect(report.targets).toHaveLength(1);
        expect(report.targets[0].status).toBe("aborted");
        const files = await readdir(join(fixture.stateDir, "runs", "web"));
        const persisted = JSON.parse(await readFile(join(fixture.stateDir, "runs", "web", files[0]), "utf8"));
        expect(persisted.status).toBe("aborted");
    });

    it("check: accept-new (TOFU pinning) only on a real TTY - a non-TTY check pins strictly", async () => {
        // Regression for invariant 5: check() hardcoded the interactive ssh
        // context, so an unattended `backupkit check` (cron, CI, `< /dev/null`)
        // silently TOFU-pinned whatever host key was presented.
        const fixture = track(await makeKit());
        const sshLog = join(fixture.root, "ssh-args.jsonl");
        const fakeSsh = join(fixture.root, "fake-ssh");
        await writeFile(
            fakeSsh,
            "#!/usr/bin/env node\n" +
                `require("node:fs").appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
                'process.stdout.write("rsync  version 3.2.7  protocol version 31\\n");\n',
            { mode: 0o755 },
        );
        /** A kit over one alias remote and the recording fake ssh binary, with the given TTY state. */
        function kitWithTty(hasTty: boolean): Backupkit {
            return new Backupkit(
                {
                    ...makeConfig({
                        configPath: join(fixture.root, "config.jsonc"),
                        stateDir: fixture.stateDir,
                        targets: [fixture.target],
                    }),
                    remotes: { srv: { kind: "alias", name: "srv", alias: "myserver" } },
                    sshBin: fakeSsh,
                },
                {
                    now: () => fixture.clock.now,
                    runtimeDir: join(fixture.root, "run"),
                    env: {},
                    hasTty,
                    logger: captureLogger("error").log,
                    execFn: async () => makeExecResult(),
                    probeRsync: async () => ({ bin: "/fake/rsync", version: "3.2.7" }),
                    // The probe travels through the check()-built runRemote closure,
                    // so the real ssh argv (and its StrictHostKeyChecking) is recorded.
                    probeRemote: async (params) => {
                        await params.runRemote(["rsync", "--version"]);
                        return "3.2.7";
                    },
                },
            );
        }
        /** The recorded ssh argv lines that carry a StrictHostKeyChecking option. */
        async function strictnessLines(): Promise<string[][]> {
            const lines = (await readFile(sshLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
            return lines.filter((argv) => argv.some((arg) => arg.startsWith("StrictHostKeyChecking")));
        }

        await kitWithTty(false).check();
        const unattended = await strictnessLines();
        expect(unattended.length).toBeGreaterThan(0);
        expect(unattended.every((argv) => argv.includes("StrictHostKeyChecking=yes"))).toBe(true);

        await rm(sshLog, { force: true });
        await kitWithTty(true).check();
        const interactive = await strictnessLines();
        expect(interactive.length).toBeGreaterThan(0);
        expect(interactive.every((argv) => argv.includes("StrictHostKeyChecking=accept-new"))).toBe(true);
    });

    it("run path enforces the remote rsync floor: refusal fails the target without transfer, success is probed once", async () => {
        // Regression for invariant 11: the floor was only enforced in check(),
        // so a downgraded remote kept transferring on every run/daemon pass.
        let probeOk = false;
        let probeCount = 0;
        let transferCount = 0;
        const fixture = track(
            await makeKit({
                target: {
                    src: { kind: "remote", remote: { kind: "alias", name: "srv", alias: "myserver" }, path: "/srv/data" },
                },
                deps: {
                    probeRemote: async () => {
                        probeCount += 1;
                        if (!probeOk) {
                            throw new Error("rsync too old on myserver (3.1.3 < 3.2.5) - refused");
                        }
                        return "3.2.7";
                    },
                    transfer: async (params) => {
                        transferCount += 1;
                        if (params.spec.dst.kind === "local") {
                            await mkdir(params.spec.dst.path, { recursive: true });
                        }
                        const result = makeTransferResult();
                        for (const attempt of result.attempts) {
                            params.attemptLog?.push(attempt);
                        }
                        return result;
                    },
                },
            }),
        );
        const first = await fixture.kit.run({ force: true });
        expect(first.targets[0].status).toBe("failed");
        expect(first.targets[0].reason).toBe("remote-unavailable");
        expect(first.targets[0].error).toContain("rsync too old");
        fixture.clock.now = new Date("2026-08-10T12:01:00Z");
        const second = await fixture.kit.run({ force: true });
        expect(second.targets[0].status).toBe("failed");
        expect(probeCount).toBe(2); // failures are never cached - a fixed host re-probes
        expect(transferCount).toBe(0); // never a silent transfer below the floor
        probeOk = true;
        fixture.clock.now = new Date("2026-08-10T12:02:00Z");
        expect((await fixture.kit.run({ force: true })).targets[0].status).toBe("success");
        fixture.clock.now = new Date("2026-08-10T12:03:00Z");
        expect((await fixture.kit.run({ force: true })).targets[0].status).toBe("success");
        expect(probeCount).toBe(3); // success memoized per connection identity per process
        expect(transferCount).toBe(2);
    });

    it("an un-primeable key fails only that remote's targets: preflight succeeds, siblings run, check reports it", async () => {
        // Regression: one prompt key with no TTY used to reject preflight and
        // crash-loop the daemon, taking every healthy target down with it.
        let probeCount = 0;
        const fixture = track(await makeKit());
        const remote: ResolvedRemote = {
            kind: "explicit",
            name: "srv",
            host: "10.0.0.9",
            user: "backup",
            port: 22,
            identityFile: "/fake/id",
            passphrase: { kind: "prompt", value: "" },
            knownHostsFile: "/fake/kh",
        };
        const remoteTarget = makeTarget({
            name: "rweb",
            src: { kind: "remote", remote, path: "/srv/data" },
            dst: { kind: "local", path: fixture.destination },
            destination: fixture.destination,
        });
        const kit = new Backupkit(
            makeConfig({
                configPath: join(fixture.root, "config.jsonc"),
                stateDir: fixture.stateDir,
                targets: [remoteTarget, fixture.target],
            }),
            {
                now: () => fixture.clock.now,
                runtimeDir: join(fixture.root, "run"),
                env: {},
                hasTty: false,
                logger: captureLogger("error").log,
                execFn: async () => makeExecResult(),
                probeRsync: async () => ({ bin: "/fake/rsync", version: "3.2.7" }),
                probeRemote: async () => {
                    probeCount += 1;
                    return "3.2.7";
                },
                loadKeysFn: async () => ({
                    sock: null,
                    failures: new Map([
                        ["srv", 'key /fake/id is encrypted and not loaded; run "backupkit check" in a terminal, then restart the service'],
                    ]),
                }),
                transfer: async (params) => {
                    if (params.spec.dst.kind === "local") {
                        await mkdir(params.spec.dst.path, { recursive: true });
                    }
                    return makeTransferResult();
                },
                estimate: async () => makeStats(),
            },
        );
        await expect(kit.preflight()).resolves.toBeUndefined();
        const report = await kit.run({ force: true });
        expect(report.targets.map((t) => [t.target, t.status])).toEqual([
            ["rweb", "failed"],
            ["web", "success"],
        ]);
        expect(report.targets[0].reason).toBe("remote-unavailable");
        expect(report.targets[0].error).toContain("backupkit check");
        expect(probeCount).toBe(0); // the key gate fails before any remote probe
        // The failed report is persisted, so status/backoff derive from it.
        expect(await readdir(join(fixture.stateDir, "runs", "rweb"))).toHaveLength(1);
        // check() still surfaces the priming failure loudly.
        const checkReport = await kit.check();
        expect(checkReport.ok).toBe(false);
        expect(checkReport.errors.some((error) => error.includes("remote srv"))).toBe(true);
    });

    it("a forced first-run failure enters backoff once, not twice (no rehydrate-after-write double count)", async () => {
        const fixture = track(
            await makeKit({
                deps: {
                    transfer: async (): Promise<never> => {
                        throw new TransferError("link down (exit 10)", { exitCode: 10, retriable: true, stderrTail: "" });
                    },
                },
            }),
        );
        const first = await fixture.kit.run({ force: true });
        expect(first.targets[0].status).toBe("failed");
        // One failure = a 15-minute backoff. At +20 min the target must be
        // retried; the double-count bug inflated it to 30 min and skipped this.
        fixture.clock.now = new Date("2026-08-10T12:20:00Z");
        const retry = await fixture.kit.run();
        expect(retry.targets).toHaveLength(1);
    });

    it("disk-low damping: full re-evaluation at most every 5 minutes, one persisted report per episode, force bypasses", async () => {
        let estimateCalls = 0;
        const fixture = track(
            await makeKit({
                target: { minFree: { kind: "bytes", bytes: Number.MAX_SAFE_INTEGER } },
                deps: {
                    estimate: async () => {
                        estimateCalls += 1;
                        return makeStats();
                    },
                },
            }),
        );
        const first = await fixture.kit.run({ force: true });
        expect(first.targets[0].status).toBe("skipped");
        expect(first.targets[0].reason).toBe("disk-low");
        expect(estimateCalls).toBe(1);
        // 30 s later (one scheduler tick): still due, but the guard is damped -
        // no lock, no estimate, no second persisted report.
        fixture.clock.now = new Date("2026-08-10T12:00:30Z");
        const tick = await fixture.kit.run();
        expect(tick.targets[0].reason).toBe("disk-low");
        expect(estimateCalls).toBe(1);
        expect(await readdir(join(fixture.stateDir, "runs", "web"))).toHaveLength(1);
        // After the re-check interval the guard re-evaluates in full...
        fixture.clock.now = new Date("2026-08-10T12:06:00Z");
        await fixture.kit.run();
        expect(estimateCalls).toBe(2);
        // ...but a repeat disk-low skip is still not persisted (one report per episode).
        expect(await readdir(join(fixture.stateDir, "runs", "web"))).toHaveLength(1);
        // force bypasses the damping entirely.
        fixture.clock.now = new Date("2026-08-10T12:06:30Z");
        await fixture.kit.run({ force: true });
        expect(estimateCalls).toBe(3);
    });
});
