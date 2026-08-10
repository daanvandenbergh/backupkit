/**
 * Restore safety tests (spec section 8, security invariant 7): existing
 * output refused, output inside an archive root refused, `latest` resolution,
 * unknown-snapshot messaging, and the copy/verify argv - which never carries
 * `--delete`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, RestoreError } from "../../shared/errors.js";
import { makeExecResult, makeKit, type KitFixture } from "./fakes.js";

/** Snapshot fixture names, oldest to newest. */
const OLD_SNAP = "2026-08-01T000000Z";
const NEW_SNAP = "2026-08-05T000000Z";

/** Create the two complete snapshot directories on disk for a fixture kit. */
async function seedSnapshots(fixture: KitFixture): Promise<void> {
    for (const name of [OLD_SNAP, NEW_SNAP]) {
        const dir = join(fixture.destination, "web", name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "a.txt"), `content of ${name}\n`);
    }
}

describe("restore", () => {
    let fixture: KitFixture | null = null;

    afterEach(async () => {
        if (fixture !== null) {
            await rm(fixture.root, { recursive: true, force: true });
            fixture = null;
        }
    });

    it("rejects an unknown target with the configured names", async () => {
        fixture = await makeKit();
        await expect(
            fixture.kit.restore({ target: "nope", snapshot: "latest", output: join(fixture.root, "out") }),
        ).rejects.toThrow(ConfigError);
    });

    it("rejects an unknown snapshot naming the newest complete one", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "2026-01-01T000000Z", output: join(fixture.root, "out") }),
        ).rejects.toThrow(new RegExp(`newest complete is ${NEW_SNAP}`));
    });

    it("rejects when no snapshot exists at all", async () => {
        fixture = await makeKit();
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.root, "out") }),
        ).rejects.toThrow(/no snapshots exist yet/);
    });

    it("rejects an existing output path", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        const out = join(fixture.root, "out");
        await mkdir(out);
        await expect(fixture.kit.restore({ target: "web", snapshot: "latest", output: out })).rejects.toThrow(
            /already exists/,
        );
    });

    it("rejects an output whose parent resolves inside an archive root", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.destination, "web", "out") }),
        ).rejects.toThrow(/inside the archive root/);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.destination, "out") }),
        ).rejects.toThrow(/inside the archive root/);
    });

    it("rejects a missing output parent", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.root, "missing", "out") }),
        ).rejects.toThrow(/does not exist/);
    });

    it("latest resolves to the newest complete snapshot; the copy argv never carries --delete", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        const out = join(fixture.root, "out");
        const report = await fixture.kit.restore({ target: "web", snapshot: "latest", output: out });
        expect(report).toEqual({ target: "web", snapshot: NEW_SNAP, output: out, verified: false });
        const copy = fixture.execCalls.at(-1);
        expect(copy?.bin).toBe("/fake/rsync");
        expect(copy?.args).toEqual(["-a", "--sparse", "-H", join(fixture.destination, "web", NEW_SNAP) + "/", out]);
        expect(copy?.args.some((arg) => arg.includes("--delete"))).toBe(false);
    });

    it("restores a named snapshot", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        const out = join(fixture.root, "out");
        const report = await fixture.kit.restore({ target: "web", snapshot: OLD_SNAP, output: out });
        expect(report.snapshot).toBe(OLD_SNAP);
    });

    it("a failing copy is a RestoreError, never a silent success", async () => {
        fixture = await makeKit({
            deps: { execFn: async () => makeExecResult({ exitCode: 11, stderr: "disk full" }) },
        });
        await seedSnapshots(fixture);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.root, "out") }),
        ).rejects.toThrow(/exit 11/);
    });

    it("verify: a clean checksum pass reports verified true and never passes --delete", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        const out = join(fixture.root, "out");
        const report = await fixture.kit.restore({ target: "web", snapshot: "latest", output: out, verify: true });
        expect(report.verified).toBe(true);
        const verify = fixture.execCalls.at(-1);
        expect(verify?.args).toContain("--checksum");
        expect(verify?.args).toContain("--dry-run");
        expect(verify?.args.some((arg) => arg.includes("--delete"))).toBe(false);
    });

    it("verify: a content-change itemize line is a RestoreError listing the path", async () => {
        let call = 0;
        fixture = await makeKit({
            deps: {
                execFn: async () => {
                    call += 1;
                    // First call = copy (clean); second = verify (differs).
                    return makeExecResult({ stdout: call === 2 ? ">f.st...... a.txt\n" : "" });
                },
            },
        });
        await seedSnapshots(fixture);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.root, "out"), verify: true }),
        ).rejects.toThrow(/a\.txt/);
    });
});
