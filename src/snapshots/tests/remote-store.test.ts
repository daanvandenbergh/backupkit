import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecResult } from "../../exec/exec.js";
import { LockHeldError, SnapshotStoreError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import type { ResolvedRemote } from "../../shared/types.js";
import { FakeBinDir } from "../../ssh/tests/fake-bin.js";
import { LocalSnapshotStore } from "../internal/local-store.js";
import { RemoteSnapshotStore, type RemoteRunner } from "../internal/remote-store.js";
import { openStore } from "../store.js";

/** Silent logger for the suites. */
const log = new Logger({ level: "error", stdout: { write() {} }, stderr: { write() {} } });

/** The remote archive root every suite uses. */
const ROOT = "/srv/backups/web";

/** Three chronologically ordered snapshot names. */
const OLD = "2026-08-08T010000Z";
const MID = "2026-08-09T020000Z";
const NEW = "2026-08-10T031502Z";

/** A fixed clock for lock TTL tests. */
const NOW = new Date("2026-08-10T03:15:02Z");

/** Build a complete ExecResult from a partial override. */
function result(over: Partial<ExecResult> = {}): ExecResult {
    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...over };
}

/** NUL-joined find output for full paths under a directory. */
function findOutput(dir: string, names: string[]): string {
    return names.map((name) => `${dir}/${name}\0`).join("");
}

/** A recording fake runner: `handler` maps each argv to a result override (default success). */
function fakeRunner(handler: (argv: readonly string[], call: number) => Partial<ExecResult> | undefined = () => ({})) {
    const calls: string[][] = [];
    const runner: RemoteRunner = async (argv) => {
        const over = handler(argv, calls.length);
        calls.push([...argv]);
        return result(over);
    };
    return { runner, calls };
}

/** Handler answering `find` on the store root with the given entry names, everything else success. */
function rootListing(names: string[]) {
    return (argv: readonly string[]) =>
        argv[0] === "find" && argv[1] === ROOT ? { stdout: findOutput(ROOT, names) } : {};
}

