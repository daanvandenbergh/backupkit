/**
 * Class-level Backupkit tests over real temp directories with fake spawn and
 * transfer seams: run (due-ness, force, dry-run, backoff, report
 * persistence), status rows, listSnapshots, prune, preflight (all-alias
 * spawns no agent), check's local probes + jail-line data, and the
 * start/stop/abort flow.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Backupkit } from "../backupkit.js";
import { ConfigError, TransferError } from "../../shared/errors.js";
import { captureLogger, makeConfig, makeExecResult, makeKit, makeStats, makeTarget, type KitFixture } from "./fakes.js";

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
            'restrict,command="/usr/local/bin/backupkit-remote /srv/backups" ' +
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
                loadKeysFn: async () => null,
            },
        );
        const report = await cold.check();
        expect(report.jailLines[0].line).toBe(
            'restrict,command="/usr/local/bin/backupkit-remote /srv/backups" ssh-ed25519 AAAAtest comment',
        );
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
});
