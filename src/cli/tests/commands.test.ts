/**
 * Command behavior against the fake engine: run (force/dry-run/failure exit),
 * list and status (aligned ANSI-free columns, --json documents), restore
 * (required arguments, success line), prune (plan printing with reasons,
 * dry-run stop, deletion-error exit), and check (versions, alias resolution,
 * jail lines + install instruction, failure exit).
 */

import { describe, expect, it } from "vitest";

import { main } from "../main.js";
import { fakeDeps, makeConfig, makeRunReport, makeTarget } from "./fakes.js";

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
        expect(h.out).toEqual([
            "web: backed up into snapshot 2026-08-10T031500Z",
            "db: skipped, not enough free disk space",
            "Done. 1 target backed up, 1 skipped.",
        ]);
    });

    it("exits 1 when any target failed", async () => {
        const h = fakeDeps();
        h.engine.runReport = {
            startedAt: "s",
            finishedAt: "f",
            targets: [makeRunReport({ status: "failed", error: "transfer exhausted", snapshot: null })],
        };
        expect(await main(["run"], h.deps)).toBe(1);
        expect(h.out).toEqual([
            "web: FAILED - transfer exhausted",
            "Done. 1 of 1 target failed - see above, or run: backupkit logs",
        ]);
    });

    it("a warning target names what is missing and the closing line says the backup is incomplete", async () => {
        const h = fakeDeps();
        h.engine.runReport = {
            startedAt: "s",
            finishedAt: "f",
            targets: [makeRunReport({ status: "warning", skippedFiles: ["/home/x/.gnupg/S.gpg-agent"] })],
        };
        expect(await main(["run"], h.deps)).toBe(0);
        expect(h.out).toEqual([
            "web: backed up into snapshot 2026-08-10T031500Z - but 1 path could not be read, so it is not in the backup: /home/x/.gnupg/S.gpg-agent",
            "Done. 1 target backed up but missing files (see above).",
        ]);
    });

    it("says so when nothing was due and wires signal handling to engine.stop", async () => {
        const h = fakeDeps();
        expect(await main(["run"], h.deps)).toBe(0);
        expect(h.out).toEqual([
            "Nothing to do - every target is already backed up for this schedule window. " +
                "Run `backupkit status` to see when they are next due, or `backupkit run --force` to back them up again now.",
        ]);
        expect(h.stops).toHaveLength(1);
        await h.stops[0]();
        expect(h.engine.calls.map((call) => call.method)).toContain("stop");
    });
});

