/**
 * Unit-file string-generation tables (spec sections 4 and 6): the systemd
 * unit carries the exact restart stanzas and the FULL hardening block, quotes
 * ExecStart correctly, and emits ReadOnlyPaths=/root/.ssh only when an alias
 * remote is configured; the launchd plist is well-formed with crash-only
 * KeepAlive; the newsyslog line is exact.
 */

import { describe, expect, it } from "vitest";

import {
    hasAliasRemote,
    launchdPlist,
    MACOS_LOG_FILES,
    NEWSYSLOG_CONF,
    readWritePathsOf,
    systemdQuote,
    systemdUnit,
} from "../internal/service/units.js";
import { makeConfig, makeTarget } from "./fakes.js";

/** Baseline systemd options for the tables. */
const base = {
    nodeBin: "/usr/bin/node",
    cliPath: "/opt/backupkit/dist/cli/main.js",
    configPath: "/etc/backupkit/config.jsonc",
    readWritePaths: ["/data/archive", "/var/lib/backupkit", "/run/backupkit", "/etc/backupkit"],
    aliasRemote: false,
};

describe("systemd unit", () => {
    const unit = systemdUnit(base);

    it.each([
        ["Restart=on-failure"],
        ["RestartSec=15"],
        ["StartLimitIntervalSec=0"],
        ["Type=simple"],
        ["User=root"],
        ["KillSignal=SIGTERM"],
        ["TimeoutStopSec=30"],
        ["After=network-online.target"],
        ["Wants=network-online.target"],
        ["NoNewPrivileges=true"],
        ["PrivateTmp=true"],
        ["ProtectSystem=strict"],
        ['ReadWritePaths="/data/archive" "/var/lib/backupkit" "/run/backupkit" "/etc/backupkit"'],
        ["RestrictSUIDSGID=true"],
        ["PrivateDevices=true"],
        ["ProtectHome=read-only"],
        ["ProtectKernelModules=true"],
        ["ProtectControlGroups=true"],
        ["RestrictNamespaces=true"],
        ["LockPersonality=true"],
        ["SystemCallFilter=@system-service"],
        ["WantedBy=multi-user.target"],
    ])("contains the line %s", (line) => {
        expect(unit.split("\n")).toContain(line);
    });

    it("quotes every ExecStart token", () => {
        expect(unit).toContain(
            'ExecStart="/usr/bin/node" "/opt/backupkit/dist/cli/main.js" "daemon" "--config" "/etc/backupkit/config.jsonc"',
        );
    });

    it("escapes quotes, backslashes, and percent signs in ExecStart tokens", () => {
        expect(systemdQuote('/pa"th')).toBe('"/pa\\"th"');
        expect(systemdQuote("/pa\\th")).toBe('"/pa\\\\th"');
        expect(systemdQuote("/pa%th")).toBe('"/pa%%th"');
    });

    it("quotes each ReadWritePaths entry so a space-containing path stays one systemd list item", () => {
        const spaced = systemdUnit({ ...base, readWritePaths: ["/Volumes/My Backups", "/var/lib/backupkit"] });
        expect(spaced.split("\n")).toContain('ReadWritePaths="/Volumes/My Backups" "/var/lib/backupkit"');
    });

    it("emits ReadOnlyPaths=/root/.ssh only when an alias remote is configured", () => {
        expect(unit).not.toContain("ReadOnlyPaths");
        const aliasUnit = systemdUnit({ ...base, aliasRemote: true });
        expect(aliasUnit.split("\n")).toContain("ReadOnlyPaths=/root/.ssh");
        // The grant sits inside [Service], before the [Install] section.
        expect(aliasUnit.indexOf("ReadOnlyPaths")).toBeLessThan(aliasUnit.indexOf("[Install]"));
    });
});

describe("readWritePathsOf / hasAliasRemote", () => {
    it("collects local destination roots, stateDir, runtime dir, and the config dir", () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [
                makeTarget(),
                makeTarget({ name: "push", dst: { kind: "remote", remote: { kind: "alias", name: "m", alias: "m" }, path: "/jail" } }),
            ],
        });
        expect(readWritePathsOf(config)).toEqual(["/data/archive", "/var/lib/backupkit", "/run/backupkit", "/etc/backupkit"]);
    });

    it("detects alias remotes from the resolved remotes record", () => {
        const explicit = makeConfig({ configPath: "/c/config.jsonc", stateDir: "/s", targets: [makeTarget()] });
        explicit.remotes = {
            r: { kind: "explicit", name: "r", host: "h", user: "u", port: 22, identityFile: "/k", passphrase: null, knownHostsFile: "/kh" },
        };
        expect(hasAliasRemote(explicit)).toBe(false);
        explicit.remotes.a = { kind: "alias", name: "a", alias: "a" };
        expect(hasAliasRemote(explicit)).toBe(true);
    });
});

describe("launchd plist", () => {
    const plist = launchdPlist({ nodeBin: "/usr/local/bin/node", cliPath: "/lib/backupkit/main.js", configPath: "/etc/backupkit/config.jsonc" });

    it.each([
        ["<string>com.daanvandenbergh.backupkit</string>"],
        ["<string>/usr/local/bin/node</string>"],
        ["<string>/lib/backupkit/main.js</string>"],
        ["<string>daemon</string>"],
        ["<string>--config</string>"],
        ["<string>/etc/backupkit/config.jsonc</string>"],
        ["<key>RunAtLoad</key>"],
        ["<key>KeepAlive</key>"],
        ["<key>SuccessfulExit</key>"],
        ["<false/>"],
        ["<key>ThrottleInterval</key>"],
        ["<integer>15</integer>"],
        ["<string>/var/log/backupkit/backupkit.log</string>"],
        ["<string>/var/log/backupkit/backupkit.err.log</string>"],
    ])("contains %s", (fragment) => {
        expect(plist).toContain(fragment);
    });

    it("is well-formed enough to balance its dict/array tags and close the plist", () => {
        expect(plist.split("<dict>").length).toBe(plist.split("</dict>").length);
        expect(plist.split("<array>").length).toBe(plist.split("</array>").length);
        expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
        expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    });

    it("escapes XML metacharacters in paths", () => {
        const hostile = launchdPlist({ nodeBin: "/node", cliPath: "/a<b>&c.js", configPath: "/c" });
        expect(hostile).toContain("<string>/a&lt;b&gt;&amp;c.js</string>");
    });
});

describe("newsyslog conf", () => {
    it("is the exact rotation line", () => {
        expect(NEWSYSLOG_CONF).toBe("/var/log/backupkit/*.log  root:wheel  640  5  10240  *  J\n");
    });

    it("names the two log files logs tails", () => {
        expect(MACOS_LOG_FILES).toEqual(["/var/log/backupkit/backupkit.log", "/var/log/backupkit/backupkit.err.log"]);
    });
});
