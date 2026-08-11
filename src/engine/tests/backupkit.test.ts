/**
 * Class-level Backupkit tests over real temp directories with fake spawn and
 * transfer seams: run (due-ness, force, dry-run, backoff, report
 * persistence), status rows, listSnapshots, prune, preflight (all-alias
 * spawns no agent), check's local probes + jail-line data, and the
 * start/stop/abort flow.
 */

import { exec } from "../../exec/exec.js";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Backupkit, defaultRuntimeDir } from "../backupkit.js";
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

describe("defaultRuntimeDir", () => {
    it("uses /run/backupkit for root on linux (systemd RuntimeDirectory owns it)", () => {
        expect(defaultRuntimeDir({}, 0, "/root", "linux")).toBe("/run/backupkit");
    });

    it("uses /var/run/backupkit for root on macOS, where /run does not exist", () => {
        expect(defaultRuntimeDir({}, 0, "/var/root", "darwin")).toBe("/var/run/backupkit");
    });

    it("prefers XDG_RUNTIME_DIR for a non-root user, platform-independent", () => {
        expect(defaultRuntimeDir({ XDG_RUNTIME_DIR: "/run/user/501" }, 501, "/home/u", "linux")).toBe(
            "/run/user/501/backupkit",
        );
        expect(defaultRuntimeDir({ XDG_RUNTIME_DIR: "/run/user/501" }, 501, "/home/u", "darwin")).toBe(
            "/run/user/501/backupkit",
        );
    });

    it("falls back to ~/.backupkit/run for a non-root user without XDG_RUNTIME_DIR", () => {
        expect(defaultRuntimeDir({}, 501, "/Users/u", "darwin")).toBe("/Users/u/.backupkit/run");
    });
});

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

    // A future-dated complete snapshot - one jail-accepted `mkdir -p --` from a
    // compromised push source, or one clock-skew event - used to brick the target
    // for good: it sorted newest, so every run failed clock-skew, and the store
    // refused to delete its newest snapshot so prune could never clear it.
    // Recovery needed shell on the archive host. Now `backupkit prune` clears it.
    it("a future-dated snapshot fails the run, is pruned by prune, and the target then runs again", async () => {
        const fixture = track(await makeKit({ target: { retention: { keepLast: 2 } } }));
        await fixture.kit.run({ force: true });
        // A compromised push source plants a future-dated directory in its own
        // archive root (the jail accepts the mkdir by design).
        const planted = join(fixture.destination, "web", "2099-01-01T000000Z");
        await mkdir(planted, { recursive: true });
        // The clock-skew guard still fires - a name from the future is
        // indistinguishable from a backwards clock, and refusing is right.
        fixture.clock.now = new Date("2026-08-10T12:01:00Z");
        const blocked = await fixture.kit.run({ force: true });
        expect(blocked.targets[0].status).toBe("failed");
        expect(blocked.targets[0].reason).toBe("clock-skew");

        const pruned = await fixture.kit.prune();
        expect(pruned.targets[0].plan.prune).toEqual(["2099-01-01T000000Z"]);
        expect(existsSync(planted)).toBe(false);

        fixture.clock.now = new Date("2026-08-10T12:02:00Z");
        const healed = await fixture.kit.run({ force: true });
        expect(healed.targets[0].status).toBe("success");
    });

    it("a future-dated snapshot that is the ONLY snapshot is never pruned away", async () => {
        const fixture = track(await makeKit({ target: { retention: { keepLast: 1 } } }));
        const planted = join(fixture.destination, "web", "2099-01-01T000000Z");
        await mkdir(planted, { recursive: true });
        const report = await fixture.kit.prune();
        expect(report.targets[0].plan.prune).toEqual([]);
        expect(existsSync(planted)).toBe(true);
    });

    // Regression (the -e string had no program name): sshArgs returns ssh
    // OPTIONS only, so feeding it straight into rsync's -e made rsync try to
    // exec "-o" - "rsync: [sender] Failed to exec -o: No such file or
    // directory", exit 14 - and EVERY remote transfer, estimate and restore
    // failed. The engine is the seam that must supply the binary.
    it("the rsync -e command the engine builds starts with the ssh binary", async () => {
        const sshTokens: string[][] = [];
        const fixture = track(
            await makeKit({
                target: {
                    src: { kind: "remote", remote: { kind: "alias", name: "srv", alias: "myserver" }, path: "/srv/data" },
                },
                deps: {
                    probeRemote: async () => "3.2.7",
                    transfer: async (params) => {
                        sshTokens.push([...params.spec.sshTokens]);
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
        await fixture.kit.run({ force: true });
        expect(sshTokens).toHaveLength(1);
        expect(sshTokens[0][0]).toBe("ssh");
        expect(sshTokens[0].join(" ")).toMatch(/^ssh -o BatchMode=yes/);
        // And the argv the builder derives from it is a runnable -e command.
        const dashE = sshTokens[0].join(" ");
        expect(dashE.startsWith("-")).toBe(false);
    });

    // The `-e` value is a COMMAND STRING rsync word-splits before exec, so a
    // token carrying whitespace becomes EXTRA ssh arguments. validate.ts refuses
    // whitespace in every path that lands here, but the default knownHostsFile is
    // synthesized from configPath downstream of that gate - which is how
    // `--config "/tmp/a -o ProxyCommand=/tmp/evil/x/config.jsonc"` turned into
    // `-o ProxyCommand=...` and got executed by ssh as root. config.ts now
    // refuses such a config path; this is the boundary assertion that makes any
    // FUTURE path reintroducing whitespace fail loudly here instead of silently
    // becoming an ssh option.
    it("refuses to build an rsync -e command whose tokens carry whitespace or quotes", async () => {
        const fixture = track(
            await makeKit({
                deps: { probeRemote: async () => "3.2.7" },
            }),
        );
        const poisoned = new Backupkit(
            {
                ...makeConfig({
                    configPath: join(fixture.root, "config.jsonc"),
                    stateDir: fixture.stateDir,
                    targets: [
                        makeTarget({
                            destination: fixture.destination,
                            dst: { kind: "local", path: fixture.destination },
                            src: {
                                kind: "remote",
                                path: "/srv/data",
                                remote: {
                                    kind: "explicit",
                                    name: "srv",
                                    host: "10.0.0.1",
                                    user: "backup",
                                    port: 22,
                                    identityFile: join(fixture.root, "id_ed25519"),
                                    passphrase: null,
                                    // The shape the old default produced from a
                                    // config path containing a space.
                                    knownHostsFile: join(fixture.root, "my dir", "known_hosts"),
                                },
                            },
                        }),
                    ],
                }),
            },
            {
                now: () => fixture.clock.now,
                runtimeDir: join(fixture.root, "run"),
                env: {},
                hasTty: false,
                logger: captureLogger("error").log,
                execFn: async () => makeExecResult(),
                probeRsync: async () => ({ bin: "/fake/rsync", version: "3.2.7" }),
                probeRemote: async () => "3.2.7",
                loadKeysFn: async () => ({ sock: null, failures: new Map<string, string>() }),
                transfer: async () => {
                    throw new Error("the transfer must never start with a poisoned -e command");
                },
            },
        );
        await expect(poisoned.run({ force: true })).rejects.toThrowError(
            /rsync -e command.*whitespace or quote characters/s,
        );
    });

    // A lock nobody releases (a future-dated remote marker, an operator's
    // forgotten manual run) used to be invisible: LockHeldError escaped the
    // pipeline, the scheduler logged a warn and continued, and NO report was
    // written - so `status` kept reporting the last success with 0 failures
    // while the target had not run for weeks.
    it("a held destination lock still writes a report, so status stops reading green", async () => {
        const fixture = track(await makeKit());
        // Plant a live-looking lock: this process's pid and start time.
        const lockDir = join(fixture.destination, "web", ".backupkit.lock");
        await mkdir(lockDir, { recursive: true });
        const { pidStartTime } = await import("../../snapshots/internal/lock.js");
        await writeFile(
            join(lockDir, "meta"),
            JSON.stringify({
                pid: process.pid,
                pidStartTime: await pidStartTime(process.pid),
                hostname: hostname(),
                createdAt: fixture.clock.now.toISOString(),
            }),
        );
        await expect(fixture.kit.run({ force: true })).rejects.toThrow(/lock/i);
        const [row] = await fixture.kit.status();
        expect(row.lastResult).toBe("skipped");
        expect(row.lockHeld).toBe(true);
        const files = await readdir(join(fixture.stateDir, "runs", "web"));
        expect(files).toHaveLength(1);
        const persisted = JSON.parse(await readFile(join(fixture.stateDir, "runs", "web", files[0]), "utf8"));
        expect(persisted.reason).toBe("lock-held");
    });

    // ...and a lock on ONE target must not take the rest of the pass down with
    // it. LockHeldError unwound the whole invocation, so every later target
    // never ran, got no report, and produced no log line naming it - `status`
    // then showed them with their last successful snapshot, `success`, 0
    // failures. The scheduler has had this containment all along (it catches
    // lock-held per target and continues); the one-shot path had not. The
    // invocation still ends non-zero (exit 3) so a cron wrapper alarms.
    it("a lock held on one target does not stop the later targets of a one-shot run", async () => {
        const fixture = track(
            await makeKit({
                extraTargets: (destination) => [
                    makeTarget({ name: "api", destination, dst: { kind: "local", path: destination } }),
                ],
            }),
        );
        // A live-looking lock on the FIRST target only: this process's pid and start time.
        const lockDir = join(fixture.destination, "web", ".backupkit.lock");
        await mkdir(lockDir, { recursive: true });
        const { pidStartTime } = await import("../../snapshots/internal/lock.js");
        await writeFile(
            join(lockDir, "meta"),
            JSON.stringify({
                pid: process.pid,
                pidStartTime: await pidStartTime(process.pid),
                hostname: hostname(),
                createdAt: fixture.clock.now.toISOString(),
            }),
        );

        await expect(fixture.kit.run({ force: true })).rejects.toThrow(/lock/i);

        // The second target ran, promoted its snapshot, and left a report.
        expect(existsSync(join(fixture.destination, "api", "2026-08-10T120000Z"))).toBe(true);
        expect(await readdir(join(fixture.stateDir, "runs", "api"))).toHaveLength(1);
        const [web, api] = await fixture.kit.status();
        expect([web.target, web.lastResult]).toEqual(["web", "skipped"]);
        expect([api.target, api.lastResult]).toEqual(["api", "success"]);
    });

    it("prune: retention off (null) prunes nothing", async () => {
        const fixture = track(await makeKit({ target: { retention: null } }));
        await mkdir(join(fixture.destination, "web", "2026-08-01T000000Z"), { recursive: true });
        const report = await fixture.kit.prune();
        expect(report.targets[0].plan.prune).toEqual([]);
        expect(report.targets[0].executed).toBe(false);
    });

    // Invariant 8 says the permission gate runs before ANY network I/O, but it
    // lived on run/start/restore/check only - listSnapshots and prune, the two
    // verbs an operator reaches for to confirm the archive is healthy, opened ssh
    // (and in prune's case issued `rm -rf`) with whatever key mode was on disk.
    // A sibling-path gap, so this is a table over EVERY engine verb that does
    // remote I/O: add a verb, add a row.
    it.each([
        ["listSnapshots", (kit: Backupkit) => kit.listSnapshots()],
        ["prune", (kit: Backupkit) => kit.prune()],
        ["prune --dry-run", (kit: Backupkit) => kit.prune({ dryRun: true })],
        ["run", (kit: Backupkit) => kit.run({ force: true })],
        ["restore", (kit: Backupkit) => kit.restore({ target: "web", snapshot: "latest", output: "/nonexistent/out" })],
    ])("%s fails closed on a group-writable config, before any store access", async (_name, call) => {
        const fixture = track(await makeKit());
        await chmod(join(fixture.root, "config.jsonc"), 0o666);
        await expect(call(fixture.kit)).rejects.toThrowError(/config file .* is group\/other-writable/);
        // Nothing was spawned: the gate is genuinely upstream of the store, not a
        // check that happens to run after the first ssh.
        expect(fixture.execCalls).toEqual([]);
    });

    // `check` was the last verb that spawned config-named binaries BEFORE the
    // trust gate: `localRsync()` runs `config.rsyncBin --version` and the ssh
    // probe runs `config.sshBin -V`, both above `await this.preflight()`. With a
    // group/other-writable config - the exact state the gate exists to refuse -
    // a local user set "rsyncBin": "/tmp/evil" and the next `backupkit check`
    // (the command `init` tells the operator to run) executed it as root. And
    // once the gate had failed, check went on to open ssh to every remote with
    // the very key and known_hosts it had just condemned, TOFU-pinning host keys
    // into an untrusted store on a TTY.
    it("check: a group-writable config reports the gate failure and spawns/probes NOTHING", async () => {
        const probed: string[] = [];
        const fixture = track(await makeKit());
        const kit = new Backupkit(
            {
                ...makeConfig({
                    configPath: join(fixture.root, "config.jsonc"),
                    stateDir: fixture.stateDir,
                    targets: [fixture.target],
                }),
                remotes: { srv: { kind: "alias", name: "srv", alias: "myserver" } },
            },
            {
                now: () => fixture.clock.now,
                runtimeDir: join(fixture.root, "run"),
                env: {},
                hasTty: true,
                logger: captureLogger("error").log,
                execFn: async (bin, args) => {
                    probed.push(`${bin} ${args.join(" ")}`);
                    return makeExecResult();
                },
                probeRsync: async (bin) => {
                    probed.push(`${bin ?? "rsync"} --version`);
                    return { bin: "/fake/rsync", version: "3.2.7" };
                },
                probeRemote: async () => {
                    probed.push("remote probe");
                    return "3.2.7";
                },
            },
        );
        await chmod(join(fixture.root, "config.jsonc"), 0o666);
        const report = await kit.check();
        expect(report.ok).toBe(false);
        expect(report.errors.some((error) => /config file .* is group\/other-writable/.test(error))).toBe(true);
        // No config-named binary was spawned, and no ssh left the host.
        expect(probed).toEqual([]);
        expect(report.remotes).toEqual([]);
        expect(report.localRsync).toBeNull();
        expect(report.sshOk).toBe(false);
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

    it("check: a jail-disabled push target produces no jail line (and no .pub read error)", async () => {
        const fixture = track(
            await makeKit({
                target: {
                    direction: "push",
                    jail: false,
                    dst: { kind: "remote", remote: { kind: "alias", name: "srv", alias: "myserver" }, path: "/srv/backups" },
                    destination: "/srv/backups",
                },
            }),
        );
        const report = await fixture.kit.check();
        expect(report.jailLines).toEqual([]);
        expect(report.ok).toBe(true);
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

    // rsync.remoteRsyncBin is per TARGET, so two targets can share one remote
    // while pointing --rsync-path at different binaries. Memoizing the probe on
    // the connection identity alone let the first target's result stand in for
    // the second's, and the second's binary - the one its transfer actually
    // uses - was never checked against the floor (invariant 11).
    it("probes each remoteRsyncBin on a shared remote: an old binary is refused even after a modern sibling passed", async () => {
        const remote: ResolvedRemote = { kind: "alias", name: "srv", alias: "myserver" };
        const probed: (string | null)[] = [];
        const fixture = track(
            await makeKit({
                target: { name: "modern", src: { kind: "remote", remote, path: "/srv/data" } },
                // A sibling target on the SAME remote, pinned to an old binary.
                // Its gate fails before the pipeline, so its archive stays empty.
                extraTargets: (destination) => [
                    makeTarget({
                        name: "legacy",
                        destination,
                        src: { kind: "remote", remote, path: "/srv/data" },
                        dst: { kind: "local", path: destination },
                        rsync: { ...makeTarget().rsync, remoteRsyncBin: "/opt/legacy/bin/rsync" },
                    }),
                ],
                deps: {
                    probeRemote: async (params) => {
                        probed.push(params.remoteRsyncBin);
                        if (params.remoteRsyncBin === "/opt/legacy/bin/rsync") {
                            throw new Error("rsync 3.1.3 on myserver is below the required floor 3.2.5");
                        }
                        return "3.2.7";
                    },
                },
            }),
        );

        const report = await fixture.kit.run({ force: true });
        expect(report.targets.map((row) => [row.target, row.status])).toEqual([
            ["modern", "success"],
            ["legacy", "failed"],
        ]);
        expect(report.targets[1].reason).toBe("remote-unavailable");
        expect(report.targets[1].error).toContain("below the required floor 3.2.5");
        // Both binaries were probed - the shared host did not mask the second.
        expect(probed).toEqual([null, "/opt/legacy/bin/rsync"]);
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

    // The daemon wires SIGTERM/SIGINT to stop() BEFORE preflight, and both
    // preflight and backoff rehydration do real I/O. A stop landing in that
    // window used to be a no-op: the process ignored the signal and then went
    // on to start backing up, so systemd waited out TimeoutStopSec and killed it.
    it("a stop that lands before the scheduler exists prevents the loop from starting", async () => {
        const fixture = track(await makeKit({ deps: { tickMs: 20 } }));
        await fixture.kit.stop();
        await fixture.kit.start();
        // No tick ran: nothing was backed up, and the loop resolved immediately.
        expect(existsSync(join(fixture.destination, "web", "2026-08-10T120000Z"))).toBe(false);
        expect(existsSync(join(fixture.stateDir, "runs", "web"))).toBe(false);

        // A later start is unaffected - the request applies to that one stop.
        const started = fixture.kit.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await fixture.kit.stop();
        await started;
        expect(existsSync(join(fixture.destination, "web", "2026-08-10T120000Z"))).toBe(true);
    });

    /**
     * A kit whose `logging.file` sink is the REAL one (no logger override), over
     * a temp tree whose config file, state dir and destination root all pass the
     * permission preflight - so a test can drive the trust gate on purpose.
     */
    async function logSinkKit(params: { root: string; logFile: string }): Promise<Backupkit> {
        const configPath = join(params.root, "config.jsonc");
        await writeFile(configPath, "{}\n", { mode: 0o600 });
        const destination = join(params.root, "archive");
        await mkdir(destination, { recursive: true, mode: 0o700 });
        const config = makeConfig({
            configPath,
            stateDir: join(params.root, "state"),
            targets: [makeTarget({ destination, dst: { kind: "local", path: destination } })],
        });
        config.logging = { level: "info", file: params.logFile };
        config.warnings = ["a config warning, logged from the constructor"];
        return new Backupkit(config, {
            now: () => new Date("2026-08-10T12:00:00Z"),
            runtimeDir: join(params.root, "run"),
            env: {},
            hasTty: false,
        });
    }

    // The constructor used to wire the sink and then immediately emit
    // config.warnings, so the FIRST thing any verb did as root was
    // openSync(logging.file, O_CREAT, 0600) + a write - before the config-file
    // permission row and before checkLoggingFile. With a group/other-writable
    // config an attacker set "logging": {"file": "/etc/ld.so.preload"} and a bare
    // `backupkit status` created a root-owned 0600 file at an arbitrary path, or
    // appended to an existing root-owned one (a line in /etc/sudoers.d/* makes
    // sudo refuse everything). Invariant 8: nothing privileged before the gate.
    it("logging.file is not opened until the permission gate has judged the path", async () => {
        const root = await mkdtemp(join(tmpdir(), "backupkit-logdefer-"));
        try {
            const victimDir = join(root, "victim");
            await mkdir(victimDir, { recursive: true, mode: 0o700 });
            const planted = join(victimDir, "planted.conf");
            const kit = await logSinkKit({ root, logFile: planted });
            // Construction logs the config warnings - and creates nothing.
            expect(existsSync(planted)).toBe(false);

            // A FAILED gate keeps it that way: the config the path came from is
            // precisely what is not trusted.
            await chmod(join(root, "config.jsonc"), 0o666);
            await expect(kit.preflight()).rejects.toThrowError(/config file .* is group\/other-writable/);
            expect(existsSync(planted)).toBe(false);

            // Once the gate passes, the buffered lines land - in a 0600 file.
            await chmod(join(root, "config.jsonc"), 0o600);
            await kit.preflight();
            expect((await stat(planted)).mode & 0o777).toBe(0o600);
            expect(await readFile(planted, "utf8")).toContain("a config warning, logged from the constructor");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    // The sink appends as the daemon's uid - root, under the shipped unit. A
    // local user who can plant a symlink at the log path would otherwise turn
    // every log line into a root-privileged append to a file of their choosing,
    // and the default 0666 & ~umask would leave config- and remote-derived text
    // world-readable. O_NOFOLLOW makes the open fail (ELOOP) instead - and that
    // failure must never escape the call site that logged (a log line thrown out
    // of the scheduler's own error handler would end the daemon), so it disables
    // file logging with one stderr notice.
    it("logging.file never follows a symlink, and a failed open disables file logging instead of throwing", async () => {
        const root = await mkdtemp(join(tmpdir(), "backupkit-logsymlink-"));
        try {
            const victim = join(root, "victim");
            await writeFile(victim, "untouched\n", { mode: 0o600 });
            const logPath = join(root, "backupkit.log");
            await symlink(victim, logPath);
            const kit = await logSinkKit({ root, logFile: logPath });

            const written: string[] = [];
            const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
                written.push(String(chunk));
                return true;
            });
            try {
                // The flush happens here, inside the preflight - and resolves.
                await expect(kit.preflight()).resolves.toBeUndefined();
            } finally {
                spy.mockRestore();
            }

            // The symlink target is byte-identical: nothing was written through it.
            expect(await readFile(victim, "utf8")).toBe("untouched\n");
            const notice = written.filter((line) => line.includes("logging.file"));
            expect(notice).toHaveLength(1);
            expect(notice[0]).toContain("is not writable");
            expect(notice[0]).toContain("file logging disabled for this process");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
