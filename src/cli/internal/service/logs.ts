/**
 * The `backupkit logs` command (spec section 7): journalctl -u backupkit on
 * Linux, tail over the launchd log files on macOS - inherited stdio, no
 * timeout, the child's exit code passed through. No --json (journald already
 * has `-o json`). Both branches probe their log source's existence before
 * spawning (the unit file on Linux, the log files on macOS) so an
 * unregistered service reports the missing-source message instead of the
 * child's silent success.
 */

import type { CliDeps } from "../context.js";
import { parseFlags, UsageError } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { LAUNCHD_PLIST_PATH, MACOS_LOG_FILES, SYSTEMD_UNIT_PATH } from "./units.js";

/** Printed when the service is genuinely not registered yet. */
const NOT_INSTALLED =
    "No daemon logs found - the service is not installed. Register it with: sudo backupkit service install";

/**
 * Printed when the service IS installed but no log file exists yet - a
 * different state from "not installed" that the old message wrongly conflated.
 * The usual cause is a daemon that crash-loops before writing anything (its
 * exit reason is in `service status` / the platform's own log), so point there.
 */
const INSTALLED_NO_LOGS =
    "The service is installed but has written no logs yet - if it should be running, it may be failing to start. Check: backupkit service status";

/** Printed on Linux when journalctl itself is missing (nothing can read the journal). */
const NO_JOURNALCTL = "Cannot read logs: journalctl is not available on this system.";

/**
 * Printed on macOS to a non-root operator: the daemon logs to a root-owned
 * directory (/var/log/backupkit, 0750 root:wheel), so an unprivileged user
 * cannot read them and they read as absent here. Re-run under sudo.
 */
const NEED_SUDO = (follow: boolean): string =>
    `The daemon logs are owned by root - re-run with sudo: sudo backupkit logs${follow ? " -f" : ""}`;

/** The `backupkit logs` command entry. */
export async function logsCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(
        argv,
        {
            follow: { type: "boolean", short: "f" },
            lines: { type: "string", short: "n" },
            config: { type: "string" },
        },
        false,
    );
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.logs);
        return 0;
    }
    const lines = (values.lines as string | undefined) ?? "100";
    if (!/^[0-9]+$/.test(lines)) {
        throw new UsageError(`--lines takes a whole number, got "${lines}"`);
    }
    const follow = values.follow === true;

    if (deps.platform === "darwin") {
        if (!deps.files.exists(LAUNCHD_PLIST_PATH)) {
            deps.stderr(NOT_INSTALLED);
            return 1;
        }
        const files = MACOS_LOG_FILES.filter((file) => deps.files.exists(file));
        if (files.length === 0) {
            // The daemon runs as root and writes to /var/log/backupkit, which is
            // 0750 root:wheel - a non-root, non-wheel operator cannot even stat
            // the files (they read as "absent" here). Do not misreport that as
            // "no logs yet"; the logs are root's, so point at sudo.
            if (deps.euid !== 0) {
                deps.stderr(NEED_SUDO(follow));
                return 1;
            }
            deps.stderr(INSTALLED_NO_LOGS);
            return 1;
        }
        const result = await deps.execFn("tail", ["-n", lines, ...(follow ? ["-f"] : []), ...files], {
            stdio: "inherit",
        });
        return result.exitCode ?? 1;
    }

    // Mirror the macOS branch: probe the log source before spawning, so an
    // unregistered unit reports the spec'd missing-source message instead of
    // journalctl's silent "-- No entries --" success (exit 0).
    if (!deps.files.exists(SYSTEMD_UNIT_PATH)) {
        deps.stderr(NOT_INSTALLED);
        return 1;
    }
    try {
        const result = await deps.execFn("journalctl", ["-u", "backupkit", "-n", lines, ...(follow ? ["-f"] : [])], {
            stdio: "inherit",
        });
        return result.exitCode ?? 1;
    } catch {
        // journalctl absent entirely (spawn failed): no journal to read.
        deps.stderr(NO_JOURNALCTL);
        return 1;
    }
}
