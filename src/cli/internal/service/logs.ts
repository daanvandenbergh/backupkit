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
import { MACOS_LOG_FILES, SYSTEMD_UNIT_PATH } from "./units.js";

/** The message printed when no log source exists. */
const NO_LOGS = "no daemon logs found - is the service installed? (backupkit service install)";

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
        const files = MACOS_LOG_FILES.filter((file) => deps.files.exists(file));
        if (files.length === 0) {
            deps.stderr(NO_LOGS);
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
        deps.stderr(NO_LOGS);
        return 1;
    }
    try {
        const result = await deps.execFn("journalctl", ["-u", "backupkit", "-n", lines, ...(follow ? ["-f"] : [])], {
            stdio: "inherit",
        });
        return result.exitCode ?? 1;
    } catch {
        // journalctl absent entirely (spawn failed): no journal to read.
        deps.stderr(NO_LOGS);
        return 1;
    }
}
