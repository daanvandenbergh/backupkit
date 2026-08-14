import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecResult } from "../../exec/exec.js";
import { LockHeldError, SnapshotStoreError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import { NO_RETRY_POLICY, type RetryPolicy } from "../../shared/retry.js";
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
    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1, ...over };
}

/** NUL-joined find output for full paths under a directory. */
function findOutput(dir: string, names: string[]): string {
    return names.map((name) => `${dir}/${name}\0`).join("");
}

/** A recording fake runner: `handler` maps each argv to a result override (default success). */
function fakeRunner(handler: (argv: readonly string[], call: number) => Partial<ExecResult> | undefined = () => ({})) {
    const calls: string[][] = [];
    /** The per-call retry override each invocation carried (undefined = the runner's default policy). */
    const policies: (RetryPolicy | undefined)[] = [];
    const runner: RemoteRunner = async (argv, options) => {
        const over = handler(argv, calls.length);
        calls.push([...argv]);
        policies.push(options?.retryPolicy);
        return result(over);
    };
    return { runner, calls, policies };
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

    // exec() caps captured stdout at 1 MiB keeping the HEAD (invariant 28), so a
    // listing over the cap comes back as a SHORT, entirely plausible list whose
    // newest name is months stale - the schedule stops being honoured, the
    // --link-dest points at an ancient base, and `newestUndeletable` protects the
    // wrong snapshot. A push client drives the root over the cap with jail-legal
    // `mkdir` commands, so the flag must be a loud failure, never a short list.
    describe("truncated remote output", () => {
        it("refuses a truncated listing instead of treating the head as the whole archive", async () => {
            const { runner } = fakeRunner((argv) =>
                argv[0] === "find" ? { stdout: findOutput(ROOT, [OLD, MID]), truncated: true } : {},
            );
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.listComplete()).rejects.toThrow(/truncated/);
            await expect(store.listComplete()).rejects.toBeInstanceOf(SnapshotStoreError);
        });

        it("refuses truncated df output too (same chokepoint)", async () => {
            const { runner } = fakeRunner((argv) =>
                argv[0] === "df"
                    ? { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 5 1 4 21% /\n", truncated: true }
                    : {},
            );
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.freeBytes()).rejects.toBeInstanceOf(SnapshotStoreError);
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
        it("issues mv -- <partial> <final> then verifies the rename did not nest", async () => {
            const { runner, calls } = fakeRunner(rootListing([`${NEW}.partial`, OLD]));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await store.promote(NEW);
            expect(calls.slice(-2)).toEqual([
                ["mv", "--", `${ROOT}/${NEW}.partial`, `${ROOT}/${NEW}`],
                ["find", `${ROOT}/${NEW}`, "-maxdepth", "1", "-mindepth", "1", "-print0"],
            ]);
        });

        // POSIX `mv A B` with B an existing DIRECTORY moves A inside B, exit 0.
        // If <name> appears between the listing and the mv, the finished snapshot
        // lands at <name>/<name>.partial and the pipeline used to report success
        // on an archive that no longer holds the snapshot where it says it does.
        it("detects a nested mv (the destination appeared mid-flight) and fails loudly", async () => {
            const { runner } = fakeRunner((argv) => {
                if (argv[0] !== "find") {
                    return {};
                }
                return argv[1] === ROOT
                    ? { stdout: findOutput(ROOT, [`${NEW}.partial`, OLD]) }
                    : { stdout: findOutput(`${ROOT}/${NEW}`, [`${NEW}.partial`]) };
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.promote(NEW)).rejects.toThrow(/nested instead of renaming/);
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
            // The all-digits test had no length bound: 400 digits parse to
            // Infinity, and `Infinity >= anything` makes the disk guard pass
            // unconditionally on a full archive.
            [
                "an unbounded digit run that would parse to Infinity",
                `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 500000 100000 ${"9".repeat(400)} 21% /\n`,
            ],
            [
                "an available column above the safe-integer range",
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 500000 100000 90071992547409910 21% /\n",
            ],
        ])("rejects malformed df output: %s", async (_label, stdout) => {
            const { runner } = fakeRunner((argv) => (argv[0] === "df" ? { stdout } : {}));
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.freeBytes()).rejects.toBeInstanceOf(SnapshotStoreError);
        });
    });

    describe("freeInodes", () => {
        // The jail answers `df -Pk --` only, whose POSIX output has no inode
        // columns, and its command grammar is an exact string match - so a push
        // store must say "unknown" rather than guess, and the disk guard skips
        // its inode half.
        it("is null and issues no remote command", async () => {
            const { runner, calls } = fakeRunner();
            const store = new RemoteSnapshotStore(ROOT, runner, log);
            await expect(store.freeInodes()).resolves.toBeNull();
            expect(calls).toEqual([]);
        });
    });

    // A future-dated complete snapshot is one `mkdir -p --` away for a jailed
    // writer. It used to be undeletable (it sorts newest), which bricked the
    // target: every run failed clock-skew and prune could never clear it.
    describe("future-dated snapshots", () => {
        const FUTURE = "2099-01-01T000000Z";

        it("is deletable while genuine history exists; the newest genuine one is not", async () => {
            const { runner, calls } = fakeRunner(rootListing([OLD, NEW, FUTURE]));
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.remove(NEW)).rejects.toThrow(/refusing to delete the newest/);
            await store.remove(FUTURE);
            expect(calls.slice(-2)).toEqual([
                ["mv", "--", `${ROOT}/${FUTURE}`, `${ROOT}/${FUTURE}.deleting`],
                ["rm", "-rf", "--", `${ROOT}/${FUTURE}.deleting`],
            ]);
        });

        it("is protected when it is the only snapshot - never lose the last copy", async () => {
            const { runner } = fakeRunner(rootListing([FUTURE]));
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.remove(FUTURE)).rejects.toThrow(/refusing to delete the newest/);
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

        it("names the archive host in the message - the lock is not on this machine", async () => {
            // A bare absolute path reads as a local one: an operator rm -rf'd
            // it on his own box (where it does not even exist) while the real
            // lock sat untouched on the archive host.
            const { runner } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    return { exitCode: 1, stderr: "mkdir: File exists" };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: findOutput(LOCK, ["2026-08-10T021502Z"]) };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW, true, "backupkit@archive.example.com");
            await expect(store.withLock(async () => undefined)).rejects.toThrow(
                `another backupkit holds backupkit@archive.example.com:${LOCK}`,
            );
        });

        it("unlock: nothing held - probes by acquiring, then leaves the root clean", async () => {
            const { runner, calls } = fakeRunner();
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.unlock(false)).resolves.toEqual({ status: "none" });
            // The probe wins the lock, writes the marker (so a crash here
            // leaves a TTL-expiring lock, never an eternal markerless one) and
            // removes it again.
            expect(calls.slice(-3)).toEqual([
                ["mkdir", "--", LOCK],
                ["mkdir", "-p", "--", `${LOCK}/${NEW}`],
                ["rm", "-rf", "--", LOCK],
            ]);
        });

        it("unlock: clears a leaked lock a killed run left behind (the 24h-TTL trap)", async () => {
            const leaked = "2026-08-10T021502Z";
            // The MARKER is the colon-free filename form; the operator-facing
            // detail renders it through `formatUtc` like every other timestamp.
            const leakedShown = "created 2026-08-10T02:15:02Z";
            const { runner, calls } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    return { exitCode: 1, stderr: "mkdir: File exists" };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: findOutput(LOCK, [leaked]) };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            // Within the TTL it is a LIVE lock, so the default refuses it: no
            // pid exists remotely to prove the holder is dead.
            await expect(store.unlock(false)).resolves.toEqual({ status: "held", detail: leakedShown });
            expect(calls.filter((argv) => argv[0] === "rm")).toEqual([]);
            // --force is the operator saying "that run is gone" - the only cure
            // that used to require an ssh session and a hand-typed rm -rf.
            await expect(store.unlock(true)).resolves.toEqual({ status: "removed", detail: leakedShown });
            expect(calls.filter((argv) => argv[0] === "rm")).toEqual([["rm", "-rf", "--", LOCK]]);
        });

        it("does not steal a fresh markerless lock caught in the mkdir->marker window", async () => {
            // Contender's mkdir loses (EEXIST); the winner has created the lock
            // dir but not yet its snapshot-named marker, so find lists nothing.
            // The contender must treat this as held (LockHeldError), never
            // rm -rf it - stealing here runs two pipelines against one archive.
            const { runner, calls } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    return { exitCode: 1, stderr: "mkdir: File exists" };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: "" };
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

        // Regression: the TTL was `now - created > TTL`, so a marker dated in the
        // FUTURE gave a negative age the TTL could never exceed and the lock was
        // reported held FOREVER. A jailed writer plants one with a single
        // `mkdir -p -- <lock>/2099-01-01T000000Z` (the jail accepts it by
        // design), and an honest holder SIGKILLed while its clock was wrong
        // leaves the same thing behind. That is a permanent DoS on the target.
        it("stale takeover: a marker dated in the FUTURE is stale, not held forever", async () => {
            let lockMkdirs = 0;
            const { runner } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    lockMkdirs += 1;
                    return { exitCode: lockMkdirs === 1 ? 1 : 0 };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { stdout: findOutput(LOCK, ["2099-01-01T000000Z"]) };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await expect(store.withLock(async () => "took over")).resolves.toBe("took over");
        });

        it("a marker inside the TTL in either direction is still live contention", async () => {
            for (const marker of ["2026-08-10T031000Z", "2026-08-10T040000Z"]) {
                const { runner } = fakeRunner((argv) => {
                    if (argv[0] === "mkdir" && argv[1] === "--") {
                        return { exitCode: 1 };
                    }
                    if (argv[0] === "find" && argv[1] === LOCK) {
                        return { stdout: findOutput(LOCK, [marker]) };
                    }
                    return {};
                });
                const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
                await expect(store.withLock(async () => "never")).rejects.toBeInstanceOf(LockHeldError);
            }
        });

        // "We could not read the lock at all" is strictly LESS information than
        // "the lock has no marker", which is deliberately treated as HELD - so it
        // must not be treated as more conclusive. Judging it stale deletes a LIVE
        // holder's lock and runs two pipelines against one archive root, which is
        // the single thing this lock exists to prevent.
        it("a lock whose directory cannot be listed is treated as HELD, never stolen", async () => {
            const { runner, calls } = fakeRunner((argv) => {
                if (argv[0] === "mkdir" && argv[1] === "--") {
                    return { exitCode: 1, stderr: "mkdir: File exists" };
                }
                if (argv[0] === "find" && argv[1] === LOCK) {
                    return { exitCode: 1, stderr: "find: Permission denied" };
                }
                return {};
            });
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            let ran = false;
            await expect(
                store.withLock(async () => {
                    ran = true;
                }),
            ).rejects.toBeInstanceOf(LockHeldError);
            expect(ran).toBe(false);
            expect(calls.filter((argv) => argv[0] === "rm")).toEqual([]);
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

        // The wedge this guards: runRemote's transport retry re-sends the whole
        // ssh command, so a blip AFTER the remote mkdir succeeded would re-send
        // it, hit EEXIST against this process's own fresh lock, find no marker
        // (writeMeta never ran) and treat it as held - forever, since a
        // markerless lock has no TTL. Every mutation must therefore be issued
        // with NO_RETRY_POLICY; only reads and idempotent commands may retry.
        it("issues every mutating remote command with NO_RETRY_POLICY, and reads with the default", async () => {
            const { runner, calls, policies } = fakeRunner(rootListing([OLD, MID, "2026-08-07T000000Z.partial"]));
            const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW);
            await store.withLock(async () => {
                await store.claimPartial(NEW);
                await store.remove(OLD);
            });
            // mkdir -p (root/marker), find, df and rm -rf are idempotent or
            // read-only: they keep the control retry. mkdir -- and mv -- do not.
            const MUTATING = ["mkdir --", "mv --"];
            const commands = calls.map((argv) => argv.slice(0, 2).join(" "));
            const unretried = commands.filter((_, index) => policies[index] === NO_RETRY_POLICY);
            const retried = commands.filter((_, index) => policies[index] === undefined);

            expect(policies.filter((policy) => policy !== undefined && policy !== NO_RETRY_POLICY)).toEqual([]);
            expect(unretried).toEqual(commands.filter((command) => MUTATING.includes(command)));
            expect(retried).toEqual(commands.filter((command) => !MUTATING.includes(command)));
            // Vacuity guard: the run really exercised all three mutations.
            expect(unretried).toEqual(["mkdir --", "mv --", "mv --"]);
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

// `"jail": false` exists for the restricted appliance account (a Hetzner
// Storage Box: ls/mkdir/mv/rm/df/rsync and nothing else). Listing with `find`
// there fails every run with "Command not found", so an unjailed store must
// list with `ls -A --` - the one listing verb such a shell always has.
describe("RemoteSnapshotStore unjailed (jail: false)", () => {
    /** Handler answering `ls` on `dir` with newline-separated basenames, everything else success. */
    function lsListing(dir: string, names: string[]) {
        return (argv: readonly string[]) =>
            argv[0] === "ls" && argv[3] === dir ? { stdout: `${names.join("\n")}\n` } : {};
    }

    it("lists the root with ls -A -- and parses newline-separated basenames", async () => {
        const { runner, calls } = fakeRunner(lsListing(ROOT, [NEW, `${MID}.partial`, OLD, ".backupkit.lock"]));
        const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW, false);
        await expect(store.listComplete()).resolves.toEqual([OLD, NEW]);
        expect(calls).toEqual([
            ["mkdir", "-p", "--", ROOT],
            ["ls", "-A", "--", ROOT],
        ]);
    });

    it("never sends find - the appliance shell has none", async () => {
        const { runner, calls } = fakeRunner(lsListing(ROOT, [OLD, NEW]));
        const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW, false);
        await store.withLock(async () => {
            await store.listComplete();
            await store.claimPartial(NEW);
        });
        expect(calls.some((argv) => argv[0] === "find")).toBe(false);
    });

    it("verifies a promote with ls and still catches the nested rename", async () => {
        const nested = fakeRunner((argv) => {
            if (argv[0] !== "ls") {
                return {};
            }
            return argv[3] === ROOT
                ? { stdout: `${NEW}.partial\n` }
                : { stdout: `${NEW}.partial\nsome-file\n` }; // listing the promoted dir
        });
        const store = new RemoteSnapshotStore(ROOT, nested.runner, log, () => NOW, false);
        await expect(store.promote(NEW)).rejects.toThrow(/nested instead of renaming/);
    });

    it("reads the lock marker with ls, so the 24h TTL still frees a stale lock", async () => {
        const stale = "2026-08-01T000000Z"; // > 24 h before NOW
        const { runner, calls } = fakeRunner((argv, call) => {
            if (argv[0] === "mkdir" && argv[1] === "--") {
                // First acquire attempt loses; after the stale lock is removed the retry wins.
                return { exitCode: call < 3 ? 1 : 0 };
            }
            return argv[0] === "ls" && argv[3] === `${ROOT}/.backupkit.lock` ? { stdout: `${stale}\n` } : {};
        });
        const store = new RemoteSnapshotStore(ROOT, runner, log, () => NOW, false);
        await expect(store.withLock(async () => "ran")).resolves.toBe("ran");
        expect(calls.some((argv) => argv[0] === "ls" && argv[3] === `${ROOT}/.backupkit.lock`)).toBe(true);
        expect(calls.some((argv) => argv[0] === "rm" && argv[3] === `${ROOT}/.backupkit.lock`)).toBe(true);
    });
});

describe("openStore", () => {
    it("returns the local implementation for a local destination endpoint", () => {
        const store = openStore({ name: "web", dst: { kind: "local", path: "/srv/backups" }, jail: false }, { log });
        expect(store).toBeInstanceOf(LocalSnapshotStore);
    });

    it("throws when the destination is remote but no ssh settings are given", () => {
        const remote: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "myserver", alias: "myserver" };
        expect(() =>
            openStore({ name: "web", dst: { kind: "remote", remote, path: ROOT }, jail: true }, { log }),
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
            const remote: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "myserver", alias: "myserver" };
            const store = openStore(
                { name: "web", dst: { kind: "remote", remote, path: ROOT }, jail: true },
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

        // The unit's TimeoutStopSec is 30 s, but a store command waits up to
        // runRemote's 60 s timeout and then retries - so without the signal a
        // stop against an unresponsive archive host is SIGKILLed mid-lock,
        // leaving a remote lock only the 24 h TTL clears.
        it("aborts an in-flight store command when the shutdown signal fires", async () => {
            const remote: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "myserver", alias: "myserver" };
            const controller = new AbortController();
            const store = openStore(
                { name: "web", dst: { kind: "remote", remote, path: ROOT }, jail: true },
                {
                    log,
                    ssh: {
                        sshBin,
                        context: "unattended",
                        authSock: null,
                        // The fake ssh sleeps far past any stop budget.
                        env: fake.env({ ssh: [{ exit: 0, sleepMs: 60_000 }] }),
                        retryPolicy: { attempts: 3, baseDelayMs: 1, capMs: 2 },
                        signal: controller.signal,
                    },
                },
            );
            const started = Date.now();
            const pending = store.listComplete().then(
                () => null,
                (error: unknown) => error,
            );
            // Let the child spawn, then stop.
            await new Promise((resolve) => setTimeout(resolve, 200));
            controller.abort();
            const error = await pending;
            // exec/ SIGTERMs the child, so ssh dies on a signal and runRemote
            // reports it - and the abort stops it retrying that as a blip.
            expect(String((error as Error).message)).toContain("was killed by signal");
            // Bounded by the child's death, not by the 60 s sleep or the retries.
            expect(Date.now() - started).toBeLessThan(15_000);
        });

        // The end-to-end shape of the wedge: a transport blip on the lock
        // mkdir must NOT put a second mkdir on the wire, because the first one
        // may already have created the lock on the remote. One attempt, one
        // failed run, and the next tick retries against a lock this process can
        // still distinguish from its own.
        it("never re-sends the lock mkdir when the transport blips, even with a retrying store policy", async () => {
            const remote: ResolvedRemote = { kind: "alias", restrictedShell: false, name: "myserver", alias: "myserver" };
            const store = openStore(
                { name: "web", dst: { kind: "remote", remote, path: ROOT }, jail: true },
                {
                    log,
                    ssh: {
                        sshBin,
                        context: "unattended",
                        authSock: null,
                        env: fake.env({
                            ssh: [
                                { exit: 0 },
                                { exit: 255, stderr: "kex_exchange_identification: Connection closed by remote host" },
                            ],
                        }),
                        // A RETRYING store-wide policy: the per-call NO_RETRY on
                        // the mkdir must win over it.
                        retryPolicy: { attempts: 3, baseDelayMs: 1, capMs: 1 },
                    },
                },
            );
            await expect(store.withLock(async () => "never runs")).rejects.toThrow(/ssh myserver failed \(exit 255\)/);
            const calls = await fake.calls();
            const commands = calls.map((call) => call.argv.at(-1));
            expect(commands).toEqual(["'mkdir' '-p' '--' '/srv/backups/web'", "'mkdir' '--' '/srv/backups/web/.backupkit.lock'"]);
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

    it("local stores opened via openStore operate on the destination ITSELF, with no target-name level", async () => {
        // A snapshot placed directly in the destination is the archive. If
        // openStore appended the target name again, this listing would come back
        // empty and the target would silently start a second archive one level
        // down - the pre-2.0 layout, reintroduced.
        await mkdir(join(tmp, OLD), { recursive: true });
        const store = openStore({ name: "web", dst: { kind: "local", path: tmp }, jail: false }, { log });
        await expect(store.listComplete()).resolves.toEqual([OLD]);
        await store.claimPartial(NEW);
        expect(existsSync(join(tmp, "web"))).toBe(false);
    });
});
