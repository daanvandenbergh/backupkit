/**
 * Lifecycle-verb tables against fake systemctl/launchctl (no real process is
 * ever spawned; the fake exec records argv): root refusal, install writing
 * the unit + reload/enable, idempotent start/stop messages, not-installed
 * exit 1 naming `service install`, macOS bootstrap/bootout/kickstart forms
 * and newsyslog handling, and `service status` merging the unit header with
 * the engine's rows.
 */

import { describe, expect, it } from "vitest";

import { main } from "../main.js";
import {
    LAUNCHD_PLIST_PATH,
    NEWSYSLOG_CONF_PATH,
    SYSTEMD_UNIT_PATH,
} from "../internal/service/units.js";
import { fakeDeps, makeConfig, makeExecResult, makeTarget } from "./fakes.js";

describe("verb parsing and root requirement", () => {
    it("rejects a missing or unknown verb with exit 64 listing the verbs", async () => {
        for (const argv of [["service"], ["service", "explode"], ["service", "start", "extra"]]) {
            const h = fakeDeps();
            expect(await main(argv, h.deps)).toBe(64);
            expect(h.err[0]).toContain("install, uninstall, start, stop, restart, status");
        }
    });

    it.each([["install"], ["uninstall"], ["start"], ["stop"], ["restart"]])(
        "%s refuses without root, naming the sudo command",
        async (verb) => {
            const h = fakeDeps({ euid: 501 });
            expect(await main(["service", verb], h.deps)).toBe(1);
            expect(h.err).toEqual([`service ${verb} requires root - run: sudo backupkit service ${verb}`]);
            expect(h.execCalls).toEqual([]);
        },
    );

    it("status does not require root", async () => {
        const h = fakeDeps({ euid: 501 });
        expect(await main(["service", "status"], h.deps)).toBe(0);
        expect(h.out[0]).toBe("service: not installed");
    });
});