describe("schedule preview", () => {
    // Regression in kind: `daemon` already argued that without its start/stop
    // lines a healthy daemon is indistinguishable from one that died during
    // preflight. The same holds one step in - a scheduler with nothing due for
    // six hours printed nothing for six hours, and a person watching it could
    // not tell that from a wedged one.
    it.each(["start", "daemon"])("%s prints when each target is next due", async (command) => {
        const h = fakeDeps();
        h.engine.statusRows = [
            {
                target: "web",
                lastSnapshot: null,
                nextDueAt: "2026-08-23T03:00:00.000Z",
                lastResult: "success",
                consecutiveFailures: 0,
                lockHeld: false,
                lastError: null,
                lastErrorAt: null,
            },
            {
                target: "db",
                lastSnapshot: null,
                nextDueAt: "2026-08-22T22:09:15.000Z",
                lastResult: "failed",
                consecutiveFailures: 9,
                lockHeld: false,
                lastError: "boom",
                lastErrorAt: "2026-08-22T16:09:15.000Z",
            },
        ];
        expect(await main([command], h.deps)).toBe(0);
        const out = h.out.join("\n");
        expect(out).toContain("2026-08-23T03:00:00Z");
        // A time further out than the schedule says needs its reason, or it
        // reads as a wrong schedule.
        expect(out).toContain("waiting after 9 failures");
    });

    // A disabled target has no next due time, and inventing one for it would
    // be worse than leaving it out.
    it("lists only targets that are actually scheduled", async () => {
        const h = fakeDeps();
        h.engine.statusRows = [
            {
                target: "off",
                lastSnapshot: null,
                nextDueAt: null,
                lastResult: null,
                consecutiveFailures: 0,
                lockHeld: false,
                lastError: null,
                lastErrorAt: null,
            },
        ];
        expect(await main(["start"], h.deps)).toBe(0);
        expect(h.out.join("\n")).not.toContain("off");
    });

    // The preview is a convenience; the loop is the command. A status() that
    // throws must not stop the scheduler from starting.
    it("still starts the scheduler when the preview cannot be produced", async () => {
        const h = fakeDeps();
        h.engine.statusThrows = new Error("state dir unreadable");
        expect(await main(["start"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).toContain("start");
        expect(h.err.join("\n")).toContain("could not read the current schedule");
    });
});

describe("daemon", () => {
    it("preflights, starts, and wires signals", async () => {
        const h = fakeDeps();
        expect(await main(["daemon"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).toEqual(["preflight", "status", "start"]);
        expect(h.stops).toHaveLength(1);
    });

    it("brackets the scheduler loop with a start and a stop line", async () => {
        const h = fakeDeps();
        expect(await main(["daemon"], h.deps)).toBe(0);
        expect(h.out).toEqual(["Daemon started - scheduling 1 of 1 configured target.", "Daemon stopped cleanly."]);
    });

    // The service is the ONE caller that must refuse a passphrase-protected
    // key: it has no terminal to unlock one on, and no later tick can fix it.
    // If this flag stops being passed, the daemon silently reverts to failing
    // every target on every tick instead of refusing to start.
    it("preflights in SERVICE mode", async () => {
        const h = fakeDeps();
        await main(["daemon"], h.deps);
        expect(h.engine.calls[0]).toEqual({ method: "preflight", options: { serviceMode: true } });
    });
});

describe("start", () => {
    it("preflights in LOCAL mode (encrypted keys are prompted for, not refused), then schedules", async () => {
        const h = fakeDeps();
        expect(await main(["start"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({ method: "preflight", options: undefined });
        expect(h.engine.calls.map((call) => call.method)).toEqual(["preflight", "status", "start"]);
        expect(h.stops).toHaveLength(1);
    });

    it("says the schedule only lives as long as this process", async () => {
        const h = fakeDeps();
        expect(await main(["start"], h.deps)).toBe(0);
        expect(h.out[0]).toContain("Backups run while this process stays alive");
        expect(h.out[1]).toBe("Scheduler stopped cleanly.");
    });

    it("--force backs every target up once before scheduling", async () => {
        const h = fakeDeps();
        h.engine.runReport = { startedAt: "s", finishedAt: "f", targets: [makeRunReport()] };
        expect(await main(["start", "--force"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).toEqual(["preflight", "run", "status", "start"]);
        expect(h.engine.calls[1]).toEqual({ method: "run", options: { force: true } });
        expect(h.out).toEqual([
            h.out[0],
            "Running every target once now (--force), then scheduling.",
            "web: backed up into snapshot 2026-08-10T031500Z",
            "Done. 1 target backed up.",
            "Scheduler stopped cleanly.",
        ]);
    });

    // The scheduler is the point of this command: a held lock (or any other
    // failing pass) must not leave the operator with no scheduler at all.
    it("--force still starts the scheduler when the immediate pass throws", async () => {
        const h = fakeDeps();
        h.engine.runFailure = new Error("destination lock held");
        expect(await main(["start", "--force"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).toEqual(["preflight", "run", "status", "start"]);
        expect(h.err).toEqual(["Initial --force pass failed: destination lock held"]);
    });

    it("does not run a pass without --force", async () => {
        const h = fakeDeps();
        expect(await main(["start"], h.deps)).toBe(0);
        expect(h.engine.calls.map((call) => call.method)).not.toContain("run");
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
        expect(h.out).toEqual(["No snapshots yet. Create the first one with: backupkit run"]);
    });

    // The table answers everything except the question a person opens `status`
    // to ask. `failed 9` and a next-due six hours out said something was wrong,
    // how badly, and nothing about WHAT - so the only way to find out was to go
    // and read the log.
    it("explains WHY a target is failing, under the table", async () => {
        const h = fakeDeps();
        h.engine.statusRows = [
            {
                target: "web",
                lastSnapshot: null,
                nextDueAt: "2026-08-22T22:09:15.000Z",
                lastResult: "failed",
                consecutiveFailures: 9,
                lockHeld: false,
                lastError: "the destination filesystem is FULL (rsync exit 11)",
                lastErrorAt: "2026-08-22T16:09:15.000Z",
            },
            {
                target: "db",
                lastSnapshot: "2026-08-22T030000Z",
                nextDueAt: "2026-08-23T03:00:00.000Z",
                lastResult: "success",
                consecutiveFailures: 0,
                lockHeld: false,
                lastError: null,
                lastErrorAt: null,
            },
        ];
        expect(await main(["status"], h.deps)).toBe(0);
        const out = h.out.join("\n");
        expect(out).toContain("web last failed at 2026-08-22T16:09:15Z (9 times in a row):");
        expect(out).toContain("the destination filesystem is FULL (rsync exit 11)");
        // The way out is in the message, not in the docs.
        expect(out).toContain("backupkit run --force web");
        // A healthy target gets no block - the section is for what needs doing.
        expect(out).not.toContain("db last failed");
    });

    it("says nothing extra when every target is healthy", async () => {
        const h = fakeDeps();
        h.engine.statusRows = [
            {
                target: "web",
                lastSnapshot: "2026-08-22T030000Z",
                nextDueAt: "2026-08-23T03:00:00.000Z",
                lastResult: "success",
                consecutiveFailures: 0,
                lockHeld: false,
                lastError: null,
                lastErrorAt: null,
            },
        ];
        expect(await main(["status"], h.deps)).toBe(0);
        expect(h.out.filter((line) => line.trim() !== "")).toHaveLength(2);
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
                lastError: null,
                lastErrorAt: null,
            },
            { target: "db", lastSnapshot: null, nextDueAt: null, lastResult: null, consecutiveFailures: 3, lockHeld: true, lastError: null, lastErrorAt: null },
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
            { target: "web", lastSnapshot: null, nextDueAt: null, lastResult: null, consecutiveFailures: 0, lockHeld: false, lastError: null, lastErrorAt: null },
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
        h.engine.restoreReport = { target: "web", snapshot: "2026-08-10T031500Z", output: "/tmp/out", verified: true, plan: null };
        expect(await main(["restore", "web", "latest", "--output", "/tmp/out", "--verify"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({
            method: "restore",
            options: { target: "web", snapshot: "latest", output: "/tmp/out", verify: true, dryRun: false },
        });
        expect(h.out).toEqual(["Restored snapshot 2026-08-10T031500Z of web to /tmp/out (contents verified)"]);
    });

    it("--dry-run reports the projected copy and says nothing was written", async () => {
        const h = fakeDeps();
        h.engine.restoreReport = {
            target: "web",
            snapshot: "2026-08-10T031500Z",
            output: "/tmp/out",
            verified: false,
            plan: { files: 1, bytes: 2048 },
        };
        expect(await main(["restore", "web", "latest", "--output", "/tmp/out", "--dry-run"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({
            method: "restore",
            options: { target: "web", snapshot: "latest", output: "/tmp/out", verify: false, dryRun: true },
        });
        expect(h.out).toEqual([
            "Would restore snapshot 2026-08-10T031500Z of web to /tmp/out: 1 file, 2.0 KiB",
            "Dry run - nothing was written. Drop --dry-run to restore.",
        ]);
    });

    it("--dry-run with an unparsable stats block still reports the plan, without a size", async () => {
        const h = fakeDeps();
        expect(await main(["restore", "web", "latest", "--output", "/tmp/out", "--dry-run"], h.deps)).toBe(0);
        expect(h.out[0]).toBe(
            "Would restore snapshot 2026-08-10T031500Z of web to /tmp/out: size unknown (rsync printed no stats)",
        );
    });

    it("refuses --dry-run with --verify instead of silently ignoring one", async () => {
        const h = fakeDeps();
        expect(await main(["restore", "web", "latest", "--output", "/tmp/out", "--dry-run", "--verify"], h.deps)).toBe(
            64,
        );
        expect(h.engine.calls).toEqual([]);
        expect(h.err.join("\n")).toContain("nothing to verify");
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
        expect(h.engine.calls[0]).toEqual({
            method: "prune",
            options: { targets: undefined, dryRun: true, force: false },
        });
        expect(h.out).toEqual([
            "Target web:",
            "    keep   2026-08-10T031500Z  (newest, last)",
            "    prune  2026-08-01T031500Z",
            "Dry run - nothing was deleted. Drop --dry-run to apply this plan.",
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
        expect(h.err[0]).toContain("Error: could not prune web: 2026-08-01T031500Z: permission denied");
    });
});

describe("unlock", () => {
    it("reports each outcome and passes --force through", async () => {
        const h = fakeDeps();
        h.engine.unlockRows = [
            { target: "web", status: "none", detail: "" },
            { target: "db", status: "removed", detail: "created 2026-08-10T02:15:02Z, past the 24h TTL" },
        ];
        expect(await main(["unlock", "--force"], h.deps)).toBe(0);
        expect(h.engine.calls[0]).toEqual({ method: "unlock", options: { targets: undefined, force: true } });
        expect(h.out).toEqual([
            "web: no lock held",
            "db: lock cleared (created 2026-08-10T02:15:02Z, past the 24h TTL)",
        ]);
        expect(h.err).toEqual([]);
    });

    it("exits 1 naming the holder and --force when the lock is live", async () => {
        const h = fakeDeps();
        h.engine.unlockRows = [{ target: "web", status: "held", detail: "pid 4242 on mbprodaan" }];
        expect(await main(["unlock"], h.deps)).toBe(1);
        expect(h.engine.calls[0]).toEqual({ method: "unlock", options: { targets: undefined, force: false } });
        expect(h.err[0]).toBe(
            "Error: web is locked by a live backupkit (pid 4242 on mbprodaan). " +
                "Stop it, or pass --force to clear the lock anyway.",
        );
    });

    it("exits 1 when a target could not be reached", async () => {
        const h = fakeDeps();
        h.engine.unlockRows = [{ target: "web", status: "failed", detail: "ssh: connection refused" }];
        expect(await main(["unlock", "web"], h.deps)).toBe(1);
        expect(h.err[0]).toBe("Error: could not unlock web: ssh: connection refused");
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
            encryptedKeys: [],
            errors: [],
        };
        expect(await main(["check"], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(text).toContain("Local rsync: /opt/homebrew/bin/rsync 3.2.7");
        expect(text).toContain("Remote example (explicit): reachable, rsync 3.2.7");
        expect(text).toContain("Remote myserver (alias, backup@10.0.0.9:2222): reachable, rsync 3.4.1");
        expect(text).toContain('restrict,command="/usr/local/bin/backupkit-remote /srv/backups" ssh-ed25519 AAAA');
        expect(text).toContain("# target push-www via remote example");
        expect(text).toContain("/usr/local/bin/backupkit-remote");
        expect(text).toContain("Push jail (recommended, optional)");
        expect(text).toContain('set "jail": false');
        expect(text).toContain("Check passed - backupkit is ready.");
    });

    it("prints a note for each jail-disabled push target instead of a jail line", async () => {
        const target = makeTarget({
            name: "push-www",
            direction: "push",
            jail: false,
            dst: { kind: "remote", remote: { kind: "alias", restrictedShell: false, name: "srv", alias: "myserver" }, path: "/srv/backups" },
            destination: "/srv/backups",
        });
        const h = fakeDeps({ config: makeConfig({ configPath: "/etc/backupkit/config.jsonc", stateDir: "/var/lib/backupkit", targets: [target] }) });
        expect(await main(["check"], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(text).not.toContain("Push jail (recommended, optional)");
        expect(text).toContain(
            'Warning: push target push-www has the jail disabled ("jail": false) - its key gets whatever access the server grants it.',
        );
    });

    // The closing lines are the operator's next command, so they must load the
    // config this check just blessed. Only /etc/backupkit is found without
    // --config, and only by root - so a checked ~/.backupkit config that
    // suggested a bare `sudo backupkit service install` sent the operator to
    // install a service over root's /etc copy, or over nothing at all.
    describe("what to do next", () => {
        it("names the checked config on both suggestions when it is not the system one", async () => {
            const h = fakeDeps({
                config: makeConfig({
                    configPath: "/Users/dan/.backupkit/config.jsonc",
                    stateDir: "/tmp/state",
                    targets: [makeTarget()],
                }),
            });
            expect(await main(["check"], h.deps)).toBe(0);
            const text = h.out.join("\n");
            expect(text).toContain("backupkit start --config /Users/dan/.backupkit/config.jsonc");
            expect(text).toContain("sudo backupkit service install --config /Users/dan/.backupkit/config.jsonc");
        });

        it("omits --config for a config in /etc/backupkit, which every identity finds", async () => {
            const h = fakeDeps();
            expect(await main(["check"], h.deps)).toBe(0);
            const text = h.out.join("\n");
            expect(h.out).toContain("    in this session:   backupkit start");
            expect(h.out).toContain("    as a root service: sudo backupkit service install");
            expect(text).not.toContain("--config");
        });

        it("offers only `start` when a key is passphrase-protected, and says why", async () => {
            const h = fakeDeps();
            h.engine.checkReport = { ...h.engine.checkReport, encryptedKeys: [{ remote: "box", key: "/keys/id_ed25519" }] };
            expect(await main(["check"], h.deps)).toBe(0);
            const text = h.out.join("\n");
            expect(text).toContain("backupkit start");
            expect(text).toContain("as a root service: NOT POSSIBLE");
            expect(text).toContain('/keys/id_ed25519 (remote "box")');
            // Still a PASS: an encrypted key is a valid config, not an error.
            expect(text).toContain("Check passed");
            expect(h.err).toEqual([]);
        });

        it("warns that a root service resolves ssh_config aliases against ROOT's ssh_config", async () => {
            const base = makeConfig({ configPath: "/etc/backupkit/config.jsonc", stateDir: "/var/lib/backupkit", targets: [makeTarget()] });
            const h = fakeDeps({
                config: { ...base, remotes: { box: { kind: "alias", restrictedShell: false, name: "box", alias: "box" } } },
            });
            expect(await main(["check"], h.deps)).toBe(0);
            expect(h.out.join("\n")).toContain("root's ssh_config");
        });

        it("says nothing about aliases for an all-explicit config", async () => {
            const h = fakeDeps();
            expect(await main(["check"], h.deps)).toBe(0);
            expect(h.out.join("\n")).not.toContain("ssh_config");
        });
    });

    it("exits 1 and surfaces every error when a probe failed", async () => {
        const h = fakeDeps();
        h.engine.checkReport = {
            ok: false,
            localRsync: null,
            sshOk: false,
            remotes: [{ remote: "example", kind: "explicit", reachable: false, rsyncVersion: null, resolved: null, error: "host unreachable" }],
            jailLines: [],
            encryptedKeys: [],
            errors: ["rsync too old", "remote example: host unreachable"],
        };
        expect(await main(["check"], h.deps)).toBe(1);
        expect(h.out.join("\n")).toContain("Check FAILED - 2 problems above need fixing");
        expect(h.err).toEqual(["Error: rsync too old", "Error: remote example: host unreachable"]);
    });
});