describe("RemoteSnapshotStore", () => {
    describe("listComplete", () => {
        it("ensures the root once, then lists via find -print0 with exact argv", async () => {
            const { runner, calls } = fakeRunner(rootListing([NEW, OLD]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.listComplete()).resolves.toEqual([OLD, NEW]);
            expect(calls).toEqual([
                ["mkdir", "-p", "--", ROOT],
                ["find", ROOT, "-maxdepth", "1", "-mindepth", "1", "-print0"],
            ]);
            // Second call: the root mkdir is not repeated.
            await store.listComplete();
            expect(calls).toHaveLength(3);
            expect(calls[2][0]).toBe("find");
        });

        it("ignores partials, deleting entries, NUL-mangled and non-regex names", async () => {
            const { runner } = fakeRunner(
                rootListing([
                    MID,
                    `${NEW}.partial`,
                    `${OLD}.deleting`,
                    "legacy-1700000000",
                    "..",
                    "evil\n2026-01-01T000000Z",
                    "2026-13-40T996161Z",
                ]),
            );
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.listComplete()).resolves.toEqual([MID]);
        });

        it("retries the root mkdir on the next call after it failed", async () => {
            let mkdirCalls = 0;
            const { runner, calls } = fakeRunner((argv) => {
                if (argv[0] === "mkdir") {
                    mkdirCalls += 1;
                    return { exitCode: mkdirCalls === 1 ? 1 : 0, stderr: "mkdir: boom" };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.listComplete()).rejects.toBeInstanceOf(SnapshotStoreError);
            await expect(store.listComplete()).resolves.toEqual([]);
            expect(calls.filter((argv) => argv[0] === "mkdir")).toHaveLength(2);
        });

        it("wraps a failing find in SnapshotStoreError with a sanitized stderr tail", async () => {
            const { runner } = fakeRunner((argv) =>
                argv[0] === "find" ? { exitCode: 2, stderr: "boom\x1b[31mred\ntail" } : {},
            );
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            const error = await store.listComplete().then(
                () => null,
                (e: unknown) => e,
            );
            expect(error).toBeInstanceOf(SnapshotStoreError);
            // The ESC and newline control chars are stripped; printable text stays.
            expect((error as Error).message).toContain("redtail");
            expect((error as Error).message).not.toContain("\x1b");
            expect((error as Error).message).not.toContain("\n");
        });
    });

    describe("claimPartial", () => {
        it("sweeps .deleting entries, deletes extra partials, and mv-renames the newest partial", async () => {
            const { runner, calls } = fakeRunner(
                rootListing([`${OLD}.partial`, `${MID}.partial`, `${OLD}.deleting`, "legacy-keep", MID]),
            );
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: true });
            expect(calls).toEqual([
                ["mkdir", "-p", "--", ROOT],
                ["find", ROOT, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["rm", "-rf", "--", `${ROOT}/${OLD}.deleting`],
                ["rm", "-rf", "--", `${ROOT}/${OLD}.partial`],
                ["mv", "--", `${ROOT}/${MID}.partial`, `${ROOT}/${NEW}.partial`],
            ]);
            // The non-regex name never appeared in any destructive argv.
            expect(calls.flat().some((token) => token.includes("legacy-keep"))).toBe(false);
        });

        it("returns resumed:false and issues no rm/mv when no partial exists", async () => {
            const { runner, calls } = fakeRunner(rootListing([MID]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: false });
            expect(calls.filter((argv) => argv[0] === "rm" || argv[0] === "mv")).toEqual([]);
        });

        it("skips the mv when the partial already carries the new name", async () => {
            const { runner, calls } = fakeRunner(rootListing([`${NEW}.partial`]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: true });
            expect(calls.filter((argv) => argv[0] === "mv")).toEqual([]);
        });

        it("rejects an invalid new name before any remote command", async () => {
            const { runner, calls } = fakeRunner();
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.claimPartial("../evil")).rejects.toBeInstanceOf(SnapshotStoreError);
            expect(calls).toEqual([]);
        });
    });

    describe("promote", () => {
        it("issues exactly mv -- <partial> <final>", async () => {
            const { runner, calls } = fakeRunner(rootListing([`${NEW}.partial`, OLD]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await store.promote(NEW);
            expect(calls.at(-1)).toEqual(["mv", "--", `${ROOT}/${NEW}.partial`, `${ROOT}/${NEW}`]);
        });

        it("refuses when the complete name already exists (no mv issued)", async () => {
            const { runner, calls } = fakeRunner(rootListing([NEW, `${NEW}.partial`]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.promote(NEW)).rejects.toThrow(/already exists/);
            expect(calls.filter((argv) => argv[0] === "mv")).toEqual([]);
        });

        it("refuses when no partial exists (no mv issued)", async () => {
            const { runner, calls } = fakeRunner(rootListing([OLD]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.promote(NEW)).rejects.toThrow(/no partial snapshot/);
            expect(calls.filter((argv) => argv[0] === "mv")).toEqual([]);
        });
    });

    describe("remove", () => {
        it("two-phase: mv to .deleting then rm -rf, exact argv and order", async () => {
            const { runner, calls } = fakeRunner(rootListing([OLD, MID, NEW]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await store.remove(OLD);
            expect(calls.slice(-2)).toEqual([
                ["mv", "--", `${ROOT}/${OLD}`, `${ROOT}/${OLD}.deleting`],
                ["rm", "-rf", "--", `${ROOT}/${OLD}.deleting`],
            ]);
        });

        it("refuses the newest complete snapshot", async () => {
            const { runner, calls } = fakeRunner(rootListing([OLD, NEW]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.remove(NEW)).rejects.toThrow(/newest complete snapshot/);
            expect(calls.filter((argv) => argv[0] === "mv" || argv[0] === "rm")).toEqual([]);
        });

        it("refuses a name that is not a complete snapshot", async () => {
            const { runner } = fakeRunner(rootListing([NEW]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.remove(MID)).rejects.toThrow(/not a complete snapshot/);
        });

        it("refuses an invalid name before any remote command", async () => {
            const { runner, calls } = fakeRunner();
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.remove("$(boom)")).rejects.toBeInstanceOf(SnapshotStoreError);
            expect(calls).toEqual([]);
        });
    });

    describe("freeBytes", () => {
        /** A well-formed df -Pk output (mount point with spaces included on purpose). */
        const DF_OK = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 500000 100000 400000 21% /srv/my backups\n";

        it("issues df -Pk -- <root> and parses the Available column", async () => {
            const { runner, calls } = fakeRunner((argv) => (argv[0] === "df" ? { stdout: DF_OK } : {}));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.freeBytes()).resolves.toBe(400000 * 1024);
            expect(calls.at(-1)).toEqual(["df", "-Pk", "--", ROOT]);
        });

        it.each([
            ["garbage text", "no columns here at all"],
            ["header only", "Filesystem 1024-blocks Used Available Capacity Mounted on\n"],
            ["non-numeric available", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 500000 100000 4oo000 21% /\n"],
            ["missing percent token", "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 500000 100000 400000 21 /\n"],
            ["percent token too early", "x 21% y\nz 42% w\n"],
            ["empty output", ""],
        ])("rejects malformed df output: %s", async (_label, stdout) => {
            const { runner } = fakeRunner((argv) => (argv[0] === "df" ? { stdout } : {}));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.freeBytes()).rejects.toBeInstanceOf(SnapshotStoreError);
        });
    });

    describe("withLock (remote mkdir lock, 24h TTL)", () => {
        const LOCK = `${ROOT}/.backupkit.lock`;

        it("acquires via plain mkdir --, records a timestamp marker, runs fn, releases via rm -rf --", async () => {
            const { runner, calls } = fakeRunner();
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            let ran = false;
            await store.withLock(async () => {
                ran = true;
            });
            expect(ran).toBe(true);
            expect(calls).toEqual([
                ["mkdir", "-p", "--", ROOT],
                ["mkdir", "--", LOCK],
                ["mkdir", "-p", "--", `${LOCK}/${NEW}`],
                ["rm", "-rf", "--", LOCK],
            ]);
        });

        it("live contention: fresh marker means LockHeldError, fn never runs, lock left alone", async () => {
            const oneHourAgo = "2026-08-10T021502Z";
            const { runner, calls } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    return { exitCode: 1, stderr: "mkdir: File exists" };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: findOutput(LOCK, [oneHourAgo]) };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            let ran = false;
            const error = await store
                .withLock(async () => {
                    ran = true;
                })
                .then(
                    () => null,
                    (e: unknown) => e,
                );
            expect(error).toBeInstanceOf(LockHeldError);
            expect((error as LockHeldError).pid).toBeNull();
            expect(ran).toBe(false);
            expect(calls.filter((argv) => argv[0] === "rm")).toEqual([]);
        });

        it("stale takeover: a marker past the 24h TTL is removed and the lock re-acquired", async () => {
            const twentyFiveHoursAgo = "2026-08-09T021502Z";
            let lockMkdirs = 0;
            const { runner, calls } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    lockMkdirs += 1;
                    return { exitCode: lockMkdirs === 1 ? 1 : 0 };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: findOutput(LOCK, [twentyFiveHoursAgo]) };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.withLock(async () => "took over")).resolves.toBe("took over");
            expect(calls.map((argv) => argv.slice(0, 2))).toEqual([
                ["mkdir", "-p"],
                ["mkdir", "--"],
                ["find", LOCK],
                ["rm", "-rf"],
                ["mkdir", "--"],
                ["mkdir", "-p"],
                ["rm", "-rf"],
            ]);
        });

        it("a lock whose directory cannot be listed is treated as stale", async () => {
            let lockMkdirs = 0;
            const { runner } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    lockMkdirs += 1;
                    return { exitCode: lockMkdirs === 1 ? 1 : 0 };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { exitCode: 1, stderr: "find: no such file" };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.withLock(async () => "ok")).resolves.toBe("ok");
        });

        it("second EEXIST after a stale removal is live contention", async () => {
            const twentyFiveHoursAgo = "2026-08-09T021502Z";
            const { runner } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    return { exitCode: 1 };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: findOutput(LOCK, [twentyFiveHoursAgo]) };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.withLock(async () => "never")).rejects.toBeInstanceOf(LockHeldError);
        });

        it("releases the lock when fn throws, and rethrows fn's error", async () => {
            const { runner, calls } = fakeRunner();
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(
                store.withLock(async () => {
                    throw new Error("pipeline boom");
                }),
            ).rejects.toThrow("pipeline boom");
            expect(calls.at(-1)).toEqual(["rm", "-rf", "--", LOCK]);
        });
    });
});

