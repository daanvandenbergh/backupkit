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
 *
 * The closing lines offer BOTH ways to schedule - `backupkit start` in this
 * session and a root service - because a config with a passphrase-protected key
 * can only ever have the first, and every command it prints carries
 * `--config <path>` unless the checked config sits in the one directory a root
 * service finds on its own. A suggestion that loads a DIFFERENT config than the
 * one just validated is worse than no suggestion.
 */

import { dirname } from "node:path";

import { SYSTEM_CONFIG_DIR } from "../../../config/config.js";
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
    if (!report.ok) {
        deps.stdout(
            `Check FAILED - ${count(report.errors.length, "problem")} above ${report.errors.length === 1 ? "needs" : "need"} fixing before backups will run.`,
        );
        return 1;
    }

    // The config THIS check validated has to be the config the suggested
    // command will load. Only /etc/backupkit is found without --config (and by
    // root at that), so any other path is named explicitly - otherwise
    // `check` blessed ~/.backupkit/config.jsonc and then told the operator to
    // install a service that resolves root's /etc copy, or nothing at all.
    const configFlag = dirname(config.configPath) === SYSTEM_CONFIG_DIR ? "" : ` --config ${config.configPath}`;
    deps.stdout("Check passed - backupkit is ready. Schedule it either way:");
    deps.stdout(`    in this session:   backupkit start${configFlag}`);
    if (report.encryptedKeys.length === 0) {
        deps.stdout(`    as a root service: sudo backupkit service install${configFlag}`);
        const aliases = Object.values(config.remotes).filter((remote) => remote.kind === "alias");
        if (aliases.length > 0) {
            deps.stdout(
                `Note: ${count(aliases.length, "remote")} (${aliases.map((r) => r.name).join(", ")}) resolve${aliases.length === 1 ? "s" : ""} through ssh_config. ` +
                    "This check used YOURS; a root service uses root's ssh_config and root's agent, which is a different arrangement - verify it there, or switch to an explicit remote.",
            );
        }
    } else {
        // Not an error - a perfectly valid setup that simply belongs to `start`.
        const list = report.encryptedKeys.map((entry) => `${entry.key} (remote "${entry.remote}")`).join(", ");
        deps.stdout(
            `    as a root service: NOT POSSIBLE - ${list} ${report.encryptedKeys.length === 1 ? "is" : "are"} passphrase-protected, ` +
                "and a service has no terminal to unlock a key on. Give the service a key of its own with no " +
                'passphrase (ssh-keygen -t ed25519 -N "") to change that.',
        );
    }
    return 0;
}
