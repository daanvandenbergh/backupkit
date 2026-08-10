/**
 * End-to-end engine integration against a REAL local rsync: the full
 * pull-mode pipeline over tmpdirs - first snapshot content, second snapshot
 * hardlink proof (--link-dest), promote semantics, retention prune, and a
 * real restore. SKIPS LOUDLY when the local rsync is below the 3.2.5 floor
 * (e.g. macOS openrsync); CI-grade rsync runs it fully.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Backupkit } from "../backupkit.js";
import { probeLocalRsync } from "../../rsync/rsync.js";
import { makeConfig, makeTarget } from "./fakes.js";

let rsyncProbe: { bin: string; version: string } | null = null;
try {
    rsyncProbe = await probeLocalRsync(null);
} catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[engine integration] SKIPPED - no usable local rsync: ${(error as Error).message}`);
}

describe.skipIf(rsyncProbe === null)("engine integration (real local rsync, full pipeline)", () => {
    let root = "";
    let source = "";
    let destination = "";
    let stateDir = "";
    let clock = { now: new Date("2026-08-10T12:00:00Z") };

    /** Build a fresh engine over the fixture dirs with the real transfer stack. */
    function makeEngine(retention: { keepLast: number } | null): Backupkit {
        const target = makeTarget({
            source,
            destination,
            retention,
            minFree: { kind: "percent", percent: 0 }, // exercises the estimate + statfs path, floor 0
            src: { kind: "local", path: source },
            dst: { kind: "local", path: destination },
        });
        return new Backupkit(makeConfig({ configPath: join(root, "config.jsonc"), stateDir, targets: [target] }), {
            now: () => clock.now,
            runtimeDir: join(root, "run"),
            env: {},
            hasTty: false,
        });
    }

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "backupkit-e2e-"));
        source = join(root, "src");
        destination = join(root, "archive");
        stateDir = join(root, "state");
        clock = { now: new Date("2026-08-10T12:00:00Z") };
        await writeFile(join(root, "config.jsonc"), "{}\n", { mode: 0o600 });
        await mkdir(join(source, "sub"), { recursive: true, mode: 0o700 });
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await writeFile(join(source, "a.txt"), "alpha v1\n");
        await writeFile(join(source, "sub", "b.txt"), "beta\n");
        await writeFile(join(source, "we ird $file'name.txt"), "hostile name\n");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("full pipeline: first snapshot, hardlink proof, retention prune, restore", async () => {
        const kit = makeEngine({ keepLast: 2 });

        // Run 1: first snapshot, promoted, report persisted.
        const first = await kit.run({ force: true });
        expect(first.targets[0].status).toBe("success");
        const snap1 = join(destination, "web", "2026-08-10T120000Z");
        expect(existsSync(snap1)).toBe(true);
        expect(existsSync(`${snap1}.partial`)).toBe(false);
        expect(await readFile(join(snap1, "a.txt"), "utf8")).toBe("alpha v1\n");
        expect(await readFile(join(snap1, "we ird $file'name.txt"), "utf8")).toBe("hostile name\n");
        expect((await readdir(join(stateDir, "runs", "web"))).length).toBe(1);
        expect(first.targets[0].stats?.filesTransferred).toBeGreaterThan(0);

        // Run 2: changed file diverges, unchanged file hardlinks into snap1.
        await writeFile(join(source, "a.txt"), "alpha v2 - changed\n");
        clock.now = new Date("2026-08-11T12:00:00Z");
        const second = await kit.run();
        expect(second.targets[0].status).toBe("success");
        const snap2 = join(destination, "web", "2026-08-11T120000Z");
        const unchanged1 = await stat(join(snap1, "sub", "b.txt"));
        const unchanged2 = await stat(join(snap2, "sub", "b.txt"));
        expect(unchanged2.ino).toBe(unchanged1.ino);
        const changed1 = await stat(join(snap1, "a.txt"));
        const changed2 = await stat(join(snap2, "a.txt"));
        expect(changed2.ino).not.toBe(changed1.ino);
        expect(await readFile(join(snap2, "a.txt"), "utf8")).toBe("alpha v2 - changed\n");
        expect(await readFile(join(snap1, "a.txt"), "utf8")).toBe("alpha v1\n");

        // Run 3: keepLast 2 prunes the first snapshot, keeps the two newest.
        clock.now = new Date("2026-08-12T12:00:00Z");
        const third = await kit.run();
        expect(third.targets[0].status).toBe("success");
        expect(existsSync(snap1)).toBe(false);
        expect(existsSync(snap2)).toBe(true);
        expect(existsSync(join(destination, "web", "2026-08-12T120000Z"))).toBe(true);

        // Restore latest to a fresh path, verified, byte-identical.
        const out = join(root, "restored");
        const restore = await kit.restore({ target: "web", snapshot: "latest", output: out, verify: true });
        expect(restore.snapshot).toBe("2026-08-12T120000Z");
        expect(restore.verified).toBe(true);
        expect(await readFile(join(out, "a.txt"), "utf8")).toBe("alpha v2 - changed\n");
        expect(await readFile(join(out, "sub", "b.txt"), "utf8")).toBe("beta\n");
        expect(await readFile(join(out, "we ird $file'name.txt"), "utf8")).toBe("hostile name\n");
    }, 60_000);

    it("resumes an orphaned partial via claimPartial instead of restarting", async () => {
        const kit = makeEngine(null);
        // Plant a stale partial (as a crashed run would leave behind).
        const stale = join(destination, "web", "2026-08-09T000000Z.partial");
        await mkdir(stale, { recursive: true });
        await writeFile(join(stale, "left-behind.txt"), "from the dead run\n");
        const report = await kit.run({ force: true });
        expect(report.targets[0].status).toBe("success");
        const snap = join(destination, "web", "2026-08-10T120000Z");
        expect(existsSync(snap)).toBe(true);
        expect(existsSync(stale)).toBe(false);
        // rsync --delete cleaned the leftover from the resumed partial.
        expect(existsSync(join(snap, "left-behind.txt"))).toBe(false);
        expect(await readFile(join(snap, "a.txt"), "utf8")).toBe("alpha v1\n");
    }, 60_000);
});
