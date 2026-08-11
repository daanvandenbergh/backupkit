/**
 * The `backupkit check` command: print the engine's readiness report - local
 * binary versions, per-remote reachability + rsync version, `ssh -G` alias
 * resolution, the push-jail `authorized_keys` lines (informational - the jail
 * is recommended but optional, and never probed) with the backupkit-remote
 * install instruction, a note per jail-disabled push target, and every
 * collected error. TOFU pinning and passphrase
 * prompts happen inside `Backupkit.check()` when a TTY is present (the engine
 * reads the real TTY by default - the CLI adds nothing). Exit 1 on any probe
 * failure; a config error exits 2 via the shared error mapping.
 */

import type { CliDeps } from "../context.js";
import { count, parseFlags } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit check` command entry. */
export async function checkCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(argv, { config: { type: "string" } }, false);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.check);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    deps.stdout(`Config:      ${config.configPath} (valid)`);
    const report = await engine.check();

    deps.stdout(
        report.localRsync === null
            ? "Local rsync: NOT USABLE (see the errors below)"
            : `Local rsync: ${report.localRsync.bin} ${report.localRsync.version}`,
    );
    deps.stdout(`Local ssh:   ${report.sshOk ? "ok" : "NOT USABLE (see the errors below)"}`);

    for (const remote of report.remotes) {
        const resolved =
            remote.resolved === null
                ? ""
                : `, ${remote.resolved.user}@${remote.resolved.hostname}:${remote.resolved.port}`;
        const state = remote.reachable
            ? `reachable, rsync ${remote.rsyncVersion ?? "version unknown"}`
            : `NOT REACHABLE${remote.error === null ? "" : ` - ${remote.error}`}`;
        deps.stdout(`Remote ${remote.remote} (${remote.kind}${resolved}): ${state}`);
    }

    if (report.jailLines.length > 0) {
        deps.stdout("");
        deps.stdout("Push jail (recommended, optional) - add these lines to the archive server's authorized_keys:");
        for (const jail of report.jailLines) {
            deps.stdout(`# target ${jail.target} via remote ${jail.remote}`);
            deps.stdout(jail.line);
        }
        deps.stdout(
            "To install the jail, run on the archive server: npm install -g @daanvandenbergh/backupkit && sudo backupkit jail install",
        );
        deps.stdout(
            "(or copy dist/snapshots/internal/backupkit-remote.sh there yourself as /usr/local/bin/backupkit-remote, chmod 755)",
        );
        deps.stdout('To skip the jail for a target (an accepted risk), set "jail": false on it.');
    }
    for (const target of config.targets) {
        if (target.direction === "push" && !target.jail) {
            deps.stdout(
                `Warning: push target ${target.name} has the jail disabled ("jail": false) - its key gets whatever access the server grants it.`,
            );
        }
    }

    for (const error of report.errors) {
        deps.stderr(`Error: ${error}`);
    }
    deps.stdout("");
    deps.stdout(
        report.ok
            ? "Check passed - backupkit is ready. Register the daemon with: sudo backupkit service install"
            : `Check FAILED - ${count(report.errors.length, "problem")} above ${report.errors.length === 1 ? "needs" : "need"} fixing before backups will run.`,
    );
    return report.ok ? 0 : 1;
}