describe("Linux lifecycle", () => {
    it("install writes the unit, reloads, enables, and points at service start", async () => {
        const h = fakeDeps();
        expect(await main(["service", "install"], h.deps)).toBe(0);
        const unit = h.fileMap.get(SYSTEMD_UNIT_PATH);
        expect(unit).toContain("Restart=on-failure");
        expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/backupkit/dist/cli/main.js" "daemon" "--config" "/etc/backupkit/config.jsonc"');
        expect(h.execCalls.map((call) => [call.bin, ...call.args])).toEqual([
            ["systemctl", "daemon-reload"],
            ["systemctl", "enable", "backupkit"],
        ]);
        expect(h.execCalls[0].options?.stdio).toBe("inherit");
        expect(h.out).toEqual(["installed - start it: backupkit service start"]);
        expect(h.fileMap.has(NEWSYSLOG_CONF_PATH)).toBe(false);
        // No logging.file in the default fixture: nothing extra to create.
        expect(h.mkdirs).toEqual([]);
    });

    // Without both halves the daemon crash-loops: ProtectSystem=strict denies
    // the write, and the very first log line throws out of preflight.
    it("install grants and creates the logging.file directory", async () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [makeTarget()],
        });
        config.logging = { level: "info", file: "/var/log/backupkit/backupkit.log" };
        const h = fakeDeps({ config });
        expect(await main(["service", "install"], h.deps)).toBe(0);
        expect(h.mkdirs).toEqual([{ path: "/var/log/backupkit", mode: 0o750 }]);
        expect(h.fileMap.get(SYSTEMD_UNIT_PATH)).toContain('"/var/log/backupkit"');
    });

    it("install is idempotent: a second install rewrites and reloads again", async () => {
        const h = fakeDeps({ files: { [SYSTEMD_UNIT_PATH]: "old" } });
        expect(await main(["service", "install"], h.deps)).toBe(0);
        expect(h.fileMap.get(SYSTEMD_UNIT_PATH)).toContain("[Unit]");
    });

    it.each([
        ["start", "inactive", ["systemctl", "start", "backupkit"], "started"],
        ["stop", "active", ["systemctl", "stop", "backupkit"], "stopped"],
        ["restart", "active", ["systemctl", "restart", "backupkit"], "restarted"],
    ])("%s drives systemctl and reports", async (verb, activeState, expectedArgv, message) => {
        const h = fakeDeps({
            files: { [SYSTEMD_UNIT_PATH]: "unit" },
            execResults: [
                {
                    match: (bin, args) => bin === "systemctl" && args[0] === "is-active",
                    result: makeExecResult({ stdout: activeState + "\n", exitCode: activeState === "active" ? 0 : 3 }),
                },
            ],
        });
        expect(await main(["service", verb], h.deps)).toBe(0);
        expect(h.execCalls.map((call) => [call.bin, ...call.args])).toContainEqual(expectedArgv);
        expect(h.out).toEqual([message]);
    });

    it("start on a running unit and stop on a stopped one are idempotent successes", async () => {
        const running = fakeDeps({
            files: { [SYSTEMD_UNIT_PATH]: "unit" },
            execResults: [{ match: (bin, args) => args[0] === "is-active", result: makeExecResult({ stdout: "active\n" }) }],
        });
        expect(await main(["service", "start"], running.deps)).toBe(0);
        expect(running.out).toEqual(["already running"]);
        expect(running.execCalls.map((call) => call.args[0])).not.toContain("start");

        const stopped = fakeDeps({
            files: { [SYSTEMD_UNIT_PATH]: "unit" },
            execResults: [{ match: (bin, args) => args[0] === "is-active", result: makeExecResult({ stdout: "inactive\n", exitCode: 3 }) }],
        });
        expect(await main(["service", "stop"], stopped.deps)).toBe(0);
        expect(stopped.out).toEqual(["already stopped"]);
    });

    it.each([["start"], ["stop"], ["restart"]])("%s without an installed unit exits 1 naming service install", async (verb) => {
        const h = fakeDeps();
        expect(await main(["service", verb], h.deps)).toBe(1);
        expect(h.err).toEqual(["service not installed - run: backupkit service install"]);
        expect(h.execCalls).toEqual([]);
    });

    it("uninstall stops, disables, removes the unit, and reloads; a second uninstall is a no-op success", async () => {
        const h = fakeDeps({
            files: { [SYSTEMD_UNIT_PATH]: "unit" },
            execResults: [{ match: (bin, args) => args[0] === "is-active", result: makeExecResult({ stdout: "active\n" }) }],
        });
        expect(await main(["service", "uninstall"], h.deps)).toBe(0);
        expect(h.fileMap.has(SYSTEMD_UNIT_PATH)).toBe(false);
        const argv = h.execCalls.map((call) => [call.bin, ...call.args]);
        expect(argv).toContainEqual(["systemctl", "stop", "backupkit"]);
        expect(argv).toContainEqual(["systemctl", "disable", "backupkit"]);
        expect(argv).toContainEqual(["systemctl", "daemon-reload"]);
        expect(h.out).toEqual(["uninstalled"]);

        const again = fakeDeps();
        expect(await main(["service", "uninstall"], again.deps)).toBe(0);
        expect(again.out).toEqual(["already uninstalled"]);
        expect(again.execCalls).toEqual([]);
    });

    it("service status merges the unit header with the engine's rows", async () => {
        const h = fakeDeps({
            files: { [SYSTEMD_UNIT_PATH]: "unit" },
            execResults: [
                { match: (bin, args) => args[0] === "is-active", result: makeExecResult({ stdout: "active\n" }) },
                { match: (bin, args) => args[0] === "show", result: makeExecResult({ stdout: "1234\n" }) },
            ],
        });
        h.engine.statusRows = [
            { target: "web", lastSnapshot: null, nextDueAt: null, lastResult: null, consecutiveFailures: 0, lockHeld: false },
        ];
        expect(await main(["service", "status"], h.deps)).toBe(0);
        expect(h.out[0]).toBe("service: active (pid 1234)");
        expect(h.out[1]).toContain("TARGET");
        expect(h.out[2]).toContain("web");
    });
});

