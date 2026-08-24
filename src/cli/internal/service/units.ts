/**
 * Service-unit file generation (pure string builders, spec sections 4 and 6):
 * the hardened systemd unit with its restart stanzas and conditional alias
 * `ReadOnlyPaths`, the launchd plist with crash-only KeepAlive, and the
 * newsyslog rotation line. All paths the units reference are constants here
 * so install and uninstall can never drift apart.
 */

import { dirname } from "node:path";

import type { ResolvedConfig } from "../../../config/types.js";
import { ConfigError } from "../../../shared/errors.js";

/** Where the systemd unit is installed. */
export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/backupkit.service";

/** The launchd job label. */
export const LAUNCHD_LABEL = "com.daanvandenbergh.backupkit";

/** Where the launchd plist is installed. */
export const LAUNCHD_PLIST_PATH = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;

/** Where the newsyslog rotation config is installed (macOS). */
export const NEWSYSLOG_CONF_PATH = "/etc/newsyslog.d/backupkit.conf";

/** The launchd log directory (created 0750 by install). */
export const MACOS_LOG_DIR = "/var/log/backupkit";

/** The two launchd log files `backupkit logs` tails on macOS. */
export const MACOS_LOG_FILES: readonly string[] = [
    `${MACOS_LOG_DIR}/backupkit.log`,
    `${MACOS_LOG_DIR}/backupkit.err.log`,
];

/** The newsyslog rotation line: rotate at 10 MiB, keep 5, compressed. */
export const NEWSYSLOG_CONF = "/var/log/backupkit/*.log  root:wheel  640  5  10240  *  J\n";

/**
 * The runtime-directory NAME under /run, for `RuntimeDirectory=`. systemd
 * creates `/run/backupkit` before ExecStart, grants it to the sandbox, and
 * removes it on stop - which is the only way the grant survives a reboot,
 * because /run is a tmpfs. Naming it in `ReadWritePaths=` instead is fatal:
 * systemd resolves that list BEFORE ExecStart, so the first boot after install
 * fails namespace setup (status 226/NAMESPACE) and `Restart=on-failure` with
 * `StartLimitIntervalSec=0` retries forever without ever marking the unit
 * failed. Must stay in lockstep with the engine's `/run/backupkit` runtimeDir
 * default (engine/backupkit.ts) - the daemon puts its agent socket there.
 */
const RUNTIME_DIR_NAME = "backupkit";

/**
 * Quote one token for a systemd unit line: double-quoted with backslash and
 * quote escapes, and `%` doubled (systemd specifier escape).
 *
 * A NUL or newline is REFUSED rather than escaped: systemd's unit grammar is
 * line-based and has no escape for a newline inside a value, so a token
 * carrying one would end the directive and let the rest of the value become an
 * arbitrary further directive (`ExecStartPre=...`) in a root unit. Every
 * config-derived path is already filtered by the validator's `expectPath`, and
 * `resolveConfigPath` filters the one value that reaches here from argv - this
 * throw holds the invariant at the sink, where no future caller can miss it.
 */
