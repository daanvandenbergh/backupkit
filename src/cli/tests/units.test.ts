/**
 * Unit-file string-generation tables (spec sections 4 and 6): the systemd
 * unit carries the exact restart stanzas and the FULL hardening block, quotes
 * ExecStart correctly, and emits ReadOnlyPaths=/root/.ssh only when an alias
 * remote is configured; the launchd plist is well-formed with crash-only
 * KeepAlive; the newsyslog line is exact.
 */

import { describe, expect, it } from "vitest";

import { ConfigError } from "../../shared/errors.js";
import {
    hasAliasRemote,
    launchdPlist,
    logDirOf,
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
    readWritePaths: ["-/data/archive", "/var/lib/backupkit", "/etc/backupkit"],
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
        ["TimeoutStopSec=45"],
        ["After=network-online.target"],
        ["Wants=network-online.target"],
        ["NoNewPrivileges=true"],
        ["PrivateTmp=true"],
        ["ProtectSystem=strict"],
        ['ReadWritePaths="-/data/archive" "/var/lib/backupkit" "/etc/backupkit"'],
        ["RestrictSUIDSGID=true"],
        ["PrivateDevices=true"],
        ["ProtectHome=read-only"],
        ["ProtectKernelModules=true"],
        ["ProtectKernelTunables=true"],
        ["ProtectKernelLogs=true"],
        ["ProtectControlGroups=true"],
        ["ProtectClock=true"],
        ["RestrictNamespaces=true"],
        ["RestrictRealtime=true"],
        ["RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"],
        ["LockPersonality=true"],
        ["SystemCallArchitectures=native"],
        ["SystemCallFilter=@system-service"],
        ["RuntimeDirectory=backupkit"],
        ["RuntimeDirectoryMode=0700"],
        ["WantedBy=multi-user.target"],
    ])("contains the line %s", (line) => {
        expect(unit.split("\n")).toContain(line);
    });

    // /run is a tmpfs: the directory the daemon puts its agent socket in is
    // gone after every reboot. As a ReadWritePaths member that is fatal -
    // systemd resolves the list BEFORE ExecStart and fails namespace setup
    // (226/NAMESPACE), and StartLimitIntervalSec=0 + Restart=on-failure then
    // retries forever without ever marking the unit failed. RuntimeDirectory=
    // creates it instead.
    it("never names /run/backupkit in ReadWritePaths - RuntimeDirectory= owns it", () => {
        const readWritePathsLine = unit.split("\n").find((line) => line.startsWith("ReadWritePaths="));
        expect(readWritePathsLine).not.toContain("/run/backupkit");
        expect(unit.split("\n")).toContain("RuntimeDirectory=backupkit");
    });

    // SystemCallFilter= is bypassable through a secondary syscall ABI (32-bit
    // on x86-64) unless the architecture set is pinned, which makes this the
    // load-bearing half of the pair.
    it("pins the syscall architecture wherever it filters syscalls", () => {
        expect(unit).toContain("SystemCallFilter=");
        expect(unit).toContain("SystemCallArchitectures=native");
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

    // A unit file is line-based and has no escape for a newline inside a value,
    // so a token carrying one would close its directive and turn the remainder
    // into an arbitrary further directive (ExecStartPre=...) in a ROOT unit.
    // Refused at the sink, not escaped.
    it.each([["/etc\nExecStartPre=/bin/sh -c evil"], ["/etc\rx"], ["/etc\0x"]])(
        "refuses to quote a token containing a NUL or newline: %j",
        (token) => {
            expect(() => systemdQuote(token)).toThrow(ConfigError);
            expect(() => systemdQuote(token)).toThrow("NUL or newline");
        },
    );

    it("refuses to build a whole unit around an injected ExecStartPre", () => {
        expect(() =>
            systemdUnit({ ...base, configPath: "/etc/c.jsonc\nExecStartPre=/bin/sh -c evil" }),
        ).toThrow(ConfigError);
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
    it("collects local destination roots, stateDir, and the config dir - and never the runtime dir", () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [
                makeTarget(),
                makeTarget({ name: "push", dst: { kind: "remote", remote: { kind: "alias", restrictedShell: false, name: "m", alias: "m" }, path: "/jail" } }),
            ],
        });
        expect(readWritePathsOf(config)).toEqual(["-/data/archive", "/var/lib/backupkit", "/etc/backupkit"]);
    });

    // A destination root that does not exist yet is a fatal ReadWritePaths
    // member (226/NAMESPACE, then a forever crash loop). Prefixed with "-" it
    // is ignored, and the daemon's own preflight reports it by name.
    it("prefixes paths install does not create with '-' and leaves the ones it does bare", () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [makeTarget()],
        });
        config.logging = { level: "info", file: "/var/log/backupkit/backupkit.log" };
        const paths = readWritePathsOf(config);
        expect(paths).toContain("-/data/archive");
        expect(paths).toContain("/var/lib/backupkit");
        expect(paths).toContain("/etc/backupkit");
        expect(paths).toContain("/var/log/backupkit");
    });

    // The daemon CREATES a missing known_hosts inside the sandbox
    // (ssh/permissions.ts) and writes the .pub sidecar next to the private key
    // (ssh/agent.ts). The default known_hosts lands under the config dir by
    // accident; a configured one outside it was never granted -> EROFS ->
    // SshError out of preflight -> the same never-give-up crash loop. The key's
    // directory is the quieter half: under ProtectHome=read-only a key in
    // /root/.ssh fails only that remote's targets.
    it("grants the identityFile and knownHostsFile directories of every explicit remote", () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [makeTarget()],
        });
        config.remotes = {
            r: {
                kind: "explicit",
                restrictedShell: false,
                name: "r",
                host: "h",
                user: "u",
                port: 22,
                identityFile: "/root/.ssh/id_ed25519",
                passphrase: null,
                knownHostsFile: "/etc/ssh/backupkit_known_hosts",
            },
            a: { kind: "alias", restrictedShell: false, name: "a", alias: "a" },
        };
        const paths = readWritePathsOf(config);
        expect(paths).toContain("-/root/.ssh");
        expect(paths).toContain("-/etc/ssh");
    });

    it("does not repeat the config dir when the default known_hosts lives in it", () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [makeTarget()],
        });
        config.remotes = {
            r: {
                kind: "explicit",
                restrictedShell: false,
                name: "r",
                host: "h",
                user: "u",
                port: 22,
                identityFile: "/etc/backupkit/keys/id",
                passphrase: null,
                knownHostsFile: "/etc/backupkit/known_hosts",
            },
        };
        expect(readWritePathsOf(config)).toEqual([
            "-/data/archive",
            "/var/lib/backupkit",
            "/etc/backupkit",
            "-/etc/backupkit/keys",
        ]);
    });

    // A logging.file outside every other ReadWritePaths member is unwritable
    // under ProtectSystem=strict, and the daemon's first log line then throws
    // out of preflight - a crash loop systemd never gives up on
    // (StartLimitIntervalSec=0). The write-set must include its directory.
    it("includes the logging.file directory so the sandbox does not block the daemon's own log", () => {
        const config = makeConfig({
            configPath: "/etc/backupkit/config.jsonc",
            stateDir: "/var/lib/backupkit",
            targets: [makeTarget()],
        });
        config.logging = { level: "info", file: "/var/log/backupkit/backupkit.log" };
        expect(readWritePathsOf(config)).toEqual([
            "-/data/archive",
            "/var/lib/backupkit",
            "/etc/backupkit",
            "/var/log/backupkit",
        ]);
        expect(logDirOf(config)).toBe("/var/log/backupkit");
    });

    it("adds nothing when no log file is configured", () => {
        const config = makeConfig({ configPath: "/c/config.jsonc", stateDir: "/s", targets: [makeTarget()] });
        expect(logDirOf(config)).toBeNull();
        expect(readWritePathsOf(config)).not.toContain(".");
    });

    it("detects alias remotes from the resolved remotes record", () => {
        const explicit = makeConfig({ configPath: "/c/config.jsonc", stateDir: "/s", targets: [makeTarget()] });
        explicit.remotes = {
            r: { kind: "explicit", restrictedShell: false, name: "r", host: "h", user: "u", port: 22, identityFile: "/k", passphrase: null, knownHostsFile: "/kh" },
        };
        expect(hasAliasRemote(explicit)).toBe(false);
        explicit.remotes.a = { kind: "alias", restrictedShell: false, name: "a", alias: "a" };
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
        // launchd's ExitTimeOut defaults to 20 s, which is LESS than a stop
        // needs (the SIGTERMed rsync reaching SIGKILL, then the destination
        // lock's detached release) - so the default SIGKILLed the daemon while
        // it still held the lock. Twin of the unit's TimeoutStopSec=45.
        ["<key>ExitTimeOut</key>"],
        ["<integer>45</integer>"],
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