describe("macOS lifecycle", () => {
    /** launchctl print succeeds (job loaded) with the given stdout. */
    const loaded = (stdout = "state = running\n\tpid = 4321\n") => ({
        match: (bin: string, args: string[]) => bin === "launchctl" && args[0] === "print",
        result: makeExecResult({ stdout }),
    });

    /** launchctl print fails (job not loaded). */
    const notLoaded = () => ({
        match: (bin: string, args: string[]) => bin === "launchctl" && args[0] === "print",
        result: makeExecResult({ exitCode: 113, stderr: "Could not find service" }),
    });

    it("install writes the plist and newsyslog conf and does not touch launchctl", async () => {
        const h = fakeDeps({ platform: "darwin" });
        expect(await main(["service", "install"], h.deps)).toBe(0);
        expect(h.fileMap.get(LAUNCHD_PLIST_PATH)).toContain("<key>KeepAlive</key>");
        expect(h.fileMap.get(NEWSYSLOG_CONF_PATH)).toBe("/var/log/backupkit/*.log  root:wheel  640  5  10240  *  J\n");
        expect(h.execCalls).toEqual([]);
        expect(h.out).toEqual(["installed - start it: backupkit service start"]);
    });

    it("start bootstraps when not loaded and is idempotent when loaded", async () => {
        const cold = fakeDeps({ platform: "darwin", files: { [LAUNCHD_PLIST_PATH]: "plist" }, execResults: [notLoaded()] });
        expect(await main(["service", "start"], cold.deps)).toBe(0);
        expect(cold.execCalls.map((call) => [call.bin, ...call.args])).toContainEqual([
            "launchctl",
            "bootstrap",
            "system",
            LAUNCHD_PLIST_PATH,
        ]);
        expect(cold.out).toEqual(["started"]);

        const warm = fakeDeps({ platform: "darwin", files: { [LAUNCHD_PLIST_PATH]: "plist" }, execResults: [loaded()] });
        expect(await main(["service", "start"], warm.deps)).toBe(0);
        expect(warm.out).toEqual(["already running"]);
    });

    it("stop boots out and restart kickstarts", async () => {
        const stop = fakeDeps({ platform: "darwin", files: { [LAUNCHD_PLIST_PATH]: "plist" }, execResults: [loaded()] });
        expect(await main(["service", "stop"], stop.deps)).toBe(0);
        expect(stop.execCalls.map((call) => [call.bin, ...call.args])).toContainEqual([
            "launchctl",
            "bootout",
            "system/com.daanvandenbergh.backupkit",
        ]);

        const restart = fakeDeps({ platform: "darwin", files: { [LAUNCHD_PLIST_PATH]: "plist" }, execResults: [loaded()] });
        expect(await main(["service", "restart"], restart.deps)).toBe(0);
        expect(restart.execCalls.map((call) => [call.bin, ...call.args])).toContainEqual([
            "launchctl",
            "kickstart",
            "-k",
            "system/com.daanvandenbergh.backupkit",
        ]);
    });

    it("uninstall removes the plist and the newsyslog conf", async () => {
        const h = fakeDeps({
            platform: "darwin",
            files: { [LAUNCHD_PLIST_PATH]: "plist", [NEWSYSLOG_CONF_PATH]: "conf" },
            execResults: [notLoaded()],
        });
        expect(await main(["service", "uninstall"], h.deps)).toBe(0);
        expect(h.fileMap.has(LAUNCHD_PLIST_PATH)).toBe(false);
        expect(h.fileMap.has(NEWSYSLOG_CONF_PATH)).toBe(false);
    });

    it("status parses the launchd pid", async () => {
        const h = fakeDeps({ platform: "darwin", files: { [LAUNCHD_PLIST_PATH]: "plist" }, execResults: [loaded()] });
        expect(await main(["service", "status"], h.deps)).toBe(0);
        expect(h.out[0]).toBe("service: active (pid 4321)");
    });
});
