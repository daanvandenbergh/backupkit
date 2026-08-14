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
import { makeExecResult, makeKit, makeTarget, type KitFixture } from "./fakes.js";

/** Snapshot fixture names, oldest to newest. */
const OLD_SNAP = "2026-08-01T000000Z";
const NEW_SNAP = "2026-08-05T000000Z";

/** Create the two complete snapshot directories on disk for a fixture kit. */
async function seedSnapshots(fixture: KitFixture): Promise<void> {
    for (const name of [OLD_SNAP, NEW_SNAP]) {
        const dir = join(fixture.destination, name);
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
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.destination, "out") }),
        ).rejects.toThrow(/inside the archive root/);
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.destination, "out") }),
        ).rejects.toThrow(/inside the archive root/);
    });

    // Invariant 11: restore's rsync talks to the remote as SENDER - the exact
    // server-to-client-write direction the >= 3.2.5 floor exists for. Every
    // scheduled transfer gates on the probe; restore used to skip it.
    it("gates on the remote rsync floor for a push target", async () => {
        let probes = 0;
        fixture = await makeKit({
            target: {
                dst: { kind: "remote", remote: { kind: "alias", restrictedShell: false, name: "srv", alias: "myserver" }, path: "/srv/backups" },
            },
            deps: {
                probeRemote: async () => {
                    probes += 1;
                    throw new Error("rsync 3.1.3 on myserver is below the required floor 3.2.5");
                },
            },
        });
        await expect(
            fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.root, "out") }),
        ).rejects.toThrow(/below the required floor 3\.2\.5/);
        expect(probes).toBe(1);
        // Refused before any rsync ran.
        expect(fixture.execCalls.filter((call) => call.bin === "/fake/rsync")).toEqual([]);
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
        expect(copy?.args).toEqual([
            "-a",
            "--sparse",
            "-H",
            "--numeric-ids",
            "--chmod=ug-s",
            "--no-devices",
            "--no-specials",
            join(fixture.destination, NEW_SNAP) + "/",
            out,
        ]);
        expect(copy?.args.some((arg) => arg.includes("--delete"))).toBe(false);
    });

    // Invariant 12: `-a` implies -p and -D, so an unhardened restore recreates a
    // setuid-root binary or a /dev/mem node that a compromised push source placed
    // in its own archive - and the output is deliberately forced OUTSIDE every
    // archive root, so the nosuid/nodev mount covering the archive cannot cover
    // it. Restore hardens exactly like ingest, on the copy AND the verify pass.
    it("hardens like ingest: --chmod=ug-s, --numeric-ids and no device/special files", async () => {
        fixture = await makeKit();
        await seedSnapshots(fixture);
        await fixture.kit.restore({
            target: "web",
            snapshot: "latest",
            output: join(fixture.root, "out"),
            verify: true,
        });
        expect(fixture.execCalls).toHaveLength(2);
        for (const call of fixture.execCalls) {
            expect(call.args).toContain("--chmod=ug-s");
            expect(call.args).toContain("--numeric-ids");
            expect(call.args).toContain("--no-devices");
            expect(call.args).toContain("--no-specials");
        }
    });

    it("honours preserveDevices: an opted-in target keeps device nodes but still strips setuid", async () => {
        fixture = await makeKit({
            target: { rsync: { ...makeTarget().rsync, preserveDevices: true } },
        });
        await seedSnapshots(fixture);
        await fixture.kit.restore({ target: "web", snapshot: "latest", output: join(fixture.root, "out") });
        const copy = fixture.execCalls.at(-1);
        expect(copy?.args).toContain("--chmod=ug-s");
        expect(copy?.args).not.toContain("--no-devices");
        expect(copy?.args).not.toContain("--no-specials");
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
