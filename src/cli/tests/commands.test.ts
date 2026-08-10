/**
 * Command behavior against the fake engine: run (force/dry-run/failure exit),
 * list and status (aligned ANSI-free columns, --json documents), restore
 * (required arguments, success line), prune (plan printing with reasons,
 * dry-run stop, deletion-error exit), and check (versions, alias resolution,
 * jail lines + install instruction, failure exit).
 */

import { describe, expect, it } from "vitest";

import { main } from "../main.js";
import { fakeDeps, makeRunReport } from "./fakes.js";

describe("run", () => {
    it("passes force/dry-run/targets to the engine and reports per-target lines", async () => {
        const h = fakeDeps();
        h.engine.runReport = {
            startedAt: "s",
            finishedAt: "f",
            targets: [makeRunReport(), makeRunReport({ target: "db", status: "skipped", reason: "disk-low", snapshot: null })],
        };
        expect(await main(["run", "web", "--force", "--dry-run"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({ method: "run", options: { targets: ["web"], force: true, dryRun: true } });
        expect(h.out).toEqual(["web: success snapshot=2026-08-10T031500Z", "db: skipped reason=disk-low"]);
    });

    it("exits 1 when any target failed", async () => {
        const h = fakeDeps();
        h.engine.runReport = {
            startedAt: "s",
            finishedAt: "f",
            targets: [makeRunReport({ status: "failed", error: "transfer exhausted", snapshot: null })],
        };
        expect(await main(["run"], h.deps)).toBe(1);
        expect(h.out[0]).toBe("web: failed error=transfer exhausted");
    });

    it("says so when nothing was due and wires signal handling to engine.stop", async () => {
        const h = fakeDeps();
        expect(await main(["run"], h.deps)).toBe(0);
        expect(h.out).toEqual(["no targets were due - pass --force to run anyway"]);
        expect(h.stops).toHaveLength(1);
        await h.stops[0]();
        expect(h.engine.calls.map((call) => call.method)).toContain("stop");
    });
});

describe("daemon", () => {
    it("preflights, starts, and wires signals", async () => {
        const h = fakeDeps();
        expect(await main(["daemon"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).toEqual(["preflight", "start"]);
        expect(h.stops).toHaveLength(1);
    });
});

describe("list", () => {
    it("prints aligned ANSI-free columns", async () => {
        const h = fakeDeps();
        h.engine.snapshots = [
            { target: "web", name: "2026-08-10T031500Z", createdAt: new Date("2026-08-10T03:15:00Z") },
            { target: "database-long-name", name: "2026-08-09T031500Z", createdAt: new Date("2026-08-09T03:15:00Z") },
        ];
        expect(await main(["list"], h.deps)).toBe(0);
        expect(h.out[0]).toMatch(/^TARGET\s+SNAPSHOT\s+CREATED \(UTC\)$/);
        expect(h.out[1]).toContain("web");
        // Columns align: the snapshot column starts at the same index in every row.
        const start = h.out[1].indexOf("2026-08-10T031500Z");
        expect(h.out[2].indexOf("2026-08-09T031500Z")).toBe(start);
        expect(h.out.join("\n")).not.toContain("[");
    });

    it("prints the no-backups hint on an empty listing", async () => {
        const h = fakeDeps();
        expect(await main(["list"], h.deps)).toBe(0);
        expect(h.out).toEqual(["no backups yet - run: backupkit run"]);
    });

    it("emits one JSON document with --json", async () => {
        const h = fakeDeps();
        h.engine.snapshots = [{ target: "web", name: "2026-08-10T031500Z", createdAt: new Date("2026-08-10T03:15:00Z") }];
        expect(await main(["list", "--json"], h.deps)).toBe(0);
        const parsed = JSON.parse(h.out.join("\n")) as { target: string; name: string }[];
        expect(parsed).toHaveLength(1);
        expect(parsed[0].name).toBe("2026-08-10T031500Z");
    });
});

describe("status", () => {
    it("prints aligned rows with placeholder dashes", async () => {
        const h = fakeDeps();
        h.engine.statusRows = [
            {
                target: "web",
                lastSnapshot: "2026-08-10T031500Z",
                nextDueAt: "2026-08-11T00:00:00.000Z",
                lastResult: "success",
                consecutiveFailures: 0,
                lockHeld: false,
            },
            { target: "db", lastSnapshot: null, nextDueAt: null, lastResult: null, consecutiveFailures: 3, lockHeld: true },
        ];
        expect(await main(["status"], h.deps)).toBe(0);
        expect(h.out[0]).toMatch(/^TARGET\s+LAST SNAPSHOT\s+NEXT DUE\s+LAST RESULT\s+FAILS\s+LOCK$/);
        expect(h.out[2]).toContain("db");
        expect(h.out[2]).toContain("held");
        expect(h.out[2]).toContain("-");
        expect(h.out.join("\n")).not.toContain("[");
    });

    it("emits one JSON document with --json", async () => {
        const h = fakeDeps();
        h.engine.statusRows = [
            { target: "web", lastSnapshot: null, nextDueAt: null, lastResult: null, consecutiveFailures: 0, lockHeld: false },
        ];
        expect(await main(["status", "--json"], h.deps)).toBe(0);
        expect(JSON.parse(h.out.join("\n"))).toEqual(h.engine.statusRows);
    });
});

describe("restore", () => {
    it("requires TARGET, SNAPSHOT, and --output", async () => {
        const missingArgs = fakeDeps();
        expect(await main(["restore", "web", "--output", "/tmp/x"], missingArgs.deps)).toBe(64);
        expect(missingArgs.err[0]).toContain("TARGET and SNAPSHOT");

        const missingOutput = fakeDeps();
        expect(await main(["restore", "web", "latest"], missingOutput.deps)).toBe(64);
        expect(missingOutput.err[0]).toContain("--output");
    });

    it("calls the engine and prints the restored line (verified marker included)", async () => {
        const h = fakeDeps();
        h.engine.restoreReport = { target: "web", snapshot: "2026-08-10T031500Z", output: "/tmp/out", verified: true };
        expect(await main(["restore", "web", "latest", "--output", "/tmp/out", "--verify"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({
            method: "restore",
            options: { target: "web", snapshot: "latest", output: "/tmp/out", verify: true },
        });
        expect(h.out).toEqual(["restored web/2026-08-10T031500Z -> /tmp/out (verified)"]);
    });
});

describe("prune", () => {
    it("prints the plan with keep reasons; --dry-run stops after planning", async () => {
        const h = fakeDeps();
        h.engine.pruneReport = {
            targets: [
                {
                    target: "web",
                    plan: {
                        keep: [{ name: "2026-08-10T031500Z", reasons: ["newest", "last"] }],
                        prune: ["2026-08-01T031500Z"],
                    },
                    executed: false,
                    errors: [],
                },
            ],
        };
        expect(await main(["prune", "--dry-run"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({ method: "prune", options: { targets: undefined, dryRun: true } });
        expect(h.out).toEqual([
            "target web:",
            "    keep  2026-08-10T031500Z  (newest, last)",
            "    prune 2026-08-01T031500Z",
            "dry-run - nothing was deleted",
        ]);
    });

    it("exits 1 when a deletion failed", async () => {
        const h = fakeDeps();
        h.engine.pruneReport = {
            targets: [
                {
                    target: "web",
                    plan: { keep: [{ name: "2026-08-10T031500Z", reasons: ["newest"] }], prune: ["2026-08-01T031500Z"] },
                    executed: true,
                    errors: ["2026-08-01T031500Z: permission denied"],
                },
            ],
        };
        expect(await main(["prune"], h.deps)).toBe(1);
        expect(h.err[0]).toContain("error snapshot-store: web: 2026-08-01T031500Z: permission denied");
    });
});

describe("check", () => {
    it("prints versions, alias resolution, and jail lines with the install instruction", async () => {
        const h = fakeDeps();
        h.engine.checkReport = {
            ok: true,
            localRsync: { bin: "/opt/homebrew/bin/rsync", version: "3.2.7" },
            sshOk: true,
            remotes: [
                { remote: "example", kind: "explicit", reachable: true, rsyncVersion: "3.2.7", resolved: null, error: null },
                {
                    remote: "myserver",
                    kind: "alias",
                    reachable: true,
                    rsyncVersion: "3.4.1",
                    resolved: { hostname: "10.0.0.9", user: "backup", port: "2222" },
                    error: null,
                },
            ],
            jailLines: [
                {
                    target: "push-www",
                    remote: "example",
                    line: 'restrict,command="/usr/local/bin/backupkit-remote /srv/backups" ssh-ed25519 AAAA',
                },
            ],
            errors: [],
        };
        expect(await main(["check"], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(text).toContain("local rsync: /opt/homebrew/bin/rsync 3.2.7");
        expect(text).toContain("remote example [explicit]: reachable, rsync 3.2.7");
        expect(text).toContain("remote myserver [alias -> backup@10.0.0.9:2222]: reachable, rsync 3.4.1");
        expect(text).toContain('restrict,command="/usr/local/bin/backupkit-remote /srv/backups" ssh-ed25519 AAAA');
        expect(text).toContain("# target push-www via remote example");
        expect(text).toContain("/usr/local/bin/backupkit-remote");
        expect(text).toContain("check ok");
    });

    it("exits 1 and surfaces every error when a probe failed", async () => {
        const h = fakeDeps();
        h.engine.checkReport = {
            ok: false,
            localRsync: null,
            sshOk: false,
            remotes: [{ remote: "example", kind: "explicit", reachable: false, rsyncVersion: null, resolved: null, error: "host unreachable" }],
            jailLines: [],
            errors: ["rsync too old", "remote example: host unreachable"],
        };
        expect(await main(["check"], h.deps)).toBe(1);
        expect(h.out.join("\n")).toContain("check FAILED");
        expect(h.err).toEqual(["check: rsync too old", "check: remote example: host unreachable"]);
    });
});