describe("openStore", () => {
    it("returns the local implementation for a local destination endpoint", () => {
        const store = openStore({ name: "web", dst: { kind: "local", path: "/srv/backups" } }, { log });
        expect(store).toBeInstanceOf(LocalSnapshotStore);
    });

    it("throws when the destination is remote but no ssh settings are given", () => {
        const remote: ResolvedRemote = { kind: "alias", name: "myserver", alias: "myserver" };
        expect(() =>
            openStore({ name: "web", dst: { kind: "remote", remote, path: "/srv/backups" } }, { log }),
        ).toThrow(SnapshotStoreError);
    });

    describe("remote wiring through runRemote (fake ssh binary)", () => {
        let fake: FakeBinDir;
        let sshBin: string;

        beforeEach(async () => {
            fake = await FakeBinDir.create();
            sshBin = await fake.install("ssh");
        });

        afterEach(async () => {
            await fake.dispose();
        });

        it("sends each store command as one fully quoted shell word sequence to the alias destination", async () => {
            const remote: ResolvedRemote = { kind: "alias", name: "myserver", alias: "myserver" };
            const store = openStore(
                { name: "web", dst: { kind: "remote", remote, path: "/srv/backups" } },
                {
                    log,
                    ssh: {
                        sshBin,
                        context: "unattended",
                        authSock: null,
                        env: fake.env({ ssh: [{ exit: 0 }, { exit: 0, stdout: `/srv/backups/web/${NEW}\0` }] }),
                        retryPolicy: { attempts: 1, baseDelayMs: 1, capMs: 1 },
                    },
                },
            );
            await expect(store.listComplete()).resolves.toEqual([NEW]);
            const calls = await fake.calls();
            expect(calls).toHaveLength(2);
            expect(calls[0].argv.at(-2)).toBe("myserver");
            expect(calls[0].argv.at(-1)).toBe("'mkdir' '-p' '--' '/srv/backups/web'");
            expect(calls[1].argv.at(-1)).toBe(
                "'find' '/srv/backups/web' '-maxdepth' '1' '-mindepth' '1' '-print0'",
            );
        });
    });
});

describe("mkdtemp hygiene helper", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), "backupkit-remote-store-"));
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it("local stores opened via openStore operate under <destination>/<name>", async () => {
        const store = openStore({ name: "web", dst: { kind: "local", path: tmp } }, { log });
        await store.claimPartial(NEW);
        await expect(store.listComplete()).resolves.toEqual([]);
    });
});