export function systemdQuote(token: string): string {
    if (/[\0\n\r]/.test(token)) {
        throw new ConfigError(
            `cannot write a service unit for a value containing a NUL or newline character: ${JSON.stringify(token)}`,
        );
    }
    return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/** True when any configured remote is an ssh_config alias (needs ~/.ssh readable). */
export function hasAliasRemote(config: ResolvedConfig): boolean {
    return Object.values(config.remotes).some((remote) => remote.kind === "alias");
}

/**
 * The unit's ReadWritePaths entries: every local destination root, the
 * stateDir, the config directory, each explicit remote's identityFile and
 * knownHostsFile directory, and - when `logging.file` is configured - its
 * directory. Deduplicated, config order. `/run/backupkit` is deliberately
 * absent: `RuntimeDirectory=` owns it (see `RUNTIME_DIR_NAME`).
 *
 * This set must cover EVERY path the daemon writes: `ProtectSystem=strict`
 * makes the rest of the filesystem read-only, so a missing member is not a
 * hardening gap but a crash loop (`Restart=on-failure` with
 * `StartLimitIntervalSec=0` retries forever and never marks the unit failed).
 * Two members are easy to forget because their writers live in other modules:
 * the logging.file directory (the engine writes it - see `logDirOf`) and the
 * two ssh directories - the daemon CREATES a missing known_hosts file
 * (ssh/permissions.ts) and writes the `.pub` sidecar next to the private key
 * (ssh/agent.ts). A configured `knownHostsFile` outside the config dir crash-
 * loops the unit; a key under /root/.ssh is EROFS under `ProtectHome=read-only`
 * and silently fails only that remote's targets.
 *
 * Entries install does not create itself carry systemd's `-` prefix, so a path
 * that does not exist yet is IGNORED at namespace setup instead of being fatal:
 * the daemon's own preflight then reports it ("destination root ... does not
 * exist; create it first") instead of systemd crash-looping on 226/NAMESPACE.
 * stateDir, the config dir, and the log dir are unprefixed because install
 * guarantees they exist (`writeUnits`).
 */
export function readWritePathsOf(config: ResolvedConfig): string[] {
    const entries: string[] = [];
    const seen = new Set<string>();
    /** Append one path once, `-`-prefixed when install does not guarantee it exists. */
    const add = (path: string, mayBeAbsent: boolean): void => {
        if (seen.has(path)) {
            return;
        }
        seen.add(path);
        entries.push(mayBeAbsent ? `-${path}` : path);
    };
    for (const target of config.targets) {
        if (target.dst.kind === "local") {
            add(target.dst.path, true);
        }
    }
    add(config.stateDir, false);
    add(dirname(config.configPath), false);
    for (const remote of Object.values(config.remotes)) {
        if (remote.kind === "explicit") {
            add(dirname(remote.identityFile), true);
            add(dirname(remote.knownHostsFile), true);
        }
    }
    const logDir = logDirOf(config);
    if (logDir !== null) {
        add(logDir, false);
    }
    return entries;
}

/**
 * The directory holding `logging.file`, or null when no log file is
 * configured. `install` creates it so the daemon's very first line has
 * somewhere to land; `readWritePathsOf` grants it to the sandbox.
 */
export function logDirOf(config: ResolvedConfig): string | null {
    return config.logging.file === null ? null : dirname(config.logging.file);
}

/** Inputs for the systemd unit builder. */
export interface SystemdUnitOptions {
    /** Absolute node binary path. */
    nodeBin: string;
    /** Absolute CLI entry path (dist/cli/main.js). */
    cliPath: string;
    /** Absolute config file path the daemon runs with. */
    configPath: string;
    /** ReadWritePaths entries (from `readWritePathsOf`). */
    readWritePaths: string[];
    /** True when an alias remote is configured (emits ReadOnlyPaths=/root/.ssh). */
    aliasRemote: boolean;
}

/**
 * Build the hardened systemd unit (spec sections 4 and 6): crash-only restart
 * with 15 s pacing and no start limit, the full hardening block, and the
 * conditional `/root/.ssh` read grant for alias remotes.
 */
export function systemdUnit(options: SystemdUnitOptions): string {
    const execStart = [options.nodeBin, options.cliPath, "daemon", "--config", options.configPath]
        .map(systemdQuote)
        .join(" ");
    const lines = [
        "[Unit]",
        "Description=backupkit - versioned rsync-over-SSH backups",
        "After=network-online.target",
        "Wants=network-online.target",
        "StartLimitIntervalSec=0",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${execStart}`,
        "User=root",
        "Restart=on-failure",
        "RestartSec=15",
        "KillSignal=SIGTERM",
        // A stop has to fit the SIGTERMed rsync reaching SIGKILL (~10 s, see
        // exec/) PLUS the destination lock's detached release (~15 s worst
        // case, see DETACHED_RELEASE in snapshots/internal/remote-store.ts).
        // 30 s did not, and being SIGKILLed here is exactly how a lock gets
        // left on the archive for the full 24 h TTL. Raising this is why an
        // existing install must re-run `backupkit service install`.
        "TimeoutStopSec=45",
        `RuntimeDirectory=${RUNTIME_DIR_NAME}`,
        "RuntimeDirectoryMode=0700",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "ProtectSystem=strict",
        `ReadWritePaths=${options.readWritePaths.map(systemdQuote).join(" ")}`,
        "RestrictSUIDSGID=true",
        "PrivateDevices=true",
        "ProtectHome=read-only",
        ...(options.aliasRemote ? ["ReadOnlyPaths=/root/.ssh"] : []),
        "ProtectKernelModules=true",
        "ProtectKernelTunables=true",
        "ProtectKernelLogs=true",
        "ProtectControlGroups=true",
        "ProtectClock=true",
        "RestrictNamespaces=true",
        "RestrictRealtime=true",
        // ssh and rsync need AF_INET/AF_INET6 (transport), AF_UNIX (the agent
        // socket, NSS), and AF_NETLINK - glibc's getaddrinfo probes the local
        // address families over netlink, so omitting it degrades name
        // resolution on some hosts. Everything else (AF_PACKET, raw sockets)
        // is denied.
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
        "LockPersonality=true",
        // SystemCallArchitectures=native first: without it SystemCallFilter is
        // bypassable through a secondary syscall ABI (32-bit on x86-64).
        "SystemCallArchitectures=native",
        "SystemCallFilter=@system-service",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
    ];
    return lines.join("\n") + "\n";
}

/** Escape XML text content for the plist. */
function xmlEscape(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Inputs for the launchd plist builder. */
export interface LaunchdPlistOptions {
    /** Absolute node binary path. */
    nodeBin: string;
    /** Absolute CLI entry path (dist/cli/main.js). */
    cliPath: string;
    /** Absolute config file path the daemon runs with. */
    configPath: string;
}

/**
 * Build the launchd daemon plist (spec section 6): RunAtLoad for reboot
 * recovery, KeepAlive on unsuccessful exit only (crash restarts, clean exit
 * stays down), 15 s throttle, logs to /var/log/backupkit.
 *
 * `ExitTimeOut` is the launchd twin of the unit's `TimeoutStopSec`: its default
 * is 20 s, which is LESS than a stop needs (the SIGTERMed rsync reaching
 * SIGKILL, then the lock's detached release), so the default SIGKILLed the
 * daemon while it still held the destination lock - leaving it on the archive
 * for the full 24 h TTL.
 */
export function launchdPlist(options: LaunchdPlistOptions): string {
    const args = [options.nodeBin, options.cliPath, "daemon", "--config", options.configPath]
        .map((token) => `        <string>${xmlEscape(token)}</string>`)
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>15</integer>
    <key>ExitTimeOut</key>
    <integer>45</integer>
    <key>StandardOutPath</key>
    <string>${MACOS_LOG_DIR}/backupkit.log</string>
    <key>StandardErrorPath</key>
    <string>${MACOS_LOG_DIR}/backupkit.err.log</string>
</dict>
</plist>
`;
}
