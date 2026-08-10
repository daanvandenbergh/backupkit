/**
 * Service-unit file generation (pure string builders, spec sections 4 and 6):
 * the hardened systemd unit with its restart stanzas and conditional alias
 * `ReadOnlyPaths`, the launchd plist with crash-only KeepAlive, and the
 * newsyslog rotation line. All paths the units reference are constants here
 * so install and uninstall can never drift apart.
 */

import { dirname } from "node:path";

import type { ResolvedConfig } from "../../../config/types.js";

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

/** The daemon's runtime directory when running as root (the unit's User=root default). */
const ROOT_RUNTIME_DIR = "/run/backupkit";

/**
 * Quote one token for a systemd ExecStart line: double-quoted with backslash
 * and quote escapes, and `%` doubled (systemd specifier escape).
 */
export function systemdQuote(token: string): string {
    return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/** True when any configured remote is an ssh_config alias (needs ~/.ssh readable). */
export function hasAliasRemote(config: ResolvedConfig): boolean {
    return Object.values(config.remotes).some((remote) => remote.kind === "alias");
}

/**
 * The unit's ReadWritePaths: every local destination root, the stateDir, the
 * root runtime dir, and the config directory - deduplicated, config order.
 */
export function readWritePathsOf(config: ResolvedConfig): string[] {
    const paths = new Set<string>();
    for (const target of config.targets) {
        if (target.dst.kind === "local") {
            paths.add(target.dst.path);
        }
    }
    paths.add(config.stateDir);
    paths.add(ROOT_RUNTIME_DIR);
    paths.add(dirname(config.configPath));
    return [...paths];
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
        "TimeoutStopSec=30",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "ProtectSystem=strict",
        `ReadWritePaths=${options.readWritePaths.map(systemdQuote).join(" ")}`,
        "RestrictSUIDSGID=true",
        "PrivateDevices=true",
        "ProtectHome=read-only",
        ...(options.aliasRemote ? ["ReadOnlyPaths=/root/.ssh"] : []),
        "ProtectKernelModules=true",
        "ProtectControlGroups=true",
        "RestrictNamespaces=true",
        "LockPersonality=true",
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
    <key>StandardOutPath</key>
    <string>${MACOS_LOG_DIR}/backupkit.log</string>
    <key>StandardErrorPath</key>
    <string>${MACOS_LOG_DIR}/backupkit.err.log</string>
</dict>
</plist>
`;
}
