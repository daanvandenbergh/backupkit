import { link, mkdir, mkdtemp, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SnapshotStoreError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import { LocalSnapshotStore } from "../internal/local-store.js";

/** Silent logger for the suites. */
const log = new Logger({ level: "error", stdout: { write() {} }, stderr: { write() {} } });

/** Three chronologically ordered snapshot names. */
const OLD = "2026-08-08T010000Z";
const MID = "2026-08-09T020000Z";
const NEW = "2026-08-10T031502Z";

describe("LocalSnapshotStore", () => {
    let tmp: string;
    let root: string;
    let store: LocalSnapshotStore;

    beforeEach(async () => {
        tmp = await mkdtemp(join(tmpdir(), "backupkit-local-"));
        root = join(tmp, "web");
        store = new LocalSnapshotStore(root, log);
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    /** Create a snapshot directory (with one marker file) under the root. */
    async function makeDir(name: string): Promise<void> {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(join(root, name, "file.txt"), `content of ${name}`);
    }

    describe("listComplete", () => {
        it("returns [] when the root does not exist yet", async () => {
            await expect(store.listComplete()).resolves.toEqual([]);
        });

        it("lists complete names lexically ascending regardless of creation order", async () => {
            await makeDir(NEW);
            await makeDir(OLD);
            await makeDir(MID);
            await expect(store.listComplete()).resolves.toEqual([OLD, MID, NEW]);
        });

        it("never lists a .partial as complete, and ignores .deleting and non-regex names", async () => {
            await makeDir(OLD);
            await makeDir(`${NEW}.partial`);
            await makeDir(`${MID}.deleting`);
            await makeDir("legacy-1700000000");
            await makeDir("notes");
            await writeFile(join(root, "stray-file"), "x");
            // Shape matches the regex but is not a real date: ignored too.
            await makeDir("2026-13-40T996161Z");
            await expect(store.listComplete()).resolves.toEqual([OLD]);
        });
    });

    describe("claimPartial", () => {
        it("returns resumed:false on a fresh root and creates it", async () => {
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: false });
            expect((await stat(root)).isDirectory()).toBe(true);
        });

        it("renames the single existing partial to <newName>.partial and keeps its contents", async () => {
            await makeDir(`${OLD}.partial`);
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: true });
            const entries = await readdir(root);
            expect(entries.sort()).toEqual([`${NEW}.partial`]);
            expect((await stat(join(root, `${NEW}.partial`, "file.txt"))).isFile()).toBe(true);
        });

        it("is a no-op rename when the partial already carries the new name", async () => {
            await makeDir(`${NEW}.partial`);
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: true });
            expect((await readdir(root)).sort()).toEqual([`${NEW}.partial`]);
        });

        it("keeps only the newest of several partials and deletes the others", async () => {
            await makeDir(`${OLD}.partial`);
            await makeDir(`${MID}.partial`);
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: true });
            const entries = await readdir(root);
            expect(entries.sort()).toEqual([`${NEW}.partial`]);
            // The survivor is the renamed MID partial, not the deleted OLD one.
            expect((await stat(join(root, `${NEW}.partial`, "file.txt"))).isFile()).toBe(true);
        });

        it("sweeps .deleting crash artifacts", async () => {
            await makeDir(`${OLD}.deleting`);
            await makeDir(MID);
            await store.claimPartial(NEW);
            expect((await readdir(root)).sort()).toEqual([MID]);
        });

        it("never touches names failing the snapshot regex family", async () => {
            await makeDir("legacy-1700000000");
            await makeDir("junk.partial");
            await makeDir("junk.deleting");
            await makeDir(".hidden");
            await store.claimPartial(NEW);
            expect((await readdir(root)).sort()).toEqual([".hidden", "junk.deleting", "junk.partial", "legacy-1700000000"]);
        });

        it("rejects an invalid new name", async () => {
            await expect(store.claimPartial("../evil")).rejects.toBeInstanceOf(SnapshotStoreError);
        });

        // Regression: `--link-dest` hardlinks unchanged files into the previous
        // snapshot, so resuming into a surviving partial lets rsync's
        // attribute-only update path (same size and mtime, different mode or
        // uid) chmod/chown THROUGH the link and mutate an already-promoted -
        // immutable - snapshot. Verified with the real argv: the promoted
        // snapshot's mode went from -rw-r--r-- to -rw-rw-rw-.
        it("discards a partial that hardlinks into a promoted snapshot instead of resuming into it", async () => {
            await makeDir(OLD);
            await makeDir(`${MID}.partial`);
            await rm(join(root, `${MID}.partial`, "file.txt"));
            await link(join(root, OLD, "file.txt"), join(root, `${MID}.partial`, "file.txt"));
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: false });
            // The partial is gone; the promoted snapshot it linked into is untouched.
            expect((await readdir(root)).sort()).toEqual([OLD]);
            expect((await stat(join(root, OLD, "file.txt"))).nlink).toBe(1);
        });

        it("still resumes a link-free partial (the first-ever transfer, where a resume actually pays)", async () => {
            await makeDir(`${MID}.partial`);
            await mkdir(join(root, `${MID}.partial`, "nested"), { recursive: true });
            await writeFile(join(root, `${MID}.partial`, "nested", "deep.txt"), "x");
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: true });
            expect((await readdir(root)).sort()).toEqual([`${NEW}.partial`]);
        });

        it("discards a partial whose hardlink sits in a nested directory", async () => {
            await makeDir(OLD);
            await makeDir(`${MID}.partial`);
            await mkdir(join(root, `${MID}.partial`, "nested"), { recursive: true });
            await link(join(root, OLD, "file.txt"), join(root, `${MID}.partial`, "nested", "file.txt"));
            await expect(store.claimPartial(NEW)).resolves.toEqual({ resumed: false });
        });
    });

    describe("promote", () => {
        it("is a single atomic rename: same inode, contents intact, partial gone", async () => {
            await makeDir(`${NEW}.partial`);
            const before = await stat(join(root, `${NEW}.partial`));
            await store.promote(NEW);
            const after = await stat(join(root, NEW));
            expect(after.ino).toBe(before.ino);
            expect((await stat(join(root, NEW, "file.txt"))).isFile()).toBe(true);
            expect((await readdir(root)).sort()).toEqual([NEW]);
            await expect(store.listComplete()).resolves.toEqual([NEW]);
        });

        it("fails when no partial exists", async () => {
            await mkdir(root, { recursive: true });
            await expect(store.promote(NEW)).rejects.toThrow(/no partial snapshot/);
        });

        it("refuses to promote over an existing complete snapshot", async () => {
            await makeDir(NEW);
            await makeDir(`${NEW}.partial`);
            await expect(store.promote(NEW)).rejects.toThrow(/already exists/);
            // Neither side was touched.
            expect((await readdir(root)).sort()).toEqual([NEW, `${NEW}.partial`]);
        });

        it("rejects an invalid name", async () => {
            await expect(store.promote("not-a-snapshot")).rejects.toBeInstanceOf(SnapshotStoreError);
        });
    });

    describe("remove", () => {
        it("deletes a non-newest snapshot two-phase and leaves no artifact", async () => {
            await makeDir(OLD);
            await makeDir(MID);
            await makeDir(NEW);
            await store.remove(OLD);
            expect((await readdir(root)).sort()).toEqual([MID, NEW]);
        });

        it("refuses to delete the newest complete snapshot", async () => {
            await makeDir(OLD);
            await makeDir(NEW);
            await expect(store.remove(NEW)).rejects.toThrow(/newest complete snapshot/);
            expect((await readdir(root)).sort()).toEqual([OLD, NEW]);
        });

        it("refuses a name that is not a complete snapshot", async () => {
            await makeDir(NEW);
            await expect(store.remove(MID)).rejects.toThrow(/not a complete snapshot/);
        });

        it("refuses an invalid name outright", async () => {
            await makeDir("keep-me");
            await expect(store.remove("keep-me")).rejects.toBeInstanceOf(SnapshotStoreError);
            expect((await readdir(root)).sort()).toEqual(["keep-me"]);
        });

        it("a .deleting crash artifact from a killed remove is swept by the next claimPartial", async () => {
            await makeDir(OLD);
            await makeDir(NEW);
            // Simulate a crash between the two phases of remove(OLD).
            await makeDir(`${OLD}.deleting`);
            await rm(join(root, OLD), { recursive: true, force: true });
            await store.claimPartial(NEW);
            expect((await readdir(root)).sort()).toEqual([NEW]);
        });
    });

    describe("freeBytes", () => {
        it("reports a sane positive byte count via statfs", async () => {
            await mkdir(root, { recursive: true });
            const free = await store.freeBytes();
            expect(Number.isFinite(free)).toBe(true);
            expect(free).toBeGreaterThan(0);
        });

        it("wraps a statfs failure in SnapshotStoreError", async () => {
            const missing = new LocalSnapshotStore(join(tmp, "does", "not", "exist"), log);
            await expect(missing.freeBytes()).rejects.toBeInstanceOf(SnapshotStoreError);
        });
    });

    describe("freeInodes", () => {
        it("reports statfs ffree, or null on a filesystem without inode accounting", async () => {
            await mkdir(root, { recursive: true });
            const inodes = await store.freeInodes();
            // ffree drifts between calls, so the shape is what matters: a positive
            // count on an inode-accounting filesystem, null when there is none.
            if ((await statfs(root)).files === 0) {
                expect(inodes).toBeNull();
            } else {
                expect(inodes).toBeGreaterThan(0);
            }
        });

        it("is null (never a guess) when statfs fails", async () => {
            const missing = new LocalSnapshotStore(join(tmp, "does", "not", "exist"), log);
            await expect(missing.freeInodes()).resolves.toBeNull();
        });
    });

    // A future-dated complete snapshot - one `mkdir` from a jailed writer, or a
    // single clock-skew event - used to be UNDELETABLE: it sorted newest, so the
    // store refused it unconditionally, every run failed clock-skew and recovery
    // needed shell on the archive host. It stays protected only while it is the
    // ONLY snapshot (it may hold the only copy of the data).
    describe("future-dated snapshots", () => {
        /** A snapshot name far enough ahead of the fixed clock to be implausible. */
        const FUTURE = "2099-01-01T000000Z";

        /** A store whose clock is fixed just after NEW. */
        function clockedStore(): LocalSnapshotStore {
            return new LocalSnapshotStore(root, log, () => new Date("2026-08-10T04:00:00Z"));
        }

        it("lists a future-dated name (so retention and prune can see it)", async () => {
            await makeDir(OLD);
            await makeDir(FUTURE);
            await expect(clockedStore().listComplete()).resolves.toEqual([OLD, FUTURE]);
        });

        it("is deletable while genuine history exists, and the newest genuine one is not", async () => {
            await makeDir(OLD);
            await makeDir(NEW);
            await makeDir(FUTURE);
            const clocked = clockedStore();
            await expect(clocked.remove(NEW)).rejects.toThrow(/refusing to delete the newest/);
            await clocked.remove(FUTURE);
            expect((await readdir(root)).sort()).toEqual([OLD, NEW]);
        });

        it("is protected when it is the only snapshot - never lose the last copy", async () => {
            await makeDir(FUTURE);
            await expect(clockedStore().remove(FUTURE)).rejects.toThrow(/refusing to delete the newest/);
        });
    });
});
