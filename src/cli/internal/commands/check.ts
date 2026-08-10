/**
 * The `backupkit check` command: print the engine's readiness report - local
 * binary versions, per-remote reachability + rsync version, `ssh -G` alias
 * resolution, the push-jail `authorized_keys` lines with the backupkit-remote
 * install instruction, and every collected error. TOFU pinning and passphrase
 * prompts happen inside `Backupkit.check()` when a TTY is present (the engine
 * reads the real TTY by default - the CLI adds nothing). Exit 1 on any probe
 * failure; a config error exits 2 via the shared error mapping.
 */

import type { CliDeps } from "../context.js";
import { parseFlags } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit check` command entry. */
export async function checkCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(argv, { config: { type: "string" } }, false);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.check);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    deps.stdout(`config: ${config.configPath} ok`);
    const report = await engine.check();

    deps.stdout(
        report.localRsync === null
            ? "local rsync: NOT OK (see errors below)"
            : `local rsync: ${report.localRsync.bin} ${report.localRsync.version}`,
    );
    deps.stdout(`local ssh: ${report.sshOk ? "ok" : "NOT OK (see errors below)"}`);

    for (const remote of report.remotes) {
        const resolved =
            remote.resolved === null
                ? ""
                : ` -> ${remote.resolved.user}@${remote.resolved.hostname}:${remote.resolved.port}`;
        const state = remote.reachable
            ? `reachable, rsync ${remote.rsyncVersion ?? "?"}`
            : `NOT reachable${remote.error === null ? "" : ` - ${remote.error}`}`;
        deps.stdout(`remote ${remote.remote} [${remote.kind}${resolved}]: ${state}`);
    }

    if (report.jailLines.length > 0) {
        deps.stdout("");
        deps.stdout("push jail - add to the archive server's authorized_keys:");
        for (const jail of report.jailLines) {
            deps.stdout(`# target ${jail.target} via remote ${jail.remote}`);
            deps.stdout(jail.line);
        }
        deps.stdout(
            "install the jail: copy dist/snapshots/internal/backupkit-remote.sh to /usr/local/bin/backupkit-remote on the archive server and chmod 755 it",
        );
    }

    for (const error of report.errors) {
        deps.stderr(`check: ${error}`);
    }
    deps.stdout(report.ok ? "check ok" : "check FAILED");
    return report.ok ? 0 : 1;
}
